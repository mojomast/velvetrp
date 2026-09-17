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
 *
 * The battery decomposes the old three-level `groundedness` judgement into atomic,
 * per-fact questions:
 * - one `noul` per committed fact asking whether the narration reflects it (coverage),
 * - one `noul` per committed fact asking whether the narration contradicts it (hazard),
 * - one `invents_mechanic` `noul` and one `crosses_boundary` `noul` (aggregate hazards).
 *
 * Coverage is then computed deterministically as the fraction of facts the model was
 * confident the narration reflects, so a narration that restates a single fact no longer
 * scores as fully grounded.
 */

/** Public flag: the narration contradicts or recasts a committed fact. */
export const NARRATION_CONTRADICTS_RECEIPT_KEY = "contradicts_receipt";
/** Public flag: the narration invents a mechanic, numeric outcome, or state transition. */
export const NARRATION_INVENTS_MECHANIC_KEY = "invents_mechanic";
/** Public flag: the narration crosses a declared boundary. */
export const NARRATION_CROSSES_BOUNDARY_KEY = "crosses_boundary";

/** The aggregate hazard questions that are not tied to a single committed fact. */
const NARRATION_GLOBAL_HAZARD_KEYS = [
  NARRATION_INVENTS_MECHANIC_KEY,
  NARRATION_CROSSES_BOUNDARY_KEY,
] as const;

/** Question-key prefixes for the per-fact coverage and contradiction `noul`s. */
const REFLECTION_PREFIX = "reflects_receipt:";
const CONTRADICTION_PREFIX = "contradicts_receipt:";

/** Builds the question key for the coverage check of committed fact `index`. */
export function narrationReflectionKey(index: number): string {
  return `${REFLECTION_PREFIX}${index}`;
}

/** Builds the question key for the contradiction check of committed fact `index`. */
export function narrationContradictionKey(index: number): string {
  return `${CONTRADICTION_PREFIX}${index}`;
}

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
  /** Public hazard flag keys that reached the action threshold. */
  flags: string[];
  /** Coverage: the fraction of committed facts the narration reflects, or null when there are none. */
  groundedness: number | null;
  /** The strongest signal reasoned over, for observability and calibration. */
  topSignal: number | null;
}

/** Optional composition inputs. */
export interface NarrationComposeOptions {
  /**
   * The number of committed facts the battery was built over. When provided, reflection
   * answers that are missing from partial model output count against coverage (safe). When
   * omitted, the count is inferred from the reflection answers present.
   */
  factCount?: number;
}

function renderList(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : empty;
}

/**
 * Builds the narration verification battery: one coverage `noul` and one contradiction
 * `noul` per committed fact, plus aggregate `invents_mechanic` and `crosses_boundary`
 * `noul`s. Committed facts and declared boundaries are embedded in the instructions so
 * each question is judged against the same authority.
 */
export function buildNarrationQuestions(input: NarrationVerificationInput): SystemOneQuestions {
  const committedFacts = input.committedFacts;
  const allFacts = renderList(committedFacts, "(no committed facts were recorded)");
  const declaredBoundaries = renderList(input.declaredBoundaries ?? [], "(no boundaries were declared)");
  const narration = input.narration.trim() || "(empty narration)";
  const candidate = `Candidate narration (non-authoritative prose):\n${narration}`;

  const questions: SystemOneQuestions = {
    [NARRATION_INVENTS_MECHANIC_KEY]: {
      type: "noul",
      instructions: [
        "Does the candidate narration invent a mechanic, numeric outcome, or state transition absent from the committed facts?",
        `Committed facts (authoritative; they override the narration):\n${allFacts}`,
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
  };

  committedFacts.forEach((fact, index) => {
    questions[narrationReflectionKey(index)] = {
      type: "noul",
      instructions: [
        "Does the candidate narration state or clearly imply this one committed fact?",
        `Committed fact to check:\n- ${fact}`,
        "The fact is NOT reflected when the narration merely omits it or asserts anything incompatible with it.",
        `All committed facts (for context):\n${allFacts}`,
        candidate,
      ].join("\n"),
      criteria: {
        true: "The narration states or clearly implies this committed fact",
        false: "The narration omits this committed fact or asserts something incompatible with it",
      },
    };
    questions[narrationContradictionKey(index)] = {
      type: "noul",
      instructions: [
        "Does the candidate narration contradict, negate, or recast this one committed fact?",
        `Committed fact to check:\n- ${fact}`,
        "Answer false when the narration states, implies, or simply does not address this fact.",
        `All committed facts (for context):\n${allFacts}`,
        candidate,
      ].join("\n"),
      criteria: {
        true: "The narration asserts or implies the opposite of this committed fact",
        false: "The narration is compatible with this committed fact, whether or not it mentions it",
      },
    };
  });

  return questions;
}

function safeBand(signal: number, thresholds: SystemOneConfidenceThresholds): SystemOneBand | null {
  if (!Number.isFinite(signal) || signal < 0 || signal > 1) return null;
  return bandForConfidence(signal, thresholds);
}

/**
 * Composes the advisory narration verification from possibly-partial answers.
 *
 * Exact band rule:
 * 1. `fallback` when there is no usable answer (no well-formed hazard or coverage `noul`).
 * 2. `fallback` when any hazard reaches `actionThreshold`; the corresponding public flag is set.
 * 3. `confirm` when a hazard sits in the moderate `confirm` band.
 * 4. `act` when every committed fact is reflected and no hazard reached `confirm`.
 * 5. `confirm` when at least one fact is reflected but coverage is incomplete.
 * 6. `fallback` otherwise (nothing reflected, so the narration cannot be grounded).
 *
 * Coverage is `reflected / factCount`, where a fact counts as reflected when its coverage
 * `noul` reaches `reviewThreshold`. This is ADVISORY: it never rewrites narration and is NOT
 * a safety guarantee. A missing hazard answer or a low hazard probability means the verifier
 * did not detect a hazard, not that none exists. Never throws on partial answers.
 */
export function composeNarrationVerification(
  answers: Record<string, SystemOneAnswer>,
  thresholds: SystemOneConfidenceThresholds,
  options: NarrationComposeOptions = {},
): NarrationVerification {
  const flags: string[] = [];
  const hazardSignals: number[] = [];
  const reflectionSignals: number[] = [];
  let moderateHazard = false;
  let contradiction = false;
  let usable = false;
  let inferredFacts = 0;
  let reflected = 0;

  for (const key of NARRATION_GLOBAL_HAZARD_KEYS) {
    const answer = answers[key];
    if (!answer || answer.type !== "noul") continue;
    const band = safeBand(answer.noul, thresholds);
    if (band === null) continue;
    usable = true;
    hazardSignals.push(answer.noul);
    if (band === "act") flags.push(key);
    else if (band === "confirm") moderateHazard = true;
  }

  for (const [key, answer] of Object.entries(answers)) {
    if (key.startsWith(CONTRADICTION_PREFIX)) {
      if (answer.type !== "noul") continue;
      const band = safeBand(answer.noul, thresholds);
      if (band === null) continue;
      usable = true;
      hazardSignals.push(answer.noul);
      if (band === "act") contradiction = true;
      else if (band === "confirm") moderateHazard = true;
      continue;
    }
    if (key.startsWith(REFLECTION_PREFIX)) {
      inferredFacts += 1;
      if (answer.type !== "noul") continue;
      const signal = answer.noul;
      if (!Number.isFinite(signal) || signal < 0 || signal > 1) continue;
      usable = true;
      reflectionSignals.push(signal);
      if (signal >= thresholds.reviewThreshold) reflected += 1;
    }
  }

  if (contradiction) flags.push(NARRATION_CONTRADICTS_RECEIPT_KEY);

  const totalFacts = options.factCount ?? inferredFacts;
  const groundedness = totalFacts > 0 ? Math.min(1, reflected / totalFacts) : null;

  if (!usable) return { band: "fallback", flags, groundedness: null, topSignal: null };

  const fullyGrounded = totalFacts > 0 && reflected === totalFacts && reflectionSignals.length > 0;
  const topSignal = flags.length > 0
    ? Math.max(...hazardSignals)
    : fullyGrounded
      ? Math.min(...reflectionSignals)
      : groundedness;

  if (flags.length > 0) return { band: "fallback", flags, groundedness, topSignal };
  if (moderateHazard) return { band: "confirm", flags, groundedness, topSignal };
  if (fullyGrounded) return { band: "act", flags, groundedness, topSignal };
  if (reflected > 0) return { band: "confirm", flags, groundedness, topSignal };
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
