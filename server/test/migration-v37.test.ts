import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS, proposalExecutionIdempotencyKeyV37 } from "../src/repo/db/migrations/v37_tool_execution_bindings.js";
import { DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS } from "../src/repo/db/migrations/v38_durable_agent_execution.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const AT = "2035-01-01T00:00:00.000Z";
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function removeV37(db: DatabaseDriver.Database): void {
  const v38Names = DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS.map(([, name]) => name);
  const v38 = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${v38Names.map(() => "?").join(",")}) AND sql IS NOT NULL`)
    .all(...v38Names) as Array<{ type: string; name: string }>;
  for (const object of v38) if (object.type === "trigger") db.exec(`DROP TRIGGER "${object.name}"`);
  for (const object of v38) if (object.type === "index") db.exec(`DROP INDEX IF EXISTS "${object.name}"`);
  for (const table of ["durable_agent_execution_layout_attestation_v38", "agent_read_outcomes_v38",
    "agent_decision_batch_seals_v38", "agent_tool_calls_v38", "agent_decision_rounds_v38", "agent_provider_starts_v38",
    "agent_execution_operations_v38", "adventure_agent_executions_v38"]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  const names = TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS.map(([, name]) => name);
  const objects = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL`)
    .all(...names) as Array<{ type: string; name: string }>;
  for (const object of objects) if (object.type === "trigger") db.exec(`DROP TRIGGER "${object.name}"`);
  for (const object of objects) if (object.type === "index") db.exec(`DROP INDEX IF EXISTS "${object.name}"`);
  db.exec("DROP TABLE IF EXISTS tool_execution_binding_layout_attestation_v37; DROP TABLE IF EXISTS tool_proposal_execution_bindings_v37");
}

function seedTurn() {
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) } });
  const campaign = repo.createCampaign("local-owner", { name: "V37 binding" });
  repo.close();
  const db = new DatabaseDriver(file()); db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(AT);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile','Profile','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('pack','1','profile','Pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('pack','1','race','human','Human','Race','[]'),('pack','1','background','hero','Hero','Background','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'pack','1','profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','pack','1','race','human','pack','1','background','hero',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor',?,'local-owner','')").run(campaign.id);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(AT);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, AT); db.close();
  const active = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) } });
  const turn = active.createAdventureTurn("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
    sessionId: "session", actorId: "actor", declaration: "Roll", expectedCampaignRevision: 0, idempotencyKey: "turn" });
  const proposed = active.appendToolProposal("local-owner", { turnId: turn.turnId, expectedTurnRevision: 0,
    expectedCampaignRevision: 0, idempotencyKey: "proposal", toolName: "roll", arguments: {}, requiresConfirmation: false });
  return { repo: active, campaign, turn, proposal: proposed.toolCalls[0]!.proposal };
}

describe("schema v37 exact tool execution bindings", () => {
  it("backfills an unexecuted v36 proposal deterministically without changing prior tables", () => {
    const seeded = seedTurn(); seeded.repo.close();
    const db = new DatabaseDriver(file());
    const priorToolSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='tool_proposals'").get() as { sql: string }).sql;
    removeV37(db); db.prepare("UPDATE meta SET value='36' WHERE key='schemaVersion'").run(); db.close();
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "38" });
    expect(verify.prepare(`SELECT execution_idempotency_key,command_type,source_turn_id,timeline_id,actor_id
      FROM tool_proposal_execution_bindings_v37 WHERE proposal_id=?`).get(seeded.proposal.proposalId)).toEqual({
      execution_idempotency_key: proposalExecutionIdempotencyKeyV37(seeded.proposal.proposalId), command_type: "roll_actor_dice",
      source_turn_id: seeded.turn.turnId, timeline_id: seeded.campaign.activeTimelineId, actor_id: "actor",
    });
    expect((verify.prepare("SELECT sql FROM sqlite_master WHERE name='tool_proposals'").get() as { sql: string }).sql).toBe(priorToolSql);
    verify.close();
  });

  it("uses an existing exact v36 mechanics link as proof of the historical command key", () => {
    const seeded = seedTurn();
    seeded.repo.executeRollActorDice("local-owner", { commandId: "linked-command", idempotencyKey: seeded.proposal.executionBinding.idempotencyKey,
      campaignId: seeded.campaign.id, timelineId: seeded.campaign.activeTimelineId, actorId: "actor", expectedRevision: 0,
      sourceTurnId: seeded.turn.turnId, command: { type: "roll_actor_dice", payload: { expression: "1d20" } } });
    seeded.repo.linkFinalMechanicsReceipt("local-owner", { turnId: seeded.turn.turnId, proposalId: seeded.proposal.proposalId,
      commandId: "linked-command", expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "link" });
    seeded.repo.close(); const db = new DatabaseDriver(file()); removeV37(db);
    db.prepare("UPDATE meta SET value='36' WHERE key='schemaVersion'").run(); db.close();
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT execution_idempotency_key FROM tool_proposal_execution_bindings_v37 WHERE proposal_id=?")
      .get(seeded.proposal.proposalId)).toEqual({ execution_idempotency_key: seeded.proposal.executionBinding.idempotencyKey });
    verify.close();
  });

  it("rejects a v36 source-turn receipt with no provable proposal binding transactionally", () => {
    const seeded = seedTurn();
    seeded.repo.executeRollActorDice("local-owner", { commandId: "crash", idempotencyKey: seeded.proposal.executionBinding.idempotencyKey,
      campaignId: seeded.campaign.id, timelineId: seeded.campaign.activeTimelineId, actorId: "actor", expectedRevision: 0,
      sourceTurnId: seeded.turn.turnId, command: { type: "roll_actor_dice", payload: { expression: "1d20" } } });
    seeded.repo.close(); const db = new DatabaseDriver(file()); removeV37(db);
    db.prepare("UPDATE meta SET value='36' WHERE key='schemaVersion'").run(); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("lack a provable proposal binding");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "36" });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='tool_proposal_execution_bindings_v37'").get()).toBeUndefined();
    verify.close();
  });

  it("attests its exact additive inventory at startup", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close(); const db = new DatabaseDriver(file());
    db.exec("DROP TRIGGER tool_proposal_execution_bindings_update_v37"); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("v37 tool execution binding object inventory");
  });

  it("refuses malformed future v37 shells on a v36 marker without partial cleanup", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close(); const db = new DatabaseDriver(file());
    db.exec("DROP TRIGGER tool_proposal_execution_bindings_update_v37");
    db.prepare("UPDATE meta SET value='36' WHERE key='schemaVersion'").run(); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("malformed partial future v37 artifacts");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "36" });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='tool_proposal_execution_bindings_v37'").get()).toEqual({ 1: 1 });
    verify.close();
  });
});
