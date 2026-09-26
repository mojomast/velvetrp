import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENCOUNTER_STATUS_CHECK,
  ENCOUNTER_STATUS_PREDECESSOR_CHECK,
  ensureCurrentSchema,
} from "../src/repo/db/schema.js";

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");
const currentSql = () => ["currentSchema.sql", "campaignDmSchema.sql", "recallSchema.sql", "contextInspectionProvenanceSchema.sql",
  "npcKnowledgeSchema.sql", "combatMarkerSchema.sql", "attunementSchema.sql", "combatReadyActionSchema.sql", "systemOneSchema.sql",
  "combatantLabelSchema.sql"].map(asset).join("\n");

const AT = "2036-01-01T00:00:00.000Z";

const encounterTableSql = (db: DatabaseDriver.Database): string =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='encounter'").get() as { sql: string }).sql;

/** Rebuilds the current encounter table as its exact cancelled-status predecessor, keeping its indexes and triggers. */
function downgradeEncounterStatus(db: DatabaseDriver.Database): void {
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='encounter' AND sql IS NOT NULL").all() as
    Array<{ type: string; name: string; sql: string }>;
  for (const object of objects.filter((value) => value.type !== "table")) db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`);
  db.exec("DROP TABLE encounter");
  for (const object of objects.filter((value) => value.type === "table")) {
    db.exec(object.sql.replace(ENCOUNTER_STATUS_CHECK, ENCOUNTER_STATUS_PREDECESSOR_CHECK));
  }
  for (const object of objects.filter((value) => value.type !== "table")) db.exec(object.sql);
}

function seedCampaignGraph(db: DatabaseDriver.Database, status: string): void {
  db.prepare("INSERT INTO characters(id,name,age,archetype,boundaries,fictional_confirmed,is_real_person,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("migration-character", "Migrator", 30, "Tester", "none", 1, 0, AT);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,?,?,?,?)")
    .run("migration-session", "migration-character", "Migration", "idle", "preset", AT);
  db.transaction(() => {
    db.prepare("INSERT INTO campaigns(id,name,active_timeline_id,owner_principal_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("migration-campaign", "Migration", "migration-timeline", "local-owner", AT, AT);
    db.prepare("INSERT INTO campaign_timelines(id,campaign_id,created_at) VALUES(?,?,?)")
      .run("migration-timeline", "migration-campaign", AT);
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
      .run("migration-campaign", "local-owner", "owner", AT);
  })();
  db.prepare("INSERT INTO campaign_sessions(session_id,campaign_id,attached_at) VALUES(?,?,?)")
    .run("migration-session", "migration-campaign", AT);
  db.prepare(`INSERT INTO encounter(encounter_id,campaign_id,session_id,encounter_kind,status,round_number,
    current_turn_combatant_id,state_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run("migration-encounter", "migration-campaign", "migration-session", "prepared", status, 0, null, 0, AT, AT);
}

describe("encounter cancelled status schema migration", () => {
  it("widens only the predecessor CHECK and preserves existing encounters", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    downgradeEncounterStatus(db);
    expect(encounterTableSql(db)).toContain(ENCOUNTER_STATUS_PREDECESSOR_CHECK);
    seedCampaignGraph(db, "preparing");
    const insertCancelled = () => db.prepare(`INSERT INTO encounter(encounter_id,campaign_id,session_id,encounter_kind,status,round_number,
      current_turn_combatant_id,state_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run("migration-cancelled", "migration-campaign", "migration-session", "prepared", "cancelled", 0, null, 0, AT, AT);
    expect(insertCancelled).toThrow(/CHECK/i);

    ensureCurrentSchema(db, ":memory:");
    expect(encounterTableSql(db)).toContain(ENCOUNTER_STATUS_CHECK);
    expect(db.prepare("SELECT status FROM encounter WHERE encounter_id='migration-encounter'").get())
      .toEqual({ status: "preparing" });
    // The widened status is now accepted by the rebuilt CHECK, and its indexes/triggers survived.
    insertCancelled();
    expect(db.prepare("SELECT status FROM encounter WHERE encounter_id='migration-cancelled'").get()).toEqual({ status: "cancelled" });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_encounter_active_session_v27'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='encounter_state_guard_v27'").get()).toBeTruthy();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("leaves an already current schema untouched", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    seedCampaignGraph(db, "preparing");
    const currentTableSql = encounterTableSql(db);
    expect(currentTableSql).toContain(ENCOUNTER_STATUS_CHECK);
    ensureCurrentSchema(db, ":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect(encounterTableSql(db)).toBe(currentTableSql);
    expect(db.prepare("SELECT status FROM encounter WHERE encounter_id='migration-encounter'").get()).toEqual({ status: "preparing" });
    db.close();
  });
});
