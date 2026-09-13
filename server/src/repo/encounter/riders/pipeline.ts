import type { DiceTerm } from "../../../rulesets/types.js";
import type { RandomNumberGenerator } from "../../../runtime.js";
import { selectDnd5eOnHitRiders } from "../../../rulesets/dnd5e/attack.js";
import { resolveDnd5eOnHitRiderDamage } from "../../../rulesets/dnd5e/damage.js";
import type { AttackRider, AttackRiderContext, AttackRiderResolution, AttackRiderDamageResolution } from "./types.js";

/** Rolls one rider damage group, doubling the die count on a critical hit. */
function rollRiderTerms(dice: readonly DiceTerm[], critical: boolean, rng: RandomNumberGenerator): readonly (readonly number[])[] {
  return Object.freeze(dice.map((term) => {
    const count = term.count * (critical ? 2 : 1);
    return Object.freeze(Array.from({ length: count }, () => {
      const roll = rng.integer(1, term.sides + 1);
      if (!Number.isInteger(roll) || roll < 1 || roll > term.sides) throw new Error("combat RNG returned an out-of-range rider die");
      return roll;
    }));
  }));
}

/**
 * Selects the riders that apply to one resolved attack. Riders only resolve on
 * a hit, and a bounded limit can suppress a rider already used this turn or
 * earlier in the same attack.
 */
export function planAttackRiders(riders: readonly AttackRider[], context: AttackRiderContext): readonly AttackRider[] {
  return selectDnd5eOnHitRiders(riders, {
    hit: context.hit,
    advantage: context.advantage,
    usedThisTurn: Object.freeze([...context.usedThisTurn]),
    usedThisAttack: Object.freeze([...context.usedThisAttack]),
  });
}

/** Resolves the applicable riders, rolling any rider damage through the injected RNG. */
export function resolveAttackRiders(
  riders: readonly AttackRider[],
  context: AttackRiderContext,
  rng: RandomNumberGenerator,
): readonly AttackRiderResolution[] {
  return Object.freeze(planAttackRiders(riders, context).map((rider): AttackRiderResolution => {
    let damage: AttackRiderDamageResolution | undefined;
    if (rider.damage) {
      const doubled = context.critical && rider.damage.doubling !== "none";
      const rolls = rollRiderTerms(rider.damage.dice, doubled, rng);
      const resolution = resolveDnd5eOnHitRiderDamage({
        dice: rider.damage.dice, rolls, damageType: rider.damage.damageType, critical: doubled,
      });
      damage = Object.freeze({
        damageType: resolution.damageType, dice: rider.damage.dice,
        rolls: Object.freeze(rolls.flat()), critical: resolution.critical, damage: resolution.total,
      });
    }
    return Object.freeze({
      riderId: rider.riderId,
      label: rider.label,
      source: rider.source,
      ...(damage ? { damage } : {}),
      ...(rider.condition ? { condition: rider.condition } : {}),
      ...(rider.effect ? { effect: rider.effect } : {}),
    });
  }));
}
