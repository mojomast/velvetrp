import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_DEFINITION_KINDS_CHECK,
  CATALOG_DEFINITION_KINDS_PREDECESSOR_CHECK,
  ensureCurrentSchema,
} from "../src/repo/db/schema.js";

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");
const currentSql = () => ["currentSchema.sql", "campaignDmSchema.sql", "recallSchema.sql", "contextInspectionProvenanceSchema.sql",
  "npcKnowledgeSchema.sql", "combatMarkerSchema.sql"].map(asset).join("\n");
const AT = "2036-01-01T00:00:00.000Z";

/** Rebuilds the exact pre-advancement-catalog schema: narrow kind CHECK and no option table. */
function makePredecessor(db: DatabaseDriver.Database): void {
  db.exec("DROP TABLE character_known_options_v25");
  const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rpg_catalog_definitions'").get() as { sql: string }).sql;
  const dependents = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='rpg_catalog_definitions' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")
    .all() as Array<{ sql: string }>;
  const narrow = tableSql.replace(CATALOG_DEFINITION_KINDS_CHECK, CATALOG_DEFINITION_KINDS_PREDECESSOR_CHECK);
  if (narrow === tableSql) throw new Error("predecessor CHECK replacement failed");
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("CREATE TEMP TABLE rpg_catalog_definitions_predecessor AS SELECT * FROM rpg_catalog_definitions");
      db.exec("DROP TABLE rpg_catalog_definitions");
      db.exec(narrow);
      db.exec("INSERT INTO rpg_catalog_definitions SELECT * FROM rpg_catalog_definitions_predecessor");
      db.exec("DROP TABLE rpg_catalog_definitions_predecessor");
      for (const dependent of dependents) db.exec(dependent.sql);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function durableStore(): DatabaseDriver.Database {
  const db = new DatabaseDriver(":memory:");
  db.exec(currentSql());
  db.prepare("INSERT INTO rpg_rules_profiles(rules_profile_id,name,description,tags) VALUES(?,?,?,?)")
    .run("velvet:test:rules", "Test Rules", "Test rules profile", "[]");
  db.prepare("INSERT INTO rpg_content_packs(pack_id,pack_version,rules_profile_id,name,description,tags,sealed) VALUES(?,?,?,?,?,?,0)")
    .run("velvet:test:pack", "1.0.0", "velvet:test:rules", "Test Pack", "Test pack", "[]");
  db.prepare("INSERT INTO rpg_catalog_definitions(pack_id,pack_version,kind,definition_id,definition_json,public_definition_json,dependencies_json) VALUES(?,?,?,?,?,?,?)")
    .run("velvet:test:pack", "1.0.0", "ability", "velvet:test:ability", "{}", "{}", "[]");
  db.transaction(() => {
    db.prepare("INSERT INTO campaigns(id,name,active_timeline_id,owner_principal_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("migration-campaign", "Migration", "migration-timeline", "local-owner", AT, AT);
    db.prepare("INSERT INTO campaign_timelines(id,campaign_id,created_at) VALUES(?,?,?)")
      .run("migration-timeline", "migration-campaign", AT);
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
      .run("migration-campaign", "local-owner", "owner", AT);
  })();
  return db;
}

describe("character known options schema migration", () => {
  it("widens the catalog kind vocabulary and adds the option table in place", () => {
    const db = durableStore();
    makePredecessor(db);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='character_known_options_v25'").get()).toBeUndefined();
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_catalog_definitions'").get() as { sql: string }).sql).toContain(CATALOG_DEFINITION_KINDS_PREDECESSOR_CHECK);

    ensureCurrentSchema(db, ":memory:");

    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='character_known_options_v25'").get()).toBeTruthy();
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_catalog_definitions'").get() as { sql: string }).sql).toContain(CATALOG_DEFINITION_KINDS_CHECK);
    expect(db.prepare("SELECT definition_id FROM rpg_catalog_definitions WHERE pack_id=? AND kind='ability'").get("velvet:test:pack")).toEqual({ definition_id: "velvet:test:ability" });
    expect(db.prepare("SELECT name FROM campaigns WHERE id=?").get("migration-campaign")).toEqual({ name: "Migration" });
    expect(db.prepare("SELECT count(*) count FROM character_known_options_v25").get()).toEqual({ count: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("accepts an already current schema without guessing", () => {
    const db = durableStore();
    ensureCurrentSchema(db, ":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='character_known_options_v25'").get()).toBeTruthy();
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_catalog_definitions'").get() as { sql: string }).sql).toContain(CATALOG_DEFINITION_KINDS_CHECK);
    expect(db.prepare("SELECT definition_id FROM rpg_catalog_definitions WHERE pack_id=? AND kind='ability'").get("velvet:test:pack")).toEqual({ definition_id: "velvet:test:ability" });
    db.close();
  });
});
