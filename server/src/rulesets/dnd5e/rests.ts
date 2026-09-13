import type { RecoveryPlan, RestInput, RulesetCapability } from "../types.js";
import { dnd5eProficiencyBonus } from "./d20.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";

export const DND_5E_REST_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "rests", version: "1.1.0", status: "partial" as const }),
]);

export function planDnd5eRest(input: RestInput): RecoveryPlan {
  requireNonNegativeInteger(input.currentHitPoints, "current hit points");
  requireNonNegativeInteger(input.maxHitPoints, "maximum hit points");
  requireNonNegativeInteger(input.hitDiceRemaining, "hit dice remaining");
  dnd5eProficiencyBonus(input.level);
  const reasons: string[] = [];
  if (input.currentHitPoints > input.maxHitPoints) reasons.push("current hit points exceed maximum hit points");
  if (input.hitDiceRemaining > input.level) reasons.push("hit dice remaining exceed level");
  const spends = input.hitDiceSpent ?? [];
  if (input.kind === "long" && spends.length > 0) reasons.push("hit dice cannot be spent as part of this long-rest plan");
  if (spends.length > input.hitDiceRemaining) reasons.push("not enough hit dice remain");
  let recovered = 0;
  spends.forEach((spend) => {
    requireInteger(spend.die, "hit die");
    requireInteger(spend.constitutionModifier, "constitution modifier");
    if (spend.die < 1) reasons.push("hit die results must be positive");
    recovered += Math.max(0, spend.die + spend.constitutionModifier);
  });
  if (input.kind === "long") recovered = Math.max(0, input.maxHitPoints - input.currentHitPoints);
  const legal = reasons.length === 0;
  const hitDiceRecovered = input.kind === "long" ? Math.min(input.level - input.hitDiceRemaining, Math.max(1, Math.floor(input.level / 2))) : 0;
  return Object.freeze({
    kind: input.kind,
    hitPointsRecovered: legal ? Math.min(recovered, Math.max(0, input.maxHitPoints - input.currentHitPoints)) : 0,
    resultingHitPoints: legal ? Math.min(input.maxHitPoints, input.currentHitPoints + recovered) : input.currentHitPoints,
    hitDiceSpent: legal && input.kind === "short" ? spends.length : 0,
    hitDiceRecovered: legal ? Math.max(0, hitDiceRecovered) : 0,
    clearExhaustionLevels: legal && input.kind === "long" && input.exhausted ? 1 : 0,
    legal,
    reasons: frozenList(reasons),
  });
}
