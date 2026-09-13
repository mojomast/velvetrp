import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureCurrentSchema, CAMPAIGN_DELETE_TRIGGER_PREDECESSOR_SQL } from "../src/repo/db/schema.js";

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");
const predecessorSql = () => asset("currentSchema.sql") + "\n" + asset("campaignDmSchema.sql") + "\n"
  + asset("recallSchema.sql") + "\n" + asset("contextInspectionProvenanceSchema.sql") + "\n" + asset("npcKnowledgeSchema.sql");

function durableStore(): DatabaseDriver.Database {
  const db = new DatabaseDriver(":memory:");
  db.exec(predecessorSql());
  db.exec("DROP TRIGGER campaigns_delete_character_drafts_v20");
  db.exec(`${CAMPAIGN_DELETE_TRIGGER_PREDECESSOR_SQL};`);
  db.transaction(() => {
    db.prepare("INSERT INTO campaigns(id,name,active_timeline_id,owner_principal_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("durable-campaign", "Durable", "durable-timeline", "local-owner", "2036-01-01T00:00:00.000Z", "2036-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO campaign_timelines(id,campaign_id,created_at) VALUES(?,?,?)")
      .run("durable-timeline", "durable-campaign", "2036-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
      .run("durable-campaign", "local-owner", "owner", "2036-01-01T00:00:00.000Z");
  })();
  return db;
}

describe("combat marker schema migration", () => {
  it("adds only the marker table to the exact predecessor and preserves durable data", () => {
    const db = durableStore();
    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare("SELECT name FROM campaigns WHERE id=?").get("durable-campaign")).toEqual({ name: "Durable" });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='combat_markers_v64'").get()).toBeTruthy();
    expect(db.prepare("SELECT count(*) count FROM combat_markers_v64").get()).toEqual({ count: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("accepts an already current schema without guessing", () => {
    const db = durableStore();
    ensureCurrentSchema(db, ":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare("SELECT count(*) count FROM combat_markers_v64").get()).toEqual({ count: 0 });
    db.close();
  });
});
