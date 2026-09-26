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

/** The free-form faction/quest/rumor authority clause exactly as published in the current DM schema. */
const FREEFORM_FACTION_QUEST_RUMOR_CLAUSE = `      OR (NEW.action IN ('materialize-faction','materialize-quest','materialize-rumor')
        AND EXISTS(SELECT 1 FROM campaign_content_receipts_v42 content
          WHERE content.campaign_id=run.campaign_id AND content.draft_id=json_extract(NEW.domain_receipt_json,'$.draftId')))
`;

/**
 * Rebuilds the two current DM receipt tables as their exact predecessor that predates the
 * faction/quest/rumor action set, keeping their indexes and authority triggers.
 */
function downgradeDmReceiptActions(db: DatabaseDriver.Database): void {
  for (const table of ["dm_receipts", "dm_composition_receipts"]) {
    const definition = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql IS NOT NULL").all(table) as
      Array<{ name: string; sql: string }>;
    db.exec(`CREATE TEMP TABLE saved AS SELECT * FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(definition.replace(",'materialize-faction','materialize-quest','materialize-rumor'", ""));
    db.exec(`INSERT INTO ${table} SELECT * FROM saved`);
    db.exec("DROP TABLE saved");
    for (const trigger of triggers) {
      db.exec(trigger.sql.includes("'materialize-rumor'") ? trigger.sql.replace(FREEFORM_FACTION_QUEST_RUMOR_CLAUSE, "") : trigger.sql);
    }
  }
}

interface MigratedObject { type: string; name: string; tbl_name: string; sql: string }

function allObjects(db: DatabaseDriver.Database): MigratedObject[] {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as MigratedObject[];
}

function canonicalObjects(): MigratedObject[] {
  const db = new DatabaseDriver(":memory:");
  db.exec(currentSql());
  const objects = allObjects(db);
  db.close();
  return objects;
}

const objectSql = (db: DatabaseDriver.Database, name: string): string =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string }).sql;

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

  it("chains the newest DM receipt actions and the cancelled status from one compound predecessor", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    downgradeEncounterStatus(db);
    downgradeDmReceiptActions(db);
    expect(encounterTableSql(db)).toContain(ENCOUNTER_STATUS_PREDECESSOR_CHECK);
    expect(objectSql(db, "dm_receipts")).not.toContain("'materialize-rumor'");
    expect(objectSql(db, "dm_composition_receipts")).not.toContain("'materialize-rumor'");
    expect(objectSql(db, "dm_receipts_authority")).not.toContain("'materialize-faction'");
    seedCampaignGraph(db, "preparing");
    const campaigns = db.prepare("SELECT * FROM campaigns").all();
    const encounters = db.prepare("SELECT * FROM encounter").all();

    ensureCurrentSchema(db, ":memory:");

    expect(encounterTableSql(db)).toContain(ENCOUNTER_STATUS_CHECK);
    expect(objectSql(db, "dm_receipts")).toContain("'materialize-rumor'");
    expect(objectSql(db, "dm_composition_receipts")).toContain("'materialize-rumor'");
    expect(objectSql(db, "dm_receipts_authority")).toContain("'materialize-faction'");
    expect(objectSql(db, "dm_composition_receipts_authority")).toContain("'materialize-faction'");
    expect(allObjects(db)).toEqual(canonicalObjects());
    expect(db.prepare("SELECT * FROM campaigns").all()).toEqual(campaigns);
    expect(db.prepare("SELECT * FROM encounter").all()).toEqual(encounters);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // A second startup leaves the fully upgraded schema untouched.
    ensureCurrentSchema(db, ":memory:");
    expect(allObjects(db)).toEqual(canonicalObjects());
    expect(db.prepare("SELECT * FROM campaigns").all()).toEqual(campaigns);
    expect(db.prepare("SELECT * FROM encounter").all()).toEqual(encounters);
    db.close();
  });

  it("rejects a compound predecessor whose encounter status drifted to an unrecognized CHECK without repair", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    downgradeEncounterStatus(db);
    downgradeDmReceiptActions(db);
    // Drift the encounter CHECK to a shape no recognized predecessor ever produced.
    const encounterObjects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='encounter' AND sql IS NOT NULL").all() as
      Array<{ type: string; name: string; sql: string }>;
    for (const object of encounterObjects.filter((value) => value.type !== "table")) db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`);
    db.exec("DROP TABLE encounter");
    for (const object of encounterObjects.filter((value) => value.type === "table")) {
      db.exec(object.sql.replace(ENCOUNTER_STATUS_PREDECESSOR_CHECK, "CHECK(status IN ('preparing','active','completed'))"));
    }
    for (const object of encounterObjects.filter((value) => value.type !== "table")) db.exec(object.sql);
    seedCampaignGraph(db, "preparing");
    const before = allObjects(db);
    const encounters = db.prepare("SELECT * FROM encounter").all();

    expect(() => ensureCurrentSchema(db, ":memory:")).toThrow(/current development schema/);

    expect(allObjects(db)).toEqual(before);
    expect(db.prepare("SELECT * FROM encounter").all()).toEqual(encounters);
    db.close();
  });

  it("installs the pre-recall sidecar inside the encounter status predecessor transaction", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    db.exec("DROP TABLE adventure_narration_contexts");
    downgradeEncounterStatus(db);
    seedCampaignGraph(db, "preparing");
    const campaigns = db.prepare("SELECT * FROM campaigns").all();
    const encounters = db.prepare("SELECT * FROM encounter").all();

    ensureCurrentSchema(db, ":memory:");

    expect(objectSql(db, "encounter")).toContain(ENCOUNTER_STATUS_CHECK);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='adventure_narration_contexts'").get()).toBeTruthy();
    expect(allObjects(db)).toEqual(canonicalObjects());
    expect(db.prepare("SELECT * FROM campaigns").all()).toEqual(campaigns);
    expect(db.prepare("SELECT * FROM encounter").all()).toEqual(encounters);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
