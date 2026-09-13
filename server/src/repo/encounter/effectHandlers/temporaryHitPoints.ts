import { evaluateDiceExpression } from "../../../dice.js";
import type { EffectContext } from "./types.js";

export function handleTemporaryHitPointsEffect(ctx:EffectContext,effect:any):void{
  const {db,deps,action,target,outcomes,tempHitPointGrants}=ctx;
  const roll=evaluateDiceExpression(`${effect.dice.count}d${effect.dice.sides}${effect.dice.modifier===0?"":`+${effect.dice.modifier}`}`,deps.rng),requested=Math.max(0,roll.total),before=(db.prepare("SELECT hit_points FROM combat_temporary_hit_points_v62 WHERE encounter_id=? AND combatant_id=?").get(action.encounterId,target.combatant_id)as any)?.hit_points??0,outcome:any={kind:"temporary-hit-points",roll,requested,before,after:before,granted:0};tempHitPointGrants.push({outcome,amount:requested});outcomes.push(outcome);
}
