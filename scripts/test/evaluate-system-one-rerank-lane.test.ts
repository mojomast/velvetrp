import assert from "node:assert/strict";
import test from "node:test";
import type { CampaignRecallHit } from "../../server/src/repo/campaign/campaignRecallReadRepo.js";
import type { MemoryEvalCase } from "../../server/test/fixtures/memory-evals/corpus.js";
import {
  evaluateRerankBenchmark,
  proposePromotionRecord,
  summarizeRerankCases,
  toRerankCandidates,
  toRerankSample,
  type RerankCasePlan,
  type RerankCaseSample,
} from "../evaluate-system-one-rerank-lane.js";

const recallHit = (sourceId: string, digest: string, text = "recalled text"): CampaignRecallHit => ({
  sourceKind: "declaration",
  authority: "intent",
  sourceId,
  digest,
  sessionId: "session",
  timelineId: "timeline",
  rootTurnId: "turn",
  actorId: "actor",
  text,
});

test("projects recall hits onto source-key candidates and dedupes repeated sources", () => {
  const { candidates, keys } = toRerankCandidates(
    { "promise:lantern": "id-1", "outcome:lantern": "id-2" },
    [recallHit("id-1", "d1"), recallHit("id-2", "d2"), recallHit("id-1", "d1"), recallHit("id-9", "d9")],
  );
  assert.deepEqual(keys, ["promise:lantern", "outcome:lantern", "unknown:d9"]);
  assert.deepEqual(candidates.map((candidate) => candidate.rank), [0, 1, 2]);
  assert.equal(candidates[0]?.candidateId, "promise:lantern");
  assert.equal(candidates[2]?.candidateId, "unknown:d9");
});

const memoryCase = (id: string): MemoryEvalCase => ({
  id,
  category: "promise",
  query: "What did I promise about the lantern?",
  actor: "aster",
  requiredSourceKeys: ["promise:lantern"],
  forbiddenSourceKeys: [],
  supportedFacts: ["The declaration is an intent."],
  forbiddenInferences: ["The lantern was restored."],
  baseline: "supported",
});

const plan = (overrides: Partial<RerankCasePlan> = {}): RerankCasePlan => ({
  memoryCase: memoryCase("case"),
  holdout: false,
  candidates: ["a", "b", "c", "d"].map((candidateId, rank) => ({ candidateId, label: "declaration", text: candidateId, rank })),
  baselineKeys: ["a", "b", "c", "d"],
  expected: ["a"],
  forbidden: [],
  supported: true,
  bytes: 100,
  hydrated: true,
  ...overrides,
});

test("grades the fused order against the case labels and the deterministic baseline", () => {
  const kept = toRerankSample(plan(), ["b", "a", "c", "d"], 0.9, "act", 1, 4);
  assert.equal(kept.answerable, true);
  assert.equal(kept.surfacedBefore, 1);
  assert.equal(kept.surfacedAfter, 1);
  assert.equal(kept.bestRankBefore, 0);
  assert.equal(kept.bestRankAfter, 1);
  assert.equal(kept.baselineCorrect, true);
  assert.equal(kept.correct, true);
  assert.equal(kept.band, "act");
  assert.equal(kept.decisive, true);

  const demoted = toRerankSample(plan(), ["b", "c", "d", "a"], 0.9, "act", 1, 4);
  assert.equal(demoted.surfacedAfter, 0);
  assert.equal(demoted.correct, false);
  assert.equal(demoted.baselineCorrect, true);

  const unretrieved = toRerankSample(plan({ baselineKeys: ["b", "c", "d"], candidates: plan().candidates.slice(1) }), ["b", "c", "d"], 0.9, "act", 1, 4);
  assert.equal(unretrieved.answerable, false);
  assert.equal(unretrieved.correct, false);
  assert.equal(unretrieved.baselineCorrect, false);
  assert.equal(unretrieved.decisive, true);

  const leak = toRerankSample(plan({ forbidden: ["d"] }), ["a", "b", "c", "d"], 0.9, "act", 1, 4);
  assert.equal(leak.privacyPass, false);
  assert.equal(leak.correct, false);
});

const sample = (overrides: Partial<RerankCaseSample> = {}): RerankCaseSample => ({
  id: "case",
  category: "promise",
  holdout: false,
  repeat: 1,
  candidateCount: 4,
  baseline: ["a", "b", "c", "d"],
  fused: ["a", "b", "c", "d"],
  expected: ["a"],
  forbidden: [],
  availableExpected: ["a"],
  answerable: true,
  supported: true,
  bytes: 100,
  hydrated: true,
  surfacedBefore: 1,
  surfacedAfter: 1,
  bestRankBefore: 0,
  bestRankAfter: 0,
  privacyPass: true,
  baselineCorrect: true,
  correct: true,
  topSignal: 0.9,
  band: "act",
  decisive: true,
  latencyMs: 10,
  ...overrides,
});

test("fits the Platt map on development and promotes only when the calibrated gate passes", () => {
  const dev = Array.from({ length: 30 }, (_, index) => sample({ id: `d${index}`, holdout: false }));
  const holdout = Array.from({ length: 10 }, (_, index) => sample({ id: `h${index}`, holdout: true }));
  const evaluation = evaluateRerankBenchmark([...dev, ...holdout]);

  assert.equal(evaluation.calls, 40);
  assert.equal(evaluation.eligibleCalls, 40);
  assert.equal(evaluation.decisiveCalls, 40);
  assert.equal(evaluation.devSamples, 30);
  assert.equal(evaluation.holdoutSamples, 10);
  assert.equal(evaluation.accuracy, 1);
  assert.equal(evaluation.gate.promoted, true);
  assert.deepEqual(evaluation.gate.reasons, []);
  assert.ok(evaluation.all.calibrated.brier <= 0.01);
  assert.ok(evaluation.all.calibrated.expectedCalibrationError <= 0.01);
  assert.equal(evaluation.improvedCalls, 0);
  assert.equal(evaluation.demotedCalls, 0);

  const record = proposePromotionRecord(evaluation, "2026-09-17", "docs/system-one-rerank-benchmark.md");
  assert.ok(record);
  assert.equal(record.metrics.samples, 40);
  assert.equal(record.metrics.accuracy, 1);
  assert.equal(record.promotedAt, "2026-09-17");
  assert.equal(record.evidence, "docs/system-one-rerank-benchmark.md");
  assert.ok(Number.isFinite(record.calibration?.a) && Number.isFinite(record.calibration?.b));
});

test("scores deterministic and fused arms with the Plan 3 scorer and counts rank movement", () => {
  const improved = sample({
    id: "i",
    candidateCount: 5,
    baseline: ["b", "c", "d", "e", "a"],
    fused: ["a", "b", "c", "d", "e"],
    bestRankBefore: 4,
    bestRankAfter: 0,
    surfacedBefore: 0,
    surfacedAfter: 1,
    baselineCorrect: false,
  });
  const demoted = sample({
    id: "d",
    candidateCount: 5,
    baseline: ["a", "b", "c", "d", "e"],
    fused: ["b", "a", "c", "d", "e"],
    bestRankBefore: 0,
    bestRankAfter: 1,
    surfacedBefore: 1,
    surfacedAfter: 1,
  });
  const evaluation = evaluateRerankBenchmark([improved, demoted]);

  assert.equal(evaluation.improvedCalls, 1);
  assert.equal(evaluation.demotedCalls, 1);
  assert.equal(evaluation.baseline.recallAtK, 1 / 2);
  assert.equal(evaluation.fused.recallAtK, 1);
  assert.ok(evaluation.fused.mrr > evaluation.baseline.mrr);
  assert.equal(evaluation.baselinePassRate, 0.5);
  assert.equal(evaluation.fusedPassRate, 1);
  assert.equal(evaluation.top1BeforeRate, 0.5);
  assert.equal(evaluation.top1AfterRate, 0.5);
});

test("reports NOT READY and proposes no record when the sample gate is short", () => {
  const short = Array.from({ length: 5 }, (_, index) => sample({ id: `s${index}`, holdout: index % 2 === 0 }));
  const evaluation = evaluateRerankBenchmark(short);
  assert.equal(evaluation.gate.promoted, false);
  assert.ok(evaluation.gate.reasons.some((reason) => reason.includes("insufficient samples")));
  assert.equal(proposePromotionRecord(evaluation, "2026-09-17"), null);
});

test("treats unanswerable and deferring calls as coverage, not gate samples", () => {
  const unanswerable = sample({ id: "u", answerable: false, availableExpected: [], baselineCorrect: false, correct: false });
  const deferred = sample({ id: "f", band: "confirm", decisive: false });
  const failedDeferred = sample({ id: "fd", correct: false, baselineCorrect: false, surfacedAfter: 0, band: "confirm", decisive: false });
  const failedActed = sample({ id: "fa", correct: false, baselineCorrect: false, surfacedAfter: 0 });
  const evaluation = evaluateRerankBenchmark([unanswerable, deferred, failedDeferred, failedActed]);
  assert.equal(evaluation.calls, 4);
  assert.equal(evaluation.eligibleCalls, 3);
  assert.equal(evaluation.decisiveCalls, 1);
  assert.equal(evaluation.misassertedCalls, 1);
  assert.equal(evaluation.eligibleFailures, 2);
  assert.equal(evaluation.deferredFailures, 1);
  assert.equal(evaluation.actedFailures, 1);
  assert.equal(evaluation.accuracy, 0);
  assert.equal(evaluation.gate.promoted, false);
});

test("rolls up per-case counts, bands, and signals", () => {
  const samples = [
    sample({ id: "g1", repeat: 1, correct: true, decisive: true, band: "act", topSignal: 1 }),
    sample({ id: "g1", repeat: 2, correct: false, decisive: true, band: "act", topSignal: 0.8, surfacedAfter: 0, bestRankAfter: 2 }),
    sample({ id: "c1", category: "no-match", answerable: false, availableExpected: [], decisive: false, band: "fallback", topSignal: null, correct: false, baselineCorrect: false, bestRankBefore: null, bestRankAfter: null }),
  ];
  const summaries = summarizeRerankCases(samples, [{ id: "c1" }]);
  const g1 = summaries.find((entry) => entry.id === "g1")!;
  assert.equal(g1.calls, 2);
  assert.equal(g1.decisive, 2);
  assert.equal(g1.correct, 1);
  assert.equal(g1.bands.act, 2);
  assert.equal(g1.surfacedAfter, 1);
  assert.equal(g1.bestRankBefore, 0);
  assert.equal(g1.bestRankAfter, 1);
  assert.ok(Math.abs(g1.meanSignal - 0.9) < 1e-9);

  const c1 = summaries.find((entry) => entry.id === "c1")!;
  assert.equal(c1.category, "no-match");
  assert.equal(c1.decisive, 0);
  assert.equal(c1.failed, 1);
  assert.equal(c1.bestRankBefore, null);
  assert.equal(c1.bestRankAfter, null);
  // Corpus order is preserved even when samples arrive out of order.
  assert.deepEqual(summaries.map((entry) => entry.id), ["g1", "c1"]);
});
