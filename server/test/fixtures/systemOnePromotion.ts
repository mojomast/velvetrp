import { afterEach } from "vitest";
import { systemOneEvaluationBinding } from "../../src/agent/systemOneBinding.js";
import { SYSTEM_ONE_PROMOTION_RECORDS } from "../../src/agent/systemOnePromotion.js";
import type { SystemOneSettings } from "../../src/types.js";

const originals = { ...SYSTEM_ONE_PROMOTION_RECORDS };
afterEach(() => { Object.assign(SYSTEM_ONE_PROMOTION_RECORDS, originals); });

/** Synthetic authority ONLY for execution-path tests, never production evaluation evidence. */
export function approveTestSystemOne(settings: SystemOneSettings,
  lane: "speaker-routing" | "adventure-selection", families: string[]): void {
  const original = originals[lane]!;
  SYSTEM_ONE_PROMOTION_RECORDS[lane] = { ...original, evaluatedBindings: families.map(family =>
    systemOneEvaluationBinding(lane, settings, settings.model, family)) };
}
