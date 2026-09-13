import type {
  AttackConditionInput, AttackConditionPlan, AttackInput, AttackResolution,
} from "../types.js";
import { deriveDnd5eExhaustionEffects } from "./conditions.js";
import { dnd5eRollMode, resolveDnd5eD20Test } from "./d20.js";
import { requireInteger } from "./internal.js";

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
 * disadvantage; a blinded, restrained, stunned, or unconscious target (and a
 * prone target in melee) produces advantage. Advantage and disadvantage from
 * any source cancel. A melee attack against an unconscious, paralyzed, or
 * petrified target is a critical hit when it hits.
 */
export function planDnd5eAttackConditions(input: AttackConditionInput): AttackConditionPlan {
  const attacker = new Set(input.attacker), target = new Set(input.target);
  let advantageSources = 0, disadvantageSources = 0;
  for (const condition of ["blinded", "poisoned", "prone", "restrained"] as const) if (attacker.has(condition)) disadvantageSources += 1;
  if (input.longRange) disadvantageSources += 1;
  if (deriveDnd5eExhaustionEffects(input.attackerExhaustion ?? 0).attackDisadvantage) disadvantageSources += 1;
  if (input.attackerBenefit) advantageSources += 1;
  if (input.attackerInMelee && input.kind !== "melee") disadvantageSources += 1;
  for (const condition of ["blinded", "restrained", "stunned", "unconscious"] as const) if (target.has(condition)) advantageSources += 1;
  if (target.has("prone")) { if (input.kind === "melee") advantageSources += 1; else disadvantageSources += 1; }
  const autoCritical = input.kind === "melee"
    && (target.has("unconscious") || target.has("paralyzed") || target.has("petrified"));
  return Object.freeze({ mode: dnd5eRollMode(advantageSources, disadvantageSources), autoCritical });
}
