import { describe, expect, it } from "vitest";
import {
  applyCalibration,
  calibrateTopSignal,
  fitPlattCalibration,
  logit,
  sigmoid,
  type CalibrationSample,
} from "../src/agent/systemOneCalibration.js";

const sample = (predictedProbability: number, correct: boolean): CalibrationSample => ({ predictedProbability, correct });

describe("System One Platt calibration", () => {
  it("returns the identity map when there are no samples", () => {
    expect(fitPlattCalibration([])).toEqual({ a: 1, b: 0 });
  });

  it("is monotonic in the raw signal", () => {
    const calibration = { a: 2.5, b: -1 } as const;
    expect(applyCalibration(0.4, calibration)).toBeLessThan(applyCalibration(0.6, calibration));
    expect(applyCalibration(0.6, calibration)).toBeLessThan(applyCalibration(0.8, calibration));
  });

  it("raises a systematically under-confident signal", () => {
    const calibration = fitPlattCalibration([
      sample(0.6, true), sample(0.62, true), sample(0.58, true), sample(0.64, true), sample(0.61, true),
    ]);
    expect(applyCalibration(0.6, calibration)).toBeGreaterThan(0.8);
  });

  it("flattens an over-confident signal", () => {
    const calibration = fitPlattCalibration([
      sample(0.95, false), sample(0.9, false), sample(0.92, false), sample(0.88, false),
    ]);
    expect(applyCalibration(0.9, calibration)).toBeLessThan(0.9);
  });

  it("passes a null signal through and calibrates a present one", () => {
    expect(calibrateTopSignal(null, { a: 2, b: 1 })).toBeNull();
    expect(calibrateTopSignal(0.6, { a: 1, b: 0 })).toBeCloseTo(0.6, 6);
    expect(calibrateTopSignal(0.6, { a: 2, b: 1 })).toBeGreaterThan(0.6);
  });

  it("round-trips through the logit and logistic functions", () => {
    for (const value of [0.05, 0.3, 0.5, 0.75, 0.99]) {
      expect(sigmoid(logit(value))).toBeCloseTo(value, 5);
    }
  });

  it("rejects invalid options and probabilities", () => {
    expect(() => fitPlattCalibration([], { iterations: 0 })).toThrow(RangeError);
    expect(() => fitPlattCalibration([], { learningRate: 0 })).toThrow(RangeError);
    expect(() => fitPlattCalibration([], { regularization: -1 })).toThrow(RangeError);
    expect(() => fitPlattCalibration([sample(Number.NaN, true)])).toThrow(RangeError);
  });
});
