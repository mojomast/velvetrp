import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureCurrentSchema } from "../src/repo/db/schema.js";

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");
const predecessorSql = () => asset("currentSchema.sql") + "\n" + asset("campaignDmSchema.sql") + "\n"
  + asset("recallSchema.sql") + "\n" + asset("contextInspectionProvenanceSchema.sql");

describe("agent observation schema migration", () => {
  it("upgrades only the exact predecessor, preserving durable data without backfill", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(predecessorSql());
    db.transaction(() => {
      db.prepare(`INSERT INTO campaigns(id,name,active_timeline_id,owner_principal_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).run("durable-campaign", "Durable", "durable-timeline", "local-owner",
        "2036-01-01T00:00:00.000Z", "2036-01-01T00:00:00.000Z");
      db.prepare("INSERT INTO campaign_timelines(id,campaign_id,created_at) VALUES(?,?,?)")
        .run("durable-timeline", "durable-campaign", "2036-01-01T00:00:00.000Z");
      db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
        .run("durable-campaign", "local-owner", "owner", "2036-01-01T00:00:00.000Z");
    })();
    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare("SELECT name FROM campaigns WHERE id=?").get("durable-campaign")).toEqual({ name: "Durable" });
    expect(db.prepare("SELECT count(*) count FROM agent_observations").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_observations'").get()).toBeTruthy();
    expect(() => db.prepare(`INSERT INTO agent_observations
      (observation_id,campaign_id,timeline_id,agent_kind,agent_id,source_command_id,observed_revision,channel,relayer_agent_id,hop_count,text,authority,created_at)
      VALUES('o',1,'t','npc','a','c',0,'witnessed',NULL,0,'text','rumor','2036-01-01T00:00:00.000Z')`).run())
      .toThrow(/FOREIGN KEY/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("rolls back the knowledge upgrade when final validation fails", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(predecessorSql());
    db.exec("DELETE FROM rpg_effect_modifier_vocabulary_v26");
    expect(() => ensureCurrentSchema(db, ":memory:")).toThrow(/does not match the current development schema/);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_observations'").get()).toBeUndefined();
    db.close();
  });

  it("rejects unknown and partial schemas without repair", () => {
    const unknown = new DatabaseDriver(":memory:");
    unknown.exec("CREATE TABLE unrelated_data(value TEXT)");
    expect(() => ensureCurrentSchema(unknown, ":memory:")).toThrow(/does not match the current development schema/);
    expect(unknown.prepare("SELECT value FROM unrelated_data").get()).toBeUndefined();
    expect(unknown.prepare("SELECT 1 FROM sqlite_master WHERE name='unrelated_data'").get()).toBeTruthy();
    unknown.close();

    const partial = new DatabaseDriver(":memory:");
    partial.exec(predecessorSql());
    partial.exec(asset("npcKnowledgeSchema.sql"));
    partial.exec("DROP TRIGGER agent_observations_update");
    expect(() => ensureCurrentSchema(partial, ":memory:")).toThrow(/does not match the current development schema/);
    partial.close();
  });

  it("accepts an already current schema without guessing", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(predecessorSql());
    ensureCurrentSchema(db, ":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare("SELECT count(*) count FROM agent_observations").get()).toEqual({ count: 0 });
    db.close();
  });
});
