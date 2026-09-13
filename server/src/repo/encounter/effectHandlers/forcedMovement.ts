import type { StarterForcedMovementEffect } from "@velvet/contracts";
import type { EffectContext } from "./types.js";

/**
 * Resolves forced movement as pure data. It computes the deterministic
 * displacement for the caller to apply against map geometry it already owns;
 * this engine never mutates a map or a combatant position.
 */
export function handleForcedMovementEffect(ctx:EffectContext,effect:StarterForcedMovementEffect):void{
  const direction=effect.mode==="push"?"away-from-source":effect.mode==="pull"?"toward-source":"destination";
  ctx.outcomes.push({kind:"forced-movement",mode:effect.mode,direction,distanceFeet:effect.distanceFeet,displacementFeet:effect.distanceFeet,targetCombatantId:ctx.target.combatant_id,mutatesMap:false});
}
