import type { AbilityId } from "../../../rulesets/types.js";
import {
  resolveMonsterAttack, resolveMonsterSave, rollMonsterRecharge,
  type MonsterActionPlan, type MonsterAttackStep, type MonsterRechargePlan, type MonsterRechargeResolution,
  type MonsterRng, type MonsterSavePlan, type MonsterSaveRider,
} from "../../../rulesets/dnd5e/monsters.js";

/**
 * Deterministic monster action executor. Every die is drawn through the
 * injected RNG, and each multiattack step produces exactly one outcome so a
 * caller can seal one receipt per attack in declared order.
 */

export type MonsterTargetState = Readonly<{
  combatantId: string;
  armorClass: number;
  /** Flat bonus applied to the target's saving throw (ability modifier + proficiency). */
  saveBonus: number;
}>;

export type MonsterRiderApplication =
  | Readonly<{ kind: "damage"; damageType: string; damageRolls: readonly number[]; damage: number }>
  | Readonly<{ kind: "condition"; condition: string; durationRounds?: number }>;

export type MonsterSaveOutcome = Readonly<{
  abilityId: string;
  ability: AbilityId;
  dc: number;
  roll: number;
  total: number;
  success: boolean;
  outcome: "full" | "partial" | "none";
  applied: readonly MonsterRiderApplication[];
}>;

export type MonsterAttackOutcome = Readonly<{
  kind: "attack";
  stepIndex: number;
  abilityId: string;
  label: string;
  targetId: string;
  attackRoll: number;
  attackTotal: number;
  armorClass: number;
  hit: boolean;
  critical: boolean;
  damageRolls: readonly number[];
  damage: number;
  damageType: string;
  /** Resolved on-hit save rider, present only when the attack hit and a rider exists. */
  rider?: MonsterSaveOutcome;
}>;

export type MonsterSaveActionOutcome = MonsterSaveOutcome & Readonly<{
  kind: "save";
  targetId: string;
}>;

export type MonsterActionReceipt = Readonly<{
  encounterId: string;
  combatantId: string;
  round: number;
  actionId: string;
  legalActionId: string;
  action: MonsterActionPlan["kind"];
  recharge: readonly MonsterRechargeResolution[];
  outcomes: readonly (MonsterAttackOutcome | MonsterSaveActionOutcome)[];
}>;

export type MonsterRechargeTurn = Readonly<{
  recharges: readonly MonsterRechargeResolution[];
  /** Ability ids still spent after the start-of-turn recharge rolls. */
  spent: readonly string[];
  /** Ability ids usable this turn. */
  ready: readonly string[];
}>;

function rollDamageDie(count: number, sides: number, rng: MonsterRng): readonly number[] {
  return Object.freeze(Array.from({ length: count }, () => {
    const roll = rng.integer(1, sides + 1);
    if (!Number.isInteger(roll) || roll < 1 || roll > sides) throw new Error("monster rider RNG returned an out-of-range die");
    return roll;
  }));
}

/** Applies the save riders selected by a save resolution, rolling damage dice via RNG. */
export function applyMonsterRiders(riders: readonly MonsterSaveRider[], rng: MonsterRng): readonly MonsterRiderApplication[] {
  return Object.freeze(riders.map((rider): MonsterRiderApplication => {
    if (rider.kind === "condition") {
      return Object.freeze({
        kind: "condition",
        condition: rider.condition,
        ...(rider.durationRounds !== undefined ? { durationRounds: rider.durationRounds } : {}),
      });
    }
    const damageRolls = rollDamageDie(rider.damageDie.count, rider.damageDie.sides, rng);
    const damage = damageRolls.reduce((sum, roll) => sum + roll, 0) + rider.damageModifier;
    return Object.freeze({ kind: "damage", damageType: rider.damageType, damageRolls, damage: Math.max(0, damage) });
  }));
}

/**
 * Rolls the start-of-turn recharge for every spent recharge ability. An
 * unspent ability stays ready without consuming a roll; a spent ability is
 * only restored when its roll lands inside the range.
 */
export function beginMonsterTurn(input: Readonly<{
  plans: readonly MonsterRechargePlan[];
  spent: readonly string[];
  rng: MonsterRng;
}>): MonsterRechargeTurn {
  const spentSet = new Set(input.spent);
  const recharges: MonsterRechargeResolution[] = [];
  for (const plan of input.plans) {
    if (!spentSet.has(plan.abilityId)) continue;
    const resolution = rollMonsterRecharge(plan, true, input.rng);
    if (!resolution.spentAfter) spentSet.delete(plan.abilityId);
    recharges.push(resolution);
  }
  return Object.freeze({
    recharges: Object.freeze(recharges),
    spent: Object.freeze([...spentSet]),
    ready: Object.freeze(input.plans.map((plan) => plan.abilityId).filter((abilityId) => !spentSet.has(abilityId))),
  });
}

/** Marks a recharge ability as spent after it is used. */
export function spendMonsterAbility(spent: readonly string[], abilityId: string): readonly string[] {
  return Object.freeze([...new Set([...spent, abilityId])]);
}

function resolveSavePlan(plan: MonsterSavePlan, target: MonsterTargetState, rng: MonsterRng, targetId: string): MonsterSaveActionOutcome {
  const roll = rng.integer(1, 21);
  if (!Number.isInteger(roll) || roll < 1 || roll > 20) throw new Error("monster save RNG returned an out-of-range d20");
  const resolution = resolveMonsterSave(plan, { rolls: [roll], saveBonus: target.saveBonus });
  return Object.freeze({
    kind: "save" as const,
    targetId,
    abilityId: resolution.abilityId,
    ability: resolution.ability,
    dc: resolution.dc,
    roll: resolution.roll,
    total: resolution.total,
    success: resolution.success,
    outcome: resolution.outcome,
    applied: applyMonsterRiders(resolution.applied, rng),
  });
}

function attackOutcome(stepIndex: number, step: MonsterAttackStep, target: MonsterTargetState, rng: MonsterRng): MonsterAttackOutcome {
  const resolution = resolveMonsterAttack(step, { armorClass: target.armorClass, rng });
  return Object.freeze({
    kind: "attack" as const,
    stepIndex,
    abilityId: step.abilityId,
    label: step.label,
    targetId: target.combatantId,
    attackRoll: resolution.attackRoll,
    attackTotal: resolution.attackTotal,
    armorClass: resolution.armorClass,
    hit: resolution.hit,
    critical: resolution.critical,
    damageRolls: resolution.damageRolls,
    damage: resolution.damage,
    damageType: step.damageType,
  });
}

/**
 * Executes one monster action plan against a single target. Multiattack yields
 * one attack outcome per declared step in order; a plain attack may add an
 * on-hit save rider; a save action forces a saving throw and applies its
 * failure/partial riders.
 */
export function executeMonsterAction(input: Readonly<{
  encounterId: string;
  combatantId: string;
  round: number;
  actionId: string;
  legalActionId: string;
  plan: MonsterActionPlan;
  target: MonsterTargetState;
  rng: MonsterRng;
  recharge?: readonly MonsterRechargeResolution[];
}>): MonsterActionReceipt {
  const { plan, target, rng } = input;
  let outcomes: readonly (MonsterAttackOutcome | MonsterSaveActionOutcome)[];
  if (plan.kind === "multiattack") {
    outcomes = Object.freeze(plan.sequence.map((step, index) => attackOutcome(index, step, target, rng)));
  } else if (plan.kind === "attack") {
    const outcome = attackOutcome(0, plan.step, target, rng);
    const rider = outcome.hit && plan.onHit ? resolveSavePlan(plan.onHit, target, rng, target.combatantId) : null;
    outcomes = Object.freeze([rider ? Object.freeze({ ...outcome, rider }) : outcome]);
  } else {
    outcomes = Object.freeze([resolveSavePlan(plan, target, rng, target.combatantId)]);
  }
  return Object.freeze({
    encounterId: input.encounterId,
    combatantId: input.combatantId,
    round: input.round,
    actionId: input.actionId,
    legalActionId: input.legalActionId,
    action: plan.kind,
    recharge: Object.freeze(input.recharge ? [...input.recharge] : []),
    outcomes,
  });
}
