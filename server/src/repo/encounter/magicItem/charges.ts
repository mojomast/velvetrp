import type { MagicChargeEvent, MagicChargeRecharge, MagicChargeState, MagicItemDice } from "./types.js";
import { requireNonNegativeInteger, requirePositiveInteger } from "./internal.js";

/**
 * Bounded charge engine. Spending rejects any over-spend; restoring is capped
 * at the maximum and is a no-op when the recharge trigger does not fire.
 * Random recharge is resolved from dice supplied by the caller.
 */

export type MagicChargeTrigger = Readonly<
  | { kind: "event"; event: MagicChargeEvent }
  | { kind: "roll"; roll: number }
>;

export type MagicChargeReceipt = Readonly<{
  kind: "charges";
  operation: "spend" | "restore";
  itemKey: string;
  requested: number;
  applied: number;
  before: number;
  after: number;
  reason: string;
  occurredAt: string;
}>;

export type MagicChargeResult = Readonly<
  | { ok: true; state: MagicChargeState; receipt: MagicChargeReceipt }
  | {
    ok: false;
    code: "out-of-range" | "over-spend" | "incompatible-trigger";
    message: string;
    state: MagicChargeState;
    receipt: MagicChargeReceipt;
  }
>;

function receipt(values: {
  operation: "spend" | "restore";
  state: MagicChargeState;
  requested: number;
  applied: number;
  after: number;
  reason: string;
  occurredAt: string;
}): MagicChargeReceipt {
  return Object.freeze({
    kind: "charges",
    operation: values.operation,
    itemKey: values.state.itemKey,
    requested: values.requested,
    applied: values.applied,
    before: values.state.current,
    after: values.after,
    reason: values.reason,
    occurredAt: values.occurredAt,
  });
}

export function createChargeState(itemKey: string, maximum: number): MagicChargeState {
  requireNonNegativeInteger(maximum, "charge maximum");
  return Object.freeze({ itemKey, current: maximum, maximum });
}

function chargeState(current: number, maximum: number, itemKey: string): MagicChargeState {
  return Object.freeze({ itemKey, current, maximum });
}

/** Spends charges, rejecting any amount that would exceed the current pool. */
export function spendCharges(state: MagicChargeState, amount: number, occurredAt: string): MagicChargeResult {
  if (!Number.isInteger(amount) || amount < 1) {
    const failed = receipt({ operation: "spend", state, requested: amount, applied: 0, after: state.current, reason: "amount must be a positive integer", occurredAt });
    return Object.freeze({ ok: false, code: "out-of-range", message: "charge spend must be a positive integer", state, receipt: failed });
  }
  if (amount > state.current) {
    const failed = receipt({ operation: "spend", state, requested: amount, applied: 0, after: state.current, reason: "insufficient charges", occurredAt });
    return Object.freeze({ ok: false, code: "over-spend", message: "charge spend exceeds the current pool", state, receipt: failed });
  }
  const after = state.current - amount;
  const next = chargeState(after, state.maximum, state.itemKey);
  return Object.freeze({ ok: true, state: next,
    receipt: receipt({ operation: "spend", state, requested: amount, applied: amount, after, reason: "spent", occurredAt }) });
}

function restore(state: MagicChargeState, amount: number, reason: string, occurredAt: string): MagicChargeResult {
  requireNonNegativeInteger(amount, "charge restore amount");
  const after = Math.min(state.maximum, state.current + amount);
  const applied = after - state.current;
  const next = chargeState(after, state.maximum, state.itemKey);
  return Object.freeze({ ok: true, state: next,
    receipt: receipt({ operation: "restore", state, requested: amount, applied, after, reason, occurredAt }) });
}

/** Resolves a recharge plan against an explicit event or roll trigger. */
export function rechargeCharges(state: MagicChargeState, recharge: MagicChargeRecharge, trigger: MagicChargeTrigger, occurredAt: string): MagicChargeResult {
  if (recharge.kind === "none") return restore(state, 0, "no-recharge", occurredAt);
  if (recharge.kind === "event") {
    if (trigger.kind !== "event") {
      const failed = receipt({ operation: "restore", state, requested: recharge.amount, applied: 0, after: state.current, reason: "event recharge needs an event trigger", occurredAt });
      return Object.freeze({ ok: false, code: "incompatible-trigger", message: "event recharge requires an event trigger", state, receipt: failed });
    }
    if (trigger.event !== recharge.event) return restore(state, 0, "event-mismatch", occurredAt);
    return restore(state, recharge.amount, `recharged-on:${recharge.event}`, occurredAt);
  }
  requirePositiveInteger(recharge.dieSides, "recharge die sides");
  requirePositiveInteger(recharge.minimum, "recharge minimum");
  if (recharge.minimum > recharge.dieSides) throw new RangeError("recharge minimum cannot exceed the die sides");
  if (trigger.kind !== "roll") {
    const failed = receipt({ operation: "restore", state, requested: recharge.amount, applied: 0, after: state.current, reason: "roll recharge needs a roll trigger", occurredAt });
    return Object.freeze({ ok: false, code: "incompatible-trigger", message: "roll recharge requires a roll trigger", state, receipt: failed });
  }
  requirePositiveInteger(trigger.roll, "recharge roll");
  if (trigger.roll > recharge.dieSides) {
    const failed = receipt({ operation: "restore", state, requested: recharge.amount, applied: 0, after: state.current, reason: "recharge roll is outside the die", occurredAt });
    return Object.freeze({ ok: false, code: "out-of-range", message: "recharge roll must be inside the die range", state, receipt: failed });
  }
  if (trigger.roll < recharge.minimum) return restore(state, 0, `roll-missed:${trigger.roll}`, occurredAt);
  return restore(state, recharge.amount, `recharged-on-roll:${trigger.roll}`, occurredAt);
}

/** Draws a recharge die through the injected dice and resolves the recharge. */
export function rollChargeRecharge(state: MagicChargeState, recharge: MagicChargeRecharge, dice: MagicItemDice, occurredAt: string): MagicChargeResult {
  // A no-recharge plan stays a no-op; any other non-roll plan is rejected as an
  // incompatible trigger by `rechargeCharges` rather than silently drawing.
  if (recharge.kind !== "roll") return rechargeCharges(state, recharge, { kind: "roll", roll: 1 }, occurredAt);
  const roll = dice.integer(1, recharge.dieSides + 1);
  if (!Number.isInteger(roll) || roll < 1 || roll > recharge.dieSides) throw new Error("magic item recharge dice returned an out-of-range die");
  return rechargeCharges(state, recharge, { kind: "roll", roll }, occurredAt);
}
