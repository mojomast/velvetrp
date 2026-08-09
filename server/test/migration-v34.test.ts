import DatabaseDriver from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const schema = (name: string) => { const db = new DatabaseDriver(name, { readonly: true }); const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(); db.close(); return rows; };
function rewind(db: DatabaseDriver.Database) {
  db.prepare("UPDATE meta SET value='33' WHERE key='schemaVersion'").run();
  for (const row of db.prepare("SELECT name,type FROM sqlite_master WHERE name GLOB '*v34*'").all() as any[]) if (row.type === "trigger") db.exec(`DROP TRIGGER "${row.name}"`);
  for (const table of ["story_layout_attestation_v34","story_discoveries_v34","story_clue_sources_v34","story_clues_v34","story_plot_point_answers_v34","story_plot_points_v34","story_edges_v34","story_node_state_v34","story_nodes_v34","story_metadata_v34","story_events_v34","story_receipts_v34","story_commands_v34","story_campaign_revisions_v34"]) db.exec(`DROP TABLE "${table}"`);
  db.exec("DROP INDEX uq_storyline_campaign_id_v34");
}
describe("schema v34 story domain", () => {
  it("has migration parity and preserves legacy roots as empty graphs", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! }); const campaign = repo.createCampaign("local-owner", { name: "Migration" });
    const db = new DatabaseDriver(file()); rewind(db); db.prepare("INSERT INTO quest_storylines(id,campaign_id,title,status,created_at) VALUES('legacy',?,'Legacy','active','2035-01-01T00:00:00.000Z')").run(campaign.id); db.close(); repo.close();
    const migratedRepo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! }); expect(migratedRepo.getCampaignStory("local-owner", campaign.id)?.story).toMatchObject({ storylines: [{ storylineId: "legacy" }], nodes: [] }); migratedRepo.close();
    const migrated = new DatabaseDriver(file(), { readonly: true }); expect(migrated.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "36" }); migrated.close();
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "velvet-v34-fresh-")); createRepository({ dataDir: freshDir }).close(); expect(schema(file())).toEqual(schema(path.join(freshDir, "velvet.sqlite"))); fs.rmSync(freshDir, { recursive: true, force: true });
  });
  it("rolls back a rejected malformed legacy ancestry", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! }); const db = new DatabaseDriver(file()); rewind(db); db.pragma("foreign_keys=OFF");
    db.prepare("INSERT INTO quest_storylines(id,campaign_id,title,status,created_at) VALUES('malformed','missing','Bad','active','2035-01-01T00:00:00.000Z')").run(); db.close(); repo.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("malformed storyline ancestry");
    const verify = new DatabaseDriver(file(), { readonly: true }); expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "33" }); expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='story_campaign_revisions_v34'").get()).toBeUndefined(); verify.close();
  });
  it("rejects attestation damage and populated future artifacts without partial cleanup", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! }); const campaign = repo.createCampaign("local-owner", { name: "Future" });
    repo.createCampaignStorylineGraph("local-owner", campaign.id, { storyline: { storylineId: "future-story", title: "Future", summary: null,
      nodes: [], edges: [], plotPoints: [], clues: [] }, expectedRevision: 0, idempotencyKey: "future" }); repo.close();
    const db = new DatabaseDriver(file()); db.prepare("UPDATE meta SET value='33' WHERE key='schemaVersion'").run(); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("populated future v34 story artifact");
    const verify = new DatabaseDriver(file(), { readonly: true }); expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "33" });
    expect(verify.prepare("SELECT count(*) count FROM story_commands_v34").get()).toEqual({ count: 1 }); verify.close();
    fs.rmSync(process.env.VELVET_DATA_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.VELVET_DATA_DIR!, { recursive: true });
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close(); const damaged = new DatabaseDriver(file());
    damaged.exec("DROP TRIGGER story_clue_sources_v34_validate_target"); damaged.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("schema v34 story object inventory is incompatible");
  });
  it.each([
    ["table", "CREATE TABLE unknown_table_v34(value TEXT)"],
    ["view", "CREATE VIEW unknown_view_v34 AS SELECT 1 value"],
    ["index", "CREATE INDEX unknown_index_v34 ON campaigns(name)"],
    ["trigger", "CREATE TRIGGER unknown_trigger_v34 AFTER INSERT ON principals BEGIN SELECT 1; END"],
  ])("rejects an unknown future-v34 %s without cleaning expected artifacts", (_type, sql) => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close(); const db = new DatabaseDriver(file());
    db.prepare("UPDATE meta SET value='33' WHERE key='schemaVersion'").run(); db.exec(sql); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("unknown partial future v34 artifact");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='story_commands_v34'").get()).toEqual({ 1: 1 });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name GLOB 'unknown_*_v34'").get()).toEqual({ 1: 1 }); verify.close();
  });
  it("rejects unknown current-v34 objects rather than blessing them through attestation", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close(); const db = new DatabaseDriver(file());
    db.exec("CREATE VIEW unknown_current_v34 AS SELECT 1 value"); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("story object inventory is incompatible");
  });
});
