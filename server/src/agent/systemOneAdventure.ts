import type { SystemOneAnswer, SystemOneQuestions } from "../provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds } from "../types.js";
import { bandForConfidence, type SystemOneBand } from "./systemOnePolicy.js";

/**
 * L2 adventure exact-candidate selection.
 *
 * An adventure turn can commit only server-issued exact candidates, each already carrying an
 * opaque id and digest binding. This lane builds a speculative fan-out over the union of the
 * turn's advertised candidates: a `supported` noul ("does the declaration clearly describe
 * committing one of these?"), a relevance `score` per interchangeable candidate group, and one
 * aggregate `best_candidate` choice that collapses each group to its deterministic representative
 * (with a fail-closed `none_of_these`), so the model never sees indistinguishable duplicate
 * options. Code composes the answer: a candidate must be advertised, the aggregate choice must
 * name its group, and both the choice probability and the `supported` probability must clear the
 * same threshold band. The lane never adds, drops, or authorizes a candidate, and the existing
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

/** One equivalence group of interchangeable advertised candidates. */
interface AdventureSelectionGroup {
  /** The deterministic representative: the lowest candidateId in the group. */
  representative: AdventureSelectionCandidate;
  /** Every advertised candidate in the group, representative included. */
  members: readonly AdventureSelectionCandidate[];
}

/**
 * Interchangeable candidates commit through the same exact tool with the same server-issued
 * label; only their instance ids and digest bindings differ (for example several copies of one
 * stackable item). The key is the exact kind and label, so a lookalike label under a different
 * tool stays a separate candidate.
 */
function adventureSelectionGroupKey(candidate: AdventureSelectionCandidate): string {
  return JSON.stringify([candidate.kind, candidate.label]);
}

/**
 * Groups the advertised candidates by interchangeable identity, preserving the advertised order
 * of each group's first occurrence. Within a group the representative is the lowest candidateId,
 * so the collapse is deterministic no matter where the group's instances sit in the union.
 */
function adventureSelectionGroups(candidates: readonly AdventureSelectionCandidate[]): AdventureSelectionGroup[] {
  const byKey = new Map<string, AdventureSelectionCandidate[]>();
  for (const candidate of candidates) {
    const key = adventureSelectionGroupKey(candidate);
    const members = byKey.get(key);
    if (members) members.push(candidate);
    else byKey.set(key, [candidate]);
  }
  return [...byKey.values()].map((members) => {
    let representative = members[0]!;
    for (const member of members) {
      if (member.candidateId.localeCompare(representative.candidateId) < 0) representative = member;
    }
    return { representative, members };
  });
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
 * Builds one relevance `score` per interchangeable candidate group plus the aggregate
 * `supported` and `best_candidate` questions. Interchangeable duplicates collapse to one
 * deterministic representative (the lowest candidateId in the group), so the model never sees
 * indistinguishable options; the advertised state still carries every candidate. The declaration
 * is embedded so every question is judged against the same authority; candidate labels stay
 * server-issued and are never rewritten by the model.
 */
export function buildAdventureSelectionQuestions(
  declaration: string,
  candidates: readonly AdventureSelectionCandidate[],
): SystemOneQuestions {
  const text = declaration.trim() || "(empty declaration)";
  const groups = adventureSelectionGroups(candidates);
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
  for (const { representative } of groups) {
    questions[`${ADVENTURE_RELEVANCE_PREFIX}${representative.candidateId}`] = {
      type: "score",
      instructions: `How closely does the declaration match this advertised candidate? 0 = ${ADVENTURE_RELEVANCE_LEVELS[0]}, 1 = ${ADVENTURE_RELEVANCE_LEVELS[1]}, 2 = ${ADVENTURE_RELEVANCE_LEVELS[2]}, 3 = ${ADVENTURE_RELEVANCE_LEVELS[3]}.\nDeclaration: ${text}\nAdvertised candidate: ${representative.label} (${representative.kind})`,
      criteria: [...ADVENTURE_RELEVANCE_LEVELS],
    };
  }
  const criteria: Record<string, string | null> = {};
  for (const { representative } of groups) criteria[representative.candidateId] = `${representative.label} (${representative.kind})`;
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

function relevanceScore(answers: Record<string, SystemOneAnswer>, candidateId: string): number | null {
  const answer = answers[`${ADVENTURE_RELEVANCE_PREFIX}${candidateId}`];
  if (!answer || answer.type !== "score" || !Number.isFinite(answer.score)) return null;
  return Math.max(0, Math.min(1, answer.score / (ADVENTURE_RELEVANCE_LEVELS.length - 1)));
}

/**
 * The normalized relevance `score` for one candidate, used for ranking and observability.
 *
 * Interchangeable candidates share one relevance question, keyed by the group's representative,
 * so a non-representative member has no answer of its own. When the advertised candidates are
 * supplied, every member of a group resolves to its representative's answer; without them only
 * an exact answer key resolves, because the recorded answers alone cannot identify the group.
 */
export function adventureCandidateRelevance(
  answers: Record<string, SystemOneAnswer>,
  candidateId: string,
  candidates?: readonly AdventureSelectionCandidate[],
): number | null {
  const direct = relevanceScore(answers, candidateId);
  if (direct !== null) return direct;
  if (candidates === undefined) return null;
  const group = adventureSelectionGroups(candidates)
    .find(({ members }) => members.some((member) => member.candidateId === candidateId));
  if (!group || group.representative.candidateId === candidateId) return null;
  return relevanceScore(answers, group.representative.candidateId);
}

/**
 * Composes an exact-candidate selection from the battery.
 *
 * 1. With no advertised candidates there is nothing to select, so the lane defers.
 * 2. The aggregate choice must name an advertised candidate (never `none_of_these`, never an
 *    undeclared id). Interchangeable instances collapse to their group's deterministic
 *    representative, so the selection is always the representative id with its own digest.
 * 3. The lane is only as confident as the weaker of the two independent claims — the
 *    declaration supports some advertised candidate (`supported`) and this is the best one
 *    (the choice's probability mass for the option it named) — so the combined signal is
 *    their minimum. An act band selects; a confirm band records a lower-confidence
 *    selection; anything below defers.
 * 4. Otherwise the lane defers and the caller keeps its existing deterministic selection.
 *
 * The caller re-validates the representative's digest before any commit, so collapsing adds no
 * authority: it only removes indistinguishable duplicates from the battery.
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
  // A named representative resolves to its own group; a named interchangeable member resolves to
  // the same group's representative, so every instance composes to one id and digest.
  const group = adventureSelectionGroups(candidates)
    .find(({ members }) => members.some((entry) => entry.candidateId === best.choice));
  if (!group) {
    return { band: "fallback", method: "defer", selection: null, topSignal: null };
  }
  const candidate = group.representative;
  const supported = noulSignal(answers, ADVENTURE_SUPPORTED_KEY);
  if (supported === null) {
    return { band: "fallback", method: "defer", selection: null, topSignal: null };
  }
  // The confidence in the selection is the probability the model assigned to the option it
  // named, not the distribution maximum: a flat split with a large `none_of_these` must not
  // masquerade as confidence in a weak pick.
  const chosenProbability = best.probabilities[best.choice];
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
