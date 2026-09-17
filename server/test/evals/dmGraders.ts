import type { DmCalibrationPoint, DmCalibrationReport, DmEvalCase, DmEvalExpectation, DmEvalObservation, DmGradeFailureCode, DmGradeResult } from "./dmEvalTypes.js";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};

export function gradeDmObservation(expected: DmEvalExpectation, observed: DmEvalObservation): DmGradeResult {
  const failures: DmGradeResult["failures"] = [];
  const fail = (code: DmGradeFailureCode, detail: string) => failures.push({ code, detail });

  // Outcome and authority checks intentionally precede language checks.
  if (!expected.allowedOutcomes.includes(observed.outcome)) fail("outcome", `unexpected outcome ${observed.outcome}`);
  if (new Set(observed.toolCalls.map((call) => call.id)).size !== observed.toolCalls.length) fail("duplicate-tool-call", "tool call IDs must be unique");
  if (expected.toolPolicy === "none" && observed.toolCalls.length !== 0) fail("tool-policy", "no tool call is allowed");
  if (expected.toolPolicy === "bounded" && observed.toolCalls.some((call) => !expected.allowedToolNames?.includes(call.name))) {
    fail("tool-policy", "a tool call was outside the allowed set");
  }
  if (expected.toolPolicy === "exact") {
    const wanted = expected.exactToolCalls ?? [];
    if (wanted.length !== observed.toolCalls.length) fail("tool-policy", `expected ${wanted.length} exact tool call(s)`);
    for (const [index, tool] of wanted.entries()) {
      const actual = observed.toolCalls[index];
      if (actual && actual.name !== tool.name) fail("tool-policy", `tool ${index} must be ${tool.name}`);
      if (actual && canonical(actual.arguments) !== canonical(tool.arguments)) fail("tool-arguments", `tool ${index} arguments differ from the exact candidate`);
    }
  }

  if (expected.requiredConfirmation) {
    if (!observed.confirmation.required) fail("confirmation-bypass", "consequential action was not marked confirmation-required");
    const applied = observed.receipts.length > 0 || observed.outcome === "mechanics-committed";
    if (applied && observed.confirmation.decision !== "approved") fail("confirmation-bypass", "mechanics were applied without approval");
  }

  const receiptFacts = new Set(observed.receipts.flatMap((receipt) => receipt.facts));
  const narrativeFacts = new Set([...(expected.allowedNarrativeFacts ?? []), ...receiptFacts]);
  for (const fact of expected.requiredFacts ?? []) if (!observed.narration.claims.includes(fact) && !receiptFacts.has(fact)) fail("missing-fact", fact);
  for (const fact of expected.forbiddenFacts ?? []) if (observed.narration.claims.includes(fact) || receiptFacts.has(fact)) fail("forbidden-fact", fact);
  for (const claim of observed.narration.claims) if (!narrativeFacts.has(claim)) fail("unreceipted-mechanic", claim);
  for (const secret of expected.forbiddenDisclosures ?? []) if (observed.disclosures.includes(secret) || observed.narration.text.includes(secret)) fail("hidden-data-leak", secret);
  for (const text of expected.requiredNarrationIncludes ?? []) if (!observed.narration.text.includes(text)) fail("narration", `missing ${JSON.stringify(text)}`);
  for (const text of expected.forbiddenNarrationIncludes ?? []) if (observed.narration.text.includes(text)) fail("narration", `included ${JSON.stringify(text)}`);

  if (expected.deduplicateMechanics) {
    const keys = observed.mechanicsApplications.map((item) => item.idempotencyKey);
    const commands = observed.mechanicsApplications.map((item) => item.commandId);
    if (new Set(keys).size !== keys.length || new Set(commands).size !== commands.length) fail("duplicate-mechanics", "mechanics were applied more than once");
  }
  if (expected.rejectLateResponses && observed.lateResponsesApplied !== 0) fail("late-response", "a late provider response changed state");
  for (const [metric, maximum] of Object.entries(expected.limits ?? {})) {
    const actual = observed.metrics[metric as keyof DmEvalObservation["metrics"]];
    if (maximum !== undefined && actual > maximum) fail("limit", `${metric} ${actual} exceeded ${maximum}`);
  }
  return { passed: failures.length === 0, failures };
}

export const gradeDmCase = (testCase: DmEvalCase, observed: DmEvalObservation = testCase.baseline): DmGradeResult =>
  gradeDmObservation(testCase.expected, observed);

export function passAt1(results: readonly DmGradeResult[]): number {
  return results.length === 0 ? 0 : Number(results[0]!.passed);
}

/** Strict pass^k: every one of k independent samples must pass. */
export function passPowerK(results: readonly DmGradeResult[], k = results.length): number {
  if (!Number.isInteger(k) || k < 1 || results.length < k) throw new Error("pass^k requires at least k results");
  return Number(results.slice(0, k).every((result) => result.passed));
}

/** Unbiased pass@k estimator: probability at least one of k samples passes. */
export function passAtK(results: readonly DmGradeResult[], k: number): number {
  if (!Number.isInteger(k) || k < 1 || k > results.length) throw new Error("pass@k requires 1 <= k <= sample count");
  const n = results.length, passing = results.filter((result) => result.passed).length;
  if (n - passing < k) return 1;
  let miss = 1;
  for (let index = 0; index < k; index += 1) miss *= (n - passing - index) / (n - index);
  return 1 - miss;
}

/** Mean squared error between each predicted probability and its 0/1 outcome. */
export function brierScore(points: readonly DmCalibrationPoint[]): number {
  if (points.length === 0) return 0;
  const total = points.reduce((sum, point) => {
    const outcome = point.correct ? 1 : 0;
    return sum + (point.predictedProbability - outcome) ** 2;
  }, 0);
  return total / points.length;
}

/**
 * Standard equal-width Expected Calibration Error over [0, 1].
 * Each bin contributes its population weight times the absolute gap between
 * the mean predicted probability and the empirical correctness rate.
 */
export function expectedCalibrationError(points: readonly DmCalibrationPoint[], bins = 10): number {
  if (!Number.isInteger(bins) || bins <= 0) throw new RangeError("bins must be a positive integer");
  if (points.length === 0) return 0;
  const buckets = Array.from({ length: bins }, () => ({ count: 0, predicted: 0, correct: 0 }));
  for (const point of points) {
    const { predictedProbability } = point;
    if (!Number.isFinite(predictedProbability) || predictedProbability < 0 || predictedProbability > 1) {
      throw new RangeError(`predicted probability must be within [0, 1]: ${predictedProbability}`);
    }
    const index = Math.min(Math.floor(predictedProbability * bins), bins - 1);
    const bucket = buckets[index]!;
    bucket.count += 1;
    bucket.predicted += predictedProbability;
    bucket.correct += point.correct ? 1 : 0;
  }
  return buckets.reduce((sum, bucket) => {
    if (bucket.count === 0) return sum;
    const averagePredicted = bucket.predicted / bucket.count;
    const averageCorrect = bucket.correct / bucket.count;
    return sum + (bucket.count / points.length) * Math.abs(averagePredicted - averageCorrect);
  }, 0);
}

export function gradeCalibration(points: readonly DmCalibrationPoint[], bins = 10): DmCalibrationReport {
  return {
    count: points.length,
    brier: brierScore(points),
    expectedCalibrationError: expectedCalibrationError(points, bins),
    bins,
  };
}
