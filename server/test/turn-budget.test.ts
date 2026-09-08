import { describe, expect, it } from "vitest";
import {
  createTurnBudget,
  estimateTurnTokens,
  reserveTurnBudget,
  settleTurnBudget,
  AdventureTurnBudgetManager,
  type TurnBudgetPolicy,
} from "../src/agent/turnBudget.js";

const policy: TurnBudgetPolicy = {
  maxPromptTokens: 100,
  maxCompletionTokens: 50,
  maxTotalTokens: 120,
  maxEstimatedCostUsd: 0.0002,
  pricing: { promptPerMillionUsd: 1, completionPerMillionUsd: 2 },
  maxConcurrentRequests: 2,
  maxRequestsPerWindow: 2,
  rateWindowMs: 1_000,
};

describe("turn budget", () => {
  it("uses conservative UTF-8 local token estimates", () => {
    expect(estimateTurnTokens("1234567")).toBe(3);
    expect(estimateTurnTokens("é")).toBe(1);
  });

  it("reserves worst-case tokens and settles provider-measured usage", () => {
    const initial = createTurnBudget(policy);
    const reserved = reserveTurnBudget(initial, { id: "one", estimatedPromptTokens: 20, maxCompletionTokens: 30 }, 100);
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) return;
    expect(initial.reservations).toEqual({});
    const settled = settleTurnBudget(reserved.state, "one", { usage: { promptTokens: 18, completionTokens: 7, totalTokens: 25 } });
    expect(settled.accounting).toMatchObject({ promptTokens: 18, completionTokens: 7, totalTokens: 25, providerMeasuredTokens: 25, locallyEstimatedTokens: 0 });
    expect(settled.reservations).toEqual({});
  });

  it("uses reserved prompt and completion maxima when usage is absent", () => {
    const reserved = reserveTurnBudget(createTurnBudget(policy), { id: "one", estimatedPromptTokens: 12, maxCompletionTokens: 20 }, 100);
    if (!reserved.allowed) throw new Error("unexpected denial");
    const settled = settleTurnBudget(reserved.state, "one", {});
    expect(settled.accounting).toMatchObject({ promptTokens: 12, completionTokens: 20, totalTokens: 32, locallyEstimatedTokens: 32 });
  });

  it("denies token and dollar overcommit before dispatch", () => {
    const tokenDenied = reserveTurnBudget(createTurnBudget(policy), { id: "large", estimatedPromptTokens: 90, maxCompletionTokens: 40 }, 0);
    expect(tokenDenied).toMatchObject({ allowed: false, reason: "total-token-budget" });
    const costly = createTurnBudget({ ...policy, maxTotalTokens: 1_000, maxEstimatedCostUsd: 0.00001 });
    expect(reserveTurnBudget(costly, { id: "costly", estimatedPromptTokens: 10, maxCompletionTokens: 10 }, 0))
      .toMatchObject({ allowed: false, reason: "estimated-dollar-budget" });
  });

  it("enforces concurrency and rolling request rate independently", () => {
    const one = reserveTurnBudget(createTurnBudget({ ...policy, maxConcurrentRequests: 1 }),
      { id: "one", estimatedPromptTokens: 1, maxCompletionTokens: 1 }, 100);
    if (!one.allowed) throw new Error("unexpected denial");
    expect(reserveTurnBudget(one.state, { id: "two", estimatedPromptTokens: 1, maxCompletionTokens: 1 }, 200))
      .toMatchObject({ allowed: false, reason: "concurrency" });

    let state = createTurnBudget(policy);
    for (const [id, at] of [["one", 100], ["two", 200]] as const) {
      const reserved = reserveTurnBudget(state, { id, estimatedPromptTokens: 1, maxCompletionTokens: 1 }, at);
      if (!reserved.allowed) throw new Error("unexpected denial");
      state = settleTurnBudget(reserved.state, id, { usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    }
    expect(reserveTurnBudget(state, { id: "three", estimatedPromptTokens: 1, maxCompletionTokens: 1 }, 300))
      .toMatchObject({ allowed: false, reason: "rate-limit", retryAtMs: 1_100 });
    expect(reserveTurnBudget(state, { id: "three", estimatedPromptTokens: 1, maxCompletionTokens: 1 }, 1_101).allowed).toBe(true);
  });

  it("atomically prevents concurrent manager reservations from overcommitting", () => {
    const manager = new AdventureTurnBudgetManager();
    const tight = { ...policy, maxTotalTokens: 20, maxEstimatedCostUsd: null };
    expect(manager.reserve("turn", tight, { id: "one", estimatedPromptTokens: 5, maxCompletionTokens: 10 }, 0).allowed).toBe(true);
    expect(manager.reserve("turn", tight, { id: "two", estimatedPromptTokens: 5, maxCompletionTokens: 10 }, 0))
      .toMatchObject({ allowed: false, reason: "total-token-budget" });
    expect(manager.settle("turn", "one", {}).source).toBe("estimated");
  });

  it("hydrates durable settlements once so restart and replay cannot reset or double charge a turn", () => {
    const manager = new AdventureTurnBudgetManager();
    const tight = { ...policy, maxTotalTokens: 20, maxEstimatedCostUsd: null };
    const durable = [{ promptTokens: 8, completionTokens: 7, totalTokens: 15, source: "estimated" as const, startedAtMs: 1 }];
    manager.initialize("turn", tight, durable);
    manager.initialize("turn", tight, durable);
    expect(manager.reserve("turn", tight, { id: "next", estimatedPromptTokens: 3, maxCompletionTokens: 3 }, 2))
      .toMatchObject({ allowed: false, reason: "total-token-budget" });
  });
});
