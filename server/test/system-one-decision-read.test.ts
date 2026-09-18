import { describe, expect, it } from "vitest";
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { buildApp } from "../src/app.js";
import {
  listLaneCommittedSystemOneDecisionIds,
  listRecentSystemOneDecisionsWithLaneCommits,
  listSystemOneDecisionsByLane,
  recordSystemOneDecision,
  summarizeSystemOneDecisions,
  type RecordSystemOneDecisionInput,
} from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const PROJECTED_KEYS = [
  "campaignId", "committedByLane", "confidenceBand", "confidencePolicyVersion", "createdAt", "decisionId",
  "fallbackUsed", "latencyMs", "lane", "model", "provider", "questionsDigest", "requestDigest", "sessionId",
  "shadow", "stateDigest", "turnId",
].sort();

function decision(overrides: Partial<RecordSystemOneDecisionInput> = {}): RecordSystemOneDecisionInput {
  return {
    decisionId: "decision:1",
    lane: "speaker-routing",
    campaignId: null,
    sessionId: "session:1",
    turnId: null,
    provider: "typesafe",
    model: "jev-latest",
    confidencePolicyVersion: "v1",
    state: { marker: "state-payload-marker" },
    questions: { marker: "questions-payload-marker" },
    answers: { marker: "answers-payload-marker" },
    selection: { method: "top-signal", speakerIds: ["npc:a"], topSignal: 0.9 },
    confidenceBand: "act",
    fallbackUsed: false,
    shadow: false,
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    latencyMs: 100,
    createdAt: "2035-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function seedThree(): void {
  recordSystemOneDecision(decision({
    decisionId: "decision:1", lane: "speaker-routing", confidenceBand: "act",
    fallbackUsed: false, shadow: false, latencyMs: 100,
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    createdAt: "2035-01-01T00:00:01.000Z",
  }));
  recordSystemOneDecision(decision({
    decisionId: "decision:2", lane: "speaker-routing", confidenceBand: "confirm",
    fallbackUsed: true, shadow: true, latencyMs: 200,
    usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
    createdAt: "2035-01-01T00:00:02.000Z",
  }));
  recordSystemOneDecision(decision({
    decisionId: "decision:3", lane: "guardrails", confidenceBand: "fallback",
    fallbackUsed: true, shadow: false, latencyMs: 300,
    usage: null,
    createdAt: "2035-01-01T00:00:03.000Z",
  }));
}

/**
 * Seeds one lane-origin check execution row linking `decisionId`. The read join only consumes the
 * execution's link columns, so this fixture connection skips the campaign graph foreign keys a full
 * lane commit would build.
 */
function seedLaneExecution(decisionId: string, suffix: string): void {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys = OFF");
  db.prepare(`INSERT INTO adventure_check_executions_v54
    (command_id,candidate_id,campaign_id,turn_id,origin,provider_call_id,provider_tool_call_id,round_number,
      provider_request_digest,provider_response_digest,system_one_decision_id,selection_json,selection_digest,
      revision_before,revision_after,rolls_json,public_result_json,result_digest,occurred_at)
    VALUES(?,?,?,?,'lane',NULL,NULL,NULL,NULL,NULL,?,?,?,0,1,?,?,?,?)`).run(
    `check-command:${suffix}`, `check-candidate:${suffix}`, `campaign:${suffix}`, `turn:${suffix}`, decisionId,
    JSON.stringify({ candidateId: `check-candidate:${suffix}` }), "a".repeat(64),
    JSON.stringify([{ value: 12, kept: true }]), JSON.stringify({ outcome: "success" }), "b".repeat(64),
    "2035-01-01T00:00:00.000Z",
  );
  db.close();
}

/** A raw lane-origin rest execution, mirroring the exact-action family's provenance shape. */
function seedRestLaneExecution(decisionId: string, suffix: string): void {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys = OFF");
  db.prepare(`INSERT INTO adventure_exact_action_executions_v56
    (execution_id,candidate_id,campaign_id,turn_id,proposal_id,action_kind,origin,provider_call_id,provider_tool_call_id,
      system_one_decision_id,command_id,actor_id,revision_before,revision_after,source_result_digest,public_result_json,
      result_digest,occurred_at,linked_at)
    VALUES(?,?,?,?,?,'rest','lane',NULL,NULL,?,?,?,0,1,?,?,?,?,?)`).run(
    `execution:${suffix}`, `rest-candidate:${suffix}`, `campaign:${suffix}`, `turn:${suffix}`, `proposal:${suffix}`, decisionId,
    `rest-command:${suffix}`, `actor:${suffix}`, "c".repeat(64), JSON.stringify({}), "d".repeat(64),
    "2035-01-01T00:00:00.000Z", "2035-01-01T00:00:00.000Z",
  );
  db.close();
}

describe("System One decision read api", () => {
  it("lists decisions newest-first with the privacy projection only", async () => {
    seedThree();
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/provider/system-one/decisions" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json() as { decisions: Array<Record<string, unknown>> };
    expect(body.decisions.map((entry) => entry.decisionId)).toEqual(["decision:3", "decision:2", "decision:1"]);
    for (const entry of body.decisions) expect(Object.keys(entry).sort()).toEqual(PROJECTED_KEYS);
    expect(body.decisions[0]).toMatchObject({
      decisionId: "decision:3", lane: "guardrails", campaignId: null, sessionId: "session:1", turnId: null,
      provider: "typesafe", model: "jev-latest", confidencePolicyVersion: "v1",
      confidenceBand: "fallback", fallbackUsed: true, shadow: false, latencyMs: 300,
      createdAt: "2035-01-01T00:00:03.000Z",
    });
    expect(body.decisions[0]).not.toHaveProperty("state");
    expect(body.decisions[0]).not.toHaveProperty("questions");
    expect(body.decisions[0]).not.toHaveProperty("answers");
    expect(body.decisions[0]).not.toHaveProperty("selection");
    expect(body.decisions[0]).not.toHaveProperty("request");
    expect(body.decisions[0]).not.toHaveProperty("usage");
    expect(response.body).not.toMatch(/state-payload-marker|questions-payload-marker|answers-payload-marker|top-signal/);
    await app.close();
  });

  it("honors the requested limit, clamps to 200, defaults to 50, and rejects invalid limits", async () => {
    for (let index = 0; index < 205; index += 1) {
      recordSystemOneDecision(decision({
        decisionId: `decision:${index}`,
        createdAt: new Date(Date.UTC(2035, 0, 1, 0, 0, 0) + index * 1_000).toISOString(),
      }));
    }
    const app = buildApp();

    const defaulted = await app.inject({ method: "GET", url: "/api/provider/system-one/decisions" });
    expect(defaulted.statusCode).toBe(200);
    expect((defaulted.json() as { decisions: unknown[] }).decisions).toHaveLength(50);

    const clamped = await app.inject({ method: "GET", url: "/api/provider/system-one/decisions?limit=1000" });
    expect(clamped.statusCode).toBe(200);
    const clampedBody = clamped.json() as { decisions: Array<{ decisionId: string }> };
    expect(clampedBody.decisions).toHaveLength(200);
    expect(clampedBody.decisions[0]!.decisionId).toBe("decision:204");
    expect(clampedBody.decisions[199]!.decisionId).toBe("decision:5");

    const two = await app.inject({ method: "GET", url: "/api/provider/system-one/decisions?limit=2" });
    expect(two.statusCode).toBe(200);
    expect((two.json() as { decisions: Array<{ decisionId: string }> }).decisions.map((entry) => entry.decisionId))
      .toEqual(["decision:204", "decision:203"]);

    for (const url of [
      "/api/provider/system-one/decisions?limit=abc",
      "/api/provider/system-one/decisions?limit=0",
      "/api/provider/system-one/decisions?limit=-1",
      "/api/provider/system-one/decisions?limit=1.5",
      "/api/provider/system-one/decisions?limit=",
      "/api/provider/system-one/decisions?lane=speaker-routing",
      "/api/provider/system-one/decisions?limit=5&other=1",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
    await app.close();
  });

  it("summarizes counts by lane and band plus fallback, shadow, latency, and token totals", async () => {
    seedThree();
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/provider/system-one/decisions/summary" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body).toEqual({
      total: 3,
      byLane: [
        { lane: "guardrails", count: 1, laneCommits: 0 },
        { lane: "speaker-routing", count: 2, laneCommits: 0 },
      ],
      byBand: [{ band: "act", count: 1 }, { band: "confirm", count: 1 }, { band: "fallback", count: 1 }],
      fallbackUsed: 2,
      shadow: 1,
      laneCommits: 0,
      shadowLaneCommits: 0,
      meanLatencyMs: 200,
      totalInputTokens: 150,
      totalOutputTokens: 15,
    });
    expect(body.fallbackUsed / body.total).toBeCloseTo(2 / 3);
    expect(body.shadow / body.total).toBeCloseTo(1 / 3);
    await app.close();
  });

  it("marks lane-origin commits from the execution join and counts them per lane", async () => {
    seedThree();
    recordSystemOneDecision(decision({
      decisionId: "decision:advisory", lane: "adventure-selection", shadow: true,
      createdAt: "2035-01-01T00:00:04.000Z",
    }));
    // A rest-family lane commit must count too, not only the check-execution family.
    recordSystemOneDecision(decision({
      decisionId: "decision:rest", lane: "adventure-selection", shadow: true,
      createdAt: "2035-01-01T00:00:05.000Z",
    }));
    seedRestLaneExecution("decision:rest", "rest:1");
    // Two executions linked to the same decision must count as one committed decision.
    seedLaneExecution("decision:2", "commit:1");
    seedLaneExecution("decision:2", "commit:2");
    const app = buildApp();

    const listed = await app.inject({ method: "GET", url: "/api/provider/system-one/decisions" });
    expect(listed.statusCode).toBe(200);
    const decisions = (listed.json() as { decisions: Array<Record<string, unknown>> }).decisions;
    const byId = new Map(decisions.map((entry) => [entry.decisionId, entry]));
    expect(decisions.map((entry) => entry.decisionId)).toEqual(["decision:rest", "decision:advisory", "decision:3", "decision:2", "decision:1"]);
    // decision:2 was recorded advisory (shadow: true) and then committed by a lane-origin execution.
    expect(byId.get("decision:2")).toMatchObject({ shadow: true, committedByLane: true });
    // decision:rest was committed by the rest family's lane-origin execution table.
    expect(byId.get("decision:rest")).toMatchObject({ shadow: true, committedByLane: true });
    // A plain advisory decision with no execution row stays shadow-only.
    expect(byId.get("decision:advisory")).toMatchObject({ shadow: true, committedByLane: false });
    expect(byId.get("decision:1")).toMatchObject({ shadow: false, committedByLane: false });

    const summaryResponse = await app.inject({ method: "GET", url: "/api/provider/system-one/decisions/summary" });
    expect(summaryResponse.statusCode).toBe(200);
    const summary = summaryResponse.json();
    expect(summary).toMatchObject({ total: 5, shadow: 3, laneCommits: 2, shadowLaneCommits: 2 });
    expect(summary.byLane).toEqual([
      { lane: "adventure-selection", count: 2, laneCommits: 1 },
      { lane: "guardrails", count: 1, laneCommits: 0 },
      { lane: "speaker-routing", count: 2, laneCommits: 1 },
    ]);

    // The repository join itself reports the same evidence and stays additive.
    expect(listLaneCommittedSystemOneDecisionIds(["decision:1", "decision:2", "decision:3", "decision:rest"]))
      .toEqual(new Set(["decision:2", "decision:rest"]));
    expect(listRecentSystemOneDecisionsWithLaneCommits(10).find((record) => record.decisionId === "decision:2")?.committedByLane)
      .toBe(true);
    await app.close();
  });

  it("filters by lane and clamps the lane read limit", () => {
    seedThree();
    const lane = listSystemOneDecisionsByLane("speaker-routing", 10);
    expect(lane.map((record) => record.decisionId)).toEqual(["decision:1", "decision:2"]);
    expect(lane.every((record) => record.lane === "speaker-routing")).toBe(true);
    expect(listSystemOneDecisionsByLane("speaker-routing", 0)).toHaveLength(1);
    expect(listSystemOneDecisionsByLane("missing", 10)).toEqual([]);

    const summary = summarizeSystemOneDecisions(1);
    expect(summary.total).toBe(1);
    expect(summary.byLane).toEqual([{ lane: "guardrails", count: 1, laneCommits: 0 }]);
    expect(summarizeSystemOneDecisions(0).total).toBe(1);
  });
});
