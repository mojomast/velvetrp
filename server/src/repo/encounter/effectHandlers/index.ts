import { handleDamageEffect } from "./damage.js";
import { handleHealingEffect } from "./healing.js";
import { handleTemporaryHitPointsEffect } from "./temporaryHitPoints.js";
import type { EffectContext } from "./types.js";

export { applyEffectKind, applyEffectRecord } from "./effect.js";
export { resolveEffect, tickOngoingEffect, isV2EffectKind, V2_EFFECT_KINDS } from "./engine.js";
export type { OngoingTickResult } from "./engine.js";

export type EffectHandler=(ctx:EffectContext,effect:any)=>void;
const handlers:Record<string,EffectHandler>={damage:handleDamageEffect,healing:handleHealingEffect,"temporary-hit-points":handleTemporaryHitPointsEffect};
export const getEffectHandler=(type:string):EffectHandler|undefined=>handlers[type];
