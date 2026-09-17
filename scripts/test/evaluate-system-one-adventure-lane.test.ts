import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ADVENTURE_BEST_KEY,
  ADVENTURE_NONE,
  ADVENTURE_SUPPORTED_KEY,
  type AdventureSelectionComposition,
} from "../../server/src/agent/systemOneAdventure.js";
import type { SystemOneAnswer } from "../../server/src/provider/systemOneCompletion.js";
import {
  ADVENTURE_EVAL_CASES,
  ADVENTURE_EVAL_CORPUS_VERSION,
  validateAdventureEvalCases,
  type AdventureEvalCase,
  type AdventureEvalCategory,
} from "../../server/test/fixtures/adventure-evals/corpus.js";
import {
  ADVENTURE_DEFAULT_ACTION_THRESHOLD,
  ADVENTURE_THRESHOLD_GRID,
  adventureStabilitySamples,
  adventureThresholdSamples,
  evaluateAdventureReadouts,
  gradeAdventureCase,
  loadHarvestedAdventureCases,
  mergeHarvestedAdventureCases,
  parseAdventureArgs,
  parseHarvestedAdventureCases,
  renderAdventureBenchmark,
  summarizeAdventureCases,
  summarizeAdventureStability,
  type AdventureReadout,
} from "../evaluate-system-one-adventure-lane.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };

/** A minimal valid case for validator and grading tests. */
const evalCase = (overrides: Partial<AdventureEvalCase> = {}): AdventureEvalCase => ({
  id: "case",
  category: "direct-match",
  holdout: false,
  declaration: "I walk to the mill.",
  candidates: [
    { candidateId: "a", digest: "a".repeat(64), kind: "exact_actor_travel.select", label: "Travel to the mill" },
  ],
  expected: { preferred: "a", acceptable: ["a"] },
  ...overrides,
});

const gradingCase = (
  expected: AdventureEvalCase["expected"],
  overrides: { id?: string; category?: AdventureEvalCategory; holdout?: boolean } = {},
): Pick<AdventureEvalCase, "id" | "category" | "holdout" | "expected" | "candidates"> => ({
  id: overrides.id ?? "case",
  category: overrides.category ?? "direct-match",
  holdout: overrides.holdout ?? false,
  expected,
  candidates: [
    { candidateId: "a", digest: "a".repeat(64), kind: "exact_actor_travel.select", label: "Travel to the mill" },
    { candidateId: "b", digest: "b".repeat(64), kind: "exact_srd_check.select", label: "Strength (Athletics), Easy difficulty, normal" },
  ],
});

const composition = (overrides: Partial<AdventureSelectionComposition> = {}): AdventureSelectionComposition => ({
  band: "act",
  method: "choice",
  selection: { candidateId: "a", digest: "a".repeat(64) },
  topSignal: 0.9,
  ...overrides,
});

const readout = (overrides: Partial<AdventureReadout> = {}): AdventureReadout => ({
  id: "case",
  category: "direct-match",
  holdout: false,
  band: "act",
  method: "choice",
  selected: "a",
  candidateId: "a",
  acceptable: ["a"],
  selectedCorrect: true,
  deferred: false,
  correct: true,
  topSignal: 0.9,
  reason: "test",
  ...overrides,
});

const noul = (value: number): SystemOneAnswer => ({ type: "noul", noul: value });
const rawChoice = (value: string, top: number): SystemOneAnswer => ({
  type: "choice",
  choice: value,
  confidence: top,
  probabilities: { [value]: top, [ADVENTURE_NONE]: Math.max(0, 1 - top) },
});

/** A synthetic confirmed-harvest proposal; the merge validates it defensively at runtime. */
const harvestProposal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  proposalId: "1".repeat(64),
  lane: "adventure-selection",
  sourceDecisionId: "decision-1",
  createdAt: "2026-09-17T00:00:00.000Z",
  provenance: "review-annotated",
  status: "confirmed",
  state: {
    declaration: "I walk to the mill.",
    candidates: [
      { candidateId: "harvest:travel", digest: "c".repeat(64), kind: "exact_actor_travel.select", label: "Travel to the mill" },
    ],
  },
  expected: { candidateId: "harvest:travel" },
  reason: "human review confirmed the recorded adventure-selection decision",
  ...overrides,
});

test("the frozen corpus covers every category and tool family with unique ids and digests", () => {
  assert.equal(ADVENTURE_EVAL_CORPUS_VERSION, "adventure-evals-v1");
  assert.doesNotThrow(() => validateAdventureEvalCases(ADVENTURE_EVAL_CASES));
  assert.ok(ADVENTURE_EVAL_CASES.length >= 24 && ADVENTURE_EVAL_CASES.length <= 32, "expected roughly 24-32 cases");

  const categories = new Set(ADVENTURE_EVAL_CASES.map((testCase) => testCase.category));
  for (const category of ["direct-match", "ambiguous", "multi-family", "unsupported", "unadvertised", "small-talk"] as const) {
    assert.ok(categories.has(category), `missing category ${category}`);
  }

  const ids = new Set(ADVENTURE_EVAL_CASES.map((testCase) => testCase.id));
  assert.equal(ids.size, ADVENTURE_EVAL_CASES.length, "case ids must be unique");
  const holdouts = ADVENTURE_EVAL_CASES.filter((testCase) => testCase.holdout);
  assert.ok(holdouts.length >= 6, "expected at least six holdout cases");
  assert.ok(holdouts.length < ADVENTURE_EVAL_CASES.length, "expected development cases too");

  const digests = new Set<string>();
  for (const testCase of ADVENTURE_EVAL_CASES) {
    assert.ok(testCase.declaration.trim().length > 0, `empty declaration ${testCase.id}`);
    assert.ok(testCase.expected.acceptable.length > 0, `empty acceptable set ${testCase.id}`);
    for (const entry of testCase.candidates) {
      assert.match(entry.digest, /^[0-9a-f]{64}$/, `bad digest in ${testCase.id}`);
      assert.ok(!digests.has(entry.digest), `duplicate digest in ${testCase.id}`);
      digests.add(entry.digest);
      assert.ok(entry.kind.trim().length > 0 && entry.label.trim().length > 0, `incomplete candidate in ${testCase.id}`);
    }
  }

  const kinds = new Set(ADVENTURE_EVAL_CASES.flatMap((testCase) => testCase.candidates.map((entry) => entry.kind)));
  for (const kind of [
    "exact_actor_travel.select",
    "exact_srd_check.select",
    "exact_inventory_action.select",
    "exact_vendor_commerce.select",
    "exact_power_use.select",
    "exact_rest.select",
    "exact_combat_consumable.select",
    "exact_combat_power.select",
    "exact_quest_lifecycle.select",
    "exact_progression_apply.select",
  ]) {
    assert.ok(kinds.has(kind), `missing tool family ${kind}`);
  }

  assert.ok(ADVENTURE_EVAL_CASES.some((testCase) => testCase.candidates.length === 0), "expected an empty candidate list case");
});

test("the corpus validator rejects malformed cases", () => {
  assert.throws(() => validateAdventureEvalCases([evalCase()]), /holdout/);
  assert.throws(() => validateAdventureEvalCases([evalCase({ id: "x" }), evalCase({ id: "x", holdout: true })]), /id/);
  assert.throws(() => validateAdventureEvalCases([evalCase({ declaration: "   " }), evalCase({ id: "h", holdout: true })]), /declaration/);
  assert.throws(
    () => validateAdventureEvalCases([
      evalCase({ candidates: [{ candidateId: "a", digest: "nope", kind: "kind", label: "label" }] }),
      evalCase({ id: "h", holdout: true }),
    ]),
    /digest/,
  );
  assert.throws(
    () => validateAdventureEvalCases([
      evalCase({ expected: { preferred: "missing", acceptable: ["missing"] } }),
      evalCase({ id: "h", holdout: true }),
    ]),
    /not advertised/,
  );
  assert.throws(
    () => validateAdventureEvalCases([
      evalCase({ expected: { preferred: null, acceptable: [] } }),
      evalCase({ id: "h", holdout: true }),
    ]),
    /acceptable/,
  );
  assert.throws(
    () => validateAdventureEvalCases([
      evalCase({ expected: { preferred: null, acceptable: ["a"] } }),
      evalCase({ id: "h", holdout: true }),
    ]),
    /null/,
  );
});

test("grades exhaustively: exact picks, acceptable alternatives, wrong picks, and deferrals", () => {
  const exact = gradeAdventureCase(gradingCase({ preferred: "a", acceptable: ["a"] }), composition());
  assert.deepEqual(
    { band: exact.band, selected: exact.selected, candidateId: exact.candidateId, selectedCorrect: exact.selectedCorrect, deferred: exact.deferred, correct: exact.correct },
    { band: "act", selected: "a", candidateId: "a", selectedCorrect: true, deferred: false, correct: true },
  );

  const alternative = gradeAdventureCase(
    gradingCase({ preferred: "a", acceptable: ["a", "b"] }),
    composition({ selection: { candidateId: "b", digest: "b".repeat(64) } }),
  );
  assert.equal(alternative.selected, "b");
  assert.equal(alternative.selectedCorrect, false);
  assert.equal(alternative.correct, true, "an acceptable alternative is a correct decision");

  const wrong = gradeAdventureCase(
    gradingCase({ preferred: "a", acceptable: ["a"] }),
    composition({ selection: { candidateId: "b", digest: "b".repeat(64) } }),
  );
  assert.equal(wrong.selected, "b");
  assert.equal(wrong.selectedCorrect, false);
  assert.equal(wrong.correct, false, "a wrong advertised pick is an incorrect decision");

  const deferred = gradeAdventureCase(
    gradingCase({ preferred: null, acceptable: [null] }),
    composition({ band: "fallback", method: "defer", selection: null, topSignal: 0.2 }),
  );
  assert.deepEqual(
    { selected: deferred.selected, candidateId: deferred.candidateId, selectedCorrect: deferred.selectedCorrect, deferred: deferred.deferred, correct: deferred.correct },
    { selected: null, candidateId: null, selectedCorrect: true, deferred: true, correct: true },
  );

  const pickedWhenDeferring = gradeAdventureCase(gradingCase({ preferred: null, acceptable: [null] }), composition());
  assert.equal(pickedWhenDeferring.deferred, false);
  assert.equal(pickedWhenDeferring.correct, false, "picking when deferral is the only acceptable outcome is incorrect");

  const confirmed = gradeAdventureCase(
    gradingCase({ preferred: null, acceptable: [null] }),
    composition({ band: "confirm", method: "choice", selection: { candidateId: "a", digest: "a".repeat(64) }, topSignal: 0.6 }),
  );
  assert.equal(confirmed.deferred, true, "confirm is a deferral");
  assert.equal(confirmed.selected, null, "confirm commits nothing");
  assert.equal(confirmed.candidateId, "a", "confirm still records the named pick for the sweep");
  assert.equal(confirmed.selectedCorrect, true);
  assert.equal(confirmed.correct, true);

  const confirmedOnCommitCase = gradeAdventureCase(
    gradingCase({ preferred: "a", acceptable: ["a"] }),
    composition({ band: "confirm", method: "choice", topSignal: 0.6 }),
  );
  assert.equal(confirmedOnCommitCase.deferred, true);
  assert.equal(confirmedOnCommitCase.correct, false, "a confirm does not satisfy a case that requires a commit");
});

test("records the named candidate on a deferral by recovering the raw aggregate pick", () => {
  const recovered = gradeAdventureCase(
    gradingCase({ preferred: "a", acceptable: ["a", "b"] }),
    composition({ band: "fallback", method: "defer", selection: null, topSignal: 0.3 }),
    { [ADVENTURE_SUPPORTED_KEY]: noul(0.95), [ADVENTURE_BEST_KEY]: rawChoice("b", 0.3) },
  );
  assert.equal(recovered.candidateId, "b");
  assert.equal(recovered.selected, null);

  const unsupported = gradeAdventureCase(
    gradingCase({ preferred: "a", acceptable: ["a", "b"] }),
    composition({ band: "fallback", method: "defer", selection: null, topSignal: null }),
    { [ADVENTURE_BEST_KEY]: rawChoice("b", 0.3) },
  );
  assert.equal(unsupported.candidateId, null, "no supported answer means no reconstruction");

  const undeclared = gradeAdventureCase(
    gradingCase({ preferred: "a", acceptable: ["a"] }),
    composition({ band: "fallback", method: "defer", selection: null, topSignal: null }),
    { [ADVENTURE_SUPPORTED_KEY]: noul(0.95), [ADVENTURE_BEST_KEY]: rawChoice("invented:teleport", 0.3) },
  );
  assert.equal(undeclared.candidateId, null, "an undeclared raw choice is never recovered");

  const noAnswers = gradeAdventureCase(
    gradingCase({ preferred: "a", acceptable: ["a"] }),
    composition({ band: "fallback", method: "defer", selection: null, topSignal: 0.3 }),
  );
  assert.equal(noAnswers.candidateId, null);
});

test("promotes, proposes a record, and selects the default when composed decisions already clear the gate", () => {
  const dev = Array.from({ length: 30 }, (_, index) => readout({ id: `dev-${index}`, holdout: false }));
  const holdout = Array.from({ length: 10 }, (_, index) => readout({ id: `holdout-${index}`, holdout: true }));
  const evaluation = evaluateAdventureReadouts([...dev, ...holdout], "2026-09-17");

  assert.equal(evaluation.calibration.devSamples, 30);
  assert.equal(evaluation.calibration.holdoutSamples, 10);
  assert.equal(evaluation.calibration.allCalibrated.samples, 40);
  assert.equal(evaluation.calibration.allCalibrated.accuracy, 1);
  assert.equal(evaluation.gate.promoted, true);
  assert.deepEqual(evaluation.gate.reasons, []);
  assert.ok(evaluation.calibration.allCalibrated.brier <= 0.1, `brier ${evaluation.calibration.allCalibrated.brier}`);
  assert.ok(evaluation.calibration.allCalibrated.expectedCalibrationError <= 0.1, `ece ${evaluation.calibration.allCalibrated.expectedCalibrationError}`);
  assert.ok(evaluation.proposedRecord);
  assert.equal(evaluation.proposedRecord.metrics.samples, 40);
  assert.equal(evaluation.proposedRecord.metrics.accuracy, 1);
  assert.equal(evaluation.proposedRecord.promotedAt, "2026-09-17");
  assert.equal(evaluation.proposedRecord.evidence, "docs/system-one-adventure-benchmark.md");
  assert.ok(Number.isFinite(evaluation.proposedRecord.calibration?.a) && Number.isFinite(evaluation.proposedRecord.calibration?.b));

  assert.equal(evaluation.sweep.defaultVerdict.threshold, ADVENTURE_DEFAULT_ACTION_THRESHOLD);
  assert.equal(evaluation.sweep.defaultVerdict.gate.promoted, true);
  assert.equal(evaluation.sweep.recommendedVerdict?.threshold, ADVENTURE_DEFAULT_ACTION_THRESHOLD);
  assert.equal(evaluation.sweep.recommendedVerdict?.gate.promoted, true);
  assert.equal(evaluation.sweep.points.length, ADVENTURE_THRESHOLD_GRID.length);
  assert.equal(ADVENTURE_THRESHOLD_GRID.at(-1), ADVENTURE_DEFAULT_ACTION_THRESHOLD);
});

test("recommends a lower threshold when the default bar leaves the raw picks below it", () => {
  const underconfident = (id: string, holdout: boolean) => readout({
    id,
    holdout,
    band: "confirm",
    method: "choice",
    selected: null,
    candidateId: "a",
    selectedCorrect: false,
    deferred: true,
    correct: false,
    topSignal: 0.68,
  });
  const evaluation = evaluateAdventureReadouts(
    [
      ...Array.from({ length: 30 }, (_, index) => underconfident(`dev-${index}`, false)),
      ...Array.from({ length: 10 }, (_, index) => underconfident(`holdout-${index}`, true)),
    ],
    "2026-09-17",
  );

  // The composed default commits nothing, so its gate is short of samples.
  assert.equal(evaluation.calibration.allCalibrated.samples, 0);
  assert.equal(evaluation.gate.promoted, false);
  assert.ok(evaluation.gate.reasons.some((reason) => reason.includes("insufficient samples")));

  // Every grid point at or below 0.65 acts on all 40 raw picks with 100% acted accuracy.
  assert.equal(evaluation.sweep.selection.selected?.threshold, 0.65);
  assert.equal(evaluation.sweep.recommendedVerdict?.threshold, 0.65);
  assert.equal(evaluation.sweep.recommendedVerdict?.calibration.allCalibrated.samples, 40);
  assert.equal(evaluation.sweep.recommendedVerdict?.calibration.allCalibrated.accuracy, 1);
  assert.equal(evaluation.sweep.recommendedVerdict?.gate.promoted, true);
  assert.ok(evaluation.sweep.recommendedVerdict);
  assert.ok(
    evaluation.sweep.recommendedVerdict.calibration.allCalibrated.brier <= 0.1,
    `recommended brier ${evaluation.sweep.recommendedVerdict.calibration.allCalibrated.brier}`,
  );
  assert.ok(
    evaluation.sweep.recommendedVerdict.calibration.allCalibrated.expectedCalibrationError <= 0.1,
    `recommended ece ${evaluation.sweep.recommendedVerdict.calibration.allCalibrated.expectedCalibrationError}`,
  );

  // The record the parent would paste comes from the recommended threshold, not the default.
  assert.ok(evaluation.proposedRecord);
  assert.equal(evaluation.proposedRecord.metrics.samples, 40);
  assert.equal(evaluation.sweep.defaultVerdict.gate.promoted, false);
  assert.equal(evaluation.sweep.defaultVerdict.proposedRecord, null);
});

test("reports no recommended threshold when every grid point fails an acted floor", () => {
  const wrong = (id: string, holdout: boolean) => readout({
    id,
    holdout,
    band: "confirm",
    method: "choice",
    selected: null,
    candidateId: "wrong",
    acceptable: ["a"],
    selectedCorrect: false,
    deferred: true,
    correct: false,
    topSignal: 0.68,
  });
  const evaluation = evaluateAdventureReadouts(
    [
      ...Array.from({ length: 30 }, (_, index) => wrong(`dev-${index}`, false)),
      ...Array.from({ length: 10 }, (_, index) => wrong(`holdout-${index}`, true)),
    ],
    "2026-09-17",
  );

  assert.equal(evaluation.sweep.selection.selected, null);
  assert.ok(evaluation.sweep.selection.reasons.some((reason) => reason.includes("no threshold reached")));
  assert.equal(evaluation.sweep.recommendedVerdict, null);
  assert.equal(evaluation.proposedRecord, null);
  assert.equal(evaluation.gate.promoted, false);
});

test("threshold samples score the named candidate and treat the act boundary inclusively", () => {
  const samples = adventureThresholdSamples(
    [
      readout({ id: "named", candidateId: "b", acceptable: ["a", "b"], topSignal: 0.6 }),
      readout({ id: "unnamed", candidateId: null, topSignal: 0.9 }),
      readout({ id: "no-signal", candidateId: "a", topSignal: null }),
    ],
    [0.5, 0.6, 0.7],
  );
  assert.deepEqual(samples, [
    { threshold: 0.5, acted: true, correct: true, predictedProbability: 0.6 },
    { threshold: 0.6, acted: true, correct: true, predictedProbability: 0.6 },
    { threshold: 0.7, acted: false, correct: true, predictedProbability: 0.6 },
  ]);

  const incorrect = adventureThresholdSamples(
    [readout({ candidateId: "wrong", acceptable: ["a"], topSignal: 0.6 })],
    [0.5],
  );
  assert.deepEqual(incorrect, [{ threshold: 0.5, acted: true, correct: false, predictedProbability: 0.6 }]);

  assert.deepEqual(adventureThresholdSamples([readout({ candidateId: null })], [0.5]), []);
});

test("reports NOT READY and proposes no record when the sample gate is short", () => {
  const short = Array.from({ length: 5 }, (_, index) => readout({ id: `s${index}`, holdout: index % 2 === 0 }));
  const evaluation = evaluateAdventureReadouts(short, "2026-09-17");
  assert.equal(evaluation.gate.promoted, false);
  assert.ok(evaluation.gate.reasons.some((reason) => reason.includes("insufficient samples")));
  assert.equal(evaluation.proposedRecord, null);
  assert.equal(evaluation.sweep.selection.selected, null, "fewer than the acted floor at every threshold");
  assert.equal(evaluation.sweep.recommendedVerdict, null);
});

test("fits on development and improves calibration out of sample", () => {
  const underconfident = (id: string, holdout: boolean) => readout({ id, holdout, topSignal: 0.6 });
  const evaluation = evaluateAdventureReadouts(
    [
      underconfident("dev-1", false),
      underconfident("dev-2", false),
      underconfident("holdout-1", true),
      underconfident("holdout-2", true),
    ],
    "2026-09-17",
  );
  assert.equal(evaluation.calibration.devSamples, 2);
  assert.equal(evaluation.calibration.holdoutSamples, 2);
  assert.ok(evaluation.calibration.holdoutCalibrated.brier <= evaluation.calibration.holdoutRaw.brier);
  assert.ok(Number.isFinite(evaluation.calibration.fitted.a) && Number.isFinite(evaluation.calibration.fitted.b));
  for (const metrics of [
    evaluation.calibration.allRaw,
    evaluation.calibration.allCalibrated,
    evaluation.calibration.holdoutRaw,
    evaluation.calibration.holdoutCalibrated,
  ]) {
    assert.ok(metrics.brier >= 0 && metrics.brier <= 1, `brier out of range: ${metrics.brier}`);
    assert.ok(
      metrics.expectedCalibrationError >= 0 && metrics.expectedCalibrationError <= 1,
      `ece out of range: ${metrics.expectedCalibrationError}`,
    );
  }
});

test("excludes deferrals and unusable signals from the acted calibration points", () => {
  const evaluation = evaluateAdventureReadouts(
    [
      readout({ id: "act", topSignal: 0.8 }),
      readout({ id: "confirm", band: "confirm", method: "choice", selected: null, candidateId: "a", selectedCorrect: false, deferred: true, correct: false, topSignal: 0.6 }),
      readout({ id: "fallback", band: "fallback", method: "defer", selected: null, candidateId: "a", selectedCorrect: true, deferred: true, correct: true, topSignal: 0.2 }),
      readout({ id: "null-signal", topSignal: null }),
    ],
    "2026-09-17",
  );
  // The null-signal row is acted but contributes no calibration point.
  assert.equal(evaluation.calibration.allRaw.samples, 1);
  assert.equal(evaluation.calibration.allCalibrated.accuracy, 1);
});

test("rolls up per-case counts, bands, outcomes, and failures", () => {
  const first = ADVENTURE_EVAL_CASES[0]!;
  const holdoutCase = ADVENTURE_EVAL_CASES.find((testCase) => testCase.holdout)!;
  const summaries = summarizeAdventureCases(
    [
      readout({ id: first.id, category: first.category }),
      readout({
        id: first.id,
        category: first.category,
        band: "fallback",
        method: "defer",
        selected: null,
        candidateId: null,
        selectedCorrect: false,
        deferred: true,
        correct: false,
        topSignal: 0.3,
      }),
      readout({ id: holdoutCase.id, category: holdoutCase.category, holdout: true, selected: "wrong", candidateId: "wrong", selectedCorrect: false, correct: false, topSignal: 0.8 }),
    ],
    [{ id: holdoutCase.id }],
  );
  assert.equal(summaries.length, ADVENTURE_EVAL_CASES.length, "every corpus case gets a row");
  assert.deepEqual(summaries.map((summary) => summary.id), ADVENTURE_EVAL_CASES.map((testCase) => testCase.id));

  const firstSummary = summaries.find((summary) => summary.id === first.id)!;
  assert.equal(firstSummary.calls, 2);
  assert.equal(firstSummary.acted, 1);
  assert.equal(firstSummary.exact, 1);
  assert.equal(firstSummary.correct, 1);
  assert.equal(firstSummary.failed, 0);
  assert.deepEqual(firstSummary.bands, { act: 1, confirm: 0, fallback: 1 });
  assert.deepEqual(firstSummary.selections, { a: 1, defer: 1 });
  assert.ok(Math.abs(firstSummary.meanSignal - 0.6) < 1e-9, `mean signal ${firstSummary.meanSignal}`);
  assert.equal(firstSummary.expected, first.expected.preferred);

  const holdoutSummary = summaries.find((summary) => summary.id === holdoutCase.id)!;
  assert.equal(holdoutSummary.failed, 1);
});

test("parses repeat and out flags with safe defaults", () => {
  assert.deepEqual(parseAdventureArgs([]), { repeats: 3, out: "docs/system-one-adventure-benchmark.md" });
  assert.deepEqual(parseAdventureArgs(["--repeat", "5", "--out", "docs/custom.md"]), { repeats: 5, out: "docs/custom.md" });
  assert.deepEqual(parseAdventureArgs(["--repeat=2"]), { repeats: 2, out: "docs/system-one-adventure-benchmark.md" });
  assert.equal(parseAdventureArgs(["--repeat", "0"]).repeats, 1);
  assert.equal(parseAdventureArgs(["--repeat", "999"]).repeats, 25);
  assert.equal(parseAdventureArgs(["--repeat", "nonsense"]).repeats, 3);
  assert.equal(parseAdventureArgs(["--repeat", "3.9"]).repeats, 3);
});

test("renders the benchmark report with the sweep, honesty, and reproduce sections", () => {
  const first = ADVENTURE_EVAL_CASES[0]!;
  const readouts = [
    gradeAdventureCase(first, composition({ selection: { candidateId: first.expected.preferred!, digest: "a".repeat(64) } })),
    gradeAdventureCase(first, composition({ band: "fallback", method: "defer", selection: null, topSignal: 0.2 })),
  ];
  const evaluation = evaluateAdventureReadouts(readouts, "2026-09-17");
  const report = renderAdventureBenchmark({
    generatedAt: "2026-09-17T00:00:00.000Z",
    model: "jev-test",
    baseUrl: "https://example.test/v1",
    repeats: 1,
    thresholds,
    readouts,
    failures: [],
    evaluation,
    proposedRecord: evaluation.proposedRecord,
    out: "docs/system-one-adventure-benchmark.md",
  });
  assert.ok(report.startsWith("# System One (Jev) L2 adventure-selection benchmark"));
  assert.ok(report.includes("## What this measures"));
  assert.ok(report.includes("never adds, drops, or authorizes a candidate"));
  assert.ok(report.includes("advisory exact-candidate selector, wired in shadow (record-only)"));
  assert.ok(report.includes("`active` lane mode is still record-only"));
  assert.ok(!report.includes("unwired"), "the wiring-status prose must not claim the lane is unwired");
  assert.ok(report.includes("## Corpus and per-case results"));
  assert.ok(report.includes("## Decision stability"));
  assert.ok(report.includes("## Threshold sweep"));
  assert.ok(report.includes("No threshold qualified"));
  assert.ok(report.includes("Server default"));
  assert.ok(report.includes("## Calibration"));
  assert.ok(report.includes("## Promotion gate — `adventure-selection`"));
  assert.ok(report.includes("**NOT READY**"));
  assert.ok(report.includes("## Honesty notes"));
  assert.ok(report.includes("asserted-subset figure"));
  assert.ok(report.includes("repeatability, not accuracy"));
  assert.ok(report.includes("set -a; . /tmp/opencode/jev/jev.env; set +a"));
  assert.ok(report.includes("docs/system-one-adventure-benchmark.json"));
  assert.ok(!report.includes("### Proposed `adventure-selection` promotion record"), "no record when no threshold qualifies");

  const promoted = evaluateAdventureReadouts(
    [
      ...Array.from({ length: 30 }, (_, index) => readout({ id: `dev-${index}`, holdout: false })),
      ...Array.from({ length: 10 }, (_, index) => readout({ id: `holdout-${index}`, holdout: true })),
    ],
    "2026-09-17",
  );
  assert.ok(promoted.proposedRecord);
  const promotedReport = renderAdventureBenchmark({
    generatedAt: "2026-09-17T00:00:00.000Z",
    model: "jev-test",
    baseUrl: "https://example.test/v1",
    repeats: 1,
    thresholds,
    readouts: promoted.readouts,
    failures: [],
    evaluation: promoted,
    proposedRecord: promoted.proposedRecord,
    out: "docs/system-one-adventure-benchmark.md",
  });
  assert.ok(promotedReport.includes("**PROMOTE**"));
  assert.ok(promotedReport.includes("### Proposed `adventure-selection` promotion record"));
  assert.ok(promotedReport.includes("```json"));
});

test("no candidate list defers by construction", () => {
  const emptyCase = ADVENTURE_EVAL_CASES.find((testCase) => testCase.candidates.length === 0);
  assert.ok(emptyCase, "expected an empty candidate list case");
  const graded = gradeAdventureCase(emptyCase, composition({ band: "fallback", method: "defer", selection: null, topSignal: null }));
  assert.equal(graded.deferred, true);
  assert.equal(graded.selected, null);
  assert.equal(graded.candidateId, null);
  assert.equal(graded.correct, true);
});

test("rolls up decision stability over synthetic readouts", () => {
  const summary = summarizeAdventureStability([
    readout({ id: "stable", candidateId: "a", topSignal: 0.8 }),
    readout({ id: "stable", candidateId: "a", topSignal: 0.6 }),
    readout({ id: "conflicted", candidateId: "a", topSignal: 0.8 }),
    readout({ id: "conflicted", candidateId: "b", topSignal: 0.7 }),
    readout({ id: "deferred", candidateId: null, topSignal: null, selected: null, selectedCorrect: true, deferred: true, correct: true }),
    readout({ id: "deferred", candidateId: null, topSignal: null, selected: null, selectedCorrect: true, deferred: true, correct: true }),
  ]);

  assert.equal(summary.cases.length, 3);
  assert.equal(summary.repeats, 6);
  assert.equal(summary.conflictCases, 1);
  assert.ok(Math.abs(summary.conflictRate - 1 / 3) < 1e-9, `conflict rate ${summary.conflictRate}`);
  assert.ok(Math.abs(summary.meanAgreement - 2.5 / 3) < 1e-9, `mean agreement ${summary.meanAgreement}`);

  const stable = summary.cases[0]!;
  assert.equal(stable.agreement, 1);
  assert.equal(stable.conflicted, false);
  assert.deepEqual(stable.decisions, ["a"]);
  assert.ok(stable.signalStdDev !== null && Math.abs(stable.signalStdDev - 0.1) < 1e-9);

  const conflicted = summary.cases[1]!;
  assert.equal(conflicted.agreement, 0.5);
  assert.deepEqual(conflicted.decisions, ["a", "b"]);
  assert.ok(conflicted.signalStdDev !== null && Math.abs(conflicted.signalStdDev - 0.05) < 1e-9);

  const deferred = summary.cases[2]!;
  assert.deepEqual(deferred.decisions, ["defer"], "a null named candidate is a deferral decision");
  assert.equal(deferred.agreement, 1, "a consistently deferred case is stable");
  assert.equal(deferred.signalStdDev, null);

  assert.ok(summary.meanSignalStdDev !== null && Math.abs(summary.meanSignalStdDev - 0.075) < 1e-9);
  assert.ok(summary.maxSignalStdDev !== null && Math.abs(summary.maxSignalStdDev - 0.1) < 1e-9);

  assert.deepEqual(adventureStabilitySamples([readout({ candidateId: null, topSignal: null })]), [
    { caseId: "case", decision: "defer", signal: null },
  ]);
});

test("merges confirmed harvested proposals and skips unusable labels", () => {
  const merged = mergeHarvestedAdventureCases([
    harvestProposal({ proposalId: "1".repeat(64) }),
    harvestProposal({ proposalId: `${"1".repeat(12)}${"b".repeat(52)}` }), // same id prefix as the first
    harvestProposal({ proposalId: "3".repeat(64), expected: null }),
    harvestProposal({ proposalId: "4".repeat(64), expected: { candidateId: 42 } }),
    harvestProposal({ proposalId: "5".repeat(64), expected: { candidateId: "not-advertised" } }),
    harvestProposal({ proposalId: "6".repeat(64), expected: { candidateId: null }, state: { declaration: "I look around.", candidates: [] } }),
    harvestProposal({ proposalId: "7".repeat(64), lane: "director-selection" }),
    harvestProposal({ proposalId: "8".repeat(64), status: "proposed" }),
    harvestProposal({ proposalId: "9".repeat(64), state: "not-an-object" }),
  ]);

  assert.equal(merged.confirmed, 7, "confirmed adventure proposals are counted before skips");
  assert.equal(merged.cases.length, 2);
  assert.equal(merged.skipped, 5, "duplicate, null, malformed, unadvertised, and unusable state are skipped");

  const primary = merged.cases.find((entry) => entry.id === `harvested:${"1".repeat(12)}`);
  assert.ok(primary);
  assert.equal(primary.category, "harvested");
  assert.equal(primary.declaration, "I walk to the mill.");
  assert.equal(primary.candidates.length, 1);
  assert.deepEqual(primary.expected, { preferred: "harvest:travel", acceptable: ["harvest:travel"] });
  assert.equal(primary.holdout, false, "harvested cases are development cases");

  const defer = merged.cases.find((entry) => entry.id === `harvested:${"6".repeat(12)}`);
  assert.ok(defer);
  assert.deepEqual(defer.expected, { preferred: null, acceptable: [null] });
  assert.equal(defer.candidates.length, 0);
});

test("treats an absent or malformed harvest fixture as zero cases without failing", async () => {
  const missing = await loadHarvestedAdventureCases(path.join(tmpdir(), `velvet-adventure-harvest-missing-${process.pid}.json`));
  assert.deepEqual(
    { cases: missing.cases.length, present: missing.present, warning: missing.warning },
    { cases: 0, present: false, warning: null },
  );

  const notJson = parseHarvestedAdventureCases("{not json");
  assert.equal(notJson.cases.length, 0);
  assert.equal(notJson.present, true);
  assert.ok(notJson.warning?.includes("not valid JSON"));

  const noProposals = parseHarvestedAdventureCases(JSON.stringify({ version: 1, lane: "adventure-selection", generatedAt: "2026-09-17T00:00:00.000Z" }));
  assert.equal(noProposals.cases.length, 0);
  assert.ok(noProposals.warning?.includes("proposals"));

  const wrongVersion = parseHarvestedAdventureCases(JSON.stringify({ version: 2, lane: "adventure-selection", generatedAt: "x", proposals: [] }));
  assert.equal(wrongVersion.cases.length, 0);
  assert.ok(wrongVersion.warning?.includes("version"));

  const wrongLane = parseHarvestedAdventureCases(JSON.stringify({ version: 1, lane: "guardrails", generatedAt: "x", proposals: [harvestProposal()] }));
  assert.equal(wrongLane.cases.length, 0);
  assert.ok(wrongLane.warning?.includes("guardrails"));

  const fixture = { version: 1, lane: "adventure-selection", generatedAt: "2026-09-17T00:00:00.000Z", proposals: [harvestProposal()] };
  const parsed = parseHarvestedAdventureCases(JSON.stringify(fixture));
  assert.equal(parsed.warning, null);
  assert.equal(parsed.cases.length, 1);

  const directory = await mkdtemp(path.join(tmpdir(), "velvet-adventure-harvest-"));
  try {
    const file = path.join(directory, "adventure-selection.json");
    await writeFile(file, JSON.stringify(fixture), "utf8");
    const loaded = await loadHarvestedAdventureCases(file);
    assert.equal(loaded.present, true);
    assert.equal(loaded.warning, null);
    assert.equal(loaded.cases.length, 1);
    assert.equal(loaded.cases[0]?.category, "harvested");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renders harvested provenance and counts harvested cases separately", () => {
  const merged = mergeHarvestedAdventureCases([harvestProposal()]);
  const cases = [...ADVENTURE_EVAL_CASES, ...merged.cases];
  const evaluation = evaluateAdventureReadouts([], "2026-09-17");
  const report = renderAdventureBenchmark({
    generatedAt: "2026-09-17T00:00:00.000Z",
    model: "jev-test",
    baseUrl: "https://example.test/v1",
    repeats: 1,
    thresholds,
    readouts: [],
    failures: [],
    evaluation,
    proposedRecord: null,
    out: "docs/system-one-adventure-benchmark.md",
    cases,
    harvest: {
      fixture: "server/test/fixtures/system-one-harvested/adventure-selection.json",
      present: true,
      confirmed: 1,
      skipped: 0,
      cases: 1,
      warning: null,
    },
  });
  assert.ok(report.includes(`harvested:${"1".repeat(12)}`));
  assert.ok(report.includes("| dev | harvested | harvest:travel |"), "the corpus table marks harvested provenance");
  assert.ok(report.includes("Harvested cases"));
  assert.ok(report.includes("confirmed live-derived labels"));
  assert.ok(!report.includes("Harvest warning"), "a clean fixture produces no warning");
});
