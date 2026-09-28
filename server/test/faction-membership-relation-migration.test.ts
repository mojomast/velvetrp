import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FACTION_COMMAND_KINDS_CHECK,
  FACTION_COMMAND_KINDS_PREDECESSOR_CHECK,
  FACTION_EVENT_KINDS_CHECK,
  FACTION_EVENT_KINDS_PREDECESSOR_CHECK,
} from "../src/repo/db/factionRelationUpgrade.js";
import { ensureCurrentSchema } from "../src/repo/db/schema.js";

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");
const currentSql = () => ["currentSchema.sql", "campaignDmSchema.sql", "recallSchema.sql", "contextInspectionProvenanceSchema.sql",
  "npcKnowledgeSchema.sql", "combatMarkerSchema.sql", "attunementSchema.sql", "combatReadyActionSchema.sql", "systemOneSchema.sql",
  "combatantLabelSchema.sql"].map(asset).join("\n");

const COMMANDS = "world_narrative_commands_v32";
const EVENTS = "world_narrative_events_v32";
const RELATIONS = "campaign_faction_relations_v32";

const tableSql = (db: DatabaseDriver.Database, table: string) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
const triggerNames = (db: DatabaseDriver.Database, table: string) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table) as Array<{ name: string }>)
    .map((row) => row.name);

/** Rebuilds a narrative table at its predecessor CHECK, preserving its own triggers. */
function rebuild(db: DatabaseDriver.Database, table: string, definition: string): void {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as Array<{ name: string; sql: string }>;
  db.exec(`CREATE TEMP TABLE ${table}_upgrade AS SELECT * FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(definition);
  db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_upgrade`);
  db.exec(`DROP TABLE ${table}_upgrade`);
  for (const trigger of triggers) db.exec(trigger.sql);
}

/** Rebuilds the exact predecessor: old narrative CHECKs and no relation table. */
function toPredecessor(db: DatabaseDriver.Database): void {
  rebuild(db, COMMANDS, tableSql(db, COMMANDS).replace(FACTION_COMMAND_KINDS_CHECK, FACTION_COMMAND_KINDS_PREDECESSOR_CHECK));
  rebuild(db, EVENTS, tableSql(db, EVENTS).replace(FACTION_EVENT_KINDS_CHECK, FACTION_EVENT_KINDS_PREDECESSOR_CHECK));
  db.exec(`DROP TABLE ${RELATIONS}`);
}

describe("faction membership and relation migration", () => {
  it("widens the closed narrative CHECKs and creates the relation table from its exact predecessor", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    const currentCommandTriggers = triggerNames(db, COMMANDS);
    const currentEventTriggers = triggerNames(db, EVENTS);
    toPredecessor(db);
    expect(tableSql(db, COMMANDS)).toContain(FACTION_COMMAND_KINDS_PREDECESSOR_CHECK);
    expect(tableSql(db, EVENTS)).toContain(FACTION_EVENT_KINDS_PREDECESSOR_CHECK);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(RELATIONS)).toBeUndefined();

    ensureCurrentSchema(db, ":memory:");
    expect(tableSql(db, COMMANDS)).toContain(FACTION_COMMAND_KINDS_CHECK);
    expect(tableSql(db, EVENTS)).toContain(FACTION_EVENT_KINDS_CHECK);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(RELATIONS)).toBeDefined();
    expect(triggerNames(db, COMMANDS)).toEqual(currentCommandTriggers);
    expect(triggerNames(db, EVENTS)).toEqual(currentEventTriggers);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("leaves an already current schema untouched", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    const before = tableSql(db, RELATIONS);
    ensureCurrentSchema(db, ":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect(tableSql(db, RELATIONS)).toBe(before);
    db.close();
  });
});
