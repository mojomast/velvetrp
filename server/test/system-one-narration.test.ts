import { describe, expect, it } from "vitest";
import {
  buildNarrationQuestions,
  composeNarrationVerification,
  narrationContradictionKey,
  narrationReflectionKey,
  narrationVerificationState,
  NARRATION_CONTRADICTS_RECEIPT_KEY,
  NARRATION_CROSSES_BOUNDARY_KEY,
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

const cleanAnswers = (): Record<string, SystemOneAnswer> => ({
  [NARRATION_INVENTS_MECHANIC_KEY]: hazard(0.05),
  [NARRATION_CROSSES_BOUNDARY_KEY]: hazard(0.05),
  [narrationReflectionKey(0)]: hazard(0.9),
  [narrationReflectionKey(1)]: hazard(0.9),
  [narrationContradictionKey(0)]: hazard(0.05),
  [narrationContradictionKey(1)]: hazard(0.05),
});

describe("System One narration verification battery", () => {
  it("builds one coverage and one contradiction noul per fact plus the aggregate hazards", () => {
    const questions = buildNarrationQuestions(input);
    expect(Object.keys(questions)).toEqual([
      NARRATION_INVENTS_MECHANIC_KEY,
      NARRATION_CROSSES_BOUNDARY_KEY,
      narrationReflectionKey(0),
      narrationContradictionKey(0),
      narrationReflectionKey(1),
      narrationContradictionKey(1),
    ]);
    for (const question of Object.values(questions)) expect(question).toMatchObject({ type: "noul" });
  });

  it("embeds committed facts and declared boundaries in the question guidance", () => {
    const questions = buildNarrationQuestions(input);
    const rendered = JSON.stringify(questions);
    expect(rendered).toContain("The mill wheel is broken");
    expect(rendered).toContain("Aria holds the brass key");
    expect(rendered).toContain("Do not depict self-harm");
    expect(rendered).toContain("merely omits");
  });

  it("acts when every fact is reflected and nothing is flagged", () => {
    expect(composeNarrationVerification(cleanAnswers(), thresholds)).toEqual({
      band: "act",
      flags: [],
      groundedness: 1,
      topSignal: 0.9,
    });
  });

  it("flags a per-fact contradiction at the action threshold and keeps the band non-act", () => {
    const answers = {
      [narrationReflectionKey(0)]: hazard(0.05),
      [narrationReflectionKey(1)]: hazard(0.9),
      [narrationContradictionKey(0)]: hazard(0.9),
      [narrationContradictionKey(1)]: hazard(0.05),
    };
    const composed = composeNarrationVerification(answers, thresholds, { factCount: 2 });
    expect(composed.flags).toEqual([NARRATION_CONTRADICTS_RECEIPT_KEY]);
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

    const partial = composeNarrationVerification({ [NARRATION_INVENTS_MECHANIC_KEY]: { type: "choice", choice: "x", confidence: 0.9, probabilities: { x: 1 } } }, thresholds);
    expect(partial).toEqual({ band: "fallback", flags: [], groundedness: null, topSignal: null });
  });

  it("computes coverage from the per-fact reflection nouls", () => {
    const partly = composeNarrationVerification({
      [narrationReflectionKey(0)]: hazard(0.9),
      [narrationReflectionKey(1)]: hazard(0.1),
    }, thresholds, { factCount: 2 });
    expect(partly.groundedness).toBe(0.5);
    expect(partly.band).toBe("confirm");

    const ungrounded = composeNarrationVerification({
      [narrationReflectionKey(0)]: hazard(0.1),
      [narrationReflectionKey(1)]: hazard(0.1),
    }, thresholds, { factCount: 2 });
    expect(ungrounded.groundedness).toBe(0);
    expect(ungrounded.band).toBe("fallback");

    // A missing reflection answer for a declared fact counts against coverage.
    const missing = composeNarrationVerification({ [narrationReflectionKey(0)]: hazard(0.9) }, thresholds, { factCount: 2 });
    expect(missing.groundedness).toBe(0.5);

    const inferred = composeNarrationVerification({ [narrationReflectionKey(0)]: hazard(0.9) }, thresholds);
    expect(inferred.groundedness).toBe(1);
    expect(inferred.band).toBe("act");

    expect(composeNarrationVerification({}, thresholds).groundedness).toBeNull();
    expect(composeNarrationVerification({ [NARRATION_INVENTS_MECHANIC_KEY]: hazard(0.05) }, thresholds).groundedness).toBeNull();
  });

  it("honors the thresholds when banding hazards and coverage", () => {
    const strict = { actionThreshold: 0.6, reviewThreshold: 0.4 };
    expect(composeNarrationVerification({ [narrationContradictionKey(0)]: hazard(0.6) }, strict).flags).toEqual([NARRATION_CONTRADICTS_RECEIPT_KEY]);

    const moderateHazard = composeNarrationVerification({ [NARRATION_INVENTS_MECHANIC_KEY]: hazard(0.6) }, thresholds);
    expect(moderateHazard.flags).toEqual([]);
    expect(moderateHazard.band).toBe("confirm");

    const moderateCoverage = composeNarrationVerification({
      [narrationReflectionKey(0)]: hazard(0.9),
      [narrationReflectionKey(1)]: hazard(0.1),
    }, thresholds);
    expect(moderateCoverage.band).toBe("confirm");
  });

  it("is pure: identical inputs produce identical outputs and inputs are not mutated", () => {
    const answers = cleanAnswers();
    const before = JSON.parse(JSON.stringify({ input, answers }));

    expect(buildNarrationQuestions(input)).toEqual(buildNarrationQuestions(input));

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
