import type { StarterUtilityEffect } from "@velvet/contracts";
import type { EffectContext } from "./types.js";

/** A bounded, deterministic no-op outcome. It never mutates game state. */
export function handleUtilityEffect(ctx:EffectContext,effect:StarterUtilityEffect):void{
  ctx.outcomes.push({kind:"utility",effectId:effect.effectId,label:effect.label,targetCombatantId:ctx.target.combatant_id,applied:false});
}
