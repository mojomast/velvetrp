import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  applyReviewAnnotations,
  renderReviewSheet,
  reviewCandidates,
} from "../../server/src/agent/systemOneReview.js";
import type { SystemOneDecisionRecord } from "../../server/src/repo/index.js";
import { parseReviewArgs } from "../review-system-one-decisions.js";

function makeRecord(
  decisionId: string,
  confidenceBand: SystemOneDecisionRecord["confidenceBand"],
  selection: unknown,
  createdAt: string,
): SystemOneDecisionRecord {
  return {
    decisionId,
    lane: "speaker-routing",
    campaignId: null,
    sessionId: null,
    turnId: null,
    provider: "test",
    model: "test-model",
    confidencePolicyVersion: "v1",
    requestDigest: `request-${decisionId}`,
    questionsDigest: `questions-${decisionId}`,
    stateDigest: `state-${decisionId}`,
    request: { decisionId },
    questions: [],
    state: { decisionId },
    answers: [],
    selection,
    confidenceBand,
    fallbackUsed: confidenceBand === "fallback",
    shadow: true,
    usage: null,
    latencyMs: 1,
    createdAt,
  };
}

test("parseReviewArgs applies defaults", () => {
  assert.deepEqual(parseReviewArgs([]), {
    lane: null,
    limit: 20,
    maxSignal: null,
    includeFlaggedFallbacks: false,
    annotations: null,
    out: null,
  });
});

test("parseReviewArgs reads each value flag in both forms", () => {
  assert.equal(parseReviewArgs(["--lane", "cost-router"]).lane, "cost-router");
  assert.equal(parseReviewArgs(["--lane=guardrails"]).lane, "guardrails");

  assert.equal(parseReviewArgs(["--limit", "7"]).limit, 7);
  assert.equal(parseReviewArgs(["--limit=7"]).limit, 7);

  assert.equal(parseReviewArgs(["--max-signal", "0.25"]).maxSignal, 0.25);
  assert.equal(parseReviewArgs(["--max-signal=0.25"]).maxSignal, 0.25);

  assert.equal(parseReviewArgs(["--annotations", "review.json"]).annotations, "review.json");
  assert.equal(parseReviewArgs(["--annotations=review.json"]).annotations, "review.json");

  assert.equal(parseReviewArgs(["--out", "out.md"]).out, path.resolve("out.md"));
  assert.equal(parseReviewArgs(["--out=out.md"]).out, path.resolve("out.md"));
});

test("parseReviewArgs toggles --include-flagged", () => {
  assert.equal(parseReviewArgs([]).includeFlaggedFallbacks, false);
  assert.equal(parseReviewArgs(["--include-flagged"]).includeFlaggedFallbacks, true);
});

test("parseReviewArgs clamps the limit like the sibling CLI", () => {
  assert.equal(parseReviewArgs(["--limit", "0"]).limit, 1);
  assert.equal(parseReviewArgs(["--limit", "-5"]).limit, 1);
  assert.equal(parseReviewArgs(["--limit", "9999"]).limit, 200);
  assert.equal(parseReviewArgs(["--limit", "2.9"]).limit, 2);
});

test("parseReviewArgs accepts max-signal at the inclusive bounds", () => {
  assert.equal(parseReviewArgs(["--max-signal", "0"]).maxSignal, 0);
  assert.equal(parseReviewArgs(["--max-signal", "1"]).maxSignal, 1);
});

test("parseReviewArgs rejects an unknown lane", () => {
  assert.throws(() => parseReviewArgs(["--lane", "not-a-lane"]), /unknown lane: not-a-lane/);
  assert.throws(() => parseReviewArgs(["--lane=nope"]), /unknown lane: nope/);
});

test("parseReviewArgs rejects unknown arguments", () => {
  assert.throws(() => parseReviewArgs(["--bogus"]), /unknown argument: --bogus/);
  assert.throws(() => parseReviewArgs(["--lane", "guardrails", "extra"]), /unknown argument: extra/);
});

test("parseReviewArgs rejects invalid numbers", () => {
  assert.throws(() => parseReviewArgs(["--limit", "abc"]), /--limit requires a number/);
  assert.throws(() => parseReviewArgs(["--limit"]), /--limit requires a number/);
  assert.throws(() => parseReviewArgs(["--max-signal", "-0.1"]), /--max-signal requires a number in \[0,1\]/);
  assert.throws(() => parseReviewArgs(["--max-signal", "1.1"]), /--max-signal requires a number in \[0,1\]/);
  assert.throws(() => parseReviewArgs(["--max-signal", "abc"]), /--max-signal requires a number in \[0,1\]/);
});

test("parseReviewArgs rejects missing path values", () => {
  assert.throws(() => parseReviewArgs(["--out"]), /--out requires a path/);
  assert.throws(() => parseReviewArgs(["--out="]), /--out requires a path/);
  assert.throws(() => parseReviewArgs(["--annotations"]), /--annotations requires a path/);
  assert.throws(() => parseReviewArgs(["--annotations="]), /--annotations requires a path/);
});

test("renders a review sheet with annotated verdicts", () => {
  const records = [
    makeRecord("decision-act", "act", { topSignal: 0.8, chosen: "a" }, "2026-09-17T00:00:00.000Z"),
    makeRecord("decision-uncertain", "act", { topSignal: 0.2, chosen: "b" }, "2026-09-17T00:01:00.000Z"),
    makeRecord("decision-fallback", "fallback", { topSignal: 0.1, flags: ["hazard"] }, "2026-09-17T00:02:00.000Z"),
  ];

  const candidates = reviewCandidates(records, { limit: 20 });
  assert.deepEqual(candidates.map((candidate) => candidate.decisionId), ["decision-uncertain", "decision-act"]);

  const annotated = applyReviewAnnotations(candidates, { "decision-uncertain": "incorrect" });
  assert.equal(annotated[0]!.verdict, "incorrect");
  assert.equal(annotated[1]!.verdict, null);

  const rendered = renderReviewSheet(annotated, {
    generatedAt: "2026-09-17T00:00:00.000Z",
    source: "/tmp/velvet.sqlite",
  });
  assert.match(rendered, /decision-uncertain/);
  assert.match(rendered, /decision-act/);
  assert.match(rendered, /incorrect/);
  assert.doesNotMatch(rendered, /decision-fallback/);
  assert.equal(rendered, renderReviewSheet(annotated, {
    generatedAt: "2026-09-17T00:00:00.000Z",
    source: "/tmp/velvet.sqlite",
  }));
});

test("includes flagged fallbacks and honors maxSignal when asked", () => {
  const records = [
    makeRecord("decision-act", "act", { topSignal: 0.8 }, "2026-09-17T00:00:00.000Z"),
    makeRecord("decision-fallback", "fallback", { topSignal: 0.1, flags: ["hazard"] }, "2026-09-17T00:02:00.000Z"),
    makeRecord("decision-quiet-fallback", "fallback", { topSignal: 0.1 }, "2026-09-17T00:03:00.000Z"),
  ];

  const flagged = reviewCandidates(records, { includeFlaggedFallbacks: true, maxSignal: 0.5 });
  assert.deepEqual(flagged.map((candidate) => candidate.decisionId), ["decision-fallback"]);
  assert.equal(flagged[0]!.topSignal, 0.1);
});
