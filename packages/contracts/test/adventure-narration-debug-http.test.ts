// Approved tests: persist holdReason / gateRule / narrationOutcome / repairAttempted on the
// public turn narration status so playtests can split narration_fail_rate from false_hold_rate.
import { describe, expect, it } from "vitest";
import { adventureTurnHttpNarrationStatusSchema } from "../src/adventure-turns-http.js";

const core = {
  status: "completed" as const,
  text: "You stay where you are; nothing has changed yet.",
  source: "deterministic-fallback" as const,
};

const outcomes = [
  "provider-accepted",
  "repair-accepted",
  "gate-rejected",
  "repair-skipped",
  "parse-failed",
  "provider-error",
  "hold-skipped-provider",
  "budget",
  "disconnected",
] as const;

const holdReasons = [
  "location-mismatch",
  "already-at-location",
  "pending-compound-step",
  "no-advertised-match",
  "unknown-person",
] as const;

describe("adventure turn narration debug fields", () => {
  it("still accepts today's status/text/source payload with the new fields omitted", () => {
    expect(adventureTurnHttpNarrationStatusSchema.parse(core)).toEqual(core);
  });

  it("accepts holdReason, gateRule, narrationOutcome, and repairAttempted", () => {
    const parsed = adventureTurnHttpNarrationStatusSchema.parse({
      ...core,
      holdReason: "location-mismatch",
      gateRule: "unsupported-travel",
      narrationOutcome: "hold-skipped-provider",
      repairAttempted: false,
    });
    expect(parsed.holdReason).toBe("location-mismatch");
    expect(parsed.gateRule).toBe("unsupported-travel");
    expect(parsed.narrationOutcome).toBe("hold-skipped-provider");
    expect(parsed.repairAttempted).toBe(false);
  });

  it("accepts every documented narrationOutcome and holdReason and rejects unknown keys or outcomes", () => {
    for (const narrationOutcome of outcomes) {
      expect(
        adventureTurnHttpNarrationStatusSchema.parse({ ...core, narrationOutcome, repairAttempted: true })
          .narrationOutcome,
      ).toBe(narrationOutcome);
    }
    for (const holdReason of holdReasons) {
      expect(adventureTurnHttpNarrationStatusSchema.parse({ ...core, holdReason }).holdReason).toBe(holdReason);
    }
    expect(() => adventureTurnHttpNarrationStatusSchema.parse({ ...core, narrationOutcome: "skipped" })).toThrow();
    expect(() => adventureTurnHttpNarrationStatusSchema.parse({ ...core, extra: true })).toThrow();
  });
});
