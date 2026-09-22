#!/usr/bin/env node
/**
 * Automated paired comparison of the two L2 adventure-selection payload variants.
 *
 * `buildAdventureBenchmarkRequest` can build two payloads for the same case:
 *
 * - **legacy** — the benchmark-shaped request the evaluator already runs: the declaration and the
 *   advertised candidate count live in state, and every question embeds the declaration;
 * - **shared-context** — the experimental request from `buildAdventureSharedContextRequest`: the
 *   declaration and every advertised candidate (including duplicate instances) live in state, and
 *   questions reference candidate ids and describe judgments.
 *
 * Offline (default) this script builds both variants for every case — the frozen
 * `ADVENTURE_EVAL_CASES` plus confirmed harvested cases from `loadHarvestedAdventureCases` — and
 * writes a markdown + JSON report with per-case serialized byte lengths, totals, delta, and
 * shrink/grow/equal counts, a bounded per-case table, a SHA-256 request digest per variant per
 * case, a corpus digest over the ordered case identities, and structural pairing checks (both
 * variants must expose the same candidate identities and count; any mismatch is a reported
 * failure, never a silent drop). Offline mode sends no network calls and makes no accuracy claims.
 *
 * Live (`--live`) runs the same paired corpus through the real System One adapter:
 * `--max-calls <N>` and `TYPESAFE_API_KEY` are required, `N` is refused when missing or above the
 * documented cap (`LIVE_CALL_CAP`, 600), and the projected `cases x repeats x 2` call count is
 * refused before any call when it exceeds `N`. Each variant runs each case `--repeat` times
 * (default 1), interleaving the two variants per case to reduce time drift. Every attempt keeps
 * its variant, case id, repeat, returned model, the evaluator's readout (composed band/selected/
 * acceptable/selectedCorrect/topSignal), request digest, corpus digest, exact payload/state
 * binding versions, and provider-reported usage/latency (cost derived from the configured pricing
 * when usage and pricing are both available; otherwise null). Failures are explicit records with
 * a classified code and message. Grading, subset summaries, and stability reuse the evaluator's
 * functions and readout shape so existing tooling can read the JSON sidecar.
 *
 * Accuracy evidence stays tied to labeled corpora: the frozen corpus is a hand-labeled projection
 * and harvested labels are live-derived; curated benchmark cases bypass production shortlisting.
 * The shared-context payload is evaluation-only and is not wired to the runtime lane.
 *
 * Usage:
 *   npx tsx scripts/compare-system-one-adventure-payloads.ts [--out docs/system-one-adventure-payload-comparison.md] [--json <path>] [--top 10]
 *   TYPESAFE_API_KEY=... npx tsx scripts/compare-system-one-adventure-payloads.ts --live --max-calls 300 [--repeat 1]
 *
 * `--payload` is deliberately not accepted: this runner always compares both variants.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADVENTURE_BEST_KEY,
  ADVENTURE_NONE,
  ADVENTURE_RELEVANCE_PREFIX,
  ADVENTURE_SHARED_CONTEXT_VERSIONS,
  composeAdventureSelection,
} from "../server/src/agent/systemOneAdventure.js";
import { SYSTEM_ONE_EXECUTION_CONTRACTS } from "../server/src/agent/systemOneBinding.js";
import type { StabilitySummary } from "../server/src/agent/systemOneStability.js";
import { defaultSystemOneSettings } from "../server/src/defaults.js";
import {
  classifySystemOneFailure,
  completeWithSystemOne,
  SystemOneError,
  type SystemOneCompletionInput,
  type SystemOneCompletionResult,
  type SystemOneQuestions,
  type SystemOneUsage,
} from "../server/src/provider/systemOneCompletion.js";
import type { ProviderPricing, SystemOneConfidenceThresholds, SystemOneSettings } from "../server/src/types.js";
import {
  ADVENTURE_EVAL_CASES,
  ADVENTURE_EVAL_CORPUS_VERSION,
  type AdventureEvalCase,
  type AdventureEvalCategory,
} from "../server/test/fixtures/adventure-evals/corpus.js";
import {
  HARVEST_FIXTURE,
  HARVEST_ID_PREFIX,
  agentHarvestedCaseIds,
  buildAdventureBenchmarkRequest,
  gradeAdventureCase,
  loadHarvestedAdventureCases,
  summarizeAdventureStability,
  summarizeAdventureSubset,
  type AdventureCaseProvenance,
  type AdventureCaseRow,
  type AdventureHarvestReport,
  type AdventureReadout,
  type AdventureSubsetSummary,
} from "./evaluate-system-one-adventure-lane.js";
import { beginAdventureEvidence } from "./system-one-evidence.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = "scripts/compare-system-one-adventure-payloads.ts";
const PROMOTION_LANE = "adventure-selection" as const;

/** The default markdown report path; `--json` defaults alongside it. */
export const DEFAULT_COMPARISON_OUT = "docs/system-one-adventure-payload-comparison.md";
/** The default per-side row bound for the bounded per-case tables. */
export const DEFAULT_COMPARISON_TOP = 10;
/** The hard bound on `--top`; the full data always lives in the JSON sidecar. */
export const COMPARISON_TOP_LIMIT = 100;
/** The hard bound on `--repeat`, mirroring the single-variant benchmark. */
export const COMPARISON_REPEAT_LIMIT = 25;
/** The documented live call cap: `--max-calls` above this is refused outright. */
export const LIVE_CALL_CAP = 600;
/** `beginAdventureEvidence` overrides the lane's candidate strategy for curated benchmark cases. */
export const BENCHMARK_CANDIDATE_STRATEGY = "benchmark-curated-candidates-v1";
/** The two payload variants, compared in this order everywhere. */
export const ADVENTURE_PAYLOAD_VARIANTS = ["legacy", "shared-context"] as const;
export type AdventurePayloadVariant = (typeof ADVENTURE_PAYLOAD_VARIANTS)[number];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// CLI parsing and the live budget
// ---------------------------------------------------------------------------------------------

export interface CompareCliOptions {
  live: boolean;
  out: string;
  /** The JSON sidecar path; defaults alongside the markdown report. */
  json: string;
  /** Per-side row bound for the bounded per-case tables. */
  top: number;
  /** Live repeats per variant per case; offline repeats are not used. */
  repeats: number;
  /** The live call budget, or null when `--max-calls` was not given. */
  maxCalls: number | null;
}

function flagValue(args: readonly string[], name: string): string | null {
  const withEquals = args.find((value) => value.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? "";
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** The JSON sidecar path alongside a markdown report: `.md` swaps to `.json`, anything else gains a suffix. */
export function defaultJsonPath(out: string): string {
  return out.endsWith(".md") ? `${out.slice(0, -3)}.json` : `${out}.json`;
}

/**
 * Parses the CLI flags. `--max-calls` is validated here only for shape (a positive integer when
 * present); whether it is required, within the cap, and large enough for the projection is the
 * budget check's job, so the refusal reasons stay in one place. `--payload` is not accepted: this
 * runner always compares both variants.
 */
export function parseCompareArgs(args: readonly string[]): CompareCliOptions {
  const live = args.includes("--live");
  const out = flagValue(args, "--out") || DEFAULT_COMPARISON_OUT;
  const json = flagValue(args, "--json") || defaultJsonPath(out);
  const topRaw = flagValue(args, "--top");
  const top = clampInt(topRaw === null || topRaw === "" ? DEFAULT_COMPARISON_TOP : Number(topRaw), 1, COMPARISON_TOP_LIMIT, DEFAULT_COMPARISON_TOP);
  const repeatRaw = flagValue(args, "--repeat");
  const repeats = clampInt(repeatRaw === null || repeatRaw === "" ? 1 : Number(repeatRaw), 1, COMPARISON_REPEAT_LIMIT, 1);
  const maxCallsRaw = flagValue(args, "--max-calls");
  const maxCalls = maxCallsRaw === null ? null : maxCallsRaw.trim() === "" ? Number.NaN : Number(maxCallsRaw);
  if (maxCalls !== null && (!Number.isInteger(maxCalls) || maxCalls < 1)) {
    throw new Error("--max-calls must be a positive integer");
  }
  return { live, out, json, top, repeats, maxCalls };
}

export interface LiveBudgetCheck {
  ok: boolean;
  /** A clear refusal reason when `ok` is false; null otherwise. */
  error: string | null;
  /** The projected live call count: cases x repeats x 2 variants. */
  projectedCalls: number;
  /** The accepted live budget; the raw input value when it was given, null otherwise. */
  maxCalls: number | null;
}

/**
 * Validates the live budget before any call is made. Offline is always acceptable: no calls run.
 * Live requires an explicit positive integer `--max-calls` no greater than `LIVE_CALL_CAP`, and a
 * projection (`cases x repeats x 2`) that fits inside it.
 */
export function checkLiveBudget(input: {
  live: boolean;
  maxCalls: number | null;
  cases: number;
  repeats: number;
}): LiveBudgetCheck {
  const projectedCalls = input.cases * input.repeats * ADVENTURE_PAYLOAD_VARIANTS.length;
  if (!input.live) return { ok: true, error: null, projectedCalls, maxCalls: input.maxCalls };
  if (input.maxCalls === null) {
    return {
      ok: false,
      error: `--max-calls <N> is required in live mode (projected ${projectedCalls} call(s)); the documented cap is ${LIVE_CALL_CAP}`,
      projectedCalls,
      maxCalls: null,
    };
  }
  if (!Number.isInteger(input.maxCalls) || input.maxCalls < 1) {
    return { ok: false, error: "--max-calls must be a positive integer", projectedCalls, maxCalls: input.maxCalls };
  }
  if (input.maxCalls > LIVE_CALL_CAP) {
    return {
      ok: false,
      error: `--max-calls ${input.maxCalls} exceeds the documented cap of ${LIVE_CALL_CAP}`,
      projectedCalls,
      maxCalls: input.maxCalls,
    };
  }
  if (projectedCalls > input.maxCalls) {
    return {
      ok: false,
      error: `projected ${projectedCalls} call(s) (${input.cases} cases x ${input.repeats} repeats x ${ADVENTURE_PAYLOAD_VARIANTS.length} variants) exceed the --max-calls budget of ${input.maxCalls}`,
      projectedCalls,
      maxCalls: input.maxCalls,
    };
  }
  return { ok: true, error: null, projectedCalls, maxCalls: input.maxCalls };
}

// ---------------------------------------------------------------------------------------------
// Request identity: bytes, digests, and structural pairing
// ---------------------------------------------------------------------------------------------

/** The state/questions half both builders return; the runner measures and compares this only. */
export interface AdventureRequest {
  state: unknown;
  questions: SystemOneQuestions;
}

/** SHA-256 over `{ state, questions }`, exactly the digest `beginAdventureEvidence` freezes. */
export function adventureRequestDigest(request: AdventureRequest): string {
  return sha256({ state: request.state, questions: request.questions });
}

/** SHA-256 over the ordered case identities, so membership and order are pinned but labels are not. */
export function adventureCorpusDigest(cases: readonly { id: string }[]): string {
  return sha256(cases.map((testCase) => testCase.id));
}

/** UTF-8 byte length of the serialized `{ state, questions }` payload. */
export function serializedRequestBytes(request: AdventureRequest): number {
  return Buffer.byteLength(JSON.stringify({ state: request.state, questions: request.questions }), "utf8");
}

/** The candidate surface one variant's request exposes to the model. */
export interface PayloadStructure {
  /** Candidate count carried by the state half (legacy: the candidateCount field; shared: the array length). */
  stateCandidateCount: number;
  /** Candidate ids carried by the state half in payload order; empty when the state carries no ids. */
  stateCandidateIds: string[];
  /** Question keys in payload order. */
  questionKeys: string[];
  /** Candidate ids the question battery exposes in order (relevance keys, then choice-only ids). */
  questionCandidateIds: string[];
  /** The aggregate choice's option ids in order, including the fail-closed none option. */
  choiceOptions: string[];
}

/** Reads the candidate surface out of a built request without assuming which variant produced it. */
export function payloadStructure(request: AdventureRequest): PayloadStructure {
  const questionKeys = Object.keys(request.questions);
  const relevanceIds: string[] = [];
  const choiceOptions: string[] = [];
  for (const key of questionKeys) {
    if (key.startsWith(ADVENTURE_RELEVANCE_PREFIX)) relevanceIds.push(key.slice(ADVENTURE_RELEVANCE_PREFIX.length));
    if (key === ADVENTURE_BEST_KEY) {
      const question = request.questions[key];
      if (question?.type === "choice") choiceOptions.push(...Object.keys(question.criteria));
    }
  }
  const questionCandidateIds: string[] = [];
  const seen = new Set<string>();
  for (const id of [...relevanceIds, ...choiceOptions]) {
    if (id === ADVENTURE_NONE || seen.has(id)) continue;
    seen.add(id);
    questionCandidateIds.push(id);
  }
  let stateCandidateCount = 0;
  let stateCandidateIds: string[] = [];
  const state = isRecord(request.state) ? request.state : null;
  if (state && Array.isArray(state.candidates)) {
    stateCandidateCount = state.candidates.length;
    stateCandidateIds = state.candidates.flatMap((entry) =>
      isRecord(entry) && typeof entry.candidateId === "string" ? [entry.candidateId] : []);
  } else if (state && typeof state.candidateCount === "number" && Number.isFinite(state.candidateCount)) {
    stateCandidateCount = state.candidateCount;
  }
  return { stateCandidateCount, stateCandidateIds, questionKeys, questionCandidateIds, choiceOptions };
}

export interface StructuralPairResult {
  caseId: string;
  /** True only when every identity, count, and order check below passed. */
  ok: boolean;
  /** The case's advertised candidate count, the expected inventory for both variants. */
  candidateCount: number;
  /** One human-readable line per failed check; empty exactly when `ok`. */
  mismatches: string[];
  /** The two question batteries expose candidate ids in the same order. */
  sameQuestionOrder: boolean;
  /** The shared state preserves the case's advertised candidate order. */
  sameStateOrder: boolean;
  legacy: PayloadStructure | null;
  shared: PayloadStructure | null;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/**
 * Structural pairing of the two built requests for one case. A curatorial bug must fail loudly:
 * both variants have to advertise the same candidate count, the shared state has to preserve every
 * advertised candidate id in order, and the two question batteries have to expose the same
 * candidate ids in the same order with the same aggregate options. A mismatch is returned, never
 * dropped, and the caller reports it as a failure.
 */
export function checkPayloadStructure(
  testCase: Pick<AdventureEvalCase, "id" | "candidates">,
  legacyRequest: AdventureRequest,
  sharedRequest: AdventureRequest,
): StructuralPairResult {
  const legacy = payloadStructure(legacyRequest);
  const shared = payloadStructure(sharedRequest);
  const expected = testCase.candidates.map((candidate) => candidate.candidateId);
  const mismatches: string[] = [];
  if (legacy.stateCandidateCount !== expected.length) {
    mismatches.push(`legacy state advertises ${legacy.stateCandidateCount} candidate(s), case advertises ${expected.length}`);
  }
  if (shared.stateCandidateCount !== expected.length) {
    mismatches.push(`shared state advertises ${shared.stateCandidateCount} candidate(s), case advertises ${expected.length}`);
  }
  const sameStateOrder = sameOrder(shared.stateCandidateIds, expected);
  if (!sameStateOrder) {
    mismatches.push(`shared state candidate ids/order differ from the advertised candidates: [${shared.stateCandidateIds.join(", ")}] vs [${expected.join(", ")}]`);
  }
  if (!sameOrder(legacy.questionKeys, shared.questionKeys)) {
    mismatches.push(`question batteries differ between variants: [${legacy.questionKeys.join(", ")}] vs [${shared.questionKeys.join(", ")}]`);
  }
  const sameQuestionOrder = sameOrder(legacy.questionCandidateIds, shared.questionCandidateIds);
  if (!sameMembers(legacy.questionCandidateIds, shared.questionCandidateIds)) {
    mismatches.push(`question batteries expose different candidate ids: [${legacy.questionCandidateIds.join(", ")}] vs [${shared.questionCandidateIds.join(", ")}]`);
  } else if (!sameQuestionOrder) {
    mismatches.push(`question candidate order differs between variants: [${legacy.questionCandidateIds.join(", ")}] vs [${shared.questionCandidateIds.join(", ")}]`);
  }
  if (!sameOrder(legacy.choiceOptions, shared.choiceOptions)) {
    mismatches.push(`aggregate choice options differ between variants: [${legacy.choiceOptions.join(", ")}] vs [${shared.choiceOptions.join(", ")}]`);
  }
  for (const id of legacy.questionCandidateIds) {
    if (!shared.stateCandidateIds.includes(id)) mismatches.push(`shared state lost candidate \`${id}\` exposed by the legacy battery`);
  }
  return {
    caseId: testCase.id,
    ok: mismatches.length === 0,
    candidateCount: expected.length,
    mismatches,
    sameQuestionOrder,
    sameStateOrder,
    legacy,
    shared,
  };
}

// ---------------------------------------------------------------------------------------------
// Offline byte comparison
// ---------------------------------------------------------------------------------------------

/** Where one case entered the corpus: frozen, human-confirmed harvested, or agent-reviewed harvested. */
export function comparisonCaseProvenance(testCase: AdventureCaseRow): AdventureCaseProvenance {
  if (!testCase.id.startsWith(HARVEST_ID_PREFIX)) return "frozen";
  return testCase.harvestBucket === "human" ? "harvested-human" : "harvested-agent";
}

/** One case's paired byte accounting and request identities. A null means that side could not be built. */
export interface PayloadByteRow {
  caseId: string;
  category: AdventureEvalCategory;
  provenance: AdventureCaseProvenance;
  candidateCount: number;
  legacyBytes: number | null;
  sharedBytes: number | null;
  /** shared − legacy; positive means the shared payload grew. */
  deltaBytes: number | null;
  /** (shared − legacy) / legacy in percent; null when the legacy size is unavailable or zero. */
  deltaPercent: number | null;
  legacyDigest: string | null;
  sharedDigest: string | null;
}

export interface PayloadByteSummary {
  /** Cases with both sides measured. */
  cases: number;
  /** Cases with at least one side unbuilt. */
  incomplete: number;
  legacyBytes: number;
  sharedBytes: number;
  deltaBytes: number;
  deltaPercent: number | null;
  shrink: number;
  grow: number;
  equal: number;
  legacyMin: number | null;
  legacyMax: number | null;
  legacyMean: number | null;
  sharedMin: number | null;
  sharedMax: number | null;
  sharedMean: number | null;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const minOf = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.min(...values));
const maxOf = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.max(...values));
const meanOf = (values: readonly number[]): number | null => (values.length === 0 ? null : sum(values) / values.length);

/** Aggregates the paired byte rows. Rows with an unbuilt side are counted, never silently dropped. */
export function summarizePayloadBytes(rows: readonly PayloadByteRow[]): PayloadByteSummary {
  const measured = rows.filter((row): row is PayloadByteRow & { legacyBytes: number; sharedBytes: number; deltaBytes: number } =>
    row.legacyBytes !== null && row.sharedBytes !== null && row.deltaBytes !== null);
  const legacy = measured.map((row) => row.legacyBytes);
  const shared = measured.map((row) => row.sharedBytes);
  const legacyTotal = sum(legacy);
  const sharedTotal = sum(shared);
  const deltaTotal = sharedTotal - legacyTotal;
  return {
    cases: measured.length,
    incomplete: rows.length - measured.length,
    legacyBytes: legacyTotal,
    sharedBytes: sharedTotal,
    deltaBytes: deltaTotal,
    deltaPercent: legacyTotal === 0 ? null : (deltaTotal / legacyTotal) * 100,
    shrink: measured.filter((row) => row.deltaBytes < 0).length,
    grow: measured.filter((row) => row.deltaBytes > 0).length,
    equal: measured.filter((row) => row.deltaBytes === 0).length,
    legacyMin: minOf(legacy),
    legacyMax: maxOf(legacy),
    legacyMean: meanOf(legacy),
    sharedMin: minOf(shared),
    sharedMax: maxOf(shared),
    sharedMean: meanOf(shared),
  };
}

/**
 * Builds both variants for every case, measures and digests each request, and structurally pairs
 * them. A builder failure yields a row with a null side plus a structural failure, so no case can
 * disappear from the comparison.
 */
export function buildPayloadComparisons(cases: readonly AdventureCaseRow[]): {
  rows: PayloadByteRow[];
  structural: StructuralPairResult[];
  corpusDigest: string;
} {
  const rows: PayloadByteRow[] = [];
  const structural: StructuralPairResult[] = [];
  for (const testCase of cases) {
    let legacyRequest: AdventureRequest | null = null;
    let sharedRequest: AdventureRequest | null = null;
    const buildErrors: string[] = [];
    try {
      legacyRequest = buildAdventureBenchmarkRequest(testCase, "legacy");
    } catch (error) {
      buildErrors.push(`legacy build failed: ${messageOf(error)}`);
    }
    try {
      sharedRequest = buildAdventureBenchmarkRequest(testCase, "shared-context");
    } catch (error) {
      buildErrors.push(`shared-context build failed: ${messageOf(error)}`);
    }
    const legacyBytes = legacyRequest === null ? null : serializedRequestBytes(legacyRequest);
    const sharedBytes = sharedRequest === null ? null : serializedRequestBytes(sharedRequest);
    const deltaBytes = legacyBytes === null || sharedBytes === null ? null : sharedBytes - legacyBytes;
    rows.push({
      caseId: testCase.id,
      category: testCase.category,
      provenance: comparisonCaseProvenance(testCase),
      candidateCount: testCase.candidates.length,
      legacyBytes,
      sharedBytes,
      deltaBytes,
      deltaPercent: deltaBytes === null || legacyBytes === null || legacyBytes === 0 ? null : (deltaBytes / legacyBytes) * 100,
      legacyDigest: legacyRequest === null ? null : adventureRequestDigest(legacyRequest),
      sharedDigest: sharedRequest === null ? null : adventureRequestDigest(sharedRequest),
    });
    if (legacyRequest !== null && sharedRequest !== null) {
      structural.push(checkPayloadStructure(testCase, legacyRequest, sharedRequest));
    } else {
      structural.push({
        caseId: testCase.id,
        ok: false,
        candidateCount: testCase.candidates.length,
        mismatches: buildErrors.length > 0 ? buildErrors : ["a payload variant could not be built"],
        sameQuestionOrder: false,
        sameStateOrder: false,
        legacy: legacyRequest === null ? null : payloadStructure(legacyRequest),
        shared: sharedRequest === null ? null : payloadStructure(sharedRequest),
      });
    }
  }
  return { rows, structural, corpusDigest: adventureCorpusDigest(cases) };
}

/**
 * The bounded per-case table selection: rows sorted by absolute delta, taking the first `top` and
 * the last `top` so both the biggest changes and the smallest/near-equal cases stay visible.
 */
export function boundedDeltaRows(rows: readonly PayloadByteRow[], top: number): { shown: PayloadByteRow[]; omitted: number } {
  const measured = rows.filter((row) => row.deltaBytes !== null);
  const sorted = [...measured].sort((left, right) =>
    Math.abs(right.deltaBytes ?? 0) - Math.abs(left.deltaBytes ?? 0) || left.caseId.localeCompare(right.caseId));
  const limit = Math.max(1, Math.floor(top));
  if (sorted.length <= limit * 2) return { shown: sorted, omitted: 0 };
  const shown = [...sorted.slice(0, limit), ...sorted.slice(-limit)];
  return { shown, omitted: sorted.length - shown.length };
}

// ---------------------------------------------------------------------------------------------
// Grading roll-ups (offline-safe; fed by live attempts)
// ---------------------------------------------------------------------------------------------

export interface VariantGradingMetrics {
  /** Every graded call, agent-reviewed harvested rows included. */
  all: AdventureSubsetSummary;
  /** The labeled scope: frozen corpus plus human-confirmed harvested cases. */
  gateScope: AdventureSubsetSummary;
  /** Agent-reviewed harvested cases: scored and reported, never promotion evidence. */
  agentSubset: AdventureSubsetSummary;
}

/**
 * The evaluator's subset summary at the composed default for all three scopes. `summarizeAdventureSubset`
 * already implements the acted/exact/asserted-subset rubric, so live mode reuses it rather than
 * inventing a second roll-up.
 */
export function summarizeVariantMetrics(
  readouts: readonly AdventureReadout[],
  cases: readonly AdventureCaseRow[],
): VariantGradingMetrics {
  const allIds = new Set(cases.map((testCase) => testCase.id));
  const agentIds = agentHarvestedCaseIds(cases);
  const gateIds = new Set([...allIds].filter((id) => !agentIds.has(id)));
  return {
    all: summarizeAdventureSubset(readouts, allIds),
    gateScope: summarizeAdventureSubset(readouts, gateIds),
    agentSubset: summarizeAdventureSubset(readouts, agentIds),
  };
}

export interface VariantUsageSummary {
  attempts: number;
  /** Attempts where the provider reported usage. */
  usageReported: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Derived from reported usage and configured pricing; null when either is unavailable. */
  costUsd: number | null;
  totalLatencyMs: number;
  meanLatencyMs: number | null;
}

/** Sums provider measurements exactly as reported; every missing value stays null. */
export function summarizeAttemptUsage(attempts: readonly AdventureAttemptRecord[]): VariantUsageSummary {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let totalTokens: number | null = null;
  let costUsd: number | null = null;
  let usageReported = 0;
  const latencies: number[] = [];
  for (const attempt of attempts) {
    if (attempt.usage !== null) {
      usageReported += 1;
      inputTokens = (inputTokens ?? 0) + attempt.usage.inputTokens;
      outputTokens = (outputTokens ?? 0) + attempt.usage.outputTokens;
      totalTokens = (totalTokens ?? 0) + attempt.usage.totalTokens;
    }
    if (attempt.costUsd !== null && Number.isFinite(attempt.costUsd)) costUsd = (costUsd ?? 0) + attempt.costUsd;
    if (attempt.latencyMs !== null && Number.isFinite(attempt.latencyMs)) latencies.push(attempt.latencyMs);
  }
  const totalLatencyMs = sum(latencies);
  return {
    attempts: attempts.length,
    usageReported,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    totalLatencyMs,
    meanLatencyMs: latencies.length === 0 ? null : totalLatencyMs / latencies.length,
  };
}

/** Cost in USD from provider-reported usage and the configured per-million pricing; null when either is missing. */
export function usageCostUsd(usage: SystemOneUsage | null, pricing: ProviderPricing): number | null {
  if (usage === null) return null;
  const { promptPerMillion, completionPerMillion } = pricing;
  if (promptPerMillion === null || completionPerMillion === null) return null;
  if (!Number.isFinite(promptPerMillion) || !Number.isFinite(completionPerMillion)) return null;
  return (usage.inputTokens / 1_000_000) * promptPerMillion + (usage.outputTokens / 1_000_000) * completionPerMillion;
}

// ---------------------------------------------------------------------------------------------
// Decision agreement across variants and repeats
// ---------------------------------------------------------------------------------------------

export interface AgreementSample {
  caseId: string;
  variant: AdventurePayloadVariant;
  /** The candidate the call named (composed or recovered), else `defer`. */
  decision: string;
}

export interface CaseAgreement {
  caseId: string;
  attempts: number;
  decisions: string[];
  legacyDecisions: string[];
  sharedDecisions: string[];
  /** Share of attempts that produced the most common decision. */
  agreement: number;
  /** More than one distinct decision appeared across the case's attempts. */
  conflicted: boolean;
  /** Share of legacy x shared decision pairs that match; null when a variant has no attempts. */
  crossVariantAgreement: number | null;
  /** True when any legacy x shared pair disagreed. */
  crossVariantConflicted: boolean;
}

export interface VariantAgreementSummary {
  cases: CaseAgreement[];
  meanAgreement: number;
  conflictCases: number;
  conflictRate: number;
  crossVariantConflictCases: number;
  /** Over cases with attempts from both variants. */
  crossVariantConflictRate: number;
  /** Mean over cases with both variants' attempts. */
  meanCrossVariantAgreement: number;
}

/**
 * Per-case agreement across every attempt (both variants, all repeats) plus the pairwise
 * cross-variant agreement. Pure; fed by live attempts or synthetic samples in tests.
 */
export function summarizeVariantAgreement(samples: readonly AgreementSample[]): VariantAgreementSummary {
  const order: string[] = [];
  const byCase = new Map<string, { legacy: string[]; shared: string[] }>();
  for (const sample of samples) {
    let bucket = byCase.get(sample.caseId);
    if (!bucket) {
      bucket = { legacy: [], shared: [] };
      byCase.set(sample.caseId, bucket);
      order.push(sample.caseId);
    }
    (sample.variant === "legacy" ? bucket.legacy : bucket.shared).push(sample.decision);
  }
  const cases = order.map((caseId): CaseAgreement => {
    const bucket = byCase.get(caseId)!;
    const decisions = [...bucket.legacy, ...bucket.shared];
    const counts = new Map<string, number>();
    for (const decision of decisions) counts.set(decision, (counts.get(decision) ?? 0) + 1);
    const plurality = decisions.length === 0 ? 0 : Math.max(...counts.values());
    let matches = 0;
    let pairs = 0;
    for (const legacy of bucket.legacy) {
      for (const shared of bucket.shared) {
        pairs += 1;
        if (legacy === shared) matches += 1;
      }
    }
    const crossVariantAgreement = pairs === 0 ? null : matches / pairs;
    return {
      caseId,
      attempts: decisions.length,
      decisions,
      legacyDecisions: bucket.legacy,
      sharedDecisions: bucket.shared,
      agreement: decisions.length === 0 ? 0 : plurality / decisions.length,
      conflicted: counts.size > 1,
      crossVariantAgreement,
      crossVariantConflicted: crossVariantAgreement !== null && crossVariantAgreement < 1,
    };
  });
  const crossValues = cases.flatMap((entry) => (entry.crossVariantAgreement === null ? [] : [entry.crossVariantAgreement]));
  const paired = crossValues.length;
  const conflicts = cases.filter((entry) => entry.conflicted).length;
  const crossConflicts = cases.filter((entry) => entry.crossVariantConflicted).length;
  return {
    cases,
    meanAgreement: cases.length === 0 ? 0 : sum(cases.map((entry) => entry.agreement)) / cases.length,
    conflictCases: conflicts,
    conflictRate: cases.length === 0 ? 0 : conflicts / cases.length,
    crossVariantConflictCases: crossConflicts,
    crossVariantConflictRate: paired === 0 ? 0 : crossConflicts / paired,
    meanCrossVariantAgreement: crossVariantMean(crossValues),
  };
}

function crossVariantMean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

// ---------------------------------------------------------------------------------------------
// Live paired run
// ---------------------------------------------------------------------------------------------

export interface AdventurePayloadVersions {
  questionVersion: string;
  stateVersion: string;
  compositionVersion: string;
  candidateStrategy: string;
}

/**
 * The exact payload/state versions `beginAdventureEvidence` binds for each variant: the shared
 * override for the experimental payload, the lane contract for legacy, both with the benchmark's
 * curated candidate strategy. Versions are read from the source constants, never inferred from
 * evidence, so an empty candidate battery still records them.
 */
export function adventurePayloadVersions(variant: AdventurePayloadVariant): AdventurePayloadVersions {
  const contract = SYSTEM_ONE_EXECUTION_CONTRACTS[PROMOTION_LANE];
  return variant === "shared-context"
    ? {
      ...ADVENTURE_SHARED_CONTEXT_VERSIONS,
      compositionVersion: contract.compositionVersion,
      candidateStrategy: BENCHMARK_CANDIDATE_STRATEGY,
    }
    : {
      questionVersion: contract.questionVersion,
      stateVersion: contract.stateVersion,
      compositionVersion: contract.compositionVersion,
      candidateStrategy: BENCHMARK_CANDIDATE_STRATEGY,
    };
}

/** One recorded live attempt: the evaluator readout plus the fields the report needs beside it. */
export interface AdventureAttemptRecord {
  variant: AdventurePayloadVariant;
  caseId: string;
  category: AdventureEvalCategory;
  provenance: AdventureCaseProvenance;
  repeat: number;
  /** The candidate the call named (composed or recovered), else `defer`. */
  decision: string;
  /** SHA-256 over this attempt's request `{ state, questions }`. */
  requestDigest: string;
  /** SHA-256 over the ordered case identities of the run corpus. */
  corpusDigest: string;
  /** UTF-8 bytes of this attempt's serialized `{ state, questions }` payload. */
  payloadBytes: number;
  /** The provider-reported model, or null when it reported none. */
  model: string | null;
  usage: SystemOneUsage | null;
  /** Derived from reported usage and the configured pricing; null when either is missing. */
  costUsd: number | null;
  latencyMs: number | null;
  /** Exact payload/state binding versions frozen into this attempt's evidence. */
  bindingVersions: AdventurePayloadVersions;
  /** The evaluator's readout shape with this attempt's fixed evidence attached. */
  readout: AdventureReadout;
}

export interface AdventureFailureRecord {
  variant: AdventurePayloadVariant;
  caseId: string;
  repeat: number;
  /** The classified provider failure kind, or `unknown` for an unclassified error. */
  code: string;
  message: string;
}

/** One explicit failure record, preserving the classification and message without inventing a readout. */
export function adventureFailureRecord(
  variant: AdventurePayloadVariant,
  caseId: string,
  repeat: number,
  error: unknown,
): AdventureFailureRecord {
  const classified = error instanceof SystemOneError ? classifySystemOneFailure(error) : null;
  return { variant, caseId, repeat, code: classified?.kind ?? "unknown", message: messageOf(error) };
}

export interface VariantRunSummary {
  readouts: AdventureReadout[];
  metrics: VariantGradingMetrics;
  stability: StabilitySummary;
  usage: VariantUsageSummary;
}

export interface LiveComparison {
  model: string;
  baseUrl: string;
  repeats: number;
  maxCalls: number;
  projectedCalls: number;
  thresholds: SystemOneConfidenceThresholds;
  bindings: Record<AdventurePayloadVariant, AdventurePayloadVersions>;
  attempts: AdventureAttemptRecord[];
  failures: AdventureFailureRecord[];
  variants: Record<AdventurePayloadVariant, VariantRunSummary>;
  agreement: VariantAgreementSummary;
}

export interface LiveComparisonInput {
  cases: readonly AdventureCaseRow[];
  repeats: number;
  maxCalls: number;
  settings: SystemOneSettings;
  /** Injectable caller; tests supply a deterministic offline double. Defaults to the real adapter. */
  complete?: (input: SystemOneCompletionInput) => Promise<SystemOneCompletionResult>;
}

/**
 * Runs the paired live comparison. The budget is re-checked here before the first call, so an
 * importer cannot bypass it. Each case runs both variants back to back per repeat (interleaved per
 * case to reduce time drift), every call freezes its evidence before awaiting transport, and a
 * failed call becomes an explicit failure record rather than a fabricated readout.
 */
export async function runLiveComparison(input: LiveComparisonInput): Promise<LiveComparison> {
  const { cases, repeats, maxCalls, settings } = input;
  const budget = checkLiveBudget({ live: true, maxCalls, cases: cases.length, repeats });
  if (!budget.ok) throw new Error(budget.error ?? "live comparison budget refused");
  const complete = input.complete ?? completeWithSystemOne;
  const thresholds = settings.confidencePolicy[PROMOTION_LANE];
  const corpusDigest = adventureCorpusDigest(cases);
  const attempts: AdventureAttemptRecord[] = [];
  const failures: AdventureFailureRecord[] = [];
  let model = settings.model;
  for (const testCase of cases) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const variant of ADVENTURE_PAYLOAD_VARIANTS) {
        const request = buildAdventureBenchmarkRequest(testCase, variant);
        const payloadBytes = serializedRequestBytes(request);
        const requestDigest = adventureRequestDigest(request);
        const finishEvidence = beginAdventureEvidence({
          settings,
          caseId: testCase.id,
          repeat,
          state: request.state,
          questions: request.questions,
          candidates: testCase.candidates,
          corpus: cases,
          ...(variant === "shared-context" ? { payloadVersions: ADVENTURE_SHARED_CONTEXT_VERSIONS } : {}),
        });
        try {
          const result = await complete({ settings, state: request.state, questions: request.questions });
          model = result.model.responseModel ?? model;
          const readout: AdventureReadout = {
            ...gradeAdventureCase(testCase, composeAdventureSelection(testCase.candidates, result.answers, thresholds), result.answers),
            evidence: finishEvidence(result.model.responseModel),
          };
          attempts.push({
            variant,
            caseId: testCase.id,
            category: testCase.category,
            provenance: comparisonCaseProvenance(testCase),
            repeat,
            decision: readout.candidateId ?? "defer",
            requestDigest,
            corpusDigest,
            payloadBytes,
            model: result.model.responseModel,
            usage: result.usage,
            costUsd: usageCostUsd(result.usage, settings.pricing),
            latencyMs: Number.isFinite(result.provenance.latencyMs) ? result.provenance.latencyMs : null,
            bindingVersions: adventurePayloadVersions(variant),
            readout,
          });
        } catch (error) {
          failures.push(adventureFailureRecord(variant, testCase.id, repeat, error));
        }
      }
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  if (attempts.length === 0) {
    const first = failures[0];
    throw new Error(
      `no paired adventure calls succeeded (${failures.length} failed)${first ? `; first error on \`${first.caseId}\` ${first.variant} repeat ${first.repeat}: ${first.message}` : ""}`,
    );
  }
  const variants = Object.fromEntries(ADVENTURE_PAYLOAD_VARIANTS.map((variant): [AdventurePayloadVariant, VariantRunSummary] => {
    const variantAttempts = attempts.filter((attempt) => attempt.variant === variant);
    const readouts = variantAttempts.map((attempt) => attempt.readout);
    return [variant, {
      readouts,
      metrics: summarizeVariantMetrics(readouts, cases),
      stability: summarizeAdventureStability(readouts),
      usage: summarizeAttemptUsage(variantAttempts),
    }];
  })) as Record<AdventurePayloadVariant, VariantRunSummary>;
  const agreement = summarizeVariantAgreement(
    attempts.map((attempt) => ({ caseId: attempt.caseId, variant: attempt.variant, decision: attempt.decision })),
  );
  return {
    model,
    baseUrl: settings.baseUrl,
    repeats,
    maxCalls,
    projectedCalls: budget.projectedCalls,
    thresholds,
    bindings: {
      legacy: adventurePayloadVersions("legacy"),
      "shared-context": adventurePayloadVersions("shared-context"),
    },
    attempts,
    failures,
    variants,
    agreement,
  };
}

// ---------------------------------------------------------------------------------------------
// Report view, markdown, and JSON sidecar
// ---------------------------------------------------------------------------------------------

export interface ComparisonView {
  mode: "offline" | "live";
  generatedAt: string;
  cases: readonly AdventureCaseRow[];
  harvest: AdventureHarvestReport;
  /** SHA-256 over the ordered case identities. */
  corpusDigest: string;
  rows: readonly PayloadByteRow[];
  structural: readonly StructuralPairResult[];
  summary: PayloadByteSummary;
  top: number;
  out: string;
  jsonPath: string;
  live?: LiveComparison;
}

export interface ComparisonViewInput {
  mode: "offline" | "live";
  generatedAt: string;
  cases: readonly AdventureCaseRow[];
  harvest: AdventureHarvestReport;
  top: number;
  out: string;
  jsonPath: string;
  live?: LiveComparison;
}

/** Empty harvest provenance for callers that hold the cases directly (tests, custom corpora). */
export function emptyHarvestReport(fixture: string = HARVEST_FIXTURE): AdventureHarvestReport {
  return { fixture, present: false, confirmed: 0, skipped: 0, cases: 0, humanCases: 0, agentCases: 0, warning: null };
}

/** Builds the full offline comparison view: paired rows, structural results, summary, and digest. */
export function buildComparisonView(input: ComparisonViewInput): ComparisonView {
  const { rows, structural, corpusDigest } = buildPayloadComparisons(input.cases);
  return {
    mode: input.mode,
    generatedAt: input.generatedAt,
    cases: input.cases,
    harvest: input.harvest,
    corpusDigest,
    rows,
    structural,
    summary: summarizePayloadBytes(rows),
    top: input.top,
    out: input.out,
    jsonPath: input.jsonPath,
    ...(input.live ? { live: input.live } : {}),
  };
}

/** The provider-free entry point: builds and renders the report without touching the network. */
export function compareAdventurePayloadsOffline(input: Omit<ComparisonViewInput, "mode">): {
  view: ComparisonView;
  markdown: string;
  json: ComparisonReportJson;
} {
  const view = buildComparisonView({ ...input, mode: "offline" });
  return { view, markdown: renderComparisonReport(view), json: comparisonJson(view) };
}

function pctText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function bytesText(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function meanBytesText(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

function signedBytes(value: number | null): string {
  if (value === null) return "n/a";
  return `${value > 0 ? "+" : ""}${value}`;
}

function signedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function shortDigest(value: string | null): string {
  return value === null ? "n/a" : value.slice(0, 12);
}

function provenanceText(provenance: AdventureCaseProvenance): string {
  if (provenance === "frozen") return "frozen";
  return provenance === "harvested-human" ? "harvested (human)" : "harvested (agent)";
}

/** Table-cell text: pipes and newlines cannot break a markdown row. */
function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function subsetRow(variant: AdventurePayloadVariant, scope: string, summary: AdventureSubsetSummary): string {
  const coverage = summary.calls === 0 ? null : summary.acted / summary.calls;
  return `| ${variant} | ${scope} | ${summary.calls} | ${summary.acted} | ${pctText(coverage)} | ${summary.acted === 0 ? "n/a" : pctText(summary.actedAccuracy)} | ${summary.calls === 0 ? "n/a" : `${summary.exact}/${summary.calls}`} | ${summary.calls === 0 ? "n/a" : pctText(summary.accuracy)} |`;
}

/** Shared honesty notes rendered into both the markdown report and the JSON sidecar. */
export function comparisonNotes(view: ComparisonView): string[] {
  const notes = [
    "Payload bytes are the UTF-8 length of the serialized `{ state, questions }` request JSON; they are not provider input tokens, billed cost, or latency.",
    "The shared-context payload is evaluation-only and is not wired to the runtime lane; this runner never changes runtime or shadow payloads.",
    "The frozen corpus is a hand-labeled projection and harvested rows are live-derived labels. Curated benchmark cases bypass production shortlisting, so this comparison is not production shortlist coverage, and accuracy claims stay tied to the labeled corpora (frozen plus human-confirmed harvested).",
    "Agent-reviewed harvested cases are scored and reported but are not promotion evidence.",
    "Structural pairing compares the two built requests per case; any mismatch is a reported failure, never a silent drop.",
  ];
  notes.push(view.mode === "live"
    ? "Tokens, cost, and latency are provider measurements for this run (null when the provider reported none); cost is derived from reported usage and the configured pricing, not a billed amount."
    : "Offline mode sends no network calls and measures no tokens, cost, or latency.");
  return notes;
}

/** Renders the markdown report. Pure. */
export function renderComparisonReport(view: ComparisonView): string {
  const { mode, generatedAt, cases, harvest, corpusDigest, rows, structural, summary, top, jsonPath, live } = view;
  const failed = structural.filter((result) => !result.ok);
  const frozen = cases.length - harvest.cases;
  const bounded = boundedDeltaRows(rows, top);
  const structuralByCase = new Map<string, StructuralPairResult>(structural.map((result): [string, StructuralPairResult] => [result.caseId, result]));
  const lines: string[] = [];

  lines.push("# System One adventure payload comparison — legacy vs shared-context");
  lines.push("");
  lines.push(`Generated ${generatedAt} by \`${SCRIPT}\` (${mode === "live" ? "live paired run" : "provider-free (offline; no network calls)"}).`);
  lines.push("");
  lines.push("## What this measures");
  lines.push("");
  lines.push("`buildAdventureBenchmarkRequest` builds two payloads for the same case:");
  lines.push("");
  lines.push("- **legacy** — the benchmark-shaped request the evaluator already runs: state carries the declaration and the");
  lines.push("  advertised candidate count, and the question battery embeds the declaration into the `supported` noul, each");
  lines.push("  per-candidate relevance `score`, and the aggregate `best_candidate` choice.");
  lines.push("- **shared-context** — the experimental request: the declaration and every advertised candidate (including");
  lines.push("  duplicate instances and digest bindings) live in state, and the questions reference candidate ids and");
  lines.push("  describe judgments.");
  lines.push("");
  lines.push("This runner builds both variants for every case, serializes them as `{ state, questions }`, and compares the");
  lines.push("UTF-8 byte length, the request digests, and the candidate surfaces. Payload size is not provider input tokens,");
  lines.push("billed cost, or latency; provider usage is measured separately in live mode.");
  if (mode === "offline") {
    lines.push("");
    lines.push("Offline mode makes no model calls, so it derives no accuracy claim: a smaller payload is not evidence of a");
    lines.push("correct or equivalent decision. The comparison is a regression guard over payload construction.");
  }
  lines.push("");
  lines.push("Both variants must expose the same candidate identities and count. A structural mismatch is reported as a");
  lines.push("failure below and in the JSON sidecar, never silently dropped.");
  lines.push("");
  lines.push("## Corpus");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Mode | ${mode === "live" ? "live paired run (provider calls measured)" : "provider-free (offline; no network calls)"} |`);
  lines.push(`| Cases | ${cases.length} (${frozen} frozen + ${harvest.cases} harvested: ${harvest.humanCases} human-confirmed, ${harvest.agentCases} agent-reviewed) |`);
  lines.push(`| Frozen corpus | \`${ADVENTURE_EVAL_CORPUS_VERSION}\` |`);
  lines.push(`| Harvest fixture | \`${harvest.fixture}\` (${harvest.present ? `present${harvest.confirmed > 0 ? `, ${harvest.confirmed} confirmed` : ""}${harvest.skipped > 0 ? `, ${harvest.skipped} skipped` : ""}` : "absent"}) |`);
  lines.push(`| Corpus digest | \`${corpusDigest}\` (SHA-256 over the ordered case identities) |`);
  lines.push(`| Structural pairing | ${structural.length - failed.length}/${structural.length} case(s) clean |`);
  if (live) {
    lines.push(`| Model | ${live.model} |`);
    lines.push(`| Base URL | ${live.baseUrl} |`);
    lines.push(`| Repeats | ${live.repeats} per variant per case (interleaved per case) |`);
    lines.push(`| Budget | \`--max-calls ${live.maxCalls}\`; projected ${live.projectedCalls} call(s) |`);
    lines.push(`| Action threshold | act >= ${live.thresholds.actionThreshold}, confirm >= ${live.thresholds.reviewThreshold} |`);
  }
  lines.push("");
  if (harvest.warning) {
    lines.push(`> **Harvest warning:** ${harvest.warning} Those proposals are skipped; the run continues.`);
    lines.push("");
  }
  lines.push("## Payload bytes");
  lines.push("");
  lines.push("| Variant | Total bytes | Mean | Min | Max |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  lines.push(`| legacy | ${bytesText(summary.legacyBytes)} | ${meanBytesText(summary.legacyMean)} | ${bytesText(summary.legacyMin)} | ${bytesText(summary.legacyMax)} |`);
  lines.push(`| shared-context | ${bytesText(summary.sharedBytes)} | ${meanBytesText(summary.sharedMean)} | ${bytesText(summary.sharedMin)} | ${bytesText(summary.sharedMax)} |`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Delta (shared − legacy) | ${signedBytes(summary.deltaBytes)} bytes |`);
  lines.push(`| Delta percent | ${signedPercent(summary.deltaPercent)} |`);
  lines.push(`| Cases shrunk | ${summary.shrink} |`);
  lines.push(`| Cases grown | ${summary.grow} |`);
  lines.push(`| Cases equal | ${summary.equal} |`);
  lines.push(`| Cases not measured | ${summary.incomplete} |`);
  lines.push("");
  lines.push("## Per-case byte deltas");
  lines.push("");
  lines.push(`Sorted by absolute delta; showing the first ${top} and last ${top} row(s). All ${rows.length} case(s) are in the JSON sidecar.`);
  lines.push("");
  lines.push("| Case | Category | Provenance | Candidates | Legacy bytes | Shared bytes | Delta | Delta % | Request digest (legacy) | Request digest (shared) | Structure |");
  lines.push("| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | --- | --- | :---: |");
  for (const row of bounded.shown) {
    const structure = structuralByCase.get(row.caseId);
    lines.push(`| ${cell(row.caseId)} | ${row.category} | ${provenanceText(row.provenance)} | ${row.candidateCount} | ${bytesText(row.legacyBytes)} | ${bytesText(row.sharedBytes)} | ${signedBytes(row.deltaBytes)} | ${signedPercent(row.deltaPercent)} | ${shortDigest(row.legacyDigest)} | ${shortDigest(row.sharedDigest)} | ${structure?.ok ? "paired" : "mismatch"} |`);
  }
  if (bounded.omitted > 0) lines.push(`| … | | | | | | | | | | ${bounded.omitted} row(s) omitted |`);
  lines.push("");
  lines.push("## Structural pairing");
  lines.push("");
  lines.push("Both variants must expose the same candidate identities and count for every case: no candidate may be lost,");
  lines.push("added, or reordered, and the question batteries must agree. A mismatch is a failure, not a silent drop.");
  lines.push("");
  lines.push(`**${structural.length - failed.length}/${structural.length}** case(s) paired cleanly.`);
  lines.push("");
  if (failed.length === 0) {
    lines.push("Every case exposes the same ordered candidate identities and question batteries in both variants.");
  } else {
    lines.push("| Case | Candidates | Mismatch |");
    lines.push("| --- | ---: | --- |");
    for (const result of failed.slice(0, top)) lines.push(`| ${cell(result.caseId)} | ${result.candidateCount} | ${cell(result.mismatches.join("; "))} |`);
    if (failed.length > top) lines.push(`| … | | ${failed.length - top} more failing case(s) |`);
  }
  lines.push("");
  if (live) {
    const agreement = live.agreement;
    const pairedCases = agreement.cases.filter((entry) => entry.crossVariantAgreement !== null).length;
    const conflicts = agreement.cases
      .filter((entry) => entry.conflicted || entry.crossVariantConflicted)
      .sort((left, right) => (left.crossVariantAgreement ?? 1) - (right.crossVariantAgreement ?? 1) || left.caseId.localeCompare(right.caseId))
      .slice(0, top);
    lines.push("## Agreement");
    lines.push("");
    lines.push(`Each case ran both variants ${live.repeats} time(s), interleaved per case. \`decision\` is the candidate a call named`);
    lines.push("(the composed pick, or the raw pick recovered from a deferral), else `defer`.");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("| --- | ---: |");
    lines.push(`| Cases with attempts from both variants | ${pairedCases} of ${agreement.cases.length} |`);
    lines.push(`| Mean agreement across attempts | ${pctText(agreement.cases.length === 0 ? null : agreement.meanAgreement)} |`);
    lines.push(`| Cases conflicted across attempts | ${agreement.conflictCases} (${pctText(agreement.conflictRate)}) |`);
    lines.push(`| Cases with a cross-variant conflict | ${agreement.crossVariantConflictCases} of ${pairedCases} |`);
    lines.push(`| Mean cross-variant agreement | ${pctText(pairedCases === 0 ? null : agreement.meanCrossVariantAgreement)} |`);
    lines.push("");
    if (conflicts.length === 0) {
      lines.push("No per-case decision conflicts: every case repeated the same decision across variants and repeats.");
    } else {
      lines.push("| Case | Attempts | Legacy decisions | Shared decisions | Agreement | Cross-variant |");
      lines.push("| --- | ---: | --- | --- | ---: | ---: |");
      for (const entry of conflicts) {
        lines.push(`| ${cell(entry.caseId)} | ${entry.attempts} | ${cell(entry.legacyDecisions.join(" / ") || "—")} | ${cell(entry.sharedDecisions.join(" / ") || "—")} | ${pctText(entry.agreement)} | ${pctText(entry.crossVariantAgreement)} |`);
      }
    }
    lines.push("");
    lines.push("## Grading metrics per variant");
    lines.push("");
    lines.push(`Composed at the lane's default action threshold (act >= ${live.thresholds.actionThreshold}). Coverage is acted/graded calls;`);
    lines.push("acted accuracy counts acted decisions in the case's acceptable set; exact preferred counts the single preferred call;");
    lines.push("asserted-subset accuracy counts committed selections or deferrals in the acceptable set. The **agent-reviewed");
    lines.push("harvested** scope is scored but is not promotion evidence, and curated benchmark cases bypass production shortlisting,");
    lines.push("so accuracy claims stay tied to the labeled scope (frozen plus human-confirmed harvested).");
    lines.push("");
    lines.push("| Variant | Scope | Calls | Acted | Coverage | Acted accuracy | Exact preferred | Asserted-subset accuracy |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const variant of ADVENTURE_PAYLOAD_VARIANTS) {
      const metrics = live.variants[variant].metrics;
      lines.push(subsetRow(variant, "All graded cases", metrics.all));
      lines.push(subsetRow(variant, "Labeled (frozen + human-confirmed)", metrics.gateScope));
      lines.push(subsetRow(variant, "Agent-reviewed harvested (not gated)", metrics.agentSubset));
    }
    lines.push("");
    lines.push("Per-variant repeat stability (using the evaluator's stability roll-up):");
    lines.push("");
    lines.push("| Variant | Mean agreement | Conflict cases | Mean signal std dev |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const variant of ADVENTURE_PAYLOAD_VARIANTS) {
      const stability = live.variants[variant].stability;
      lines.push(`| ${variant} | ${pctText(stability.meanAgreement)} | ${stability.conflictCases} of ${stability.cases.length} | ${stability.meanSignalStdDev === null ? "n/a" : stability.meanSignalStdDev.toFixed(4)} |`);
    }
    lines.push("");
    lines.push("## Provider usage (measured separately)");
    lines.push("");
    lines.push("Tokens, cost, and latency are provider measurements for the calls each variant made; `null` means the provider did");
    lines.push("not report the value. Cost is derived from reported usage and the configured pricing, not a billed amount. These");
    lines.push("figures are separate from the payload bytes above.");
    lines.push("");
    lines.push("| Variant | Attempts | Usage reported | Input tokens | Output tokens | Total tokens | Cost (USD) | Mean latency | Total latency | Failures |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const variant of ADVENTURE_PAYLOAD_VARIANTS) {
      const usage = live.variants[variant].usage;
      const failures = live.failures.filter((failure) => failure.variant === variant).length;
      lines.push(`| ${variant} | ${usage.attempts} | ${usage.usageReported} | ${bytesText(usage.inputTokens)} | ${bytesText(usage.outputTokens)} | ${bytesText(usage.totalTokens)} | ${usage.costUsd === null ? "n/a" : usage.costUsd.toFixed(6)} | ${usage.meanLatencyMs === null ? "n/a" : `${Math.round(usage.meanLatencyMs)} ms`} | ${Math.round(usage.totalLatencyMs)} ms | ${failures} |`);
    }
    lines.push("");
    lines.push("## Failures");
    lines.push("");
    if (live.failures.length === 0) {
      lines.push("No adapter failures: every scheduled call returned a graded composition.");
    } else {
      lines.push("| Variant | Case | Repeat | Code | Message |");
      lines.push("| --- | --- | ---: | --- | --- |");
      for (const failure of live.failures.slice(0, top)) {
        lines.push(`| ${failure.variant} | ${cell(failure.caseId)} | ${failure.repeat} | ${failure.code} | ${cell(failure.message.slice(0, 200))} |`);
      }
      if (live.failures.length > top) lines.push(`| … | | | | ${live.failures.length - top} more failure(s) |`);
    }
    lines.push("");
  }
  lines.push("## Honesty notes");
  lines.push("");
  for (const note of comparisonNotes(view)) lines.push(`- ${note}`);
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push(`npx tsx ${SCRIPT} --out ${view.out}`);
  lines.push("# live paired run (owner-approved budget; both variants, interleaved per case):");
  lines.push("set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY");
  lines.push(`npx tsx ${SCRIPT} --live --max-calls ${live ? live.maxCalls : LIVE_CALL_CAP} --repeat ${live ? live.repeats : 1}`);
  lines.push("```");
  lines.push("");
  lines.push(`Raw per-case data: \`${jsonPath}\`.`);
  lines.push("");
  return lines.join("\n");
}

export interface ComparisonReportJson {
  script: string;
  mode: "offline" | "live";
  generatedAt: string;
  out: string;
  jsonPath: string;
  corpus: {
    cases: number;
    frozen: number;
    harvested: number;
    harvestedHuman: number;
    harvestedAgent: number;
    /** SHA-256 over the ordered case identities. */
    digest: string;
    ids: string[];
    frozenVersion: string;
    fixture: string;
    fixturePresent: boolean;
    warning: string | null;
  };
  payloadBytes: PayloadByteSummary;
  cases: PayloadByteRow[];
  structural: { cases: number; paired: number; failures: StructuralPairResult[] };
  notes: string[];
  live?: LiveComparison;
}

/** The JSON sidecar. Existing tooling can read each variant's evaluator-shaped readouts from `live`. */
export function comparisonJson(view: ComparisonView): ComparisonReportJson {
  const failures = view.structural.filter((result) => !result.ok);
  return {
    script: SCRIPT,
    mode: view.mode,
    generatedAt: view.generatedAt,
    out: view.out,
    jsonPath: view.jsonPath,
    corpus: {
      cases: view.cases.length,
      frozen: view.cases.length - view.harvest.cases,
      harvested: view.harvest.cases,
      harvestedHuman: view.harvest.humanCases,
      harvestedAgent: view.harvest.agentCases,
      digest: view.corpusDigest,
      ids: view.cases.map((testCase) => testCase.id),
      frozenVersion: ADVENTURE_EVAL_CORPUS_VERSION,
      fixture: view.harvest.fixture,
      fixturePresent: view.harvest.present,
      warning: view.harvest.warning,
    },
    payloadBytes: view.summary,
    cases: [...view.rows],
    structural: {
      cases: view.structural.length,
      paired: view.structural.length - failures.length,
      failures: failures.map((failure) => ({ ...failure })),
    },
    notes: comparisonNotes(view),
    ...(view.live ? { live: view.live } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  let options: CompareCliOptions;
  try {
    options = parseCompareArgs(process.argv.slice(2));
  } catch (error) {
    console.error(messageOf(error));
    process.exitCode = 1;
    return;
  }
  const outPath = path.resolve(ROOT, options.out);
  const jsonPath = path.resolve(ROOT, options.json);
  const harvest = await loadHarvestedAdventureCases();
  if (harvest.warning) console.warn(`harvested fixture warning: ${harvest.warning}`);
  const harvestReport: AdventureHarvestReport = {
    fixture: HARVEST_FIXTURE,
    present: harvest.present,
    confirmed: harvest.confirmed,
    skipped: harvest.skipped,
    cases: harvest.cases.length,
    humanCases: harvest.humanCases,
    agentCases: harvest.agentCases,
    warning: harvest.warning,
  };
  const cases: AdventureCaseRow[] = [...ADVENTURE_EVAL_CASES, ...harvest.cases];

  let live: LiveComparison | undefined;
  if (options.live) {
    const key = process.env.TYPESAFE_API_KEY?.trim() ?? "";
    if (!key) {
      console.error("TYPESAFE_API_KEY is required for a live paired comparison.");
      process.exitCode = 1;
      return;
    }
    const budget = checkLiveBudget({ live: true, maxCalls: options.maxCalls, cases: cases.length, repeats: options.repeats });
    const maxCalls = budget.maxCalls;
    if (!budget.ok || maxCalls === null) {
      console.error(budget.error ?? "live paired comparison budget refused");
      process.exitCode = 1;
      return;
    }
    const settings = { ...defaultSystemOneSettings(), apiKey: key };
    console.log(`live paired comparison: ${cases.length} case(s) x ${options.repeats} repeat(s) x ${ADVENTURE_PAYLOAD_VARIANTS.length} variants = ${budget.projectedCalls} call(s) against ${settings.model}; --max-calls ${maxCalls}`);
    live = await runLiveComparison({ cases, repeats: options.repeats, maxCalls, settings });
  }

  const view = buildComparisonView({
    mode: options.live ? "live" : "offline",
    generatedAt: new Date().toISOString(),
    cases,
    harvest: harvestReport,
    top: options.top,
    out: options.out,
    jsonPath: options.json,
    ...(live ? { live } : {}),
  });
  await writeFile(outPath, `${renderComparisonReport(view)}\n`, "utf8");
  await writeFile(jsonPath, `${JSON.stringify(comparisonJson(view), null, 2)}\n`, "utf8");

  console.log(`payload bytes: legacy ${view.summary.legacyBytes} -> shared-context ${view.summary.sharedBytes} (${signedPercent(view.summary.deltaPercent)})`);
  console.log(`cases: ${view.summary.shrink} shrunk, ${view.summary.grow} grown, ${view.summary.equal} equal, ${view.summary.incomplete} unmeasured`);
  const failed = view.structural.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.error(`structural pairing failed for ${failed.length} case(s): ${failed.slice(0, 3).map((result) => result.caseId).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`structural pairing: ${view.structural.length}/${view.structural.length} case(s) clean`);
  }
  if (live) {
    const pairedCases = live.agreement.cases.filter((entry) => entry.crossVariantAgreement !== null).length;
    console.log(`agreement: mean ${pctText(live.agreement.meanAgreement)}, cross-variant conflicts ${live.agreement.crossVariantConflictCases}/${pairedCases}`);
    console.log(`failures: ${live.failures.length}`);
  }
  console.log(`wrote ${path.relative(ROOT, outPath)} and ${path.relative(ROOT, jsonPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
