import type { SystemOneLane } from "../types.js";
import type { PlattCalibration } from "./systemOneCalibration.js";

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

/**
 * Frozen evidence that a lane cleared its gate on a measured evaluation.
 *
 * A record is a snapshot, not a guarantee: it names the evidence document and the
 * calibration map that produced the calibrated metrics. Lanes without a record cannot
 * act — the runtime records their decisions but never lets them change behavior.
 */
export interface SystemOnePromotionRecord {
  metrics: CalibrationMetrics;
  /** The Platt map that produced the calibrated metrics, to mirror in settings. */
  calibration: PlattCalibration | null;
  promotedAt: string;
  evidence: string;
}

/**
 * Measured, promoted lanes. Each entry is re-derivable by rerunning the named evidence
 * command; adding one is the deliberate act that lets a lane leave shadow mode.
 */
export const SYSTEM_ONE_PROMOTION_RECORDS: Partial<Record<SystemOneLane, SystemOnePromotionRecord>> = {
  "speaker-routing": {
    // scripts/benchmark-system-one-lanes.ts: 90 acted decisions, exact-set accuracy 100%,
    // raw ECE 0.119 -> calibrated ECE 0.003 (held-out archive ECE 0.001).
    metrics: { samples: 90, accuracy: 1, brier: 0, expectedCalibrationError: 0.0033 },
    calibration: { a: 2.5732, b: 1.3973 },
    promotedAt: "2026-09-17",
    evidence: "docs/system-one-benchmark.md",
  },
  "cost-router": {
    // scripts/evaluate-system-one-router-lane.ts: 45 acted decisions, 100% handler
    // accuracy, raw ECE 0.057 -> calibrated ECE 0.003 (held-out ECE 0.003). The lane has
    // no active handler-selection path yet, so this record is evidence, not activation.
    metrics: { samples: 45, accuracy: 1, brier: 0.0001, expectedCalibrationError: 0.0031 },
    calibration: { a: 2.2177, b: 0.9611 },
    promotedAt: "2026-09-17",
    evidence: "docs/system-one-router-benchmark.md",
  },
  "narration-verification": {
    // scripts/evaluate-system-one-narration-lane.ts: 51 decisive verdicts, 94.1% verdict
    // accuracy, calibrated Brier 0.057, ECE 0.056; every accepted narration was correct and
    // none was a false accept. The single miss (c3) was a flag-label mismatch on a
    // contradiction the lane still refused to accept. The lane is advisory and never rewrites
    // narration, so this record is evidence, not activation.
    metrics: { samples: 51, accuracy: 0.9412, brier: 0.0573, expectedCalibrationError: 0.0563 },
    calibration: { a: 1.9971, b: 0.5491 },
    promotedAt: "2026-09-17",
    evidence: "docs/system-one-narration-benchmark.md",
  },
  "director-selection": {
    // scripts/evaluate-system-one-director.ts: 36 acted decisions, 100% acceptable and 100%
    // exact, calibrated Brier ~0, ECE 0.0059 (held-out calibrated ECE 0.0035). The frozen
    // corpus has no acted errors — the server only advertises authorized beats and the model
    // defers on every mixed state — so this is a promotion candidate, not a stress-tested
    // guarantee. No active Director path is wired, so the record is evidence, not activation.
    metrics: { samples: 36, accuracy: 1, brier: 0, expectedCalibrationError: 0.0059 },
    calibration: { a: 2.5661, b: 3.299 },
    promotedAt: "2026-09-17",
    evidence: "docs/system-one-director-calibration.md",
  },
  "adventure-selection": {
    // scripts/evaluate-system-one-adventure-lane.ts, re-derived after the first harvest-loop pass:
    // 93 live calls over 30 frozen hand-labeled cases plus 1 confirmed harvested live case, at 3
    // repeats with the vendor's uid decorrelator in state. The lane named a candidate on 54 calls
    // and all 54 picks were acceptable; at the sweep's recommended action threshold 0.55 (which
    // also requires reviewThreshold <= 0.55) the gate passes: 54 acted, 100% accuracy, calibrated
    // Brier 0.0001, ECE 0.0092 (held-out 0.0117). Decision stability was 100% (0/31 conflicted
    // cases; mean per-case signal std dev 0.0135, max 0.0531). The harvested live case is a
    // stable miss: the lane defers on "drop my longsword" although the server bound an unequip
    // candidate, 3/3 repeats. The threshold is selected on the same corpus that scores it and the
    // acted subset has no errors, so this is a promotion candidate, not proof; the server default
    // stays 0.75/0.5. The lane is wired in shadow (record-only) into fresh adventure turns, so
    // the record is evidence, not activation.
    metrics: { samples: 54, accuracy: 1, brier: 0.0001, expectedCalibrationError: 0.0092 },
    calibration: { a: 2.5171, b: 3.0141 },
    promotedAt: "2026-09-17",
    evidence: "docs/system-one-adventure-benchmark.md",
  },
  "memory-reranking": {
    // scripts/evaluate-system-one-rerank-lane.ts: 81 live reranks over the Plan 3 recall
    // oracle, 30 decisive (band act), 100% decisive case accuracy, raw ECE 0.135 -> calibrated
    // 0.0036. The lane improved the best required-source position on 6 calls and demoted none;
    // aggregate recall@K/MRR/nDCG are unchanged because every supported-corpus required source
    // was already inside top-K. Both alias cases stayed a top-K miss and the lane deferred on
    // every one of them at ~0.4 confidence, so the acted subset has no observed errors and the
    // calibration tail is untested. No rerank path is wired into recall, so this record is
    // evidence, not activation.
    metrics: { samples: 30, accuracy: 1, brier: 0, expectedCalibrationError: 0.0036 },
    calibration: { a: 2.6454, b: 1.3874 },
    promotedAt: "2026-09-17",
    evidence: "docs/system-one-rerank-benchmark.md",
  },
  "guardrails": {
    // scripts/evaluate-system-one-guardrails-lane.ts: 168 live calls over a 56-case labeled
    // corpus, 75 acted (60 block, 15 support), 100% acted accuracy, calibrated Brier ~0, ECE
    // 0.0022 (held-out 0.0025). The first run acted at 90.5% and every error was a false
    // positive on fiction/meta questions; the hazard criteria were redesigned from that
    // measurement (override addresses the assistant itself, disclosure demands protected
    // material rather than story hints, severity judges the real user rather than fictional
    // drama), and the expanded corpus then caught every hazard with no benign/fiction
    // escalation. The acted subset has no errors, so the calibration tail is untested. The lane
    // is wired in shadow (record-only) into the room-turn route, so the record is evidence, not
    // activation.
    metrics: { samples: 75, accuracy: 1, brier: 0, expectedCalibrationError: 0.0022 },
    calibration: { a: 2.1254, b: 0.655 },
    promotedAt: "2026-09-17",
    evidence: "docs/system-one-guardrails-benchmark.md",
  },
};

/** The promotion record for a lane, or undefined when it has never been promoted. */
export function promotionRecord(lane: SystemOneLane): SystemOnePromotionRecord | undefined {
  return SYSTEM_ONE_PROMOTION_RECORDS[lane];
}

/**
 * Whether a lane may leave shadow mode. A lane is promoted only when it has a record and
 * that record still clears the lane's gate. The runtime checks this before acting, so an
 * unpromoted lane records its decisions but never changes behavior.
 */
export function isLanePromoted(lane: SystemOneLane): boolean {
  const record = promotionRecord(lane);
  if (!record) return false;
  return evaluatePromotionGate(lane, record.metrics).promoted;
}
