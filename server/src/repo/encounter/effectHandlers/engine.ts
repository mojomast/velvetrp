import { starterEffectV2Schema, type StarterEffectV2 } from "@velvet/contracts";
import { EncounterConflictError } from "../encounterErrors.js";
import { applyEffectRecord } from "./effect.js";
import { handleDamageEffect } from "./damage.js";
import { handleHealingEffect } from "./healing.js";
import { handleTemporaryHitPointsEffect } from "./temporaryHitPoints.js";
import { handleAreaTargetingEffect } from "./areaTargeting.js";
import { handleSaveWithRiderEffect } from "./saveWithRider.js";
import { handleForcedMovementEffect } from "./forcedMovement.js";
import { handleUtilityEffect } from "./utility.js";
import { handleOngoingEffect, persistOngoingTick, readOngoingEffect } from "./ongoingEffect.js";
import { targetSaveBonus } from "./spellAttack.js";
import { nextId } from "./util.js";
import type { EffectApplier, EffectContext, Row } from "./types.js";

/** The additive v2 kinds this engine owns; every other kind stays on the v1 path. */
export const V2_EFFECT_KINDS:ReadonlySet<string>=new Set(["area-targeting","save-with-rider","ongoing-effect","forced-movement","utility"]);
export const isV2EffectKind=(type:string):boolean=>V2_EFFECT_KINDS.has(type);

/** Recursive composition core. It reuses the v1 handlers unchanged and never
 * walks back through schema validation for already-validated nested effects. */
const apply:EffectApplier=(ctx,effect,powerUseId,targets)=>{
  switch(effect.type){
    case "damage":handleDamageEffect(ctx,effect);return;
    case "healing":handleHealingEffect(ctx,effect);return;
    case "temporary-hit-points":handleTemporaryHitPointsEffect(ctx,effect);return;
    case "modifier":
    case "condition":applyEffectRecord(ctx,effect,powerUseId);return;
    case "area-targeting":handleAreaTargetingEffect(ctx,effect,powerUseId,targets,apply);return;
    case "save-with-rider":handleSaveWithRiderEffect(ctx,effect,powerUseId,apply);return;
    case "ongoing-effect":handleOngoingEffect(ctx,effect,powerUseId,apply);return;
    case "forced-movement":handleForcedMovementEffect(ctx,effect);return;
    case "utility":handleUtilityEffect(ctx,effect);return;
  }
};

/** Validates and executes one v2 effect (top-level or nested). Malformed
 * definitions are rejected before any mutation, with a stable error message. */
export function resolveEffect(ctx:EffectContext,effect:unknown,powerUseId:string,targets:Row[]=[ctx.target]):void{
  const parsed=starterEffectV2Schema.safeParse(effect);
  if(!parsed.success)throw new EncounterConflictError("effect definition is malformed");
  apply(ctx,parsed.data,powerUseId,targets);
}

export interface OngoingTickResult {
  kind:"ongoing-effect-tick";
  ongoingId:string;
  timing:string;
  phase:string;
  applied:boolean;
  reason?:string;
  remainingBefore:number;
  remainingAfter:number;
  ended:boolean;
  repeatSaveRoll:number|null;
  repeatSaveSuccess:boolean|null;
  outcomes:any[];
}

/** Deterministic tick: applies the persisted inner effect only when its timing
 * phase is due, rolls the repeat save with injected dice, then advances or ends
 * the entry. It never consults wall-clock time or ambient randomness. */
export function tickOngoingEffect(ctx:EffectContext,ongoingId:string,phase:"start-of-turn"|"end-of-turn"):OngoingTickResult{
  const actorId=ctx.target.actor_id;
  if(!actorId)throw new EncounterConflictError("ongoing effects require an actor-backed target");
  const record=readOngoingEffect(ctx.db,ctx.action.campaignId,actorId,ongoingId);
  if(!record||record.status!=="active")throw new EncounterConflictError("ongoing effect is unavailable");
  const marker:OngoingTickResult={kind:"ongoing-effect-tick",ongoingId,timing:record.timing,phase,applied:false,remainingBefore:record.remainingRounds,remainingAfter:record.remainingRounds,ended:false,repeatSaveRoll:null,repeatSaveSuccess:null,outcomes:[]};
  if(record.timing!==phase){marker.reason="not-due";return marker;}
  const powerUseId=nextId(ctx.deps);
  const start=ctx.outcomes.length;
  apply(ctx,record.effect,powerUseId,[ctx.target]);
  marker.outcomes=ctx.outcomes.slice(start);
  let repeatSaveSuccess:boolean|null=null;
  if(record.repeatSave){
    const saveRoll=ctx.deps.rng.integer(1,21);
    if(!Number.isInteger(saveRoll)||saveRoll<1||saveRoll>20)throw new Error("combat RNG returned an out-of-range d20");
    const saveBonus=ctx.target.actor_id?targetSaveBonus(ctx.db,ctx.action.campaignId,ctx.target,record.repeatSave.ability):0;
    repeatSaveSuccess=saveRoll+saveBonus>=record.repeatSave.dc;
    marker.repeatSaveRoll=saveRoll;marker.repeatSaveSuccess=repeatSaveSuccess;
  }
  const remainingAfter=Math.max(0,record.remainingRounds-1),ended=repeatSaveSuccess===true||remainingAfter===0;
  persistOngoingTick(ctx,ongoingId,ended?0:remainingAfter,ended);
  marker.applied=true;marker.remainingAfter=ended?0:remainingAfter;marker.ended=ended;
  return marker;
}
