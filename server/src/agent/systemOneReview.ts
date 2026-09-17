import type { SystemOneDecisionRecord } from "../repo/systemOneDecisionRepo.js";

/**
 * Read-only review path over the immutable System One decision log.
 *
 * A lane records a would-be decision for every turn it participates in, but only a
 * human can say whether a decisive call was actually right. This module turns a
 * window of decision records into a deterministic review queue ordered
 * uncertain-first, applies human verdicts, and renders a sheet a reviewer can work
 * from. It is pure formatting and selection: no I/O, no network, and it never
 * mutates the log. A verdict of `incorrect` is the raw material for a negative
 * example in the lane's evaluation corpus.
 */

/** A human verdict on one decisive decision. */
export type ReviewVerdict = "correct" | "incorrect";

export interface ReviewQueueOptions {
  /** Only include decisions for this lane id. */
  lane?: string;
  /** Maximum number of candidates, clamped to 1..200. Defaults to 20. */
  limit?: number;
  /** Only include candidates whose recorded top signal is a finite value <= this bound. */
  maxSignal?: number;
  /**
   * Also include `fallback` decisions whose selection carries a non-empty `flags`
   * array (for example a narration hazard). Off by default, so the queue is the
   * set of decisions that took a positive stance.
   */
  includeFlaggedFallbacks?: boolean;
}

/** One decision selected for human review, with its raw payloads unredacted. */
export interface ReviewCandidate {
  decisionId: string;
  lane: string;
  createdAt: string;
  confidenceBand: SystemOneDecisionRecord["confidenceBand"];
  shadow: boolean;
  fallbackUsed: boolean;
  /** The calibrated signal recorded in `selection.topSignal`, or null when absent. */
  topSignal: number | null;
  selection: unknown;
  state: unknown;
  questions: unknown;
  answers: unknown;
}

export interface AnnotatedReviewCandidate extends ReviewCandidate {
  verdict: ReviewVerdict | null;
}

export interface ReviewSummary {
  total: number;
  reviewed: number;
  correct: number;
  incorrect: number;
  unjudged: number;
  /** Lane ids with at least one `incorrect` verdict, sorted. */
  incorrectLanes: string[];
  /** Decision ids marked `incorrect`, in queue order. */
  incorrectDecisionIds: string[];
}

export const DEFAULT_REVIEW_LIMIT = 20;
export const MAX_REVIEW_LIMIT = 200;

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_REVIEW_LIMIT;
  return Math.max(1, Math.min(MAX_REVIEW_LIMIT, Math.trunc(limit)));
}

function topSignalOf(selection: unknown): number | null {
  if (selection === null || typeof selection !== "object") return null;
  const value = (selection as { topSignal?: unknown }).topSignal;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasFlags(selection: unknown): boolean {
  if (selection === null || typeof selection !== "object") return false;
  const flags = (selection as { flags?: unknown }).flags;
  return Array.isArray(flags) && flags.length > 0;
}

/**
 * Selects the decisions worth human review, ordered uncertain-first.
 *
 * A decision is a candidate when it took a positive stance (`act`), or — only when
 * `includeFlaggedFallbacks` is set — when it is a `fallback` carrying hazard flags.
 * `maxSignal` drops candidates whose signal is missing or above the bound. The result
 * is sorted by ascending signal (missing last), then created-at, then id, and sliced
 * to the bounded limit.
 */
export function reviewCandidates(
  records: readonly SystemOneDecisionRecord[],
  options: ReviewQueueOptions = {},
): ReviewCandidate[] {
  const limit = clampLimit(options.limit ?? DEFAULT_REVIEW_LIMIT);
  const includeFlagged = options.includeFlaggedFallbacks === true;
  return records
    .filter((record) => options.lane === undefined || record.lane === options.lane)
    .filter((record) => record.confidenceBand === "act"
      || (includeFlagged && record.confidenceBand === "fallback" && hasFlags(record.selection)))
    .map((record) => ({
      decisionId: record.decisionId,
      lane: record.lane,
      createdAt: record.createdAt,
      confidenceBand: record.confidenceBand,
      shadow: record.shadow,
      fallbackUsed: record.fallbackUsed,
      topSignal: topSignalOf(record.selection),
      selection: record.selection,
      state: record.state,
      questions: record.questions,
      answers: record.answers,
    }))
    .filter((candidate) => options.maxSignal === undefined
      || (candidate.topSignal !== null && candidate.topSignal <= options.maxSignal))
    .sort((left, right) => (left.topSignal ?? 1) - (right.topSignal ?? 1)
      || left.createdAt.localeCompare(right.createdAt)
      || left.decisionId.localeCompare(right.decisionId))
    .slice(0, limit);
}

/** Attaches a human verdict to each candidate; unknown ids and invalid verdicts are ignored. */
export function applyReviewAnnotations(
  candidates: readonly ReviewCandidate[],
  annotations: Readonly<Record<string, ReviewVerdict>>,
): AnnotatedReviewCandidate[] {
  return candidates.map((candidate) => {
    const verdict = annotations[candidate.decisionId];
    return { ...candidate, verdict: verdict === "correct" || verdict === "incorrect" ? verdict : null };
  });
}

/** Counts the human verdicts in a review queue. */
export function summarizeReview(candidates: readonly AnnotatedReviewCandidate[]): ReviewSummary {
  const incorrect = candidates.filter((candidate) => candidate.verdict === "incorrect");
  return {
    total: candidates.length,
    reviewed: candidates.filter((candidate) => candidate.verdict !== null).length,
    correct: candidates.filter((candidate) => candidate.verdict === "correct").length,
    incorrect: incorrect.length,
    unjudged: candidates.filter((candidate) => candidate.verdict === null).length,
    incorrectLanes: [...new Set(incorrect.map((candidate) => candidate.lane))].sort(),
    incorrectDecisionIds: incorrect.map((candidate) => candidate.decisionId),
  };
}

const MAX_RENDERED_JSON_CHARS = 4_000;

function boundedJson(value: unknown): string {
  const rendered = JSON.stringify(value, null, 2) ?? "null";
  if (rendered.length <= MAX_RENDERED_JSON_CHARS) return rendered;
  return `${rendered.slice(0, MAX_RENDERED_JSON_CHARS)}\n… (truncated at ${MAX_RENDERED_JSON_CHARS} chars)`;
}

function formatSignal(value: number | null): string {
  return value === null ? "—" : value.toFixed(4);
}

/**
 * Renders a deterministic review sheet: the queue summary, one row per candidate,
 * and a detail block per candidate with its raw selection, state, questions, and
 * answers so a reviewer can judge and copy the case into a corpus.
 */
export function renderReviewSheet(
  candidates: readonly AnnotatedReviewCandidate[],
  options: { generatedAt?: string; source?: string } = {},
): string {
  const summary = summarizeReview(candidates);
  const lines: string[] = [];
  lines.push("# System One decision review sheet");
  lines.push("");
  if (options.generatedAt) lines.push(`Generated ${options.generatedAt} by \`scripts/review-system-one-decisions.ts\`.`);
  if (options.source) lines.push(`Source: ${options.source}.`);
  if (options.generatedAt || options.source) lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Candidates: ${summary.total}`);
  lines.push(`- Reviewed: ${summary.reviewed} (${summary.correct} correct, ${summary.incorrect} incorrect, ${summary.unjudged} unjudged)`);
  lines.push(`- Lanes with an incorrect verdict: ${summary.incorrectLanes.length > 0 ? summary.incorrectLanes.join(", ") : "—"}`);
  lines.push("");
  lines.push("## Queue");
  lines.push("");
  lines.push("| # | Decision | Lane | Band | Signal | Shadow | Verdict |");
  lines.push("| ---: | --- | --- | --- | ---: | --- | --- |");
  candidates.forEach((candidate, index) => {
    lines.push(`| ${index + 1} | ${candidate.decisionId} | ${candidate.lane} | ${candidate.confidenceBand}`
      + ` | ${formatSignal(candidate.topSignal)} | ${candidate.shadow ? "yes" : "no"} | ${candidate.verdict ?? "unjudged"} |`);
  });
  lines.push("");
  lines.push("## Decisions");
  lines.push("");
  for (const candidate of candidates) {
    lines.push(`### ${candidate.decisionId}`);
    lines.push("");
    lines.push(`- Lane: ${candidate.lane}`);
    lines.push(`- Created: ${candidate.createdAt}`);
    lines.push(`- Band: ${candidate.confidenceBand}`);
    lines.push(`- Shadow: ${candidate.shadow ? "yes" : "no"}`);
    lines.push(`- Fallback used: ${candidate.fallbackUsed ? "yes" : "no"}`);
    lines.push(`- Signal: ${formatSignal(candidate.topSignal)}`);
    lines.push(`- Verdict: ${candidate.verdict ?? "unjudged"}`);
    lines.push("");
    lines.push("Selection:");
    lines.push("");
    lines.push("```json");
    lines.push(boundedJson(candidate.selection));
    lines.push("```");
    lines.push("");
    lines.push("State:");
    lines.push("");
    lines.push("```json");
    lines.push(boundedJson(candidate.state));
    lines.push("```");
    lines.push("");
    lines.push("Questions:");
    lines.push("");
    lines.push("```json");
    lines.push(boundedJson(candidate.questions));
    lines.push("```");
    lines.push("");
    lines.push("Answers:");
    lines.push("");
    lines.push("```json");
    lines.push(boundedJson(candidate.answers));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}
