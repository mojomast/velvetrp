import { describe, expect, it } from "vitest";
import {
  bandForConfidence,
  bandSystemOneAnswer,
  combineSystemOneBands,
  systemOneSignal,
} from "../src/agent/systemOnePolicy.js";
import type { SystemOneAnswer, SystemOneQuestion } from "../src/provider/systemOneCompletion.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };

describe("System One confidence policy", () => {
  it("bands confidence at the configured boundaries", () => {
    expect(bandForConfidence(0.75, thresholds)).toBe("act");
    expect(bandForConfidence(0.9, thresholds)).toBe("act");
    expect(bandForConfidence(0.5, thresholds)).toBe("confirm");
    expect(bandForConfidence(0.74, thresholds)).toBe("confirm");
    expect(bandForConfidence(0.49, thresholds)).toBe("fallback");
    expect(bandForConfidence(0, thresholds)).toBe("fallback");
  });

  it("rejects invalid or inverted thresholds", () => {
    expect(() => bandForConfidence(0.5, { actionThreshold: 0.4, reviewThreshold: 0.6 })).toThrow(RangeError);
    expect(() => bandForConfidence(0.5, { actionThreshold: 1.2, reviewThreshold: 0.5 })).toThrow(RangeError);
    expect(() => bandForConfidence(Number.NaN, thresholds)).toThrow(RangeError);
  });

  it("uses the noul probability and the confidence field otherwise", () => {
    const noul: SystemOneQuestion = { type: "noul", instructions: "yes?" };
    expect(systemOneSignal(noul, { type: "noul", noul: 0.33 })).toBe(0.33);
    const choice: SystemOneQuestion = { type: "choice", instructions: "pick", criteria: { a: null } };
    expect(systemOneSignal(choice, { type: "choice", choice: "a", confidence: 0.61, probabilities: { a: 1 } })).toBe(0.61);
    const score: SystemOneQuestion = { type: "score", instructions: "rate", criteria: ["low", "high"] };
    expect(systemOneSignal(score, { type: "score", score: 1, confidence: 0.8, legend: {}, probabilities: { 0: 0.2, 1: 0.8 } })).toBe(0.8);
    expect(() => systemOneSignal(choice, { type: "noul", noul: 0.5 } as SystemOneAnswer)).toThrow(RangeError);
  });

  it("bands one answer with its signal and thresholds", () => {
    const question: SystemOneQuestion = { type: "noul", instructions: "hold?" };
    const decision = bandSystemOneAnswer(question, { type: "noul", noul: 0.2 }, thresholds);
    expect(decision).toEqual({ band: "fallback", signal: 0.2, thresholds });
  });

  it("combines bands conservatively", () => {
    expect(combineSystemOneBands(["act", "act"])).toBe("act");
    expect(combineSystemOneBands(["act", "confirm"])).toBe("confirm");
    expect(combineSystemOneBands(["act", "fallback", "confirm"])).toBe("fallback");
    expect(() => combineSystemOneBands([])).toThrow(RangeError);
  });
});
