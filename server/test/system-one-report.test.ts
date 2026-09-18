import { describe, expect, it } from "vitest";
import { buildSystemOneShadowReport } from "../src/agent/systemOneReport.js";
import type {
  SystemOneDecisionRecord,
  SystemOneDecisionSummary,
} from "../src/repo/systemOneDecisionRepo.js";

function record(overrides: Partial<SystemOneDecisionRecord> = {}): SystemOneDecisionRecord {
  return {
    decisionId: "decision:1",
    lane: "speaker-routing",
    campaignId: null,
    sessionId: "session:1",
    turnId: null,
    provider: "typesafe",
    model: "jev-latest",
    confidencePolicyVersion: "v1",
    requestDigest: "request-digest",
    questionsDigest: "questions-digest",
    stateDigest: "state-digest",
    request: { marker: "RAW_REQUEST_PAYLOAD" },
    questions: { marker: "RAW_QUESTIONS_PAYLOAD" },
    state: { marker: "RAW_STATE_PAYLOAD" },
    answers: { marker: "RAW_ANSWERS_PAYLOAD" },
    selection: { method: "top-signal", speakerIds: ["npc:a"] },
    confidenceBand: "act",
    fallbackUsed: false,
    shadow: false,
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    latencyMs: 120.5,
    createdAt: "2035-01-01T00:00:01.000Z",
    ...overrides,
  };
}

const summary: SystemOneDecisionSummary = {
  total: 4,
  byLane: [
    { lane: "guardrails", count: 1, laneCommits: 0 },
    { lane: "speaker-routing", count: 3, laneCommits: 2 },
  ],
  byBand: [
    { band: "act", count: 2 },
    { band: "confirm", count: 1 },
    { band: "fallback", count: 1 },
  ],
  fallbackUsed: 2,
  shadow: 3,
  laneCommits: 2,
  shadowLaneCommits: 2,
  meanLatencyMs: 187.625,
  totalInputTokens: 350,
  totalOutputTokens: 35,
};

describe("buildSystemOneShadowReport", () => {
  it("renders totals, tables, rates and tokens", () => {
    const output = buildSystemOneShadowReport(summary, [
      record({ decisionId: "decision:1", lane: "speaker-routing", confidenceBand: "act", fallbackUsed: false, shadow: true,
        committedByLane: true }),
      record({ decisionId: "decision:2", lane: "guardrails", confidenceBand: "fallback", fallbackUsed: true, shadow: false,
        committedByLane: false, latencyMs: 300 }),
    ]);

    expect(output).toContain("# System One shadow decision report");
    expect(output).toContain("Total decisions: 4");
    expect(output).toContain("Shadow decisions: 3 (75.0%)");
    expect(output).toContain("Lane commits: 2 (50.0%)");
    expect(output).toContain("Shadow decisions with a lane commit: 2 (50.0%)");
    expect(output).toContain("Fallback used: 2 (50.0%)");
    expect(output).toContain("Mean latency: 187.6 ms");
    expect(output).toContain("Total input tokens: 350");
    expect(output).toContain("Total output tokens: 35");
    // The report names the authoritative commit evidence: the execution row, not the decision row.
    expect(output).toContain(
      "Lane commit evidence is the authoritative `adventure_check_executions_v54` row with `origin='lane'`"
      + " linked by `system_one_decision_id`; a decision row with `shadow: true` was only recorded as advisory.",
    );

    expect(output).toContain("## Per-lane breakdown");
    expect(output).toContain("| speaker-routing | 3 | 75.0% | 2 |");
    expect(output).toContain("| guardrails | 1 | 25.0% | 0 |");
    expect(output).toContain("## Per-band breakdown");
    expect(output).toContain("| act | 2 | 50.0% |");
    expect(output).toContain("| confirm | 1 | 25.0% |");
    expect(output).toContain("| fallback | 1 | 25.0% |");

    expect(output).toContain("## Recent decisions");
    expect(output).toContain("| Lane | Band | Fallback | Shadow | Lane commit | Latency (ms) | Created at |");
    // A shadow decision with a lane commit reads as recorded advisory but actually committed.
    expect(output).toContain("| speaker-routing | act | no | yes | yes | 120.5 | 2035-01-01T00:00:01.000Z |");
    expect(output).toContain("| guardrails | fallback | yes | no | no | 300.0 | 2035-01-01T00:00:01.000Z |");
  });

  it("renders the lane-commit flag as unknown when the record was not joined", () => {
    const output = buildSystemOneShadowReport(summary, [record({ decisionId: "decision:1", shadow: true })]);

    expect(output).toContain("| speaker-routing | act | no | yes | — | 120.5 | 2035-01-01T00:00:01.000Z |");
  });

  it("never emits raw decision payloads", () => {
    const output = buildSystemOneShadowReport(summary, [record()]);
    for (const marker of [
      "RAW_REQUEST_PAYLOAD",
      "RAW_QUESTIONS_PAYLOAD",
      "RAW_STATE_PAYLOAD",
      "RAW_ANSWERS_PAYLOAD",
    ]) {
      expect(output).not.toContain(marker);
    }
    for (const key of ["state", "questions", "answers", "request"]) {
      expect(output).not.toContain(key);
    }
  });

  it("renders an empty-decisions report without throwing", () => {
    const output = buildSystemOneShadowReport(
      {
        total: 0,
        byLane: [],
        byBand: [
          { band: "act", count: 0 },
          { band: "confirm", count: 0 },
          { band: "fallback", count: 0 },
        ],
        fallbackUsed: 0,
        shadow: 0,
        laneCommits: 0,
        shadowLaneCommits: 0,
        meanLatencyMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
      [],
    );

    expect(output).toContain("Total decisions: 0");
    expect(output).toContain("Shadow decisions: 0 (0.0%)");
    expect(output).toContain("Lane commits: 0 (0.0%)");
    expect(output).toContain("Shadow decisions with a lane commit: 0 (0.0%)");
    expect(output).toContain("Fallback used: 0 (0.0%)");
    expect(output).toContain("Mean latency: 0.0 ms");
    expect(output).toContain("_No decisions recorded._");
  });
});
