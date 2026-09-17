import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_LIMIT,
  MAX_REVIEW_LIMIT,
  applyReviewAnnotations,
  renderReviewSheet,
  reviewCandidates,
  summarizeReview,
  type ReviewCandidate,
  type ReviewVerdict,
} from "../src/agent/systemOneReview.js";
import type { SystemOneDecisionRecord } from "../src/repo/systemOneDecisionRepo.js";

let sequence = 0;

function record(overrides: Partial<SystemOneDecisionRecord> = {}): SystemOneDecisionRecord {
  sequence += 1;
  const id = sequence;
  return {
    decisionId: `decision-${String(id).padStart(4, "0")}`,
    lane: "director",
    campaignId: null,
    sessionId: null,
    turnId: null,
    provider: "stub-provider",
    model: "stub-model",
    confidencePolicyVersion: "v1",
    requestDigest: `request-digest-${id}`,
    questionsDigest: `questions-digest-${id}`,
    stateDigest: `state-digest-${id}`,
    request: { seed: id },
    questions: [{ id: `q-${id}` }],
    state: { seed: id },
    answers: [{ id: `a-${id}` }],
    selection: { topSignal: 0.5 },
    confidenceBand: "act",
    fallbackUsed: false,
    shadow: false,
    usage: null,
    latencyMs: 12,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, id)).toISOString(),
    ...overrides,
  };
}

describe("reviewCandidates", () => {
  it("includes act decisions and excludes confirm and fallback by default", () => {
    const candidates = reviewCandidates([
      record({ decisionId: "act", confidenceBand: "act" }),
      record({ decisionId: "confirm", confidenceBand: "confirm" }),
      record({ decisionId: "fallback", confidenceBand: "fallback" }),
    ]);
    expect(candidates.map((candidate) => candidate.decisionId)).toEqual(["act"]);
  });

  it("adds flagged fallbacks when includeFlaggedFallbacks is set", () => {
    const records = [
      record({ decisionId: "act", confidenceBand: "act" }),
      record({ decisionId: "confirm", confidenceBand: "confirm", selection: { flags: ["hazard"] } }),
      record({ decisionId: "fallback-flagged", confidenceBand: "fallback", selection: { topSignal: 0.1, flags: ["hazard"] } }),
      record({ decisionId: "fallback-empty", confidenceBand: "fallback", selection: { topSignal: 0.2, flags: [] } }),
      record({ decisionId: "fallback-plain", confidenceBand: "fallback", selection: { topSignal: 0.3 } }),
      record({ decisionId: "fallback-nonarray", confidenceBand: "fallback", selection: { topSignal: 0.4, flags: "hazard" } }),
    ];

    expect(reviewCandidates(records).map((candidate) => candidate.decisionId)).toEqual(["act"]);
    expect(reviewCandidates(records, { includeFlaggedFallbacks: true }).map((candidate) => candidate.decisionId))
      .toEqual(["fallback-flagged", "act"]);
  });

  it("filters by lane", () => {
    const records = [
      record({ decisionId: "a", lane: "alpha" }),
      record({ decisionId: "b", lane: "beta" }),
      record({ decisionId: "c", lane: "alpha" }),
    ];
    expect(reviewCandidates(records, { lane: "alpha" }).map((candidate) => candidate.decisionId)).toEqual(["a", "c"]);
    expect(reviewCandidates(records, { lane: "missing" })).toEqual([]);
  });

  it("keeps only finite signals at or below maxSignal", () => {
    const records = [
      record({ decisionId: "low", selection: { topSignal: 1 } }),
      record({ decisionId: "bound", selection: { topSignal: 5 } }),
      record({ decisionId: "high", selection: { topSignal: 10 } }),
      record({ decisionId: "missing", selection: {} }),
      record({ decisionId: "nonnumeric", selection: { topSignal: "5" } }),
      record({ decisionId: "infinite", selection: { topSignal: Number.POSITIVE_INFINITY } }),
    ];
    expect(reviewCandidates(records, { maxSignal: 5 }).map((candidate) => candidate.decisionId))
      .toEqual(["low", "bound"]);
  });

  it("reads topSignal from selection.topSignal and yields null otherwise", () => {
    const byId = new Map(reviewCandidates([
      record({ decisionId: "numeric", selection: { topSignal: 0.42 } }),
      record({ decisionId: "absent", selection: { other: 1 } }),
      record({ decisionId: "nonnumeric", selection: { topSignal: "0.42" } }),
      record({ decisionId: "nan", selection: { topSignal: Number.NaN } }),
      record({ decisionId: "primitive", selection: 7 }),
      record({ decisionId: "null-selection", selection: null }),
    ]).map((candidate) => [candidate.decisionId, candidate.topSignal]));

    expect(byId.get("numeric")).toBe(0.42);
    expect(byId.get("absent")).toBeNull();
    expect(byId.get("nonnumeric")).toBeNull();
    expect(byId.get("nan")).toBeNull();
    expect(byId.get("primitive")).toBeNull();
    expect(byId.get("null-selection")).toBeNull();
  });

  it("sorts ascending by signal (missing last), then createdAt, then decisionId", () => {
    const candidates = reviewCandidates([
      record({ decisionId: "high", selection: { topSignal: 0.9 }, createdAt: "2026-01-01T00:00:00.000Z" }),
      record({ decisionId: "low", selection: { topSignal: 0.2 }, createdAt: "2026-01-01T00:00:00.000Z" }),
      record({ decisionId: "b-mid", selection: { topSignal: 0.5 }, createdAt: "2026-01-01T00:00:01.000Z" }),
      record({ decisionId: "a-mid", selection: { topSignal: 0.5 }, createdAt: "2026-01-01T00:00:01.000Z" }),
      record({ decisionId: "later-mid", selection: { topSignal: 0.5 }, createdAt: "2026-01-01T00:00:02.000Z" }),
      record({ decisionId: "missing-b", selection: {}, createdAt: "2026-01-01T00:00:04.000Z" }),
      record({ decisionId: "missing-a", selection: {}, createdAt: "2026-01-01T00:00:03.000Z" }),
    ]);

    expect(candidates.map((candidate) => candidate.decisionId)).toEqual([
      "low",
      "a-mid",
      "b-mid",
      "later-mid",
      "high",
      "missing-a",
      "missing-b",
    ]);
  });

  it("defaults the limit to DEFAULT_REVIEW_LIMIT", () => {
    expect(DEFAULT_REVIEW_LIMIT).toBe(20);
    const records = Array.from({ length: 25 }, (_, index) => record({ decisionId: `d-${index}` }));
    expect(reviewCandidates(records)).toHaveLength(DEFAULT_REVIEW_LIMIT);
  });

  it("clamps a limit above MAX_REVIEW_LIMIT and retains the lowest signals", () => {
    expect(MAX_REVIEW_LIMIT).toBe(200);
    const records = Array.from({ length: 205 }, (_, index) => record({
      decisionId: `bulk-${String(index).padStart(3, "0")}`,
      selection: { topSignal: index },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    }));

    const retained = reviewCandidates(records, { limit: 500 });
    expect(retained).toHaveLength(MAX_REVIEW_LIMIT);
    expect(new Set(retained.map((candidate) => candidate.decisionId)).size).toBe(MAX_REVIEW_LIMIT);
    expect(retained[0]?.topSignal).toBe(0);
    expect(retained.at(-1)?.topSignal).toBe(199);
    expect(retained.every((candidate) => (candidate.topSignal ?? Number.POSITIVE_INFINITY) <= 199)).toBe(true);
  });

  it("clamps a limit below 1 to 1", () => {
    const records = [
      record({ decisionId: "low", selection: { topSignal: 0.1 } }),
      record({ decisionId: "high", selection: { topSignal: 0.9 } }),
    ];
    expect(reviewCandidates(records, { limit: 0 }).map((candidate) => candidate.decisionId)).toEqual(["low"]);
    expect(reviewCandidates(records, { limit: -5 }).map((candidate) => candidate.decisionId)).toEqual(["low"]);
  });
});

describe("applyReviewAnnotations", () => {
  it("attaches valid verdicts, ignores unknown ids, and rejects invalid verdicts", () => {
    const queue = reviewCandidates([
      record({ decisionId: "correct", selection: { topSignal: 0.1 } }),
      record({ decisionId: "incorrect", selection: { topSignal: 0.2 } }),
      record({ decisionId: "unjudged", selection: { topSignal: 0.3 } }),
    ]);

    const annotated = applyReviewAnnotations(queue, {
      correct: "correct",
      incorrect: "incorrect",
      unjudged: "maybe" as unknown as ReviewVerdict,
      "not-in-queue": "correct",
    });

    expect(annotated.map((candidate) => [candidate.decisionId, candidate.verdict])).toEqual([
      ["correct", "correct"],
      ["incorrect", "incorrect"],
      ["unjudged", null],
    ]);
  });

  it("keeps unannotated candidates at a null verdict", () => {
    const queue = reviewCandidates([record({ decisionId: "solo", selection: { topSignal: 0.1 } })]);
    const annotated = applyReviewAnnotations(queue, {});
    expect(annotated).toHaveLength(1);
    expect(annotated[0]?.verdict).toBeNull();
  });
});

describe("summarizeReview", () => {
  it("counts verdicts and reports incorrect lanes and ids in order", () => {
    const queue = reviewCandidates([
      record({ decisionId: "d1", lane: "laneA", selection: { topSignal: 0.1 } }),
      record({ decisionId: "d2", lane: "laneB", selection: { topSignal: 0.2 } }),
      record({ decisionId: "d3", lane: "laneA", selection: { topSignal: 0.3 } }),
      record({ decisionId: "d4", lane: "laneC", selection: { topSignal: 0.4 } }),
      record({ decisionId: "d5", lane: "laneB", selection: { topSignal: 0.5 } }),
    ]);
    const annotated = applyReviewAnnotations(queue, {
      d1: "incorrect",
      d2: "correct",
      d3: "incorrect",
      d5: "incorrect",
    });

    expect(summarizeReview(annotated)).toEqual({
      total: 5,
      reviewed: 4,
      correct: 1,
      incorrect: 3,
      unjudged: 1,
      incorrectLanes: ["laneA", "laneB"],
      incorrectDecisionIds: ["d1", "d3", "d5"],
    });
  });
});

describe("renderReviewSheet", () => {
  function annotatedSample(): ReturnType<typeof applyReviewAnnotations> {
    const queue = reviewCandidates([
      record({ decisionId: "alpha", lane: "laneA", selection: { topSignal: 0.1 } }),
      record({ decisionId: "beta", lane: "laneB", selection: { topSignal: 0.2 } }),
      record({ decisionId: "gamma", lane: "laneC", selection: { topSignal: 0.3 } }),
    ]);
    return applyReviewAnnotations(queue, { alpha: "incorrect", beta: "correct" });
  }

  it("is deterministic for identical input", () => {
    const candidates = annotatedSample();
    expect(renderReviewSheet(candidates)).toBe(renderReviewSheet(candidates));
  });

  it("renders the summary, queue table, decisions, ids, and verdicts", () => {
    const candidates = annotatedSample();
    const sheet = renderReviewSheet(candidates, { generatedAt: "2026-01-01T00:00:00.000Z", source: "unit-test" });

    expect(sheet).toContain("# System One decision review sheet");
    expect(sheet).toContain("## Summary");
    expect(sheet).toContain("Generated 2026-01-01T00:00:00.000Z");
    expect(sheet).toContain("Source: unit-test");
    expect(sheet).toContain("## Queue");
    expect(sheet).toContain("| # | Decision | Lane | Band | Signal | Shadow | Verdict |");
    expect(sheet).toContain("## Decisions");
    expect(sheet).toContain("- Candidates: 3");
    expect(sheet).toContain("- Reviewed: 2 (1 correct, 1 incorrect, 1 unjudged)");
    expect(sheet).toContain("- Lanes with an incorrect verdict: laneA");

    for (const candidate of candidates) expect(sheet).toContain(candidate.decisionId);
    expect(sheet).toContain("incorrect");
    expect(sheet).toContain("correct");
    expect(sheet).toContain("unjudged");
  });

  it("truncates oversized payloads and keeps the sheet bounded", () => {
    const huge = "x".repeat(50_000);
    const queue = reviewCandidates([record({ decisionId: "huge", selection: { topSignal: 0.1 }, state: huge })]);
    const sheet = renderReviewSheet(applyReviewAnnotations(queue, {}));

    expect(sheet).toContain("(truncated at 4000 chars)");
    expect(sheet.length).toBeLessThan(10_000);
    expect(sheet.length).toBeLessThan(huge.length);
  });
});

describe("purity", () => {
  it("does not mutate input records or the annotation object", () => {
    const records = [
      record({ decisionId: "one", selection: { topSignal: 0.1, flags: ["hazard"] }, confidenceBand: "fallback" }),
      record({ decisionId: "two", selection: { topSignal: 0.9 }, state: { nested: { value: 1 } } }),
    ];
    const annotations: Record<string, ReviewVerdict> = { one: "incorrect", two: "correct" };
    const recordsBefore = structuredClone(records);
    const annotationsBefore = structuredClone(annotations);

    const queue: ReviewCandidate[] = reviewCandidates(records, { includeFlaggedFallbacks: true, limit: 10 });
    const annotated = applyReviewAnnotations(queue, annotations);
    summarizeReview(annotated);
    renderReviewSheet(annotated, { generatedAt: "2026-01-01T00:00:00.000Z" });

    expect(records).toEqual(recordsBefore);
    expect(annotations).toEqual(annotationsBefore);
  });
});
