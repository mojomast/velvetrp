import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { settleCombatRewardV51 } from "../grantSettlementRepo.js";
import {
  encounterCommandSchema,
  combatActionCommandRequestSchema,
  combatEnemyTurnCommandRequestSchema,
  combatActionCommandResponseSchema,
  combatActionResolutionSchema,
  combatEndCommandRequestSchema,
  combatEndCommandResponseSchema,
  encounterCreateRequestSchema,
  encounterStartCommandRequestSchema,
  currencyCatalogDefinitionSchema,
  currencyCodeSchema,
  enemyTemplateCatalogDefinitionSchema,
  resourceIdSchema,
  utcIsoTimestampSchema,
  type EncounterCommand,
  type CombatActionCommandRequest,
  type CombatEnemyTurnCommandRequest,
  type CombatActionResolution,
  type CombatEndCommandRequest,
  type CombatRewardGrantPublic,
  type EncounterCreateRequest,
  type EncounterStartCommandRequest,
  type LegalCombatActionAllowlist,
  type UseConsumableCommandRequest,
  type UseConsumableCommandResult,
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
import { beginDndCombatTurn, buildCombatActionPlans, buildRangedCombatCandidate, buildThrownCombatCandidate, consumeDndTurnCost, coverArmorClassBonus, endDndCombatTurn, isDndCombat } from "./combatActionPlan.js";
import { buildCombatCompositionPlan, type CombatantStateChange } from "./combatCompositionPlan.js";
import { executeCombatCompositionPlan } from "./combatCompositionExecutor.js";
import { executeUseConsumable } from "./useConsumableRuntime.js";
import { buildCombatPowerLegalActions, executeCombatPower, getCombatPowerResultByKey, type CombatPowerRequest, type CombatPowerResult } from "./combatPowerRuntime.js";
import { resolveCampaignRuleset } from "../../rulesets/campaignBinding.js";
import { DND_5E_UNARMED_STRIKE, dnd5eProficiencyBonus, planDnd5eAttackConditions, type ConditionId } from "../../rulesets/index.js";
import { resolveSrdEquipment } from "../srdEquipmentRuntime.js";
import { absorbDamage, applyCombatCondition, conditionsFor, interruptConcentrationAfterDamage, readActorExhaustion, removeCombatCondition } from "./combatConditionRuntime.js";
import { adjustedCombatDamage, resolveCombatDamageAdjustment } from "./damageAdjustment.js";
import { isMonsterKnockdown, planMonsterTurn } from "./monsterTurnPlanner.js";
import { readReactionAvailability } from "./opportunityAttackRuntime.js";

export type EncounterDependencies={clock:Clock;ids:IdGenerator;rng:RandomNumberGenerator};
export type EncounterReceipt={commandId:string;idempotencyKey:string;revisionBefore:number;revisionAfter:number;occurredAt:string};
export type EncounterResult<T extends object>=T&{receipt:EncounterReceipt};
export type EncounterRewardGrantSnapshot=CombatRewardGrantPublic&{campaignId:string;encounterId:string};

const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==="object"&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=(v:unknown)=>createHash("sha256").update(canonical(v)).digest("hex");
const id=(d:EncounterDependencies)=>resourceIdSchema.parse(d.ids.nextId());
const now=(d:EncounterDependencies)=>utcIsoTimestampSchema.parse(d.clock.now().toISOString());
const member=(db:DatabaseDriver.Database,p:string,c:string)=>Boolean(db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(c,p));
const gm=(db:DatabaseDriver.Database,p:string,c:string)=>Boolean(db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')").get(c,p));
const controls=(db:DatabaseDriver.Database,p:string,c:string,a:string)=>Boolean(db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?").get(c,a,p));
const commandType=(t:string)=>t==="create_encounter"||t==="start_encounter"||t==="resolve_initiative"||t==="join_combatant"?"start":t==="advance_turn"||t==="advance_round"?"advance_turn":t==="flee"?"flee":t==="claim_reward_bundle"||t==="end_combat"?"grant_rewards":"resolve_action";
const actionTypes=new Set(["attack","power","item","defend","flee","end-turn","dash","disengage","help","hide"]);
const dndCommandTypes=new Set(["attack","dash","disengage","help","hide","flee","end-turn"]);

/** Dependencies required by transactional encounter commands. */
export interface EncounterWriteDependencies extends EncounterDependencies {
  reads: Pick<EncounterReadRepository, "getLegalCombatActionAllowlist" | "getCombatState" | "listEncounters">;
  assertFactoryMutation(): void;
}

/** State-changing encounter commands. */
export interface EncounterWriteRepository {
  createEncounter(principal:string,campaignId:string,input:EncounterCreateRequest):EncounterResult<{campaignId:string;encounter:EncounterLifecycleSnapshot}>;
  startEncounter(principal:string,encounterId:string,input:EncounterStartCommandRequest):EncounterResult<{campaignId:string;encounterId:string;combat:EncounterCombatSnapshot}>;
  resolveCombatAction(principal:string,combatId:string,input:CombatActionCommandRequest):EncounterResult<{campaignId:string;encounterId:string;resolution:CombatActionResolution;combat:EncounterCombatSnapshot}>;
  executeCombatEnemyTurn(principal:string,combatId:string,input:CombatEnemyTurnCommandRequest):EncounterResult<{campaignId:string;encounterId:string;resolution:CombatActionResolution;combat:EncounterCombatSnapshot}>;
  endCombat(principal:string,combatId:string,input:CombatEndCommandRequest):EncounterResult<{campaignId:string;encounterId:string;encounter:EncounterLifecycleSnapshot;rewards:EncounterRewardGrantSnapshot[]}>;
  executeEncounterCommand(principal:string, command:EncounterCommand):EncounterResult<{encounterId:string;status:string}>;
  mutateEncounter(principal:string, command:EncounterCommand):EncounterResult<{encounterId:string;status:string}>;
  useConsumable(principal:string,input:UseConsumableCommandRequest):UseConsumableCommandResult;
  useCombatPower(principal:string,input:CombatPowerRequest):CombatPowerResult;
  getCombatPowerLegalActions(principal:string,combatId:string):Array<ReturnType<typeof buildCombatPowerLegalActions>[number]&{revisions:{combat:number;sourceM15:number;sourceM16:number;targetM15:number|null;targetM16:number|null}}>;
  getCombatPowerResultByKey(principal:string,combatId:string,idempotencyKey:string):{request:CombatPowerRequest;result:CombatPowerResult}|null;
  claimCombatReward(principal:string,combatId:string,rewardBundleId:string,input:{rewardClaimId:string;expectedRevision:number;idempotencyKey:string}):EncounterResult<{encounterId:string;status:string}>;
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
        const combatantId=id(deps),initiative=campaignInitiative(db,deps,parsedCampaignId,combatant.kind==="actor"?combatant.actorId:null),tie=deps.rng.integer(0,1000001);
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
      const preparedActors=db.prepare(`SELECT combatant.hit_points,combatant.maximum_hit_points,
        health.current health_current,health.max health_max FROM combatant
        LEFT JOIN rpg_actor_resources health ON health.campaign_id=combatant.campaign_id
          AND health.actor_id=combatant.actor_id AND health.name='health'
        WHERE combatant.encounter_id=? AND combatant.actor_id IS NOT NULL`).all(encounterId) as Array<{
          hit_points:number;maximum_hit_points:number;health_current:number|null;health_max:number|null}>;
      if(preparedActors.some(actor=>actor.health_current===null||actor.health_max===null||actor.health_current<=0
          ||actor.hit_points!==actor.health_current||actor.maximum_hit_points!==actor.health_max))
        throw new EncounterConflictError("prepared actor health changed before encounter activation");
      if(db.prepare(`SELECT 1 FROM combatant candidate JOIN combatant active ON active.actor_id=candidate.actor_id
        JOIN encounter other ON other.encounter_id=active.encounter_id AND other.status='active'
        WHERE candidate.encounter_id=? AND candidate.actor_id IS NOT NULL AND active.encounter_id<>? LIMIT 1`)
        .get(encounterId,encounterId))throw new EncounterConflictError("an actor is already in an active encounter");
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
      beginDndCombatTurn(db,encounter.campaign_id,encounterId,first.combatant_id,1,id(deps),at);
      advanceRevision(db,encounterId,after,at);
      const combat=deps.reads.getCombatState(p,encounterId);
      if(!combat)throw new Error("started combat projection is unavailable");
      const result={campaignId:encounter.campaign_id,encounterId,combat,receipt:{commandId,
        idempotencyKey:command.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at}};
      sealReceipt(db,encounterId,commandId,after,at,result);
      return result;
    }).immediate();
  };

  const resolveCombatAction=(p:string,combatIdInput:string,input:CombatActionCommandRequest,legacyRequest?:string):EncounterResult<{campaignId:string;encounterId:string;resolution:CombatActionResolution;combat:EncounterCombatSnapshot}>=>{
    deps.assertFactoryMutation();
    const combatId=resourceIdSchema.parse(combatIdInput),command=combatActionCommandRequestSchema.parse(input),request=legacyRequest??canonical(command);
    return db.transaction(()=>{
      const encounter=db.prepare("SELECT * FROM encounter WHERE encounter_id=?").get(combatId) as any;
      if(!encounter)throw new EncounterUnavailableError("combat unavailable");
      if(!member(db,p,encounter.campaign_id))throw new EncounterAuthorizationError("combat unavailable");
      const isGm=gm(db,p,encounter.campaign_id);
      const replay=db.prepare(`SELECT command.command_type,command.actor_id,command.canonical_request_json,
        receipt.canonical_result_json FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt
          ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        WHERE command.encounter_id=? AND command.idempotency_key=?`).get(combatId,command.idempotencyKey) as any;
      if(replay){
        if(!isGm&&(!replay.actor_id||!controls(db,p,encounter.campaign_id,replay.actor_id)))
          throw new EncounterAuthorizationError("combat action unavailable");
        if(replay.command_type!=="resolve_action"||replay.canonical_request_json!==request)
          throw new EncounterConflictError("idempotency key was reused");
        return JSON.parse(replay.canonical_result_json);
      }
      const root=db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(combatId) as any;
      if(!root||root.revision!==command.expectedRevision)throw new EncounterStaleError("combat revision is stale");
      if(encounter.status!=="active"||encounter.current_turn_combatant_id===null)
        throw new EncounterTurnError("combat has no current turn");
      const current=db.prepare("SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status IN ('active','unconscious')")
        .get(combatId,encounter.current_turn_combatant_id) as any;
      if(!current)throw new EncounterTurnError("combat has no current combatant");
      if(!isGm&&(!current.actor_id||!controls(db,p,encounter.campaign_id,current.actor_id)))
        throw new EncounterAuthorizationError("combat action unavailable");
      const dnd=isDndCombat(db,encounter.campaign_id);
      if(dnd&&current.combatant_kind==="enemy")throw new EncounterAuthorizationError("D&D enemy turns are server-authoritative");
      // Typed legacy commands carry no equipment identity; resolve current equipment only after replay lookup.
      const plan=buildCombatActionPlans(db,p,encounter.campaign_id,combatId,current.combatant_id)
        .find((candidate)=>candidate.legalActionId===command.legalActionId
          ||(legacyRequest!==undefined&&dnd&&command.legalActionId==="attack:basic"&&candidate.kind==="attack"));
      if(!plan)throw new EncounterConflictError("combat action is not legal");
       if(((plan.kind==="attack"||plan.kind==="stabilize"||plan.kind==="grapple"||plan.kind==="escape-grapple"||plan.kind==="help")
              &&(command.targetIds.length!==1||!plan.targetIds.includes(command.targetIds[0]!)))
            ||(plan.kind!=="attack"&&plan.kind!=="stabilize"&&plan.kind!=="grapple"&&plan.kind!=="escape-grapple"&&plan.kind!=="help"&&command.targetIds.length!==0))
         throw new EncounterConflictError("combat action targets are not legal");

      const at=now(deps);
      let outcome:any=null;
      if(plan.kind==="attack"){
        const target=db.prepare(`SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status ${dnd?"IN ('active','unconscious','stable')":"='active'"}`)
          .get(combatId,command.targetIds[0]!) as any;
        if(!target)throw new EncounterConflictError("combat target is unavailable");
        let binding:ReturnType<typeof resolveCampaignRuleset>;
        try{binding=resolveCampaignRuleset(db,encounter.campaign_id);}catch{throw new EncounterConflictError("campaign ruleset binding is unavailable");}
        if(binding.rulesetId==="dnd-5e"){
          if(!current.actor_id||!binding.module.mechanics)throw new EncounterConflictError("SRD basic attack is unavailable for this combatant");
          const sheet=db.prepare(`SELECT actor.sheet_id,progression.level,progression.derived_json FROM campaign_actors actor
            JOIN character_progression_v23 progression ON progression.actor_id=actor.id WHERE actor.campaign_id=? AND actor.id=?`)
            .get(encounter.campaign_id,current.actor_id) as {sheet_id:string;level:number;derived_json:string}|undefined;
          if(!sheet)throw new EncounterConflictError("SRD attacker sheet is incomplete");
          let equipment:ReturnType<typeof resolveSrdEquipment>;
          try{equipment=resolveSrdEquipment(db,encounter.campaign_id,current.actor_id);}catch{throw new EncounterConflictError("SRD equipment is unavailable");}
          const weapon=equipment.weapon;
          // SRD 5.1: every creature is proficient with unarmed strikes and always has one.
          const unarmed=weapon===null;
           const thrown = !unarmed && weapon.properties.some((value) => value.property === "thrown");
           const ranged = !unarmed && !thrown && weapon.properties.some((value) => value.property === "ammunition");
           const thrownCandidate = thrown ? buildThrownCombatCandidate(db, encounter.campaign_id, combatId, current.actor_id, [target.combatant_id]) : null;
           const rangedCandidate = ranged ? buildRangedCombatCandidate(db, encounter.campaign_id, combatId, current.actor_id, [target.combatant_id]) : null;
           if (thrown && (!thrownCandidate || !thrownCandidate.targetIds.includes(target.combatant_id)))
             throw new EncounterConflictError("thrown attack is unavailable at this position or item");
           if (ranged && (!rangedCandidate || !rangedCandidate.targetIds.includes(target.combatant_id)))
             throw new EncounterConflictError("ranged attack is unavailable at this position");
          const ability=db.prepare("SELECT value FROM rpg_character_attributes WHERE campaign_id=? AND sheet_id=? AND attribute_id=?")
            .get(encounter.campaign_id,sheet.sheet_id,unarmed?DND_5E_UNARMED_STRIKE.attackAbility:weapon.attackAbility) as {value:number}|undefined;
          if(!ability)throw new EncounterConflictError("SRD attacker sheet is incomplete");
          let armorClass:number;
          if(target.actor_id){try{armorClass=resolveSrdEquipment(db,encounter.campaign_id,target.actor_id).armorClass;}
            catch{throw new EncounterConflictError("SRD target equipment is unavailable");}}
          else{const definition=db.prepare(`SELECT definition.definition_json FROM encounter_enemy_provenance_v31 provenance
            JOIN rpg_catalog_definitions definition ON definition.pack_id=provenance.pack_id AND definition.pack_version=provenance.pack_version
              AND definition.kind=provenance.kind AND definition.definition_id=provenance.definition_id WHERE provenance.combatant_id=?`)
            .get(target.combatant_id) as {definition_json:string}|undefined;armorClass=Number(definition&&JSON.parse(definition.definition_json).mechanics.defense);}
          if(!Number.isInteger(armorClass))throw new EncounterConflictError("SRD target armor class is unavailable");
             const candidate = thrownCandidate ?? rangedCandidate;
             const rangeFeet=candidate?.rangeFeetByTarget[target.combatant_id];
             const cover = candidate?.targetEvidence.find((evidence) => evidence.targetCombatantId === target.combatant_id)?.cover;
             const adjustedArmorClass = armorClass + (cover ? coverArmorClassBonus(cover) : 0);
             const attackPlan=planDnd5eAttackConditions({
               attacker:[...conditionsFor(db,combatId,current.combatant_id,encounter.round_number)] as ConditionId[],
               target:[...conditionsFor(db,combatId,target.combatant_id,encounter.round_number)] as ConditionId[],
               kind: ranged ? "ranged" : thrown ? "thrown" : "melee",
               longRange: rangeFeet !== undefined && rangeFeet > (candidate?.normalRangeFeet ?? 0),
               attackerExhaustion: current.actor_id ? readActorExhaustion(db,encounter.campaign_id,current.actor_id) : 0});
             const firstRoll=deps.rng.integer(1,21);if(!Number.isInteger(firstRoll)||firstRoll<1||firstRoll>20)throw new Error("combat RNG returned an out-of-range d20");
             const attackRoll=attackPlan.mode==="normal"?firstRoll:attackPlan.mode==="advantage"?Math.max(firstRoll,deps.rng.integer(1,21)):Math.min(firstRoll,deps.rng.integer(1,21));
           const attack=binding.module.mechanics.resolveAttack({rolls:[attackRoll],abilityScore:ability.value,
             proficiencyBonus:(unarmed?DND_5E_UNARMED_STRIKE.proficient:weapon.proficient)?binding.module.proficiencyBonus(sheet.level):0,armorClass:adjustedArmorClass});
          const critical=attack.critical || (attackPlan.autoCritical && attack.hit);
          const die=unarmed?DND_5E_UNARMED_STRIKE.damageDie:weapon.damage.die;
          const damageRolls=attack.hit?Array.from({length:die.count*(critical?2:1)},()=>deps.rng.integer(1,die.sides+1)):[];
          if(damageRolls.some(value=>!Number.isInteger(value)||value<1||value>die.sides))throw new Error("combat RNG returned an out-of-range damage die");
          const damage=attack.hit?binding.module.mechanics.resolveDamageRoll({dice:[die],rolls:[damageRolls],
            modifier:binding.module.abilityModifier(ability.value)+(unarmed?DND_5E_UNARMED_STRIKE.flatDamageBonus:0),critical}).total:0;
          const damageType=unarmed?DND_5E_UNARMED_STRIKE.damageType:weapon.damage.type;
          const adjustment=resolveCombatDamageAdjustment(db,encounter.campaign_id,target,damageType,at);
          const adjustedDamage=adjustedCombatDamage(damage,adjustment);
            let ammunitionBefore: number | undefined, ammunitionAfter: number | undefined;
           if (rangedCandidate?.ammunitionResourceId) {
             const ammo=db.prepare("SELECT current_ammunition FROM rpg_actor_resource_ammunition_v25 WHERE campaign_id=? AND actor_id=? AND resource_name=?")
               .get(encounter.campaign_id,current.actor_id,rangedCandidate.ammunitionResourceId) as { current_ammunition: number } | undefined;
             if (!ammo || ammo.current_ammunition < 1) throw new EncounterConflictError("ammunition is unavailable");
             ammunitionBefore=ammo.current_ammunition; ammunitionAfter=ammo.current_ammunition-1;
             const changed=db.prepare("UPDATE rpg_actor_resource_ammunition_v25 SET current_ammunition=? WHERE campaign_id=? AND actor_id=? AND resource_name=? AND current_ammunition=?")
               .run(ammunitionAfter,encounter.campaign_id,current.actor_id,rangedCandidate.ammunitionResourceId,ammunitionBefore);
              if (changed.changes !== 1) throw new EncounterConflictError("ammunition changed before attack");
            }
            let thrownItemBefore: number | undefined, thrownItemAfter: number | undefined;
            if (thrownCandidate) {
              const item = db.prepare("SELECT quantity,entry_mode,equipped FROM rpg_inventory_entries_v25 WHERE entry_id=? AND campaign_id=? AND actor_id=?")
                .get(thrownCandidate.throwableItemEntryId, encounter.campaign_id, current.actor_id) as { quantity: number; entry_mode: string; equipped: number } | undefined;
              if (!item || item.equipped !== 0 || item.quantity < 1) throw new EncounterConflictError("throwable item is unavailable");
              thrownItemBefore = item.quantity; thrownItemAfter = item.quantity - 1;
              const changed = thrownItemAfter === 0
                ? db.prepare("DELETE FROM rpg_inventory_entries_v25 WHERE entry_id=? AND campaign_id=? AND actor_id=? AND equipped=0 AND quantity=1").run(thrownCandidate.throwableItemEntryId, encounter.campaign_id, current.actor_id)
                : db.prepare("UPDATE rpg_inventory_entries_v25 SET quantity=quantity-1 WHERE entry_id=? AND campaign_id=? AND actor_id=? AND equipped=0 AND quantity=?").run(thrownCandidate.throwableItemEntryId, encounter.campaign_id, current.actor_id, thrownItemBefore);
              if (changed.changes !== 1) throw new EncounterConflictError("throwable item changed before attack");
            }
           const absorbed=absorbDamage(db,combatId,target.combatant_id,adjustedDamage,at),hitPointsAfter=Math.max(0,target.hit_points-absorbed.hitPointDamage);
          outcome={kind:"damage",targetId:command.targetIds[0]!,damageType,requested:damage,adjustment,
            applied:target.hit_points-hitPointsAfter,temporaryHitPointsAbsorbed:adjustedDamage-absorbed.hitPointDamage,temporaryHitPointsAfter:absorbed.temporaryHitPointsAfter,hitPointsBefore:target.hit_points,hitPointsAfter,
            statusBefore:target.status,statusAfter:dndDamageStatus(db,target,hitPointsAfter,absorbed.hitPointDamage),rulesetId:binding.rulesetId,
             rulesetVersion:binding.rulesetVersion,attackRoll,attackTotal:attack.total,armorClass:adjustedArmorClass,hit:attack.hit,
             critical,damageRolls,...(candidate ? { attackAbility: candidate.attackAbility, attackModifier: binding.module.abilityModifier(ability.value),
                 rangeFeet: rangeFeet!, normalRangeFeet:candidate.normalRangeFeet, longRangeFeet:candidate.longRangeFeet,
                 ...(candidate.targetEvidence ? { targetEvidence: candidate.targetEvidence } : {}),
                 disadvantage:attackPlan.mode==="disadvantage", ...(rangedCandidate ? { ammunitionResourceId:rangedCandidate.ammunitionResourceId, ammunitionBefore, ammunitionAfter } : {}),
                ...(thrownCandidate ? { thrownItemEntryId: thrownCandidate.throwableItemEntryId, thrownItemBefore, thrownItemAfter, targetEvidence: thrownCandidate.targetEvidence } : {}) } : {})};
          const concentrationCheck=interruptConcentrationAfterDamage(db,deps.ids,deps.rng,encounter.campaign_id,combatId,target.combatant_id,
            target.hit_points-hitPointsAfter,outcome.statusAfter,at);if(concentrationCheck)outcome.concentrationCheck=concentrationCheck;
        }else{const hitPointsAfter=Math.max(0,target.hit_points-1);outcome={kind:"damage",targetId:command.targetIds[0]!,damageType:"physical",requested:1,
          applied:target.hit_points-hitPointsAfter,hitPointsBefore:target.hit_points,hitPointsAfter,
          statusBefore:"active",statusAfter:hitPointsAfter===0?"defeated":"active"};}
       }else if(plan.kind==="stabilize"){
        const target=db.prepare("SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND team=? AND combatant_kind='actor' AND status='unconscious'")
          .get(combatId,command.targetIds[0]!,current.team) as any;
        if(!target)throw new EncounterConflictError("combatant cannot be stabilized");
        setSurvival(db,combatId,target.combatant_id,0,0,true);
        outcome={kind:"survival",targetId:target.combatant_id,successes:0,failures:0,statusAfter:"stable",hitPointsBefore:target.hit_points,hitPointsAfter:target.hit_points,statusBefore:target.status};
       }else if(plan.kind==="grapple"||plan.kind==="escape-grapple"){
         const targetId=command.targetIds[0]!;
         const target=plan.kind==="grapple" ? db.prepare(`SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'`)
           .get(combatId,targetId) as any : db.prepare(`SELECT source_combatant_id combatant_id FROM combat_conditions_v62
             WHERE encounter_id=? AND combatant_id=? AND condition='grappled' LIMIT 1`).get(combatId,current.combatant_id) as any;
         if(!target)throw new EncounterConflictError("grapple target is unavailable");
         if(plan.kind==="escape-grapple" && !conditionsFor(db,combatId,current.combatant_id,encounter.round_number).has("grappled"))
           throw new EncounterConflictError("combatant is not grappled");
         const grappling=plan.kind==="grapple";
         const attackerScore=contestScore(db,encounter.campaign_id,current,grappling?"athletics":"best");
         const defenderScore=contestScore(db,encounter.campaign_id,target,grappling?"best":"athletics");
         const attackerRoll=deps.rng.integer(1,21),defenderRoll=deps.rng.integer(1,21);
         if(!Number.isInteger(attackerRoll)||attackerRoll<1||attackerRoll>20||!Number.isInteger(defenderRoll)||defenderRoll<1||defenderRoll>20)
           throw new Error("combat RNG returned an out-of-range contest d20");
         const success=attackerRoll+attackerScore>=defenderRoll+defenderScore;
         if(plan.kind==="grapple"&&success) outcome={kind:"contest",targetId,contest:"grapple",attackerRoll,defenderRoll,success,condition:"grappled"};
         else outcome={kind:"contest",targetId:current.combatant_id,contest:"escape-grapple",attackerRoll,defenderRoll,success};
       }else if(plan.kind==="death-save"){
        const roll=deps.rng.integer(1,21);if(!Number.isInteger(roll)||roll<1||roll>20)throw new Error("combat RNG returned an out-of-range d20");
        const prior=survival(db,combatId,current.combatant_id),failures=Math.min(3,prior.failures+(roll===1?2:roll<10?1:0)),successes=Math.min(3,prior.successes+(roll>=10&&roll!==20?1:0));
        const statusAfter=roll===20?"active":failures===3?"dead":successes===3?"stable":"unconscious",hitPointsAfter=roll===20?1:current.hit_points;
        if(roll===20)db.prepare("DELETE FROM combat_survival_v61 WHERE encounter_id=? AND combatant_id=?").run(combatId,current.combatant_id);
        else setSurvival(db,combatId,current.combatant_id,successes,failures,statusAfter==="stable");
        outcome={kind:"survival",targetId:current.combatant_id,roll,successes,failures,statusAfter,hitPointsBefore:current.hit_points,hitPointsAfter,statusBefore:current.status};
        interruptConcentrationAfterDamage(db,deps.ids,deps.rng,encounter.campaign_id,combatId,current.combatant_id,0,statusAfter,at);
      }else if(plan.kind==="flee"){
        outcome={kind:"status",targetId:current.combatant_id,statusBefore:"active",statusAfter:"fled"};
      }
      const before=root.revision,after=before+1;
      const stateOverrides=new Map<string,string>();
      if(outcome?.kind==="damage"||outcome?.kind==="survival")stateOverrides.set(outcome.targetId,outcome.statusAfter);
      else if(outcome?.kind==="status")stateOverrides.set(current.combatant_id,"fled");
      const plannedAdvance=planTurnAdvance(db,combatId,encounter,current.combatant_id,stateOverrides);
       const keepsTurn=["attack","dash","disengage","help","hide"].includes(plan.kind) && dnd;
       const advancesTurn=!keepsTurn||plannedAdvance.nextId===null;
      const turnPlan=advancesTurn?plannedAdvance:{event:null,nextId:current.combatant_id,round:encounter.round_number};
      const combatantChanges:CombatantStateChange[]=(outcome?.kind==="damage"||outcome?.kind==="survival")?[{combatantId:outcome.targetId,
        hitPointsBefore:outcome.hitPointsBefore,hitPointsAfter:outcome.hitPointsAfter,statusBefore:outcome.statusBefore,
        statusAfter:outcome.statusAfter,stateRevisionBefore:(db.prepare("SELECT state_revision FROM combatant WHERE combatant_id=?")
          .get(outcome.targetId) as {state_revision:number}).state_revision}]:outcome?.kind==="status"?[{
        combatantId:current.combatant_id,hitPointsBefore:current.hit_points,hitPointsAfter:current.hit_points,
        statusBefore:"active",statusAfter:"fled",stateRevisionBefore:current.state_revision}]:[];
      const compositionPlan=buildCombatCompositionPlan(db,deps.ids,{encounterId:combatId,campaignId:encounter.campaign_id,
        roundBefore:encounter.round_number,roundAfter:turnPlan.round,occurredAt:at,
        combatantChanges});
      const commandId=id(deps),actionId=id(deps);
      const internal={type:"http_action",encounterId:combatId,idempotencyKey:command.idempotencyKey};
       beginProtocol(db,deps,internal,request,commandId,current.actor_id,before,after,at,"combat_action_resolved",
         {kind:"action_resolved",actionId,action:plan.kind},"action",0);
       if(plan.kind==="grapple"&&outcome?.success)
         applyCombatCondition(db,combatId,outcome.targetId,"grappled",current.combatant_id,commandId,null,at);
       if(plan.kind==="escape-grapple"&&outcome?.success)
         removeCombatCondition(db,combatId,current.combatant_id,"grappled");
      if(outcome?.kind==="damage"||outcome?.kind==="survival")recordStateEvent(db,deps,combatId,outcome.targetId,outcome.hitPointsAfter,outcome.statusAfter,at,commandId,after);
      else if(outcome?.kind==="status")recordStateEvent(db,deps,combatId,current.combatant_id,current.hit_points,"fled",at,commandId,after);
      executeCombatCompositionPlan(db,compositionPlan);
       if(dnd&&plan.cost)consumeDndTurnCost(db,combatId,current.combatant_id,plan.cost);
       if(dnd&&plan.kind==="disengage") db.prepare(`INSERT INTO combat_disengagement_v63(encounter_id,combatant_id,round_number,command_id)
         VALUES(?,?,?,?) ON CONFLICT(encounter_id,combatant_id,round_number) DO NOTHING`).run(combatId,current.combatant_id,encounter.round_number,commandId);
      if(advancesTurn)persistTurnAdvance(db,deps,combatId,turnPlan,at,commandId,after);
      advanceRevision(db,combatId,after,at);
      const combat=deps.reads.getCombatState(p,combatId);
      if(!combat)throw new Error("resolved combat projection is unavailable");
      const resolution=combatActionResolutionSchema.parse({actionId,legalActionId:plan.legalActionId,kind:plan.kind,
        actingCombatantId:current.combatant_id,targetIds:command.targetIds,outcomes:outcome?[outcome]:[],
        roundBefore:encounter.round_number,roundAfter:combat.round,currentCombatantBefore:current.combatant_id,
        currentCombatantAfter:combat.currentCombatant});
      const receipt={commandId,idempotencyKey:command.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at};
      combatActionCommandResponseSchema.parse({resolution,combat:{combatId:combat.combatId,round:combat.round,
        currentCombatant:combat.currentCombatant,combatants:combat.combatants,legalActions:combat.legalActions,revision:combat.revision},
        receipt:{idempotencyKey:receipt.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at}});
      const result={campaignId:encounter.campaign_id,encounterId:combatId,resolution,combat,receipt};
      if(canonical(result).length>32_768)throw new EncounterConflictError("combat action result exceeds receipt bounds");
      sealReceipt(db,combatId,commandId,after,at,result);
      return result;
    }).immediate();
  };

  const executeCombatEnemyTurn=(p:string,combatIdInput:string,input:CombatEnemyTurnCommandRequest):EncounterResult<{campaignId:string;encounterId:string;resolution:CombatActionResolution;combat:EncounterCombatSnapshot}>=>{
    deps.assertFactoryMutation();
    const combatId=resourceIdSchema.parse(combatIdInput),command=combatEnemyTurnCommandRequestSchema.parse(input),request=canonical(command);
    return db.transaction(()=>{
      const encounter=db.prepare("SELECT * FROM encounter WHERE encounter_id=?").get(combatId) as any;
      if(!encounter)throw new EncounterUnavailableError("combat unavailable");
      if(!gm(db,p,encounter.campaign_id))throw new EncounterAuthorizationError("enemy turn requires GM authority");
      const replay=db.prepare(`SELECT command_type,canonical_request_json FROM combat_commands_v27 WHERE encounter_id=? AND idempotency_key=?`).get(combatId,command.idempotencyKey) as any;
      if(replay){
        if(replay.command_type!=="resolve_action"||replay.canonical_request_json!==request)throw new EncounterConflictError("idempotency key was reused");
        const receipt=db.prepare("SELECT canonical_result_json FROM combat_receipts_v27 WHERE encounter_id=? AND command_id=(SELECT command_id FROM combat_commands_v27 WHERE encounter_id=? AND idempotency_key=? )").get(combatId,combatId,command.idempotencyKey) as any;
        if(!receipt)throw new Error("enemy turn receipt is unavailable");
        return JSON.parse(receipt.canonical_result_json);
      }
      const root=db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(combatId) as any;
      if(!root||root.revision!==command.expectedRevision)throw new EncounterStaleError("combat revision is stale");
      if(encounter.status!=="active"||encounter.current_turn_combatant_id===null)throw new EncounterTurnError("combat has no current turn");
      if(!isDndCombat(db,encounter.campaign_id))throw new EncounterConflictError("enemy turn is only available for D&D combat");
      const current=db.prepare("SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'").get(combatId,encounter.current_turn_combatant_id) as any;
      if(!current||current.combatant_kind!=="enemy")throw new EncounterTurnError("current turn is not an enemy");
       const plan=planMonsterTurn(db,combatId,current,encounter.round_number),ability=plan.ability;
       const effect=ability.mechanics.effects[0] as any;
        const target=plan.target;
       const at=now(deps);
       let outcome:any=null,legalActionId="end-turn",targetIds:string[]=[];
      if(target){
        let armorClass:number;try{armorClass=resolveSrdEquipment(db,encounter.campaign_id,target.actor_id).armorClass;}catch{armorClass=NaN;}
        if(Number.isInteger(armorClass)){
             const attackPlan=planDnd5eAttackConditions({
               attacker:[...conditionsFor(db,combatId,current.combatant_id,encounter.round_number)] as ConditionId[],
               target:[...conditionsFor(db,combatId,target.combatant_id,encounter.round_number)] as ConditionId[],
               kind:"melee"});
             const diceCount=attackPlan.mode==="normal"?plan.attackRollCount:Math.max(2,plan.attackRollCount);
             const rolls=Array.from({length:diceCount},()=>deps.rng.integer(1,21));
             if(rolls.some((value)=>!Number.isInteger(value)||value<1||value>20))throw new Error("combat RNG returned an out-of-range d20");
             const attackRoll=attackPlan.mode==="disadvantage"?Math.min(...rolls):Math.max(...rolls);
            const profile=plan.enemy.mechanics.combatProfile!;
            const binding=resolveCampaignRuleset(db,encounter.campaign_id),attack=binding.module.mechanics!.resolveAttack({rolls:[attackRoll],abilityScore:10,
               proficiencyBonus:profile.proficiencyBonus,flatBonus:profile.attack.attackBonus-profile.proficiencyBonus,armorClass});
           const critical=attack.critical || (attackPlan.autoCritical && attack.hit);
           const die=effect.dice,damageRolls=attack.hit?Array.from({length:die.count*(critical?2:1)},()=>deps.rng.integer(1,die.sides+1)):[];
           if(damageRolls.some(value=>!Number.isInteger(value)||value<1||value>die.sides))throw new Error("combat RNG returned an out-of-range damage die");
            const damage=attack.hit?binding.module.mechanics!.resolveDamageRoll({dice:[die],rolls:[damageRolls],modifier:effect.dice.modifier,critical}).total:0;
             const adjustment=resolveCombatDamageAdjustment(db,encounter.campaign_id,target,effect.damageType,at),adjustedDamage=adjustedCombatDamage(damage,adjustment);
             const absorbed=absorbDamage(db,combatId,target.combatant_id,adjustedDamage,at),hitPointsAfter=Math.max(0,target.hit_points-absorbed.hitPointDamage);legalActionId=plan.legalActionId;targetIds=[target.combatant_id];
            outcome={kind:"damage",targetId:target.combatant_id,damageType:effect.damageType,requested:damage,adjustment,applied:target.hit_points-hitPointsAfter,temporaryHitPointsAbsorbed:adjustedDamage-absorbed.hitPointDamage,temporaryHitPointsAfter:absorbed.temporaryHitPointsAfter,
             hitPointsBefore:target.hit_points,hitPointsAfter,statusBefore:target.status,statusAfter:dndDamageStatus(db,target,hitPointsAfter,absorbed.hitPointDamage),rulesetId:binding.rulesetId,rulesetVersion:binding.rulesetVersion,
             attackRoll,attackTotal:attack.total,armorClass,hit:attack.hit,critical,damageRolls};
           const concentrationCheck=interruptConcentrationAfterDamage(db,deps.ids,deps.rng,encounter.campaign_id,combatId,target.combatant_id,
             target.hit_points-hitPointsAfter,outcome.statusAfter,at);if(concentrationCheck)outcome.concentrationCheck=concentrationCheck;
        }
      }
       const before=root.revision,after=before+1,overrides=new Map<string,string>();if(outcome)overrides.set(outcome.targetId,outcome.statusAfter);
      const turnPlan=planTurnAdvance(db,combatId,encounter,current.combatant_id,overrides),changes:CombatantStateChange[]=outcome?[{combatantId:outcome.targetId,hitPointsBefore:outcome.hitPointsBefore,hitPointsAfter:outcome.hitPointsAfter,statusBefore:"active",statusAfter:outcome.statusAfter,stateRevisionBefore:target.state_revision}]:[];
      const compositionPlan=buildCombatCompositionPlan(db,deps.ids,{encounterId:combatId,campaignId:encounter.campaign_id,roundBefore:encounter.round_number,roundAfter:turnPlan.round,occurredAt:at,combatantChanges:changes});
      const commandId=id(deps),actionId=id(deps),internal={type:"enemy_turn",encounterId:combatId,idempotencyKey:command.idempotencyKey};
       beginProtocol(db,deps,internal,request,commandId,null,before,after,at,"combat_action_resolved",{kind:"action_resolved",actionId,action:outcome?"attack":"end-turn"},"action",0);
       if(outcome && isMonsterKnockdown(plan, outcome.hit === true)) applyCombatCondition(db,combatId,outcome.targetId,"prone",current.combatant_id,commandId,encounter.round_number+1,at);
      if(outcome)recordStateEvent(db,deps,combatId,outcome.targetId,outcome.hitPointsAfter,outcome.statusAfter,at,commandId,after);
      executeCombatCompositionPlan(db,compositionPlan);if(outcome)consumeDndTurnCost(db,combatId,current.combatant_id,"action");persistTurnAdvance(db,deps,combatId,turnPlan,at,commandId,after);advanceRevision(db,combatId,after,at);
      const combat=deps.reads.getCombatState(p,combatId);if(!combat)throw new Error("enemy turn projection is unavailable");
      const resolution=combatActionResolutionSchema.parse({actionId,legalActionId,kind:outcome?"attack":"end-turn",actingCombatantId:current.combatant_id,targetIds,outcomes:outcome?[outcome]:[],roundBefore:encounter.round_number,roundAfter:combat.round,currentCombatantBefore:current.combatant_id,currentCombatantAfter:combat.currentCombatant});
      const receipt={commandId,idempotencyKey:command.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at},result={campaignId:encounter.campaign_id,encounterId:combatId,resolution,combat,receipt};
      sealReceipt(db,combatId,commandId,after,at,result);return result;
    }).immediate();
  };

  const endCombat=(p:string,combatIdInput:string,input:CombatEndCommandRequest):EncounterResult<{campaignId:string;encounterId:string;encounter:EncounterLifecycleSnapshot;rewards:EncounterRewardGrantSnapshot[]}>=>{
    deps.assertFactoryMutation();
    const combatId=resourceIdSchema.parse(combatIdInput),command=combatEndCommandRequestSchema.parse(input),request=canonical(command);
    return db.transaction(()=>{
      const row=db.prepare("SELECT * FROM encounter WHERE encounter_id=?").get(combatId) as any;
      if(!row)throw new EncounterUnavailableError("combat unavailable");
      if(!gm(db,p,row.campaign_id))throw new EncounterAuthorizationError("combat end requires GM authority");
      const replay=db.prepare(`SELECT command.command_type,command.canonical_request_json,receipt.canonical_result_json
        FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt
          ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        WHERE command.encounter_id=? AND command.idempotency_key=?`).get(combatId,command.idempotencyKey) as any;
      if(replay){
        if(replay.command_type!=="grant_rewards"||replay.canonical_request_json!==request)
          throw new EncounterConflictError("idempotency key was reused");
        return JSON.parse(replay.canonical_result_json);
      }
      const root=db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(combatId) as any;
      if(!root||root.revision!==command.expectedRevision)throw new EncounterStaleError("combat revision is stale");
      const living=isDndCombat(db,row.campaign_id)?"IN ('active','unconscious','stable')":"='active'";
      const teams=(db.prepare(`SELECT count(DISTINCT team) count FROM combatant WHERE encounter_id=? AND status ${living}`)
        .get(combatId) as {count:number}).count;
      if(row.status!=="active"||row.current_turn_combatant_id!==null||teams>=2)
        throw new EncounterConflictError("combat is not terminal");

      const activeTeam=(db.prepare(`SELECT team FROM combatant WHERE encounter_id=? AND status ${living} LIMIT 1`)
        .get(combatId) as {team:string}|undefined)?.team??null;
      const recipients=activeTeam==="allies"?(db.prepare(`SELECT DISTINCT actor_id FROM combatant
         WHERE encounter_id=? AND team='allies' AND actor_id IS NOT NULL AND status IN ('active','unconscious','stable','defeated') ORDER BY actor_id`)
        .all(combatId) as Array<{actor_id:string}>).map((value)=>value.actor_id):[];
      const defeatedEnemies=db.prepare(`SELECT provenance.pack_id,provenance.pack_version,provenance.definition_id,
        definition.definition_json FROM combatant combatant
        JOIN encounter_enemy_provenance_v31 provenance ON provenance.combatant_id=combatant.combatant_id
        JOIN rpg_catalog_definitions definition ON definition.pack_id=provenance.pack_id
          AND definition.pack_version=provenance.pack_version AND definition.kind='enemy-template'
          AND definition.definition_id=provenance.definition_id
        WHERE combatant.encounter_id=? AND combatant.team='enemies' AND combatant.status='defeated'
        ORDER BY combatant.combatant_id`).all(combatId) as any[];
      const defeatedCount=(db.prepare(`SELECT count(*) count FROM combatant WHERE encounter_id=?
        AND combatant_kind='enemy' AND team='enemies' AND status='defeated'`).get(combatId) as {count:number}).count;
      if(activeTeam==="allies"&&defeatedEnemies.length!==defeatedCount)
        throw new EncounterConflictError("defeated enemy provenance is incomplete");
      let rewardAmount=0;
      for(const enemy of defeatedEnemies){
        const definition=enemyTemplateCatalogDefinitionSchema.parse(JSON.parse(enemy.definition_json));
        if(definition.reference.packId!==enemy.pack_id||definition.reference.packVersion!==enemy.pack_version
            ||definition.reference.definitionId!==enemy.definition_id)throw new EncounterConflictError("enemy reward provenance is invalid");
        rewardAmount+=definition.mechanics.tier;
      }
      const rewardCurrency=recipients.length>0&&rewardAmount>0?ensureRewardCurrency(db,row.campaign_id):null;
      const before=root.revision,after=before+1,at=now(deps),commandId=id(deps);
      const bundleIds=rewardCurrency?recipients.map(()=>id(deps)):[];
      const internal={type:"end_combat",encounterId:combatId,idempotencyKey:command.idempotencyKey};
      beginProtocol(db,deps,internal,request,commandId,null,before,after,at,"encounter_state_changed",
        {kind:"encounter_completed"},"encounter_state",0);
      db.prepare(`UPDATE encounter SET status='completed',current_turn_combatant_id=NULL,
        state_revision=state_revision+1,updated_at=? WHERE encounter_id=?`).run(at,combatId);
      endDndCombatTurn(db,combatId,at);
      const rewardEventId=id(deps),rewardEvent={kind:"rewards_granted",rewardBundleIds:bundleIds};
      db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(rewardEventId,combatId,commandId,after,
        "rewards_granted",canonical(rewardEvent),at);
      db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(id(deps),combatId,null,rewardEventId,1,
        "reward",canonical(rewardEvent),at);
      const rewards:EncounterRewardGrantSnapshot[]=[];
      if(rewardCurrency){
        recipients.forEach((recipientActorId,index)=>{
          const rewardBundleId=bundleIds[index]!;
          db.prepare(`INSERT INTO reward_bundle(reward_bundle_id,campaign_id,encounter_id,source_event_id,
            recipient_actor_id,created_at) VALUES(?,?,?,?,?,?)`).run(rewardBundleId,row.campaign_id,combatId,rewardEventId,recipientActorId,at);
          db.prepare(`INSERT INTO reward_entry_v27(reward_entry_id,campaign_id,reward_bundle_id,entry_ordinal,
            reward_kind,amount_minor,currency_code,currency_pack_id,currency_pack_version,currency_kind,
            currency_definition_id,created_at) VALUES(?,?,?,0,'currency',?,?,?,?, 'currency',?,?)`)
            .run(id(deps),row.campaign_id,rewardBundleId,rewardAmount,rewardCurrency.code,rewardCurrency.reference.packId,
              rewardCurrency.reference.packVersion,rewardCurrency.reference.definitionId,at);
          rewards.push({campaignId:row.campaign_id,encounterId:combatId,rewardBundleId,recipientActorId,createdAt:at,
            rewards:[{kind:"currency",currency:rewardCurrency.reference,amount:rewardAmount}],claim:{state:"unclaimed"}});
        });
      }
      advanceRevision(db,combatId,after,at);
      const encounter=deps.reads.listEncounters(p,row.campaign_id)?.find((value)=>value.encounterId===combatId);
      if(!encounter)throw new Error("completed encounter projection is unavailable");
      const receipt={commandId,idempotencyKey:command.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at};
      combatEndCommandResponseSchema.parse({encounter:{encounterId:encounter.encounterId,sessionId:encounter.sessionId,
        name:encounter.name,status:encounter.status,combatId:encounter.combatId,combatants:encounter.combatants,
        revision:encounter.revision,createdAt:encounter.createdAt,updatedAt:encounter.updatedAt},
        rewards:rewards.map(({campaignId:_campaignId,encounterId:_encounterId,...reward})=>reward),
        receipt:{idempotencyKey:receipt.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at}});
      const result={campaignId:row.campaign_id,encounterId:combatId,encounter,rewards,receipt};
      if(canonical(result).length>32_768)throw new EncounterConflictError("combat end result exceeds receipt bounds");
      sealReceipt(db,combatId,commandId,after,at,result);
      return result;
    }).immediate();
  };

  const execute=(p:string,input:EncounterCommand):EncounterResult<{encounterId:string;status:string}>=>{
    deps.assertFactoryMutation(); const command=encounterCommandSchema.parse(input), request=canonical(command);
    if(isDndCombat(db,command.campaignId)&&dndCommandTypes.has(command.type)){
      const c:any=command;
      const encounter=db.prepare("SELECT * FROM encounter WHERE encounter_id=? AND campaign_id=?").get(c.encounterId,c.campaignId) as any;
      if(!encounter)throw new EncounterUnavailableError("encounter unavailable");
      const prior=db.prepare("SELECT 1 FROM combat_commands_v27 WHERE encounter_id=? AND idempotency_key=?").get(c.encounterId,c.idempotencyKey);
      if(!prior&&c.combatantId!==encounter.current_turn_combatant_id)throw new EncounterTurnError("only the current combatant may act");
      if(c.type==="attack"&&c.attackId!=="basic_attack")throw new EncounterUnavailableError("D&D attack is unsupported");
      const result=resolveCombatAction(p,c.encounterId,{legalActionId:c.type==="attack"?"attack:basic":c.type==="help"?`help:${c.targetCombatantId}`:c.type,
        targetIds:c.type==="attack"||c.type==="help"?[c.targetCombatantId]:[],choices:[],expectedRevision:c.expectedRevision,idempotencyKey:c.idempotencyKey},request);
      return {encounterId:c.encounterId,status:"active",receipt:result.receipt};
    }
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
      if(isDndCombat(db,command.campaignId)){
        const current=currentCombatant(db,encounter);
       if(!current||command.combatantId!==current.combatant_id)throw new EncounterTurnError("only the current combatant may act");
         const action:any=command;
          if(!dndCommandTypes.has(command.type))throw new EncounterUnavailableError("D&D action is unsupported");
         if(action.type==="attack"&&action.attackId!=="basic_attack")throw new EncounterUnavailableError("D&D attack is unsupported");
          const result=resolveCombatAction(p,action.encounterId,{legalActionId:action.type==="attack"?"attack:basic":action.type==="help"?`help:${action.targetCombatantId}`:action.type,
            targetIds:action.type==="attack"||action.type==="help"?[action.targetCombatantId]:[],choices:[],expectedRevision:before,idempotencyKey:action.idempotencyKey});
        return {encounterId:command.encounterId,status:encounter.status,receipt:result.receipt};
      }
      if(encounter.status!=="active") throw new EncounterUnavailableError("encounter is not active");
      const current=currentCombatant(db,encounter);
      if(!current) throw new EncounterTurnError("no current combatant");
      if(!current.actor_id||!controls(db,p,command.campaignId,current.actor_id)) throw new EncounterAuthorizationError("only the current actor controller may act");
      if(command.combatantId!==current.combatant_id) throw new EncounterTurnError("only the current combatant may act");
      const allow=legal(p,command.campaignId,command.encounterId);
      if(!allow||allow.revision!==before||!allowed(allow,command)) throw new EncounterUnavailableError("action is not in the authoritative allowlist");
      // Powers/items are intentionally rejected rather than becoming a successful no-op; this
      // allowlist does not yet carry enough fixed server-owned mechanics to resolve either safely.
      if(command.type==="power"||command.type==="item") throw new EncounterUnavailableError("power and item combat resolution is unavailable");
      let combatantChange:CombatantStateChange|undefined;
      const overrides=new Map<string,string>();
      if(command.type==="attack"){
        const target=db.prepare("SELECT hit_points,status,state_revision FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'")
          .get(command.encounterId,command.targetCombatantId) as {hit_points:number;status:string;state_revision:number}|undefined;
        if(!target)throw new EncounterUnavailableError("attack target unavailable");
        const hitPointsAfter=Math.max(0,target.hit_points-1);
        combatantChange={combatantId:command.targetCombatantId,hitPointsBefore:target.hit_points,hitPointsAfter,
          statusBefore:target.status,statusAfter:hitPointsAfter===0?"defeated":"active",stateRevisionBefore:target.state_revision};
        overrides.set(command.targetCombatantId,hitPointsAfter===0?"defeated":"active");
      }else if(command.type==="flee"){
        overrides.set(current.combatant_id,"fled");combatantChange={combatantId:current.combatant_id,
          hitPointsBefore:current.hit_points,hitPointsAfter:current.hit_points,statusBefore:"active",statusAfter:"fled",
          stateRevisionBefore:current.state_revision};
      }
      const turnPlan=planTurnAdvance(db,command.encounterId,encounter,current.combatant_id,overrides);
      const compositionPlan=buildCombatCompositionPlan(db,deps.ids,{encounterId:command.encounterId,
        campaignId:command.campaignId,roundBefore:encounter.round_number,roundAfter:turnPlan.round,occurredAt:at,
        combatantChanges:combatantChange?[combatantChange]:[]});
      const result=receipt(command,commandId,before,after,at,encounter.status);
      protocol(db,deps,command,request,commandId,current.actor_id,before,after,at,result,"combat_action_resolved",{kind:"action_resolved",actionId:command.actionId,action:command.type},"action",0);
      if(command.type==="attack")recordStateEvent(db,deps,command.encounterId,command.targetCombatantId,
        combatantChange!.hitPointsAfter,overrides.get(command.targetCombatantId)!,at,commandId,after);
      if(command.type==="flee")recordStateEvent(db,deps,command.encounterId,current.combatant_id,current.hit_points,"fled",at,commandId,after);
      executeCombatCompositionPlan(db,compositionPlan);
      persistTurnAdvance(db,deps,command.encounterId,turnPlan,at,commandId,after);
      advanceRevision(db,command.encounterId,after,at); return result;
    }).immediate();
  };
  return {createEncounter:createLifecycleEncounter,startEncounter:startLifecycleEncounter,resolveCombatAction,executeCombatEnemyTurn,endCombat,
    claimCombatReward(principal,combatId,rewardBundleId,input){
      const bundle=db.prepare(`SELECT campaign_id,reward_bundle_id,recipient_actor_id FROM reward_bundle
        WHERE encounter_id=? AND reward_bundle_id=? AND recipient_actor_id IN(SELECT actor_id FROM campaign_actor_private_state WHERE controller_principal_id=?)`)
        .get(combatId,rewardBundleId,principal) as any;
      if(!bundle)throw new EncounterUnavailableError("reward bundle unavailable");
      return execute(principal,{type:"claim_reward_bundle",campaignId:bundle.campaign_id,encounterId:combatId,
        rewardClaimId:input.rewardClaimId,rewardBundleId:bundle.reward_bundle_id,recipientActorId:bundle.recipient_actor_id,
        claimedAt:now(deps),expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey});
    },
    executeEncounterCommand:execute,mutateEncounter:execute,
    useConsumable(principal,input){deps.assertFactoryMutation();return executeUseConsumable(db,deps,principal,input);},
    useCombatPower(principal,input){deps.assertFactoryMutation();return executeCombatPower(db,deps,principal,input);},
    getCombatPowerLegalActions(principal,combatId){const actions=buildCombatPowerLegalActions(db,principal,combatId);const combat=(db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(combatId)as any)?.revision;if(combat===undefined)return[];const rev=(family:"m15"|"m16",campaignId:string,actorId:string)=>(db.prepare(`SELECT revision FROM rpg_${family}_mutation_revisions_v${family==="m15"?"25":"26"} WHERE campaign_id=? AND actor_id=?`).get(campaignId,actorId)as any)?.revision??0;return actions.map(action=>({...action,revisions:{combat,sourceM15:rev("m15",action.campaignId,action.sourceActorId),sourceM16:rev("m16",action.campaignId,action.sourceActorId),targetM15:action.targetActorId?rev("m15",action.campaignId,action.targetActorId):null,targetM16:action.targetActorId?rev("m16",action.campaignId,action.targetActorId):null}}));},
    getCombatPowerResultByKey(principal,combatId,idempotencyKey){return getCombatPowerResultByKey(db,principal,combatId,idempotencyKey);}};
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
function initiative(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:any,request:string,e:any,b:number,a:number,at:string,commandId:string){
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
function claim(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:Extract<EncounterCommand,{type:"claim_reward_bundle"}>,request:string,e:any,b:number,a:number,at:string,commandId:string){
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
function advance(db:DatabaseDriver.Database,d:EncounterDependencies,p:string,c:any,request:string,e:any,b:number,a:number,at:string,commandId:string){
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
function receipt(c:any,commandId:string,b:number,a:number,at:string,status:string){return {encounterId:c.encounterId,status,receipt:{commandId,idempotencyKey:c.idempotencyKey,revisionBefore:b,revisionAfter:a,occurredAt:at}};}
function allowed(allow:LegalCombatActionAllowlist,c:any){return allow.actions.some((x:any)=>x.kind===c.type&&(x.kind!=="attack"||(x.attackId===c.attackId&&x.targetCombatantIds.includes(c.targetCombatantId))));}
function beginProtocol(db:DatabaseDriver.Database,d:EncounterDependencies,c:any,request:string,commandId:string,actorId:string|null,b:number,a:number,at:string,eventType:string,event:any,logKind:string,ordinal:number){const eventId=id(d);db.prepare("INSERT INTO combat_commands_v27 VALUES(?,?,?,?,?,?,?,?,?,?)").run(c.encounterId,commandId,actorId,commandType(c.type),c.idempotencyKey,request,digest(JSON.parse(request)),b,a,at);db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(eventId,c.encounterId,commandId,a,eventType,canonical(event),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(id(d),c.encounterId,null,eventId,ordinal,logKind,canonical(event),at);return eventId;}
function sealReceipt(db:DatabaseDriver.Database,encounterId:string,commandId:string,revision:number,at:string,result:any){db.prepare("INSERT INTO combat_receipts_v27 VALUES(?,?,?,?,?,?)").run(encounterId,commandId,revision,canonical(result),digest(result),at);}
function protocol(db:DatabaseDriver.Database,d:EncounterDependencies,c:any,request:string,commandId:string,actorId:string|null,b:number,a:number,at:string,result:any,eventType:string,event:any,logKind:string,ordinal:number){beginProtocol(db,d,c,request,commandId,actorId,b,a,at,eventType,event,logKind,ordinal);sealReceipt(db,c.encounterId,commandId,a,at,result);}
function advanceRevision(db:DatabaseDriver.Database,e:string,a:number,at:string){db.prepare("UPDATE combat_mutation_revisions_v27 SET revision=?,updated_at=? WHERE encounter_id=?").run(a,at,e);}
function currentCombatant(db:DatabaseDriver.Database,e:any){return e.current_turn_combatant_id&&db.prepare("SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'").get(e.encounter_id,e.current_turn_combatant_id) as any;}
function recordStateEvent(db:DatabaseDriver.Database,d:EncounterDependencies,e:string,c:string,hp:number,status:string,at:string,commandId:string,revision:number){const eventId=id(d),event={kind:"combatant_state_changed",combatantId:c,hitPoints:hp,status};db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(eventId,e,commandId,revision,"combatant_state_changed",canonical(event),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(id(d),e,c,eventId,1,status==="fled"?"flee":status==="defeated"?"defeat":"damage",canonical(event),at);}
function next(db:DatabaseDriver.Database,e:string,current:string,round:number){const rows=db.prepare("SELECT combatant_id FROM combatant WHERE encounter_id=? AND status='active' ORDER BY initiative DESC,initiative_tiebreaker,combatant_id").all(e) as any[];const i=rows.findIndex(x=>x.combatant_id===current),n=rows[(i+1+rows.length)%rows.length];return n&&{combatantId:n.combatant_id,round:i===rows.length-1?round+1:round};}
function turn(db:DatabaseDriver.Database,e:string,encounter:any,current:string,at:string){const n=next(db,e,current,encounter.round_number);if(n)db.prepare("UPDATE encounter SET current_turn_combatant_id=?,round_number=?,state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(n.combatantId,n.round,at,e);}
function complete(db:DatabaseDriver.Database,e:string,at:string){db.prepare("UPDATE encounter SET status='completed',current_turn_combatant_id=NULL,state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(at,e);}
function survival(db:DatabaseDriver.Database,encounterId:string,combatantId:string){return db.prepare("SELECT successes,failures,stable FROM combat_survival_v61 WHERE encounter_id=? AND combatant_id=?").get(encounterId,combatantId) as {successes:number;failures:number;stable:number}??{successes:0,failures:0,stable:0};}
function setSurvival(db:DatabaseDriver.Database,encounterId:string,combatantId:string,successes:number,failures:number,stable:boolean){db.prepare(`INSERT INTO combat_survival_v61(encounter_id,combatant_id,successes,failures,stable) VALUES(?,?,?,?,?)
  ON CONFLICT(encounter_id,combatant_id) DO UPDATE SET successes=excluded.successes,failures=excluded.failures,stable=excluded.stable`).run(encounterId,combatantId,successes,failures,stable?1:0);}
/** D&D actors remain targetable at zero; a damaging hit adds one failed save. */
function dndDamageStatus(db:DatabaseDriver.Database,target:any,hitPointsAfter:number,damage:number):string{
  if(!target.actor_id)return hitPointsAfter===0?"defeated":"active";
  if(target.hit_points>0&&hitPointsAfter===0){setSurvival(db,target.encounter_id,target.combatant_id,0,0,false);return "unconscious";}
  if(target.hit_points===0&&damage>0){const prior=survival(db,target.encounter_id,target.combatant_id),failures=Math.min(3,prior.failures+1);setSurvival(db,target.encounter_id,target.combatant_id,prior.successes,failures,prior.stable===1);return failures===3?"dead":target.status;}
  return target.status;
}

/** Bounded contest scores use the actor's raw ability modifier; enemy templates have no ability-score schema. */
export function contestScore(db:DatabaseDriver.Database,campaignId:string,combatant:any,mode:"athletics"|"best"):number{
  if(!combatant.actor_id)return 0;
  const row=db.prepare(`SELECT actor.sheet_id,progression.level,
      strength.value strength,dexterity.value dexterity FROM campaign_actors actor
    JOIN character_progression_v23 progression ON progression.campaign_id=actor.campaign_id AND progression.actor_id=actor.id
    JOIN rpg_character_attributes strength ON strength.campaign_id=actor.campaign_id
      AND strength.sheet_id=actor.sheet_id AND strength.attribute_id='strength'
    LEFT JOIN rpg_character_attributes dexterity ON dexterity.campaign_id=actor.campaign_id
      AND dexterity.sheet_id=actor.sheet_id AND dexterity.attribute_id='dexterity'
    WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId,combatant.actor_id) as
    {sheet_id:string;level:number;strength:number;dexterity:number|null}|undefined;
  if(!row)return 0;
  const proficient=(skill:string)=>Boolean(db.prepare(`SELECT 1 FROM rpg_character_proficiencies
    WHERE campaign_id=? AND sheet_id=? AND category='skill' AND proficiency_id=?`).get(campaignId,row.sheet_id,skill));
  const bonus=dnd5eProficiencyBonus(Number.isInteger(row.level)?row.level:1);
  const athletics=Math.floor((row.strength-10)/2)+(proficient("athletics")?bonus:0);
  if(mode==="athletics")return athletics;
  const acrobatics=Number.isInteger(row.dexterity)?Math.floor(((row.dexterity as number)-10)/2)+(proficient("acrobatics")?bonus:0):null;
  return acrobatics===null?athletics:Math.max(athletics,acrobatics);
}

type TurnAdvancePlan={event:any;nextId:string|null;round:number};
function planTurnAdvance(db:DatabaseDriver.Database,encounterId:string,encounter:any,currentId:string,
  overrides:ReadonlyMap<string,string>):TurnAdvancePlan{
  const rows=db.prepare(`SELECT combatant_id,team,status FROM combatant WHERE encounter_id=?
    ORDER BY initiative DESC,initiative_tiebreaker,combatant_id`).all(encounterId) as Array<{combatant_id:string;team:string;status:string}>;
  const status=(row:{combatant_id:string;status:string})=>overrides.get(row.combatant_id)??row.status;
   const activeTeams=new Set(rows.filter((row)=>["active","unconscious","stable"].includes(status(row))).map((row)=>row.team)).size;
  let event:any,nextId:string|null=null,round=encounter.round_number;
  if(activeTeams<2){
    event={kind:"combat_terminal"};
  }else{
    const order=rows;
    const currentIndex=order.findIndex((value)=>value.combatant_id===currentId);
    if(currentIndex<0)throw new EncounterTurnError("current combatant is outside turn order");
    for(let step=1;step<=order.length;step+=1){
      const index=(currentIndex+step)%order.length,candidate=order[index]!;
       if(["active","unconscious"].includes(status(candidate))){
        nextId=candidate.combatant_id;
        if(index<=currentIndex)round+=1;
        break;
      }
    }
    event=nextId===null?{kind:"combat_terminal"}:{kind:"turn_advanced",combatantId:nextId};
  }
  return {event,nextId,round};
}

function persistTurnAdvance(db:DatabaseDriver.Database,d:EncounterDependencies,encounterId:string,
  plan:TurnAdvancePlan,at:string,commandId:string,revision:number){
  const eventId=id(d);
  db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)")
    .run(eventId,encounterId,commandId,revision,"encounter_state_changed",canonical(plan.event),at);
  db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)")
    .run(id(d),encounterId,null,eventId,2,"encounter_state",canonical(plan.event),at);
  db.prepare(`UPDATE encounter SET current_turn_combatant_id=?,round_number=?,
    state_revision=state_revision+1,updated_at=? WHERE encounter_id=?`).run(plan.nextId,plan.round,at,encounterId);
  endDndCombatTurn(db,encounterId,at);
  const campaign=(db.prepare("SELECT campaign_id FROM encounter WHERE encounter_id=?").get(encounterId) as {campaign_id:string}).campaign_id;
  if(plan.nextId)beginDndCombatTurn(db,campaign,encounterId,plan.nextId,plan.round,id(d),at);
}

function ensureRewardCurrency(db:DatabaseDriver.Database,campaignId:string):{code:string;reference:{kind:"currency";packId:string;packVersion:string;definitionId:string}}{
  const boundRows=db.prepare(`SELECT currency.currency_code,definition.pack_id,definition.pack_version,
      definition.definition_id,definition.definition_json
    FROM rpg_currency_references_v25 currency JOIN campaign_catalog_current_pins pin
      ON pin.campaign_id=currency.campaign_id AND pin.pack_id=currency.pack_id AND pin.pack_version=currency.pack_version
    JOIN rpg_catalog_definitions definition ON definition.pack_id=currency.pack_id
      AND definition.pack_version=currency.pack_version AND definition.kind=currency.kind
      AND definition.definition_id=currency.definition_id
    WHERE currency.campaign_id=? AND currency.kind='currency'
    ORDER BY currency.currency_code COLLATE BINARY LIMIT 2`).all(campaignId) as Array<{
      currency_code:string;pack_id:string;pack_version:string;definition_id:string;definition_json:string}>;
  if(boundRows.length>1)throw new EncounterConflictError("combat reward currency is unavailable or ambiguous");
  const rows=boundRows.length===1?boundRows:db.prepare(`SELECT NULL currency_code,definition.pack_id,definition.pack_version,
      definition.definition_id,definition.definition_json
    FROM campaign_catalog_current_pins pin JOIN rpg_catalog_definitions definition
    ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
    WHERE pin.campaign_id=? AND definition.kind='currency'
    ORDER BY pin.position,definition.definition_id COLLATE BINARY LIMIT 2`).all(campaignId) as Array<{
      currency_code:null;pack_id:string;pack_version:string;definition_id:string;definition_json:string}>;
  if(rows.length!==1)throw new EncounterConflictError("combat reward currency is unavailable or ambiguous");
  const row=rows[0]!,definition=currencyCatalogDefinitionSchema.parse(JSON.parse(row.definition_json));
  if(definition.reference.packId!==row.pack_id||definition.reference.packVersion!==row.pack_version
    ||definition.reference.definitionId!==row.definition_id)throw new EncounterConflictError("combat reward currency is malformed");
  const reference={kind:"currency" as const,packId:row.pack_id,packVersion:row.pack_version,definitionId:row.definition_id};
  const code=currencyCodeSchema.parse(definition.mechanics.symbol.toUpperCase());
  if(!db.prepare(`SELECT 1 FROM rpg_campaign_catalog_definitions_v25 WHERE campaign_id=? AND pack_id=?
      AND pack_version=? AND kind='currency' AND definition_id=?`)
    .get(campaignId,reference.packId,reference.packVersion,reference.definitionId)){
    db.prepare(`INSERT INTO rpg_campaign_catalog_definitions_v25
      (campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,'currency',?)`)
      .run(campaignId,reference.packId,reference.packVersion,reference.definitionId);
  }
  if(row.currency_code)return {code:row.currency_code,reference};
  const existing=db.prepare(`SELECT currency_code FROM rpg_currency_references_v25 WHERE campaign_id=?
    AND pack_id=? AND pack_version=? AND kind='currency' AND definition_id=?`)
    .get(campaignId,reference.packId,reference.packVersion,reference.definitionId) as {currency_code:string}|undefined;
  if(existing)return {code:existing.currency_code,reference};
  if(db.prepare("SELECT 1 FROM rpg_currency_references_v25 WHERE campaign_id=? AND currency_code=?").get(campaignId,code))
    throw new EncounterConflictError("combat reward currency code is unavailable");
  db.prepare(`INSERT INTO rpg_currency_references_v25
    (campaign_id,currency_code,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,'currency',?)`)
    .run(campaignId,code,reference.packId,reference.packVersion,reference.definitionId);
  return {code,reference};
}

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

function campaignInitiative(db:DatabaseDriver.Database,deps:EncounterDependencies,campaignId:string,actorId:string|null):number{
  const roll=deps.rng.integer(1,21);if(!Number.isInteger(roll)||roll<1||roll>20)throw new Error("initiative RNG returned an out-of-range d20");
  let binding:ReturnType<typeof resolveCampaignRuleset>;try{binding=resolveCampaignRuleset(db,campaignId);}catch{return roll;}
  if(binding.rulesetId!=="dnd-5e"||actorId===null||!binding.module.mechanics)return roll;
  const dexterity=db.prepare(`SELECT attribute.value FROM campaign_actors actor JOIN rpg_character_attributes attribute
    ON attribute.campaign_id=actor.campaign_id AND attribute.sheet_id=actor.sheet_id AND attribute.attribute_id='dexterity'
    WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId,actorId) as {value:number}|undefined;
  if(!dexterity)throw new EncounterConflictError("SRD initiative requires Dexterity");
  return binding.module.mechanics.resolveInitiative([{id:actorId,dexterityScore:dexterity.value,roll}])[0]!.total;
}
