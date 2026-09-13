import type DatabaseDriver from "better-sqlite3";
import type { EncounterCommand } from "@velvet/contracts";
import { settleCombatRewardV51 } from "../../grantSettlementRepo.js";
import { EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, EncounterTurnError, EncounterUnavailableError } from "../encounterErrors.js";
import { beginDndCombatTurn, isDndCombat } from "../combatActionPlan.js";
import { buildCombatCompositionPlan } from "../combatCompositionPlan.js";
import { executeCombatCompositionPlan } from "../combatCompositionExecutor.js";
import { advanceRevision, beginProtocol, campaignInitiative, controls, currentCombatant, digest, gm, id, now, protocol, receipt, recordStateEvent, sealReceipt, type EncounterDependencies } from "./shared.js";
import { complete, next, persistTurnAdvance, planTurnAdvance, turn } from "./turn.js";

export function create(db:DatabaseDriver.Database,d:EncounterDependencies,c:Extract<EncounterCommand,{type:"create_encounter"}>,request:string){
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
export function join(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:Extract<EncounterCommand,{type:"join_combatant"}>,request:string,e:any,b:number,a:number,at:string,commandId:string){
  if(!gm(db,p,c.campaignId)) throw new EncounterAuthorizationError("combatant joining requires GM authority");
  if(e.status!=="active") throw new EncounterUnavailableError("encounter is not active");
  if(c.combatant.kind!=="actor") throw new EncounterUnavailableError("enemies are created only from pinned enemy spawns");
  if(!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(c.campaignId,c.combatant.actorId)) throw new EncounterUnavailableError("actor unavailable");
  if(db.prepare("SELECT 1 FROM combatant WHERE encounter_id=? AND (combatant_id=? OR actor_id=?)").get(c.encounterId,c.combatantId,c.combatant.actorId)) throw new EncounterConflictError("combatant already joined");
  if(db.prepare(`SELECT 1 FROM combatant JOIN encounter ON encounter.encounter_id=combatant.encounter_id
    WHERE combatant.campaign_id=? AND combatant.actor_id=? AND encounter.status='active'`).get(c.campaignId,c.combatant.actorId))
    throw new EncounterConflictError("actor is already in an active encounter");
  const health=db.prepare("SELECT current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'").get(c.campaignId,c.combatant.actorId) as any;
  if(!health)throw new EncounterConflictError("actor health is unavailable");
  if(health.current<=0)throw new EncounterConflictError("actor health must be positive to join combat");
  const hp=health.current,max=health.max,result=receipt(c,commandId,b,a,at,e.status);
  protocol(db,d,c,request,commandId,null,b,a,at,result,"encounter_state_changed",{kind:"combatant_joined",combatantId:c.combatantId},"encounter_state",0);
  db.prepare("INSERT INTO combatant(combatant_id,encounter_id,campaign_id,actor_id,combatant_kind,team,initiative,initiative_tiebreaker,hit_points,maximum_hit_points,status,state_revision,created_at,updated_at) VALUES(?,?,?,?, 'actor',?,?,?,?,?,'active',0,?,?)").run(c.combatantId,c.encounterId,c.campaignId,c.combatant.actorId,c.team,campaignInitiative(db,d,c.campaignId,c.combatant.actorId),d.rng.integer(0,1000001),hp,max,at,at);
  db.prepare("UPDATE encounter SET state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(at,c.encounterId); advanceRevision(db,c.encounterId,a,at); return result;
}
export function initiative(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:any,request:string,e:any,b:number,a:number,at:string,commandId:string){
  if(!gm(db,p,c.campaignId)) throw new EncounterAuthorizationError("initiative requires GM authority");
  if(e.status!=="active") throw new EncounterUnavailableError("encounter is not active");
  if(isDndCombat(db,c.campaignId)&&e.round_number!==0)throw new EncounterConflictError("initiative is already resolved");
  const first=db.prepare("SELECT combatant_id FROM combatant WHERE encounter_id=? AND status='active' ORDER BY initiative DESC,initiative_tiebreaker,combatant_id LIMIT 1").get(c.encounterId) as any;
  if(!first) throw new EncounterUnavailableError("no active combatants"); const result=receipt(c,commandId,b,a,at,e.status);
  protocol(db,d,c,request,commandId,null,b,a,at,result,"encounter_state_changed",{kind:"initiative_resolved",combatantId:first.combatant_id},"encounter_state",0);
  db.prepare("UPDATE encounter SET current_turn_combatant_id=?,round_number=CASE WHEN round_number=0 THEN 1 ELSE round_number END,state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(first.combatant_id,at,c.encounterId);
  beginDndCombatTurn(db,c.campaignId,c.encounterId,first.combatant_id,Math.max(1,e.round_number),id(d),at);
  advanceRevision(db,c.encounterId,a,at);return result;
}
export function claim(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:Extract<EncounterCommand,{type:"claim_reward_bundle"}>,request:string,e:any,b:number,a:number,at:string,commandId:string){
  if(!controls(db,p,c.campaignId,c.recipientActorId)) throw new EncounterAuthorizationError("only the reward recipient may claim");
  const bundle=db.prepare("SELECT * FROM reward_bundle WHERE campaign_id=? AND reward_bundle_id=? AND encounter_id=? AND recipient_actor_id=?").get(c.campaignId,c.rewardBundleId,c.encounterId,c.recipientActorId) as any;
  if(!bundle) throw new EncounterUnavailableError("reward bundle unavailable");
  if(db.prepare("SELECT 1 FROM reward_claim_v27 WHERE reward_bundle_id=?").get(c.rewardBundleId)) throw new EncounterConflictError("reward bundle already claimed");
  const result=receipt(c,commandId,b,a,at,e.status);
  protocol(db,d,c,request,commandId,null,b,a,at,result,"rewards_granted",{kind:"reward_claimed",rewardClaimId:c.rewardClaimId},"reward",0);
  db.prepare("INSERT INTO reward_claim_v27(reward_claim_id,campaign_id,reward_bundle_id,encounter_id,command_id,claim_state,claimed_at) VALUES(?,?,?,?,?,'recorded',?)").run(c.rewardClaimId,c.campaignId,c.rewardBundleId,c.encounterId,commandId,at);
  settleCombatRewardV51(db,d.ids,{campaignId:c.campaignId,encounterId:c.encounterId,rewardBundleId:c.rewardBundleId,
    recipientActorId:c.recipientActorId,rewardClaimId:c.rewardClaimId,occurredAt:at});
  advanceRevision(db,c.encounterId,a,at);return result;
}
export function advance(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:any,request:string,e:any,b:number,a:number,at:string,commandId:string){
  if(!gm(db,p,c.campaignId)) throw new EncounterAuthorizationError("turn advancement requires GM authority");
  if(e.status!=="active") throw new EncounterUnavailableError("encounter is not active"); const current=currentCombatant(db,e); if(!current) throw new EncounterTurnError("no current combatant");
  const result=receipt(c,commandId,b,a,at,e.status);
  if(isDndCombat(db,c.campaignId)){
    const plan=planTurnAdvance(db,c.encounterId,e,current.combatant_id,new Map());
    beginProtocol(db,d,c,request,commandId,null,b,a,at,"combat_action_resolved",{kind:"action_resolved",actionId:id(d),action:"end-turn"},"action",0);
    executeCombatCompositionPlan(db,buildCombatCompositionPlan(db,d.ids,{encounterId:c.encounterId,campaignId:c.campaignId,roundBefore:e.round_number,roundAfter:plan.round,occurredAt:at,combatantChanges:[]}));
    persistTurnAdvance(db,d,c.encounterId,plan,at,commandId,a);
    advanceRevision(db,c.encounterId,a,at);sealReceipt(db,c.encounterId,commandId,a,at,result);return result;
  }
  if(current.combatant_kind==="enemy"){
    const target=db.prepare("SELECT combatant_id,hit_points,status,state_revision FROM combatant WHERE encounter_id=? AND status='active' AND team<>? ORDER BY combatant_id LIMIT 1").get(c.encounterId,current.team) as any;
    if(target){const hp=Math.max(0,target.hit_points-1),overrides=new Map([[target.combatant_id,hp===0?"defeated":"active"]]),turnPlan=planTurnAdvance(db,c.encounterId,e,current.combatant_id,overrides);
      const compositionPlan=buildCombatCompositionPlan(db,d.ids,{encounterId:c.encounterId,campaignId:c.campaignId,
        roundBefore:e.round_number,roundAfter:turnPlan.round,occurredAt:at,combatantChanges:[{combatantId:target.combatant_id,
          hitPointsBefore:target.hit_points,hitPointsAfter:hp,statusBefore:target.status,statusAfter:overrides.get(target.combatant_id)!,
          stateRevisionBefore:target.state_revision}]});
      protocol(db,d,c,request,commandId,null,b,a,at,result,"combat_action_resolved",{kind:"action_resolved",actionId:"enemy-fallback",action:"attack"},"action",0);
      recordStateEvent(db,d,c.encounterId,target.combatant_id,hp,overrides.get(target.combatant_id)!,at,commandId,a);
      executeCombatCompositionPlan(db,compositionPlan);
      persistTurnAdvance(db,d,c.encounterId,turnPlan,at,commandId,a);}
    else { protocol(db,d,c,request,commandId,null,b,a,at,result,"encounter_state_changed",{kind:"turn_advanced",combatantId:current.combatant_id},"encounter_state",0); complete(db,c.encounterId,at); }
  } else {const turnPlan=next(db,c.encounterId,current.combatant_id,e.round_number),roundAfter=turnPlan?.round??e.round_number;
    const compositionPlan=buildCombatCompositionPlan(db,d.ids,{encounterId:c.encounterId,campaignId:c.campaignId,
      roundBefore:e.round_number,roundAfter,occurredAt:at,combatantChanges:[]});
    protocol(db,d,c,request,commandId,null,b,a,at,result,"encounter_state_changed",{kind:"turn_advanced",combatantId:current.combatant_id},"encounter_state",0);
    executeCombatCompositionPlan(db,compositionPlan);turn(db,c.encounterId,e,current.combatant_id,at);}
  advanceRevision(db,c.encounterId,a,at);return result;
}
