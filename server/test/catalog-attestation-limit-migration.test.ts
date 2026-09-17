import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_ATTESTATION_LIMIT_CHECK,
  CATALOG_ATTESTATION_LIMIT_PREDECESSOR_CHECK,
  ensureCurrentSchema,
} from "../src/repo/db/schema.js";

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");
const currentSql = () => ["currentSchema.sql", "campaignDmSchema.sql", "recallSchema.sql", "contextInspectionProvenanceSchema.sql",
  "npcKnowledgeSchema.sql", "combatMarkerSchema.sql", "attunementSchema.sql", "combatReadyActionSchema.sql", "systemOneSchema.sql"].map(asset).join("\n");

const TABLE = "rpg_catalog_publication_attestations";

const tableSql = (db: DatabaseDriver.Database) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(TABLE) as { sql: string }).sql;
const triggerNames = (db: DatabaseDriver.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(TABLE) as Array<{ name: string }>)
    .map((row) => row.name);

/** Rebuilds the attestation table at its exact 1024 predecessor, preserving triggers. */
function toPredecessor(db: DatabaseDriver.Database): void {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(TABLE) as Array<{ name: string; sql: string }>;
  const predecessor = tableSql(db).replace(CATALOG_ATTESTATION_LIMIT_CHECK, CATALOG_ATTESTATION_LIMIT_PREDECESSOR_CHECK);
  db.exec(`CREATE TEMP TABLE ${TABLE}_upgrade AS SELECT * FROM ${TABLE}`);
  db.exec(`DROP TABLE ${TABLE}`);
  db.exec(predecessor);
  db.exec(`INSERT INTO ${TABLE} SELECT * FROM ${TABLE}_upgrade`);
  db.exec(`DROP TABLE ${TABLE}_upgrade`);
  for (const trigger of triggers) db.exec(trigger.sql);
}

describe("catalog attestation definition-count limit migration", () => {
  it("widens only the predecessor CHECK and recreates its triggers", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    const currentTriggers = triggerNames(db);
    toPredecessor(db);
    expect(tableSql(db)).toContain(CATALOG_ATTESTATION_LIMIT_PREDECESSOR_CHECK);
    expect(tableSql(db)).not.toContain(CATALOG_ATTESTATION_LIMIT_CHECK);

    ensureCurrentSchema(db, ":memory:");
    expect(tableSql(db)).toContain(CATALOG_ATTESTATION_LIMIT_CHECK);
    expect(triggerNames(db)).toEqual(currentTriggers);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("leaves an already current schema untouched", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    const before = tableSql(db);
    const beforeTriggers = triggerNames(db);
    ensureCurrentSchema(db, ":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect(tableSql(db)).toBe(before);
    expect(triggerNames(db)).toEqual(beforeTriggers);
    db.close();
  });
});
