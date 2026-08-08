import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  encounterCommandSchema,
  encounterCreateRequestSchema,
  encounterStartCommandRequestSchema,
  resourceIdSchema,
  utcIsoTimestampSchema,
  type EncounterCommand,
  type EncounterCreateRequest,
  type EncounterStartCommandRequest,
  type LegalCombatActionAllowlist,
} from "@velvet/contracts";
import type { Clock, IdGenerator, RandomNumberGenerator } from "../../runtime.js";
import {
  EncounterAuthorizationError,
  EncounterConflictError,
  EncounterStaleError,
  EncounterTurnError,
  EncounterUnavailableError,
} from "./encounterErrors.js";
import type { EncounterCombatSnapshot, EncounterLifecycleSnapshot, EncounterReadRepository } from "./encounterReadRepo.js";

export type EncounterDependencies={clock:Clock;ids:IdGenerator;rng:RandomNumberGenerator};
export type EncounterReceipt={commandId:string;idempotencyKey:string;revisionBefore:number;revisionAfter:number;occurredAt:string};
export type EncounterResult<T extends object>=T&{receipt:EncounterReceipt};

const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==="object"&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=(v:unknown)=>createHash("sha256").update(canonical(v)).digest("hex");
const id=(d:EncounterDependencies)=>resourceIdSchema.parse(d.ids.nextId());
const now=(d:EncounterDependencies)=>utcIsoTimestampSchema.parse(d.clock.now().toISOString());
const member=(db:DatabaseDriver.Database,p:string,c:string)=>Boolean(db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(c,p));
const gm=(db:DatabaseDriver.Database,p:string,c:string)=>Boolean(db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')").get(c,p));
const controls=(db:DatabaseDriver.Database,p:string,c:string,a:string)=>Boolean(db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?").get(c,a,p));
const commandType=(t:string)=>t==="create_encounter"||t==="start_encounter"||t==="resolve_initiative"||t==="join_combatant"?"start":t==="advance_turn"||t==="advance_round"?"advance_turn":t==="flee"?"flee":t==="claim_reward_bundle"?"grant_rewards":"resolve_action";
const actionTypes=new Set(["attack","power","item","defend","flee","end-turn"]);

/** Dependencies required by transactional encounter commands. */
export interface EncounterWriteDependencies extends EncounterDependencies {
  reads: Pick<EncounterReadRepository, "getLegalCombatActionAllowlist" | "getCombatState" | "listEncounters">;
  assertFactoryMutation(): void;
}

/** State-changing encounter commands. */
export interface EncounterWriteRepository {
  createEncounter(principal:string,campaignId:string,input:EncounterCreateRequest):EncounterResult<{campaignId:string;encounter:EncounterLifecycleSnapshot}>;
  startEncounter(principal:string,encounterId:string,input:EncounterStartCommandRequest):EncounterResult<{campaignId:string;encounterId:string;combat:EncounterCombatSnapshot}>;
  executeEncounterCommand(principal:string, command:EncounterCommand):EncounterResult<{encounterId:string;status:string}>;
  mutateEncounter(principal:string, command:EncounterCommand):EncounterResult<{encounterId:string;status:string}>;
}

/** Creates immediate-transaction commands backed by the authoritative read projection. */
export function createEncounterWriteRepository(db:DatabaseDriver.Database,deps:EncounterWriteDependencies):EncounterWriteRepository {
  const legal=deps.reads.getLegalCombatActionAllowlist;

  const createLifecycleEncounter=(p:string,campaignId:string,input:EncounterCreateRequest):EncounterResult<{campaignId:string;encounter:EncounterLifecycleSnapshot}>=>{
    deps.assertFactoryMutation();
    const parsedCampaignId=resourceIdSchema.parse(campaignId), command=encounterCreateRequestSchema.parse(input), request=canonical(command);
    return db.transaction(()=>{
      if(!gm(db,p,parsedCampaignId))throw new EncounterAuthorizationError("encounter creation requires GM authority");
      const replay=db.prepare(`SELECT metadata.encounter_id,metadata.canonical_create_request_json,receipt.canonical_result_json
        FROM encounter_lifecycle_v31 metadata
        LEFT JOIN combat_commands_v27 command ON command.encounter_id=metadata.encounter_id
          AND command.idempotency_key=metadata.create_idempotency_key
        LEFT JOIN combat_receipts_v27 receipt ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        WHERE metadata.campaign_id=? AND metadata.create_idempotency_key=?`).get(parsedCampaignId,command.idempotencyKey) as any;
      if(replay){
        if(replay.canonical_create_request_json!==request||typeof replay.canonical_result_json!=="string")
          throw new EncounterConflictError("idempotency key was reused");
        return JSON.parse(replay.canonical_result_json);
      }
      if(!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(parsedCampaignId,command.sessionId))
        throw new EncounterUnavailableError("session does not belong to campaign");
      if(db.prepare("SELECT 1 FROM encounter WHERE session_id=? AND status IN ('preparing','active')").get(command.sessionId))
        throw new EncounterConflictError("session already has an open encounter");
      for(const combatant of command.combatants){
        if(combatant.kind==="actor"){
          if(!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(parsedCampaignId,combatant.actorId))
            throw new EncounterUnavailableError("actor is unavailable");
        }else if(!enemyDefinition(db,parsedCampaignId,combatant.template)){
          throw new EncounterUnavailableError("enemy template is unavailable");
        }
      }

      const encounterId=id(deps),at=now(deps),commandId=id(deps);
      db.prepare(`INSERT INTO encounter(encounter_id,campaign_id,session_id,encounter_kind,status,round_number,
        current_turn_combatant_id,state_revision,created_at,updated_at)
        VALUES(?,?,?,'prepared','preparing',0,NULL,0,?,?)`).run(encounterId,parsedCampaignId,command.sessionId,at,at);
      db.prepare("INSERT INTO combat_mutation_revisions_v27 VALUES(?,?,?)").run(encounterId,0,at);
      for(const combatant of command.combatants){
        const combatantId=id(deps),initiative=deps.rng.integer(1,21),tie=deps.rng.integer(0,1000001);
        if(combatant.kind==="actor"){
          const health=db.prepare("SELECT current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
            .get(parsedCampaignId,combatant.actorId) as any;
          const hp=Math.max(0,health?.current??10),maximum=Math.max(1,health?.max??10);
          db.prepare(`INSERT INTO combatant(combatant_id,encounter_id,campaign_id,actor_id,combatant_kind,team,
            initiative,initiative_tiebreaker,hit_points,maximum_hit_points,status,state_revision,created_at,updated_at)
            VALUES(?,?,?,?,'actor',?,?,?,?,?,'active',0,?,?)`)
            .run(combatantId,encounterId,parsedCampaignId,combatant.actorId,combatant.team,initiative,tie,hp,maximum,at,at);
        }else{
          const definition=enemyDefinition(db,parsedCampaignId,combatant.template);
          if(!definition)throw new EncounterUnavailableError("enemy template is unavailable");
          db.prepare(`INSERT INTO combatant(combatant_id,encounter_id,campaign_id,actor_id,combatant_kind,team,
            initiative,initiative_tiebreaker,hit_points,maximum_hit_points,status,state_revision,created_at,updated_at)
            VALUES(?,?,?,NULL,'enemy',?,?,?,?,?,'active',0,?,?)`)
            .run(combatantId,encounterId,parsedCampaignId,combatant.team,initiative,tie,definition.maximumHitPoints,definition.maximumHitPoints,at,at);
          db.prepare(`INSERT INTO encounter_enemy_provenance_v31
            (combatant_id,encounter_id,campaign_id,pack_id,pack_version,kind,definition_id)
            VALUES(?,?,?,?,?,'enemy-template',?)`).run(combatantId,encounterId,parsedCampaignId,
              combatant.template.packId,combatant.template.packVersion,combatant.template.definitionId);
        }
      }
      db.prepare(`INSERT INTO encounter_lifecycle_v31(encounter_id,campaign_id,session_id,name,
        create_idempotency_key,canonical_create_request_json,request_digest) VALUES(?,?,?,?,?,?,?)`)
        .run(encounterId,parsedCampaignId,command.sessionId,command.name,command.idempotencyKey,request,digest(JSON.parse(request)));
      const internal={type:"create_encounter",encounterId,idempotencyKey:command.idempotencyKey};
      beginProtocol(db,deps,internal,request,commandId,null,0,1,at,"encounter_state_changed",{kind:"encounter_created"},"encounter_state",0);
      db.prepare("UPDATE encounter SET state_revision=1,updated_at=? WHERE encounter_id=?").run(at,encounterId);
      advanceRevision(db,encounterId,1,at);
      const encounter=deps.reads.listEncounters(p,parsedCampaignId)?.find((value)=>value.encounterId===encounterId);
      if(!encounter)throw new Error("created encounter projection is unavailable");
      const result={campaignId:parsedCampaignId,encounter,receipt:{commandId,idempotencyKey:command.idempotencyKey,revisionBefore:0,revisionAfter:1,occurredAt:at}};
      sealReceipt(db,encounterId,commandId,1,at,result);
      return result;
    }).immediate();
  };

  const startLifecycleEncounter=(p:string,encounterIdInput:string,input:EncounterStartCommandRequest):EncounterResult<{campaignId:string;encounterId:string;combat:EncounterCombatSnapshot}>=>{
    deps.assertFactoryMutation();
    const encounterId=resourceIdSchema.parse(encounterIdInput),command=encounterStartCommandRequestSchema.parse(input),request=canonical(command);
    return db.transaction(()=>{
      const encounter=db.prepare("SELECT * FROM encounter WHERE encounter_id=?").get(encounterId) as any;
      if(!encounter)throw new EncounterUnavailableError("encounter unavailable");
      if(!gm(db,p,encounter.campaign_id))throw new EncounterAuthorizationError("encounter start requires GM authority");
      const replay=db.prepare(`SELECT command.canonical_request_json,receipt.canonical_result_json
        FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt
          ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        WHERE command.encounter_id=? AND command.idempotency_key=?`).get(encounterId,command.idempotencyKey) as any;
      if(replay){
        if(replay.canonical_request_json!==request)throw new EncounterConflictError("idempotency key was reused");
        return JSON.parse(replay.canonical_result_json);
      }
      const root=db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(encounterId) as any;
      if(!root||root.revision!==command.expectedRevision)throw new EncounterStaleError("encounter revision is stale");
      if(encounter.status!=="preparing")throw new EncounterConflictError("encounter cannot be started");
      if(db.prepare("SELECT 1 FROM encounter WHERE session_id=? AND status='active' AND encounter_id<>?")
        .get(encounter.session_id,encounterId))throw new EncounterConflictError("session already has an active encounter");
      const first=db.prepare(`SELECT combatant_id FROM combatant WHERE encounter_id=? AND status='active'
        ORDER BY initiative DESC,initiative_tiebreaker,combatant_id LIMIT 1`).get(encounterId) as any;
      if(!first)throw new EncounterConflictError("encounter has no active combatants");
      const before=root.revision,after=before+1,at=now(deps),commandId=id(deps);
      const internal={type:"start_encounter",encounterId,idempotencyKey:command.idempotencyKey};
      beginProtocol(db,deps,internal,request,commandId,null,before,after,at,"encounter_state_changed",
        {kind:"initiative_resolved",combatantId:first.combatant_id},"encounter_state",0);
      db.prepare(`UPDATE encounter SET status='active',round_number=1,current_turn_combatant_id=?,
        state_revision=state_revision+1,updated_at=? WHERE encounter_id=?`).run(first.combatant_id,at,encounterId);
      advanceRevision(db,encounterId,after,at);
      const combat=deps.reads.getCombatState(p,encounterId);
      if(!combat)throw new Error("started combat projection is unavailable");
      const result={campaignId:encounter.campaign_id,encounterId,combat,receipt:{commandId,
        idempotencyKey:command.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at}};
      sealReceipt(db,encounterId,commandId,after,at,result);
      return result;
    }).immediate();
  };

  const execute=(p:string,input:EncounterCommand):EncounterResult<{encounterId:string;status:string}>=>{
    deps.assertFactoryMutation(); const command=encounterCommandSchema.parse(input), request=canonical(command);
    return db.transaction(()=>{
      // Always establish authority before looking up a receipt: idempotency is not a read capability.
      if(!member(db,p,command.campaignId)) throw new EncounterAuthorizationError("campaign membership is required");
      if(command.type==="create_encounter"&&!gm(db,p,command.campaignId)) throw new EncounterAuthorizationError("encounter creation requires GM authority");
      const replay=db.prepare("SELECT c.command_type,c.actor_id,c.canonical_request_json,r.canonical_result_json FROM combat_commands_v27 c JOIN combat_receipts_v27 r USING(encounter_id,command_id) WHERE c.encounter_id=? AND c.idempotency_key=?").get(command.encounterId,command.idempotencyKey) as any;
      if(replay){
        replayAuthority(db,p,command,replay);
        if(replay.command_type!==commandType(command.type)||replay.canonical_request_json!==request) throw new EncounterConflictError("idempotency key was reused");
        return JSON.parse(replay.canonical_result_json);
      }
      if(command.type==="create_encounter") return create(db,deps,command,request);
      const encounter=db.prepare("SELECT * FROM encounter WHERE encounter_id=? AND campaign_id=?").get(command.encounterId,command.campaignId) as any;
      if(!encounter) throw new EncounterUnavailableError("encounter unavailable");
      const root=db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(command.encounterId) as any;
      if(!root||root.revision!==command.expectedRevision) throw new EncounterStaleError("encounter revision is stale");
      const before=root.revision, after=before+1, at=now(deps), commandId=id(deps);
      if(command.type==="join_combatant") return join(db,deps,p,command,request,encounter,before,after,at,commandId);
      if(command.type==="resolve_initiative") return initiative(db,deps,p,command,request,encounter,before,after,at,commandId);
      if(command.type==="claim_reward_bundle") return claim(db,deps,p,command,request,encounter,before,after,at,commandId);
      if(command.type==="advance_turn"||command.type==="advance_round") return advance(db,deps,p,command,request,encounter,before,after,at,commandId);
      if(encounter.status!=="active") throw new EncounterUnavailableError("encounter is not active");
      const current=currentCombatant(db,encounter);
      if(!current) throw new EncounterTurnError("no current combatant");
      if(!current.actor_id||!controls(db,p,command.campaignId,current.actor_id)) throw new EncounterAuthorizationError("only the current actor controller may act");
      if(command.combatantId!==current.combatant_id) throw new EncounterTurnError("only the current combatant may act");
      const allow=legal(p,command.campaignId,command.encounterId);
      if(!allow||allow.revision!==before||!allowed(allow,command)) throw new EncounterUnavailableError("action is not in the authoritative allowlist");
      // Powers/items are intentionally rejected, rather than becoming a successful no-op. Their
      // independent M15/M16 revision streams cannot be nested in this combat transaction.
      if(command.type==="power"||command.type==="item") throw new EncounterUnavailableError("power and item combat resolution is unavailable");
      const result=receipt(command,commandId,before,after,at,encounter.status);
      protocol(db,deps,command,request,commandId,current.actor_id,before,after,at,result,"combat_action_resolved",{kind:"action_resolved",actionId:command.actionId,action:command.type},"action",0);
      if(command.type==="attack") damage(db,deps,command.encounterId,command.targetCombatantId,1,at,commandId,after);
      if(command.type==="flee") state(db,deps,command.encounterId,current.combatant_id,current.hit_points,"fled",at,commandId,after);
      finishOrTurn(db,deps,command.encounterId,encounter,current.combatant_id,at,commandId,after);
      advanceRevision(db,command.encounterId,after,at); return result;
    }).immediate();
  };
  return {createEncounter:createLifecycleEncounter,startEncounter:startLifecycleEncounter,executeEncounterCommand:execute,mutateEncounter:execute};
}

function replayAuthority(db:DatabaseDriver.Database,p:string,c:any,row:any){
  if(["create_encounter","join_combatant","resolve_initiative","advance_turn","advance_round"].includes(c.type)&&!gm(db,p,c.campaignId)) throw new EncounterAuthorizationError("GM authority is required");
  if(c.type==="claim_reward_bundle"&&!controls(db,p,c.campaignId,c.recipientActorId)) throw new EncounterAuthorizationError("only the reward recipient may claim");
  if(actionTypes.has(c.type)&&(!row.actor_id||!controls(db,p,c.campaignId,row.actor_id))) throw new EncounterAuthorizationError("only the acting controller may replay an action");
}
function create(db:DatabaseDriver.Database,d:EncounterDependencies,c:Extract<EncounterCommand,{type:"create_encounter"}>,request:string){
  if(c.expectedRevision!==0) throw new EncounterStaleError("new encounters start at revision zero");
  if(db.prepare("SELECT 1 FROM encounter WHERE encounter_id=?").get(c.encounterId)) throw new EncounterConflictError("encounter already exists");
  if(!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(c.campaignId,c.sessionId)) throw new EncounterUnavailableError("session does not belong to campaign");
  if(db.prepare("SELECT 1 FROM encounter WHERE session_id=? AND status='active'").get(c.sessionId)) throw new EncounterConflictError("session already has an active encounter");
  for(const s of c.enemySpawns){if(s.tactic.tacticId!=="basic_attack"||!db.prepare("SELECT 1 FROM rpg_campaign_catalog_definitions_v25 WHERE campaign_id=? AND pack_id=? AND pack_version=? AND kind='enemy' AND definition_id=?").get(c.campaignId,s.template.packId,s.template.packVersion,s.template.definitionId))throw new EncounterUnavailableError("enemy spawn is not a pinned basic-attack catalog enemy");}
  const at=now(d), commandId=id(d), result=receipt(c,commandId,0,1,at,"active");
  db.prepare("INSERT INTO encounter(encounter_id,campaign_id,session_id,encounter_kind,status,round_number,current_turn_combatant_id,state_revision,created_at,updated_at) VALUES(?,?,?,?,'active',0,NULL,0,?,?)").run(c.encounterId,c.campaignId,c.sessionId,c.kind,at,at);
  db.prepare("INSERT INTO combat_mutation_revisions_v27 VALUES(?,?,?)").run(c.encounterId,0,at);
  const legacyKey=`legacy:${digest(c.encounterId)}`;
  db.prepare(`INSERT INTO encounter_lifecycle_v31(encounter_id,campaign_id,session_id,name,
    create_idempotency_key,canonical_create_request_json,request_digest) VALUES(?,?,?,?,?,?,?)`)
    .run(c.encounterId,c.campaignId,c.sessionId,`Encounter ${c.encounterId}`,legacyKey,request,digest(JSON.parse(request)));
  for(const s of c.enemySpawns) db.prepare("INSERT INTO combatant(combatant_id,encounter_id,campaign_id,actor_id,combatant_kind,team,enemy_pack_id,enemy_pack_version,enemy_kind,enemy_definition_id,enemy_tactic,initiative,initiative_tiebreaker,hit_points,maximum_hit_points,status,state_revision,created_at,updated_at) VALUES(?,?,?,NULL,'enemy','enemies',?,?,'enemy',?,'basic_attack',?,?,10,10,'active',0,?,?)").run(s.enemyInstanceId,c.encounterId,c.campaignId,s.template.packId,s.template.packVersion,s.template.definitionId,d.rng.integer(1,21),d.rng.integer(0,1000001),at,at);
  protocol(db,d,c,request,commandId,null,0,1,at,result,"encounter_state_changed",{kind:"encounter_created"},"encounter_state",0); db.prepare("UPDATE encounter SET state_revision=1,updated_at=? WHERE encounter_id=?").run(at,c.encounterId); advanceRevision(db,c.encounterId,1,at); return result;
}
function join(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:Extract<EncounterCommand,{type:"join_combatant"}>,request:string,e:any,b:number,a:number,at:string,commandId:string){
  if(!gm(db,p,c.campaignId)) throw new EncounterAuthorizationError("combatant joining requires GM authority");
  if(e.status!=="active") throw new EncounterUnavailableError("encounter is not active");
  if(c.combatant.kind!=="actor") throw new EncounterUnavailableError("enemies are created only from pinned enemy spawns");
  if(!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(c.campaignId,c.combatant.actorId)) throw new EncounterUnavailableError("actor unavailable");
  if(db.prepare("SELECT 1 FROM combatant WHERE encounter_id=? AND (combatant_id=? OR actor_id=?)").get(c.encounterId,c.combatantId,c.combatant.actorId)) throw new EncounterConflictError("combatant already joined");
  const health=db.prepare("SELECT current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'").get(c.campaignId,c.combatant.actorId) as any;
  const hp=Math.max(0,health?.current??10), max=Math.max(1,health?.max??10), result=receipt(c,commandId,b,a,at,e.status);
  protocol(db,d,c,request,commandId,null,b,a,at,result,"encounter_state_changed",{kind:"combatant_joined",combatantId:c.combatantId},"encounter_state",0);
  db.prepare("INSERT INTO combatant(combatant_id,encounter_id,campaign_id,actor_id,combatant_kind,team,initiative,initiative_tiebreaker,hit_points,maximum_hit_points,status,state_revision,created_at,updated_at) VALUES(?,?,?,?, 'actor',?,?,?,?,?,'active',0,?,?)").run(c.combatantId,c.encounterId,c.campaignId,c.combatant.actorId,c.team,d.rng.integer(1,21),d.rng.integer(0,1000001),hp,max,at,at);
  db.prepare("UPDATE encounter SET state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(at,c.encounterId); advanceRevision(db,c.encounterId,a,at); return result;
}
function initiative(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:any,request:string,e:any,b:number,a:number,at:string,commandId:string){
  if(!gm(db,p,c.campaignId)) throw new EncounterAuthorizationError("initiative requires GM authority");
  if(e.status!=="active") throw new EncounterUnavailableError("encounter is not active");
  const first=db.prepare("SELECT combatant_id FROM combatant WHERE encounter_id=? AND status='active' ORDER BY initiative DESC,initiative_tiebreaker,combatant_id LIMIT 1").get(c.encounterId) as any;
  if(!first) throw new EncounterUnavailableError("no active combatants"); const result=receipt(c,commandId,b,a,at,e.status);
  protocol(db,d,c,request,commandId,null,b,a,at,result,"encounter_state_changed",{kind:"initiative_resolved",combatantId:first.combatant_id},"encounter_state",0);
  db.prepare("UPDATE encounter SET current_turn_combatant_id=?,round_number=CASE WHEN round_number=0 THEN 1 ELSE round_number END,state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(first.combatant_id,at,c.encounterId);advanceRevision(db,c.encounterId,a,at);return result;
}
function claim(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:Extract<EncounterCommand,{type:"claim_reward_bundle"}>,request:string,e:any,b:number,a:number,at:string,commandId:string){
  if(!controls(db,p,c.campaignId,c.recipientActorId)) throw new EncounterAuthorizationError("only the reward recipient may claim");
  const bundle=db.prepare("SELECT * FROM reward_bundle WHERE campaign_id=? AND reward_bundle_id=? AND encounter_id=? AND recipient_actor_id=?").get(c.campaignId,c.rewardBundleId,c.encounterId,c.recipientActorId) as any;
  if(!bundle) throw new EncounterUnavailableError("reward bundle unavailable");
  if(db.prepare("SELECT 1 FROM reward_claim_v27 WHERE reward_bundle_id=?").get(c.rewardBundleId)) throw new EncounterConflictError("reward bundle already claimed");
  const result=receipt(c,commandId,b,a,at,e.status);
  // v27 deliberately persists a recorded, unsettled currency claim only. There is no safe wallet
  // stream composition here; this command must not mutate a wallet or pretend it paid currency.
  protocol(db,d,c,request,commandId,null,b,a,at,result,"rewards_granted",{kind:"reward_claimed",rewardClaimId:c.rewardClaimId},"reward",0);
  db.prepare("INSERT INTO reward_claim_v27(reward_claim_id,campaign_id,reward_bundle_id,encounter_id,command_id,claim_state,claimed_at) VALUES(?,?,?,?,?,'recorded',?)").run(c.rewardClaimId,c.campaignId,c.rewardBundleId,c.encounterId,commandId,at);
  advanceRevision(db,c.encounterId,a,at);return result;
}
function advance(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:any,request:string,e:any,b:number,a:number,at:string,commandId:string){
  if(!gm(db,p,c.campaignId)) throw new EncounterAuthorizationError("turn advancement requires GM authority");
  if(e.status!=="active") throw new EncounterUnavailableError("encounter is not active"); const current=currentCombatant(db,e); if(!current) throw new EncounterTurnError("no current combatant");
  const result=receipt(c,commandId,b,a,at,e.status);
  if(current.combatant_kind==="enemy"){
    const target=db.prepare("SELECT combatant_id FROM combatant WHERE encounter_id=? AND status='active' AND team<>? ORDER BY combatant_id LIMIT 1").get(c.encounterId,current.team) as any;
    if(target){protocol(db,d,c,request,commandId,null,b,a,at,result,"combat_action_resolved",{kind:"action_resolved",actionId:"enemy-fallback",action:"attack"},"action",0);damage(db,d,c.encounterId,target.combatant_id,1,at,commandId,a);finishOrTurn(db,d,c.encounterId,e,current.combatant_id,at,commandId,a);}
    else { protocol(db,d,c,request,commandId,null,b,a,at,result,"encounter_state_changed",{kind:"turn_advanced",combatantId:current.combatant_id},"encounter_state",0); complete(db,c.encounterId,at); }
  } else {protocol(db,d,c,request,commandId,null,b,a,at,result,"encounter_state_changed",{kind:"turn_advanced",combatantId:current.combatant_id},"encounter_state",0);turn(db,c.encounterId,e,current.combatant_id,at);}
  advanceRevision(db,c.encounterId,a,at);return result;
}
function receipt(c:any,commandId:string,b:number,a:number,at:string,status:string){return {encounterId:c.encounterId,status,receipt:{commandId,idempotencyKey:c.idempotencyKey,revisionBefore:b,revisionAfter:a,occurredAt:at}};}
function allowed(allow:LegalCombatActionAllowlist,c:any){return allow.actions.some((x:any)=>x.kind===c.type&&(x.kind!=="attack"||(x.attackId===c.attackId&&x.targetCombatantIds.includes(c.targetCombatantId))));}
function beginProtocol(db:DatabaseDriver.Database,d:EncounterDependencies,c:any,request:string,commandId:string,actorId:string|null,b:number,a:number,at:string,eventType:string,event:any,logKind:string,ordinal:number){const eventId=id(d);db.prepare("INSERT INTO combat_commands_v27 VALUES(?,?,?,?,?,?,?,?,?,?)").run(c.encounterId,commandId,actorId,commandType(c.type),c.idempotencyKey,request,digest(JSON.parse(request)),b,a,at);db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(eventId,c.encounterId,commandId,a,eventType,canonical(event),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(id(d),c.encounterId,null,eventId,ordinal,logKind,canonical(event),at);return eventId;}
function sealReceipt(db:DatabaseDriver.Database,encounterId:string,commandId:string,revision:number,at:string,result:any){db.prepare("INSERT INTO combat_receipts_v27 VALUES(?,?,?,?,?,?)").run(encounterId,commandId,revision,canonical(result),digest(result),at);}
function protocol(db:DatabaseDriver.Database,d:EncounterDependencies,c:any,request:string,commandId:string,actorId:string|null,b:number,a:number,at:string,result:any,eventType:string,event:any,logKind:string,ordinal:number){beginProtocol(db,d,c,request,commandId,actorId,b,a,at,eventType,event,logKind,ordinal);sealReceipt(db,c.encounterId,commandId,a,at,result);}
function advanceRevision(db:DatabaseDriver.Database,e:string,a:number,at:string){db.prepare("UPDATE combat_mutation_revisions_v27 SET revision=?,updated_at=? WHERE encounter_id=?").run(a,at,e);}
function currentCombatant(db:DatabaseDriver.Database,e:any){return e.current_turn_combatant_id&&db.prepare("SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'").get(e.encounter_id,e.current_turn_combatant_id) as any;}
function state(db:DatabaseDriver.Database,d:EncounterDependencies,e:string,c:string,hp:number,status:string,at:string,commandId:string,revision:number){const eventId=id(d),event={combatantId:c,hp,status};db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(eventId,e,commandId,revision,"combatant_state_changed",canonical(event),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(id(d),e,c,eventId,1,status==="fled"?"flee":status==="defeated"?"defeat":"damage",canonical(event),at);db.prepare("UPDATE combatant SET hit_points=?,status=?,state_revision=state_revision+1,updated_at=? WHERE encounter_id=? AND combatant_id=?").run(hp,status,at,e,c);}
function damage(db:DatabaseDriver.Database,d:EncounterDependencies,e:string,target:string,amount:number,at:string,commandId:string,revision:number){const row=db.prepare("SELECT hit_points FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'").get(e,target) as any;if(!row)throw new EncounterUnavailableError("attack target unavailable");const hp=row.hit_points-amount;state(db,d,e,target,hp,hp<=0?"defeated":"active",at,commandId,revision);}
function next(db:DatabaseDriver.Database,e:string,current:string,round:number){const rows=db.prepare("SELECT combatant_id FROM combatant WHERE encounter_id=? AND status='active' ORDER BY initiative DESC,initiative_tiebreaker,combatant_id").all(e) as any[];const i=rows.findIndex(x=>x.combatant_id===current),n=rows[(i+1+rows.length)%rows.length];return n&&{combatantId:n.combatant_id,round:i===rows.length-1?round+1:round};}
function turn(db:DatabaseDriver.Database,e:string,encounter:any,current:string,at:string){const n=next(db,e,current,encounter.round_number);if(n)db.prepare("UPDATE encounter SET current_turn_combatant_id=?,round_number=?,state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(n.combatantId,n.round,at,e);}
function complete(db:DatabaseDriver.Database,e:string,at:string){db.prepare("UPDATE encounter SET status='completed',current_turn_combatant_id=NULL,state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(at,e);}
function finishOrTurn(db:DatabaseDriver.Database,d:EncounterDependencies,e:string,encounter:any,current:string,at:string,commandId:string,revision:number){const alive=db.prepare("SELECT count(DISTINCT team) count FROM combatant WHERE encounter_id=? AND status='active'").get(e) as any;if(alive.count<2){const eventId=id(d),event={kind:"turn_advanced",combatantId:current};db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(eventId,e,commandId,revision,"encounter_state_changed",canonical(event),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(id(d),e,null,eventId,2,"encounter_state",canonical(event),at);complete(db,e,at);return;}const n=next(db,e,current,encounter.round_number);if(!n)return;const eventId=id(d),event={kind:"turn_advanced",combatantId:n.combatantId};db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(eventId,e,commandId,revision,"encounter_state_changed",canonical(event),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(id(d),e,null,eventId,2,"turn",canonical(event),at);db.prepare("UPDATE encounter SET current_turn_combatant_id=?,round_number=?,state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(n.combatantId,n.round,at,e);}

function enemyDefinition(db:DatabaseDriver.Database,campaignId:string,template:{packId:string;packVersion:string;definitionId:string}):{maximumHitPoints:number}|null{
  let row=db.prepare(`SELECT definition.definition_json FROM rpg_campaign_catalog_definitions_v25 pin
    JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id
      AND definition.pack_version=pin.pack_version AND definition.kind=pin.kind
      AND definition.definition_id=pin.definition_id
    WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?
      AND pin.kind='enemy-template' AND pin.definition_id=?`)
    .get(campaignId,template.packId,template.packVersion,template.definitionId) as {definition_json:string}|undefined;
  if(!row){
    row=db.prepare(`SELECT definition.definition_json FROM campaign_catalog_current_pins pin
      JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id
        AND definition.pack_version=pin.pack_version
      WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?
        AND definition.kind='enemy-template' AND definition.definition_id=?`)
      .get(campaignId,template.packId,template.packVersion,template.definitionId) as {definition_json:string}|undefined;
    if(row)db.prepare(`INSERT INTO rpg_campaign_catalog_definitions_v25
      (campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,'enemy-template',?)`)
      .run(campaignId,template.packId,template.packVersion,template.definitionId);
  }
  if(!row)return null;
  try{
    const value=JSON.parse(row.definition_json) as {mechanics?:{maxHp?:unknown}};
    return Number.isInteger(value.mechanics?.maxHp)&&Number(value.mechanics?.maxHp)>=1&&Number(value.mechanics?.maxHp)<=1_000_000
      ?{maximumHitPoints:Number(value.mechanics?.maxHp)}:null;
  }catch{return null;}
}
