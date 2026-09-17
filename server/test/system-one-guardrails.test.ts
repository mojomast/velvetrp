import { describe, expect, it } from "vitest";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";
import {
  GUARDRAIL_HAZARDS,
  GUARDRAIL_SEVERITY_KEY,
  buildGuardrailQuestions,
  composeGuardrailDecision,
} from "../src/agent/systemOneGuardrails.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };
const noul = (value: number): SystemOneAnswer => ({ type: "noul", noul: value });
const severity = (level: number): SystemOneAnswer => ({ type: "score", score: level, confidence: 0.9, legend: {}, probabilities: {} });

const benign = (overrides: Partial<Record<string, SystemOneAnswer>> = {}): Record<string, SystemOneAnswer> => ({
  override_attempt: noul(0.02),
  boundary_crossing: noul(0.02),
  disclosure_request: noul(0.02),
  self_harm_signal: noul(0.01),
  [GUARDRAIL_SEVERITY_KEY]: severity(0),
  ...overrides,
});

describe("buildGuardrailQuestions", () => {
  it("asks one noul per hazard plus a severity score", () => {
    const questions = buildGuardrailQuestions({ message: "I draw my sword and greet the innkeeper." });
    expect(Object.keys(questions)).toEqual([...GUARDRAIL_HAZARDS, GUARDRAIL_SEVERITY_KEY]);
    for (const hazard of GUARDRAIL_HAZARDS) {
      expect(questions[hazard]?.type).toBe("noul");
      expect(String((questions[hazard] as { instructions: unknown }).instructions)).toContain("I draw my sword");
    }
    expect(questions[GUARDRAIL_SEVERITY_KEY]?.type).toBe("score");
  });

  it("embeds declared boundaries and tolerates empty or oversized messages", () => {
    const questions = buildGuardrailQuestions({
      message: "x".repeat(9_000),
      declaredBoundaries: ["Do not depict graphic torture", "  ", "No sexual content"],
    });
    const boundary = String((questions.boundary_crossing as { instructions: unknown }).instructions);
    expect(boundary).toContain("Do not depict graphic torture");
    expect(boundary).toContain("No sexual content");
    expect(boundary.length).toBeLessThan(9_000);
    expect(() => buildGuardrailQuestions({ message: "   " })).not.toThrow();
    const emptyQuestions = buildGuardrailQuestions({ message: "   " });
    const empty = String((emptyQuestions.self_harm_signal as { instructions: unknown }).instructions);
    expect(empty).toContain("(empty message)");
  });
});

describe("composeGuardrailDecision", () => {
  it("passes a benign message and defers to the deterministic checks", () => {
    const composition = composeGuardrailDecision(benign(), thresholds);
    expect(composition.band).toBe("fallback");
    expect(composition.disposition).toBe("pass");
    expect(composition.hazards).toEqual([]);
    expect(composition.topSignal).toBeGreaterThan(0);
    expect(composition.severity).toBe(0);
  });

  it("recommends a block only at the action threshold", () => {
    const strong = composeGuardrailDecision(benign({ boundary_crossing: noul(0.9) }), thresholds);
    expect(strong.band).toBe("act");
    expect(strong.disposition).toBe("block");
    expect(strong.hazards).toEqual(["boundary_crossing"]);
    expect(strong.topSignal).toBe(0.9);

    const borderline = composeGuardrailDecision(benign({ boundary_crossing: noul(0.7) }), thresholds);
    expect(borderline.band).toBe("confirm");
    expect(borderline.disposition).toBe("review");
  });

  it("routes a self-harm signal to support and outranks a simultaneous block", () => {
    const composition = composeGuardrailDecision(benign({ self_harm_signal: noul(0.9), boundary_crossing: noul(0.95) }), thresholds);
    expect(composition.disposition).toBe("support");
    expect(composition.band).toBe("act");
    expect(composition.topSignal).toBe(0.9);

    const weaker = composeGuardrailDecision(benign({ self_harm_signal: noul(0.6) }), thresholds);
    expect(weaker.disposition).toBe("support");
    expect(weaker.band).toBe("confirm");
  });

  it("escalates a severe score to review when no hazard clears the review threshold", () => {
    const severe = composeGuardrailDecision(benign({ [GUARDRAIL_SEVERITY_KEY]: severity(3) }), thresholds);
    expect(severe.disposition).toBe("review");
    expect(severe.band).toBe("confirm");
    expect(severe.topSignal).toBe(1);

    const moderate = composeGuardrailDecision(benign({ [GUARDRAIL_SEVERITY_KEY]: severity(2) }), thresholds);
    expect(moderate.disposition).toBe("pass");
    expect(moderate.band).toBe("fallback");
  });

  it("never throws on missing or malformed answers", () => {
    expect(() => composeGuardrailDecision({}, thresholds)).not.toThrow();
    const empty = composeGuardrailDecision({}, thresholds);
    expect(empty).toEqual({ band: "fallback", disposition: "pass", hazards: [], signals: {}, topSignal: null, severity: null });
    const composition = composeGuardrailDecision({ boundary_crossing: { type: "choice", choice: "x", confidence: 0.9, probabilities: {} } }, thresholds);
    expect(composition.disposition).toBe("pass");
    expect(composition.band).toBe("fallback");
    expect(composition.topSignal).toBeNull();
    expect(composition.severity).toBeNull();
  });
});
