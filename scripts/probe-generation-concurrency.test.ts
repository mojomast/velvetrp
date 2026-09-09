import { describe, expect, it } from "vitest";
import {
  buildObservedRecommendation,
  summarizeProbeResults,
  type ProbeResult,
} from "./probe-generation-concurrency.js";

function result(width: number, index: number, staged: boolean, adherent: boolean): ProbeResult {
  return {
    width,
    wave: Math.floor(index / width) + 1,
    slot: (index % width) + 1,
    artifactKey: `probe-w${width}-${index}`,
    idempotencyKey: `probe:w${width}:${index}`,
    stagingSucceeded: staged,
    instructionAdherent: staged ? adherent : null,
    providerFailed: !staged,
    uncertain: false,
    latencyMs: 100 + index,
    httpStatus: staged ? 201 : 503,
    recoveryState: staged ? "succeeded" : "failed",
    attempt: 1,
    reason: staged && !adherent ? "instruction ignored" : null,
  };
}

describe("generation concurrency probe metrics", () => {
  it("separates staging from adherence and labels the recommendation as observed", () => {
    const outcomes = [
      ...Array.from({ length: 2 }, (_, index) => result(1, index, true, false)),
      ...Array.from({ length: 4 }, (_, index) => result(2, index, true, index === 0)),
      ...Array.from({ length: 6 }, (_, index) => result(3, index, index !== 5, index === 0 || index === 2)),
      ...Array.from({ length: 8 }, (_, index) => result(4, index, true, index < 3)),
    ];

    const summary = summarizeProbeResults(outcomes, 2);
    expect(summary.map(({ width, stagingSucceeded, instructionAdherent, providerFailed, uncertain }) => ({
      width, stagingSucceeded, instructionAdherent, providerFailed, uncertain,
    }))).toEqual([
      { width: 1, stagingSucceeded: 2, instructionAdherent: 0, providerFailed: 0, uncertain: 0 },
      { width: 2, stagingSucceeded: 4, instructionAdherent: 1, providerFailed: 0, uncertain: 0 },
      { width: 3, stagingSucceeded: 5, instructionAdherent: 2, providerFailed: 1, uncertain: 0 },
      { width: 4, stagingSucceeded: 8, instructionAdherent: 3, providerFailed: 0, uncertain: 0 },
    ]);
    expect(summary[0]?.latencyMs.min).toBe(100);
    expect(summary[2]).toMatchObject({
      stagingSuccessRate: 5 / 6,
      instructionAdherenceRate: 2 / 6,
      instructionAdherenceAmongStagedRate: 2 / 5,
      observedPerfectStaging: false,
    });

    const recommendation = buildObservedRecommendation(summary);
    expect(recommendation).toMatchObject({
      largestObservedPerfectStagingWidth: 4,
      observedRecommendedWidth: 4,
      stagingSuccessRateAtWidth: 1,
      instructionAdherenceRateAtWidth: 3 / 8,
      instructionAdherenceAmongStagedRateAtWidth: 3 / 8,
    });
    expect(recommendation.label).toContain("insufficient to claim reliability");
  });
});
