import DatabaseDriver from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const schema = (databaseFile: string) => { const db = new DatabaseDriver(databaseFile, { readonly: true });
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(); db.close(); return rows; };
function rewindToV32(db: DatabaseDriver.Database): void {
  db.prepare("UPDATE meta SET value='32' WHERE key='schemaVersion'").run();
  for (const row of db.prepare("SELECT name,type FROM sqlite_master WHERE name GLOB '*v33*'").all() as any[]) {
    if (row.type === "trigger") db.exec(`DROP TRIGGER "${row.name}"`);
  }
  for (const table of ["quest_domain_layout_attestation_v33","quest_journal_v33","quest_reward_claims_v33","quest_reward_definitions_v33",
    "quest_objective_progress_v33","quest_objective_dependencies_v33","quest_objectives_v33","quest_definitions_v33",
    "quest_domain_events_v33","quest_domain_receipts_v33","quest_domain_commands_v33","quest_domain_revisions_v33"]) db.exec(`DROP TABLE "${table}"`);
  db.exec("DROP INDEX uq_quest_reward_ancestry_v33; DROP INDEX uq_quest_campaign_id_v33;");
}

describe("schema v33 quest domain", () => {
  it("has fresh/migrated parity and preserves v29 quest rows", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    const campaign = repo.createCampaign("local-owner", { name: "Quest migration" });
    const db = new DatabaseDriver(file()); db.pragma("foreign_keys=ON");
    db.prepare("INSERT INTO quest_storylines(id,campaign_id,title,status,created_at) VALUES(?,?,?,?,?)")
      .run("story", campaign.id, "Legacy", "active", "2035-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO quests VALUES(?,?,?,?,?,?,?,?,?)").run("legacy", "story", campaign.id, "Legacy quest", null,
      "open", 0, "2035-01-01T00:00:00.000Z", "2035-01-01T00:00:00.000Z");
    rewindToV32(db); db.close(); repo.close();
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const migrated = new DatabaseDriver(file(), { readonly: true });
    expect(migrated.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "33" });
    expect(migrated.prepare("SELECT title FROM quests WHERE id='legacy'").get()).toEqual({ title: "Legacy quest" });
    expect(migrated.prepare("SELECT length(layout_digest) length FROM quest_domain_layout_attestation_v33").get()).toEqual({ length: 64 });
    migrated.close();
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "velvet-v33-fresh-")); createRepository({ dataDir: freshDir }).close();
    expect(schema(file())).toEqual(schema(path.join(freshDir, "velvet.sqlite"))); fs.rmSync(freshDir, { recursive: true, force: true });
  });

  it("rejects tampered attested layouts", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const db = new DatabaseDriver(file()); db.exec("DROP TRIGGER quest_domain_events_v33_immutable_delete"); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("schema v33 quest domain is incompatible");
    fs.rmSync(process.env.VELVET_DATA_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.VELVET_DATA_DIR!, { recursive: true });
  });

  it.each(["quest", "reward", "clue"] as const)("rejects malformed legacy %s campaign ancestry before creating v33", (kind) => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    const first = repo.createCampaign("local-owner", { name: "First" }), second = repo.createCampaign("local-owner", { name: "Second" });
    const db = new DatabaseDriver(file()); db.pragma("foreign_keys=OFF"); rewindToV32(db);
    db.prepare("INSERT INTO quest_storylines(id,campaign_id,title,status,created_at) VALUES(?,?,?,?,?)").run("story", first.id, "Story", "active", "2035-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO quests VALUES(?,?,?,?,?,?,?,?,?)").run("quest", "story", kind === "quest" ? second.id : first.id,
      "Quest", null, "open", 0, "2035-01-01T00:00:00.000Z", "2035-01-01T00:00:00.000Z");
    if (kind === "reward") db.prepare("INSERT INTO quest_rewards(id,quest_id,campaign_id,kind,label,created_at) VALUES(?,?,?,?,?,?)")
      .run("reward", "quest", second.id, "custom", "Reward", "2035-01-01T00:00:00.000Z");
    if (kind === "clue") db.prepare("INSERT INTO quest_clues(id,quest_id,campaign_id,content,created_at) VALUES(?,?,?,?,?)")
      .run("clue", "quest", second.id, "Clue", "2035-01-01T00:00:00.000Z");
    db.close(); repo.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow(`malformed ${kind === "quest" ? "quest/storyline" : kind} ancestry`);
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "32" });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='quest_domain_revisions_v33'").get()).toBeUndefined(); verify.close();
  });
});
