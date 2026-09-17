import assert from "node:assert/strict";
import test from "node:test";
import type { SystemOnePromotionResult } from "../../server/src/agent/systemOnePromotion.js";
import type { SystemOneAnswer } from "../../server/src/provider/systemOneCompletion.js";
import {
  aggregateRouterMetrics,
  evaluateCalibration,
  gradeRouterCase,
  parseRouterArgs,
  proposeRecord,
  ROUTER_CORPUS,
  type RouterReadout,
} from "../evaluate-system-one-router-lane.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };
const current = "frontier-generation" as const;

function handlerChoice(choice: string, top: number): SystemOneAnswer {
  const rest = Math.max(0, 1 - top);
  return { type: "choice", choice, confidence: top, probabilities: { [choice]: top, none_of_these: rest } };
}

const noul = (value: number): SystemOneAnswer => ({ type: "noul", noul: value });

function readout(overrides: Partial<RouterReadout> = {}): RouterReadout {
  return {
    id: "case",
    holdout: false,
    expectedHandler: "cheap-generation",
    handler: "cheap-generation",
    band: "act",
    complexity: 1,
    topSignal: 0.9,
    correct: true,
    acted: true,
    reason: "test",
    ...overrides,
  };
}

test("corpus covers every handler and forces safety and human-decision cases to human review", () => {
  const expected = new Set(ROUTER_CORPUS.map((testCase) => testCase.expectedHandler));
  for (const handler of ["deterministic", "cheap-generation", "frontier-generation", "human-review"] as const) {
    assert.ok(expected.has(handler), `missing handler ${handler}`);
  }
  const ids = new Set(ROUTER_CORPUS.map((testCase) => testCase.id));
  assert.equal(ids.size, ROUTER_CORPUS.length, "case ids must be unique");
  const safety = ROUTER_CORPUS.filter((testCase) => testCase.request.safetySensitive || testCase.request.requiresHumanDecision);
  assert.ok(safety.length >= 2, "expected safety-sensitive and human-decision cases");
  assert.ok(safety.every((testCase) => testCase.expectedHandler === "human-review"));
  assert.ok(ROUTER_CORPUS.some((testCase) => testCase.holdout), "expected at least one holdout case");
  assert.ok(ROUTER_CORPUS.some((testCase) => !testCase.holdout), "expected development cases");
});

test("grades the safety gate and the deterministic-first rule", () => {
  const safetyCase = { id: "s", holdout: false, expectedHandler: "human-review" as const };
  const safety = gradeRouterCase(
    safetyCase,
    { summary: "harm", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: true },
    { handler: handlerChoice("cheap-generation", 0.99) },
    thresholds,
    current,
  );
  assert.equal(safety.handler, "human-review");
  assert.equal(safety.correct, true);
  assert.equal(safety.acted, false);

  const confidentReview = gradeRouterCase(
    { id: "h", holdout: false, expectedHandler: "human-review" },
    { summary: "decide", hasDeterministicPath: false, requiresHumanDecision: true, safetySensitive: false },
    { handler: handlerChoice("human-review", 0.9) },
    thresholds,
    current,
  );
  assert.equal(confidentReview.band, "act");
  assert.equal(confidentReview.handler, "human-review");
  assert.equal(confidentReview.correct, true);

  const deterministic = gradeRouterCase(
    { id: "d", holdout: false, expectedHandler: "deterministic" },
    { summary: "roll", hasDeterministicPath: true, requiresHumanDecision: false, safetySensitive: false },
    { deterministic_sufficient: noul(0.9) },
    thresholds,
    current,
  );
  assert.equal(deterministic.band, "act");
  assert.equal(deterministic.handler, "deterministic");
  assert.equal(deterministic.topSignal, 0.9);
  assert.equal(deterministic.correct, true);
});

test("grades confident cheaper moves, deferrals, and the no-upgrade rule", () => {
  const request = { summary: "route", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false };
  const cheap = gradeRouterCase(
    { id: "c", holdout: false, expectedHandler: "cheap-generation" },
    request,
    { handler: handlerChoice("cheap-generation", 0.9) },
    thresholds,
    current,
  );
  assert.deepEqual(
    { band: cheap.band, handler: cheap.handler, correct: cheap.correct, acted: cheap.acted, signal: cheap.topSignal },
    { band: "act", handler: "cheap-generation", correct: true, acted: true, signal: 0.9 },
  );

  const deferred = gradeRouterCase(
    { id: "c2", holdout: false, expectedHandler: "cheap-generation" },
    request,
    { handler: handlerChoice("cheap-generation", 0.6) },
    thresholds,
    current,
  );
  assert.equal(deferred.band, "confirm");
  assert.equal(deferred.handler, current);
  assert.equal(deferred.acted, false);
  assert.equal(deferred.correct, false);

  const noUpgrade = gradeRouterCase(
    { id: "u", holdout: false, expectedHandler: "cheap-generation" },
    request,
    { handler: handlerChoice("frontier-generation", 0.95) },
    thresholds,
    "cheap-generation",
  );
  assert.equal(noUpgrade.band, "confirm");
  assert.equal(noUpgrade.handler, "cheap-generation");
  assert.equal(noUpgrade.correct, true);
});

test("aggregates accuracy, Brier, and ECE over calibration points", () => {
  const perfect = aggregateRouterMetrics([
    { predictedProbability: 1, correct: true },
    { predictedProbability: 0, correct: false },
  ]);
  assert.deepEqual(perfect, { samples: 2, accuracy: 0.5, brier: 0, expectedCalibrationError: 0 });

  const uncertain = aggregateRouterMetrics([
    { predictedProbability: 0.5, correct: true },
    { predictedProbability: 0.5, correct: false },
  ]);
  assert.equal(uncertain.accuracy, 0.5);
  assert.equal(uncertain.brier, 0.25);
  assert.equal(uncertain.expectedCalibrationError, 0);
});

test("fits on development and improves calibration out of sample", () => {
  const underconfident = (id: string, holdout: boolean) => readout({ id, holdout, topSignal: 0.6, correct: true });
  const report = evaluateCalibration([
    underconfident("dev-1", false),
    underconfident("dev-2", false),
    underconfident("holdout-1", true),
    underconfident("holdout-2", true),
  ]);
  assert.equal(report.devSamples, 2);
  assert.equal(report.holdoutSamples, 2);
  assert.ok(report.holdoutCalibrated.brier <= report.holdoutRaw.brier);
  assert.ok(Number.isFinite(report.fitted.a) && Number.isFinite(report.fitted.b));
});

test("proposes a record only for a passing gate", () => {
  const passing: SystemOnePromotionResult = { lane: "cost-router", promoted: true, reasons: [], gates: { minSamples: 30, minAccuracy: 0.95, maxBrier: 0.05, maxExpectedCalibrationError: 0.05 } };
  const failing: SystemOnePromotionResult = { ...passing, promoted: false, reasons: ["x"] };
  const metrics = { samples: 30, accuracy: 1, brier: 0, expectedCalibrationError: 0 };
  assert.equal(proposeRecord(failing, metrics, { a: 1, b: 0 }, "2026-09-17"), null);
  assert.deepEqual(proposeRecord(passing, metrics, { a: 2, b: 1 }, "2026-09-17"), {
    metrics,
    calibration: { a: 2, b: 1 },
    promotedAt: "2026-09-17",
    evidence: "docs/system-one-router-benchmark.md",
  });
});

test("parses repeat and out flags with safe defaults", () => {
  assert.deepEqual(parseRouterArgs([]), { repeats: 3, out: "docs/system-one-router-benchmark.md" });
  assert.deepEqual(parseRouterArgs(["--repeat", "5", "--out", "docs/custom.md"]), { repeats: 5, out: "docs/custom.md" });
  assert.deepEqual(parseRouterArgs(["--repeat=2"]), { repeats: 2, out: "docs/system-one-router-benchmark.md" });
  assert.equal(parseRouterArgs(["--repeat", "0"]).repeats, 1);
  assert.equal(parseRouterArgs(["--repeat", "999"]).repeats, 25);
});
