import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema, combatActionCommandRequestSchema, combatActionResolutionSchema, combatActionCommandResponseSchema, type CombatActionCommandRequest, type CombatActionResolution } from "@velvet/contracts";
import { EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, EncounterTurnError, EncounterUnavailableError } from "../encounterErrors.js";
import type { EncounterCombatSnapshot } from "../encounterReadRepo.js";
import { buildCombatActionPlans, buildRangedCombatCandidate, buildThrownCombatCandidate, consumeDndTurnCost, coverArmorClassBonus, hostileWithinFiveFeet, isDndCombat, readCombatTurnEconomy } from "../combatActionPlan.js";
import { buildCombatCompositionPlan, type CombatantStateChange } from "../combatCompositionPlan.js";
import { executeCombatCompositionPlan } from "../combatCompositionExecutor.js";
import { resolveCampaignRuleset } from "../../../rulesets/campaignBinding.js";
import { DND_5E_UNARMED_STRIKE, planDnd5eAttackConditions, type ConditionId } from "../../../rulesets/index.js";
import { resolveSrdEquipment } from "../../srdEquipmentRuntime.js";
import { absorbDamage, applyCombatCondition, conditionsFor, interruptConcentrationAfterDamage, readActorExhaustion, removeCombatCondition, resolveCombatArmorClassBonus } from "../combatConditionRuntime.js";
import { adjustedCombatDamage, resolveCombatDamageAdjustment } from "../damageAdjustment.js";
import { actorStealthModifier, consumeCombatMarker, grantCombatMarker, hasCombatMarker, opposingPassivePerception } from "../combatMarkerRuntime.js";
import { advanceRevision, beginProtocol, canonical, controls, gm, id, member, now, recordStateEvent, sealReceipt, type EncounterResult, type EncounterWriteDependencies } from "./shared.js";
import { contestScore, dndDamageStatus, setSurvival, survival } from "./survival.js";
import { persistTurnAdvance, planTurnAdvance } from "./turn.js";

export function createResolveCombatAction(db:DatabaseDriver.Database,deps:EncounterWriteDependencies){
  return (p:string,combatIdInput:string,input:CombatActionCommandRequest,legacyRequest?:string):EncounterResult<{campaignId:string;encounterId:string;resolution:CombatActionResolution;combat:EncounterCombatSnapshot}>=>{
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
       if(((plan.kind==="attack"||plan.kind==="stabilize"||plan.kind==="grapple"||plan.kind==="escape-grapple"||plan.kind==="shove"||plan.kind==="stand-up"||plan.kind==="help")
              &&(command.targetIds.length!==1||!plan.targetIds.includes(command.targetIds[0]!)))
            ||(plan.kind!=="attack"&&plan.kind!=="stabilize"&&plan.kind!=="grapple"&&plan.kind!=="escape-grapple"&&plan.kind!=="shove"&&plan.kind!=="stand-up"&&plan.kind!=="help"&&command.targetIds.length!==0))
         throw new EncounterConflictError("combat action targets are not legal");

       const at=now(deps);
      let outcome:any=null,helpTarget:string|null=null,hideSucceeded=false;
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
          if(target.actor_id){try{armorClass=resolveSrdEquipment(db,encounter.campaign_id,target.actor_id).armorClass+resolveCombatArmorClassBonus(db,encounter.campaign_id,target.actor_id,at);}
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
             const attackerBenefit=hasCombatMarker(db,combatId,current.combatant_id,"helped")||hasCombatMarker(db,combatId,current.combatant_id,"hidden");
             const attackerInMelee=(ranged||thrown)&&hostileWithinFiveFeet(db,combatId,current.combatant_id,current.team);
             const targetConditions=conditionsFor(db,combatId,target.combatant_id,encounter.round_number);
             const attackPlan=planDnd5eAttackConditions({
               attacker:[...conditionsFor(db,combatId,current.combatant_id,encounter.round_number)] as ConditionId[],
               target:[...targetConditions] as ConditionId[],
               kind: ranged ? "ranged" : thrown ? "thrown" : "melee",
               longRange: rangeFeet !== undefined && rangeFeet > (candidate?.normalRangeFeet ?? 0),
               attackerExhaustion: current.actor_id ? readActorExhaustion(db,encounter.campaign_id,current.actor_id) : 0,
               attackerBenefit,attackerInMelee});
             const firstRoll=deps.rng.integer(1,21);if(!Number.isInteger(firstRoll)||firstRoll<1||firstRoll>20)throw new Error("combat RNG returned an out-of-range d20");
             const attackRoll=attackPlan.mode==="normal"?firstRoll:attackPlan.mode==="advantage"?Math.max(firstRoll,deps.rng.integer(1,21)):Math.min(firstRoll,deps.rng.integer(1,21));
           const attack=binding.module.mechanics.resolveAttack({rolls:[attackRoll],abilityScore:ability.value,
             proficiencyBonus:(unarmed?DND_5E_UNARMED_STRIKE.proficient:weapon.proficient)?binding.module.proficiencyBonus(sheet.level):0,armorClass:adjustedArmorClass});
          const critical=attack.critical || (attackPlan.autoCritical && attack.hit);
          if(attackerBenefit){consumeCombatMarker(db,combatId,current.combatant_id,"helped");consumeCombatMarker(db,combatId,current.combatant_id,"hidden");}
          const die=unarmed?DND_5E_UNARMED_STRIKE.damageDie:weapon.damage.die;
          const damageRolls=attack.hit?Array.from({length:die.count*(critical?2:1)},()=>deps.rng.integer(1,die.sides+1)):[];
          if(damageRolls.some(value=>!Number.isInteger(value)||value<1||value>die.sides))throw new Error("combat RNG returned an out-of-range damage die");
          const damage=attack.hit?binding.module.mechanics.resolveDamageRoll({dice:[die],rolls:[damageRolls],
            modifier:binding.module.abilityModifier(ability.value)+(unarmed?DND_5E_UNARMED_STRIKE.flatDamageBonus:0),critical}).total:0;
          const damageType=unarmed?DND_5E_UNARMED_STRIKE.damageType:weapon.damage.type;
          const adjustment=resolveCombatDamageAdjustment(db,encounter.campaign_id,target,damageType,at);
          // SRD 5.1 petrified: resistance to all damage.
          const conditionedAdjustment=targetConditions.has("petrified")&&adjustment==="none"?"resistance":adjustment;
          const adjustedDamage=adjustedCombatDamage(damage,conditionedAdjustment);
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
          outcome={kind:"damage",targetId:command.targetIds[0]!,damageType,requested:damage,adjustment:conditionedAdjustment,
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
       }else if(plan.kind==="grapple"||plan.kind==="escape-grapple"||plan.kind==="shove"){
         const targetId=command.targetIds[0]!;
         const target=plan.kind==="escape-grapple" ? db.prepare(`SELECT source_combatant_id combatant_id FROM combat_conditions_v62
             WHERE encounter_id=? AND combatant_id=? AND condition='grappled' LIMIT 1`).get(combatId,current.combatant_id) as any
           : db.prepare(`SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'`).get(combatId,targetId) as any;
         if(!target)throw new EncounterConflictError("grapple target is unavailable");
         if(plan.kind==="escape-grapple" && !conditionsFor(db,combatId,current.combatant_id,encounter.round_number).has("grappled"))
           throw new EncounterConflictError("combatant is not grappled");
         const contesting=plan.kind==="grapple"||plan.kind==="shove";
         const attackerScore=contestScore(db,encounter.campaign_id,current,contesting?"athletics":"best");
         const defenderScore=contestScore(db,encounter.campaign_id,target,contesting?"best":"athletics");
         const attackerRoll=deps.rng.integer(1,21),defenderRoll=deps.rng.integer(1,21);
         if(!Number.isInteger(attackerRoll)||attackerRoll<1||attackerRoll>20||!Number.isInteger(defenderRoll)||defenderRoll<1||defenderRoll>20)
           throw new Error("combat RNG returned an out-of-range contest d20");
         const success=attackerRoll+attackerScore>=defenderRoll+defenderScore;
         if(plan.kind==="grapple"&&success) outcome={kind:"contest",targetId,contest:"grapple",attackerRoll,defenderRoll,success,condition:"grappled"};
         else if(plan.kind==="shove"&&success) outcome={kind:"contest",targetId,contest:"shove",attackerRoll,defenderRoll,success,condition:"prone"};
         else if(plan.kind==="shove") outcome={kind:"contest",targetId,contest:"shove",attackerRoll,defenderRoll,success};
          else outcome={kind:"contest",targetId:current.combatant_id,contest:"escape-grapple",attackerRoll,defenderRoll,success};
        }else if(plan.kind==="stand-up"){
         if(!conditionsFor(db,combatId,current.combatant_id,encounter.round_number).has("prone"))
           throw new EncounterConflictError("combatant is not prone");
         const economy=readCombatTurnEconomy(db,combatId);
         if(!economy||economy.combatantId!==current.combatant_id)throw new EncounterConflictError("stand up requires the current turn economy");
         const cost=Math.floor(economy.movement.allowanceFeet/2);
         if(cost<1||economy.movement.remainingFeet<cost)throw new EncounterConflictError("not enough movement remains to stand up");
         const spent=db.prepare(`UPDATE combat_turn_economy_v60 SET movement_used_feet=movement_used_feet+?
           WHERE encounter_id=? AND combatant_id=? AND ended_at IS NULL AND movement_used_feet=? AND movement_allowance_feet=?`)
           .run(cost,combatId,current.combatant_id,economy.movement.usedFeet,economy.movement.allowanceFeet);
         if(spent.changes!==1)throw new EncounterConflictError("stand up movement changed before commit");
         removeCombatCondition(db,combatId,current.combatant_id,"prone");
         outcome={kind:"stand-up",targetId:current.combatant_id,movementCostFeet:cost};
        }else if(plan.kind==="dash"){
         const economy=readCombatTurnEconomy(db,combatId);
         if(!economy||economy.combatantId!==current.combatant_id)throw new EncounterConflictError("dash requires the current turn economy");
         const bonus=economy.movement.allowanceFeet;
         const extended=db.prepare(`UPDATE combat_turn_economy_v60 SET movement_allowance_feet=movement_allowance_feet+?
           WHERE encounter_id=? AND combatant_id=? AND ended_at IS NULL AND movement_allowance_feet=?`)
           .run(bonus,combatId,current.combatant_id,economy.movement.allowanceFeet);
         if(extended.changes!==1)throw new EncounterConflictError("dash allowance changed before commit");
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
      }else if(plan.kind==="help"){
        helpTarget=command.targetIds[0]??null;
      }else if(plan.kind==="hide"){
        const stealth=deps.rng.integer(1,21);if(!Number.isInteger(stealth)||stealth<1||stealth>20)throw new Error("combat RNG returned an out-of-range d20");
        const modifier=current.actor_id?actorStealthModifier(db,encounter.campaign_id,current.actor_id):null;
        hideSucceeded=modifier!==null&&stealth+modifier>=opposingPassivePerception(db,encounter.campaign_id,combatId,current.team);
      }
      const before=root.revision,after=before+1;
      const stateOverrides=new Map<string,string>();
      if(outcome?.kind==="damage"||outcome?.kind==="survival")stateOverrides.set(outcome.targetId,outcome.statusAfter);
      else if(outcome?.kind==="status")stateOverrides.set(current.combatant_id,"fled");
      const plannedAdvance=planTurnAdvance(db,combatId,encounter,current.combatant_id,stateOverrides);
       const keepsTurn=["attack","dash","disengage","help","hide","grapple","escape-grapple","shove","stand-up"].includes(plan.kind) && dnd;
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
       if(helpTarget)grantCombatMarker(db,combatId,helpTarget,"helped",current.combatant_id,commandId,encounter.round_number,at);
       if(plan.kind==="hide"&&hideSucceeded)grantCombatMarker(db,combatId,current.combatant_id,"hidden",current.combatant_id,commandId,encounter.round_number,at);
       if(plan.kind==="grapple"&&outcome?.success)
         applyCombatCondition(db,combatId,outcome.targetId,"grappled",current.combatant_id,commandId,null,at);
       if(plan.kind==="shove"&&outcome?.success)
         applyCombatCondition(db,combatId,outcome.targetId,"prone",current.combatant_id,commandId,null,at);
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
}
