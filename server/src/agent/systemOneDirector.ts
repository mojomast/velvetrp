import type { SystemOneAnswer, SystemOneCaller, SystemOneQuestions } from "../provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds, SystemOneSettings } from "../types.js";
import { bandForConfidence, type SystemOneBand } from "./systemOnePolicy.js";

/** An injected Director shadow lane; absent when the flag, setting, or key is off. */
export interface SystemOneDirectorDependency {
  settings: SystemOneSettings;
  caller: SystemOneCaller;
}

/** The candidate projection the Director battery reasons over. */
export interface DirectorCandidateProjection {
  candidateId: string;
  digest: string;
  action: string;
  label: string;
}

export const DIRECTOR_HOLD_KEY = "hold";
export const DIRECTOR_BEST_KEY = "best_candidate";
export const DIRECTOR_NONE = "none_of_these";

/** Ordered priority levels for the per-candidate `score` question. */
const DIRECTOR_PRIORITY_LEVELS = ["low priority", "medium priority", "high priority"] as const;
const DIRECTOR_MAX_BEATS = 3;

/**
 * Builds the Director decision battery: one `noul` ("is this a legal, grounded next
 * beat?") and one `score` (priority) per advertised candidate, plus a `hold` noul and
 * an aggregate `best_candidate` choice. Independent answers are composed in code.
 */
export function buildDirectorQuestions(candidates: readonly DirectorCandidateProjection[]): SystemOneQuestions {
  const questions: SystemOneQuestions = {
    [DIRECTOR_HOLD_KEY]: {
      type: "noul",
      instructions: "Should the Director hold this beat instead of advancing any candidate?",
      criteria: {
        true: "No advertised candidate is a legal, well-grounded immediate next beat",
        false: "At least one advertised candidate is grounded and can advance now",
      },
    },
  };
  for (const candidate of candidates) {
    questions[`supported:${candidate.candidateId}`] = {
      type: "noul",
      instructions: `Is this advertised candidate a legal, well-grounded immediate next beat? Candidate: ${candidate.label} (${candidate.action}).`,
      criteria: {
        true: "The candidate is legal now and directly supported by the current committed state",
        false: "The candidate is illegal now, premature, or not grounded by the committed state",
      },
    };
    questions[`priority:${candidate.candidateId}`] = {
      type: "score",
      instructions: `How strong and relevant a next beat is this candidate? Candidate: ${candidate.label} (${candidate.action}).`,
      criteria: [...DIRECTOR_PRIORITY_LEVELS],
    };
  }
  const criteria: Record<string, string | null> = {};
  for (const candidate of candidates) criteria[candidate.candidateId] = `${candidate.label} (${candidate.action})`;
  criteria[DIRECTOR_NONE] = "No advertised candidate is a supported next beat";
  questions[DIRECTOR_BEST_KEY] = {
    type: "choice",
    instructions: "Which single advertised candidate is the best-supported immediate next beat, or none?",
    criteria,
  };
  return questions;
}

export type DirectorMethod = "hold" | "candidates" | "best-pick" | "defer";

export interface DirectorComposition {
  band: SystemOneBand;
  method: DirectorMethod;
  hold: boolean;
  /** Ordered candidate selections (id + digest), highest priority first. */
  selections: Array<{ candidateId: string; digest: string }>;
  topSignal: number | null;
}

function topProbability(probabilities: Record<string, number>): number {
  return Object.values(probabilities).reduce((max, value) => (value > max ? value : max), 0);
}

/**
 * Composes a Director selection from the battery.
 *
 * 1. A strong `hold` answer holds the beat (`act`, no selections).
 * 2. Otherwise grounded candidates (`noul` act) are ordered by priority score and
 *    capped at the beat limit.
 * 3. If none are grounded, the aggregate choice rescues a single confident candidate.
 * 4. Otherwise the lane defers; the caller keeps its existing behavior.
 */
export function composeDirectorSelection(
  candidates: readonly DirectorCandidateProjection[],
  answers: Record<string, SystemOneAnswer>,
  thresholds: SystemOneConfidenceThresholds,
  maxBeats = DIRECTOR_MAX_BEATS,
): DirectorComposition {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const holdAnswer = answers[DIRECTOR_HOLD_KEY];
  const holdSignal = holdAnswer && holdAnswer.type === "noul" ? holdAnswer.noul : null;
  if (holdSignal !== null && bandForConfidence(holdSignal, thresholds) === "act") {
    return { band: "act", method: "hold", hold: true, selections: [], topSignal: holdSignal };
  }

  const scored = candidates.flatMap((candidate) => {
    const support = answers[`supported:${candidate.candidateId}`];
    if (!support || support.type !== "noul") return [];
    const priority = answers[`priority:${candidate.candidateId}`];
    const normalizedPriority = priority && priority.type === "score"
      ? Math.max(0, Math.min(1, priority.score / (DIRECTOR_PRIORITY_LEVELS.length - 1)))
      : 0;
    return [{ candidate, support: support.noul, priority: normalizedPriority, band: bandForConfidence(support.noul, thresholds) }];
  });
  const grounded = scored.filter((entry) => entry.band === "act")
    .sort((left, right) => (right.priority - left.priority) || (right.support - left.support))
    .slice(0, maxBeats);
  if (grounded.length > 0) {
    return {
      band: "act", method: "candidates", hold: false,
      selections: grounded.map((entry) => ({ candidateId: entry.candidate.candidateId, digest: entry.candidate.digest })),
      topSignal: grounded[0]!.support,
    };
  }

  const best = answers[DIRECTOR_BEST_KEY];
  const bestTop = best && best.type === "choice" ? topProbability(best.probabilities) : null;
  if (best && best.type === "choice" && best.choice !== DIRECTOR_NONE && byId.has(best.choice) && bestTop !== null && bestTop >= thresholds.reviewThreshold) {
    const selected = byId.get(best.choice)!;
    return { band: "act", method: "best-pick", hold: false, selections: [{ candidateId: selected.candidateId, digest: selected.digest }], topSignal: bestTop };
  }

  // The defer band reflects candidate/hold support only; a high `none_of_these` probability
  // is confidence in deferring, not in acting, so it must not raise the band.
  const strongest = Math.max(holdSignal ?? 0, ...scored.map((entry) => entry.support));
  return {
    band: strongest > 0 ? bandForConfidence(strongest, thresholds) : "fallback",
    method: "defer", hold: false, selections: [], topSignal: strongest > 0 ? strongest : null,
  };
}
