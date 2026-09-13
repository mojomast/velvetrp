import { isAttuned } from "./attunement.js";
import type { MagicAttunementState, MagicGrantedPower, MagicItemDefinition, MagicPowerReference } from "./types.js";

/**
 * Granted-power planning. Resolving an item's granted power emits a bounded
 * plan that references the underlying catalog power. It never executes the
 * power, rolls dice, or touches persistence.
 */

export type MagicGrantedPowerPlan = Readonly<{
  kind: "granted-power";
  sourceItemKey: string;
  powerKey: string;
  power: MagicPowerReference;
  actionCost: "action" | "bonus-action" | "reaction";
  /** Charge cost the caller must settle before executing the referenced power. */
  chargeCost: number;
  /** Explicit marker that this is planning data, not an execution. */
  executed: false;
}>;

export type MagicEquippedPowerItem = Readonly<{
  key: string;
  definition: MagicItemDefinition;
  equipped: boolean;
}>;

export type PlanGrantedPowersInput = Readonly<{
  items: readonly MagicEquippedPowerItem[];
  attunement: MagicAttunementState;
}>;

/** True when a granted power is available from an equipped (and attuned) item. */
export function grantedPowerActive(item: MagicEquippedPowerItem, granted: MagicGrantedPower, attunement: MagicAttunementState): boolean {
  return item.equipped && (!granted.requireAttunement || isAttuned(attunement, item.key));
}

/** Resolves one granted power to a bounded plan, or null when unavailable. */
export function resolveGrantedPower(item: MagicEquippedPowerItem, granted: MagicGrantedPower, attunement: MagicAttunementState): MagicGrantedPowerPlan | null {
  if (!grantedPowerActive(item, granted, attunement)) return null;
  return Object.freeze({
    kind: "granted-power",
    sourceItemKey: item.key,
    powerKey: granted.key,
    power: Object.freeze({ ...granted.power }),
    actionCost: granted.actionCost,
    chargeCost: granted.cost,
    executed: false,
  });
}

/** Plans every granted power currently available across the carried items. */
export function planGrantedPowers(input: PlanGrantedPowersInput): readonly MagicGrantedPowerPlan[] {
  const plans: MagicGrantedPowerPlan[] = [];
  for (const item of input.items) {
    for (const granted of item.definition.grantedPowers) {
      const plan = resolveGrantedPower(item, granted, input.attunement);
      if (plan) plans.push(plan);
    }
  }
  return Object.freeze(plans);
}
