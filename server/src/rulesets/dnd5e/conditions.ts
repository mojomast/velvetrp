import type {
  ConcentrationPlan, ConditionId, ConditionStatePlan, D20TestInput, ExhaustionEffects, LegalActionPlan, RulesetCapability,
} from "../types.js";
import { resolveDnd5eAbilityTest } from "./d20.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";

export const DND_5E_CONDITION_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "concentration", version: "1.0.0", status: "partial" as const }),
  Object.freeze({ id: "conditions", version: "1.2.0", status: "partial" as const }),
  Object.freeze({ id: "exhaustion", version: "1.0.0", status: "partial" as const }),
  Object.freeze({ id: "combat-markers", version: "1.0.0", status: "partial" as const }),
]);

/**
 * SRD 5.1 conditions that deny a creature its actions and reactions. A
 * paralyzed, petrified, or unconscious creature is also incapacitated, so the
 * whole set collapses to "cannot take actions or reactions".
 */
export const DND_5E_ACTION_DENYING_CONDITIONS: readonly ConditionId[] = Object.freeze([
  "incapacitated", "paralyzed", "petrified", "stunned", "unconscious",
]);

/** SRD 5.1 conditions that reduce a creature's speed to 0. */
export const DND_5E_MOVEMENT_DENYING_CONDITIONS: readonly ConditionId[] = Object.freeze([
  "grappled", "paralyzed", "petrified", "restrained", "stunned", "unconscious",
]);

/** SRD 5.1 conditions that impose disadvantage on the creature's own attack rolls. */
export const DND_5E_ATTACK_DISADVANTAGE_CONDITIONS: readonly ConditionId[] = Object.freeze([
  "blinded", "frightened", "poisoned", "prone", "restrained",
]);

/** SRD 5.1 conditions that grant advantage to attacks made against the creature. */
export const DND_5E_ATTACKED_WITH_ADVANTAGE_CONDITIONS: readonly ConditionId[] = Object.freeze([
  "blinded", "paralyzed", "petrified", "restrained", "stunned", "unconscious",
]);

/** Persisted SRD 5.1 conditions (exhaustion is tracked as a six-level resource). */
export const DND_5E_PERSISTED_CONDITIONS: readonly ConditionId[] = Object.freeze([
  "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "invisible",
  "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious",
]);

/** All fifteen SRD 5.1 conditions, including exhaustion. */
export const DND_5E_CONDITIONS: readonly (ConditionId | "exhaustion")[] = Object.freeze([
  ...DND_5E_PERSISTED_CONDITIONS, "exhaustion",
]);

/**
 * The complete non-attack condition state derived from a set of conditions.
 * Exhaustion is tracked separately by `deriveDnd5eExhaustionEffects`.
 */
export type Dnd5eConditionEffects = Readonly<{
  actionsDenied: boolean;
  reactionsDenied: boolean;
  speedZero: boolean;
  attackRollDisadvantage: boolean;
  abilityCheckDisadvantage: boolean;
  strengthSaveAutoFail: boolean;
  dexteritySaveAutoFail: boolean;
  damageResistance: boolean;
  unawareOfSurroundings: boolean;
}>;

/** Derives the aggregated SRD 5.1 non-attack effects for one creature. */
export function deriveDnd5eConditionEffects(conditions: readonly ConditionId[]): Dnd5eConditionEffects {
  const present = new Set(conditions);
  const hasAny = (ids: readonly ConditionId[]) => ids.some((condition) => present.has(condition));
  return Object.freeze({
    actionsDenied: hasAny(DND_5E_ACTION_DENYING_CONDITIONS),
    reactionsDenied: hasAny(DND_5E_ACTION_DENYING_CONDITIONS),
    speedZero: hasAny(DND_5E_MOVEMENT_DENYING_CONDITIONS),
    attackRollDisadvantage: hasAny(DND_5E_ATTACK_DISADVANTAGE_CONDITIONS),
    abilityCheckDisadvantage: hasAny(["frightened", "poisoned"]),
    strengthSaveAutoFail: hasAny(["paralyzed", "petrified"]),
    dexteritySaveAutoFail: hasAny(["paralyzed", "petrified"]),
    damageResistance: present.has("petrified"),
    unawareOfSurroundings: present.has("petrified"),
  });
}

/**
 * SRD 5.1 frightened: disadvantage on ability checks and attack rolls while
 * the source of fear is within line of sight, and the creature cannot willingly
 * move closer to that source.
 */
export function deriveDnd5eFrightenedEffects(
  input: Readonly<{ frightened: boolean; sourceInLineOfSight: boolean }>,
): Readonly<{ abilityCheckDisadvantage: boolean; attackRollDisadvantage: boolean; canApproachSource: boolean }> {
  const active = input.frightened && input.sourceInLineOfSight;
  return Object.freeze({
    abilityCheckDisadvantage: active,
    attackRollDisadvantage: active,
    canApproachSource: !input.frightened,
  });
}

/** SRD 5.1 exhaustion level 6 is death. */
export function isDnd5eExhaustionFatal(level: number): boolean {
  requireInteger(level, "exhaustion level");
  if (level < 0 || level > 6) throw new RangeError("exhaustion level must be between 0 and 6");
  return level >= 6;
}

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
