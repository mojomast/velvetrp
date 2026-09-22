import { describe, expect, it } from "vitest";
import { SystemOneLaneBudgetManager } from "../src/agent/systemOneBudget.js";
import { validateSystemOneAnswers } from "../src/provider/systemOneCompletion.js";

const policy = { maxTotalTokens: 10000, maxEstimatedCostUsd: 250, maxRequestsPerWindow: 100, rateWindowMs: 1000 };
const request = { estimatedInputTokens: 100, maxOutputTokens: 0, pricing: { inputPerMillionUsd: 1000000, outputPerMillionUsd: 1000000 }, nowMs: 0 };
function reserve(manager: SystemOneLaneBudgetManager, input = request) {
  const result = manager.reserve("jev", policy, input);
  if (!result.allowed) throw new Error(result.reason);
  return result.reservationId;
}

describe("Jev concurrent budget boundaries", () => {
  it("includes all outstanding dollar reservations and settles out of order", () => {
    const manager = new SystemOneLaneBudgetManager();
    const first = reserve(manager);
    const second = reserve(manager, { ...request, pricing: { inputPerMillionUsd: 500000, outputPerMillionUsd: 1000000 } });
    expect(manager.reserve("jev", policy, { ...request, estimatedInputTokens: 101 })).toEqual({ allowed: false, reason: "dollar-budget" });
    expect(() => manager.settle("jev", { inputTokens: 1, outputTokens: 0 })).toThrow(/reservationId/);
    expect(() => manager.release("jev")).toThrow(/reservationId/);
    manager.settle("jev", { inputTokens: 80, outputTokens: 0 }, second);
    expect(manager.snapshot("jev")).toMatchObject({ reservedInputTokens: 100, costUsd: 40 });
    manager.settle("jev", { inputTokens: 90, outputTokens: 0 }, first);
    expect(manager.snapshot("jev")).toMatchObject({ reservedInputTokens: 0, settledInputTokens: 170, costUsd: 130 });
    expect(() => manager.settle("jev", { inputTokens: 1, outputTokens: 0 }, second)).toThrow();
  });
  it("releases only the specified call, even after settlement or reset", () => {
    const manager = new SystemOneLaneBudgetManager();
    const first = reserve(manager);
    const second = reserve(manager);
    manager.release("jev", first);
    manager.release("jev", first);
    expect(manager.snapshot("jev").reservedInputTokens).toBe(100);
    manager.reset("jev");
    const third = reserve(manager);
    expect(third).not.toBe(second);
    manager.release("jev", second);
    expect(manager.snapshot("jev").reservedInputTokens).toBe(100);
    manager.release("jev", third);
    expect(manager.snapshot("jev").reservedInputTokens).toBe(0);
  });
  it("prunes expired request starts without releasing outstanding reservations", () => {
    const manager = new SystemOneLaneBudgetManager();
    reserve(manager);
    reserve(manager, { ...request, nowMs: 2000 });
    expect(manager.snapshot("jev")).toMatchObject({ requestStartsMs: [2000], reservedInputTokens: 200 });
  });
});

describe("Jev score validation", () => {
  const questions = { relevance: { type: "score" as const, instructions: "Rate relevance", criteria: ["irrelevant", "relevant"] } };
  function validate(score: number, probabilities = { "0": 0.25, "1": 0.75 }) {
    validateSystemOneAnswers(questions, { relevance: { type: "score", score, confidence: 0.9, probabilities, legend: {} } });
  }
  it.each([-1, 999, 0.2, NaN, Infinity])("rejects invalid score %s", (score) => {
    expect(() => validate(score)).toThrow(/score/);
  });
  it("accepts fractional expectations, endpoints and rounded distributions", () => {
    expect(() => validate(0.75)).not.toThrow();
    expect(() => validate(0, { "0": 1, "1": 0 })).not.toThrow();
    expect(() => validate(1, { "0": 0, "1": 1 })).not.toThrow();
    expect(() => validate(0.75, { "0": 0.25001, "1": 0.74999 })).not.toThrow();
  });
});
