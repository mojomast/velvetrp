import { describe, expect, it } from "vitest";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";
import {
  ADVENTURE_BEST_KEY,
  ADVENTURE_NONE,
  ADVENTURE_RELEVANCE_PREFIX,
  ADVENTURE_SUPPORTED_KEY,
  adventureCandidateRelevance,
  buildAdventureSelectionQuestions,
  composeAdventureSelection,
  type AdventureSelectionCandidate,
} from "../src/agent/systemOneAdventure.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };
const candidates: AdventureSelectionCandidate[] = [
  { candidateId: "travel:mill", digest: "a".repeat(64), kind: "exact_actor_travel.select", label: "Travel to the mill" },
  { candidateId: "check:climb", digest: "b".repeat(64), kind: "exact_srd_check.select", label: "Climb the mill wall" },
];

const noul = (value: number): SystemOneAnswer => ({ type: "noul", noul: value });
const choice = (value: string, top: number): SystemOneAnswer => ({
  type: "choice",
  choice: value,
  confidence: top,
  probabilities: { [value]: top, [ADVENTURE_NONE]: Math.max(0, 1 - top) },
});

describe("buildAdventureSelectionQuestions", () => {
  it("builds one support noul, one relevance score per candidate, and a fail-closed aggregate choice", () => {
    const questions = buildAdventureSelectionQuestions("I head to the mill.", candidates);
    expect(questions[ADVENTURE_SUPPORTED_KEY]?.type).toBe("noul");
    expect(questions[`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]?.type).toBe("score");
    expect(questions[`${ADVENTURE_RELEVANCE_PREFIX}check:climb`]?.type).toBe("score");
    expect(questions[ADVENTURE_BEST_KEY]?.type).toBe("choice");
    const aggregate = questions[ADVENTURE_BEST_KEY];
    if (aggregate?.type !== "choice") throw new Error("aggregate must be a choice");
    expect(Object.keys(aggregate.criteria)).toEqual(["travel:mill", "check:climb", ADVENTURE_NONE]);
    expect(aggregate.criteria[ADVENTURE_NONE]).toBeTruthy();
    expect(aggregate.instructions).toContain("or none");
  });

  it("embeds the declaration and tolerates empty text and zero candidates", () => {
    const embedded = buildAdventureSelectionQuestions("I climb the wall.", [candidates[1]!]);
    const support = embedded[ADVENTURE_SUPPORTED_KEY];
    if (support?.type !== "noul") throw new Error("support must be a noul");
    expect(String(support.instructions)).toContain("I climb the wall.");
    expect(() => buildAdventureSelectionQuestions("   ", [])).not.toThrow();
    const empty = buildAdventureSelectionQuestions("   ", []);
    expect(empty[`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]).toBeUndefined();
    const aggregate = empty[ADVENTURE_BEST_KEY];
    if (aggregate?.type !== "choice") throw new Error("aggregate must be a choice");
    expect(Object.keys(aggregate.criteria)).toEqual([ADVENTURE_NONE]);
  });
});

describe("composeAdventureSelection", () => {
  it("acts on an advertised candidate when both independent claims clear the action threshold", () => {
    const composition = composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.9),
      [ADVENTURE_BEST_KEY]: choice("travel:mill", 0.9),
    }, thresholds);
    expect(composition).toEqual({
      band: "act",
      method: "choice",
      selection: { candidateId: "travel:mill", digest: "a".repeat(64) },
      topSignal: 0.9,
    });
  });

  it("confirms, rather than acts, when the weaker claim sits in the review band", () => {
    const composition = composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.6),
      [ADVENTURE_BEST_KEY]: choice("check:climb", 0.9),
    }, thresholds);
    expect(composition.band).toBe("confirm");
    expect(composition.method).toBe("choice");
    expect(composition.selection?.candidateId).toBe("check:climb");
    expect(composition.topSignal).toBe(0.6);
  });

  it("fails closed when either claim is weak, even if the other is confident", () => {
    const unsupported = composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.2),
      [ADVENTURE_BEST_KEY]: choice("travel:mill", 0.95),
    }, thresholds);
    expect(unsupported).toEqual({ band: "fallback", method: "defer", selection: null, topSignal: 0.2 });
    const hesitant = composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.95),
      [ADVENTURE_BEST_KEY]: choice("travel:mill", 0.4),
    }, thresholds);
    expect(hesitant.selection).toBeNull();
    expect(hesitant.topSignal).toBe(0.4);
  });

  it("defers on none_of_these, an undeclared id, a missing noul, or no candidates", () => {
    expect(composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.99),
      [ADVENTURE_BEST_KEY]: choice(ADVENTURE_NONE, 0.99),
    }, thresholds).selection).toBeNull();
    expect(composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.99),
      [ADVENTURE_BEST_KEY]: choice("invented:teleport", 0.99),
    }, thresholds).band).toBe("fallback");
    expect(composeAdventureSelection(candidates, {
      [ADVENTURE_BEST_KEY]: choice("travel:mill", 0.99),
    }, thresholds).band).toBe("fallback");
    expect(composeAdventureSelection([], {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.99),
      [ADVENTURE_BEST_KEY]: choice("travel:mill", 0.99),
    }, thresholds)).toEqual({ band: "fallback", method: "defer", selection: null, topSignal: null });
  });

  it("never throws on malformed or missing probability maps", () => {
    const malformed = { type: "choice", choice: "travel:mill", confidence: 0.9, probabilities: {} } as SystemOneAnswer;
    expect(() => composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.9),
      [ADVENTURE_BEST_KEY]: malformed,
    }, thresholds)).not.toThrow();
    expect(composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.9),
      [ADVENTURE_BEST_KEY]: malformed,
    }, thresholds).band).toBe("fallback");
  });

  it("normalizes the per-candidate relevance score and clamps out-of-range values", () => {
    expect(adventureCandidateRelevance({ [`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]: { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: {} } }, "travel:mill")).toBe(1);
    expect(adventureCandidateRelevance({ [`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]: { type: "score", score: 0, confidence: 0.9, legend: {}, probabilities: {} } }, "travel:mill")).toBe(0);
    expect(adventureCandidateRelevance({ [`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]: { type: "score", score: 9, confidence: 0.9, legend: {}, probabilities: {} } }, "travel:mill")).toBe(1);
    expect(adventureCandidateRelevance({}, "travel:mill")).toBeNull();
    expect(adventureCandidateRelevance({ [`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]: noul(0.9) }, "travel:mill")).toBeNull();
  });
});
