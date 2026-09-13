import type { LegalActionPlan, RulesetCapability } from "../types.js";
import { frozenList } from "./internal.js";

export const DND_5E_PLAN_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "legal-action-plans", version: "1.0.0", status: "supported" as const }),
]);

export function planDnd5eAction<TKind extends string, TResult>(kind: TKind, reasons: readonly string[], result: TResult): LegalActionPlan<TKind, TResult> {
  const legal = reasons.length === 0;
  return Object.freeze({ kind, legal, reasons: frozenList(reasons), result: legal ? result : null });
}
