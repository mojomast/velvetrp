import { evaluateDiceExpression } from "../../../dice.js";
import type { EffectContext } from "./types.js";

export function handleHealingEffect(ctx:EffectContext,effect:any):void{
  const {db,deps,action,target,outcomes}=ctx;let hp=ctx.hp;const layOnHands=ctx.layOnHands;
  const roll=layOnHands?evaluateDiceExpression("1d2",{integer:()=>1}):evaluateDiceExpression(`${effect.dice.count}d${effect.dice.sides}${effect.dice.modifier===0?"":effect.dice.modifier>0?`+${effect.dice.modifier}`:effect.dice.modifier}`,deps.rng),pool=layOnHands?(db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='lay-on-hands'").get(action.campaignId,action.sourceActorId)as any)?.current??0:Math.max(0,roll.total),requested=layOnHands?Math.min(pool,target.maximum_hit_points-hp):Math.max(0,roll.total),before=hp;hp=Math.min(target.maximum_hit_points,hp+requested);outcomes.push({kind:"healing",roll,requested,applied:hp-before,before,after:hp});
  ctx.hp=hp;
}
