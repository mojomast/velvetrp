import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brierScore, expectedCalibrationError, gradeCalibration } from "./dmGraders.js";
import type { DmCalibrationPoint, DmCalibrationReport } from "./dmEvalTypes.js";

interface CalibrationFixture {
  version: string;
  bins: number;
  points: DmCalibrationPoint[];
  expected: DmCalibrationReport;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/dm-evals/calibration.v1.json", import.meta.url)), "utf8"),
) as CalibrationFixture;

describe("probability-aware calibration grading", () => {
  it("returns zero brier and zero ECE for empty input", () => {
    expect(brierScore([])).toBe(0);
    expect(expectedCalibrationError([])).toBe(0);
    expect(gradeCalibration([])).toEqual({ count: 0, brier: 0, expectedCalibrationError: 0, bins: 10 });
  });

  it("scores perfect calibration and maximal miscalibration", () => {
    const calibrated: DmCalibrationPoint[] = [
      { predictedProbability: 0.5, correct: true },
      { predictedProbability: 0.5, correct: false },
    ];
    // Half of the 0.5 predictions are correct -> the bin is calibrated even though Brier is nonzero.
    expect(brierScore(calibrated)).toBeCloseTo(0.25, 12);
    expect(expectedCalibrationError(calibrated)).toBeCloseTo(0, 12);

    const maximallyWrong: DmCalibrationPoint[] = [
      { predictedProbability: 1, correct: false },
      { predictedProbability: 1, correct: false },
      { predictedProbability: 1, correct: false },
    ];
    expect(brierScore(maximallyWrong)).toBe(1);
    expect(expectedCalibrationError(maximallyWrong)).toBe(1);
  });

  it("matches hand-computed Brier and ECE for a fixed mixed set", () => {
    const points: DmCalibrationPoint[] = [
      { predictedProbability: 0.9, correct: true },
      { predictedProbability: 0.9, correct: false },
      { predictedProbability: 0.2, correct: false },
      { predictedProbability: 0.2, correct: true },
      { predictedProbability: 0.5, correct: true },
    ];
    // Brier = (0.01 + 0.81 + 0.04 + 0.64 + 0.25) / 5 = 0.35.
    expect(brierScore(points)).toBeCloseTo(0.35, 12);
    // Bins (10): [0.2]->0.3 gap * 2/5, [0.5]->0.5 gap * 1/5, [0.9]->0.4 gap * 2/5 = 0.38.
    expect(expectedCalibrationError(points)).toBeCloseTo(0.38, 12);
    expect(gradeCalibration(points)).toEqual({
      count: 5,
      brier: expect.closeTo(0.35, 12),
      expectedCalibrationError: expect.closeTo(0.38, 12),
      bins: 10,
    });
  });

  it("respects custom bin counts and clamps the top edge into the final bin", () => {
    const points: DmCalibrationPoint[] = [
      { predictedProbability: 0.6, correct: true },
      { predictedProbability: 0.9, correct: false },
    ];
    // With 2 bins both points land in the upper bin: mean 0.75 vs. rate 0.5 -> 0.25.
    expect(expectedCalibrationError(points, 2)).toBeCloseTo(0.25, 12);
    // A probability of exactly 1 must be clamped into the last bin, not overrun it.
    expect(expectedCalibrationError([{ predictedProbability: 1, correct: true }], 4)).toBe(0);
    expect(expectedCalibrationError([{ predictedProbability: 0, correct: true }], 4)).toBe(1);
  });

  it("rejects invalid bins and out-of-range probabilities", () => {
    const points: DmCalibrationPoint[] = [{ predictedProbability: 0.5, correct: true }];
    for (const bins of [0, -1, 1.5, Number.NaN]) {
      expect(() => expectedCalibrationError(points, bins)).toThrow(RangeError);
      expect(() => gradeCalibration(points, bins)).toThrow(RangeError);
    }
    for (const predictedProbability of [-0.001, 1.001, Number.NaN]) {
      expect(() => expectedCalibrationError([{ predictedProbability, correct: true }])).toThrow(RangeError);
    }
  });

  it("grades a probability per scenario against boolean correctness", () => {
    const scenarios: Array<{ id: string; predictedProbability: number; correct: boolean }> = [
      { id: "grounded-receipt", predictedProbability: 0.95, correct: true },
      { id: "tool-argument-drift", predictedProbability: 0.8, correct: true },
      { id: "hidden-data-leak", predictedProbability: 0.6, correct: false },
      { id: "stale-replay", predictedProbability: 0.3, correct: false },
    ];
    const report = gradeCalibration(scenarios.map(({ predictedProbability, correct }) => ({ predictedProbability, correct })));
    // Brier = (0.0025 + 0.04 + 0.36 + 0.09) / 4 = 0.123125.
    expect(report).toEqual({
      count: 4,
      brier: expect.closeTo(0.123125, 12),
      expectedCalibrationError: expect.closeTo(0.2875, 12),
      bins: 10,
    });
    expect(report.brier).toBeGreaterThan(0);
    expect(report.expectedCalibrationError).toBeGreaterThan(0);
  });

  it("loads the frozen calibration fixture and reproduces its declared report", () => {
    expect(fixture.version).toBe("v1");
    expect(gradeCalibration(fixture.points, fixture.bins)).toEqual({
      count: fixture.expected.count,
      brier: expect.closeTo(fixture.expected.brier, 12),
      expectedCalibrationError: expect.closeTo(fixture.expected.expectedCalibrationError, 12),
      bins: fixture.expected.bins,
    });
  });
});
