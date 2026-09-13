import type {
  ConcentrationPlan, ConditionId, ConditionStatePlan, D20TestInput, ExhaustionEffects, LegalActionPlan, RulesetCapability,
} from "../types.js";
import { resolveDnd5eAbilityTest } from "./d20.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";

export const DND_5E_CONDITION_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "concentration", version: "1.0.0", status: "partial" as const }),
  Object.freeze({ id: "conditions", version: "1.1.0", status: "partial" as const }),
  Object.freeze({ id: "exhaustion", version: "1.0.0", status: "partial" as const }),
  Object.freeze({ id: "combat-markers", version: "1.0.0", status: "partial" as const }),
]);

/**
 * SRD 5.1 exhaustion: level 1 disadvantage on ability checks; level 2 speed
 * halved; level 3 disadvantage on attack rolls and saving throws; level 4 hit
 * point maximum halved; level 5 speed 0; level 6 death.
 */
export function deriveDnd5eExhaustionEffects(level: number): ExhaustionEffects {
  requireInteger(level, "exhaustion level");
  if (level < 0 || level > 6) throw new RangeError("exhaustion level must be between 0 and 6");
  return Object.freeze({
    level,
    checkDisadvantage: level >= 1,
    speedMultiplier: level >= 5 ? 0 : level >= 2 ? 0.5 : 1,
    attackDisadvantage: level >= 3,
    saveDisadvantage: level >= 3,
    hitPointMaximumMultiplier: level >= 4 ? 0.5 : 1,
  });
}

export function planDnd5eConcentrationDamage(damage: number, concentrating: boolean, checkInput?: Omit<D20TestInput, "dc" | "abilityScore"> & Readonly<{ constitutionScore: number }>): ConcentrationPlan {
  requireNonNegativeInteger(damage, "damage");
  if (!concentrating || damage === 0) return Object.freeze({ required: false, dc: null, broken: false });
  const dc = Math.max(10, Math.floor(damage / 2));
  if (checkInput === undefined) return Object.freeze({ required: true, dc, broken: false });
  const check = resolveDnd5eAbilityTest("concentration-check", "constitution", { ...checkInput, abilityScore: checkInput.constitutionScore, dc });
  return Object.freeze({ required: true, dc, broken: !check.success, check });
}

export function planDnd5eConcentrationReplacement(currentEffectId: string | null, nextEffectId: string): LegalActionPlan<"replace-concentration", { endEffectId: string | null; startEffectId: string }> {
  const reasons = !nextEffectId ? ["next concentration effect ID is required"] : [];
  return Object.freeze({ kind: "replace-concentration", legal: reasons.length === 0, reasons: frozenList(reasons), result: reasons.length ? null : Object.freeze({ endEffectId: currentEffectId, startEffectId: nextEffectId }) });
}

export function planDnd5eCondition(before: readonly ConditionId[], operation: "add" | "remove", condition: ConditionId): ConditionStatePlan {
  const unique = [...new Set(before)];
  const present = unique.includes(condition);
  const after = operation === "add" ? (present ? unique : [...unique, condition]) : unique.filter((item) => item !== condition);
  return Object.freeze({ operation, condition, before: frozenList(unique), after: frozenList(after), changed: operation === "add" ? !present : present });
}
