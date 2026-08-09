import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { canonicalAgentJson } from "@velvet/contracts";
import { DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS, V38_DURABLE_AGENT_EXECUTION_CANONICAL_DIGEST }
  from "../src/repo/db/migrations/v38_durable_agent_execution.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const AT = "2035-01-01T00:00:00.000Z";
const file = (dir = process.env.VELVET_DATA_DIR!) => path.join(dir, "velvet.sqlite");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function v38Sql(db: DatabaseDriver.Database): unknown[] {
  const names = DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS.map(([, name]) => name);
  return db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")})
    AND sql IS NOT NULL ORDER BY type,name`).all(...names);
}

function removeV38(db: DatabaseDriver.Database): void {
  const objects = v38Sql(db) as Array<{ type: string; name: string }>;
  for (const object of objects) if (object.type === "trigger") db.exec(`DROP TRIGGER "${object.name}"`);
  for (const object of objects) if (object.type === "index") db.exec(`DROP INDEX IF EXISTS "${object.name}"`);
  for (const table of ["durable_agent_execution_layout_attestation_v38", "agent_read_outcomes_v38",
    "agent_decision_batch_seals_v38", "agent_tool_calls_v38", "agent_decision_rounds_v38", "agent_provider_starts_v38",
    "agent_execution_operations_v38", "adventure_agent_executions_v38"]) db.exec(`DROP TABLE "${table}"`);
}

function populatedTurn(): { turnId: string; campaignId: string } {
  let sequence = 0;
  let repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) },
    ids: { nextId: () => `v38-id-${++sequence}` } });
  const campaign = repo.createCampaign("local-owner", { name: "Populated v37" }); repo.close();
  const db = new DatabaseDriver(file()); db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO principals VALUES ('player','Player',0)").run();
  db.prepare("INSERT INTO campaign_memberships VALUES (?,'player','player',?)").run(campaign.id, AT);
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(AT);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('turn-profile','Turn profile','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('turn-pack','1','turn-profile','Turn pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('turn-pack','1','race','human','Human','Race','[]'),('turn-pack','1','background','hero','Hero','Background','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='turn-pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'turn-profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'turn-pack','1','turn-profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','turn-pack','1','race','human','turn-pack','1','background','hero',?,?)")
    .run(campaign.id, AT, AT);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor',?,'player','private')").run(campaign.id);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(AT);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, AT); db.close();
  repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) },
    ids: { nextId: () => `v38-id-${++sequence}` } });
  const turn = repo.createAdventureTurn("player", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
    sessionId: "session", actorId: "actor", declaration: "Open the door", expectedCampaignRevision: 0, idempotencyKey: "turn" });
  repo.recordProviderCallStart("player", { turnId: turn.turnId, callId: "historical", provider: "test", model: "model", attempt: 1,
    expectedTurnRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "historical-start" });
  repo.close();
  return { turnId: turn.turnId, campaignId: campaign.id };
}

describe("schema v38 durable agent execution", () => {
  it("upgrades a genuinely populated v37 with baseline and fresh window, matching fresh DDL", () => {
    const identity = populatedTurn();
    let db = new DatabaseDriver(file()); removeV38(db);
    db.prepare("UPDATE meta SET value='37' WHERE key='schemaVersion'").run(); db.close();
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    db = new DatabaseDriver(file(), { readonly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "38" });
    const run = db.prepare(`SELECT started_at,deadline_at,max_decision_rounds,max_tool_calls,
      max_mutation_calls,max_provider_calls,max_duration_ms FROM adventure_agent_executions_v38 WHERE turn_id=?`).get(identity.turnId) as any;
    expect(run).toMatchObject({ max_decision_rounds: 5, max_tool_calls: 12,
      max_mutation_calls: 4, max_provider_calls: 7, max_duration_ms: 90_000 });
    expect(new Date(run.deadline_at).getTime() - new Date(run.started_at).getTime()).toBe(90_000);
    expect(run.started_at).not.toBe(AT);
    const migratedSql = v38Sql(db); db.close();
    const freshDir = path.join(process.env.VELVET_DATA_DIR!, "fresh");
    // The parent exists and is intentionally inside the test temp directory.
    mkdirSync(freshDir);
    createRepository({ dataDir: freshDir }).close();
    const fresh = new DatabaseDriver(file(freshDir), { readonly: true });
    expect(v38Sql(fresh)).toEqual(migratedSql);
    expect(fresh.prepare("SELECT layout_digest FROM durable_agent_execution_layout_attestation_v38").get())
      .toEqual({ layout_digest: V38_DURABLE_AGENT_EXECUTION_CANONICAL_DIGEST });
    fresh.close();
  });

  it("rejects exact-layout data tampering through response-child validation", () => {
    const identity = populatedTurn();
    let repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) } });
    repo.startAgentProviderCall("player", { turnId: identity.turnId, providerCallId: "planner", provider: "test", model: "model", attempt: 1,
      expectedCampaignRevision: 0, expectedTurnRevision: 1, expectedExecutionRevision: 0, idempotencyKey: "planner" });
    repo.persistAgentDecisionRound("player", { turnId: identity.turnId, round: 1, providerCallId: "planner", toolRegistryVersion: "v1",
      request: {}, result: "tool-calls", calls: [{ providerToolCallId: "read", toolName: "campaign_context.read", kind: "read", arguments: {} }],
      expectedCampaignRevision: 0, expectedTurnRevision: 1, expectedExecutionRevision: 1, idempotencyKey: "round" });
    repo.close();
    const db = new DatabaseDriver(file());
    const guard = (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='agent_decision_rounds_v38_update_v38'").get() as { sql: string }).sql;
    db.exec("DROP TRIGGER agent_decision_rounds_v38_update_v38");
    db.prepare("UPDATE agent_decision_rounds_v38 SET response_json=?").run('{"calls":[],"result":"tool-calls"}');
    db.exec(guard); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("decision round is malformed");
  });

  it("rejects exact-layout batch-seal count and timestamp tampering", () => {
    const identity = populatedTurn(); seedReadRound(identity, false);
    const db = new DatabaseDriver(file());
    tamperImmutable(db, "agent_decision_batch_seals_v38_update_v38",
      "UPDATE agent_decision_batch_seals_v38 SET call_count=0,sealed_at='2035-01-01T00:00:00.001Z'");
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("batch seal is malformed");
  });

  it("rejects exact-layout round and call timestamp ancestry tampering", () => {
    const identity = populatedTurn(); seedReadRound(identity, false);
    const db = new DatabaseDriver(file());
    tamperImmutable(db, "agent_tool_calls_v38_update_v38",
      "UPDATE agent_tool_calls_v38 SET recorded_at='2035-01-01T00:00:00.001Z'");
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("tool call is malformed");
  });

  it("rejects exact-layout outcome-operation timestamp tampering", () => {
    const identity = populatedTurn(); seedReadRound(identity, true);
    const db = new DatabaseDriver(file());
    tamperImmutable(db, "agent_read_outcomes_v38_update_v38",
      "UPDATE agent_read_outcomes_v38 SET recorded_at='2035-01-01T00:00:00.001Z'");
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("read outcome is malformed");
  });

  it("rejects a tampered additive SQL inventory at startup", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const db = new DatabaseDriver(file()); db.exec("DROP TRIGGER agent_tool_calls_validate_v38"); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("v38 durable agent execution object inventory");
  });

  it("grandfathers a populated v37 provider excess without permitting growth", () => {
    const identity = populatedTurn();
    let db = new DatabaseDriver(file()); removeV38(db);
    const insert = db.prepare(`INSERT INTO provider_call_metadata(record_id,campaign_id,turn_id,call_id,phase,provider,model,attempt,
      prompt_tokens,completion_tokens,outcome_code,idempotency_key,recorded_at) VALUES(?,?,?,?,'started','test','model',1,NULL,NULL,NULL,?,?)`);
    for (let index = 1; index < 9; index += 1) insert.run(`historical-record-${index}`, identity.campaignId, identity.turnId,
      `historical-${index}`, `historical-key-${index}`, AT);
    db.prepare("UPDATE meta SET value='37' WHERE key='schemaVersion'").run(); db.close();
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    db = new DatabaseDriver(file());
    expect(db.prepare("SELECT max_provider_calls FROM adventure_agent_executions_v38 WHERE turn_id=?").get(identity.turnId))
      .toEqual({ max_provider_calls: 9 });
    expect(() => insertProviderStart(db, identity, "historical-9", "historical-key-9")).toThrow("provider call limit exceeded");
    expect(db.prepare("SELECT count(*) count FROM provider_call_metadata WHERE turn_id=? AND phase='started'").get(identity.turnId))
      .toEqual({ count: 9 });
    db.close();
  });

  it("SQL rejects an eighth unified provider start and deadline operation without residue", () => {
    const identity = populatedTurn(); const db = new DatabaseDriver(file());
    for (let index = 1; index < 7; index += 1) insertProviderStart(db, identity, `legacy-${index}`, `legacy-key-${index}`);
    expect(() => insertProviderStart(db, identity, "legacy-7", "legacy-key-7")).toThrow("provider call limit exceeded");
    const run = db.prepare("SELECT deadline_at FROM adventure_agent_executions_v38 WHERE turn_id=?").get(identity.turnId) as { deadline_at: string };
    const request = canonicalAgentJson({ turnId: identity.turnId, providerCallId: "late", provider: "test", model: "model", attempt: 1,
      expectedCampaignRevision: 0, expectedTurnRevision: 1, expectedExecutionRevision: 0, idempotencyKey: "late" });
    expect(() => db.prepare(`INSERT INTO agent_execution_operations_v38(operation_id,campaign_id,turn_id,principal_id,operation_type,
      idempotency_key,expected_campaign_revision,expected_turn_revision,expected_execution_revision,resulting_execution_revision,
      request_json,request_digest,occurred_at) VALUES('late-operation',?,?,'player','provider-start','late',0,1,0,1,?,?,?)`)
      .run(identity.campaignId, identity.turnId, request, sha256(request), run.deadline_at)).toThrow("invalid durable agent execution operation");
    expect(db.prepare("SELECT count(*) count FROM agent_execution_operations_v38 WHERE turn_id=?").get(identity.turnId)).toEqual({ count: 0 });
    db.close();
  });

  it("SQL rejects a sixth round after five resolved rounds without residue", () => {
    const identity = populatedTurn(); const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) } });
    let revision = 0;
    for (let round = 1; round <= 5; round += 1) {
      repo.startAgentProviderCall("player", { turnId: identity.turnId, providerCallId: `provider-${round}`, provider: "test", model: "model",
        attempt: round, expectedCampaignRevision: 0, expectedTurnRevision: 1, expectedExecutionRevision: revision,
        idempotencyKey: `provider-${round}` }); revision += 1;
      repo.persistAgentDecisionRound("player", { turnId: identity.turnId, round, providerCallId: `provider-${round}`, toolRegistryVersion: "v1",
        request: {}, result: "tool-calls", calls: [{ providerToolCallId: `read-${round}`, toolName: "campaign_context.read", kind: "read",
          arguments: {} }], expectedCampaignRevision: 0, expectedTurnRevision: 1, expectedExecutionRevision: revision,
        idempotencyKey: `round-${round}` }); revision += 1;
      repo.markAgentReadOutcome("player", { turnId: identity.turnId, providerToolCallId: `read-${round}`,
        outcome: { status: "succeeded", result: {} }, expectedCampaignRevision: 0, expectedTurnRevision: 1,
        expectedExecutionRevision: revision, idempotencyKey: `outcome-${round}` }); revision += 1;
    }
    repo.close();
    const db = new DatabaseDriver(file());
    const requestValue = { turnId: identity.turnId, round: 6, providerCallId: "provider-6", toolRegistryVersion: "v1",
      request: {}, result: "complete", calls: [], expectedCampaignRevision: 0, expectedTurnRevision: 1,
      expectedExecutionRevision: revision, idempotencyKey: "round-6" };
    const request = canonicalAgentJson(requestValue), response = canonicalAgentJson({ result: "complete", calls: [] });
    const attempt = db.transaction(() => {
      db.prepare(`INSERT INTO agent_execution_operations_v38 VALUES('round-6-operation',?,?,'player','decision-round','round-6',0,1,?,?,?, ?,?)`)
        .run(identity.campaignId, identity.turnId, revision, revision + 1, request, sha256(request), AT);
      db.prepare(`INSERT INTO agent_decision_rounds_v38 VALUES('round-6-id','round-6-seal','round-6-operation',?,?,6,'provider-6','v1',
        '{}',? ,?,?,'complete',?,?)`).run(identity.campaignId, identity.turnId, sha256("{}"), response, sha256(response), revision + 1, AT);
    });
    expect(attempt).toThrow("invalid durable agent decision round");
    expect(db.prepare("SELECT count(*) count FROM agent_execution_operations_v38 WHERE operation_id='round-6-operation'").get()).toEqual({ count: 0 });
    db.close();
  });

  it("SQL rejects thirteenth-call and fifth-mutation children without changing counts", () => {
    const identity = populatedTurn(); const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) } });
    repo.startAgentProviderCall("player", { turnId: identity.turnId, providerCallId: "provider", provider: "test", model: "model",
      attempt: 1, expectedCampaignRevision: 0, expectedTurnRevision: 1, expectedExecutionRevision: 0, idempotencyKey: "provider" });
    const calls = Array.from({ length: 12 }, (_, index) => ({ providerToolCallId: `call-${index}`,
      toolName: "campaign_context.read" as const, kind: "read" as const, arguments: {} }));
    repo.persistAgentDecisionRound("player", { turnId: identity.turnId, round: 1, providerCallId: "provider", toolRegistryVersion: "v1",
      request: {}, result: "tool-calls", calls, expectedCampaignRevision: 0, expectedTurnRevision: 1,
      expectedExecutionRevision: 1, idempotencyKey: "round" });
    const campaign = repo.getCampaign("player", identity.campaignId)!;
    const mutationTurn = repo.createAdventureTurn("player", { campaignId: identity.campaignId, timelineId: campaign.activeTimelineId,
      sessionId: "session", actorId: "actor", declaration: "Mutate", expectedCampaignRevision: 0, idempotencyKey: "mutation-turn" });
    repo.startAgentProviderCall("player", { turnId: mutationTurn.turnId, providerCallId: "mutation-provider", provider: "test", model: "model",
      attempt: 1, expectedCampaignRevision: 0, expectedTurnRevision: 0, expectedExecutionRevision: 0, idempotencyKey: "mutation-provider" });
    repo.persistAgentDecisionRound("player", { turnId: mutationTurn.turnId, round: 1, providerCallId: "mutation-provider", toolRegistryVersion: "v1",
      request: {}, result: "tool-calls", calls: Array.from({ length: 4 }, (_, index) => ({ providerToolCallId: `mutation-${index}`,
        toolName: "actor_dice.roll" as const, kind: "mutation" as const, arguments: {} })), expectedCampaignRevision: 0,
      expectedTurnRevision: 0, expectedExecutionRevision: 1, idempotencyKey: "mutation-round" }); repo.close();
    const db = new DatabaseDriver(file());
    const round = db.prepare("SELECT round_id,recorded_at FROM agent_decision_rounds_v38 WHERE turn_id=?").get(identity.turnId) as any;
    const insertCall = (id: string, roundNumber: number, position: number, kind: string, tool: string) => db.prepare(`INSERT INTO agent_tool_calls_v38
      (call_id,campaign_id,turn_id,round_id,round_number,position,provider_tool_call_id,tool_name,call_kind,arguments_json,argument_digest,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?, '{}',?,?)`).run(id, identity.campaignId, identity.turnId, round.round_id, roundNumber,
        position, id, tool, kind, sha256("{}"), round.recorded_at);
    expect(() => insertCall("call-12", 2, 0, "read", "campaign_context.read")).toThrow("invalid durable agent tool call");
    expect(db.prepare("SELECT count(*) count FROM agent_tool_calls_v38 WHERE turn_id=?").get(identity.turnId)).toEqual({ count: 12 });
    const mutationRound = db.prepare("SELECT round_id,recorded_at FROM agent_decision_rounds_v38 WHERE turn_id=?")
      .get(mutationTurn.turnId) as any;
    expect(() => db.prepare(`INSERT INTO agent_tool_calls_v38
      (call_id,campaign_id,turn_id,round_id,round_number,position,provider_tool_call_id,tool_name,call_kind,arguments_json,argument_digest,recorded_at)
      VALUES('mutation-4',?,?,?,1,4,'mutation-4','actor_dice.roll','mutation','{}',?,?)`)
      .run(identity.campaignId, mutationTurn.turnId, mutationRound.round_id, sha256("{}"), mutationRound.recorded_at))
      .toThrow("invalid durable agent tool call");
    expect(db.prepare("SELECT count(*) count FROM agent_tool_calls_v38 WHERE turn_id=?").get(mutationTurn.turnId)).toEqual({ count: 4 });
    db.close();
  });
});

function insertProviderStart(db: DatabaseDriver.Database, identity: { campaignId: string; turnId: string }, callId: string, key: string): void {
  db.prepare(`INSERT INTO provider_call_metadata(record_id,campaign_id,turn_id,call_id,phase,provider,model,attempt,prompt_tokens,
    completion_tokens,outcome_code,idempotency_key,recorded_at) VALUES(?,?,?,?,'started','test','model',1,NULL,NULL,NULL,?,?)`)
    .run(`${callId}-record`, identity.campaignId, identity.turnId, callId, key, AT);
}

function seedReadRound(identity: { campaignId: string; turnId: string }, outcome: boolean): void {
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) } });
  repo.startAgentProviderCall("player", { turnId: identity.turnId, providerCallId: "planner", provider: "test", model: "model", attempt: 1,
    expectedCampaignRevision: 0, expectedTurnRevision: 1, expectedExecutionRevision: 0, idempotencyKey: "planner" });
  repo.persistAgentDecisionRound("player", { turnId: identity.turnId, round: 1, providerCallId: "planner", toolRegistryVersion: "v1",
    request: {}, result: "tool-calls", calls: [{ providerToolCallId: "read", toolName: "campaign_context.read", kind: "read", arguments: {} }],
    expectedCampaignRevision: 0, expectedTurnRevision: 1, expectedExecutionRevision: 1, idempotencyKey: "round" });
  if (outcome) repo.markAgentReadOutcome("player", { turnId: identity.turnId, providerToolCallId: "read",
    outcome: { status: "succeeded", result: {} }, expectedCampaignRevision: 0, expectedTurnRevision: 1,
    expectedExecutionRevision: 2, idempotencyKey: "outcome" });
  repo.close();
}

function tamperImmutable(db: DatabaseDriver.Database, triggerName: string, update: string): void {
  const guard = (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName) as { sql: string }).sql;
  db.exec(`DROP TRIGGER "${triggerName}"`); db.exec(update); db.exec(guard);
}
