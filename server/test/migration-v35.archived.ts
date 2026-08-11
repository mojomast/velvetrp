import DatabaseDriver from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { restoreAdventureGenerationV35Guards } from "../src/repo/db/migrations/v36_adventure_hardening.js";
import { TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS } from "../src/repo/db/migrations/v37_tool_execution_bindings.js";
import { DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS } from "../src/repo/db/migrations/v38_durable_agent_execution.js";
import { makeTmpDir, removeFutureAgentSchema, useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const tables = ["adventure_turns", "tool_proposals", "confirmation_decisions", "provider_call_metadata",
  "generation_drafts", "review_decisions", "final_receipt_links"] as const;

function schema(databaseFile: string): unknown[] {
  const db = new DatabaseDriver(databaseFile, { readonly: true });
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return rows;
}

function rewindToV34(db: DatabaseDriver.Database): void {
  removeFutureAgentSchema(db);
  const v38Names = DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS.map(([, name]) => name);
  const v38 = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${v38Names.map(() => "?").join(",")}) AND sql IS NOT NULL`)
    .all(...v38Names) as Array<{ type: string; name: string }>;
  for (const row of v38) if (row.type === "trigger") db.exec(`DROP TRIGGER "${row.name}"`);
  for (const row of v38) if (row.type === "index") db.exec(`DROP INDEX IF EXISTS "${row.name}"`);
  for (const table of ["durable_agent_execution_layout_attestation_v38", "agent_read_outcomes_v38",
    "agent_decision_batch_seals_v38", "agent_tool_calls_v38", "agent_decision_rounds_v38", "agent_provider_starts_v38",
    "agent_execution_operations_v38", "adventure_agent_executions_v38"]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  const v37Names = TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS.map(([, name]) => name);
  const v37 = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${v37Names.map(() => "?").join(",")}) AND sql IS NOT NULL`)
    .all(...v37Names) as Array<{ type: string; name: string }>;
  for (const row of v37) if (row.type === "trigger") db.exec(`DROP TRIGGER "${row.name}"`);
  for (const row of v37) if (row.type === "index") db.exec(`DROP INDEX IF EXISTS "${row.name}"`);
  db.exec("DROP TABLE IF EXISTS tool_execution_binding_layout_attestation_v37; DROP TABLE IF EXISTS tool_proposal_execution_bindings_v37");
  const v36 = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v36*'").all() as Array<{ type: string; name: string }>;
  for (const row of v36) if (row.type === "trigger") db.exec(`DROP TRIGGER "${row.name}"`);
  for (const table of ["adventure_hardening_layout_attestation_v36", "generation_draft_apply_receipts_v36", "turn_mechanics_links_v36",
    "adventure_coordination_receipts_v36", "adventure_coordination_events_v36", "adventure_coordination_commands_v36"]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  for (const row of v36) if (row.type === "index") db.exec(`DROP INDEX IF EXISTS "${row.name}"`);
  restoreAdventureGenerationV35Guards(db);
  const managed = db.prepare(`SELECT type,name FROM sqlite_master WHERE name GLOB '*v35*' OR name IN
    ('adventure_turns','tool_proposals','confirmation_decisions','provider_call_metadata','generation_drafts','review_decisions','final_receipt_links')`).all() as Array<{ type: string; name: string }>;
  for (const row of managed) if (row.type === "trigger") db.exec(`DROP TRIGGER "${row.name}"`);
  for (const table of ["adventure_generation_layout_attestation_v35", "final_receipt_links", "review_decisions", "generation_drafts",
    "provider_call_metadata", "confirmation_decisions", "tool_proposals", "adventure_turns"]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  for (const row of managed) if (row.type === "index") db.exec(`DROP INDEX IF EXISTS "${row.name}"`);
  db.prepare("UPDATE meta SET value='34' WHERE key='schemaVersion'").run();
}

describe("schema v35 adventure turns and generation drafts", () => {
  it("has fresh/migrated parity and preserves populated v34 story data", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    const campaign = repo.createCampaign("local-owner", { name: "V35 migration" });
    repo.createCampaignStorylineGraph("local-owner", campaign.id, { storyline: { storylineId: "legacy-story", title: "Legacy story",
      summary: null, nodes: [], edges: [], plotPoints: [], clues: [] }, expectedRevision: 0, idempotencyKey: "legacy-story" });
    const db = new DatabaseDriver(file());
    rewindToV34(db);
    db.close();
    repo.close();

    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const migrated = new DatabaseDriver(file(), { readonly: true });
    expect(migrated.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(migrated.prepare("SELECT title FROM quest_storylines WHERE id='legacy-story'").get()).toEqual({ title: "Legacy story" });
    expect(migrated.prepare("SELECT length(layout_digest) length FROM adventure_generation_layout_attestation_v35").get()).toEqual({ length: 64 });
    for (const table of tables) expect(migrated.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    migrated.close();

    const freshDir = makeTmpDir("velvet-v35-fresh-");
    createRepository({ dataDir: freshDir }).close();
    expect(schema(file())).toEqual(schema(path.join(freshDir, "velvet.sqlite")));
    fs.rmSync(freshDir, { recursive: true, force: true });
  });

  it("rolls back when the required v34 layout is damaged", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const db = new DatabaseDriver(file());
    rewindToV34(db);
    db.exec("DROP TRIGGER story_clue_sources_v34_validate_target");
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("schema v34 story object inventory is incompatible");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "34" });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='adventure_turns'").get()).toBeUndefined();
    verify.close();
  });

  it("rejects layout tampering at startup", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const db = new DatabaseDriver(file());
    db.exec("DROP TRIGGER provider_call_metadata_guard_insert_v35");
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("schema v35 hardened adventure/generation layout is incompatible");
  });

  it("never cleans populated future v35 data from a v34 marker", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    const campaign = repo.createCampaign("local-owner", { name: "Future draft" });
    repo.close();
    const db = new DatabaseDriver(file());
    const row = db.prepare("SELECT active_timeline_id timelineId,administration_revision revision FROM campaigns WHERE id=?").get(campaign.id) as { timelineId: string; revision: number };
    db.prepare(`INSERT INTO generation_drafts(id,campaign_id,timeline_id,session_id,principal_id,kind,staged_content_json,validation_json,state,
      revision,campaign_revision,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("future-draft", campaign.id,
      row.timelineId, null, "local-owner", "encounter", "{}", "{}", "staged", 0, row.revision, "future-draft", "2035-01-01T00:00:00.000Z", "2035-01-01T00:00:00.000Z");
    db.prepare("UPDATE meta SET value='34' WHERE key='schemaVersion'").run();
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("populated future v35 adventure/generation artifact generation_drafts");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT id FROM generation_drafts").get()).toEqual({ id: "future-draft" });
    verify.close();
  });

  it("rejects unknown partial future-v35 objects without cleaning expected artifacts", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const db = new DatabaseDriver(file());
    db.prepare("UPDATE meta SET value='34' WHERE key='schemaVersion'").run();
    db.exec("CREATE VIEW unknown_future_v35 AS SELECT 1 value");
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("unknown partial future v35 artifact unknown_future_v35");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='adventure_turns'").get()).toEqual({ 1: 1 });
    verify.close();
  });
});
