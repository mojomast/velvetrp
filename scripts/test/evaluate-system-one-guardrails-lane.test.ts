import assert from "node:assert/strict";
import test from "node:test";
import {
  GUARDRAIL_SEVERITY_KEY,
  composeGuardrailDecision,
} from "../../server/src/agent/systemOneGuardrails.js";
import type { SystemOneAnswer } from "../../server/src/provider/systemOneCompletion.js";
import {
  GUARDRAILS_EVAL_CATEGORIES,
  GUARDRAILS_EVAL_CORPUS,
  expectedHazardsForCategory,
  validateGuardrailsEvalCases,
  type GuardrailsEvalCase,
} from "../../server/test/fixtures/guardrails-evals/corpus.js";
import {
  evaluateGuardrailsReadouts,
  gradeGuardrailsCase,
  parseGuardrailsArgs,
  renderGuardrailsBenchmark,
  summarizeGuardrailsCases,
  type GuardrailsReadout,
} from "../evaluate-system-one-guardrails-lane.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };
const noul = (value: number): SystemOneAnswer => ({ type: "noul", noul: value });
const severity = (level: number): SystemOneAnswer => ({ type: "score", score: level, confidence: 0.9, legend: {}, probabilities: {} });

const benignAnswers = (overrides: Partial<Record<string, SystemOneAnswer>> = {}): Record<string, SystemOneAnswer> => ({
  override_attempt: noul(0.02),
  boundary_crossing: noul(0.02),
  disclosure_request: noul(0.02),
  self_harm_signal: noul(0.01),
  [GUARDRAIL_SEVERITY_KEY]: severity(0),
  ...overrides,
});

function syntheticCase(overrides: Partial<GuardrailsEvalCase> = {}): GuardrailsEvalCase {
  const testCase: GuardrailsEvalCase = {
    id: overrides.id ?? "synthetic",
    category: overrides.category ?? "benign",
    message: overrides.message ?? "synthetic message",
    expected: overrides.expected ?? "pass",
    holdout: overrides.holdout ?? false,
  };
  if (overrides.declaredBoundaries !== undefined) testCase.declaredBoundaries = overrides.declaredBoundaries;
  if (overrides.acceptable !== undefined) testCase.acceptable = overrides.acceptable;
  return testCase;
}

/** A composed block on a synthetic override case: acted, correct, and signal-bearing. */
const blockedReadout = (id: string, holdout: boolean, signal = 0.9): GuardrailsReadout =>
  gradeGuardrailsCase(
    syntheticCase({ id, category: "override-attempt", expected: "block", holdout }),
    composeGuardrailDecision(benignAnswers({ override_attempt: noul(signal) }), thresholds),
  );

test("corpus validates, covers every category, and keeps unique ids with holdouts", () => {
  assert.doesNotThrow(() => validateGuardrailsEvalCases(GUARDRAILS_EVAL_CORPUS));
  assert.ok(GUARDRAILS_EVAL_CORPUS.length >= 30 && GUARDRAILS_EVAL_CORPUS.length <= 40, "expected 30-40 cases");
  assert.equal(new Set(GUARDRAILS_EVAL_CORPUS.map((entry) => entry.id)).size, GUARDRAILS_EVAL_CORPUS.length);
  const categories = new Set(GUARDRAILS_EVAL_CORPUS.map((entry) => entry.category));
  for (const category of GUARDRAILS_EVAL_CATEGORIES) assert.ok(categories.has(category), `missing category ${category}`);
  assert.ok(GUARDRAILS_EVAL_CORPUS.filter((entry) => entry.holdout).length >= 8, "expected at least 8 holdouts");
  assert.ok(GUARDRAILS_EVAL_CORPUS.some((entry) => !entry.holdout), "expected development cases");
  for (const entry of GUARDRAILS_EVAL_CORPUS) {
    if (entry.acceptable) assert.ok(entry.acceptable.includes(entry.expected), `expected must be acceptable: ${entry.id}`);
  }
});

test("corpus covers the required hazard and false-positive shapes", () => {
  const count = (category: GuardrailsEvalCase["category"]): number =>
    GUARDRAILS_EVAL_CORPUS.filter((entry) => entry.category === category).length;
  assert.ok(count("override-attempt") >= 2, "expected two override attempts");
  assert.ok(count("boundary-crossing") >= 2, "expected two boundary crossings");
  assert.ok(count("disclosure-request") >= 2, "expected two disclosure requests");
  assert.ok(count("self-harm") >= 2, "expected two genuine self-harm signals");
  assert.ok(count("fiction") >= 4, "expected multiple fiction controls");
  assert.ok(count("benign") >= 4, "expected multiple benign controls");
  assert.ok(count("ambiguous") >= 1, "expected ambiguous cases");
  const boundaryCases = GUARDRAILS_EVAL_CORPUS.filter((entry) => entry.category === "boundary-crossing");
  assert.ok(boundaryCases.every((entry) => (entry.declaredBoundaries ?? []).length > 0), "boundary crossings need a declared boundary");
  const selfHarmSignals = GUARDRAILS_EVAL_CORPUS.filter((entry) => entry.category === "self-harm");
  assert.ok(selfHarmSignals.every((entry) => entry.expected === "support"), "self-harm cases must not expect a block");
  assert.ok(selfHarmSignals.some((entry) => entry.acceptable?.includes("review")), "expected an indirect self-harm signal");
  const ambiguous = GUARDRAILS_EVAL_CORPUS.filter((entry) => entry.category === "ambiguous");
  assert.ok(ambiguous.every((entry) => entry.expected === "review"), "ambiguous cases must expect review");
  assert.ok(GUARDRAILS_EVAL_CORPUS.some((entry) => entry.expected === "block" && entry.acceptable?.includes("review")), "expected a block case that tolerates review");
});

test("validation rejects duplicate ids, empty messages, and missing coverage", () => {
  assert.throws(
    () => validateGuardrailsEvalCases([syntheticCase({ id: "dup" }), syntheticCase({ id: "dup" })]),
    /invalid guardrails evaluation id/,
  );
  assert.throws(() => validateGuardrailsEvalCases([syntheticCase({ id: "empty", message: "   " })]), /empty guardrails evaluation message/);
  assert.throws(
    () => validateGuardrailsEvalCases([
      syntheticCase({ id: "dev", category: "benign" }),
      syntheticCase({ id: "hold", category: "fiction", holdout: true }),
    ]),
    /missing guardrails evaluation categories/,
  );
  assert.throws(
    () => validateGuardrailsEvalCases([syntheticCase({ id: "accept", acceptable: ["review"] })]),
    /expected disposition must be acceptable/,
  );
});

test("grades an acted block on a hazard case as correct", () => {
  const testCase = syntheticCase({ id: "ovr", category: "override-attempt", expected: "block" });
  const readout = gradeGuardrailsCase(testCase, composeGuardrailDecision(benignAnswers({ override_attempt: noul(0.95) }), thresholds));
  assert.equal(readout.disposition, "block");
  assert.equal(readout.band, "act");
  assert.equal(readout.correct, true);
  assert.equal(readout.acted, true);
  assert.deepEqual(readout.hazards, ["override_attempt"]);
  assert.deepEqual(readout.missedHazards, []);
  assert.equal(readout.topSignal, 0.95);
});

test("accepts a defensible review where block was expected when review is acceptable", () => {
  const reviewCase = GUARDRAILS_EVAL_CORPUS.find((entry) => entry.id === "bnd-5")!;
  const readout = gradeGuardrailsCase(reviewCase, composeGuardrailDecision(benignAnswers({ boundary_crossing: noul(0.6) }), thresholds));
  assert.equal(readout.disposition, "review");
  assert.equal(readout.band, "confirm");
  assert.equal(readout.correct, true);
  assert.equal(readout.acted, false);
  assert.deepEqual(readout.hazards, ["boundary_crossing"]);

  // The same review is incorrect when the label only accepts a block.
  const strictCase = syntheticCase({ id: "strict", category: "boundary-crossing", expected: "block" });
  const strict = gradeGuardrailsCase(strictCase, composeGuardrailDecision(benignAnswers({ boundary_crossing: noul(0.6) }), thresholds));
  assert.equal(strict.disposition, "review");
  assert.equal(strict.correct, false);
});

test("grades a benign pass as correct and a false-positive block as incorrect", () => {
  const benignCase = syntheticCase({ id: "ben", category: "benign", expected: "pass" });
  const pass = gradeGuardrailsCase(benignCase, composeGuardrailDecision(benignAnswers(), thresholds));
  assert.equal(pass.disposition, "pass");
  assert.equal(pass.correct, true);
  assert.equal(pass.acted, false);

  const blocked = gradeGuardrailsCase(benignCase, composeGuardrailDecision(benignAnswers({ boundary_crossing: noul(0.9) }), thresholds));
  assert.equal(blocked.disposition, "block");
  assert.equal(blocked.correct, false);
  assert.equal(blocked.acted, true);
});

test("routes self-harm to support and marks an expected hazard that never cleared review", () => {
  const crisis = syntheticCase({ id: "sh", category: "self-harm", expected: "support" });
  const supported = gradeGuardrailsCase(crisis, composeGuardrailDecision(benignAnswers({ self_harm_signal: noul(0.95) }), thresholds));
  assert.equal(supported.disposition, "support");
  assert.equal(supported.band, "act");
  assert.equal(supported.correct, true);

  const disclosure = syntheticCase({ id: "dis", category: "disclosure-request", expected: "block" });
  const missed = gradeGuardrailsCase(disclosure, composeGuardrailDecision(benignAnswers(), thresholds));
  assert.equal(missed.disposition, "pass");
  assert.equal(missed.correct, false);
  assert.deepEqual(missed.missedHazards, ["disclosure_request"]);
  assert.deepEqual(expectedHazardsForCategory("self-harm"), ["self_harm_signal"]);
  assert.deepEqual(expectedHazardsForCategory("fiction"), []);
});

test("promotes and proposes a record when enough acted samples are correct", () => {
  const readouts: GuardrailsReadout[] = [
    ...Array.from({ length: 30 }, (_, index) => blockedReadout(`dev-${index}`, false)),
    ...Array.from({ length: 10 }, (_, index) => blockedReadout(`holdout-${index}`, true)),
  ];
  const evaluation = evaluateGuardrailsReadouts(readouts, "2026-09-17");

  assert.equal(evaluation.calibration.allCalibrated.samples, 40);
  assert.equal(evaluation.calibration.devSamples, 30);
  assert.equal(evaluation.calibration.holdoutSamples, 10);
  assert.equal(evaluation.calibration.allCalibrated.accuracy, 1);
  assert.equal(evaluation.gate.promoted, true);
  assert.deepEqual(evaluation.gate.reasons, []);
  assert.ok(evaluation.calibration.allCalibrated.brier <= 0.05);
  assert.ok(evaluation.calibration.allCalibrated.expectedCalibrationError <= 0.05);
  assert.ok(evaluation.proposedRecord);
  assert.equal(evaluation.proposedRecord.metrics.samples, 40);
  assert.equal(evaluation.proposedRecord.metrics.accuracy, 1);
  assert.equal(evaluation.proposedRecord.promotedAt, "2026-09-17");
  assert.equal(evaluation.proposedRecord.evidence, "docs/system-one-guardrails-benchmark.md");
  assert.ok(Number.isFinite(evaluation.proposedRecord.calibration?.a));
  assert.ok(Number.isFinite(evaluation.proposedRecord.calibration?.b));
});

test("excludes deferrals and signal-less readouts from the acted gate sample", () => {
  const deferred = gradeGuardrailsCase(
    syntheticCase({ id: "amb", category: "ambiguous", expected: "review" }),
    composeGuardrailDecision(benignAnswers({ boundary_crossing: noul(0.6) }), thresholds),
  );
  const silent: GuardrailsReadout = { ...blockedReadout("silent", false), topSignal: null };
  const readouts: GuardrailsReadout[] = [
    ...Array.from({ length: 20 }, (_, index) => blockedReadout(`dev-${index}`, false)),
    ...Array.from({ length: 10 }, (_, index) => blockedReadout(`holdout-${index}`, true)),
    deferred,
    silent,
  ];
  const evaluation = evaluateGuardrailsReadouts(readouts, "2026-09-17");

  assert.equal(evaluation.calibration.allCalibrated.samples, 30);
  assert.equal(evaluation.calibration.allRaw.samples, 30);
  assert.equal(evaluation.calibration.devSamples, 20);
  assert.equal(evaluation.calibration.holdoutSamples, 10);
  assert.equal(evaluation.calibration.allCalibrated.accuracy, 1);
  assert.equal(evaluation.gate.promoted, true);
});

test("reports NOT READY and proposes no record when the sample gate is short", () => {
  const short = Array.from({ length: 5 }, (_, index) => blockedReadout(`short-${index}`, index % 2 === 0));
  const evaluation = evaluateGuardrailsReadouts(short, "2026-09-17");

  assert.equal(evaluation.gate.promoted, false);
  assert.ok(evaluation.gate.reasons.some((reason) => reason.includes("insufficient samples")));
  assert.equal(evaluation.proposedRecord, null);
});

test("rolls up per-case counts and the confusion matrix by expected disposition", () => {
  const corpus = [
    syntheticCase({ id: "a1", category: "override-attempt", expected: "block" }),
    syntheticCase({ id: "b1", category: "benign", expected: "pass" }),
  ];
  const blocked = gradeGuardrailsCase(corpus[0]!, composeGuardrailDecision(benignAnswers({ override_attempt: noul(0.95) }), thresholds));
  const missed = gradeGuardrailsCase(corpus[0]!, composeGuardrailDecision(benignAnswers(), thresholds));
  const escalated = gradeGuardrailsCase(corpus[1]!, composeGuardrailDecision(benignAnswers({ boundary_crossing: noul(0.9) }), thresholds));
  const summaries = summarizeGuardrailsCases([blocked, missed, escalated], corpus);

  assert.deepEqual(summaries.cases.map((entry) => entry.id), ["a1", "b1"]);
  const a1 = summaries.cases[0]!;
  assert.equal(a1.total, 2);
  assert.equal(a1.acted, 1);
  assert.equal(a1.correct, 1);
  assert.equal(a1.dispositions.block, 1);
  assert.equal(a1.dispositions.pass, 1);
  assert.deepEqual(a1.hazards, ["override_attempt"]);
  const b1 = summaries.cases[1]!;
  assert.equal(b1.dispositions.block, 1);
  assert.equal(b1.correct, 0);

  const blockRow = summaries.confusion.find((row) => row.expected === "block")!;
  assert.equal(blockRow.composed.block, 1);
  assert.equal(blockRow.composed.pass, 1);
  assert.equal(blockRow.total, 2);
  const passRow = summaries.confusion.find((row) => row.expected === "pass")!;
  assert.equal(passRow.composed.block, 1);
  assert.equal(passRow.total, 1);
  const supportRow = summaries.confusion.find((row) => row.expected === "support")!;
  assert.equal(supportRow.total, 0);
});

test("parses repeat and out flags with safe defaults", () => {
  assert.deepEqual(parseGuardrailsArgs([]), { repeats: 3, out: "docs/system-one-guardrails-benchmark.md" });
  assert.deepEqual(parseGuardrailsArgs(["--repeat", "5", "--out", "docs/custom.md"]), { repeats: 5, out: "docs/custom.md" });
  assert.deepEqual(parseGuardrailsArgs(["--repeat=2"]), { repeats: 2, out: "docs/system-one-guardrails-benchmark.md" });
  assert.equal(parseGuardrailsArgs(["--repeat", "0"]).repeats, 1);
  assert.equal(parseGuardrailsArgs(["--repeat", "999"]).repeats, 25);
  assert.equal(parseGuardrailsArgs(["--repeat", "nope"]).repeats, 3);
});

test("renders the benchmark report with the required sections", () => {
  const overrideCase = GUARDRAILS_EVAL_CORPUS.find((entry) => entry.category === "override-attempt")!;
  const benignCase = GUARDRAILS_EVAL_CORPUS.find((entry) => entry.category === "benign")!;
  const readouts = [
    gradeGuardrailsCase(overrideCase, composeGuardrailDecision(benignAnswers({ override_attempt: noul(0.95) }), thresholds)),
    gradeGuardrailsCase(benignCase, composeGuardrailDecision(benignAnswers(), thresholds)),
  ];
  const evaluation = evaluateGuardrailsReadouts(readouts, "2026-09-17");
  const markdown = renderGuardrailsBenchmark({
    generatedAt: "2026-09-17T00:00:00.000Z",
    model: "jev-latest",
    baseUrl: "https://api.typesafe.ai/v1",
    repeats: 1,
    thresholds,
    readouts,
    failures: [],
    evaluation,
    proposedRecord: evaluation.proposedRecord,
  });

  for (const heading of [
    "## What this measures",
    "## Corpus",
    "## Per-case results",
    "## Confusion matrix",
    "## Calibration",
    "## Promotion gate",
    "## Observations",
    "## Honesty notes",
    "## Reproduce",
  ]) {
    assert.ok(markdown.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(markdown.includes("never blocks"));
  assert.ok(markdown.includes("set -a; . /tmp/opencode/jev/jev.env; set +a"));
  assert.ok(markdown.includes("docs/system-one-guardrails-benchmark.json"));
});
