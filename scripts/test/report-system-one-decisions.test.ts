import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import DatabaseDriver from "better-sqlite3";
import { closeRepo, createRepository, recordSystemOneDecision } from "../../server/src/repo/index.js";
import { readDecisions } from "../report-system-one-decisions.js";

const AT = "2035-01-01T00:00:00.000Z";

/** One advisory decision row, exactly as the decision log stores it. */
function seedDecision(decisionId: string, lane: string, shadow: boolean, createdAt: string): void {
  recordSystemOneDecision({
    decisionId,
    lane,
    campaignId: null,
    sessionId: null,
    turnId: null,
    provider: "test",
    model: "test-model",
    confidencePolicyVersion: "v1",
    state: {},
    questions: {},
    answers: {},
    selection: {},
    confidenceBand: "act",
    fallbackUsed: false,
    shadow,
    usage: null,
    latencyMs: 1,
    createdAt,
  });
}

/**
 * Seeds one lane-origin check execution row linking `decisionId`. The report read only consumes the
 * execution's link columns, so this fixture connection skips the campaign graph foreign keys a full
 * lane commit would build.
 */
function seedLaneExecution(databasePath: string, decisionId: string, suffix: string): void {
  const db = new DatabaseDriver(databasePath);
  db.pragma("foreign_keys = OFF");
  db.prepare(`INSERT INTO adventure_check_executions_v54
    (command_id,candidate_id,campaign_id,turn_id,origin,provider_call_id,provider_tool_call_id,round_number,
      provider_request_digest,provider_response_digest,system_one_decision_id,selection_json,selection_digest,
      revision_before,revision_after,rolls_json,public_result_json,result_digest,occurred_at)
    VALUES(?,?,?,?,'lane',NULL,NULL,NULL,NULL,NULL,?,?,?,0,1,?,?,?,?)`).run(
    `check-command:${suffix}`, `check-candidate:${suffix}`, `campaign:${suffix}`, `turn:${suffix}`, decisionId,
    JSON.stringify({ candidateId: `check-candidate:${suffix}` }), "a".repeat(64),
    JSON.stringify([{ value: 12, kept: true }]), JSON.stringify({ outcome: "success" }), "b".repeat(64), AT,
  );
  db.close();
}

/** Builds a fresh repository database, runs the assertion body, and tears the data directory down. */
function withDecisionDatabase(run: (databasePath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), `velvet-report-one-${process.pid}-`));
  process.env.VELVET_DATA_DIR = dir;
  try {
    createRepository();
    run(path.join(dir, "velvet.sqlite"));
  } finally {
    closeRepo();
    delete process.env.VELVET_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readDecisions joins lane-origin executions into the summary and recent flags", () => {
  withDecisionDatabase((databasePath) => {
    seedDecision("decision:committed", "adventure-selection", true, "2035-01-01T00:00:01.000Z");
    seedDecision("decision:advisory", "adventure-selection", true, "2035-01-01T00:00:02.000Z");
    seedDecision("decision:plain", "guardrails", false, "2035-01-01T00:00:03.000Z");
    seedLaneExecution(databasePath, "decision:committed", "commit:1");

    const { summary, recent } = readDecisions(10, databasePath);

    assert.equal(summary.total, 3);
    assert.equal(summary.shadow, 2);
    assert.equal(summary.laneCommits, 1);
    assert.equal(summary.shadowLaneCommits, 1);
    assert.deepEqual(summary.byLane, [
      { lane: "adventure-selection", count: 2, laneCommits: 1 },
      { lane: "guardrails", count: 1, laneCommits: 0 },
    ]);

    const byId = new Map(recent.map((record) => [record.decisionId, record]));
    assert.equal(byId.get("decision:committed")?.committedByLane, true);
    assert.equal(byId.get("decision:advisory")?.committedByLane, false);
    assert.equal(byId.get("decision:plain")?.committedByLane, false);
    // The advisory decision row itself is untouched: the execution row is the commit evidence.
    assert.equal(byId.get("decision:committed")?.shadow, true);
  });
});
