import { describe, expect, it } from "vitest";
import {
  aggregateThresholdSamples,
  selectActionThreshold,
  type ThresholdSample,
} from "../src/agent/systemOneThreshold.js";

function sample(threshold: number, acted: boolean, correct: boolean, predictedProbability = 0.5): ThresholdSample {
  return { threshold, acted, correct, predictedProbability };
}

const mixed: ThresholdSample[] = [
  // 0.5: 5 samples, 4 acted, all 4 correct -> coverage 0.8, accuracy 1
  sample(0.5, true, true),
  sample(0.5, true, true),
  sample(0.5, true, true),
  sample(0.5, true, true),
  sample(0.5, false, false),
  // 0.7: 4 samples, 2 acted, 1 correct -> coverage 0.5, accuracy 0.5
  sample(0.7, true, true),
  sample(0.7, true, false),
  sample(0.7, false, true),
  sample(0.7, false, true),
  // 0.3: 3 samples, 3 acted, all correct -> coverage 1, accuracy 1
  sample(0.3, true, true),
  sample(0.3, true, true),
  sample(0.3, true, true),
];

describe("aggregateThresholdSamples", () => {
  it("groups by threshold, orders ascending, and computes coverage and acted accuracy", () => {
    expect(aggregateThresholdSamples(mixed)).toEqual([
      { threshold: 0.3, acted: 3, total: 3, coverage: 1, actedAccuracy: 1 },
      { threshold: 0.5, acted: 4, total: 5, coverage: 0.8, actedAccuracy: 1 },
      { threshold: 0.7, acted: 2, total: 4, coverage: 0.5, actedAccuracy: 0.5 },
    ]);
  });

  it("ignores `correct` for samples that did not act", () => {
    const points = aggregateThresholdSamples([
      sample(0.4, true, false),
      sample(0.4, false, true),
      sample(0.4, false, true),
    ]);
    expect(points[0]).toEqual({ threshold: 0.4, acted: 1, total: 3, coverage: 1 / 3, actedAccuracy: 0 });
  });

  it("fixes the output set and order to the provided thresholds, zeroing missing groups", () => {
    expect(aggregateThresholdSamples(mixed, [0.1, 0.5, 0.9])).toEqual([
      { threshold: 0.1, acted: 0, total: 0, coverage: 0, actedAccuracy: 0 },
      { threshold: 0.5, acted: 4, total: 5, coverage: 0.8, actedAccuracy: 1 },
      { threshold: 0.9, acted: 0, total: 0, coverage: 0, actedAccuracy: 0 },
    ]);
  });

  it("returns no points for no samples", () => {
    expect(aggregateThresholdSamples([])).toEqual([]);
  });

  it("rejects non-finite sample thresholds", () => {
    expect(() => aggregateThresholdSamples([sample(Number.NaN, true, true)])).toThrow(RangeError);
    expect(() => aggregateThresholdSamples([sample(Number.POSITIVE_INFINITY, true, true)])).toThrow(RangeError);
  });

  it("rejects non-finite or out-of-range predictedProbability", () => {
    expect(() => aggregateThresholdSamples([sample(0.5, true, true, 1.01)])).toThrow(RangeError);
    expect(() => aggregateThresholdSamples([sample(0.5, true, true, -0.01)])).toThrow(RangeError);
    expect(() => aggregateThresholdSamples([sample(0.5, true, true, Number.NaN)])).toThrow(RangeError);
  });

  it("rejects duplicate or non-finite thresholds in the argument", () => {
    expect(() => aggregateThresholdSamples(mixed, [0.5, 0.5])).toThrow(RangeError);
    expect(() => aggregateThresholdSamples(mixed, [0.5, Number.NaN])).toThrow(RangeError);
  });
});

describe("selectActionThreshold", () => {
  it("selects the greatest-coverage qualifying point", () => {
    const selection = selectActionThreshold(mixed, { minActed: 2, minAccuracy: 0.9 });
    expect(selection.selected).toEqual({
      threshold: 0.3,
      acted: 3,
      total: 3,
      coverage: 1,
      actedAccuracy: 1,
    });
    expect(selection.points).toHaveLength(3);
  });

  it("breaks coverage ties toward the higher threshold", () => {
    const tied: ThresholdSample[] = [
      sample(0.2, true, true),
      sample(0.2, true, true),
      sample(0.2, true, true),
      sample(0.2, true, true),
      sample(0.2, false, false),
      sample(0.8, true, true),
      sample(0.8, true, true),
      sample(0.8, true, true),
      sample(0.8, true, true),
      sample(0.8, false, false),
    ];
    const selection = selectActionThreshold(tied, { minActed: 4, minAccuracy: 0.9 });
    expect(selection.points.map((point) => point.coverage)).toEqual([0.8, 0.8]);
    expect(selection.selected?.threshold).toBe(0.8);
  });

  it("prefers the highest threshold that still reaches targetCoverage", () => {
    const samples: ThresholdSample[] = [
      ...Array.from({ length: 9 }, () => sample(0.2, true, true)),
      sample(0.2, false, false),
      ...Array.from({ length: 8 }, () => sample(0.6, true, true)),
      sample(0.6, false, false),
      sample(0.6, false, false),
      ...Array.from({ length: 5 }, () => sample(0.9, true, true)),
      ...Array.from({ length: 5 }, () => sample(0.9, false, false)),
    ];
    const selection = selectActionThreshold(samples, { minActed: 5, minAccuracy: 0.9, targetCoverage: 0.8 });
    expect(selection.selected?.threshold).toBe(0.6);
    expect(selection.reasons.join(" ")).toContain("coverage >= 0.8");
  });

  it("falls back to the greatest-coverage point when targetCoverage is unreachable", () => {
    const samples: ThresholdSample[] = [
      ...Array.from({ length: 9 }, () => sample(0.2, true, true)),
      sample(0.2, false, false),
      ...Array.from({ length: 8 }, () => sample(0.6, true, true)),
      sample(0.6, false, false),
      sample(0.6, false, false),
    ];
    const selection = selectActionThreshold(samples, { minActed: 5, minAccuracy: 0.9, targetCoverage: 0.95 });
    expect(selection.selected?.threshold).toBe(0.2);
    expect(selection.reasons.join(" ")).toContain("fell back");
  });

  it("returns null with explanatory reasons when nothing qualifies", () => {
    const selection = selectActionThreshold(mixed, { minActed: 100, minAccuracy: 0.9 });
    expect(selection.selected).toBeNull();
    expect(selection.reasons.join(" ")).toContain("no threshold reached actedAccuracy >= 0.9 with at least 100 acted decisions");
  });

  it("explains which floors filtered points", () => {
    const selection = selectActionThreshold(mixed, { minActed: 4, minAccuracy: 0.9 });
    expect(selection.selected?.threshold).toBe(0.5);
    expect(selection.reasons.join(" ")).toContain("filtered");
    expect(selection.reasons.join(" ")).toContain("actedAccuracy >= 0.9");
  });

  it("returns null for no samples", () => {
    expect(selectActionThreshold([]).selected).toBeNull();
  });

  it("validates options", () => {
    expect(() => selectActionThreshold(mixed, { minAccuracy: 1.2 })).toThrow(RangeError);
    expect(() => selectActionThreshold(mixed, { minAccuracy: Number.NaN })).toThrow(RangeError);
    expect(() => selectActionThreshold(mixed, { minActed: -1 })).toThrow(RangeError);
    expect(() => selectActionThreshold(mixed, { minActed: 1.5 })).toThrow(RangeError);
    expect(() => selectActionThreshold(mixed, { targetCoverage: 2 })).toThrow(RangeError);
    expect(() => selectActionThreshold(mixed, { targetCoverage: Number.NaN })).toThrow(RangeError);
  });

  it("is deterministic for the same input", () => {
    const options = { minActed: 2, minAccuracy: 0.9, targetCoverage: 0.5 } as const;
    expect(selectActionThreshold(mixed, options)).toEqual(selectActionThreshold(mixed, options));
  });
});
