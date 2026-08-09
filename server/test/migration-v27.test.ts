import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { removeFutureCombatFoundationV27 } from "./helpers.js";

const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "velvet-v27-"));
const file = (dir: string) => path.join(dir, "velvet.sqlite");

function layout(dir: string): unknown[] {
  const db = new DatabaseDriver(file(dir), { readonly: true });
  const result = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return result;
}

function rewindToV26(dir: string): void {
  const db = new DatabaseDriver(file(dir));
  removeFutureCombatFoundationV27(db);
  db.prepare("UPDATE meta SET value='26' WHERE key='schemaVersion'").run();
  db.close();
}

describe("additive schema v27r1 combat foundation migration", () => {
  it("has fresh/migrated parity and preserves the combat invariants", () => {
    const migrated = makeDir();
    createRepository({ dataDir: migrated }).close();
    rewindToV26(migrated);
    createRepository({ dataDir: migrated }).close();
    const db = new DatabaseDriver(file(migrated));
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "37" });
    expect(db.prepare("SELECT prior_layout_digest,current_layout_digest FROM combat_foundation_layout_attestation_v27").get()).toEqual({
      prior_layout_digest: "7e3fe64f425173022d119f156f60eb36b26af2c97f29d40975f5579caa660f6a",
      current_layout_digest: "5ff782cab830d8c7e934edbae69fde1398b7482531d6b77c7ced8696798737be",
    });
    for (const name of ["encounter", "combatant", "combat_log", "reward_bundle", "reward_entry_v27", "reward_claim_v27", "combat_mutation_revisions_v27", "combat_commands_v27", "combat_receipts_v27", "combat_events_v27"]) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)).toBeTruthy();
    }
    const encounterSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='encounter'").get() as { sql: string }).sql;
    const combatantSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='combatant'").get() as { sql: string }).sql;
    expect(encounterSql).toContain("encounter_kind IN ('prepared','improvised')");
    expect(encounterSql).toContain("status IN ('preparing','active','completed','escaped')");
    expect(combatantSql).toContain("enemy_tactic TEXT NOT NULL DEFAULT 'basic_attack'");
    expect(combatantSql).toContain("status IN ('active','defeated','fled','removed')");
    expect(combatantSql).toContain("team TEXT NOT NULL DEFAULT 'enemies' CHECK(team IN ('allies','enemies'))");
    const rewardEntrySql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='reward_entry_v27'").get() as { sql: string }).sql;
    const rewardClaimSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='reward_claim_v27'").get() as { sql: string }).sql;
    expect(rewardEntrySql).toContain("reward_kind TEXT NOT NULL CHECK(reward_kind='currency')");
    expect(rewardClaimSql).toContain("UNIQUE(reward_bundle_id)");
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='reward_bundle_server_lifecycle_source_v27'").get() as { sql: string }).sql).toContain("event_type='rewards_granted'");
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='uq_encounter_active_session_v27'").get()).toBeTruthy();
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='combat_log_immutable_update_v27'").get() as { sql: string }).sql).toContain("combat logs are immutable");
    db.close();
    const fresh = makeDir();
    createRepository({ dataDir: fresh }).close();
    expect(layout(migrated)).toEqual(layout(fresh));
  });

  it("rolls back v27 DDL and rejects drift or future artifacts", () => {
    const dir = makeDir();
    createRepository({ dataDir: dir }).close();
    rewindToV26(dir);
    const blocked = new DatabaseDriver(file(dir));
    blocked.exec("CREATE TRIGGER reject_schema_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='27' BEGIN SELECT RAISE(ABORT,'reject v27 marker'); END;");
    blocked.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("reject v27 marker");
    const rolledBack = new DatabaseDriver(file(dir));
    expect(rolledBack.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "26" });
    expect(rolledBack.prepare("SELECT 1 FROM sqlite_master WHERE name='encounter'").get()).toBeUndefined();
    rolledBack.close();

    const drift = makeDir();
    createRepository({ dataDir: drift }).close();
    const driftDb = new DatabaseDriver(file(drift));
    driftDb.exec("DROP TRIGGER combat_log_immutable_update_v27; CREATE TRIGGER combat_log_immutable_update_v27 BEFORE UPDATE ON combat_log BEGIN SELECT 1; END;");
    driftDb.close();
    expect(() => createRepository({ dataDir: drift })).toThrow("schema v27 combat foundation canonical SQL is incompatible");

    const future = makeDir();
    createRepository({ dataDir: future }).close();
    const futureDb = new DatabaseDriver(file(future));
    futureDb.prepare("UPDATE meta SET value='26' WHERE key='schemaVersion'").run();
    futureDb.close();
    expect(() => createRepository({ dataDir: future })).toThrow("cannot contain future v27 artifact");
  });
});
