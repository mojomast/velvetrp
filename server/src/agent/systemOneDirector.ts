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
  /**
   * True for a pacing beat (an ambient moment or a bounded time step) that keeps the world
   * moving without advancing the story. Only pacing candidates get a `transition` question,
   * so the transition fallback can never displace a preferred mechanical beat. Defaults to false.
   */
  pacing?: boolean;
}

export const DIRECTOR_HOLD_KEY = "hold";
export const DIRECTOR_BEST_KEY = "best_candidate";
export const DIRECTOR_NONE = "none_of_these";
export const DIRECTOR_PROGRESS_PREFIX = "progress:";
export const DIRECTOR_PRIORITY_PREFIX = "priority:";
export const DIRECTOR_TRANSITION_PREFIX = "transition:";

/** Ordered priority levels for the per-candidate `score` question. */
const DIRECTOR_PRIORITY_LEVELS = ["low priority", "medium priority", "high priority"] as const;
const DIRECTOR_MAX_BEATS = 3;

/**
 * Builds the Director decision battery. Each advertised candidate gets three atomic
 * questions: `progress:` ("is committing this a good, meaningful next step now?"), a
 * `transition:` noul ("is this a safe, low-risk way to keep the world moving even without
 * advancing the story?"), and a priority `score`. A `hold` noul covers "a player decision
 * is genuinely required", and an aggregate `best_candidate` choice names the single beat to
 * commit when the atomic signals are not decisive. Independent answers are composed in code.
 *
 * The design is evidence-led. The original single "is this supported?" noul conflated
 * legality, relevance, and immediacy, and hedged (0.53-0.73) on states whose only legal
 * beats were neutral transitions. Two changes came out of measuring against the live
 * model: (1) an atomic `legal` question was dropped because the advertised candidate set
 * is server-authorized, so re-asking legality only added hedging (a legal `encounter-start`
 * scored 0.51) without changing decisions; (2) `progress` grades a "meaningful next step"
 * rather than specifically "story-objective progress", so a consequential mechanical beat
 * like starting a prepared encounter is not penalized for not advancing plot. A third change
 * came from live shadow data: in richer campaign states the model scored transition beats
 * (ambient-beat, advance-time) around 0.11 because the criteria named "let time pass or add
 * ambiance" as not-progress, so the lane deferred on states where the provider committed a
 * transition. The criteria now treat a safe low-risk transition as a valid next step while
 * still rejecting premature, redundant, or unsafe beats.
 */
export function buildDirectorQuestions(candidates: readonly DirectorCandidateProjection[]): SystemOneQuestions {
  const questions: SystemOneQuestions = {
    [DIRECTOR_HOLD_KEY]: {
      type: "noul",
      instructions: "Should the Director hold this beat and require a player decision before committing any advertised candidate?",
      criteria: {
        true: "No advertised candidate is a good next step and a player decision is genuinely required now",
        false: "At least one advertised candidate can be committed as the next beat, even if it only keeps the world alive",
      },
    },
  };
  for (const candidate of candidates) {
    questions[`${DIRECTOR_PROGRESS_PREFIX}${candidate.candidateId}`] = {
      type: "noul",
      instructions: `Is committing this advertised beat a good, meaningful next step for the Director right now? Candidate: ${candidate.label} (${candidate.action}).`,
      criteria: {
        true: "Committing it now would reveal, resolve, start, or otherwise meaningfully change the situation, or is a safe low-risk transition that keeps the world moving while play waits",
        false: "Committing it now would be premature, redundant, or unsafe, or should wait for a player decision",
      },
    };
    questions[`${DIRECTOR_PRIORITY_PREFIX}${candidate.candidateId}`] = {
      type: "score",
      instructions: `How strong and relevant a next beat is this candidate? Candidate: ${candidate.label} (${candidate.action}).`,
      criteria: [...DIRECTOR_PRIORITY_LEVELS],
    };
    if (candidate.pacing === true) {
      questions[`${DIRECTOR_TRANSITION_PREFIX}${candidate.candidateId}`] = {
        type: "noul",
        instructions: `Is committing this advertised pacing beat a safe, low-risk way to keep the world moving right now, even though it does not advance the story? Candidate: ${candidate.label} (${candidate.action}).`,
        criteria: {
          true: "Committing it now is safe and keeps the world moving without forcing a player decision",
          false: "Committing it now is unsafe, premature, redundant, or the world should instead wait for a player decision",
        },
      };
    }
  }
  const criteria: Record<string, string | null> = {};
  for (const candidate of candidates) criteria[candidate.candidateId] = `${candidate.label} (${candidate.action})`;
  criteria[DIRECTOR_NONE] = "A player decision is required now and no advertised beat should be forced";
  questions[DIRECTOR_BEST_KEY] = {
    type: "choice",
    instructions: "Which single advertised beat should the Director commit next, or none? Prefer a beat that makes real progress; if none does, prefer the liveliest low-risk transition (an ambient moment over an arbitrary time skip). Choose none only when a player decision is genuinely required now.",
    criteria,
  };
  return questions;
}

export type DirectorMethod = "hold" | "candidates" | "transition" | "best-pick" | "defer";

export interface DirectorComposition {
  band: SystemOneBand;
  method: DirectorMethod;
  hold: boolean;
  /** Ordered candidate selections (id + digest), highest priority first. */
  selections: Array<{ candidateId: string; digest: string }>;
  topSignal: number | null;
}

interface ScoredCandidate {
  candidate: DirectorCandidateProjection;
  progress: number;
  priority: number;
}

function topProbability(probabilities: Record<string, number>): number {
  return Object.values(probabilities).reduce((max, value) => (value > max ? value : max), 0);
}

function noulSignal(answers: Record<string, SystemOneAnswer>, key: string): number | null {
  const answer = answers[key];
  return answer && answer.type === "noul" ? answer.noul : null;
}

function normalizedPriority(answers: Record<string, SystemOneAnswer>, key: string): number {
  const answer = answers[key];
  if (!answer || answer.type !== "score") return 0;
  return Math.max(0, Math.min(1, answer.score / (DIRECTOR_PRIORITY_LEVELS.length - 1)));
}

/**
 * Composes a Director selection from the battery.
 *
 * 0. With no advertised candidates, holding is the only possible action and is forced.
 * 1. Candidates whose `progress` answer clears the action threshold are ordered by
 *    priority score and capped at the beat limit.
 * 2. If none are grounded, a confident `hold` holds the beat (`act`, no selections).
 * 3. Otherwise candidates whose `transition` answer clears the action threshold are
 *    ordered by priority and committed as a low-risk way to keep the world moving.
 * 4. Otherwise the aggregate `best_candidate` choice rescues one candidate when it
 *    clears the action threshold.
 * 5. Otherwise the lane defers; the caller keeps its existing behavior.
 */
export function composeDirectorSelection(
  candidates: readonly DirectorCandidateProjection[],
  answers: Record<string, SystemOneAnswer>,
  thresholds: SystemOneConfidenceThresholds,
  maxBeats = DIRECTOR_MAX_BEATS,
): DirectorComposition {
  if (candidates.length === 0) {
    return { band: "act", method: "hold", hold: true, selections: [], topSignal: 1 };
  }

  const holdSignal = noulSignal(answers, DIRECTOR_HOLD_KEY);
  const scored: ScoredCandidate[] = candidates.flatMap((candidate) => {
    const progress = noulSignal(answers, `${DIRECTOR_PROGRESS_PREFIX}${candidate.candidateId}`);
    if (progress === null) return [];
    return [{ candidate, progress, priority: normalizedPriority(answers, `${DIRECTOR_PRIORITY_PREFIX}${candidate.candidateId}`) }];
  });

  const grounded = scored
    .filter((entry) => bandForConfidence(entry.progress, thresholds) === "act")
    .sort((left, right) => (right.priority - left.priority) || (right.progress - left.progress))
    .slice(0, maxBeats);
  if (grounded.length > 0) {
    return {
      band: "act", method: "candidates", hold: false,
      selections: grounded.map((entry) => ({ candidateId: entry.candidate.candidateId, digest: entry.candidate.digest })),
      topSignal: grounded[0]!.progress,
    };
  }

  // A confident hold ("a player decision is required now") outranks the aggregate
  // best-pick, but never a grounded, meaningful candidate above.
  if (holdSignal !== null && bandForConfidence(holdSignal, thresholds) === "act") {
    return { band: "act", method: "hold", hold: true, selections: [], topSignal: holdSignal };
  }

  // No candidate can advance the story (every advertised beat is a pacing beat) and a
  // player decision is not required now, so a grounded low-risk transition keeps the world
  // moving. Requiring every candidate to be pacing means a transition can never displace a
  // preferred mechanical beat; it is a fallback below `progress` and below a confident hold.
  const onlyPacing = candidates.every((candidate) => candidate.pacing === true);
  const transitioned = !onlyPacing ? [] : scored
    .filter((entry) => entry.candidate.pacing === true)
    .flatMap((entry) => {
      const transition = noulSignal(answers, `${DIRECTOR_TRANSITION_PREFIX}${entry.candidate.candidateId}`);
      return transition === null ? [] : [{ entry, transition }];
    })
    .filter((candidate) => bandForConfidence(candidate.transition, thresholds) === "act")
    .sort((left, right) => (right.entry.priority - left.entry.priority) || (right.transition - left.transition))
    .slice(0, maxBeats);
  if (transitioned.length > 0) {
    return {
      band: "act", method: "transition", hold: false,
      selections: transitioned.map(({ entry }) => ({ candidateId: entry.candidate.candidateId, digest: entry.candidate.digest })),
      topSignal: transitioned[0]!.transition,
    };
  }

  // Director beats mutate campaign state, so the aggregate pick must clear the action
  // threshold; a mere review-level pick defers.
  const best = answers[DIRECTOR_BEST_KEY];
  const bestTop = best && best.type === "choice" && best.choice !== DIRECTOR_NONE ? topProbability(best.probabilities) : null;
  const chosen = best && best.type === "choice" && best.choice !== DIRECTOR_NONE ? scored.find((entry) => entry.candidate.candidateId === best.choice) : undefined;
  if (best && best.type === "choice" && chosen && bestTop !== null && bestTop >= thresholds.actionThreshold) {
    return {
      band: "act", method: "best-pick", hold: false,
      selections: [{ candidateId: chosen.candidate.candidateId, digest: chosen.candidate.digest }],
      topSignal: bestTop,
    };
  }

  // The defer band reflects the strongest near-miss across the decisive signals only:
  // candidate progress (which failed to clear the action threshold) and hold. A
  // deferral never reports the `act` band, even after a near-miss.
  const strongest = Math.max(holdSignal ?? 0, bestTop ?? 0, ...scored.map((entry) => entry.progress));
  if (strongest === 0) {
    return { band: "fallback", method: "defer", hold: false, selections: [], topSignal: null };
  }
  const band = bandForConfidence(strongest, thresholds);
  return { band: band === "act" ? "confirm" : band, method: "defer", hold: false, selections: [], topSignal: strongest };
}
