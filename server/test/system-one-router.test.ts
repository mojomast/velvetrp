import { describe, expect, it } from "vitest";
import {
  buildRouterQuestions,
  composeRouterDecision,
  ROUTER_COMPLEXITY_KEY,
  ROUTER_DETERMINISTIC_KEY,
  ROUTER_HANDLERS,
  ROUTER_HANDLER_KEY,
  ROUTER_NONE,
  type RouterHandler,
  type RouterRequestProjection,
} from "../src/agent/systemOneRouter.js";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };

function request(overrides: Partial<RouterRequestProjection> = {}): RouterRequestProjection {
  return {
    summary: "Summarize the scene",
    hasDeterministicPath: false,
    requiresHumanDecision: false,
    safetySensitive: false,
    ...overrides,
  };
}

function handlerChoice(choice: string, top: number): SystemOneAnswer {
  const rest = Math.max(0, 1 - top);
  return {
    type: "choice",
    choice,
    confidence: top,
    probabilities: { [choice]: top, [ROUTER_NONE]: rest },
  };
}

const deterministic = (noul: number): SystemOneAnswer => ({ type: "noul", noul });
const complexity = (score: number): SystemOneAnswer => ({
  type: "score",
  score,
  confidence: 0.8,
  legend: { 0: "simple", 1: "moderate", 2: "complex" },
  probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
});

describe("System One cost router", () => {
  it("builds a handler choice, a three-level complexity score, and a deterministic noul", () => {
    const questions = buildRouterQuestions(request({ summary: "Summarize the scene" }));
    expect(Object.keys(questions)).toEqual([ROUTER_HANDLER_KEY, ROUTER_COMPLEXITY_KEY, ROUTER_DETERMINISTIC_KEY]);
    expect(questions[ROUTER_HANDLER_KEY]).toMatchObject({ type: "choice" });
    expect(questions[ROUTER_COMPLEXITY_KEY]).toMatchObject({ type: "score" });
    expect(questions[ROUTER_DETERMINISTIC_KEY]).toMatchObject({ type: "noul" });

    const handlerQuestion = questions[ROUTER_HANDLER_KEY]!;
    if (handlerQuestion.type !== "choice") throw new Error("expected a choice question");
    expect(Object.keys(handlerQuestion.criteria)).toEqual([...ROUTER_HANDLERS, ROUTER_NONE]);

    const complexityQuestion = questions[ROUTER_COMPLEXITY_KEY]!;
    if (complexityQuestion.type !== "score") throw new Error("expected a score question");
    expect(complexityQuestion.criteria).toHaveLength(3);

    expect(JSON.stringify(questions[ROUTER_HANDLER_KEY])).toContain("Summarize the scene");
  });

  it("always routes a safety-sensitive request to human review regardless of other answers", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [ROUTER_HANDLER_KEY]: handlerChoice("cheap-generation", 0.99),
      [ROUTER_DETERMINISTIC_KEY]: deterministic(0.99),
      [ROUTER_COMPLEXITY_KEY]: complexity(0),
    };
    const decision = composeRouterDecision(request({ safetySensitive: true }), answers, thresholds, "frontier-generation");
    expect(decision.handler).toBe("human-review");
    expect(decision.band).toBe("confirm");
    expect(decision.deterministicSufficient).toBe(true);
  });

  it("acts on human review only when that choice is confident, and still never routes away", () => {
    const confident: Record<string, SystemOneAnswer> = { [ROUTER_HANDLER_KEY]: handlerChoice("human-review", 0.9) };
    expect(composeRouterDecision(request({ requiresHumanDecision: true }), confident, thresholds, "cheap-generation")).toMatchObject({
      band: "act",
      handler: "human-review",
    });

    const unconfident: Record<string, SystemOneAnswer> = { [ROUTER_HANDLER_KEY]: handlerChoice("human-review", 0.6) };
    expect(composeRouterDecision(request({ requiresHumanDecision: true }), unconfident, thresholds, "cheap-generation")).toMatchObject({
      band: "confirm",
      handler: "human-review",
    });

    expect(composeRouterDecision(request({ safetySensitive: true }), {}, thresholds, "deterministic")).toMatchObject({
      band: "confirm",
      handler: "human-review",
    });
  });

  it("acts on a confident cheap-generation selection that is cheaper than the current handler", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [ROUTER_HANDLER_KEY]: handlerChoice("cheap-generation", 0.9),
      [ROUTER_DETERMINISTIC_KEY]: deterministic(0.2),
      [ROUTER_COMPLEXITY_KEY]: complexity(1),
    };
    expect(composeRouterDecision(request(), answers, thresholds, "frontier-generation")).toEqual({
      band: "act",
      handler: "cheap-generation",
      complexity: 1,
      deterministicSufficient: false,
      topSignal: 0.9,
      reason: "confident handler choice: cheap-generation",
    });
  });

  it("falls back to the current handler when confidence is low", () => {
    const confirm: Record<string, SystemOneAnswer> = { [ROUTER_HANDLER_KEY]: handlerChoice("cheap-generation", 0.6) };
    expect(composeRouterDecision(request(), confirm, thresholds, "frontier-generation")).toMatchObject({
      band: "confirm",
      handler: "frontier-generation",
    });

    const fallback: Record<string, SystemOneAnswer> = { [ROUTER_HANDLER_KEY]: handlerChoice("cheap-generation", 0.2) };
    expect(composeRouterDecision(request(), fallback, thresholds, "frontier-generation")).toMatchObject({
      band: "fallback",
      handler: "frontier-generation",
    });
  });

  it("selects deterministic when deterministic_sufficient is confidently true", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [ROUTER_HANDLER_KEY]: handlerChoice("frontier-generation", 0.99),
      [ROUTER_DETERMINISTIC_KEY]: deterministic(0.9),
    };
    expect(composeRouterDecision(request({ hasDeterministicPath: true }), answers, thresholds, "frontier-generation")).toMatchObject({
      band: "act",
      handler: "deterministic",
      deterministicSufficient: true,
    });

    // A confident deterministic answer without a real deterministic path cannot act on it.
    const deterministicOnly: Record<string, SystemOneAnswer> = { [ROUTER_DETERMINISTIC_KEY]: deterministic(0.9) };
    expect(composeRouterDecision(request({ hasDeterministicPath: false }), deterministicOnly, thresholds, "frontier-generation")).toMatchObject({
      handler: "frontier-generation",
    });
  });

  it("never upgrades to a more capable handler", () => {
    const answers: Record<string, SystemOneAnswer> = { [ROUTER_HANDLER_KEY]: handlerChoice("frontier-generation", 0.95) };
    expect(composeRouterDecision(request(), answers, thresholds, "cheap-generation")).toMatchObject({
      band: "confirm",
      handler: "cheap-generation",
    });

    const deterministicCurrent: Record<string, SystemOneAnswer> = { [ROUTER_HANDLER_KEY]: handlerChoice("cheap-generation", 0.95) };
    expect(composeRouterDecision(request(), deterministicCurrent, thresholds, "deterministic")).toMatchObject({
      band: "confirm",
      handler: "deterministic",
    });
  });

  it("returns the status quo without throwing on missing or partial answers", () => {
    expect(() => composeRouterDecision(request(), {}, thresholds, "cheap-generation")).not.toThrow();
    expect(composeRouterDecision(request(), {}, thresholds, "cheap-generation")).toMatchObject({
      band: "fallback",
      handler: "cheap-generation",
      complexity: null,
      deterministicSufficient: null,
      topSignal: null,
    });

    const partial: Record<string, SystemOneAnswer> = { [ROUTER_COMPLEXITY_KEY]: complexity(2) };
    expect(composeRouterDecision(request(), partial, thresholds, "cheap-generation")).toMatchObject({
      band: "fallback",
      handler: "cheap-generation",
      complexity: 2,
      deterministicSufficient: null,
    });

    const wrongType: Record<string, SystemOneAnswer> = { [ROUTER_HANDLER_KEY]: deterministic(0.9) };
    expect(composeRouterDecision(request(), wrongType, thresholds, "cheap-generation")).toMatchObject({
      band: "fallback",
      handler: "cheap-generation",
    });
  });

  it("only ever returns the chosen handler or the current handler for non-safety requests", () => {
    const cases: Array<{ current: RouterHandler; answer: SystemOneAnswer }> = [
      { current: "frontier-generation", answer: handlerChoice("cheap-generation", 0.9) },
      { current: "frontier-generation", answer: handlerChoice("cheap-generation", 0.4) },
      { current: "frontier-generation", answer: handlerChoice("deterministic", 0.95) },
      { current: "cheap-generation", answer: handlerChoice("frontier-generation", 0.95) },
      { current: "deterministic", answer: handlerChoice("human-review", 0.95) },
      { current: "cheap-generation", answer: handlerChoice(ROUTER_NONE, 0.95) },
    ];
    for (const { current, answer } of cases) {
      const decision = composeRouterDecision(request(), { [ROUTER_HANDLER_KEY]: answer }, thresholds, current);
      const chosen = answer.type === "choice" ? answer.choice : null;
      expect([chosen, current]).toContain(decision.handler);
    }
  });

  it("is pure: the same inputs always produce the same decision", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [ROUTER_HANDLER_KEY]: handlerChoice("cheap-generation", 0.9),
      [ROUTER_DETERMINISTIC_KEY]: deterministic(0.3),
      [ROUTER_COMPLEXITY_KEY]: complexity(1),
    };
    const input = request({ summary: "route me" });
    const first = composeRouterDecision(input, answers, thresholds, "frontier-generation");
    const second = composeRouterDecision(input, answers, thresholds, "frontier-generation");
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
  });
});
