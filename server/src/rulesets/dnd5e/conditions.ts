import type {
  ConcentrationPlan, ConditionId, ConditionStatePlan, D20TestInput, ExhaustionEffects, LegalActionPlan, RulesetCapability,
} from "../types.js";
import { resolveDnd5eAbilityTest, resolveDnd5eSkillTest } from "./d20.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";

export const DND_5E_CONDITION_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "concentration", version: "1.1.0", status: "partial" as const }),
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

/** A creature is dead once its death save failures reach three. */
export const DND_5E_DEATH_SAVE_FAILURE_LIMIT = 3;
/** A creature is stable once its death save successes reach three. */
export const DND_5E_DEATH_SAVE_SUCCESS_LIMIT = 3;

export type Dnd5eDeathSavePlan = Readonly<{
  roll: number;
  successes: number;
  failures: number;
  status: "active" | "stable" | "unconscious" | "dead";
  regainsHitPoints: number;
  stable: boolean;
}>;

/**
 * SRD 5.1 death saving throw. A natural 20 regains 1 hit point; a natural 1
 * counts as two failures; any other roll below 10 is a failure and 10 or higher
 * is a success. Three failures kill; three successes stabilize.
 */
export function planDnd5eDeathSave(input: Readonly<{ roll: number; successes: number; failures: number }>): Dnd5eDeathSavePlan {
  requireInteger(input.roll, "death save roll");
  if (input.roll < 1 || input.roll > 20) throw new RangeError("death save roll must be between 1 and 20");
  requireNonNegativeInteger(input.successes, "death save successes");
  requireNonNegativeInteger(input.failures, "death save failures");
  const successesBefore = Math.min(DND_5E_DEATH_SAVE_SUCCESS_LIMIT, input.successes);
  const failuresBefore = Math.min(DND_5E_DEATH_SAVE_FAILURE_LIMIT, input.failures);
  if (input.roll === 20) return Object.freeze({ roll: 20, successes: 0, failures: 0, status: "active", regainsHitPoints: 1, stable: false });
  const failures = Math.min(DND_5E_DEATH_SAVE_FAILURE_LIMIT, failuresBefore + (input.roll === 1 ? 2 : input.roll < 10 ? 1 : 0));
  const successes = Math.min(DND_5E_DEATH_SAVE_SUCCESS_LIMIT, successesBefore + (input.roll >= 10 ? 1 : 0));
  const status = failures >= DND_5E_DEATH_SAVE_FAILURE_LIMIT ? "dead"
    : successes >= DND_5E_DEATH_SAVE_SUCCESS_LIMIT ? "stable" : "unconscious";
  return Object.freeze({ roll: input.roll, successes, failures, status, regainsHitPoints: 0, stable: status === "stable" });
}

/** SRD 5.1 massive damage: leftover damage at or above the hit point maximum kills instantly. */
export function planDnd5eMassiveDamage(input: Readonly<{ hitPointsBefore: number; hitPointDamage: number; maximumHitPoints: number }>): boolean {
  requireInteger(input.hitPointsBefore, "hit points before");
  requireNonNegativeInteger(input.hitPointDamage, "hit point damage");
  requireInteger(input.maximumHitPoints, "maximum hit points");
  if (input.hitPointsBefore <= 0 || input.hitPointDamage < input.hitPointsBefore) return false;
  return input.hitPointDamage - input.hitPointsBefore >= input.maximumHitPoints;
}

export type Dnd5eDyingDamagePlan = Readonly<{
  status: string;
  successes: number;
  failures: number;
  stable: boolean;
  massiveDamage: boolean;
  failuresAdded: number;
}>;

/**
 * SRD 5.1 damage while dying. Dropping to 0 hit points either kills ("massive
 * damage") or leaves the creature unconscious; damage taken while already at 0
 * adds one death save failure, or two when the source is a critical hit made
 * within 5 feet. Healing is handled by `planDnd5eHealingEndsDying`.
 */
export function planDnd5eDyingDamage(input: Readonly<{
  actorBacked: boolean;
  hitPointsBefore: number;
  hitPointsAfter: number;
  maximumHitPoints: number;
  hitPointDamage: number;
  currentStatus: string;
  successes?: number;
  failures?: number;
  stable?: boolean;
  critical?: boolean;
  withinFiveFeet?: boolean;
}>): Dnd5eDyingDamagePlan {
  requireInteger(input.hitPointsBefore, "hit points before");
  requireInteger(input.hitPointsAfter, "hit points after");
  requireNonNegativeInteger(input.hitPointDamage, "hit point damage");
  requireNonNegativeInteger(input.maximumHitPoints, "maximum hit points");
  const successes = Math.min(DND_5E_DEATH_SAVE_SUCCESS_LIMIT, Math.max(0, input.successes ?? 0));
  const failures = Math.min(DND_5E_DEATH_SAVE_FAILURE_LIMIT, Math.max(0, input.failures ?? 0));
  if (!input.actorBacked) return Object.freeze({ status: input.hitPointsAfter === 0 ? "defeated" : "active",
    successes, failures, stable: false, massiveDamage: false, failuresAdded: 0 });
  if (input.hitPointsBefore > 0 && input.hitPointsAfter === 0) {
    const massiveDamage = planDnd5eMassiveDamage(input);
    return Object.freeze({ status: massiveDamage ? "dead" : "unconscious", successes: 0, failures: 0,
      stable: false, massiveDamage, failuresAdded: 0 });
  }
  if (input.hitPointsBefore === 0 && input.hitPointDamage > 0) {
    const failuresAdded = input.critical && input.withinFiveFeet ? 2 : 1;
    const nextFailures = Math.min(DND_5E_DEATH_SAVE_FAILURE_LIMIT, failures + failuresAdded);
    const status = nextFailures >= DND_5E_DEATH_SAVE_FAILURE_LIMIT ? "dead" : "unconscious";
    return Object.freeze({ status, successes, failures: nextFailures, stable: false, massiveDamage: false, failuresAdded });
  }
  return Object.freeze({ status: input.currentStatus, successes, failures, stable: Boolean(input.stable),
    massiveDamage: false, failuresAdded: 0 });
}

/** SRD 5.1 healing ends the dying state (but cannot revive a dead creature). */
export function planDnd5eHealingEndsDying(input: Readonly<{ hitPointsBefore: number; hitPointsAfter: number; currentStatus: string }>): Readonly<{ status: string; endsDying: boolean }> {
  requireInteger(input.hitPointsBefore, "hit points before");
  requireInteger(input.hitPointsAfter, "hit points after");
  const endsDying = input.hitPointsBefore <= 0 && input.hitPointsAfter > 0 && input.currentStatus !== "dead" && input.currentStatus !== "defeated";
  return Object.freeze({ status: endsDying ? "active" : input.currentStatus, endsDying });
}

/** Advantage for an assisted stabilization, disadvantage for an unsupported ranged attempt. */
export function dnd5eStabilizationRollMode(input: Readonly<{ assisted?: boolean; ranged?: boolean }>): "normal" | "advantage" | "disadvantage" {
  const assisted = Boolean(input.assisted), ranged = Boolean(input.ranged);
  if (assisted === ranged) return "normal";
  return assisted ? "advantage" : "disadvantage";
}

export type Dnd5eStabilizationPlan = Readonly<{
  required: boolean;
  dc: number | null;
  stabilized: boolean;
  healerKit: boolean;
  ranged: boolean;
  assisted: boolean;
  rollMode: "normal" | "advantage" | "disadvantage";
  check?: ReturnType<typeof resolveDnd5eSkillTest>;
}>;

/**
 * SRD 5.1 stabilizing a dying creature. Administering first aid is a DC 10
 * Wisdom (Medicine) check; a healer's kit stabilizes automatically, assistance
 * grants advantage, and an unsupported ranged attempt is at disadvantage.
 */
export function planDnd5eStabilization(input: Readonly<{
  targetAtZeroHitPoints: boolean;
  targetStable: boolean;
  healerKit?: boolean;
  ranged?: boolean;
  assisted?: boolean;
  checkInput?: Omit<D20TestInput, "dc" | "abilityScore"> & Readonly<{ wisdomScore: number }>;
}>): Dnd5eStabilizationPlan {
  const healerKit = Boolean(input.healerKit), ranged = Boolean(input.ranged), assisted = Boolean(input.assisted);
  const rollMode = dnd5eStabilizationRollMode({ assisted, ranged });
  if (!input.targetAtZeroHitPoints || input.targetStable) return Object.freeze({ required: false, dc: null,
    stabilized: input.targetStable, healerKit, ranged, assisted, rollMode });
  if (healerKit) return Object.freeze({ required: false, dc: null, stabilized: true, healerKit, ranged, assisted, rollMode });
  const dc = 10;
  if (input.checkInput === undefined) return Object.freeze({ required: true, dc, stabilized: false, healerKit, ranged, assisted, rollMode });
  const check = resolveDnd5eSkillTest("medicine", { ...input.checkInput, abilityScore: input.checkInput.wisdomScore, dc,
    advantageSources: rollMode === "advantage" ? 1 : 0, disadvantageSources: rollMode === "disadvantage" ? 1 : 0 });
  return Object.freeze({ required: true, dc, stabilized: check.success, healerKit, ranged, assisted, rollMode, check });
}

export type Dnd5eConcentrationEndReason = "dropped" | "save-failed" | "incapacitated" | "zero-hit-points" | "dead";
export type Dnd5eConcentrationEndPlan = Readonly<{
  ends: boolean;
  reason: Dnd5eConcentrationEndReason | null;
  condition: ConditionId | null;
}>;

/**
 * SRD 5.1 concentration ends on incapacitation (including stunned, paralyzed,
 * petrified, and unconscious), death, being reduced to 0 hit points, a failed
 * save, or when the caster deliberately drops it.
 */
export function planDnd5eConcentrationEnd(input: Readonly<{
  conditions?: readonly ConditionId[];
  status?: string;
  hitPoints?: number;
  dropped?: boolean;
  saveFailed?: boolean;
}>): Dnd5eConcentrationEndPlan {
  if (input.dropped) return Object.freeze({ ends: true, reason: "dropped", condition: null });
  if (input.saveFailed) return Object.freeze({ ends: true, reason: "save-failed", condition: null });
  if (input.status === "dead" || input.status === "defeated") return Object.freeze({ ends: true, reason: "dead", condition: null });
  if (input.hitPoints !== undefined && input.hitPoints <= 0) return Object.freeze({ ends: true, reason: "zero-hit-points", condition: null });
  const condition = (input.conditions ?? []).find((candidate) => DND_5E_ACTION_DENYING_CONDITIONS.includes(candidate)) ?? null;
  if (condition) return Object.freeze({ ends: true, reason: "incapacitated", condition });
  return Object.freeze({ ends: false, reason: null, condition: null });
}

/**
 * Concentration save against an explicit environmental or spell DC rather than
 * the damage-derived DC used by `planDnd5eConcentrationDamage`.
 */
export function planDnd5eConcentrationEnvironment(dc: number, concentrating: boolean, checkInput?: Omit<D20TestInput, "dc" | "abilityScore"> & Readonly<{ constitutionScore: number }>): ConcentrationPlan {
  requireInteger(dc, "concentration DC");
  if (dc < 1) throw new RangeError("concentration DC must be at least 1");
  if (!concentrating) return Object.freeze({ required: false, dc: null, broken: false });
  if (checkInput === undefined) return Object.freeze({ required: true, dc, broken: false });
  const check = resolveDnd5eAbilityTest("concentration-check", "constitution", { ...checkInput, abilityScore: checkInput.constitutionScore, dc });
  return Object.freeze({ required: true, dc, broken: !check.success, check });
}
