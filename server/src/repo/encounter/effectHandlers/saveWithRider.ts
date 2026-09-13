import type { StarterSaveWithRiderEffect } from "@velvet/contracts";
import { targetSaveBonus } from "./spellAttack.js";
import type { EffectApplier, EffectContext } from "./types.js";

/**
 * Rolls one d20 save with injected dice, adds the target's ability save bonus
 * when it is actor-backed, and applies exactly one rider branch (`onFail` or
 * `onSuccess` when present). Enemy combatants have no modeled saves, so their
 * bonus is zero, matching the existing v1 save contract.
 */
export function handleSaveWithRiderEffect(ctx:EffectContext,effect:StarterSaveWithRiderEffect,powerUseId:string,apply:EffectApplier):void{
  const target=ctx.target;
  const saveRoll=ctx.deps.rng.integer(1,21);
  if(!Number.isInteger(saveRoll)||saveRoll<1||saveRoll>20)throw new Error("combat RNG returned an out-of-range d20");
  const saveBonus=target.actor_id?targetSaveBonus(ctx.db,ctx.action.campaignId,target,effect.ability):0;
  const saveTotal=saveRoll+saveBonus,saveSuccess=saveTotal>=effect.dc,branch=saveSuccess?effect.onSuccess:effect.onFail;
  const marker:any={kind:"save-with-rider",ability:effect.ability,dc:effect.dc,saveDc:effect.dc,saveRoll,saveBonus,saveTotal,saveSuccess,applied:saveSuccess?"onSuccess":"onFail",outcomes:[]};
  ctx.outcomes.push(marker);
  const start=ctx.outcomes.length;
  if(branch)for(const nested of branch)apply(ctx,nested,powerUseId,[target]);
  marker.outcomes=ctx.outcomes.slice(start);
}
