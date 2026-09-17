import type { SystemOneAnswer, SystemOneQuestion } from "../provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds } from "../types.js";

/** Bump when the band semantics or threshold shape change, so decision records stay meaningful. */
export const SYSTEM_ONE_CONFIDENCE_POLICY_VERSION = "system-one-confidence-v1";

/** The action a confidence band authorizes. */
export type SystemOneBand = "act" | "confirm" | "fallback";

export interface SystemOneBandDecision {
  band: SystemOneBand;
  /** The signal used for banding: `confidence`, or the noul probability. */
  signal: number;
  thresholds: SystemOneConfidenceThresholds;
}

function validThreshold(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Converts a confidence (or noul probability) into an act/confirm/fallback band.
 *
 * Thresholds are server settings, never model outputs. `reviewThreshold` must not
 * exceed `actionThreshold`; an inverted pair is rejected rather than silently
 * reinterpreted.
 */
export function bandForConfidence(signal: number, thresholds: SystemOneConfidenceThresholds): SystemOneBand {
  if (!validThreshold(signal) || !validThreshold(thresholds.reviewThreshold) || !validThreshold(thresholds.actionThreshold)) {
    throw new RangeError("confidence thresholds must be finite values between 0 and 1");
  }
  if (thresholds.reviewThreshold > thresholds.actionThreshold) {
    throw new RangeError("reviewThreshold must not exceed actionThreshold");
  }
  if (signal >= thresholds.actionThreshold) return "act";
  if (signal >= thresholds.reviewThreshold) return "confirm";
  return "fallback";
}

/** The banding signal for one answer, following the vendor's per-primitive confidence rules. */
export function systemOneSignal(question: SystemOneQuestion, answer: SystemOneAnswer): number {
  if (answer.type !== question.type) throw new RangeError("answer type does not match the question");
  if (answer.type === "noul") return answer.noul;
  return answer.confidence;
}

/** Bands one answer for its question. */
export function bandSystemOneAnswer(
  question: SystemOneQuestion,
  answer: SystemOneAnswer,
  thresholds: SystemOneConfidenceThresholds,
): SystemOneBandDecision {
  const signal = systemOneSignal(question, answer);
  return { band: bandForConfidence(signal, thresholds), signal, thresholds };
}

/**
 * Combines several bands conservatively: a lane acts only when every gating
 * answer acts, falls back when any answer falls back, and confirms otherwise.
 */
export function combineSystemOneBands(bands: readonly SystemOneBand[]): SystemOneBand {
  if (bands.length === 0) throw new RangeError("at least one band is required");
  if (bands.some((band) => band === "fallback")) return "fallback";
  if (bands.every((band) => band === "act")) return "act";
  return "confirm";
}
