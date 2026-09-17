import type { SystemOneAnswer, SystemOneQuestions } from "../provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds } from "../types.js";
import { bandForConfidence, type SystemOneBand } from "./systemOnePolicy.js";

/**
 * L2 adventure exact-candidate selection.
 *
 * An adventure turn can commit only server-issued exact candidates, each already carrying an
 * opaque id and digest binding. This lane builds a speculative fan-out over the union of the
 * turn's advertised candidates: a `supported` noul ("does the declaration clearly describe
 * committing one of these?"), a per-candidate relevance `score`, and one aggregate
 * `best_candidate` choice over the exact candidate ids with a fail-closed `none_of_these`.
 * Code composes the answer: a candidate must be advertised, the aggregate choice must name
 * it, and both the choice probability and the `supported` probability must clear the same
 * threshold band. The lane never adds, drops, or authorizes a candidate, and the existing
 * digest re-validation and command bridge remain authoritative.
 *
 * The lane is ADVISORY and has no active path: composition is recorded for evaluation only.
 */

/** The question key for the "does the declaration support any advertised candidate?" noul. */
export const ADVENTURE_SUPPORTED_KEY = "supported";
/** The question key for the aggregate exact-candidate choice. */
export const ADVENTURE_BEST_KEY = "best_candidate";
/** The fail-closed option used when no advertised candidate is supported. */
export const ADVENTURE_NONE = "none_of_these";
/** Question key prefix for the per-candidate relevance `score`. */
export const ADVENTURE_RELEVANCE_PREFIX = "relevance:";

/** Ordered relevance levels; the score ranges over their zero-based indices. */
const ADVENTURE_RELEVANCE_LEVELS = ["unrelated", "loosely related", "a reasonable match", "directly requested"] as const;

/** One advertised exact candidate, projected for the battery. */
export interface AdventureSelectionCandidate {
  candidateId: string;
  digest: string;
  /** The exact selection tool that would commit it, e.g. `exact_actor_travel.select`. */
  kind: string;
  /** Server-issued human-readable label. */
  label: string;
}

/** The advisory result of composing the L2 battery over model answers. */
export interface AdventureSelectionComposition {
  /** `act` selects; `confirm` records a lower-confidence selection; `fallback` defers. */
  band: SystemOneBand;
  method: "choice" | "defer";
  /** The selected advertised candidate with its digest binding, or null when deferring. */
  selection: { candidateId: string; digest: string } | null;
  /** The combined confidence that produced the band, or null when no candidate was named. */
  topSignal: number | null;
}

/**
 * Builds one relevance `score` per advertised candidate plus the aggregate `supported` and
 * `best_candidate` questions. The declaration is embedded so every question is judged against
 * the same authority; candidate labels stay server-issued and are never rewritten by the model.
 */
export function buildAdventureSelectionQuestions(
  declaration: string,
  candidates: readonly AdventureSelectionCandidate[],
): SystemOneQuestions {
  const text = declaration.trim() || "(empty declaration)";
  const questions: SystemOneQuestions = {
    [ADVENTURE_SUPPORTED_KEY]: {
      type: "noul",
      instructions: `Does the player's declaration clearly describe committing exactly one of the advertised exact candidates?\nDeclaration: ${text}`,
      criteria: {
        true: "The declaration describes one of the advertised actions closely enough that committing it would match what the player declared",
        false: "The declaration is small talk, a question, an unsupported or invented action, or otherwise does not clearly commit any advertised candidate",
      },
    },
  };
  for (const candidate of candidates) {
    questions[`${ADVENTURE_RELEVANCE_PREFIX}${candidate.candidateId}`] = {
      type: "score",
      instructions: `How closely does the declaration match this advertised candidate? 0 = ${ADVENTURE_RELEVANCE_LEVELS[0]}, 1 = ${ADVENTURE_RELEVANCE_LEVELS[1]}, 2 = ${ADVENTURE_RELEVANCE_LEVELS[2]}, 3 = ${ADVENTURE_RELEVANCE_LEVELS[3]}.\nDeclaration: ${text}\nAdvertised candidate: ${candidate.label} (${candidate.kind})`,
      criteria: [...ADVENTURE_RELEVANCE_LEVELS],
    };
  }
  const criteria: Record<string, string | null> = {};
  for (const candidate of candidates) criteria[candidate.candidateId] = `${candidate.label} (${candidate.kind})`;
  criteria[ADVENTURE_NONE] = "No advertised candidate matches the declaration and nothing should be committed";
  questions[ADVENTURE_BEST_KEY] = {
    type: "choice",
    instructions: "Which single advertised exact candidate matches the player's declaration, or none? Choose none when the declaration does not clearly support exactly one candidate.",
    criteria,
  };
  return questions;
}

function noulSignal(answers: Record<string, SystemOneAnswer>, key: string): number | null {
  const answer = answers[key];
  return answer && answer.type === "noul" && Number.isFinite(answer.noul) ? answer.noul : null;
}

/** The normalized relevance `score` for one candidate, used for ranking and observability. */
export function adventureCandidateRelevance(answers: Record<string, SystemOneAnswer>, candidateId: string): number | null {
  const answer = answers[`${ADVENTURE_RELEVANCE_PREFIX}${candidateId}`];
  if (!answer || answer.type !== "score" || !Number.isFinite(answer.score)) return null;
  return Math.max(0, Math.min(1, answer.score / (ADVENTURE_RELEVANCE_LEVELS.length - 1)));
}

/**
 * Composes an exact-candidate selection from the battery.
 *
 * 1. With no advertised candidates there is nothing to select, so the lane defers.
 * 2. The aggregate choice must name an advertised candidate (never `none_of_these`, never an
 *    undeclared id).
 * 3. The lane is only as confident as the weaker of the two independent claims — the
 *    declaration supports some advertised candidate (`supported`) and this is the best one
 *    (the choice's probability mass for the selected option) — so the combined signal is
 *    their minimum. An act band selects; a confirm band records a lower-confidence
 *    selection; anything below defers.
 * 4. Otherwise the lane defers and the caller keeps its existing deterministic selection.
 */
export function composeAdventureSelection(
  candidates: readonly AdventureSelectionCandidate[],
  answers: Record<string, SystemOneAnswer>,
  thresholds: SystemOneConfidenceThresholds,
): AdventureSelectionComposition {
  if (candidates.length === 0) {
    return { band: "fallback", method: "defer", selection: null, topSignal: null };
  }
  const best = answers[ADVENTURE_BEST_KEY];
  if (!best || best.type !== "choice" || best.choice === ADVENTURE_NONE) {
    return { band: "fallback", method: "defer", selection: null, topSignal: null };
  }
  const candidate = candidates.find((entry) => entry.candidateId === best.choice);
  if (!candidate) {
    return { band: "fallback", method: "defer", selection: null, topSignal: null };
  }
  const supported = noulSignal(answers, ADVENTURE_SUPPORTED_KEY);
  if (supported === null) {
    return { band: "fallback", method: "defer", selection: null, topSignal: null };
  }
  // The confidence in the selection is the probability the model assigned to the option it
  // named, not the distribution maximum: a flat split with a large `none_of_these` must not
  // masquerade as confidence in a weak pick.
  const chosenProbability = best.probabilities[candidate.candidateId];
  const choiceProbability = typeof chosenProbability === "number" && Number.isFinite(chosenProbability)
    ? Math.max(0, Math.min(1, chosenProbability))
    : 0;
  const signal = Math.min(choiceProbability, supported);
  const band = bandForConfidence(signal, thresholds);
  if (band === "fallback") {
    return { band: "fallback", method: "defer", selection: null, topSignal: signal };
  }
  return {
    band,
    method: "choice",
    selection: { candidateId: candidate.candidateId, digest: candidate.digest },
    topSignal: signal,
  };
}
