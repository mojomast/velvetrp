import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { removeFutureWorldTravelNpcFactionV28 } from "./helpers.js";

const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "velvet-v28-"));
const file = (dir: string) => path.join(dir, "velvet.sqlite");

function layout(dir: string): unknown[] {
  const db = new DatabaseDriver(file(dir), { readonly: true });
  const result = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return result;
}

function rewindToV27(dir: string): void {
  const db = new DatabaseDriver(file(dir));
  removeFutureWorldTravelNpcFactionV28(db);
  db.prepare("UPDATE meta SET value='27' WHERE key='schemaVersion'").run();
  db.close();
}

describe("additive schema v28r1 world/travel/NPC/faction migration", () => {
  it("has fresh/migrated parity and preserves world boundaries", () => {
    const migrated = makeDir();
    createRepository({ dataDir: migrated }).close();
    rewindToV27(migrated);
    createRepository({ dataDir: migrated }).close();
    const db = new DatabaseDriver(file(migrated));
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "37" });
    expect(db.prepare("SELECT prior_layout_digest,current_layout_digest FROM world_travel_layout_attestation_v28").get()).toEqual({
      prior_layout_digest: "5ff782cab830d8c7e934edbae69fde1398b7482531d6b77c7ced8696798737be",
       current_layout_digest: "2f6001699f45ecc90c426e05065d0ef004196c4419a5fbe2a94cd7e3770688c7",
    });
    for (const name of ["campaign_locations_v28", "campaign_location_connections_v28", "campaign_location_discoveries_v28", "campaign_actor_locations_v28", "campaign_npcs_v28", "campaign_npc_private_state_v28", "campaign_factions_v28", "campaign_reputation_ledger_v28", "world_commands_v28", "world_receipts_v28", "world_events_v28"]) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)).toBeTruthy();
    }
    const connection = (db.prepare("SELECT sql FROM sqlite_master WHERE name='campaign_location_connections_v28'").get() as { sql: string }).sql;
    expect(connection).toContain("requirement_kind IN ('none','discovery','faction_reputation')");
    expect(connection).toContain("UNIQUE(campaign_id,from_location_id,to_location_id)");
    const npc = (db.prepare("SELECT sql FROM sqlite_master WHERE name='campaign_npcs_v28'").get() as { sql: string }).sql;
    expect(npc).toContain("FOREIGN KEY(persona_id) REFERENCES characters(id)");
    expect(npc).toContain("UNIQUE(campaign_id,persona_id)");
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='world_commands_v28_immutable_update'").get() as { sql: string }).sql).toContain("world commands are immutable");
    db.close();
    const fresh = makeDir();
    createRepository({ dataDir: fresh }).close();
    expect(layout(migrated)).toEqual(layout(fresh));
  });

  it("rolls back v28 DDL and rejects drift or future artifacts", () => {
    const dir = makeDir();
    createRepository({ dataDir: dir }).close();
    rewindToV27(dir);
    const blocked = new DatabaseDriver(file(dir));
    blocked.exec("CREATE TRIGGER reject_schema_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='28' BEGIN SELECT RAISE(ABORT,'reject v28 marker'); END;");
    blocked.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("reject v28 marker");
    const rolledBack = new DatabaseDriver(file(dir));
    expect(rolledBack.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "27" });
    expect(rolledBack.prepare("SELECT 1 FROM sqlite_master WHERE name='campaign_locations_v28'").get()).toBeUndefined();
    rolledBack.close();

    const drift = makeDir();
    createRepository({ dataDir: drift }).close();
    const driftDb = new DatabaseDriver(file(drift));
    driftDb.exec("DROP TRIGGER world_commands_v28_immutable_update; CREATE TRIGGER world_commands_v28_immutable_update BEFORE UPDATE ON world_commands_v28 BEGIN SELECT 1; END;");
    driftDb.close();
    expect(() => createRepository({ dataDir: drift })).toThrow("schema v28 world/travel canonical SQL is incompatible");

    const future = makeDir();
    createRepository({ dataDir: future }).close();
    const futureDb = new DatabaseDriver(file(future));
    futureDb.prepare("UPDATE meta SET value='27' WHERE key='schemaVersion'").run();
    futureDb.close();
    expect(() => createRepository({ dataDir: future })).toThrow("cannot contain future v28 artifact");
  });
});
