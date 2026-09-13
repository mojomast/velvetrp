import type { StarterAreaTargetingEffect } from "@velvet/contracts";
import type { EffectApplier, EffectContext, Row } from "./types.js";

/** The executable surface is bounded even though target collections are supplied. */
const MAX_AREA_TARGETS = 32;

/**
 * Resolves nested effects against exactly the bounded target set the caller
 * passes in. The engine never derives map geometry: it consumes the provided
 * combatant rows, deduplicated in stable order, and rebinds its working target
 * for each one so nested damage/healing/save handlers remain per-target.
 */
export function handleAreaTargetingEffect(ctx:EffectContext,effect:StarterAreaTargetingEffect,powerUseId:string,targets:Row[],apply:EffectApplier):void{
  const bounded:Row[]=[];const seen=new Set<string>();
  for(const target of (targets.length>0?targets:[ctx.target])){
    if(seen.has(target.combatant_id))continue;
    seen.add(target.combatant_id);bounded.push(target);
    if(bounded.length>=MAX_AREA_TARGETS)break;
  }
  const marker:any={kind:"area-targeting",shape:effect.shape,sizeFeet:effect.sizeFeet,origin:effect.origin,targetCombatantIds:bounded.map(target=>target.combatant_id),outcomes:[]};
  ctx.outcomes.push(marker);
  const previous=ctx.target;
  for(const target of bounded){
    ctx.target=target;
    const start=ctx.outcomes.length;
    for(const nested of effect.effects)apply(ctx,nested,powerUseId,[target]);
    marker.outcomes.push({targetCombatantId:target.combatant_id,outcomes:ctx.outcomes.slice(start)});
  }
  ctx.target=previous;
}
