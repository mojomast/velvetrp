import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureCurrentSchema } from "../src/repo/db/schema.js";

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");

/**
 * Every composed schema asset except the actor-journey sidecar under test. This is
 * exactly the complete store that predates the actor-journey generation.
 */
const predecessorSql = () => [
  "currentSchema.sql",
  "campaignDmSchema.sql",
  "recallSchema.sql",
  "contextInspectionProvenanceSchema.sql",
  "npcKnowledgeSchema.sql",
  "combatMarkerSchema.sql",
  "attunementSchema.sql",
  "combatReadyActionSchema.sql",
  "systemOneSchema.sql",
  "combatantLabelSchema.sql",
].map(asset).join("\n");

const AT = "2038-06-01T00:00:00.000Z";
const DIGEST = "a".repeat(64);

/** Builds the exact predecessor and one durable campaign row to survive the upgrade. */
function openPredecessor(): DatabaseDriver.Database {
  const db = new DatabaseDriver(":memory:");
  db.exec(predecessorSql());
  db.transaction(() => {
    db.prepare("INSERT INTO campaigns(id,name,active_timeline_id,owner_principal_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("campaign", "Journey", "timeline", "local-owner", AT, AT);
    db.prepare("INSERT INTO campaign_timelines(id,campaign_id,created_at) VALUES(?,?,?)")
      .run("timeline", "campaign", AT);
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)")
      .run("campaign", "local-owner", "owner", AT);
  })();
  return db;
}

const JOURNEY_OBJECTS = [
  "world_actor_journey_executions_v1",
  "world_actor_journey_executions_v1_journey_id",
  "world_actor_journey_executions_v1_immutable_update",
  "world_actor_journey_executions_v1_immutable_delete",
  "world_route_event_profiles_v1",
];

describe("actor journey schema migration", () => {
  it("installs the sidecar on an exact predecessor without losing existing rows", () => {
    const db = openPredecessor();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='world_actor_journey_executions_v1'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='world_route_event_profiles_v1'").get()).toBeUndefined();

    ensureCurrentSchema(db, ":memory:");

    // Existing data survives; the new execution and metadata tables start empty.
    expect(db.prepare("SELECT name FROM campaigns WHERE id=?").get("campaign")).toEqual({ name: "Journey" });
    expect(db.prepare("SELECT count(*) count FROM world_actor_journey_executions_v1").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM world_route_event_profiles_v1").get()).toEqual({ count: 0 });
    for (const name of JOURNEY_OBJECTS) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), name).toBeTruthy();
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
    // The upgrade is idempotent once the complete inventory is present.
    ensureCurrentSchema(db, ":memory:");
    db.close();
  });

  it("rejects a partial sidecar that installs only some objects", () => {
    const db = openPredecessor();
    db.exec(`CREATE TABLE world_actor_journey_executions_v1 (
      command_id TEXT PRIMARY KEY, campaign_id TEXT, session_id TEXT, actor_id TEXT, turn_id TEXT UNIQUE,
      journey_id TEXT, principal_id TEXT, request_json TEXT, request_digest TEXT, result_json TEXT,
      result_digest TEXT, occurred_at TEXT)`);
    expect(() => ensureCurrentSchema(db, ":memory:")).toThrow(/does not match the current development schema/);
    db.close();
  });

  it("rejects a tampered sidecar table definition", () => {
    const db = openPredecessor();
    const tampered = asset("actorJourneySchema.sql").replace("BETWEEN 0 AND 100", "BETWEEN 0 AND 50");
    db.exec(tampered);
    expect(() => ensureCurrentSchema(db, ":memory:")).toThrow(/does not match the current development schema/);
    db.close();
  });

  it("guards journey executions as append-only", () => {
    const db = openPredecessor();
    ensureCurrentSchema(db, ":memory:");
    // Parent rows are intentionally out of scope for this trigger test; the
    // append-only guards fire independently of foreign-key enforcement.
    db.pragma("foreign_keys=OFF");
    db.prepare(`INSERT INTO world_actor_journey_executions_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "command-1", "campaign", "session", "actor", "turn", "journey", "local-owner",
      JSON.stringify({ destinationLocationId: "B", partyActorIds: ["actor"], previousCommandId: null }), DIGEST,
      JSON.stringify({ destinationLocationId: "B", status: "completed", interruption: null }), DIGEST, AT,
    );
    expect(db.prepare("SELECT count(*) count FROM world_actor_journey_executions_v1").get()).toEqual({ count: 1 });
    expect(() => db.prepare("UPDATE world_actor_journey_executions_v1 SET result_json='{}' WHERE command_id=?")
      .run("command-1")).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM world_actor_journey_executions_v1 WHERE command_id=?").run("command-1"))
      .toThrow(/immutable/);
    expect(db.prepare("SELECT count(*) count FROM world_actor_journey_executions_v1").get()).toEqual({ count: 1 });
    db.close();
  });

  it("keeps route event profiles mutable and bounds their vocabulary", () => {
    const db = openPredecessor();
    ensureCurrentSchema(db, ":memory:");
    db.pragma("foreign_keys=OFF");
    const insert = db.prepare("INSERT INTO world_route_event_profiles_v1 VALUES(?,?,?,?,?)");
    insert.run("campaign", "connection", "urban", "safe", 25);
    db.prepare(`UPDATE world_route_event_profiles_v1 SET environment=?,risk=?,chance_percent=?
      WHERE campaign_id=? AND connection_id=?`).run("water", "dangerous", 80, "campaign", "connection");
    expect(db.prepare("SELECT environment,risk,chance_percent FROM world_route_event_profiles_v1 WHERE campaign_id=? AND connection_id=?")
      .get("campaign", "connection")).toEqual({ environment: "water", risk: "dangerous", chance_percent: 80 });
    expect(() => insert.run("campaign", "bad-environment", "swamp", "safe", 10)).toThrow();
    expect(() => insert.run("campaign", "bad-risk", "urban", "deadly", 10)).toThrow();
    expect(() => insert.run("campaign", "bad-chance", "urban", "safe", 101)).toThrow();
    db.prepare("DELETE FROM world_route_event_profiles_v1 WHERE campaign_id=? AND connection_id=?").run("campaign", "connection");
    expect(db.prepare("SELECT count(*) count FROM world_route_event_profiles_v1").get()).toEqual({ count: 0 });
    db.close();
  });
});
