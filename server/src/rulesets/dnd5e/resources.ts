import type {
  ResourceCost, ResourceCostPlan, ResourcePool, SpellCostInput, SpellCostPlan,
} from "../types.js";
import { frozenList, requireNonNegativeInteger } from "./internal.js";

export function planDnd5eResourceCosts(pools: readonly ResourcePool[], costs: readonly ResourceCost[]): ResourceCostPlan {
  const reasons: string[] = [];
  const amounts = new Map<string, number>();
  const poolIds = new Set<string>();
  pools.forEach((pool) => {
    if (poolIds.has(pool.id)) reasons.push(`duplicate resource pool: ${pool.id}`);
    poolIds.add(pool.id);
    requireNonNegativeInteger(pool.current, `${pool.id} current`);
    requireNonNegativeInteger(pool.maximum, `${pool.id} maximum`);
    if (pool.current > pool.maximum) reasons.push(`${pool.id} current exceeds maximum`);
  });
  costs.forEach((cost) => {
    requireNonNegativeInteger(cost.amount, `${cost.resourceId} cost`);
    amounts.set(cost.resourceId, (amounts.get(cost.resourceId) ?? 0) + cost.amount);
  });
  amounts.forEach((amount, id) => {
    const pool = pools.find((candidate) => candidate.id === id);
    if (pool === undefined) reasons.push(`missing resource pool: ${id}`);
    else if (amount > pool.current) reasons.push(`insufficient resource: ${id}`);
  });
  const legal = reasons.length === 0;
  const resultingPools = pools.map((pool) => Object.freeze({ ...pool, current: legal ? pool.current - (amounts.get(pool.id) ?? 0) : pool.current }));
  return Object.freeze({ legal, costs: frozenList(costs.map((cost) => Object.freeze({ ...cost }))), resultingPools: frozenList(resultingPools), reasons: frozenList(reasons) });
}

export function planDnd5eSpellCost(input: SpellCostInput): SpellCostPlan {
  requireNonNegativeInteger(input.spellLevel, "spell level");
  requireNonNegativeInteger(input.slotLevel, "slot level");
  const reasons: string[] = [];
  if (input.spellLevel > 9 || input.slotLevel > 9) reasons.push("spell and slot levels must not exceed 9");
  if (input.spellLevel > 0 && input.slotLevel < input.spellLevel) reasons.push("slot level is below spell level");
  if (input.spellLevel > 0 && (input.slots[input.slotLevel] ?? 0) < 1) reasons.push("no spell slot is available at that level");
  if (input.consumesMaterial && !input.materialAvailable) reasons.push("consumed material is unavailable");
  const legal = reasons.length === 0;
  const resultingSlots = { ...input.slots };
  if (legal && input.spellLevel > 0) resultingSlots[input.slotLevel] = resultingSlots[input.slotLevel]! - 1;
  return Object.freeze({ legal, slotLevel: input.slotLevel, resultingSlots: Object.freeze(resultingSlots), consumesMaterial: legal && (input.consumesMaterial ?? false), reasons: frozenList(reasons) });
}
