import type { LegalActionPlan } from "../types.js";
import { frozenList } from "./internal.js";

export function planDnd5eAction<TKind extends string, TResult>(kind: TKind, reasons: readonly string[], result: TResult): LegalActionPlan<TKind, TResult> {
  const legal = reasons.length === 0;
  return Object.freeze({ kind, legal, reasons: frozenList(reasons), result: legal ? result : null });
}
