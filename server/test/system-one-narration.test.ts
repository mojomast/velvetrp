import { describe, expect, it } from "vitest";
import {
  buildNarrationQuestions,
  composeNarrationVerification,
  narrationVerificationState,
  NARRATION_CONTRADICTS_RECEIPT_KEY,
  NARRATION_CROSSES_BOUNDARY_KEY,
  NARRATION_GROUNDEDNESS_KEY,
  NARRATION_GROUNDEDNESS_LEVELS,
  NARRATION_INVENTS_MECHANIC_KEY,
  type NarrationVerificationInput,
} from "../src/agent/systemOneNarration.js";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };

const input: NarrationVerificationInput = {
  narration: "The party surveys the quiet mill while the wheel turns.",
  committedFacts: ["The mill wheel is broken", "Aria holds the brass key"],
  declaredBoundaries: ["Do not depict self-harm"],
};

const hazard = (noul: number): SystemOneAnswer => ({ type: "noul", noul });
const grounded = (score: number): SystemOneAnswer => ({
  type: "score",
  score,
  confidence: 0.9,
  legend: { 0: "ungrounded", 1: "partly grounded", 2: "fully grounded" },
  probabilities: { 0: 0.05, 1: 0.15, 2: 0.8 },
});

describe("System One narration verification battery", () => {
  it("builds one noul per hazard plus a three-level groundedness score", () => {
    const questions = buildNarrationQuestions(input);
    expect(Object.keys(questions)).toEqual([
      NARRATION_CONTRADICTS_RECEIPT_KEY,
      NARRATION_INVENTS_MECHANIC_KEY,
      NARRATION_CROSSES_BOUNDARY_KEY,
      NARRATION_GROUNDEDNESS_KEY,
    ]);
    expect(questions[NARRATION_CONTRADICTS_RECEIPT_KEY]).toMatchObject({ type: "noul" });
    expect(questions[NARRATION_INVENTS_MECHANIC_KEY]).toMatchObject({ type: "noul" });
    expect(questions[NARRATION_CROSSES_BOUNDARY_KEY]).toMatchObject({ type: "noul" });
    expect(questions[NARRATION_GROUNDEDNESS_KEY]).toMatchObject({ type: "score" });
    expect((questions[NARRATION_GROUNDEDNESS_KEY] as { criteria: string[] }).criteria).toEqual([...NARRATION_GROUNDEDNESS_LEVELS]);
  });

  it("embeds committed facts and declared boundaries in the question guidance", () => {
    const questions = buildNarrationQuestions(input);
    const rendered = JSON.stringify(questions);
    expect(rendered).toContain("The mill wheel is broken");
    expect(rendered).toContain("Aria holds the brass key");
    expect(rendered).toContain("Do not depict self-harm");
    expect(rendered).toContain("compatible atmosphere");
  });

  it("acts when nothing is flagged and groundedness is confidently high", () => {
    const answers = {
      [NARRATION_CONTRADICTS_RECEIPT_KEY]: hazard(0.1),
      [NARRATION_INVENTS_MECHANIC_KEY]: hazard(0.05),
      [NARRATION_CROSSES_BOUNDARY_KEY]: hazard(0.05),
      [NARRATION_GROUNDEDNESS_KEY]: grounded(2),
    };
    expect(composeNarrationVerification(answers, thresholds)).toEqual({
      band: "act",
      flags: [],
      groundedness: 1,
      topSignal: 1,
    });
  });

  it("flags a contradiction at the action threshold and keeps the band non-act", () => {
    const answers = {
      [NARRATION_CONTRADICTS_RECEIPT_KEY]: hazard(0.9),
      [NARRATION_GROUNDEDNESS_KEY]: grounded(2),
    };
    const composed = composeNarrationVerification(answers, thresholds);
    expect(composed.flags).toEqual([NARRATION_CONTRADICTS_RECEIPT_KEY]);
    expect(composed.band).not.toBe("act");
    expect(composed.band).toBe("fallback");
  });

  it("flags an invented mechanic and a boundary crossing", () => {
    const invented = composeNarrationVerification({ [NARRATION_INVENTS_MECHANIC_KEY]: hazard(0.8) }, thresholds);
    expect(invented.flags).toEqual([NARRATION_INVENTS_MECHANIC_KEY]);
    expect(invented.band).not.toBe("act");

    const boundary = composeNarrationVerification({ [NARRATION_CROSSES_BOUNDARY_KEY]: hazard(0.99) }, thresholds);
    expect(boundary.flags).toEqual([NARRATION_CROSSES_BOUNDARY_KEY]);
    expect(boundary.band).not.toBe("act");
  });

  it("falls back without throwing on missing or empty answers", () => {
    const empty = () => composeNarrationVerification({}, thresholds);
    expect(empty).not.toThrow();
    expect(empty()).toEqual({ band: "fallback", flags: [], groundedness: null, topSignal: null });

    const partial = composeNarrationVerification({ [NARRATION_CONTRADICTS_RECEIPT_KEY]: { type: "choice", choice: "x", confidence: 0.9, probabilities: { x: 1 } } }, thresholds);
    expect(partial).toEqual({ band: "fallback", flags: [], groundedness: null, topSignal: null });
  });

  it("normalizes groundedness over the declared levels and nulls it when absent", () => {
    expect(composeNarrationVerification({ [NARRATION_GROUNDEDNESS_KEY]: grounded(0) }, thresholds).groundedness).toBe(0);
    expect(composeNarrationVerification({ [NARRATION_GROUNDEDNESS_KEY]: grounded(1) }, thresholds).groundedness).toBe(0.5);
    expect(composeNarrationVerification({ [NARRATION_GROUNDEDNESS_KEY]: grounded(2) }, thresholds).groundedness).toBe(1);
    expect(composeNarrationVerification({ [NARRATION_GROUNDEDNESS_KEY]: grounded(9) }, thresholds).groundedness).toBe(1);
    expect(composeNarrationVerification({}, thresholds).groundedness).toBeNull();
  });

  it("honors the thresholds when banding hazards and groundedness", () => {
    const strict = { actionThreshold: 0.6, reviewThreshold: 0.4 };
    expect(composeNarrationVerification({ [NARRATION_CONTRADICTS_RECEIPT_KEY]: hazard(0.6) }, strict).flags).toEqual([NARRATION_CONTRADICTS_RECEIPT_KEY]);

    const moderateHazard = composeNarrationVerification({ [NARRATION_INVENTS_MECHANIC_KEY]: hazard(0.6) }, thresholds);
    expect(moderateHazard.flags).toEqual([]);
    expect(moderateHazard.band).toBe("confirm");

    const moderateGrounding = composeNarrationVerification({ [NARRATION_GROUNDEDNESS_KEY]: grounded(1) }, thresholds);
    expect(moderateGrounding.band).toBe("confirm");

    expect(composeNarrationVerification({ [NARRATION_GROUNDEDNESS_KEY]: grounded(1) }, strict).band).toBe("confirm");
    expect(composeNarrationVerification({ [NARRATION_GROUNDEDNESS_KEY]: grounded(0) }, strict).band).toBe("fallback");
  });

  it("is pure: identical inputs produce identical outputs and inputs are not mutated", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [NARRATION_CONTRADICTS_RECEIPT_KEY]: hazard(0.2),
      [NARRATION_GROUNDEDNESS_KEY]: grounded(2),
    };
    const before = JSON.parse(JSON.stringify({ input, answers }));

    const firstQuestions = buildNarrationQuestions(input);
    const secondQuestions = buildNarrationQuestions(input);
    expect(firstQuestions).toEqual(secondQuestions);

    const first = composeNarrationVerification(answers, thresholds);
    const second = composeNarrationVerification(answers, thresholds);
    expect(first).toEqual(second);

    const state = narrationVerificationState(input);
    expect(state).toEqual({ narration: input.narration, committed_facts: [...input.committedFacts], declared_boundaries: [...input.declaredBoundaries!] });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);

    expect(JSON.parse(JSON.stringify({ input, answers }))).toEqual(before);
  });

  it("defaults declared boundaries to an empty list in the state projection", () => {
    const state = narrationVerificationState({ narration: "x", committedFacts: ["f"] });
    expect(state.declared_boundaries).toEqual([]);
  });
});
