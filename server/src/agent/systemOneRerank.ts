import type { SystemOneAnswer, SystemOneQuestions } from "../provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds } from "../types.js";
import { bandForConfidence, type SystemOneBand } from "./systemOnePolicy.js";

/**
 * L4 memory and clue reranking.
 *
 * Recall authorizes first; this lane only reorders an already-authorized, bounded shortlist.
 * It never sees or changes authorization, never drops a candidate, and never changes the
 * query, hit, whole-entry, or byte caps. The model contributes a per-candidate relevance
 * `score` and an "does this answer the query?" `noul`; the fused order blends those with the
 * existing deterministic rank using code-owned weights, so the deterministic rank is never
 * replaced outright.
 *
 * The lane is ADVISORY and has no active path: composition is recorded for evaluation only.
 */

/** Question key prefix for the per-candidate relevance `score`. */
export const RERANK_RELEVANCE_PREFIX = "relevance:";
/** Question key prefix for the per-candidate "answers the query?" `noul`. */
export const RERANK_ANSWERS_PREFIX = "answers:";

/** Ordered relevance levels; the score ranges over their zero-based indices. */
const RERANK_RELEVANCE_LEVELS = ["irrelevant", "loosely related", "relevant", "directly relevant"] as const;

/** One already-authorized recall candidate, with its deterministic rank position. */
export interface RerankCandidate {
  candidateId: string;
  label: string;
  text?: string;
  /** Zero-based deterministic rank position among the shortlist (0 = highest ranked). */
  rank: number;
}

export interface RerankInput {
  query: string;
  candidates: readonly RerankCandidate[];
}

/** Code-owned fusion weights; must sum to a positive value. */
export interface RerankWeights {
  deterministic: number;
  model: number;
}

/** Deterministic rank and model relevance weighted equally by default. */
export const DEFAULT_RERANK_WEIGHTS: RerankWeights = { deterministic: 0.5, model: 0.5 };

/** The advisory result of composing the rerank battery over model answers. */
export interface RerankComposition {
  /** Candidate ids in fused order; every input candidate is present. */
  order: string[];
  /** Fused score per candidate id (deterministic rank + normalized relevance). */
  fused: Record<string, number>;
  /** Normalized model relevance in [0, 1] per candidate id that was answered. */
  relevance: Record<string, number>;
  /** Whether the model judged each candidate to answer the query. */
  answers: Record<string, boolean>;
  /** Advisory confidence band for the reordering. */
  band: SystemOneBand;
  /** The strongest "answers the query?" signal reasoned over. */
  topSignal: number | null;
}

function renderCandidate(candidate: RerankCandidate): string {
  return candidate.text ? `${candidate.label}\n${candidate.text}` : candidate.label;
}

/**
 * Builds one relevance `score` and one "answers the query?" `noul` per candidate. The query and
 * the candidate text are embedded so every question is judged against the same authority.
 */
export function buildRerankQuestions(input: RerankInput): SystemOneQuestions {
  const query = input.query.trim() || "(empty query)";
  const questions: SystemOneQuestions = {};
  for (const candidate of input.candidates) {
    const item = renderCandidate(candidate);
    questions[`${RERANK_RELEVANCE_PREFIX}${candidate.candidateId}`] = {
      type: "score",
      instructions: `How relevant is this recalled item to the query? 0 = ${RERANK_RELEVANCE_LEVELS[0]}, 1 = ${RERANK_RELEVANCE_LEVELS[1]}, 2 = ${RERANK_RELEVANCE_LEVELS[2]}, 3 = ${RERANK_RELEVANCE_LEVELS[3]}.\nQuery: ${query}\nRecalled item:\n${item}`,
      criteria: [...RERANK_RELEVANCE_LEVELS],
    };
    questions[`${RERANK_ANSWERS_PREFIX}${candidate.candidateId}`] = {
      type: "noul",
      instructions: `Does this recalled item actually answer the query?\nQuery: ${query}\nRecalled item:\n${item}`,
      criteria: {
        true: "The item directly bears on and helps answer the query",
        false: "The item is related at most loosely, or does not address the query",
      },
    };
  }
  return questions;
}

function normalizeRelevance(score: number): number | null {
  if (!Number.isFinite(score)) return null;
  const max = RERANK_RELEVANCE_LEVELS.length - 1;
  return Math.max(0, Math.min(1, score / max));
}

function validSignal(signal: number): boolean {
  return Number.isFinite(signal) && signal >= 0 && signal <= 1;
}

/**
 * Fuses the model signals with the deterministic rank.
 *
 * `fused = deterministic * rankScore + model * relevance`, where `rankScore` is `1` for rank
 * 0 and `0` for the worst rank. The order sorts by descending fused score and breaks ties by
 * the deterministic rank, so an all-equal model response reproduces the deterministic order.
 * Every candidate is retained. A malformed or missing weight falls back to the defaults; a
 * non-positive total weight degenerates to the deterministic rank alone. Never throws.
 */
export function composeRerankOrder(
  input: RerankInput,
  answers: Record<string, SystemOneAnswer>,
  thresholds: SystemOneConfidenceThresholds,
  weights: RerankWeights = DEFAULT_RERANK_WEIGHTS,
): RerankComposition {
  const { candidates } = input;
  if (candidates.length === 0) {
    return { order: [], fused: {}, relevance: {}, answers: {}, band: "fallback", topSignal: null };
  }
  const deterministic = Number.isFinite(weights.deterministic) && weights.deterministic > 0 ? weights.deterministic : 0;
  const model = Number.isFinite(weights.model) && weights.model > 0 ? weights.model : 0;
  const totalWeight = deterministic + model;
  const maxRank = candidates.reduce((max, candidate) => Math.max(max, Number.isFinite(candidate.rank) ? candidate.rank : 0), 0);
  const rankScore = (rank: number): number => (maxRank <= 0 ? 1 : Math.max(0, Math.min(1, 1 - rank / maxRank)));

  const fused: Record<string, number> = {};
  const relevance: Record<string, number> = {};
  const answerMap: Record<string, boolean> = {};
  let usable = false;
  let sawAnswers = false;
  let maxAnswers = 0;

  for (const candidate of candidates) {
    const relevanceAnswer = answers[`${RERANK_RELEVANCE_PREFIX}${candidate.candidateId}`];
    const normalized = relevanceAnswer && relevanceAnswer.type === "score" ? normalizeRelevance(relevanceAnswer.score) : null;
    const answersAnswer = answers[`${RERANK_ANSWERS_PREFIX}${candidate.candidateId}`];
    const answersSignal = answersAnswer && answersAnswer.type === "noul" && validSignal(answersAnswer.noul) ? answersAnswer.noul : null;
    if (normalized !== null || answersSignal !== null) usable = true;
    const rank = Number.isFinite(candidate.rank) ? candidate.rank : 0;
    const rankValue = rankScore(rank);
    // An unanswered candidate keeps its deterministic score, so a partial model response
    // nudges the answered candidates without demoting the rest.
    const modelScore = normalized ?? rankValue;
    relevance[candidate.candidateId] = normalized ?? 0;
    answerMap[candidate.candidateId] = answersSignal !== null && bandForConfidence(answersSignal, thresholds) === "act";
    if (answersSignal !== null) {
      sawAnswers = true;
      maxAnswers = Math.max(maxAnswers, answersSignal);
    }
    fused[candidate.candidateId] = totalWeight <= 0
      ? rankValue
      : (deterministic * rankValue + model * modelScore) / totalWeight;
  }

  if (!usable) {
    return {
      order: candidates.map((candidate) => candidate.candidateId),
      fused: {},
      relevance: {},
      answers: {},
      band: "fallback",
      topSignal: null,
    };
  }

  const order = [...candidates]
    .sort((left, right) => (fused[right.candidateId] ?? -1) - (fused[left.candidateId] ?? -1) || left.rank - right.rank)
    .map((candidate) => candidate.candidateId);

  const band = maxAnswers >= thresholds.actionThreshold
    ? "act"
    : maxAnswers >= thresholds.reviewThreshold
      ? "confirm"
      : "fallback";

  return { order, fused, relevance, answers: answerMap, band, topSignal: sawAnswers ? maxAnswers : null };
}
