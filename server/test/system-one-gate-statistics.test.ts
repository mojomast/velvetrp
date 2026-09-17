import { describe, expect, it, vi } from "vitest";
import {
  bootstrapAccuracyLowerBound,
  wilsonLowerBound,
} from "../src/agent/systemOneGateStatistics.js";

/** A 30-sample mixture with point accuracy 25/30 ≈ 0.8333 and a wide but not degenerate spread. */
const mixedOutcomes: readonly boolean[] = [
  true, true, true, true, true, true, true, false, true, false,
  true, true, true, true, false, true, true, true, true, true,
  false, true, true, true, false, true, true, true, true, true,
];

describe("wilsonLowerBound", () => {
  it("places the 100/100 lower bound well below 1 and the 9/10 bound near 0.60", () => {
    expect(wilsonLowerBound(100, 100)).toBeCloseTo(0.963, 3);
    expect(wilsonLowerBound(100, 100)).toBeLessThan(1);
    expect(wilsonLowerBound(9, 10)).toBeCloseTo(0.5958, 3);
    expect(wilsonLowerBound(9, 10)).toBeGreaterThan(0.59);
    expect(wilsonLowerBound(9, 10)).toBeLessThan(0.60);
  });

  it("returns the point estimate's lower bound for a perfect 30/30 record", () => {
    expect(wilsonLowerBound(30, 30)).toBeCloseTo(0.8865, 3);
    expect(wilsonLowerBound(27, 30)).toBeCloseTo(0.7438, 3);
  });

  it("returns 0 for zero successes and stays within [0, 1]", () => {
    expect(wilsonLowerBound(0, 30)).toBe(0);
    expect(wilsonLowerBound(0, 1)).toBe(0);
    for (const [successes, samples] of [
      [1, 1],
      [1, 3],
      [2, 3],
      [17, 20],
      [99, 100],
    ] as const) {
      const bound = wilsonLowerBound(successes, samples);
      expect(bound).toBeGreaterThanOrEqual(0);
      expect(bound).toBeLessThanOrEqual(1);
      expect(bound).toBeLessThanOrEqual(successes / samples);
    }
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.2065, 3);
  });

  it("gets more conservative as z grows", () => {
    const ninetyFive = wilsonLowerBound(9, 10, 1.959963984540054);
    const ninetyNine = wilsonLowerBound(9, 10, 2.5758293035489004);
    expect(ninetyNine).toBeLessThan(ninetyFive);
    expect(ninetyNine).toBeCloseTo(0.4928, 3);
  });

  it("throws RangeError for invalid inputs", () => {
    expect(() => wilsonLowerBound(-1, 10)).toThrow(RangeError);
    expect(() => wilsonLowerBound(11, 10)).toThrow(RangeError);
    expect(() => wilsonLowerBound(Number.NaN, 10)).toThrow(RangeError);
    expect(() => wilsonLowerBound(5, 0)).toThrow(RangeError);
    expect(() => wilsonLowerBound(5, -1)).toThrow(RangeError);
    expect(() => wilsonLowerBound(5, Number.NaN)).toThrow(RangeError);
    expect(() => wilsonLowerBound(5, 10, 0)).toThrow(RangeError);
    expect(() => wilsonLowerBound(5, 10, -1.96)).toThrow(RangeError);
    expect(() => wilsonLowerBound(5, 10, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("bootstrapAccuracyLowerBound", () => {
  it("is deterministic for a fixed seed and uses no Math.random", () => {
    const randomSpy = vi.spyOn(Math, "random");
    const first = bootstrapAccuracyLowerBound(mixedOutcomes, { seed: 1 });
    const second = bootstrapAccuracyLowerBound(mixedOutcomes, { seed: 1 });
    expect(second).toBe(first);
    expect(first).toBeCloseTo(0.7333, 3);
    expect(randomSpy).not.toHaveBeenCalled();
    randomSpy.mockRestore();
  });

  it("reproduces the default seed and changes the bound with a different seed", () => {
    expect(bootstrapAccuracyLowerBound(mixedOutcomes)).toBe(bootstrapAccuracyLowerBound(mixedOutcomes));
    expect(bootstrapAccuracyLowerBound(mixedOutcomes)).toBeCloseTo(0.7, 3);
    expect(bootstrapAccuracyLowerBound(mixedOutcomes, { seed: 1 })).not.toBe(
      bootstrapAccuracyLowerBound(mixedOutcomes, { seed: 2 }),
    );
  });

  it("returns a lower bound at or below the point estimate", () => {
    for (const outcomes of [
      mixedOutcomes,
      [true, false],
      [true, true, false],
      [false, false, true, true, true],
      Array.from({ length: 37 }, (_, index) => (index * 7) % 11 !== 0),
    ] as const) {
      const point = outcomes.filter(Boolean).length / outcomes.length;
      const bound = bootstrapAccuracyLowerBound(outcomes, { iterations: 500, seed: 7 });
      expect(bound).toBeGreaterThanOrEqual(0);
      expect(bound).toBeLessThanOrEqual(1);
      expect(bound).toBeLessThanOrEqual(point);
    }
  });

  it("is lower at higher confidence", () => {
    const ninety = bootstrapAccuracyLowerBound(mixedOutcomes, { confidence: 0.9 });
    const ninetyFive = bootstrapAccuracyLowerBound(mixedOutcomes, { confidence: 0.95 });
    expect(ninety).toBeGreaterThan(ninetyFive);
  });

  it("handles all-true, all-false, single, and tiny samples", () => {
    expect(bootstrapAccuracyLowerBound([true, true, true, true, true])).toBe(1);
    expect(bootstrapAccuracyLowerBound([true])).toBe(1);
    expect(bootstrapAccuracyLowerBound([false, false, false, false, false])).toBe(0);
    expect(bootstrapAccuracyLowerBound([false])).toBe(0);
    expect(bootstrapAccuracyLowerBound([true, false])).toBeGreaterThanOrEqual(0);
    expect(bootstrapAccuracyLowerBound([true, false])).toBeLessThanOrEqual(0.5);
  });

  it("throws RangeError for invalid inputs", () => {
    expect(() => bootstrapAccuracyLowerBound([])).toThrow(RangeError);
    expect(() => bootstrapAccuracyLowerBound(mixedOutcomes, { iterations: 0 })).toThrow(RangeError);
    expect(() => bootstrapAccuracyLowerBound(mixedOutcomes, { iterations: -1 })).toThrow(RangeError);
    expect(() => bootstrapAccuracyLowerBound(mixedOutcomes, { iterations: 1.5 })).toThrow(RangeError);
    expect(() => bootstrapAccuracyLowerBound(mixedOutcomes, { iterations: Number.NaN })).toThrow(RangeError);
    expect(() => bootstrapAccuracyLowerBound(mixedOutcomes, { confidence: 0 })).toThrow(RangeError);
    expect(() => bootstrapAccuracyLowerBound(mixedOutcomes, { confidence: 1 })).toThrow(RangeError);
    expect(() => bootstrapAccuracyLowerBound(mixedOutcomes, { confidence: -0.1 })).toThrow(RangeError);
    expect(() => bootstrapAccuracyLowerBound(mixedOutcomes, { confidence: Number.NaN })).toThrow(RangeError);
    expect(() => bootstrapAccuracyLowerBound(mixedOutcomes, { seed: Number.NaN })).toThrow(RangeError);
    expect(() => bootstrapAccuracyLowerBound(mixedOutcomes, { seed: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
