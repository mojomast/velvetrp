import assert from "node:assert/strict";
import test from "node:test";
import {
  composeNarrationVerification,
  narrationContradictionKey,
  narrationReflectionKey,
  NARRATION_CONTRADICTS_RECEIPT_KEY,
  NARRATION_CROSSES_BOUNDARY_KEY,
  NARRATION_INVENTS_MECHANIC_KEY,
} from "../../server/src/agent/systemOneNarration.js";
import type { SystemOneAnswer } from "../../server/src/provider/systemOneCompletion.js";
import {
  NARRATION_BENCHMARK_CORPUS,
  evaluateNarrationBenchmark,
  gradeNarrationVerdict,
  proposePromotionRecord,
  summarizeNarrationCases,
  toNarrationSample,
  type NarrationBenchmarkSample,
} from "../evaluate-system-one-narration-lane.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };
const hazard = (noul: number): SystemOneAnswer => ({ type: "noul", noul });

const groundedAnswers = (factCount: number): Record<string, SystemOneAnswer> => {
  const answers: Record<string, SystemOneAnswer> = {
    [NARRATION_INVENTS_MECHANIC_KEY]: hazard(0.05),
    [NARRATION_CROSSES_BOUNDARY_KEY]: hazard(0.05),
  };
  for (let index = 0; index < factCount; index += 1) {
    answers[narrationReflectionKey(index)] = hazard(0.9);
    answers[narrationContradictionKey(index)] = hazard(0.05);
  }
  return answers;
};

const sample = (overrides: Partial<NarrationBenchmarkSample>): NarrationBenchmarkSample => ({
  caseId: "x",
  category: "grounded",
  holdout: false,
  band: "act",
  flags: [],
  groundedness: 1,
  topSignal: 0.9,
  decisive: true,
  accepted: true,
  correct: true,
  ...overrides,
});

test("corpus covers at least eight cases across at least three categories with unique ids", () => {
  assert.ok(NARRATION_BENCHMARK_CORPUS.length >= 8);
  assert.ok(new Set(NARRATION_BENCHMARK_CORPUS.map((entry) => entry.id)).size === NARRATION_BENCHMARK_CORPUS.length);
  assert.ok(new Set(NARRATION_BENCHMARK_CORPUS.map((entry) => entry.category)).size >= 3);
  assert.ok(NARRATION_BENCHMARK_CORPUS.some((entry) => entry.holdout));
  assert.ok(NARRATION_BENCHMARK_CORPUS.some((entry) => !entry.holdout));
});

test("grades a composed verdict against its labelled expectation", () => {
  const groundedCase = NARRATION_BENCHMARK_CORPUS.find((entry) => entry.id === "g1")!;
  const composed = composeNarrationVerification(groundedAnswers(groundedCase.committedFacts.length), thresholds, { factCount: groundedCase.committedFacts.length });
  assert.equal(gradeNarrationVerdict(composed, groundedCase.expected), true);

  const contradictionCase = NARRATION_BENCHMARK_CORPUS.find((entry) => entry.id === "c1")!;
  // A clean verdict must not pass a hazard label, and a flagged verdict must not pass a clean label.
  assert.equal(gradeNarrationVerdict(composed, contradictionCase.expected), false);
  const flagged = composeNarrationVerification({ [narrationContradictionKey(0)]: hazard(0.95) }, thresholds, { factCount: 1 });
  assert.equal(gradeNarrationVerdict(flagged, contradictionCase.expected), true);
  assert.equal(gradeNarrationVerdict(flagged, groundedCase.expected), false);
});

test("grades the partial-grounding label on computed coverage", () => {
  const partialCase = NARRATION_BENCHMARK_CORPUS.find((entry) => entry.id === "p1")!;
  const factCount = partialCase.committedFacts.length;
  const partly = composeNarrationVerification({
    [narrationReflectionKey(0)]: hazard(0.9),
    [narrationReflectionKey(1)]: hazard(0.1),
  }, thresholds, { factCount });
  assert.equal(partly.band, "confirm");
  assert.equal(partly.groundedness, 0.5);
  assert.equal(gradeNarrationVerdict(partly, partialCase.expected), true);
  const fully = composeNarrationVerification(groundedAnswers(factCount), thresholds, { factCount });
  assert.equal(gradeNarrationVerdict(fully, partialCase.expected), false);
});

test("projects a decisive sample only when the lane accepts or flags", () => {
  const benchmarkCase = NARRATION_BENCHMARK_CORPUS.find((entry) => entry.id === "g1")!;
  const factCount = benchmarkCase.committedFacts.length;
  const accepted = toNarrationSample(benchmarkCase, composeNarrationVerification(groundedAnswers(factCount), thresholds, { factCount }));
  assert.equal(accepted.decisive, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.correct, true);

  const flaggedCase = NARRATION_BENCHMARK_CORPUS.find((entry) => entry.id === "c1")!;
  const flagged = toNarrationSample(flaggedCase, composeNarrationVerification({ [narrationContradictionKey(0)]: hazard(0.95) }, thresholds, { factCount: 1 }));
  assert.equal(flagged.decisive, true);
  assert.equal(flagged.accepted, false);
  assert.equal(flagged.correct, true);

  const deferred = toNarrationSample(benchmarkCase, composeNarrationVerification({ [narrationReflectionKey(0)]: hazard(0.1) }, thresholds, { factCount }));
  assert.equal(deferred.decisive, false);
  assert.equal(deferred.correct, false);
});

test("fits the Platt map on development and promotes only when the calibrated gate passes", () => {
  const dev = Array.from({ length: 30 }, (_, index) =>
    sample({ caseId: `g${index}`, holdout: false, topSignal: 0.9, correct: true }));
  const holdout = Array.from({ length: 10 }, (_, index) =>
    sample({ caseId: `h${index}`, holdout: true, topSignal: 0.9, correct: true }));
  const evaluation = evaluateNarrationBenchmark([...dev, ...holdout]);

  assert.equal(evaluation.decisiveSamples, 40);
  assert.equal(evaluation.devSamples, 30);
  assert.equal(evaluation.holdoutSamples, 10);
  assert.equal(evaluation.accuracy, 1);
  assert.equal(evaluation.gate.promoted, true);
  assert.deepEqual(evaluation.gate.reasons, []);
  assert.ok(evaluation.all.calibrated.brier <= 0.01);
  assert.ok(evaluation.all.calibrated.expectedCalibrationError <= 0.01);

  const record = proposePromotionRecord(evaluation, "2026-09-17", "docs/system-one-narration-benchmark.md");
  assert.ok(record);
  assert.equal(record.metrics.samples, 40);
  assert.equal(record.metrics.accuracy, 1);
  assert.ok(record.metrics.brier <= 0.01);
  assert.ok(record.metrics.expectedCalibrationError <= 0.01);
  assert.equal(record.promotedAt, "2026-09-17");
  assert.equal(record.evidence, "docs/system-one-narration-benchmark.md");
  assert.ok(Number.isFinite(record.calibration?.a) && Number.isFinite(record.calibration?.b));
});

test("reports NOT READY and proposes no record when the sample gate is short", () => {
  const short = Array.from({ length: 5 }, (_, index) =>
    sample({ caseId: `s${index}`, holdout: index % 2 === 0, topSignal: 0.9, correct: true }));
  const evaluation = evaluateNarrationBenchmark(short);
  assert.equal(evaluation.gate.promoted, false);
  assert.ok(evaluation.gate.reasons.some((reason) => reason.includes("insufficient samples")));
  assert.equal(proposePromotionRecord(evaluation, "2026-09-17", "docs/system-one-narration-benchmark.md"), null);
});

test("rolls up per-case counts, bands, and signals", () => {
  const samples = [
    sample({ caseId: "g1", accepted: true, decisive: true, correct: true, band: "act", topSignal: 1 }),
    sample({ caseId: "g1", accepted: true, decisive: true, correct: false, band: "act", topSignal: 0.8 }),
    sample({ caseId: "c1", category: "contradiction", accepted: false, decisive: true, correct: true, band: "fallback", flags: [NARRATION_CONTRADICTS_RECEIPT_KEY], groundedness: null, topSignal: 0.95 }),
  ];
  const summaries = summarizeNarrationCases(samples);
  const g1 = summaries.find((entry) => entry.id === "g1")!;
  assert.equal(g1.total, 2);
  assert.equal(g1.decisive, 2);
  assert.equal(g1.correct, 1);
  assert.equal(g1.accepted, 2);
  assert.equal(g1.bands.act, 2);
  assert.ok(Math.abs(g1.meanSignal - 0.9) < 1e-9);

  const c1 = summaries.find((entry) => entry.id === "c1")!;
  assert.equal(c1.category, "contradiction");
  assert.equal(c1.meanGroundedness, null);
  assert.equal(c1.bands.fallback, 1);
  // Corpus order is preserved even when samples arrive out of order.
  assert.deepEqual(summaries.map((entry) => entry.id), ["g1", "c1"]);
});
