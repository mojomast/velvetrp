import { describe, expect, it } from "vitest";
import {
  DEFAULT_RERANK_WEIGHTS,
  RERANK_ANSWERS_PREFIX,
  RERANK_RELEVANCE_PREFIX,
  buildRerankQuestions,
  composeRerankOrder,
  type RerankCandidate,
  type RerankInput,
} from "../src/agent/systemOneRerank.js";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };

const candidates: RerankCandidate[] = [
  { candidateId: "c0", label: "Alpha", text: "first memory", rank: 0 },
  { candidateId: "c1", label: "Bravo", text: "second memory", rank: 1 },
  { candidateId: "c2", label: "Charlie", rank: 2 },
  { candidateId: "c3", label: "Delta", text: "fourth memory", rank: 3 },
];

const allIds = candidates.map((candidate) => candidate.candidateId);
const input: RerankInput = { query: "find alpha", candidates };

const relevance = (id: string, score: number): Record<string, SystemOneAnswer> => ({
  [`${RERANK_RELEVANCE_PREFIX}${id}`]: { type: "score", score, confidence: 1, legend: {}, probabilities: {} },
});

const answersNoul = (id: string, value: number): Record<string, SystemOneAnswer> => ({
  [`${RERANK_ANSWERS_PREFIX}${id}`]: { type: "noul", noul: value },
});

const relevanceAll = (score: number): Record<string, SystemOneAnswer> =>
  Object.assign({}, ...allIds.map((id) => relevance(id, score)));

const answersAll = (value: number): Record<string, SystemOneAnswer> =>
  Object.assign({}, ...allIds.map((id) => answersNoul(id, value)));

describe("buildRerankQuestions", () => {
  it("emits one relevance score and one answers noul per candidate", () => {
    const questions = buildRerankQuestions(input);
    expect(Object.keys(questions).sort()).toEqual([
      "answers:c0", "answers:c1", "answers:c2", "answers:c3",
      "relevance:c0", "relevance:c1", "relevance:c2", "relevance:c3",
    ]);
    expect(Object.keys(questions).filter((key) => key.startsWith(RERANK_RELEVANCE_PREFIX))).toHaveLength(candidates.length);
    expect(Object.keys(questions).filter((key) => key.startsWith(RERANK_ANSWERS_PREFIX))).toHaveLength(candidates.length);
    for (const candidate of candidates) {
      expect(questions[`${RERANK_RELEVANCE_PREFIX}${candidate.candidateId}`]!.type).toBe("score");
      expect(questions[`${RERANK_ANSWERS_PREFIX}${candidate.candidateId}`]!.type).toBe("noul");
    }
  });

  it("embeds the query and the candidate text in the instructions", () => {
    const questions = buildRerankQuestions(input);
    const relevanceInstructions = String(questions[`${RERANK_RELEVANCE_PREFIX}c0`]!.instructions);
    const answersInstructions = String(questions[`${RERANK_ANSWERS_PREFIX}c0`]!.instructions);
    expect(relevanceInstructions).toContain("find alpha");
    expect(relevanceInstructions).toContain("first memory");
    expect(relevanceInstructions).toContain("Alpha");
    expect(answersInstructions).toContain("find alpha");
    expect(answersInstructions).toContain("first memory");
    expect(String(questions[`${RERANK_ANSWERS_PREFIX}c2`]!.instructions)).toContain("Charlie");
  });

  it("handles an empty or whitespace query without throwing", () => {
    expect(() => buildRerankQuestions({ query: "", candidates })).not.toThrow();
    expect(() => buildRerankQuestions({ query: "   ", candidates })).not.toThrow();
    const blank = buildRerankQuestions({ query: "   ", candidates });
    expect(String(blank[`${RERANK_ANSWERS_PREFIX}c0`]!.instructions)).toContain("(empty query)");
  });

  it("returns no questions for an empty candidate list", () => {
    expect(buildRerankQuestions({ query: "find alpha", candidates: [] })).toEqual({});
  });
});

describe("composeRerankOrder", () => {
  it("returns the empty composition for no candidates", () => {
    expect(composeRerankOrder({ query: "find alpha", candidates: [] }, {}, thresholds)).toEqual({
      order: [],
      fused: {},
      relevance: {},
      answers: {},
      band: "fallback",
      topSignal: null,
    });
  });

  it("reproduces the deterministic rank order for all-equal model responses", () => {
    const composition = composeRerankOrder(input, { ...relevanceAll(2), ...answersAll(0.9) }, thresholds);
    expect(composition.order).toEqual(allIds);
  });

  it("lifts a worse-ranked candidate above a better-ranked one on high relevance", () => {
    const answers = {
      ...relevance("c0", 0),
      ...relevance("c1", 3),
      ...relevance("c2", 0),
      ...relevance("c3", 0),
      ...answersAll(0.2),
    };
    const composition = composeRerankOrder(input, answers, thresholds, DEFAULT_RERANK_WEIGHTS);
    expect(composition.order).toEqual(["c1", "c0", "c2", "c3"]);
    expect(composition.order.indexOf("c1")).toBeLessThan(composition.order.indexOf("c0"));
  });

  it("honors the deterministic and model weights", () => {
    const answers = {
      ...relevanceAll(0),
      ...relevance("c1", 1),
      ...relevance("c2", 2),
      ...relevance("c3", 3),
      ...answersAll(0.2),
    };
    expect(composeRerankOrder(input, answers, thresholds, { deterministic: 0, model: 1 }).order).toEqual(["c3", "c2", "c1", "c0"]);
    expect(composeRerankOrder(input, answers, thresholds, { deterministic: 1, model: 0 }).order).toEqual(allIds);
    expect(composeRerankOrder(input, answers, thresholds, { deterministic: 0, model: 0 }).order).toEqual(allIds);
  });

  it("never drops or duplicates a candidate across answer combinations", () => {
    const combinations: Record<string, SystemOneAnswer>[] = [
      {},
      { ...relevance("c0", 3) },
      { ...answersNoul("c1", 0.9) },
      { ...relevance("c0", 1), ...answersNoul("c2", 0.5) },
      { ...relevanceAll(3), ...answersAll(0.9) },
      { ...relevance("c3", 3), ...answersNoul("c3", 0.75) },
    ];
    for (const answers of combinations) {
      const composition = composeRerankOrder(input, answers, thresholds);
      expect(composition.order).toHaveLength(candidates.length);
      expect(new Set(composition.order)).toEqual(new Set(allIds));
      expect([...composition.order].sort()).toEqual([...allIds].sort());
    }
  });

  it("falls back to deterministic order when no answer is usable", () => {
    const composition = composeRerankOrder(input, {}, thresholds);
    expect(composition).toEqual({
      order: allIds,
      fused: {},
      relevance: {},
      answers: {},
      band: "fallback",
      topSignal: null,
    });
  });

  it("keeps unanswered candidates at their deterministic score when some answers are usable", () => {
    const answers = { ...relevance("c1", 3), ...answersNoul("c1", 0.9), ...relevance("c3", 0), ...answersNoul("c3", 0.2) };
    const composition = composeRerankOrder(input, answers, thresholds);
    expect(composition.order).toHaveLength(candidates.length);
    // A partial model response must not demote candidates it did not answer.
    expect(composition.order[0]).toBe("c0");
    expect(composition.fused.c0).toBe(1);
    expect(composition.fused.c2).toBeCloseTo(1 / 3, 10);
    // The answered candidate with perfect relevance rises above the unanswered second-ranked one.
    expect(composition.order.indexOf("c1")).toBeLessThan(composition.order.indexOf("c2"));
  });

  it("ignores wrong-typed answers without throwing", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [`${RERANK_RELEVANCE_PREFIX}c0`]: { type: "noul", noul: 0.9 },
      [`${RERANK_ANSWERS_PREFIX}c0`]: { type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 1 } },
    };
    expect(() => composeRerankOrder(input, answers, thresholds)).not.toThrow();
    expect(composeRerankOrder(input, answers, thresholds)).toEqual({
      order: allIds,
      fused: {},
      relevance: {},
      answers: {},
      band: "fallback",
      topSignal: null,
    });
  });

  it("derives the band and topSignal from the strongest answers noul", () => {
    const act = composeRerankOrder(input, { ...relevanceAll(1), ...answersAll(0.9) }, thresholds);
    expect(act.band).toBe("act");
    expect(act.topSignal).toBeCloseTo(0.9, 6);
    const confirm = composeRerankOrder(input, { ...relevanceAll(1), ...answersAll(0.6) }, thresholds);
    expect(confirm.band).toBe("confirm");
    expect(confirm.topSignal).toBeCloseTo(0.6, 6);
    const fallback = composeRerankOrder(input, { ...relevanceAll(1), ...answersAll(0.2) }, thresholds);
    expect(fallback.band).toBe("fallback");
    expect(fallback.topSignal).toBeCloseTo(0.2, 6);
  });

  it("marks answers true only at or above the action threshold", () => {
    const answers = {
      ...answersNoul("c0", 0.9),
      ...answersNoul("c1", 0.5),
      ...answersNoul("c2", 0.74),
      ...answersNoul("c3", 0.75),
    };
    const composition = composeRerankOrder(input, answers, thresholds);
    expect(composition.answers).toEqual({ c0: true, c1: false, c2: false, c3: true });
  });

  it("normalizes and clamps relevance into [0, 1]", () => {
    const answers = {
      ...relevance("c0", 3),
      ...relevance("c1", 0),
      ...relevance("c2", 9),
      ...relevance("c3", -4),
    };
    const composition = composeRerankOrder(input, answers, thresholds);
    expect(composition.relevance.c0).toBe(1);
    expect(composition.relevance.c1).toBe(0);
    expect(composition.relevance.c2).toBe(1);
    expect(composition.relevance.c3).toBe(0);
  });

  it("does not mutate the input or the candidate array", () => {
    const fresh: RerankInput = { query: "find alpha", candidates: candidates.map((candidate) => ({ ...candidate })) };
    const snapshot = JSON.parse(JSON.stringify(fresh));
    const answers = { ...relevance("c0", 3), ...answersNoul("c0", 0.9) };
    buildRerankQuestions(fresh);
    composeRerankOrder(fresh, answers, thresholds);
    expect(fresh).toEqual(snapshot);
    expect(fresh.candidates.map((candidate) => candidate.candidateId)).toEqual(allIds);
    expect(fresh.query).toBe("find alpha");
  });
});
