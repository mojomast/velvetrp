import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ADVENTURE_NONE,
  ADVENTURE_SHARED_CONTEXT_VERSIONS,
  ADVENTURE_SUPPORTED_KEY,
} from "../../server/src/agent/systemOneAdventure.js";
import { defaultSystemOneSettings } from "../../server/src/defaults.js";
import type {
  SystemOneAnswer,
  SystemOneCompletionInput,
  SystemOneCompletionResult,
} from "../../server/src/provider/systemOneCompletion.js";
import {
  ADVENTURE_EVAL_CASES,
  type AdventureEvalCase,
} from "../../server/test/fixtures/adventure-evals/corpus.js";
import {
  buildAdventureBenchmarkRequest,
  loadHarvestedAdventureCases,
  type AdventureReadout,
} from "../evaluate-system-one-adventure-lane.js";
import {
  LIVE_CALL_CAP,
  adventureCorpusDigest,
  adventurePayloadVersions,
  adventureRequestDigest,
  boundedDeltaRows,
  buildComparisonView,
  buildPayloadComparisons,
  checkLiveBudget,
  checkPayloadStructure,
  compareAdventurePayloadsOffline,
  comparisonJson,
  emptyHarvestReport,
  parseCompareArgs,
  renderComparisonReport,
  runLiveComparison,
  serializedRequestBytes,
  summarizeAttemptUsage,
  summarizePayloadBytes,
  summarizeVariantAgreement,
  usageCostUsd,
  type AdventureAttemptRecord,
  type AgreementSample,
  type PayloadByteRow,
} from "../compare-system-one-adventure-payloads.js";
import { beginAdventureEvidence } from "../system-one-evidence.js";

const digestSeed = (seed: string): string => seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64);

const candidate = (candidateId: string, label: string, kind = "exact_actor_travel.select") => ({
  candidateId,
  digest: digestSeed(candidateId),
  kind,
  label,
});

const evalCase = (overrides: Partial<AdventureEvalCase> = {}): AdventureEvalCase => ({
  id: "case",
  category: "direct-match",
  holdout: false,
  declaration: "I walk to the mill.",
  candidates: [candidate("a", "Travel to the mill")],
  expected: { preferred: "a", acceptable: ["a"] },
  ...overrides,
});

const byteRow = (caseId: string, legacyBytes: number | null, sharedBytes: number | null): PayloadByteRow => {
  const deltaBytes = legacyBytes === null || sharedBytes === null ? null : sharedBytes - legacyBytes;
  return {
    caseId,
    category: "direct-match",
    provenance: "frozen",
    candidateCount: 1,
    legacyBytes,
    sharedBytes,
    deltaBytes,
    deltaPercent: deltaBytes === null || legacyBytes === null || legacyBytes === 0 ? null : (deltaBytes / legacyBytes) * 100,
    legacyDigest: null,
    sharedDigest: null,
  };
};

const readoutFixture = (overrides: Partial<AdventureReadout> = {}): AdventureReadout => ({
  id: "case",
  category: "direct-match",
  holdout: false,
  band: "fallback",
  method: "defer",
  selected: null,
  candidateId: null,
  acceptable: [null],
  selectedCorrect: true,
  deferred: true,
  correct: true,
  topSignal: null,
  reason: "test",
  ...overrides,
});

const attemptRecord = (overrides: Partial<AdventureAttemptRecord> = {}): AdventureAttemptRecord => ({
  variant: "legacy",
  caseId: "case",
  category: "direct-match",
  provenance: "frozen",
  repeat: 1,
  decision: "defer",
  requestDigest: "0".repeat(64),
  corpusDigest: "1".repeat(64),
  payloadBytes: 10,
  model: null,
  usage: null,
  costUsd: null,
  latencyMs: null,
  bindingVersions: adventurePayloadVersions("legacy"),
  readout: readoutFixture(),
  ...overrides,
});

/**
 * A deterministic offline adapter double: it answers every question by shape, never touches the
 * network, and always names the first advertised candidate. Both variants get the same answers,
 * so it exercises attempt assembly, grading, and agreement without measuring the model.
 */
async function fakeCompletion(input: SystemOneCompletionInput): Promise<SystemOneCompletionResult> {
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [key, question] of Object.entries(input.questions)) {
    if (key === ADVENTURE_SUPPORTED_KEY) {
      answers[key] = { type: "noul", noul: 0.9 };
      continue;
    }
    if (question.type === "score") {
      answers[key] = { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: { "0": 0.02, "1": 0.03, "2": 0.05, "3": 0.9 } };
      continue;
    }
    const options = Object.keys(question.criteria ?? {});
    const pick = options.find((option) => option !== ADVENTURE_NONE) ?? ADVENTURE_NONE;
    const rest = (1 - 0.9) / Math.max(1, options.length - 1);
    answers[key] = {
      type: "choice",
      choice: pick,
      confidence: 0.9,
      probabilities: Object.fromEntries(options.map((option): [string, number] => [option, option === pick ? 0.9 : rest])),
    };
  }
  return {
    model: { requestedModel: input.settings.model, responseModel: "fake-model" },
    answers,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    provenance: { requestId: null, latencyMs: 12, attempts: 1 },
  };
}

test("parses CLI flags with safe defaults and validates the budget flag shape", () => {
  assert.deepEqual(parseCompareArgs([]), {
    live: false,
    out: "docs/system-one-adventure-payload-comparison.md",
    json: "docs/system-one-adventure-payload-comparison.json",
    top: 10,
    repeats: 1,
    maxCalls: null,
  });
  assert.deepEqual(parseCompareArgs(["--live", "--max-calls", "300", "--repeat=2", "--top", "5", "--out", "docs/x.md", "--json", "/tmp/x.json"]), {
    live: true,
    out: "docs/x.md",
    json: "/tmp/x.json",
    top: 5,
    repeats: 2,
    maxCalls: 300,
  });
  assert.equal(parseCompareArgs(["--top", "999"]).top, 100);
  assert.equal(parseCompareArgs(["--top", "0"]).top, 1);
  assert.equal(parseCompareArgs(["--repeat", "404"]).repeats, 25);
  assert.equal(parseCompareArgs(["--out", "custom"]).json, "custom.json", "the JSON sidecar defaults alongside the markdown");
  assert.equal(parseCompareArgs(["--live", "--max-calls=10", "--payload", "legacy"]).live, true, "--payload is ignored: both variants always run");
  for (const args of [["--max-calls"], ["--max-calls", "nope"], ["--max-calls", "0"], ["--max-calls", "3.5"]]) {
    assert.throws(() => parseCompareArgs(args), /positive integer/, `expected a refusal for ${args.join(" ")}`);
  }
});

test("validates the live call budget before any call", () => {
  assert.deepEqual(checkLiveBudget({ live: false, maxCalls: null, cases: 135, repeats: 3 }), {
    ok: true,
    error: null,
    projectedCalls: 810,
    maxCalls: null,
  });

  const missing = checkLiveBudget({ live: true, maxCalls: null, cases: 1, repeats: 1 });
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /--max-calls/);

  const overCap = checkLiveBudget({ live: true, maxCalls: LIVE_CALL_CAP + 1, cases: 1, repeats: 1 });
  assert.equal(overCap.ok, false);
  assert.match(overCap.error ?? "", /cap/);

  const overrun = checkLiveBudget({ live: true, maxCalls: 100, cases: 20, repeats: 3 });
  assert.equal(overrun.projectedCalls, 120);
  assert.equal(overrun.ok, false);
  assert.match(overrun.error ?? "", /120 call\(s\).*budget/);

  const exact = checkLiveBudget({ live: true, maxCalls: 120, cases: 20, repeats: 3 });
  assert.equal(exact.ok, true);
  assert.equal(exact.maxCalls, 120);
  assert.equal(exact.projectedCalls, 120);
});

test("derives deterministic request and corpus digests", () => {
  const testCase = ADVENTURE_EVAL_CASES.find((entry) => entry.candidates.length >= 2)!;
  const legacy = buildAdventureBenchmarkRequest(testCase, "legacy");
  const shared = buildAdventureBenchmarkRequest(testCase, "shared-context");
  const settings = defaultSystemOneSettings();
  const base = { settings, caseId: testCase.id, repeat: 1, candidates: testCase.candidates, corpus: ADVENTURE_EVAL_CASES };
  const legacyEvidence = beginAdventureEvidence({ ...base, ...legacy })("model");
  const sharedEvidence = beginAdventureEvidence({ ...base, ...shared, payloadVersions: ADVENTURE_SHARED_CONTEXT_VERSIONS })("model");

  assert.equal(adventureRequestDigest(legacy), legacyEvidence.requestDigest);
  assert.equal(adventureRequestDigest(shared), sharedEvidence.requestDigest);
  assert.notEqual(adventureRequestDigest(legacy), adventureRequestDigest(shared));
  assert.equal(adventureRequestDigest(legacy), adventureRequestDigest(buildAdventureBenchmarkRequest(testCase, "legacy")), "digests are stable across identical builds");

  assert.equal(adventureCorpusDigest(ADVENTURE_EVAL_CASES), createHash("sha256").update(JSON.stringify(ADVENTURE_EVAL_CASES.map((entry) => entry.id))).digest("hex"));
  assert.equal(adventureCorpusDigest(ADVENTURE_EVAL_CASES), adventureCorpusDigest(ADVENTURE_EVAL_CASES));
  assert.notEqual(adventureCorpusDigest(ADVENTURE_EVAL_CASES), adventureCorpusDigest([...ADVENTURE_EVAL_CASES].reverse()), "case order is part of the corpus identity");
});

test("accounts payload bytes and counts shrink, grow, and equality", () => {
  const large = evalCase({
    id: "large",
    declaration: "I walk to the mill and back through the fog. ".repeat(20),
    candidates: "abcdefghij".split("").map((id, index) => candidate(id, `Travel option ${index + 1} to the mill`)),
    expected: { preferred: "a", acceptable: ["a"] },
  });
  const small = evalCase({ id: "small" });
  const empty = evalCase({ id: "empty", candidates: [], declaration: "I look around.", expected: { preferred: null, acceptable: [null] } });

  const { rows, structural, corpusDigest } = buildPayloadComparisons([large, small, empty]);
  assert.equal(rows.length, 3);
  assert.equal(structural.length, 3);
  assert.ok(structural.every((result) => result.ok), structural.flatMap((result) => result.mismatches).join("; "));
  assert.equal(corpusDigest, adventureCorpusDigest([large, small, empty]));
  for (const row of rows) {
    assert.ok((row.legacyBytes ?? 0) > 0);
    assert.ok((row.sharedBytes ?? 0) > 0);
    assert.equal(row.deltaBytes, (row.sharedBytes ?? 0) - (row.legacyBytes ?? 0));
  }
  const largeRow = rows.find((row) => row.caseId === "large")!;
  assert.ok((largeRow.sharedBytes ?? 0) < (largeRow.legacyBytes ?? 0), "a many-candidate long declaration shrinks under shared context");

  const summary = summarizePayloadBytes(rows);
  assert.equal(summary.cases, 3);
  assert.equal(summary.shrink + summary.grow + summary.equal, 3);
  assert.equal(summary.legacyBytes, rows.reduce((total, row) => total + (row.legacyBytes ?? 0), 0));
  assert.equal(summary.sharedBytes, rows.reduce((total, row) => total + (row.sharedBytes ?? 0), 0));
  assert.equal(summary.deltaBytes, summary.sharedBytes - summary.legacyBytes);

  const counted = summarizePayloadBytes([byteRow("shrink", 100, 50), byteRow("grow", 100, 150), byteRow("equal", 20, 20), byteRow("missing", 10, null)]);
  assert.deepEqual(
    {
      cases: counted.cases,
      incomplete: counted.incomplete,
      legacyBytes: counted.legacyBytes,
      sharedBytes: counted.sharedBytes,
      deltaBytes: counted.deltaBytes,
      deltaPercent: counted.deltaPercent,
      shrink: counted.shrink,
      grow: counted.grow,
      equal: counted.equal,
    },
    { cases: 3, incomplete: 1, legacyBytes: 220, sharedBytes: 220, deltaBytes: 0, deltaPercent: 0, shrink: 1, grow: 1, equal: 1 },
  );
  assert.equal(summarizePayloadBytes([byteRow("zero", 0, 5)]).deltaPercent, null, "a zero legacy size has no percentage");

  const bounded = boundedDeltaRows([byteRow("a", 100, 50), byteRow("b", 100, 60), byteRow("c", 100, 90), byteRow("d", 100, 0)], 1);
  assert.deepEqual(bounded.shown.map((row) => row.caseId), ["d", "c"]);
  assert.equal(bounded.omitted, 2);
});

test("reports structural pairing mismatches instead of dropping them", () => {
  const testCase = evalCase({ id: "paired", candidates: [candidate("a", "Travel to the mill"), candidate("b", "Travel to the harbor", "exact_srd_check.select")] });
  const legacy = buildAdventureBenchmarkRequest(testCase, "legacy");
  const shared = buildAdventureBenchmarkRequest(testCase, "shared-context");

  const clean = checkPayloadStructure(testCase, legacy, shared);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.mismatches, []);
  assert.equal(clean.sameQuestionOrder, true);
  assert.equal(clean.sameStateOrder, true);
  assert.equal(clean.legacy?.stateCandidateCount, 2);
  assert.deepEqual(clean.shared?.stateCandidateIds, ["a", "b"]);

  const truncatedShared = buildAdventureBenchmarkRequest(
    evalCase({ id: "paired", candidates: [candidate("a", "Travel to the mill")] }),
    "shared-context",
  );
  const truncated = checkPayloadStructure(testCase, legacy, truncatedShared);
  assert.equal(truncated.ok, false);
  assert.ok(truncated.mismatches.some((message) => message.includes("shared state advertises 1")), truncated.mismatches.join("; "));
  assert.ok(truncated.mismatches.some((message) => message.includes("lost candidate")), truncated.mismatches.join("; "));

  const miscounted = checkPayloadStructure(testCase, { state: { declaration: "x", candidateCount: 1 }, questions: legacy.questions }, shared);
  assert.equal(miscounted.ok, false);
  assert.ok(miscounted.mismatches.some((message) => message.includes("legacy state advertises 1")), miscounted.mismatches.join("; "));
});

test("reports a variant build failure as a structural failure with a null side", () => {
  const duplicated = evalCase({
    id: "duplicate",
    candidates: [candidate("a", "Travel to the mill"), candidate("a", "Travel to the mill")],
  });
  const { rows, structural } = buildPayloadComparisons([duplicated]);
  const row = rows[0]!;
  assert.ok(row.legacyBytes !== null);
  assert.equal(row.sharedBytes, null);
  assert.equal(row.deltaBytes, null);
  assert.equal(structural[0]?.ok, false);
  assert.ok(structural[0]?.mismatches.some((message) => message.includes("shared-context build failed")), structural[0]?.mismatches.join("; "));

  const summary = summarizePayloadBytes(rows);
  assert.equal(summary.cases, 0);
  assert.equal(summary.incomplete, 1);
});

test("computes within-case and cross-variant agreement", () => {
  const samples: AgreementSample[] = [
    { caseId: "agrees", variant: "legacy", decision: "a" },
    { caseId: "agrees", variant: "legacy", decision: "a" },
    { caseId: "agrees", variant: "shared-context", decision: "a" },
    { caseId: "agrees", variant: "shared-context", decision: "a" },
    { caseId: "flips", variant: "legacy", decision: "a" },
    { caseId: "flips", variant: "shared-context", decision: "b" },
    { caseId: "repeat-flips", variant: "legacy", decision: "a" },
    { caseId: "repeat-flips", variant: "legacy", decision: "b" },
    { caseId: "repeat-flips", variant: "shared-context", decision: "a" },
  ];
  const summary = summarizeVariantAgreement(samples);
  assert.equal(summary.cases.length, 3);

  const agrees = summary.cases.find((entry) => entry.caseId === "agrees")!;
  assert.equal(agrees.attempts, 4);
  assert.equal(agrees.agreement, 1);
  assert.equal(agrees.conflicted, false);
  assert.equal(agrees.crossVariantAgreement, 1);
  assert.equal(agrees.crossVariantConflicted, false);

  const flips = summary.cases.find((entry) => entry.caseId === "flips")!;
  assert.equal(flips.agreement, 0.5);
  assert.equal(flips.conflicted, true);
  assert.equal(flips.crossVariantAgreement, 0);
  assert.equal(flips.crossVariantConflicted, true);

  const repeatFlips = summary.cases.find((entry) => entry.caseId === "repeat-flips")!;
  assert.equal(repeatFlips.agreement, 2 / 3);
  assert.equal(repeatFlips.conflicted, true);
  assert.equal(repeatFlips.crossVariantAgreement, 0.5);
  assert.equal(repeatFlips.crossVariantConflicted, true);

  assert.equal(summary.conflictCases, 2);
  assert.equal(summary.crossVariantConflictCases, 2);
  assert.ok(Math.abs(summary.meanAgreement - (1 + 0.5 + 2 / 3) / 3) < 1e-9);
  assert.ok(Math.abs(summary.meanCrossVariantAgreement - (1 + 0 + 0.5) / 3) < 1e-9);

  const unpaired = summarizeVariantAgreement([{ caseId: "only-legacy", variant: "legacy", decision: "defer" }]);
  assert.equal(unpaired.cases[0]?.crossVariantAgreement, null, "a case without both variants has no cross-variant figure");
  assert.equal(unpaired.meanCrossVariantAgreement, 0);
  assert.equal(unpaired.crossVariantConflictCases, 0);
});

test("records exact payload and state binding versions per variant", () => {
  const legacy = adventurePayloadVersions("legacy");
  const shared = adventurePayloadVersions("shared-context");
  assert.equal(legacy.questionVersion, "adventure-grouped-v1");
  assert.equal(legacy.stateVersion, "adventure-declaration-candidates-v1");
  assert.equal(legacy.compositionVersion, "adventure-grouped-v1");
  assert.equal(legacy.candidateStrategy, "benchmark-curated-candidates-v1");
  assert.equal(shared.questionVersion, ADVENTURE_SHARED_CONTEXT_VERSIONS.questionVersion);
  assert.equal(shared.stateVersion, ADVENTURE_SHARED_CONTEXT_VERSIONS.stateVersion);
  assert.equal(shared.compositionVersion, legacy.compositionVersion);
  assert.notEqual(shared.questionVersion, legacy.questionVersion);
});

test("reports provider measurements only when provided", () => {
  const summary = summarizeAttemptUsage([
    attemptRecord({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, costUsd: 0.5, latencyMs: 10 }),
    attemptRecord({ usage: null, costUsd: null, latencyMs: 20 }),
    attemptRecord({ usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, costUsd: null, latencyMs: null }),
  ]);
  assert.deepEqual(
    {
      attempts: summary.attempts,
      usageReported: summary.usageReported,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      totalTokens: summary.totalTokens,
      costUsd: summary.costUsd,
      totalLatencyMs: summary.totalLatencyMs,
      meanLatencyMs: summary.meanLatencyMs,
    },
    { attempts: 3, usageReported: 2, inputTokens: 12, outputTokens: 8, totalTokens: 20, costUsd: 0.5, totalLatencyMs: 30, meanLatencyMs: 15 },
  );

  const nothing = summarizeAttemptUsage([attemptRecord()]);
  assert.equal(nothing.inputTokens, null);
  assert.equal(nothing.outputTokens, null);
  assert.equal(nothing.totalTokens, null);
  assert.equal(nothing.costUsd, null);
  assert.equal(nothing.meanLatencyMs, null);
  assert.equal(nothing.totalLatencyMs, 0);

  const usage = { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 };
  assert.equal(usageCostUsd(usage, { promptPerMillion: 0.042, completionPerMillion: 1 }), 0.042 + 0.5);
  assert.equal(usageCostUsd(usage, { promptPerMillion: null, completionPerMillion: 1 }), null);
  assert.equal(usageCostUsd(null, { promptPerMillion: 0.042, completionPerMillion: 1 }), null);
});

test("refuses a live run whose projection exceeds the budget before any call", async () => {
  let calls = 0;
  const complete = async (): Promise<SystemOneCompletionResult> => {
    calls += 1;
    throw new Error("must not be called");
  };
  await assert.rejects(
    () => runLiveComparison({ cases: [evalCase()], repeats: 3, maxCalls: 5, settings: defaultSystemOneSettings(), complete }),
    /budget/,
  );
  assert.equal(calls, 0);
});

test("assembles paired live metrics and renders them without network access", async () => {
  const cases = [
    evalCase({
      id: "two",
      candidates: [candidate("a", "Travel to the mill"), candidate("b", "Travel to the harbor", "exact_srd_check.select")],
      expected: { preferred: "a", acceptable: ["a", "b"] },
    }),
    evalCase({ id: "one", candidates: [candidate("s", "Travel to the mill")], expected: { preferred: "s", acceptable: ["s"] } }),
  ];
  const live = await runLiveComparison({ cases, repeats: 2, maxCalls: 100, settings: defaultSystemOneSettings(), complete: fakeCompletion });

  assert.equal(live.projectedCalls, 8);
  assert.equal(live.attempts.length, 8);
  assert.equal(live.failures.length, 0);
  assert.equal(live.variants.legacy.readouts.length, 4);
  assert.equal(live.variants["shared-context"].readouts.length, 4);

  for (const attempt of live.attempts) {
    const testCase = cases.find((entry) => entry.id === attempt.caseId)!;
    assert.equal(attempt.model, "fake-model");
    assert.equal(attempt.decision, attempt.readout.candidateId ?? "defer");
    assert.equal(attempt.payloadBytes, serializedRequestBytes(buildAdventureBenchmarkRequest(testCase, attempt.variant)));
    assert.equal(attempt.requestDigest, adventureRequestDigest(buildAdventureBenchmarkRequest(testCase, attempt.variant)));
    assert.equal(attempt.corpusDigest, adventureCorpusDigest(cases));
    assert.equal(attempt.bindingVersions.questionVersion, adventurePayloadVersions(attempt.variant).questionVersion);
    assert.ok(attempt.readout.evidence, "every attempt carries its frozen evidence");
    assert.deepEqual(attempt.bindingVersions, live.bindings[attempt.variant]);
  }

  const legacyUsage = live.variants.legacy.usage;
  assert.equal(legacyUsage.attempts, 4);
  assert.equal(legacyUsage.usageReported, 4);
  assert.equal(legacyUsage.inputTokens, 40);
  assert.equal(legacyUsage.outputTokens, 20);
  assert.equal(legacyUsage.totalTokens, 60);
  assert.equal(legacyUsage.meanLatencyMs, 12);
  assert.ok((legacyUsage.costUsd ?? 0) > 0, "cost is derived from reported usage and configured pricing");

  assert.equal(live.variants.legacy.metrics.all.calls, 4);
  assert.equal(live.variants.legacy.metrics.all.acted, 4);
  assert.equal(live.variants.legacy.metrics.all.actedAccuracy, 1);
  assert.equal(live.variants.legacy.metrics.all.exact, 4);
  assert.equal(live.variants.legacy.metrics.agentSubset.cases, 0);
  assert.equal(live.variants.legacy.metrics.gateScope.cases, 2);
  assert.equal(live.agreement.cases.length, 2);
  assert.equal(live.agreement.crossVariantConflictCases, 0);
  assert.equal(live.agreement.meanAgreement, 1);

  const view = buildComparisonView({
    mode: "live",
    generatedAt: "2026-09-22T00:00:00.000Z",
    cases,
    harvest: emptyHarvestReport(),
    top: 10,
    out: "docs/x.md",
    jsonPath: "docs/x.json",
    live,
  });
  const report = renderComparisonReport(view);
  assert.ok(report.includes("## Agreement"));
  assert.ok(report.includes("## Grading metrics per variant"));
  assert.ok(report.includes("## Provider usage (measured separately)"));
  assert.ok(report.includes("## Payload bytes"));
  assert.ok(report.includes("## Structural pairing"));
  assert.ok(report.includes("fake-model"));
  assert.ok(report.includes("| legacy | All graded cases |"));
  assert.ok(report.includes("| shared-context | Agent-reviewed harvested (not gated) |"));
  assert.ok(report.includes("No per-case decision conflicts"));

  const json = comparisonJson(view);
  assert.equal(json.mode, "live");
  assert.equal(json.corpus.digest, adventureCorpusDigest(cases));
  assert.equal(json.live?.attempts.length, 8);
  assert.equal(json.structural.paired, 2);
});

test("offline comparison never sends a network call and reports structural status", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("offline comparison must not fetch");
  }) as unknown as typeof fetch;
  try {
    const cases = [
      evalCase({ id: "one", candidates: [candidate("a", "Travel to the mill")] }),
      evalCase({ id: "two", candidates: [candidate("b", "Travel to the harbor")], expected: { preferred: "b", acceptable: ["b"] } }),
    ];
    const result = compareAdventurePayloadsOffline({
      cases,
      harvest: emptyHarvestReport(),
      generatedAt: "2026-09-22T00:00:00.000Z",
      top: 1,
      out: "docs/x.md",
      jsonPath: "docs/x.json",
    });
    assert.equal(calls, 0, "offline mode must not call fetch");
    assert.equal(result.view.mode, "offline");
    assert.equal(result.json.cases.length, 2);
    assert.equal(result.json.structural.paired, 2);
    assert.equal(result.json.payloadBytes.cases, 2);
    assert.ok(result.markdown.includes("provider-free (offline; no network calls)"));
    assert.ok(result.markdown.includes("## Structural pairing"));
    assert.ok(result.markdown.includes("## Payload bytes"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the frozen corpus and the harvested fixture pair cleanly offline", async () => {
  const harvest = await loadHarvestedAdventureCases();
  const cases = [...ADVENTURE_EVAL_CASES, ...harvest.cases];
  assert.equal(cases.length, ADVENTURE_EVAL_CASES.length + harvest.cases.length);

  const { rows, structural, corpusDigest } = buildPayloadComparisons(cases);
  assert.equal(rows.length, cases.length, "every case gets a byte row");
  assert.equal(structural.length, cases.length, "every case gets a structural result");
  assert.deepEqual(
    structural.filter((result) => !result.ok).map((result) => `${result.caseId}: ${result.mismatches.join("; ")}`),
    [],
    "both variants must expose the same candidate identities and count",
  );
  assert.equal(corpusDigest, adventureCorpusDigest(cases));

  const summary = summarizePayloadBytes(rows);
  assert.equal(summary.cases, cases.length);
  assert.equal(summary.incomplete, 0);
  assert.equal(summary.shrink + summary.grow + summary.equal, cases.length);

  const ids = new Set(cases.map((entry) => entry.id));
  assert.equal(ids.size, cases.length, "corpus identities are unique");
  const sharedBytes = rows.reduce((total, row) => total + (row.sharedBytes ?? 0), 0);
  assert.ok(sharedBytes < summary.legacyBytes, "across the full corpus the shared payload is smaller in bytes");
});
