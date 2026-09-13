import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema, combatEnemyTurnCommandRequestSchema, combatActionResolutionSchema, type CombatEnemyTurnCommandRequest, type CombatActionResolution } from "@velvet/contracts";
import { EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, EncounterTurnError, EncounterUnavailableError } from "../encounterErrors.js";
import type { EncounterCombatSnapshot } from "../encounterReadRepo.js";
import { consumeDndTurnCost, isDndCombat } from "../combatActionPlan.js";
import { buildCombatCompositionPlan, type CombatantStateChange } from "../combatCompositionPlan.js";
import { executeCombatCompositionPlan } from "../combatCompositionExecutor.js";
import { resolveCampaignRuleset } from "../../../rulesets/campaignBinding.js";
import { planDnd5eAttackConditions, type ConditionId } from "../../../rulesets/index.js";
import { resolveSrdEquipment } from "../../srdEquipmentRuntime.js";
import { absorbDamage, applyCombatCondition, conditionsFor, interruptConcentrationAfterDamage, resolveCombatArmorClassBonus } from "../combatConditionRuntime.js";
import { adjustedCombatDamage, resolveCombatDamageAdjustment } from "../damageAdjustment.js";
import { consumeCombatMarker, hasCombatMarker } from "../combatMarkerRuntime.js";
import { isMonsterKnockdown, planMonsterTurn } from "../monsterTurnPlanner.js";
import { advanceRevision, beginProtocol, canonical, gm, id, now, recordStateEvent, sealReceipt, type EncounterResult, type EncounterWriteDependencies } from "./shared.js";
import { dndDamageStatus } from "./survival.js";
import { persistTurnAdvance, planTurnAdvance } from "./turn.js";

export function createExecuteCombatEnemyTurn(db:DatabaseDriver.Database,deps:EncounterWriteDependencies){
  return (p:string,combatIdInput:string,input:CombatEnemyTurnCommandRequest):EncounterResult<{campaignId:string;encounterId:string;resolution:CombatActionResolution;combat:EncounterCombatSnapshot}>=>{
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
        let armorClass:number;try{armorClass=resolveSrdEquipment(db,encounter.campaign_id,target.actor_id).armorClass+resolveCombatArmorClassBonus(db,encounter.campaign_id,target.actor_id,at);}catch{armorClass=NaN;}
        if(Number.isInteger(armorClass)){
             const attackerBenefit=hasCombatMarker(db,combatId,current.combatant_id,"helped")||hasCombatMarker(db,combatId,current.combatant_id,"hidden");
             const attackPlan=planDnd5eAttackConditions({
               attacker:[...conditionsFor(db,combatId,current.combatant_id,encounter.round_number)] as ConditionId[],
               target:[...conditionsFor(db,combatId,target.combatant_id,encounter.round_number)] as ConditionId[],
               kind:"melee",attackerBenefit});
             const diceCount=attackPlan.mode==="normal"?plan.attackRollCount:Math.max(2,plan.attackRollCount);
             const rolls=Array.from({length:diceCount},()=>deps.rng.integer(1,21));
             if(rolls.some((value)=>!Number.isInteger(value)||value<1||value>20))throw new Error("combat RNG returned an out-of-range d20");
             const attackRoll=attackPlan.mode==="disadvantage"?Math.min(...rolls):Math.max(...rolls);
            const profile=plan.enemy.mechanics.combatProfile!;
            const binding=resolveCampaignRuleset(db,encounter.campaign_id),attack=binding.module.mechanics!.resolveAttack({rolls:[attackRoll],abilityScore:10,
               proficiencyBonus:profile.proficiencyBonus,flatBonus:profile.attack.attackBonus-profile.proficiencyBonus,armorClass});
           const critical=attack.critical || (attackPlan.autoCritical && attack.hit);
           if(attackerBenefit){consumeCombatMarker(db,combatId,current.combatant_id,"helped");consumeCombatMarker(db,combatId,current.combatant_id,"hidden");}
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
}
