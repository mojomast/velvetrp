import { createHash } from "node:crypto";
import { canonicalAgentJson } from "@velvet/contracts";
import { describe, expect, it } from "vitest";
import {
  assertSystemOneDecisionIntegrity,
  createRepository,
  getSystemOneDecision,
  listSystemOneDecisions,
  recordSystemOneDecision,
  type RecordSystemOneDecisionInput,
} from "../src/repo/index.js";
import { getRepositoryDatabase } from "../src/repo/repoContext.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const at = "2035-01-01T00:00:00.000Z";
const sha = (value: unknown) => createHash("sha256").update(canonicalAgentJson(value as never)).digest("hex");

function decision(overrides: Partial<RecordSystemOneDecisionInput> = {}): RecordSystemOneDecisionInput {
  return {
    decisionId: "decision:1",
    lane: "combat",
    provider: "openai",
    model: "m1",
    confidencePolicyVersion: "v1",
    state: { hp: 7, tags: ["a", "b"] },
    questions: { q1: { type: "score" } },
    answers: { q1: 3 },
    selection: { candidate: "x" },
    confidenceBand: "act",
    fallbackUsed: false,
    shadow: true,
    usage: { total: 5 },
    latencyMs: 123,
    createdAt: at,
    ...overrides,
  };
}

describe("system one decision repository", () => {
  it("records and reads back a decision with digests derived from the raw values", () => {
    createRepository();
    const input = decision();
    recordSystemOneDecision(input);

    const record = getSystemOneDecision(input.decisionId)!;
    expect(record.state).toEqual(input.state);
    expect(record.questions).toEqual(input.questions);
    expect(record.answers).toEqual(input.answers);
    expect(record.selection).toEqual(input.selection);
    expect(record.request).toEqual({ state: input.state, model: input.model, questions: input.questions });
    expect(record.stateDigest).toBe(sha(input.state));
    expect(record.questionsDigest).toBe(sha(input.questions));
    expect(record.requestDigest).toBe(sha({ state: input.state, model: input.model, questions: input.questions }));
    expect(record.stateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.questionsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.fallbackUsed).toBe(false);
    expect(record.shadow).toBe(true);
    expect(record.usage).toEqual({ total: 5 });
    expect(record.latencyMs).toBe(123);
    expect(record.createdAt).toBe(at);
    assertSystemOneDecisionIntegrity(input.decisionId);
  });

  it("rejects a duplicate decision id through the replace trigger", () => {
    createRepository();
    const input = decision();
    recordSystemOneDecision(input);
    expect(() => recordSystemOneDecision(input)).toThrow(/cannot be replaced/);
  });

  it("rejects updates and deletes through the immutability triggers", () => {
    createRepository();
    recordSystemOneDecision(decision());
    const db = getRepositoryDatabase();
    expect(() => db.prepare("UPDATE system_one_decisions_v1 SET lane=? WHERE decision_id=?").run("other", "decision:1"))
      .toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM system_one_decisions_v1 WHERE decision_id=?").run("decision:1"))
      .toThrow(/immutable/);
    expect(getSystemOneDecision("decision:1")!.lane).toBe("combat");
  });

  it("throws when a stored row has been tampered with a mismatched digest", () => {
    createRepository();
    getRepositoryDatabase().prepare(`INSERT INTO system_one_decisions_v1
      (decision_id,lane,campaign_id,session_id,turn_id,provider,model,confidence_policy_version,
        request_digest,questions_digest,state_digest,request_json,questions_json,state_json,answers_json,
        selection_json,confidence_band,fallback_used,shadow,usage_json,latency_ms,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "tampered", "combat", null, null, null, "openai", "m1", "v1",
      "0".repeat(64), "0".repeat(64), "0".repeat(64),
      "{}", "{}", '{"tampered":true}', "{}", "{}", "act", 0, 0, null, 0, at,
    );
    expect(() => assertSystemOneDecisionIntegrity("tampered")).toThrow(/digest mismatch/);
  });

  it("lists decisions in ascending created-at order and clamps the limit", () => {
    createRepository();
    recordSystemOneDecision(decision({ decisionId: "decision:b", createdAt: "2035-01-02T00:00:00.000Z" }));
    recordSystemOneDecision(decision({ decisionId: "decision:a", createdAt: "2035-01-01T00:00:00.000Z" }));
    recordSystemOneDecision(decision({ decisionId: "decision:c", createdAt: "2035-01-03T00:00:00.000Z" }));

    expect(listSystemOneDecisions(10).map((record) => record.decisionId))
      .toEqual(["decision:a", "decision:b", "decision:c"]);
    expect(listSystemOneDecisions(0)).toHaveLength(1);
    expect(listSystemOneDecisions(5_000)).toHaveLength(3);
  });
});
