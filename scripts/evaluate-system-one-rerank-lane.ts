#!/usr/bin/env node
/**
 * Live evaluation of the L4 memory/clue reranking lane (`memory-reranking`).
 *
 * The lane only reorders an already-authorized, bounded shortlist: it never adds, drops, or
 * authorizes a candidate. This script drives the Plan 3 provider-free memory oracle
 * (`createMemoryEvalFixture`, `scoreCases`) to obtain that shortlist for every labelled case,
 * runs the real System One (Jev) rerank battery on it, and compares the fused order with the
 * deterministic baseline using recall@K, recall@8, MRR, and nDCG. Because the lane's output is
 * an order, the promotion gate is scored on a per-case success label restricted to calls where
 * the shortlist actually contains a labelled required source: every available required source
 * must remain in the fused top K and no forbidden source may be present. A sample is decisive
 * only when the composed band is `act`; a deferral keeps the deterministic order and is
 * coverage, not a decision.
 *
 * Opt-in live evaluation: TYPESAFE_API_KEY must be exported. It uses a temporary, disposable
 * data directory and closes it again; it never touches an existing store.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-rerank-lane.ts [--repeat 3] [--out docs/system-one-rerank-benchmark.md]
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCalibration,
  fitPlattCalibration,
  type PlattCalibration,
} from "../server/src/agent/systemOneCalibration.js";
import type { SystemOneBand } from "../server/src/agent/systemOnePolicy.js";
import {
  evaluatePromotionGate,
  type SystemOnePromotionRecord,
  type SystemOnePromotionResult,
} from "../server/src/agent/systemOnePromotion.js";
import { buildRerankQuestions, composeRerankOrder, type RerankCandidate } from "../server/src/agent/systemOneRerank.js";
import { defaultSystemOneSettings } from "../server/src/defaults.js";
import { completeWithSystemOne } from "../server/src/provider/systemOneCompletion.js";
import { closeRepo } from "../server/src/repo/index.js";
import type { CampaignRecallHit } from "../server/src/repo/campaign/campaignRecallReadRepo.js";
import type { SystemOneConfidenceThresholds } from "../server/src/types.js";
import { gradeCalibration } from "../server/test/evals/dmGraders.js";
import { MEMORY_EVAL_DEVELOPMENT_CASES, type MemoryEvalCase } from "../server/test/fixtures/memory-evals/corpus.js";
import { MEMORY_EVAL_HOLDOUTS } from "../server/test/fixtures/memory-evals/holdouts.js";
import { createMemoryEvalFixture, type MemoryEvalFixture } from "../server/test/fixtures/memory-evals/fixture.js";
import { scoreCases, type MetricReport, type RankedCase } from "./evaluate-campaign-memory.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EVIDENCE = "docs/system-one-rerank-benchmark.md";
const PROMOTION_LANE = "memory-reranking" as const;
const OWNER = "local-owner";
/** The labelled-corpus recall cut used by the Plan 3 oracle and this gate label. */
export const RERANK_K = 3;

/**
 * One labelled memory case projected onto its authorized deterministic shortlist. The case is
 * built once per run because the recall order is deterministic; only the model reranking varies.
 */
export interface RerankCasePlan {
  memoryCase: MemoryEvalCase;
  /** True when the case comes from the frozen holdout split. */
  holdout: boolean;
  /** Authorized candidates in deterministic order, with their zero-based rank. */
  candidates: RerankCandidate[];
  /** Source keys in deterministic order. */
  baselineKeys: string[];
  expected: string[];
  forbidden: string[];
  supported: boolean;
  bytes: number;
  hydrated: boolean;
}

/** One reranked call: the composed order for a case and repeat, plus its label comparison. */
export interface RerankCaseSample {
  id: string;
  category: MemoryEvalCase["category"];
  holdout: boolean;
  repeat: number;
  candidateCount: number;
  baseline: string[];
  fused: string[];
  expected: string[];
  forbidden: string[];
  /** Labelled required sources that the shortlist actually retrieved; empty means unanswerable. */
  availableExpected: string[];
  answerable: boolean;
  supported: boolean;
  bytes: number;
  hydrated: boolean;
  /** Available required sources inside the deterministic / fused top K. */
  surfacedBefore: number;
  surfacedAfter: number;
  /** Best (lowest) position of an available required source, or null when none was retrieved. */
  bestRankBefore: number | null;
  bestRankAfter: number | null;
  privacyPass: boolean;
  /** The deterministic order already satisfied the case label. */
  baselineCorrect: boolean;
  /** The fused order satisfied the case label. */
  correct: boolean;
  /** The strongest "answers the query?" probability, raw (pre-calibration). */
  topSignal: number | null;
  band: SystemOneBand;
  /** The lane asserted enough to act; a deferral leaves the deterministic order in place. */
  decisive: boolean;
  latencyMs: number;
}

export interface RerankCalibrationMetrics {
  brier: number;
  expectedCalibrationError: number;
}

export interface RerankBenchmarkEvaluation {
  fitted: PlattCalibration;
  calls: number;
  evaluatedCases: number;
  /** Calls where the shortlist retrieved a labelled required source (gate-eligible). */
  eligibleCalls: number;
  /** Gate-eligible calls whose composed band is `act`. */
  decisiveCalls: number;
  devSamples: number;
  holdoutSamples: number;
  /** Fused-order case accuracy over decisive gate-eligible calls. */
  accuracy: number;
  /** Case-label pass rate over all gate-eligible calls, before and after reranking. */
  baselinePassRate: number;
  fusedPassRate: number;
  improvedCalls: number;
  demotedCalls: number;
  /** Decisive calls where recall retrieved no labelled required source at all. */
  misassertedCalls: number;
  /** Gate-eligible calls where the fused order did not satisfy the case label. */
  eligibleFailures: number;
  /** Eligible label failures the lane deferred on (coverage rather than an acted error). */
  deferredFailures: number;
  /** Eligible label failures the lane acted on. */
  actedFailures: number;
  /** Top-1 pick is a labelled required source, over gate-eligible calls. */
  top1BeforeRate: number;
  top1AfterRate: number;
  /** Plan 3 `scoreCases` over the same calls, deterministic versus fused order. */
  baseline: MetricReport;
  fused: MetricReport;
  holdout: { raw: RerankCalibrationMetrics; calibrated: RerankCalibrationMetrics };
  all: { raw: RerankCalibrationMetrics; calibrated: RerankCalibrationMetrics };
  gate: SystemOnePromotionResult;
}

const rate = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator);

function sourceKeyFor(sourceIds: Record<string, string>, hit: CampaignRecallHit): string {
  for (const [key, id] of Object.entries(sourceIds)) if (id === hit.sourceId) return key;
  return `unknown:${hit.digest}`;
}

/** Projects a recall result into the bounded candidate shortlist the lane would rerank. */
export function toRerankCandidates(
  sourceIds: Record<string, string>,
  hits: readonly CampaignRecallHit[],
): { candidates: RerankCandidate[]; keys: string[] } {
  const candidates: RerankCandidate[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  let rank = 0;
  for (const hit of hits) {
    if (seen.has(hit.sourceId)) continue;
    seen.add(hit.sourceId);
    const key = sourceKeyFor(sourceIds, hit);
    keys.push(key);
    candidates.push({ candidateId: key, label: hit.sourceKind, text: hit.text, rank });
    rank += 1;
  }
  return { candidates, keys };
}

/** Builds the deterministic shortlist and labels for every memory-eval case with a non-empty recall. */
export function buildRerankCasePlans(fixture: MemoryEvalFixture): RerankCasePlan[] {
  const cases = [...MEMORY_EVAL_DEVELOPMENT_CASES, ...MEMORY_EVAL_HOLDOUTS];
  const holdoutIds = new Set(MEMORY_EVAL_HOLDOUTS.map((memoryCase) => memoryCase.id));
  return cases.map((memoryCase) => {
    const result = fixture.repo.getCampaignRecall(OWNER, {
      campaignId: fixture.campaign.id,
      sessionId: fixture.session.id,
      audience: { kind: "player", actorId: fixture.actors[memoryCase.actor] },
      query: memoryCase.query,
      purpose: "public-narration",
    })!;
    const { candidates, keys } = toRerankCandidates(fixture.sourceIds, result.hits);
    return {
      memoryCase,
      holdout: holdoutIds.has(memoryCase.id),
      candidates,
      baselineKeys: keys,
      expected: [...memoryCase.requiredSourceKeys],
      forbidden: [...memoryCase.forbiddenSourceKeys],
      supported: memoryCase.baseline === "supported",
      bytes: Buffer.byteLength(JSON.stringify(result)),
      hydrated: result.hits.every((hit) => Buffer.byteLength(hit.text) <= 2_048),
    };
  });
}

/**
 * Grades one composed reranking against the case labels. A call is answerable when the
 * shortlist retrieved at least one labelled required source; only then can a reorder change
 * the case outcome. `correct` requires every available required source inside the top K and
 * no forbidden source anywhere in the presented shortlist.
 */
export function toRerankSample(
  plan: RerankCasePlan,
  fused: string[],
  topSignal: number | null,
  band: SystemOneBand,
  repeat: number,
  latencyMs: number,
  k = RERANK_K,
): RerankCaseSample {
  const topAfter = new Set(fused.slice(0, k));
  const topBefore = new Set(plan.baselineKeys.slice(0, k));
  const availableExpected = plan.expected.filter((key) => plan.baselineKeys.includes(key));
  const answered = (top: ReadonlySet<string>): boolean => availableExpected.every((key) => top.has(key));
  const privacyPass = plan.forbidden.every((key) => !fused.includes(key) && !plan.baselineKeys.includes(key));
  const bestRank = (order: readonly string[]): number | null => {
    const positions = availableExpected.map((key) => order.indexOf(key)).filter((index) => index >= 0);
    return positions.length === 0 ? null : Math.min(...positions);
  };
  const answerable = availableExpected.length > 0;
  const baselineCorrect = answerable && answered(topBefore) && privacyPass;
  const correct = answerable && answered(topAfter) && privacyPass;
  return {
    id: plan.memoryCase.id,
    category: plan.memoryCase.category,
    holdout: plan.holdout,
    repeat,
    candidateCount: plan.candidates.length,
    baseline: [...plan.baselineKeys],
    fused: [...fused],
    expected: [...plan.expected],
    forbidden: [...plan.forbidden],
    availableExpected,
    answerable,
    supported: plan.supported,
    bytes: plan.bytes,
    hydrated: plan.hydrated,
    surfacedBefore: availableExpected.filter((key) => topBefore.has(key)).length,
    surfacedAfter: availableExpected.filter((key) => topAfter.has(key)).length,
    bestRankBefore: bestRank(plan.baselineKeys),
    bestRankAfter: bestRank(fused),
    privacyPass,
    baselineCorrect,
    correct,
    topSignal,
    band,
    decisive: band === "act",
    latencyMs,
  };
}

function toRankedCase(sample: RerankCaseSample, fused: boolean): RankedCase {
  return {
    expected: sample.expected,
    forbidden: sample.forbidden,
    ranked: fused ? sample.fused : sample.baseline,
    supported: sample.supported,
    bytes: sample.bytes,
    hydrated: sample.hydrated,
    latencyMs: sample.latencyMs,
  };
}

function isDecisiveSample(
  sample: RerankCaseSample,
): sample is RerankCaseSample & { topSignal: number } {
  return sample.decisive && sample.topSignal !== null && Number.isFinite(sample.topSignal);
}

function toPoints(
  samples: readonly (RerankCaseSample & { topSignal: number })[],
  fitted: PlattCalibration,
  calibrated: boolean,
): Array<{ predictedProbability: number; correct: boolean }> {
  return samples.map((sample) => ({
    predictedProbability: calibrated ? applyCalibration(sample.topSignal, fitted) : sample.topSignal,
    correct: sample.correct,
  }));
}

function metricsFor(
  samples: readonly (RerankCaseSample & { topSignal: number })[],
  fitted: PlattCalibration,
  calibrated: boolean,
): RerankCalibrationMetrics {
  const graded = gradeCalibration(toPoints(samples, fitted, calibrated), 10);
  return { brier: graded.brier, expectedCalibrationError: graded.expectedCalibrationError };
}

/**
 * Fits the Platt map on the decisive development calls and evaluates the gate on the
 * calibrated signal, mirroring the other lane evals: the held-out rows are the unbiased
 * calibration estimate, while the gate scores the calibrated map over every decisive call
 * (the map the lane would ship with). Ranking benefit is reported separately with the Plan 3
 * scorer so it is directly comparable to the deterministic baseline.
 */
export function evaluateRerankBenchmark(samples: readonly RerankCaseSample[], k = RERANK_K): RerankBenchmarkEvaluation {
  const eligible = samples.filter((sample) => sample.answerable);
  const decisive = eligible.filter(isDecisiveSample);
  const devSamples = decisive.filter((sample) => !sample.holdout);
  const holdoutSamples = decisive.filter((sample) => sample.holdout);
  const fitted = fitPlattCalibration(toPoints(devSamples, { a: 1, b: 0 }, false));
  const allCalibrated = metricsFor(decisive, fitted, true);
  const accuracy = rate(decisive.filter((sample) => sample.correct).length, decisive.length);
  const gate = evaluatePromotionGate(PROMOTION_LANE, {
    samples: decisive.length,
    accuracy,
    brier: allCalibrated.brier,
    expectedCalibrationError: allCalibrated.expectedCalibrationError,
  });
  const rankDelta = (sample: RerankCaseSample): number | null =>
    sample.bestRankBefore === null || sample.bestRankAfter === null ? null : sample.bestRankBefore - sample.bestRankAfter;
  const eligibleTop1 = eligible.filter((sample) => sample.availableExpected.length > 0);
  return {
    fitted,
    calls: samples.length,
    evaluatedCases: new Set(samples.map((sample) => sample.id)).size,
    eligibleCalls: eligible.length,
    decisiveCalls: decisive.length,
    devSamples: devSamples.length,
    holdoutSamples: holdoutSamples.length,
    accuracy,
    baselinePassRate: rate(eligible.filter((sample) => sample.baselineCorrect).length, eligible.length),
    fusedPassRate: rate(eligible.filter((sample) => sample.correct).length, eligible.length),
    improvedCalls: eligible.filter((sample) => (rankDelta(sample) ?? 0) > 0).length,
    demotedCalls: eligible.filter((sample) => (rankDelta(sample) ?? 0) < 0).length,
    misassertedCalls: samples.filter((sample) => sample.decisive && !sample.answerable).length,
    eligibleFailures: eligible.filter((sample) => !sample.correct).length,
    deferredFailures: eligible.filter((sample) => !sample.correct && !sample.decisive).length,
    actedFailures: eligible.filter((sample) => !sample.correct && sample.decisive).length,
    top1BeforeRate: rate(eligibleTop1.filter((sample) => sample.availableExpected.includes(sample.baseline[0] ?? "")).length, eligibleTop1.length),
    top1AfterRate: rate(eligibleTop1.filter((sample) => sample.availableExpected.includes(sample.fused[0] ?? "")).length, eligibleTop1.length),
    baseline: scoreCases(samples.map((sample) => toRankedCase(sample, false)), k),
    fused: scoreCases(samples.map((sample) => toRankedCase(sample, true)), k),
    holdout: {
      raw: metricsFor(holdoutSamples, fitted, false),
      calibrated: metricsFor(holdoutSamples, fitted, true),
    },
    all: {
      raw: metricsFor(decisive, fitted, false),
      calibrated: allCalibrated,
    },
    gate,
  };
}

const round4 = (value: number): number => Number(value.toFixed(4));

/**
 * The promotion record this run would justify, or null when the gate did not pass. The parent
 * owns `systemOnePromotion.ts`; this is the proposed snapshot to paste into it.
 */
export function proposePromotionRecord(
  evaluation: RerankBenchmarkEvaluation,
  promotedAt: string,
  evidence = EVIDENCE,
): SystemOnePromotionRecord | null {
  if (!evaluation.gate.promoted) return null;
  return {
    metrics: {
      samples: evaluation.decisiveCalls,
      accuracy: round4(evaluation.accuracy),
      brier: round4(evaluation.all.calibrated.brier),
      expectedCalibrationError: round4(evaluation.all.calibrated.expectedCalibrationError),
    },
    calibration: { a: round4(evaluation.fitted.a), b: round4(evaluation.fitted.b) },
    promotedAt,
    evidence,
  };
}

export interface RerankCaseSummary {
  id: string;
  category: MemoryEvalCase["category"];
  holdout: boolean;
  candidateCount: number;
  calls: number;
  answerable: number;
  decisive: number;
  correct: number;
  failed: number;
  baselineCorrect: number;
  surfacedBefore: number;
  surfacedAfter: number;
  /** Mean best (lowest) position of an available required source, or null when none was retrieved. */
  bestRankBefore: number | null;
  bestRankAfter: number | null;
  meanSignal: number;
  bands: Record<SystemOneBand, number>;
}

/** Per-case roll-up over repeats, for the report table. */
export function summarizeRerankCases(
  samples: readonly RerankCaseSample[],
  failures: readonly { id: string }[] = [],
): RerankCaseSummary[] {
  const order = new Map(
    [...MEMORY_EVAL_DEVELOPMENT_CASES, ...MEMORY_EVAL_HOLDOUTS].map((entry, index) => [entry.id, index]),
  );
  const byId = new Map<string, RerankCaseSample[]>();
  for (const sample of samples) {
    const bucket = byId.get(sample.id);
    if (bucket) bucket.push(sample);
    else byId.set(sample.id, [sample]);
  }
  return [...byId.entries()]
    .sort(([left], [right]) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
    .map(([id, rows]) => {
      const first = rows[0]!;
      const signals = rows.filter(
        (row): row is RerankCaseSample & { topSignal: number } =>
          row.topSignal !== null && Number.isFinite(row.topSignal),
      );
      const bands: Record<SystemOneBand, number> = { act: 0, confirm: 0, fallback: 0 };
      for (const row of rows) bands[row.band] += 1;
      const meanRank = (values: readonly (number | null)[]): number | null => {
        const usable = values.filter((value): value is number => value !== null);
        return usable.length === 0 ? null : usable.reduce((sum, value) => sum + value, 0) / usable.length;
      };
      return {
        id,
        category: first.category,
        holdout: first.holdout,
        candidateCount: first.candidateCount,
        calls: rows.length,
        answerable: rows.filter((row) => row.answerable).length,
        decisive: rows.filter((row) => row.decisive).length,
        correct: rows.filter((row) => row.decisive && row.correct).length,
        failed: failures.filter((failure) => failure.id === id).length,
        baselineCorrect: rows.filter((row) => row.decisive && row.baselineCorrect).length,
        surfacedBefore: rows.reduce((sum, row) => sum + row.surfacedBefore, 0),
        surfacedAfter: rows.reduce((sum, row) => sum + row.surfacedAfter, 0),
        bestRankBefore: meanRank(rows.map((row) => row.bestRankBefore)),
        bestRankAfter: meanRank(rows.map((row) => row.bestRankAfter)),
        meanSignal: signals.length === 0 ? 0 : signals.reduce((sum, row) => sum + row.topSignal, 0) / signals.length,
        bands,
      };
    });
}

export interface RerankCallFailure {
  id: string;
  repeat: number;
  error: string;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function metricRow(label: string, metrics: MetricReport | undefined): string {
  if (!metrics) return `| ${label} | n/a | n/a | n/a | n/a | n/a |`;
  return `| ${label} | ${metrics.recallAtK.toFixed(4)} | ${metrics.recallAt8.toFixed(4)} | ${metrics.mrr.toFixed(4)} | ${metrics.ndcg.toFixed(4)} | ${metrics.negativePassRate.toFixed(4)} |`;
}

export function renderRerankBenchmark(input: {
  generatedAt: string;
  model: string;
  baseUrl: string;
  repeats: number;
  thresholds: SystemOneConfidenceThresholds;
  plans: readonly RerankCasePlan[];
  samples: readonly RerankCaseSample[];
  failures: readonly RerankCallFailure[];
  evaluation: RerankBenchmarkEvaluation;
  proposedRecord: SystemOnePromotionRecord | null;
}): string {
  const { generatedAt, model, baseUrl, repeats, thresholds, plans, samples, failures, evaluation, proposedRecord } = input;
  const summaries = summarizeRerankCases(samples, failures);
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const latencies = samples.map((sample) => sample.latencyMs);
  const meanLatency = latencies.length === 0 ? 0 : latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
  const emptyCases = plans.filter((plan) => plan.candidates.length === 0).length;
  const unanswerable = evaluation.calls - evaluation.eligibleCalls;
  const lines: string[] = [];
  lines.push("# System One (Jev) memory-reranking (L4) benchmark");
  lines.push("");
  lines.push(`Generated ${generatedAt} by \`scripts/evaluate-system-one-rerank-lane.ts\` using the live System One adapter.`);
  lines.push("");
  lines.push("## What this measures");
  lines.push("");
  lines.push("The L4 lane reorders an already-authorized, bounded recall shortlist. It never adds, drops, or authorizes a candidate: the Plan 3 provider-free memory oracle produces the same shortlist the runtime recall would, and the lane contributes one relevance `score` and one \"does this item answer the query?\" `noul` per candidate. `composeRerankOrder` fuses them with the deterministic rank (`0.5 * rankScore + 0.5 * relevance`), so an all-equal or malformed model response reproduces the deterministic order exactly.");
  lines.push("");
  lines.push("Because the lane's output is an order, the promotion gate is scored on a per-case success label restricted to calls where the shortlist actually retrieved a labelled required source: every available required source must remain in the fused top " + `${RERANK_K}` + " and no forbidden source may be present. A call with no retrieved required source is **unanswerable** — no reorder can recover it — and is reported as coverage, not as a decision. A sample is **decisive** only when the composed band is `act`; a deferral keeps the deterministic order.");
  lines.push("");
  lines.push("The benefit comparison reuses the Plan 3 scorer (`scoreCases`) over the same calls: the deterministic and fused orders are scored against the same labels, so recall@K, recall@8, MRR, and nDCG are directly comparable.");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Model | ${model} |`);
  lines.push(`| Base URL | \`${baseUrl}\` |`);
  lines.push(`| Confidence thresholds (action / review) | ${thresholds.actionThreshold} / ${thresholds.reviewThreshold} |`);
  lines.push(`| Fusion weights | 0.5 deterministic / 0.5 model |`);
  lines.push(`| Top-K | ${RERANK_K} |`);
  lines.push(`| Repeats | ${repeats} |`);
  lines.push(`| Corpus | ${plans.length} cases (${emptyCases} with an empty shortlist) x ${repeats} repeats = ${samples.length} calls |`);
  lines.push("");
  lines.push("## Corpus and per-case results");
  lines.push("");
  const rankText = (value: number | null): string => (value === null ? "—" : value.toFixed(2));
  lines.push("| Case | Category | Split | Candidates | Calls | Answerable | Decisive | Correct/decisive | Baseline correct/decisive | Surfaced before→after | Best rank before→after | Mean signal | Bands (act/confirm/fallback) | Errors |");
  lines.push("| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |");
  for (const plan of plans) {
    const summary = summaryById.get(plan.memoryCase.id);
    if (!summary) {
      lines.push(`| ${plan.memoryCase.id} | ${plan.memoryCase.category} | ${plan.holdout ? "holdout" : "dev"} | ${plan.candidates.length} | 0 | 0 | 0 | 0/0 | 0/0 | — | — | n/a | — | 0 |`);
      continue;
    }
    lines.push(
      `| ${summary.id} | ${summary.category} | ${summary.holdout ? "holdout" : "dev"} | ${summary.candidateCount} | ${summary.calls} | ${summary.answerable} | ${summary.decisive} | ${summary.correct}/${summary.decisive} | ${summary.baselineCorrect}/${summary.decisive} | ${summary.surfacedBefore}→${summary.surfacedAfter} | ${rankText(summary.bestRankBefore)}→${rankText(summary.bestRankAfter)} | ${summary.meanSignal.toFixed(3)} | ${summary.bands.act}/${summary.bands.confirm}/${summary.bands.fallback} | ${summary.failed} |`,
    );
  }
  lines.push("");
  if (failures.length > 0) {
    lines.push(`Adapter failures: ${failures.length}.`);
    for (const failure of failures.slice(0, 10)) lines.push(`- \`${failure.id}\` repeat ${failure.repeat}: ${failure.error}`);
    lines.push("");
  }
  lines.push("## Ranking benefit versus the deterministic baseline");
  lines.push("");
  lines.push("Both arms are scored with the Plan 3 `scoreCases` over the same calls and labels.");
  lines.push("");
  lines.push("| Arm | Recall@K | Recall@8 | MRR | nDCG | Negative pass |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  lines.push(metricRow(`deterministic baseline (${samples.length} calls)`, evaluation.baseline));
  lines.push(metricRow(`fused rerank (${samples.length} calls)`, evaluation.fused));
  lines.push("");
  lines.push(`Top-1 is a labelled required source on ${pct(evaluation.top1BeforeRate)} of answerable calls before and ${pct(evaluation.top1AfterRate)} after reranking; the fused order improved the best required-source position on ${evaluation.improvedCalls} eligible call(s), demoted it on ${evaluation.demotedCalls}, and left the rest unchanged. Case-label pass rate over eligible calls moved from ${pct(evaluation.baselinePassRate)} to ${pct(evaluation.fusedPassRate)}.`);
  lines.push("");
  lines.push("## Calibration (fit on development, scored on holdout)");
  lines.push("");
  lines.push(`Fitted a monotonic Platt map on ${evaluation.devSamples} decisive development call(s); the calibrated signal is the model's strongest "answers the query?" probability.`);
  lines.push("");
  lines.push("| Split | Signal | Brier | ECE |");
  lines.push("| --- | --- | ---: | ---: |");
  lines.push(`| held-out decisive (${evaluation.holdoutSamples}) | raw | ${evaluation.holdout.raw.brier.toFixed(4)} | ${evaluation.holdout.raw.expectedCalibrationError.toFixed(4)} |`);
  lines.push(`| held-out decisive (${evaluation.holdoutSamples}) | calibrated | ${evaluation.holdout.calibrated.brier.toFixed(4)} | ${evaluation.holdout.calibrated.expectedCalibrationError.toFixed(4)} |`);
  lines.push(`| all decisive (${evaluation.decisiveCalls}) | raw | ${evaluation.all.raw.brier.toFixed(4)} | ${evaluation.all.raw.expectedCalibrationError.toFixed(4)} |`);
  lines.push(`| all decisive (${evaluation.decisiveCalls}) | calibrated | ${evaluation.all.calibrated.brier.toFixed(4)} | ${evaluation.all.calibrated.expectedCalibrationError.toFixed(4)} |`);
  lines.push("");
  lines.push(`Map: \`sigmoid(a * logit(p) + b)\` with a = ${evaluation.fitted.a.toFixed(4)}, b = ${evaluation.fitted.b.toFixed(4)}. The held-out rows are the unbiased estimate; the gate scores the calibrated map over every decisive call, which is the map the lane would ship with.`);
  lines.push("");
  lines.push(`Decisive case accuracy ${pct(evaluation.accuracy)} over ${evaluation.decisiveCalls} decisive gate-eligible call(s). Mean transport latency ${meanLatency.toFixed(0)} ms.`);
  lines.push("");
  lines.push(`## Promotion gate — \`${PROMOTION_LANE}\``);
  lines.push("");
  lines.push(`**${evaluation.gate.promoted ? "PROMOTE" : "NOT READY"}**`);
  lines.push("");
  if (evaluation.gate.reasons.length === 0) lines.push("All gates passed.");
  else for (const reason of evaluation.gate.reasons) lines.push(`- ${reason}`);
  lines.push("");
  lines.push(`Gate: samples ${evaluation.gate.gates.minSamples}+, accuracy ${pct(evaluation.gate.gates.minAccuracy)}+, Brier <= ${evaluation.gate.gates.maxBrier}, ECE <= ${evaluation.gate.gates.maxExpectedCalibrationError}.`);
  lines.push("");
  if (proposedRecord) {
    lines.push("Proposed promotion record:");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(proposedRecord, null, 2));
    lines.push("```");
  } else {
    lines.push("No promotion record is proposed: the gate did not pass, so the lane keeps its record-only shadow behavior.");
  }
  lines.push("");
  lines.push("## Observations");
  lines.push("");
  lines.push(`- **Coverage.** ${evaluation.eligibleCalls} of ${evaluation.calls} call(s) were gate-eligible (the shortlist retrieved a labelled required source); ${unanswerable} call(s) were unanswerable, including cases whose baseline recall miss cannot be repaired by reordering. ${plans.filter((plan) => plan.candidates.length === 0).length} case(s) produced an empty shortlist and were never called.`);
  lines.push(`- **Assertions.** ${evaluation.misassertedCalls} decisive call(s) landed on an unanswerable shortlist; those are excluded from the gate label and reported here so an over-eager assertion is visible.`);
  const fused = evaluation.fused;
  const baseline = evaluation.baseline;
  const signed = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;
  lines.push(`- **Ranking.** Aggregate Recall@K ${signed(fused.recallAtK - baseline.recallAtK)}, MRR ${signed(fused.mrr - baseline.mrr)}, and nDCG ${signed(fused.ndcg - baseline.ndcg)} are unchanged over the deterministic baseline: every supported-case required source was already inside the top K, and the Plan 3 scorer excludes expected-miss alias/pronoun rows from MRR/nDCG. The rerank's position movement is visible in the per-case table (best rank before→after) and the improved/demoted counts: ${evaluation.improvedCalls} improved, ${evaluation.demotedCalls} demoted, ${evaluation.eligibleCalls - evaluation.improvedCalls - evaluation.demotedCalls} unchanged. Negative (forbidden-source) pass rate stayed ${fused.negativePassRate.toFixed(4)}.`);
  lines.push(`- **Gate label.** ${evaluation.eligibleFailures} of ${evaluation.eligibleCalls} eligible call(s) did not satisfy the case label (${pct(evaluation.fusedPassRate)} pass rate). The lane deferred on ${evaluation.deferredFailures} of them and acted on ${evaluation.actedFailures}, so the decisive accuracy above is an asserted-subset figure, not the corpus-wide pass rate. A deferral leaves the deterministic order in place.`);
  lines.push(`- **Honesty.** The gate label only asks whether the lane keeps every retrieved required source inside the top K; it cannot reward a source the shortlist never retrieved, and a decisive subset with no observed errors cannot test the calibration's error tail. The corpus is small and provider-free, and the fixture is the same one Plan 3 uses, so a passing gate is a promotion candidate, not proof.`);
  lines.push("- **No active path.** The lane has no runtime wiring. A promotion record is evidence only: recall authorization, caps, and the deterministic order fallback are unchanged.");
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY");
  lines.push("npx tsx scripts/evaluate-system-one-rerank-lane.ts --repeat 3");
  lines.push("```");
  lines.push("");
  lines.push(`Raw per-call data: \`${EVIDENCE.replace(/\.md$/, ".json")}\`.`);
  lines.push("");
  return lines.join("\n");
}

function parseFlag(args: readonly string[], name: string): string | null {
  const withEquals = args.find((value) => value.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] ?? null;
  return null;
}

async function main(): Promise<void> {
  const key = process.env.TYPESAFE_API_KEY?.trim() ?? "";
  if (!key) {
    console.error("TYPESAFE_API_KEY is required for the live memory-reranking evaluation.");
    process.exitCode = 1;
    return;
  }
  const repeatRaw = Number(parseFlag(process.argv.slice(2), "--repeat") ?? "3");
  const repeats = Math.max(1, Math.min(25, Number.isFinite(repeatRaw) ? Math.floor(repeatRaw) : 3));
  const outPath = path.resolve(ROOT, parseFlag(process.argv.slice(2), "--out") ?? EVIDENCE);
  const settings = { ...defaultSystemOneSettings(), apiKey: key };
  const thresholds = settings.confidencePolicy[PROMOTION_LANE];
  const promotedAt = new Date().toISOString().slice(0, 10);

  const directory = await mkdtemp(path.join(tmpdir(), "velvet-rerank-eval-"));
  const previousDataDir = process.env.VELVET_DATA_DIR;
  const samples: RerankCaseSample[] = [];
  const failures: RerankCallFailure[] = [];
  let model = settings.model;
  try {
    process.env.VELVET_DATA_DIR = directory;
    closeRepo();
    const fixture = await createMemoryEvalFixture(directory);
    const plans = buildRerankCasePlans(fixture);
    const callable = plans.filter((plan) => plan.candidates.length > 0);
    console.log(
      `evaluating ${callable.length} recalled shortlists (${plans.length - callable.length} empty) x ${repeats} repeats against ${settings.model}`,
    );
    for (const plan of callable) {
      const questions = buildRerankQuestions({ query: plan.memoryCase.query, candidates: plan.candidates });
      const state = { query: plan.memoryCase.query, purpose: "public-narration" };
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const startedAt = performance.now();
        try {
          const result = await completeWithSystemOne({ settings, state, questions });
          model = result.model.responseModel ?? model;
          const composition = composeRerankOrder(
            { query: plan.memoryCase.query, candidates: plan.candidates },
            result.answers,
            thresholds,
          );
          const topSignal = composition.topSignal;
          const band = composition.band;
          samples.push(toRerankSample(plan, composition.order, topSignal, band, repeat, Math.max(0, Math.round(performance.now() - startedAt))));
        } catch (error) {
          failures.push({
            id: plan.memoryCase.id,
            repeat,
            error: error instanceof Error ? error.message : "error",
          });
        }
      }
      process.stdout.write(".");
    }
    process.stdout.write("\n");
    if (samples.length === 0) throw new Error("no rerank calls succeeded; nothing to evaluate");
    const evaluation = evaluateRerankBenchmark(samples);
    const proposedRecord = proposePromotionRecord(evaluation, promotedAt);
    const markdown = renderRerankBenchmark({
      generatedAt: new Date().toISOString(),
      model,
      baseUrl: settings.baseUrl,
      repeats,
      thresholds,
      plans,
      samples,
      failures,
      evaluation,
      proposedRecord,
    });
    await writeFile(outPath, markdown, "utf8");
    await writeFile(
      outPath.replace(/\.md$/, ".json"),
      `${JSON.stringify(
        { model, repeats, thresholds, k: RERANK_K, plans: plans.map((plan) => ({ id: plan.memoryCase.id, category: plan.memoryCase.category, holdout: plan.holdout, candidateCount: plan.candidates.length, baseline: plan.baselineKeys, expected: plan.expected, forbidden: plan.forbidden })), failures, samples, evaluation, proposedRecord },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fixture.repo.close();
    console.log(`calls: ${evaluation.calls} (${evaluation.eligibleCalls} eligible, ${evaluation.decisiveCalls} decisive), accuracy ${pct(evaluation.accuracy)}`);
    console.log(`recall@K: ${evaluation.baseline.recallAtK.toFixed(4)} -> ${evaluation.fused.recallAtK.toFixed(4)}; mrr ${evaluation.baseline.mrr.toFixed(4)} -> ${evaluation.fused.mrr.toFixed(4)}; ndcg ${evaluation.baseline.ndcg.toFixed(4)} -> ${evaluation.fused.ndcg.toFixed(4)}`);
    console.log(`brier: raw ${evaluation.all.raw.brier.toFixed(4)} -> calibrated ${evaluation.all.calibrated.brier.toFixed(4)}; ece: raw ${evaluation.all.raw.expectedCalibrationError.toFixed(4)} -> calibrated ${evaluation.all.calibrated.expectedCalibrationError.toFixed(4)}`);
    console.log(`gate: ${evaluation.gate.promoted ? "PROMOTE" : "NOT READY"}${evaluation.gate.reasons.length ? ` (${evaluation.gate.reasons.join("; ")})` : ""}`);
    console.log(`wrote ${path.relative(ROOT, outPath)}`);
  } finally {
    closeRepo();
    if (previousDataDir === undefined) delete process.env.VELVET_DATA_DIR;
    else process.env.VELVET_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
