import type DatabaseDriver from "better-sqlite3";
import { encounterCommandSchema, type EncounterCommand } from "@velvet/contracts";
import { EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, EncounterTurnError, EncounterUnavailableError } from "../encounterErrors.js";
import { isDndCombat } from "../combatActionPlan.js";
import { buildCombatCompositionPlan, type CombatantStateChange } from "../combatCompositionPlan.js";
import { executeCombatCompositionPlan } from "../combatCompositionExecutor.js";
import type { createResolveCombatAction } from "./attack.js";
import { advanceRevision, allowed, canonical, commandType, controls, currentCombatant, dndCommandTypes, gm, id, member, now, protocol, receipt, recordStateEvent, replayAuthority, type EncounterResult, type EncounterWriteDependencies } from "./shared.js";
import { persistTurnAdvance, planTurnAdvance } from "./turn.js";
import { advance, claim, create, initiative, join } from "./legacyCommands.js";

export function createExecute(db:DatabaseDriver.Database,deps:EncounterWriteDependencies,resolveCombatAction:ReturnType<typeof createResolveCombatAction>){
  const legal=deps.reads.getLegalCombatActionAllowlist;
  return (p:string,input:EncounterCommand):EncounterResult<{encounterId:string;status:string}>=>{
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
}
