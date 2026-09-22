import { describe, expect, it } from "vitest";
import {
  SystemOneLaneBudgetManager,
  type SystemOneBudgetPolicy,
  type SystemOneBudgetPricing,
  type SystemOneBudgetReservationRequest,
} from "../src/agent/systemOneBudget.js";

const policy: SystemOneBudgetPolicy = {
  maxTotalTokens: 1_000,
  maxEstimatedCostUsd: 1,
  maxRequestsPerWindow: 2,
  rateWindowMs: 1_000,
};

const pricing: SystemOneBudgetPricing = { inputPerMillionUsd: 1, outputPerMillionUsd: 2 };

function request(overrides: Partial<SystemOneBudgetReservationRequest> = {}): SystemOneBudgetReservationRequest {
  return { estimatedInputTokens: 100, maxOutputTokens: 50, pricing, nowMs: 0, ...overrides };
}

describe("system one lane budget", () => {
  it("allows a reservation then settles against actual usage and cost", () => {
    const budgets = new SystemOneLaneBudgetManager();
    expect(budgets.reserve("jev", policy, request())).toEqual({ allowed: true, reservationId: expect.any(Number) });
    expect(budgets.snapshot("jev")).toMatchObject({
      reservedInputTokens: 100,
      reservedOutputTokens: 50,
      settledInputTokens: 0,
      settledOutputTokens: 0,
      costUsd: 0,
    });
    budgets.settle("jev", { inputTokens: 80, outputTokens: 20 });
    expect(budgets.snapshot("jev")).toMatchObject({
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      settledInputTokens: 80,
      settledOutputTokens: 20,
      costUsd: (80 * 1 + 20 * 2) / 1_000_000,
    });
  });

  it("denies when the token budget would be exceeded", () => {
    const budgets = new SystemOneLaneBudgetManager();
    const tight: SystemOneBudgetPolicy = { ...policy, maxTotalTokens: 100 };
    expect(budgets.reserve("jev", tight, request({ estimatedInputTokens: 60, maxOutputTokens: 50 })))
      .toEqual({ allowed: false, reason: "token-budget" });
  });

  it("counts settled and reserved tokens when checking the token budget", () => {
    const budgets = new SystemOneLaneBudgetManager();
    const tight: SystemOneBudgetPolicy = { ...policy, maxTotalTokens: 200 };
    expect(budgets.reserve("jev", tight, request({ estimatedInputTokens: 60, maxOutputTokens: 50 }))).toEqual({ allowed: true, reservationId: expect.any(Number) });
    budgets.settle("jev", { inputTokens: 110, outputTokens: 50 });
    expect(budgets.reserve("jev", tight, request({ estimatedInputTokens: 30, maxOutputTokens: 20 })))
      .toEqual({ allowed: false, reason: "token-budget" });
  });

  it("denies when the dollar budget would be exceeded", () => {
    const budgets = new SystemOneLaneBudgetManager();
    const expensive: SystemOneBudgetPolicy = { ...policy, maxEstimatedCostUsd: 100 };
    const expensivePricing: SystemOneBudgetPricing = { inputPerMillionUsd: 1_000_000, outputPerMillionUsd: 1_000_000 };
    expect(budgets.reserve("jev", expensive, request({ pricing: expensivePricing, estimatedInputTokens: 100, maxOutputTokens: 50 })))
      .toEqual({ allowed: false, reason: "dollar-budget" });
  });

  it("rate-limits within the window and allows again once the window passes", () => {
    const budgets = new SystemOneLaneBudgetManager();
    expect(budgets.reserve("jev", policy, request({ nowMs: 0 }))).toEqual({ allowed: true, reservationId: expect.any(Number) });
    expect(budgets.reserve("jev", policy, request({ nowMs: 100 }))).toEqual({ allowed: true, reservationId: expect.any(Number) });
    expect(budgets.reserve("jev", policy, request({ nowMs: 200 }))).toEqual({ allowed: false, reason: "rate-limit" });
    expect(budgets.reserve("jev", policy, request({ nowMs: 1101 }))).toEqual({ allowed: true, reservationId: expect.any(Number) });
  });

  it("release removes the reservation without settling", () => {
    const budgets = new SystemOneLaneBudgetManager();
    budgets.reserve("jev", policy, request({ nowMs: 42 }));
    budgets.release("jev");
    expect(budgets.snapshot("jev")).toMatchObject({
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      settledInputTokens: 0,
      settledOutputTokens: 0,
      costUsd: 0,
      requestStartsMs: [42],
    });
    expect(() => budgets.settle("jev", { inputTokens: 1, outputTokens: 1 })).toThrow(Error);
    budgets.release("jev");
    expect(budgets.snapshot("jev").requestStartsMs).toEqual([42]);
  });

  it("does not mutate state on a denied reservation", () => {
    const budgets = new SystemOneLaneBudgetManager();
    const tight: SystemOneBudgetPolicy = { ...policy, maxEstimatedCostUsd: 0 };
    expect(budgets.reserve("jev", tight, request()))
      .toEqual({ allowed: false, reason: "dollar-budget" });
    expect(budgets.snapshot("jev")).toMatchObject({
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      settledInputTokens: 0,
      settledOutputTokens: 0,
      costUsd: 0,
      requestStartsMs: [],
    });
  });

  it("resets one lane or all lanes", () => {
    const budgets = new SystemOneLaneBudgetManager();
    budgets.reserve("a", policy, request({ nowMs: 0 }));
    budgets.reserve("b", policy, request({ nowMs: 0 }));
    budgets.reset("a");
    expect(budgets.snapshot("a").reservedInputTokens).toBe(0);
    expect(budgets.snapshot("b").reservedInputTokens).toBe(100);
    budgets.reset();
    expect(budgets.snapshot("b").reservedInputTokens).toBe(0);
  });

  it("returns zeros for an unknown lane", () => {
    const budgets = new SystemOneLaneBudgetManager();
    expect(budgets.snapshot("missing")).toEqual({
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      settledInputTokens: 0,
      settledOutputTokens: 0,
      costUsd: 0,
      requestStartsMs: [],
    });
  });

  it("throws RangeError on invalid policy and request values", () => {
    const budgets = new SystemOneLaneBudgetManager();
    expect(() => budgets.reserve("jev", { ...policy, maxTotalTokens: 0 }, request())).toThrow(RangeError);
    expect(() => budgets.reserve("jev", { ...policy, maxRequestsPerWindow: 0 }, request())).toThrow(RangeError);
    expect(() => budgets.reserve("jev", { ...policy, rateWindowMs: 0 }, request())).toThrow(RangeError);
    expect(() => budgets.reserve("jev", { ...policy, maxEstimatedCostUsd: -1 }, request())).toThrow(RangeError);
    expect(() => budgets.reserve("jev", policy, request({ estimatedInputTokens: -1 }))).toThrow(RangeError);
    expect(() => budgets.reserve("jev", policy, request({ maxOutputTokens: 1.5 }))).toThrow(RangeError);
    expect(() => budgets.reserve("jev", policy, request({ pricing: { inputPerMillionUsd: -1, outputPerMillionUsd: 2 } }))).toThrow(RangeError);
    expect(() => budgets.reserve("jev", policy, request({ nowMs: Number.NaN }))).toThrow(RangeError);
  });

  it("throws when settling without an outstanding reservation", () => {
    const budgets = new SystemOneLaneBudgetManager();
    expect(() => budgets.settle("jev", { inputTokens: 1, outputTokens: 1 })).toThrow(Error);
  });
});
