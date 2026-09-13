import type { AbilityId, AttackResolution, DamageRollResolution, D20TestResolution } from "../types.js";
import { resolveDnd5eAttack } from "./attack.js";
import { resolveDnd5eDamageRoll } from "./damage.js";
import { resolveDnd5eD20Test } from "./d20.js";
import { frozenList, requireInteger } from "./internal.js";

/**
 * Pure SRD 5.1 monster action plans. This module is deliberately free of
 * persistence and catalog types so it can describe and resolve multiattack,
 * recharge abilities, and save-based monster actions deterministically. Dice
 * are always supplied by the caller (either as explicit faces or through a
 * narrow injected RNG), which keeps every resolution reproducible.
 */

export type MonsterRng = Readonly<{ integer(minInclusive: number, maxExclusive: number): number }>;

export type MonsterDamageDie = Readonly<{ count: number; sides: number }>;

export type MonsterAttackStep = Readonly<{
  /** Catalog ability definition id this step resolves through. */
  abilityId: string;
  label: string;
  attackBonus: number;
  damageDie: MonsterDamageDie;
  damageModifier: number;
  damageType: string;
  /** Critical threat range floor; defaults to a natural 20. */
  criticalThreshold?: number;
}>;

export type MonsterMultiattackPlan = Readonly<{
  kind: "multiattack";
  /** Ordered attacks; one receipt/outcome is produced per entry. */
  sequence: readonly MonsterAttackStep[];
}>;

export type MonsterSaveRider =
  | Readonly<{ kind: "damage"; damageDie: MonsterDamageDie; damageModifier: number; damageType: string }>
  | Readonly<{ kind: "condition"; condition: string; durationRounds?: number }>;

export type MonsterSavePlan = Readonly<{
  kind: "save";
  abilityId: string;
  ability: AbilityId;
  dc: number;
  onFail: readonly MonsterSaveRider[];
  onSuccess: readonly MonsterSaveRider[];
}>;

export type MonsterRechargePlan = Readonly<{
  kind: "recharge";
  abilityId: string;
  /** Inclusive recharge range, e.g. 5-6. */
  min: number;
  max: number;
}>;

/** A single attack that may carry an on-hit save rider (e.g. Wolf Knockdown). */
export type MonsterAttackPlan = Readonly<{
  kind: "attack";
  step: MonsterAttackStep;
  onHit?: MonsterSavePlan;
}>;

export type MonsterActionPlan = MonsterMultiattackPlan | MonsterAttackPlan | MonsterSavePlan;

export type MonsterRechargeResolution = Readonly<{
  abilityId: string;
  range: readonly [number, number];
  roll: number;
  /** True when the ability can be used this turn. */
  ready: boolean;
  /** True when a spent ability was restored by this roll. */
  restored: boolean;
  /** Recharge state after the start-of-turn roll. */
  spentAfter: boolean;
}>;

export type MonsterSaveResolution = Readonly<{
  abilityId: string;
  ability: AbilityId;
  dc: number;
  roll: number;
  total: number;
  success: boolean;
  /** "full" on failure, "partial" or "none" on success. */
  outcome: "full" | "partial" | "none";
  applied: readonly MonsterSaveRider[];
}>;

export type MonsterAttackResolution = Readonly<{
  step: MonsterAttackStep;
  attackRoll: number;
  attackTotal: number;
  armorClass: number;
  hit: boolean;
  critical: boolean;
  damageRolls: readonly number[];
  damage: number;
  /** Full shared attack resolution evidence for auditability. */
  attack: AttackResolution;
  /** Full shared damage resolution evidence, or null on a miss. */
  damageResolution: DamageRollResolution | null;
}>;

/**
 * Closed multiattack shapes keyed by enemy-template definition id. Each entry
 * is the ordered list of ability definition ids the monster attacks with. The
 * Goblin's SRD "two attacks, using Scimitar or Shortbow in any combination" is
 * bounded to the pinned scimitar ability the starter catalog actually ships.
 */
const MONSTER_MULTIATTACK_SHAPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "srd-5.1:enemy-template:goblin": Object.freeze(["srd-5.1:ability:goblin-scimitar", "srd-5.1:ability:goblin-scimitar"]),
});

/**
 * Save-based riders keyed by ability definition id. The Wolf's bite forces a
 * DC 11 Strength saving throw or the target is knocked prone.
 */
const MONSTER_SAVE_RIDERS: Readonly<Record<string, Omit<MonsterSavePlan, "kind" | "abilityId">>> = Object.freeze({
  "srd-5.1:ability:wolf-knockdown": Object.freeze({
    ability: "strength",
    dc: 11,
    onFail: frozenList([Object.freeze({ kind: "condition" as const, condition: "prone" })]),
    onSuccess: frozenList([]),
  }),
});

/**
 * Recharge ranges keyed by ability definition id. No shipped starter ability
 * has a recharge entry yet; the closed test-fixture key exercises the engine
 * without inventing SRD content.
 */
const MONSTER_RECHARGE_RANGES: Readonly<Record<string, Omit<MonsterRechargePlan, "kind" | "abilityId">>> = Object.freeze({
  "velvet:test-fixture:ability:recharge-5-6": Object.freeze({ min: 5, max: 6 }),
});

/** The ordered ability ids of a monster's multiattack, or null when it has none. */
export function monsterMultiattackShape(enemyDefinitionId: string): readonly string[] | null {
  return MONSTER_MULTIATTACK_SHAPES[enemyDefinitionId] ?? null;
}

/** Builds the ordered multiattack plan from the monster's available attack steps. */
export function planMonsterMultiattack(enemyDefinitionId: string, attackSteps: readonly MonsterAttackStep[]): MonsterMultiattackPlan | null {
  const shape = monsterMultiattackShape(enemyDefinitionId);
  if (!shape) return null;
  const byAbility = new Map(attackSteps.map((step) => [step.abilityId, step] as const));
  const sequence = shape.map((abilityId) => {
    const step = byAbility.get(abilityId);
    if (!step) throw new Error(`monster multiattack is missing an attack profile: ${abilityId}`);
    return step;
  });
  return Object.freeze({ kind: "multiattack", sequence: frozenList(sequence) });
}

/** The save plan for an ability, or null when it has no save rider. */
export function planMonsterSave(abilityId: string): MonsterSavePlan | null {
  const rider = MONSTER_SAVE_RIDERS[abilityId];
  return rider ? Object.freeze({ kind: "save", abilityId, ...rider }) : null;
}

/** The recharge plan for an ability, or null when it does not recharge. */
export function planMonsterRecharge(abilityId: string): MonsterRechargePlan | null {
  const range = MONSTER_RECHARGE_RANGES[abilityId];
  return range ? Object.freeze({ kind: "recharge", abilityId, ...range }) : null;
}

/**
 * Applies one start-of-turn recharge roll. A spent ability is only restored
 * when the roll lands inside its inclusive range; an unspent ability stays
 * ready. The roll is supplied (not drawn) so the resolution is deterministic.
 */
export function resolveMonsterRecharge(plan: MonsterRechargePlan, spent: boolean, roll: number): MonsterRechargeResolution {
  requireInteger(roll, "recharge roll");
  if (plan.min < 1 || plan.max < plan.min || roll < 1 || roll > plan.max) {
    throw new RangeError("recharge roll must be inside the die range");
  }
  const restored = spent && roll >= plan.min;
  return Object.freeze({
    abilityId: plan.abilityId,
    range: Object.freeze([plan.min, plan.max]) as readonly [number, number],
    roll,
    ready: !spent || restored,
    restored,
    spentAfter: spent && !restored,
  });
}

/** Draws a recharge die through the injected RNG and resolves it. */
export function rollMonsterRecharge(plan: MonsterRechargePlan, spent: boolean, rng: MonsterRng): MonsterRechargeResolution {
  const roll = rng.integer(1, plan.max + 1);
  if (!Number.isInteger(roll) || roll < 1 || roll > plan.max) throw new Error("monster recharge RNG returned an out-of-range die");
  return resolveMonsterRecharge(plan, spent, roll);
}

/**
 * Resolves a save-based monster action. The target's total save bonus is
 * supplied directly so this stays free of character-sheet lookups. Failure
 * applies every on-fail rider ("full"); success applies the on-success riders,
 * which is "partial" when riders exist and "none" otherwise.
 */
export function resolveMonsterSave(plan: MonsterSavePlan, input: Readonly<{
  rolls: readonly number[];
  saveBonus: number;
  advantageSources?: number;
  disadvantageSources?: number;
}>): MonsterSaveResolution {
  requireInteger(input.saveBonus, "save bonus");
  const test: D20TestResolution = resolveDnd5eD20Test({
    rolls: input.rolls,
    abilityScore: 10,
    flatBonus: input.saveBonus,
    dc: plan.dc,
    ...(input.advantageSources !== undefined ? { advantageSources: input.advantageSources } : {}),
    ...(input.disadvantageSources !== undefined ? { disadvantageSources: input.disadvantageSources } : {}),
  });
  const applied = test.success ? plan.onSuccess : plan.onFail;
  return Object.freeze({
    abilityId: plan.abilityId,
    ability: plan.ability,
    dc: plan.dc,
    roll: test.evidence.selected,
    total: test.total,
    success: test.success,
    outcome: test.success ? (applied.length === 0 ? "none" : "partial") : "full",
    applied: frozenList(applied),
  });
}

/**
 * Resolves one monster attack step from explicit dice. A natural 1 misses and
 * a critical doubles the damage dice (not the modifier) through the shared
 * attack/damage machinery.
 */
export function resolveMonsterAttackStep(step: MonsterAttackStep, input: Readonly<{
  armorClass: number;
  attackRoll: number;
  damageRolls: readonly number[];
}>): MonsterAttackResolution {
  requireInteger(input.attackRoll, "attack roll");
  if (input.attackRoll < 1 || input.attackRoll > 20) throw new RangeError("attack roll must be between 1 and 20");
  const attack = resolveDnd5eAttack({
    rolls: [input.attackRoll],
    abilityScore: 10,
    flatBonus: step.attackBonus,
    armorClass: input.armorClass,
    ...(step.criticalThreshold !== undefined ? { criticalThreshold: step.criticalThreshold } : {}),
  });
  const damageResolution = attack.hit
    ? resolveDnd5eDamageRoll({ dice: [step.damageDie], rolls: [input.damageRolls], modifier: step.damageModifier, critical: attack.critical })
    : null;
  return Object.freeze({
    step,
    attackRoll: attack.evidence.selected,
    attackTotal: attack.total,
    armorClass: input.armorClass,
    hit: attack.hit,
    critical: attack.critical,
    damageRolls: frozenList(input.damageRolls),
    damage: damageResolution?.total ?? 0,
    attack,
    damageResolution,
  });
}

/** Draws an attack d20 and its damage dice through the injected RNG. */
export function resolveMonsterAttack(step: MonsterAttackStep, input: Readonly<{ armorClass: number; rng: MonsterRng }>): MonsterAttackResolution {
  const attackRoll = input.rng.integer(1, 21);
  if (!Number.isInteger(attackRoll) || attackRoll < 1 || attackRoll > 20) throw new Error("monster attack RNG returned an out-of-range d20");
  const attack = resolveDnd5eAttack({
    rolls: [attackRoll],
    abilityScore: 10,
    flatBonus: step.attackBonus,
    armorClass: input.armorClass,
    ...(step.criticalThreshold !== undefined ? { criticalThreshold: step.criticalThreshold } : {}),
  });
  const expected = attack.hit ? step.damageDie.count * (attack.critical ? 2 : 1) : 0;
  const damageRolls = Array.from({ length: expected }, () => {
    const roll = input.rng.integer(1, step.damageDie.sides + 1);
    if (!Number.isInteger(roll) || roll < 1 || roll > step.damageDie.sides) throw new Error("monster damage RNG returned an out-of-range die");
    return roll;
  });
  const damageResolution = attack.hit
    ? resolveDnd5eDamageRoll({ dice: [step.damageDie], rolls: [damageRolls], modifier: step.damageModifier, critical: attack.critical })
    : null;
  return Object.freeze({
    step,
    attackRoll: attack.evidence.selected,
    attackTotal: attack.total,
    armorClass: input.armorClass,
    hit: attack.hit,
    critical: attack.critical,
    damageRolls: frozenList(damageRolls),
    damage: damageResolution?.total ?? 0,
    attack,
    damageResolution,
  });
}
