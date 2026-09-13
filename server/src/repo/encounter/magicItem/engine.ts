import { attuneItem, dropAttunement, type AttuneItemInput, type DropAttunementInput, type MagicAttunementResult } from "./attunement.js";
import { rechargeCharges, rollChargeRecharge, spendCharges, type MagicChargeResult, type MagicChargeTrigger } from "./charges.js";
import { planDerivedValues, type MagicDerivedValuesPlan, type PlanDerivedValuesInput } from "./passiveModifiers.js";
import { planGrantedPowers, type MagicGrantedPowerPlan, type PlanGrantedPowersInput } from "./grantedSpells.js";
import type { MagicChargeRecharge, MagicChargeState, MagicItemDice } from "./types.js";

/**
 * Single deterministic entry point. Every capability is a pure plan or
 * operation; the entry point only dispatches and returns a frozen receipt.
 * Random recharge draws exclusively through the injected dice seam.
 */

export type MagicItemAction = Readonly<
  | { kind: "attune"; input: AttuneItemInput }
  | { kind: "drop-attunement"; input: DropAttunementInput }
  | { kind: "spend-charges"; state: MagicChargeState; amount: number; occurredAt: string }
  | { kind: "recharge-charges"; state: MagicChargeState; recharge: MagicChargeRecharge; trigger: MagicChargeTrigger; occurredAt: string }
  | { kind: "roll-charge-recharge"; state: MagicChargeState; recharge: MagicChargeRecharge; occurredAt: string }
  | { kind: "plan-derived-values"; input: PlanDerivedValuesInput }
  | { kind: "plan-granted-powers"; input: PlanGrantedPowersInput }
>;

export type MagicItemActionOutcome = Readonly<
  | { kind: "attunement"; result: MagicAttunementResult }
  | { kind: "charges"; result: MagicChargeResult }
  | { kind: "derived-values"; plan: MagicDerivedValuesPlan }
  | { kind: "granted-powers"; plans: readonly MagicGrantedPowerPlan[] }
>;

export function evaluateMagicItemAction(dice: MagicItemDice, action: MagicItemAction): MagicItemActionOutcome {
  switch (action.kind) {
    case "attune":
      return Object.freeze({ kind: "attunement", result: attuneItem(action.input) });
    case "drop-attunement":
      return Object.freeze({ kind: "attunement", result: dropAttunement(action.input) });
    case "spend-charges":
      return Object.freeze({ kind: "charges", result: spendCharges(action.state, action.amount, action.occurredAt) });
    case "recharge-charges":
      return Object.freeze({ kind: "charges", result: rechargeCharges(action.state, action.recharge, action.trigger, action.occurredAt) });
    case "roll-charge-recharge":
      return Object.freeze({ kind: "charges", result: rollChargeRecharge(action.state, action.recharge, dice, action.occurredAt) });
    case "plan-derived-values":
      return Object.freeze({ kind: "derived-values", plan: planDerivedValues(action.input) });
    case "plan-granted-powers":
      return Object.freeze({ kind: "granted-powers", plans: planGrantedPowers(action.input) });
  }
}
