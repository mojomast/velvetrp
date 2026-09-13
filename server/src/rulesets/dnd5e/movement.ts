import type {
  EncumbranceInput, EncumbrancePlan, InitiativeEntry, InitiativeResult, MovementInput, MovementPlan,
} from "../types.js";
import { dnd5eAbilityModifier } from "./d20.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";

export function resolveDnd5eInitiative(entries: readonly InitiativeEntry[]): readonly InitiativeResult[] {
  const seen = new Set<string>();
  const results = entries.map((entry) => {
    if (!entry.id || seen.has(entry.id)) throw new Error(`initiative ID must be unique and non-empty: ${entry.id}`);
    seen.add(entry.id);
    requireInteger(entry.roll, "initiative roll");
    if (entry.roll < 1 || entry.roll > 20) throw new RangeError("initiative roll must be between 1 and 20");
    const dexterityModifier = dnd5eAbilityModifier(entry.dexterityScore);
    const bonus = entry.bonus ?? 0;
    requireInteger(bonus, "initiative bonus");
    return Object.freeze({ id: entry.id, roll: entry.roll, dexterityModifier, bonus, total: entry.roll + dexterityModifier + bonus });
  });
  results.sort((a, b) => b.total - a.total || b.dexterityModifier - a.dexterityModifier || a.id.localeCompare(b.id));
  return frozenList(results);
}

/**
 * SRD 5.1 carrying capacity. Encumbered (weight above 5 x Strength) reduces
 * speed by 10; heavily encumbered (above 10 x Strength) reduces speed by 20 and
 * imposes disadvantage on ability checks, saving throws, and attacks. Capacity
 * is 15 x Strength.
 */
export function planDnd5eEncumbrance(input: EncumbranceInput): EncumbrancePlan {
  requireNonNegativeInteger(input.carriedWeight, "carried weight");
  requireInteger(input.strengthScore, "strength score");
  if (input.strengthScore < 1 || input.strengthScore > 30) throw new RangeError("strength score must be between 1 and 30");
  const heavily = input.carriedWeight > input.strengthScore * 10;
  const encumbered = input.carriedWeight > input.strengthScore * 5;
  return Object.freeze({
    tier: heavily ? "heavily-encumbered" : encumbered ? "encumbered" : "unencumbered",
    carryingCapacity: input.strengthScore * 15,
    speedReduction: heavily ? 20 : encumbered ? 10 : 0,
    checkPenaltyDisadvantage: heavily,
  });
}

export function planDnd5eMovement(input: MovementInput): MovementPlan {
  requireNonNegativeInteger(input.distance, "distance");
  requireNonNegativeInteger(input.speed, "speed");
  const mode = input.mode ?? "walk";
  const specialSpeed = input.specialSpeed;
  if (specialSpeed !== undefined) requireNonNegativeInteger(specialSpeed, "special speed");
  const extraCost = input.difficultTerrain ? 1 : 0;
  const modeCost = mode === "walk" || specialSpeed !== undefined ? 1 : 2;
  const cost = input.distance * (modeCost + extraCost);
  const budget = (specialSpeed ?? input.speed) * (input.dash ? 2 : 1);
  const reasons = cost > budget ? ["movement cost exceeds available speed"] : [];
  return Object.freeze({ distance: input.distance, cost, budget, remaining: Math.max(0, budget - cost), legal: reasons.length === 0, reasons: frozenList(reasons) });
}
