import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureCurrentSchema, TURN_ECONOMY_GUARD_PREDECESSOR_SQL, CAMPAIGN_DELETE_TRIGGER_PREDECESSOR_SQL } from "../src/repo/db/schema.js";

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");
const currentSql = () => ["currentSchema.sql", "campaignDmSchema.sql", "recallSchema.sql", "contextInspectionProvenanceSchema.sql",
  "npcKnowledgeSchema.sql", "combatMarkerSchema.sql"].map(asset).join("\n");

function predecessorStore(): DatabaseDriver.Database {
  const db = new DatabaseDriver(":memory:");
  db.exec(currentSql());
  db.transaction(() => {
    db.prepare("INSERT INTO campaigns(id,name,active_timeline_id,owner_principal_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("durable-campaign", "Durable", "durable-timeline", "local-owner", "2036-01-01T00:00:00.000Z", "2036-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO campaign_timelines(id,campaign_id,created_at) VALUES(?,?,?)")
      .run("durable-timeline", "durable-campaign", "2036-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
      .run("durable-campaign", "local-owner", "owner", "2036-01-01T00:00:00.000Z");
  })();
  // Regress exactly the update guard and campaign-deletion trigger to their pre-fix form.
  db.exec("DROP TRIGGER combat_turn_economy_v60_guard");
  db.exec(`${TURN_ECONOMY_GUARD_PREDECESSOR_SQL};`);
  db.exec("DROP TRIGGER campaigns_delete_character_drafts_v20");
  db.exec(`${CAMPAIGN_DELETE_TRIGGER_PREDECESSOR_SQL};`);
  return db;
}

describe("turn economy guard migration", () => {
  it("upgrades only the pre-Dash guard and preserves durable data", () => {
    const db = predecessorStore();
    const guardSql = () => (db.prepare("SELECT sql FROM sqlite_master WHERE name='combat_turn_economy_v60_guard'").get() as { sql: string }).sql;
    expect(guardSql()).toBe(TURN_ECONOMY_GUARD_PREDECESSOR_SQL);
    ensureCurrentSchema(db, ":memory:");
    expect(guardSql()).not.toBe(TURN_ECONOMY_GUARD_PREDECESSOR_SQL);
    expect(guardSql()).toContain("NEW.movement_allowance_feet<OLD.movement_allowance_feet");
    expect(db.prepare("SELECT name FROM campaigns WHERE id=?").get("durable-campaign")).toEqual({ name: "Durable" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("accepts an already current schema without guessing", () => {
    const db = predecessorStore();
    ensureCurrentSchema(db, ":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='combat_turn_economy_v60_guard'").get() as { sql: string }).sql)
      .toContain("NEW.movement_allowance_feet<OLD.movement_allowance_feet");
    db.close();
  });
});
