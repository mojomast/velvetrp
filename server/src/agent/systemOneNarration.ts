import type { SystemOneAnswer, SystemOneQuestions } from "../provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds } from "../types.js";
import { bandForConfidence, type SystemOneBand } from "./systemOnePolicy.js";

/**
 * L3 advisory narration/receipt verification.
 *
 * This module is a pure projection and composition battery: it emits observations
 * about a candidate narration relative to committed facts and declared boundaries.
 * It never rewrites narration, never mutates game state, and never throws on partial
 * model output. Its band is ADVISORY ONLY and is NOT a safety guarantee: a low hazard
 * signal means the verifier did not detect a hazard, not that the narration is safe.
 */

/** Question key: the narration contradicts or recasts a committed fact. */
export const NARRATION_CONTRADICTS_RECEIPT_KEY = "contradicts_receipt";
/** Question key: the narration invents a mechanic, numeric outcome, or state transition. */
export const NARRATION_INVENTS_MECHANIC_KEY = "invents_mechanic";
/** Question key: the narration crosses a declared boundary. */
export const NARRATION_CROSSES_BOUNDARY_KEY = "crosses_boundary";
/** Question key: the score question measuring how well the narration is grounded. */
export const NARRATION_GROUNDEDNESS_KEY = "groundedness";

/** Ordered groundedness levels; the score ranges over their zero-based indices. */
export const NARRATION_GROUNDEDNESS_LEVELS = ["ungrounded", "partly grounded", "fully grounded"] as const;

/** The hazard questions that can become flags; each is an independent `noul`. */
const NARRATION_HAZARD_KEYS = [
  NARRATION_CONTRADICTS_RECEIPT_KEY,
  NARRATION_INVENTS_MECHANIC_KEY,
  NARRATION_CROSSES_BOUNDARY_KEY,
] as const;

/** The minimal narration projection the verification battery reasons over. */
export interface NarrationVerificationInput {
  narration: string;
  committedFacts: readonly string[];
  declaredBoundaries?: readonly string[];
}

/** The advisory result of composing the narration battery over model answers. */
export interface NarrationVerification {
  /** Advisory confidence that the narration should be accepted as-is. */
  band: SystemOneBand;
  /** Hazard question keys whose `noul` reached the action threshold. */
  flags: string[];
  /** Normalized groundedness in [0, 1], or null when the score answer was absent. */
  groundedness: number | null;
  /** The strongest signal reasoned over, for observability and calibration. */
  topSignal: number | null;
}

function renderList(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : empty;
}

function normalizeGroundedness(score: number): number {
  const maxScore = NARRATION_GROUNDEDNESS_LEVELS.length - 1;
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score / maxScore));
}

/**
 * Builds the narration verification battery: one atomic `noul` per hazard
 * (contradiction, invented mechanic, boundary crossing) plus a three-level
 * `score` for groundedness. Committed facts and declared boundaries are embedded
 * in the instructions so each hazard question is judged against the same authority.
 */
export function buildNarrationQuestions(input: NarrationVerificationInput): SystemOneQuestions {
  const committedFacts = renderList(input.committedFacts, "(no committed facts were recorded)");
  const declaredBoundaries = renderList(input.declaredBoundaries ?? [], "(no boundaries were declared)");
  const narration = input.narration.trim() || "(empty narration)";
  const candidate = `Candidate narration (non-authoritative prose):\n${narration}`;
  return {
    [NARRATION_CONTRADICTS_RECEIPT_KEY]: {
      type: "noul",
      instructions: [
        "Does the candidate narration contradict, negate, or recast any committed fact?",
        `Committed facts (authoritative; they override the narration):\n${committedFacts}`,
        candidate,
      ].join("\n"),
      criteria: {
        true: "The narration asserts or implies something incompatible with a committed fact",
        false: "The narration is consistent with every committed fact, or only adds compatible atmosphere",
      },
    },
    [NARRATION_INVENTS_MECHANIC_KEY]: {
      type: "noul",
      instructions: [
        "Does the candidate narration invent a mechanic, numeric outcome, or state transition absent from the committed facts?",
        `Committed facts (authoritative; they override the narration):\n${committedFacts}`,
        candidate,
      ].join("\n"),
      criteria: {
        true: "The narration states or implies an unrecorded roll, damage, reward, possession, travel, or other state change",
        false: "The narration stays descriptive and introduces no mechanic or state change beyond the committed facts",
      },
    },
    [NARRATION_CROSSES_BOUNDARY_KEY]: {
      type: "noul",
      instructions: [
        "Does the candidate narration cross any declared boundary or safety agreement?",
        `Declared boundaries (authoritative; they constrain the narration):\n${declaredBoundaries}`,
        candidate,
      ].join("\n"),
      criteria: {
        true: "The narration depicts a topic, act, or framing that a declared boundary forbids",
        false: "The narration respects every declared boundary, or no boundary is relevant to it",
      },
    },
    [NARRATION_GROUNDEDNESS_KEY]: {
      type: "score",
      instructions: [
        `How well is the candidate narration grounded in the committed facts? 0 = ${NARRATION_GROUNDEDNESS_LEVELS[0]}, 1 = ${NARRATION_GROUNDEDNESS_LEVELS[1]}, 2 = ${NARRATION_GROUNDEDNESS_LEVELS[2]}.`,
        `Committed facts (authoritative; they override the narration):\n${committedFacts}`,
        candidate,
      ].join("\n"),
      criteria: [...NARRATION_GROUNDEDNESS_LEVELS],
    },
  };
}

function safeBand(signal: number, thresholds: SystemOneConfidenceThresholds): SystemOneBand | null {
  if (!Number.isFinite(signal) || signal < 0 || signal > 1) return null;
  return bandForConfidence(signal, thresholds);
}

/**
 * Composes the advisory narration verification from possibly-partial answers.
 *
 * Exact band rule:
 * 1. `fallback` when there is no usable answer (no well-formed hazard `noul` and no
 *    groundedness `score`).
 * 2. `fallback` when any hazard `noul` reaches `actionThreshold`; those keys become flags.
 * 3. `act` when nothing is flagged, groundedness reaches `actionThreshold`, and no hazard
 *    sits in the moderate `confirm` band.
 * 4. `confirm` when groundedness or a hazard signal reaches `reviewThreshold` but not the
 *    action threshold.
 * 5. `fallback` otherwise (usable but weak signals).
 *
 * This is ADVISORY: it never rewrites narration and is NOT a safety guarantee. A missing
 * hazard answer or a low hazard probability means the verifier did not detect a hazard,
 * not that none exists. Never throws on partial answers.
 */
export function composeNarrationVerification(
  answers: Record<string, SystemOneAnswer>,
  thresholds: SystemOneConfidenceThresholds,
): NarrationVerification {
  const flags: string[] = [];
  const hazardSignals: number[] = [];
  let moderateHazard = false;
  let usable = false;

  for (const key of NARRATION_HAZARD_KEYS) {
    const answer = answers[key];
    if (!answer || answer.type !== "noul") continue;
    const band = safeBand(answer.noul, thresholds);
    if (band === null) continue;
    usable = true;
    hazardSignals.push(answer.noul);
    if (band === "act") flags.push(key);
    else if (band === "confirm") moderateHazard = true;
  }

  const groundedAnswer = answers[NARRATION_GROUNDEDNESS_KEY];
  const groundedness = groundedAnswer && groundedAnswer.type === "score"
    ? normalizeGroundedness(groundedAnswer.score)
    : null;
  const groundedBand = groundedness === null ? null : safeBand(groundedness, thresholds);
  if (groundedness !== null) usable = true;

  if (!usable) return { band: "fallback", flags, groundedness, topSignal: null };

  const topSignal = Math.max(...hazardSignals, groundedness ?? 0);
  if (flags.length > 0) return { band: "fallback", flags, groundedness, topSignal };
  if (groundedBand === "act" && !moderateHazard) return { band: "act", flags, groundedness, topSignal };
  if (groundedBand === "confirm" || moderateHazard) return { band: "confirm", flags, groundedness, topSignal };
  return { band: "fallback", flags, groundedness, topSignal };
}

/** A JSON-safe state projection for the caller; copies arrays so the input is never shared. */
export function narrationVerificationState(input: NarrationVerificationInput): {
  narration: string;
  committed_facts: string[];
  declared_boundaries: string[];
} {
  return {
    narration: input.narration,
    committed_facts: [...input.committedFacts],
    declared_boundaries: [...(input.declaredBoundaries ?? [])],
  };
}
