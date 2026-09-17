import { describe, expect, it } from "vitest";
import { stabilityUid, summarizeStability, type StabilitySample } from "../src/agent/systemOneStability.js";

const sample = (caseId: string, decision: string, signal: number | null): StabilitySample => ({ caseId, decision, signal });

describe("summarizeStability", () => {
  it("reports agreement, conflicts, and signal variance per case", () => {
    const summary = summarizeStability([
      sample("a", "pick-1", 0.9),
      sample("a", "pick-1", 0.8),
      sample("a", "pick-2", 0.7),
      sample("b", "defer", null),
      sample("b", "defer", null),
      sample("b", "defer", null),
    ]);
    expect(summary.cases).toHaveLength(2);
    expect(summary.repeats).toBe(6);
    const a = summary.cases[0]!;
    expect(a.repeats).toBe(3);
    expect(a.agreement).toBeCloseTo(2 / 3, 10);
    expect(a.decisions).toEqual(["pick-1", "pick-2"]);
    expect(a.conflicted).toBe(true);
    expect(a.meanSignal).toBeCloseTo(0.8, 10);
    expect(a.signalStdDev).toBeCloseTo(Math.sqrt((0.1 ** 2 + 0 ** 2 + 0.1 ** 2) / 3), 10);

    const b = summary.cases[1]!;
    expect(b.agreement).toBe(1);
    expect(b.conflicted).toBe(false);
    expect(b.meanSignal).toBeNull();
    expect(summary.meanAgreement).toBeCloseTo((2 / 3 + 1) / 2, 10);
    expect(summary.conflictCases).toBe(1);
    expect(summary.conflictRate).toBeCloseTo(0.5, 10);
    expect(summary.meanSignalStdDev).toBeCloseTo(Math.sqrt(0.02 / 3), 10);
    expect(summary.maxSignalStdDev).toBeCloseTo(Math.sqrt(0.02 / 3), 10);
  });

  it("ignores non-finite signals and handles empty input", () => {
    const summary = summarizeStability([sample("a", "x", Number.NaN), sample("a", "x", Number.POSITIVE_INFINITY)]);
    expect(summary.cases[0]!.meanSignal).toBeNull();
    expect(summary.cases[0]!.signalStdDev).toBeNull();
    expect(summary.meanSignalStdDev).toBeNull();
    expect(summarizeStability([])).toEqual({
      cases: [], repeats: 0, meanAgreement: 0, conflictCases: 0, conflictRate: 0, meanSignalStdDev: null, maxSignalStdDev: null,
    });
  });

  it("derives a deterministic per-repeat decorrelator", () => {
    expect(stabilityUid("guardrails", "case-1", 2)).toBe("guardrails:case-1:2");
    expect(stabilityUid("guardrails", "case-1", -1)).toBe("guardrails:case-1:0");
    expect(stabilityUid("guardrails", "case-1", 2.9)).toBe("guardrails:case-1:2");
  });
});
