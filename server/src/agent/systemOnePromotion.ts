import type { SystemOneLane } from "../types.js";

/**
 * Measured calibration for one System One lane on a frozen holdout.
 *
 * The field names mirror the eval harness (`server/test/evals/dmGraders.ts`):
 * `brier` is the mean squared error between predicted probability and the 0/1
 * outcome, and `expectedCalibrationError` is the equal-width ECE over [0, 1].
 * `accuracy` is the oracle-agreement rate. All rates are proportions in [0, 1].
 */
export interface CalibrationMetrics {
  samples: number;
  accuracy: number;
  brier: number;
  expectedCalibrationError: number;
}

/** The thresholds a lane must clear on the holdout before it may leave shadow mode. */
export interface SystemOneLaneGate {
  minSamples: number;
  minAccuracy: number;
  maxBrier: number;
  maxExpectedCalibrationError: number;
}

/** The conservative starting point shared by lanes without a specific override. */
const BASE_LANE_GATE: SystemOneLaneGate = {
  minSamples: 30,
  minAccuracy: 0.9,
  maxBrier: 0.1,
  maxExpectedCalibrationError: 0.1,
};

/**
 * Per-lane promotion gates.
 *
 * These are judgment-based starting points, not measured truths: they must be
 * re-derived from frozen-holdout data before they are trusted. Lanes whose
 * mistakes are expensive or user-visible (`guardrails`, `cost-router`) are held
 * to a stricter accuracy and calibration bar, while `memory-reranking` is
 * observational and starts looser.
 */
export const DEFAULT_SYSTEM_ONE_LANE_GATES: Record<SystemOneLane, SystemOneLaneGate> = {
  "director-selection": { ...BASE_LANE_GATE },
  "adventure-selection": { ...BASE_LANE_GATE },
  "narration-verification": { ...BASE_LANE_GATE },
  "memory-reranking": { minSamples: 20, minAccuracy: 0.85, maxBrier: 0.15, maxExpectedCalibrationError: 0.15 },
  "speaker-routing": { ...BASE_LANE_GATE },
  guardrails: { minSamples: 30, minAccuracy: 0.95, maxBrier: 0.05, maxExpectedCalibrationError: 0.05 },
  "cost-router": { minSamples: 30, minAccuracy: 0.95, maxBrier: 0.05, maxExpectedCalibrationError: 0.05 },
};

/** The promotion decision for one lane, with every failed gate spelled out. */
export interface SystemOnePromotionResult {
  lane: SystemOneLane;
  promoted: boolean;
  reasons: string[];
  gates: SystemOneLaneGate;
}

function validUnitRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateMetrics(metrics: CalibrationMetrics): void {
  if (!Number.isFinite(metrics.samples) || metrics.samples < 0) {
    throw new RangeError(`calibration metrics samples must be a finite non-negative number: ${metrics.samples}`);
  }
  if (!validUnitRate(metrics.accuracy)) {
    throw new RangeError(`calibration metrics accuracy must be within [0, 1]: ${metrics.accuracy}`);
  }
  if (!validUnitRate(metrics.brier)) {
    throw new RangeError(`calibration metrics brier must be within [0, 1]: ${metrics.brier}`);
  }
  if (!validUnitRate(metrics.expectedCalibrationError)) {
    throw new RangeError(
      `calibration metrics expectedCalibrationError must be within [0, 1]: ${metrics.expectedCalibrationError}`,
    );
  }
}

function validateGate(gate: SystemOneLaneGate): void {
  if (!Number.isFinite(gate.minSamples) || gate.minSamples < 0) {
    throw new RangeError(`gate minSamples must be a finite non-negative number: ${gate.minSamples}`);
  }
  if (!validUnitRate(gate.minAccuracy)) {
    throw new RangeError(`gate minAccuracy must be within [0, 1]: ${gate.minAccuracy}`);
  }
  if (!validUnitRate(gate.maxBrier)) {
    throw new RangeError(`gate maxBrier must be within [0, 1]: ${gate.maxBrier}`);
  }
  if (!validUnitRate(gate.maxExpectedCalibrationError)) {
    throw new RangeError(
      `gate maxExpectedCalibrationError must be within [0, 1]: ${gate.maxExpectedCalibrationError}`,
    );
  }
}

/**
 * Decides whether a lane may leave shadow mode.
 *
 * A lane is promoted only when every gate passes. A failing gate is recorded as
 * a reason with the observed and required values; a not-ready lane is never
 * force-enabled, it is simply reported as not promoted.
 */
export function evaluatePromotionGate(
  lane: SystemOneLane,
  metrics: CalibrationMetrics,
  gates: SystemOneLaneGate = DEFAULT_SYSTEM_ONE_LANE_GATES[lane],
): SystemOnePromotionResult {
  validateMetrics(metrics);
  validateGate(gates);
  const reasons: string[] = [];
  if (metrics.samples < gates.minSamples) {
    reasons.push(`insufficient samples: ${metrics.samples} < ${gates.minSamples}`);
  }
  if (metrics.accuracy < gates.minAccuracy) {
    reasons.push(`accuracy below minimum: ${metrics.accuracy.toFixed(4)} < ${gates.minAccuracy.toFixed(4)}`);
  }
  if (metrics.brier > gates.maxBrier) {
    reasons.push(`brier above maximum: ${metrics.brier.toFixed(4)} > ${gates.maxBrier.toFixed(4)}`);
  }
  if (metrics.expectedCalibrationError > gates.maxExpectedCalibrationError) {
    reasons.push(
      `expected calibration error above maximum: ${metrics.expectedCalibrationError.toFixed(4)} > ${gates.maxExpectedCalibrationError.toFixed(4)}`,
    );
  }
  return { lane, promoted: reasons.length === 0, reasons, gates };
}

/** Throws when a lane is not ready to promote, naming the lane and every failed gate. */
export function assertPromoted(result: SystemOnePromotionResult): void {
  if (!result.promoted) {
    throw new Error(
      `System One lane "${result.lane}" is not ready for promotion: ${result.reasons.join("; ")}`,
    );
  }
}
