import type {
  AttackConditionInput, AttackConditionPlan, AttackInput, AttackResolution, RulesetCapability,
} from "../types.js";
import {
  DND_5E_ATTACKED_WITH_ADVANTAGE_CONDITIONS, DND_5E_ATTACK_DISADVANTAGE_CONDITIONS, deriveDnd5eExhaustionEffects,
} from "./conditions.js";
import { dnd5eRollMode, resolveDnd5eD20Test } from "./d20.js";
import { frozenList, requireInteger } from "./internal.js";

export const DND_5E_ATTACK_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "attacks", version: "1.7.0", status: "supported" as const }),
]);

export function resolveDnd5eAttack(input: AttackInput): AttackResolution {
  requireInteger(input.armorClass, "armor class");
  const criticalThreshold = input.criticalThreshold ?? 20;
  requireInteger(criticalThreshold, "critical threshold");
  if (criticalThreshold < 2 || criticalThreshold > 20) throw new RangeError("critical threshold must be between 2 and 20");
  const resolution = resolveDnd5eD20Test({ ...input, dc: input.armorClass });
  const natural = resolution.evidence.selected;
  const automaticMiss = natural === 1;
  const critical = natural !== 1 && natural >= criticalThreshold;
  const hit = !automaticMiss && (critical || resolution.success);
  return Object.freeze({ ...resolution, armorClass: input.armorClass, hit, critical, automaticMiss });
}

/**
 * SRD 5.1 condition effects on one attack roll. Attacker hindrances produce
 * disadvantage and an invisible attacker produces advantage; a blinded,
 * paralyzed, petrified, restrained, stunned, or unconscious target (and a prone
 * target in melee) produces advantage, while an invisible target produces
 * disadvantage. Advantage and disadvantage from any source cancel. A melee
 * attack against an unconscious, paralyzed, or petrified target is a critical
 * hit when it hits.
 */
export function planDnd5eAttackConditions(input: AttackConditionInput): AttackConditionPlan {
  const attacker = new Set(input.attacker), target = new Set(input.target);
  let advantageSources = 0, disadvantageSources = 0;
  for (const condition of DND_5E_ATTACK_DISADVANTAGE_CONDITIONS) if (attacker.has(condition)) disadvantageSources += 1;
  if (input.longRange) disadvantageSources += 1;
  if (deriveDnd5eExhaustionEffects(input.attackerExhaustion ?? 0).attackDisadvantage) disadvantageSources += 1;
  if (input.attackerBenefit) advantageSources += 1;
  if (attacker.has("invisible")) advantageSources += 1;
  // SRD 5.1 unseen attackers and targets: an unseen attacker has advantage and
  // an unseen target imposes disadvantage, independent of the invisible condition.
  if (input.attackerUnseen) advantageSources += 1;
  if (input.mountedAdvantage) advantageSources += 1;
  if (input.underwaterDisadvantage) disadvantageSources += 1;
  if (input.attackerInMelee && input.kind !== "melee") disadvantageSources += 1;
  for (const condition of DND_5E_ATTACKED_WITH_ADVANTAGE_CONDITIONS) if (target.has(condition)) advantageSources += 1;
  if (target.has("prone")) { if (input.kind === "melee") advantageSources += 1; else disadvantageSources += 1; }
  if (target.has("invisible") || input.targetUnseen) disadvantageSources += 1;
  const autoCritical = input.kind === "melee"
    && (target.has("unconscious") || target.has("paralyzed") || target.has("petrified"));
  return Object.freeze({ mode: dnd5eRollMode(advantageSources, disadvantageSources), autoCritical });
}

/** One declarative on-hit rider requirement evaluated after the hit/miss step. */
export type OnHitRiderPlan = Readonly<{
  riderId: string;
  requiresAdvantage?: boolean;
  limit?: "once-per-turn" | "once-per-attack";
}>;
export type OnHitRiderContext = Readonly<{
  hit: boolean;
  advantage: boolean;
  usedThisTurn: readonly string[];
  usedThisAttack: readonly string[];
}>;

/**
 * Selects the on-hit riders that resolve for one attack. Riders never resolve
 * on a miss; an advantage requirement and once-per-turn/once-per-attack limits
 * are enforced deterministically in declaration order.
 */
export function selectDnd5eOnHitRiders<T extends OnHitRiderPlan>(riders: readonly T[], context: OnHitRiderContext): readonly T[] {
  if (!context.hit) return frozenList([]);
  const usedTurn = new Set(context.usedThisTurn), usedAttack = new Set(context.usedThisAttack);
  return frozenList(riders.filter((rider) => {
    if (rider.requiresAdvantage && !context.advantage) return false;
    if (rider.limit === "once-per-turn" && usedTurn.has(rider.riderId)) return false;
    if (rider.limit === "once-per-attack" && usedAttack.has(rider.riderId)) return false;
    return true;
  }));
}
