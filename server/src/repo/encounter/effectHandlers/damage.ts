import { evaluateDiceExpression } from "../../../dice.js";
import { absorbDamage } from "../combatConditionRuntime.js";
import { EncounterConflictError } from "../encounterErrors.js";
import { adjustedCombatDamage, resolveCombatDamageAdjustment } from "../damageAdjustment.js";
import type { EffectContext } from "./types.js";
import { spellCasterStats, targetArmorClass, targetSaveBonus } from "./spellAttack.js";

export function handleDamageEffect(ctx:EffectContext,effect:any):void{
  const {db,deps,action,target,dnd,at,outcomes}=ctx;let hp=ctx.hp;
  const mechanics:any=action.definition.mechanics,attackType=mechanics.attackType??"none",saveType=mechanics.saveType??"none";
  let gate:any=null,blocked=false;
  if(dnd&&action.definition.reference.kind==="spell"&&(attackType!=="none"||saveType!=="none")){
    const caster=spellCasterStats(db,action.campaignId,action.sourceActorId);
    if(!caster)throw new EncounterConflictError("spellcasting ability is unavailable");
    const natural=deps.rng.integer(1,21);if(!Number.isInteger(natural)||natural<1||natural>20)throw new Error("combat RNG returned an out-of-range d20");
    if(attackType!=="none"){
      const armorClass=targetArmorClass(db,action.campaignId,target,at);if(armorClass===null)throw new EncounterConflictError("spell target armor class is unavailable");
      const automaticMiss=natural===1,critical=natural===20,total=natural+caster.attackBonus,hit=!automaticMiss&&(critical||total>=armorClass);
      gate={attackRoll:natural,attackTotal:total,armorClass,hit,critical};blocked=!hit;
    }else{
      const total=natural+targetSaveBonus(db,action.campaignId,target,saveType),saveSuccess=total>=caster.saveDc;
      gate={saveRoll:natural,saveTotal:total,saveDc:caster.saveDc,saveSuccess};blocked=saveSuccess;
    }
  }
  if(blocked){outcomes.push({kind:"damage",damageType:effect.damageType,requested:0,adjustment:"none",applied:0,before:hp,after:hp,...gate});}
  else{const critical=gate?.critical===true,count=effect.dice.count*(critical?2:1);
    const roll=evaluateDiceExpression(`${count}d${effect.dice.sides}${effect.dice.modifier===0?"":effect.dice.modifier>0?`+${effect.dice.modifier}`:effect.dice.modifier}`,deps.rng),requested=Math.max(0,roll.total),adjust=resolveCombatDamageAdjustment(db,action.campaignId,target,effect.damageType,at),adjusted=adjustedCombatDamage(requested,adjust),before=hp,absorbed=absorbDamage(db,action.encounterId,target.combatant_id,adjusted,at);hp=Math.max(0,hp-absorbed.hitPointDamage);outcomes.push({kind:"damage",damageType:effect.damageType,roll,requested,adjustment:adjust,applied:before-hp,temporaryHitPointsAbsorbed:adjusted-absorbed.hitPointDamage,temporaryHitPointsAfter:absorbed.temporaryHitPointsAfter,before,after:hp,...(gate??{})});}
  ctx.hp=hp;
}
