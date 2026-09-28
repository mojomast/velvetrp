import assert from "node:assert/strict";
import test from "node:test";
import { systemOneEvaluationBinding } from "../../server/src/agent/systemOneBinding.js";
import {
  FREEFORM_CANDIDATE_KEY,
  FREEFORM_LEGAL_KEY,
  FREEFORM_MATERIALIZATION_ACTION_FAMILY,
  FREEFORM_MATERIALIZATION_NONE,
  FREEFORM_NEEDS_CONTENT_KEY,
  composeFreeformMaterializationDecision,
  type FreeformMaterializationCandidate,
  type FreeformMaterializationDecision,
} from "../../server/src/agent/systemOneFreeformMaterialization.js";
import { defaultSystemOneSettings } from "../../server/src/defaults.js";
import type { SystemOneAnswer } from "../../server/src/provider/systemOneCompletion.js";
import {
  FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS,
  FREEFORM_MATERIALIZATION_CORPUS_DIGEST,
  FREEFORM_MATERIALIZATION_DEV_DIGEST,
  FREEFORM_MATERIALIZATION_HOLDOUT_DIGEST,
  FREEFORM_MATERIALIZATION_REVIEW_THRESHOLD,
  FREEFORM_MATERIALIZATION_THRESHOLD_GRID,
  evaluateFreeformBenchmark,
  evaluateFreeformDevSelection,
  gradeFreeformDecision,
  proposePromotionRecord,
  proposeSelectionPromotionRecord,
  sampleAtThreshold,
  summarizeFreeformCases,
  toFreeformSample,
  type FreeformBenchmarkSample,
  type FreeformRawObservation,
} from "../evaluate-system-one-freeform-materialization-lane.js";

const LANE = "freeform-materialization" as const;
const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };

test("the frozen corpus is broad, labelled, and digest-pinned", () => {
  const corpus = FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS;
  assert.ok(corpus.length >= 40, `expected at least 40 cases, got ${corpus.length}`);
  assert.equal(new Set(corpus.map((entry) => entry.id)).size, corpus.length, "case ids must be unique");
  assert.ok(corpus.some((entry) => entry.holdout), "a holdout split is required");
  assert.ok(corpus.some((entry) => !entry.holdout), "a development split is required");
  const categories = new Set(corpus.map((entry) => entry.category));
  for (const category of ["materialize-location", "materialize-npc", "hostile-encounter", "shop-stock", "new-clue", "hold", "illegal", "duplicate"]) {
    assert.ok(categories.has(category as never), `missing corpus category ${category}`);
  }
  assert.ok(corpus.some((entry) => entry.expected.band === "act"), "positive cases are required");
  assert.ok(corpus.some((entry) => entry.expected.band === "fallback"), "hard negative cases are required");
  // Every positive names a candidate that is actually advertised in its own state.
  for (const entry of corpus) {
    if (entry.expected.band !== "act") continue;
    assert.ok(entry.candidates.some((candidate) => candidate.candidateId === entry.expected.candidateId),
      `${entry.id} does not advertise its expected candidate`);
    assert.ok(entry.candidates.length >= 2, `${entry.id} should carry a distractor candidate`);
  }
  // The corpus and both splits are frozen: any drift changes the digest.
  assert.equal(FREEFORM_MATERIALIZATION_CORPUS_DIGEST, "a323ce6a1da8e41812341cd70a295c848fecded252531ed033019939d77dfa4c");
  assert.equal(FREEFORM_MATERIALIZATION_DEV_DIGEST, "c44e0023ecf4b13ea3a90fd27f95e5b2f048b4411993021946d271897d7b523f");
  assert.equal(FREEFORM_MATERIALIZATION_HOLDOUT_DIGEST, "0e2fb2a89393ba6df9f83ecaae7c5c51b91cfb50a583408f9bf28a2d0aeed8a3");
  // The grid is fixed and ascending.
  assert.deepEqual([...FREEFORM_MATERIALIZATION_THRESHOLD_GRID], [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75]);
});

const answers = (options: {
  choice: string;
  choiceProbability?: number;
  needsContent?: number;
  legal?: number;
}): Record<string, SystemOneAnswer> => {
  const probability = options.choiceProbability ?? 0.95;
  return {
    [FREEFORM_NEEDS_CONTENT_KEY]: { type: "noul", noul: options.needsContent ?? 0.95 },
    [FREEFORM_LEGAL_KEY]: { type: "noul", noul: options.legal ?? 0.95 },
    [FREEFORM_CANDIDATE_KEY]: {
      type: "choice",
      choice: options.choice,
      confidence: probability,
      probabilities: { [options.choice]: probability, [FREEFORM_MATERIALIZATION_NONE]: 1 - probability },
    },
  };
};

const compose = (entry: (typeof FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS)[number], scripted: Record<string, SystemOneAnswer>): FreeformMaterializationDecision =>
  composeFreeformMaterializationDecision(
    { campaignId: "c", sessionId: "s", attempt: entry.attempt, candidates: entry.candidates },
    scripted,
    thresholds,
  );

test("grades an act label on the exact candidate and a fallback label on a hold", () => {
  const positive = FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.find((entry) => entry.id === "loc-1")!;
  const composed = compose(positive, answers({ choice: positive.expected.candidateId! }));
  assert.equal(composed.band, "act");
  assert.equal(gradeFreeformDecision(composed, positive.expected), true);

  const negative = FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.find((entry) => entry.id === "hold-1")!;
  const held = compose(negative, answers({ choice: negative.candidates[0]!.candidateId, needsContent: 0.1 }));
  assert.equal(held.band, "fallback");
  assert.equal(gradeFreeformDecision(held, negative.expected), true);
  // Acting on a must-hold case is an acted error.
  const falseAct = compose(negative, answers({ choice: negative.candidates[0]!.candidateId }));
  assert.equal(falseAct.band, "act");
  assert.equal(gradeFreeformDecision(falseAct, negative.expected), false);
});

test("fails closed on an out-of-set or none choice when scoring a corpus case", () => {
  const positive = FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.find((entry) => entry.id === "npc-1")!;
  const outOfSet = compose(positive, answers({ choice: "ffn-invented", choiceProbability: 0.99 }));
  assert.equal(outOfSet.band, "fallback");
  assert.equal(gradeFreeformDecision(outOfSet, positive.expected), false);
  const none = compose(positive, answers({ choice: FREEFORM_MATERIALIZATION_NONE, choiceProbability: 0.99 }));
  assert.equal(none.band, "fallback");
  assert.equal(gradeFreeformDecision(none, positive.expected), false);
});

test("projects a corpus case and its composition into a graded sample", () => {
  const positive = FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.find((entry) => entry.id === "enc-1")!;
  const sample = toFreeformSample(positive, compose(positive, answers({ choice: positive.expected.candidateId! })));
  assert.equal(sample.caseId, "enc-1");
  assert.equal(sample.category, "hostile-encounter");
  assert.equal(sample.acted, true);
  assert.equal(sample.expectedAct, true);
  assert.equal(sample.correct, true);
  assert.ok(sample.topSignal !== null && sample.topSignal >= 0.75);
});

const sample = (overrides: Partial<FreeformBenchmarkSample> = {}): FreeformBenchmarkSample => ({
  caseId: "x",
  category: "materialize-location",
  holdout: false,
  band: "act",
  candidateId: "ffc-x",
  kind: "materialize-location",
  expectedCandidateId: "ffc-x",
  topSignal: 0.9,
  expectedAct: true,
  acted: true,
  correct: true,
  ...overrides,
});

test("fits the Platt map on development acts and promotes only when the calibrated gate passes", () => {
  const dev = Array.from({ length: 30 }, (_, index) => sample({ caseId: `d${index}`, holdout: false }));
  const holdout = Array.from({ length: 10 }, (_, index) => sample({ caseId: `h${index}`, holdout: true }));
  const evaluation = evaluateFreeformBenchmark([...dev, ...holdout]);

  assert.equal(evaluation.totalSamples, 40);
  assert.equal(evaluation.actedSamples, 40);
  assert.equal(evaluation.devSamples, 30);
  assert.equal(evaluation.holdoutSamples, 10);
  assert.equal(evaluation.accuracy, 1);
  assert.equal(evaluation.gate.promoted, true);
  assert.deepEqual(evaluation.gate.reasons, []);
  assert.ok(evaluation.all.calibrated.brier <= 0.01);
  assert.ok(evaluation.all.calibrated.expectedCalibrationError <= 0.01);

  const record = proposePromotionRecord(evaluation, defaultSystemOneSettings(), "jev-1.13.0", "2026-09-28");
  assert.ok(record);
  assert.equal(record.metrics.samples, 40);
  assert.equal(record.metrics.accuracy, 1);
  assert.equal(record.promotedAt, "2026-09-28");
  assert.ok(record.calibration && Number.isFinite(record.calibration.a) && Number.isFinite(record.calibration.b));
  // The record binds the exact runtime evaluation binding with the fitted calibration shipped.
  const settings = defaultSystemOneSettings();
  const calibratedSettings = {
    ...settings,
    confidenceCalibration: { ...settings.confidenceCalibration, [LANE]: record.calibration! },
  };
  assert.deepEqual(record.evaluatedBindings, [
    systemOneEvaluationBinding(LANE, calibratedSettings, "jev-1.13.0", FREEFORM_MATERIALIZATION_ACTION_FAMILY),
  ]);

  // No real response model can never satisfy the binding, so no record is proposed.
  assert.equal(proposePromotionRecord(evaluation, defaultSystemOneSettings(), null, "2026-09-28"), null);
});

test("counts a false act as an acted error and a deferral as coverage", () => {
  const acted = Array.from({ length: 31 }, (_, index) => sample({ caseId: `a${index}` }));
  acted[30] = sample({ caseId: "false-act", expectedAct: false, category: "hold", candidateId: "ffc-x", correct: false });
  const deferred = sample({ caseId: "deferred", expectedAct: true, acted: false, band: "fallback", candidateId: null, kind: null, correct: false });
  const evaluation = evaluateFreeformBenchmark([...acted, deferred]);

  assert.equal(evaluation.totalSamples, 32);
  assert.equal(evaluation.actedSamples, 31);
  assert.equal(evaluation.falseActs, 1);
  assert.equal(evaluation.deferredPositive, 1);
  assert.equal(evaluation.actedErrors, 1);
  assert.ok(Math.abs(evaluation.accuracy - 30 / 31) < 1e-9);
});

test("reports NOT READY and proposes no record when the sample gate is short", () => {
  const short = Array.from({ length: 5 }, (_, index) => sample({ caseId: `s${index}`, holdout: index % 2 === 0 }));
  const evaluation = evaluateFreeformBenchmark(short);
  assert.equal(evaluation.gate.promoted, false);
  assert.ok(evaluation.gate.reasons.some((reason) => reason.includes("insufficient samples")));
  assert.equal(proposePromotionRecord(evaluation, defaultSystemOneSettings(), "jev-1.13.0", "2026-09-28"), null);
});

test("rolls up per-case counts, bands, and signals in corpus order", () => {
  const samples = [
    sample({ caseId: "loc-1", acted: true, correct: true, band: "act", topSignal: 1 }),
    sample({ caseId: "loc-1", acted: true, correct: false, band: "act", topSignal: 0.8 }),
    sample({ caseId: "hold-1", category: "hold", expectedAct: false, acted: false, correct: true, band: "fallback", candidateId: null, kind: null, topSignal: 0.2 }),
  ];
  const summaries = summarizeFreeformCases(samples);
  const loc1 = summaries.find((entry) => entry.id === "loc-1")!;
  assert.equal(loc1.calls, 2);
  assert.equal(loc1.acted, 2);
  assert.equal(loc1.correct, 1);
  assert.equal(loc1.bands.act, 2);
  assert.ok(Math.abs(loc1.meanSignal - 0.9) < 1e-9);

  const hold1 = summaries.find((entry) => entry.id === "hold-1")!;
  assert.equal(hold1.category, "hold");
  assert.equal(hold1.deferred, 1);
  assert.equal(hold1.bands.fallback, 1);
  assert.deepEqual(summaries.map((entry) => entry.id), ["loc-1", "hold-1"]);
});

test("carries no unbounded fields: a selected decision exposes only populated routing fields", () => {
  const positive = FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.find((entry) => entry.id === "clue-1")!;
  const composed = compose(positive, answers({ choice: positive.expected.candidateId! }));
  const candidate: FreeformMaterializationCandidate | undefined =
    positive.candidates.find((entry) => entry.candidateId === composed.candidateId);
  assert.ok(candidate);
  assert.equal(composed.kind, "new-clue");
  assert.deepEqual(Object.keys(composed).sort(), ["band", "candidateId", "kind", "legal", "needsContent", "reason", "signals", "topSignal"]);
});

/** Builds retained observations with a per-case signal and repeat count, for selection tests. */
function observationSet(
  signalFor: (entry: (typeof FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS)[number]) => number,
  repeats: number,
  omit: ReadonlySet<string> = new Set(),
): FreeformRawObservation[] {
  const out: FreeformRawObservation[] = [];
  for (const entry of FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS) {
    if (omit.has(entry.id)) continue;
    const signal = signalFor(entry);
    const choice = entry.expected.candidateId ?? entry.candidates[0]!.candidateId;
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      out.push({ caseId: entry.id, repeat, answers: answers({ choice, choiceProbability: signal, needsContent: signal, legal: signal }), latencyMs: 1 });
    }
  }
  return out;
}

test("selects on development and promotes only when the frozen holdout gate passes", () => {
  const observations = observationSet((entry) => (entry.expected.band === "act" ? 0.9 : 0.1), 5);
  const selection = evaluateFreeformDevSelection(observations);
  assert.equal(selection.devGateQualified, true);
  assert.equal(selection.selectedBy, "dev-gate");
  assert.ok(selection.selected);
  // Every threshold acts identically here; the lowest wins coverage.
  assert.equal(selection.selected!.threshold, 0.3);
  assert.ok(selection.selected!.holdout.gate.promoted);
  assert.equal(selection.selected!.holdout.accuracy, 1);
  assert.ok(selection.selected!.holdout.distinctActed >= 10);

  const record = proposeSelectionPromotionRecord(selection, defaultSystemOneSettings(), "jev-1.13.0", "2026-09-28");
  assert.ok(record);
  assert.equal(record.evidence, "docs/system-one-freeform-materialization-benchmark.md");
  assert.equal(record.metrics.accuracy, 1);
  const settings = defaultSystemOneSettings();
  const expectedSettings = {
    ...settings,
    confidenceCalibration: { ...settings.confidenceCalibration, [LANE]: record.calibration! },
    confidencePolicy: { ...settings.confidencePolicy, [LANE]: { actionThreshold: 0.3, reviewThreshold: Math.min(FREEFORM_MATERIALIZATION_REVIEW_THRESHOLD, 0.3) } },
  };
  assert.deepEqual(record.evaluatedBindings, [
    systemOneEvaluationBinding(LANE, expectedSettings, "jev-1.13.0", FREEFORM_MATERIALIZATION_ACTION_FAMILY),
  ]);
  // A missing response model can never satisfy the binding.
  assert.equal(proposeSelectionPromotionRecord(selection, settings, null, "2026-09-28"), null);
});

test("does not promote when the frozen holdout fails even though development passes", () => {
  // Development negatives stay low, so development passes; holdout negatives are high, so they act.
  const observations = observationSet((entry) => {
    if (entry.expected.band === "act") return 0.9;
    return entry.holdout ? 0.9 : 0.1;
  }, 5);
  const selection = evaluateFreeformDevSelection(observations);
  assert.equal(selection.devGateQualified, true);
  assert.ok(selection.selected);
  assert.equal(selection.selected!.holdout.gate.promoted, false);
  assert.ok(selection.selected!.holdout.accuracy < 0.9);
  assert.equal(proposeSelectionPromotionRecord(selection, defaultSystemOneSettings(), "jev-1.13.0", "2026-09-28"), null);
});

test("never promotes a descriptive selection that no development threshold qualified", () => {
  // Few development positives act, so every development gate fails the sample floor.
  const omit = new Set(FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS
    .filter((entry) => !entry.holdout && entry.expected.band === "act")
    .slice(2)
    .map((entry) => entry.id));
  const observations = observationSet((entry) => (entry.expected.band === "act" ? 0.9 : 0.1), 5, omit);
  const selection = evaluateFreeformDevSelection(observations);
  assert.equal(selection.devGateQualified, false);
  assert.equal(selection.selectedBy, "dev-best");
  assert.ok(selection.reasons.some((reason) => reason.includes("no development threshold passed")));
  assert.equal(proposeSelectionPromotionRecord(selection, defaultSystemOneSettings(), "jev-1.13.0", "2026-09-28"), null);
});

test("recomposes a retained answer at a lower threshold without changing composition semantics", () => {
  const entry = FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.find((candidate) => candidate.id === "loc-1")!;
  const raw = answers({ choice: entry.expected.candidateId!, choiceProbability: 0.6, needsContent: 0.6, legal: 0.6 });
  const shipped = sampleAtThreshold(entry, raw, 0.75);
  assert.equal(shipped.acted, false);
  const swept = sampleAtThreshold(entry, raw, 0.5);
  assert.equal(swept.acted, true);
  assert.equal(swept.correct, true);
  assert.equal(swept.topSignal, 0.6);
});
