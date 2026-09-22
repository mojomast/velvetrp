import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMBAT_CONDITIONS_CHECK,
  COMBAT_CONDITIONS_PREDECESSOR_CHECK,
  ensureCurrentSchema,
} from "../src/repo/db/schema.js";

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");
const currentSql = () => ["currentSchema.sql", "campaignDmSchema.sql", "recallSchema.sql", "contextInspectionProvenanceSchema.sql",
  "npcKnowledgeSchema.sql", "combatMarkerSchema.sql", "attunementSchema.sql", "combatReadyActionSchema.sql", "systemOneSchema.sql",
  "combatantLabelSchema.sql"].map(asset).join("\n");

const AT = "2036-01-01T00:00:00.000Z";
const NEW_CONDITIONS = ["deafened", "invisible", "paralyzed", "petrified"] as const;

function conditionTableSql(db: DatabaseDriver.Database): string {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='combat_conditions_v62'").get() as { sql: string }).sql;
}

/** Leaves the prerequisite combat graph in place so the condition row survives foreign_key_check. */
function seedGraph(db: DatabaseDriver.Database): void {
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
    .run("migration-encounter", "migration-campaign", "migration-session", "improvised", "completed", 1, null, 0, AT, AT);
  db.prepare(`INSERT INTO combatant(combatant_id,encounter_id,campaign_id,actor_id,combatant_kind,team,initiative,
    initiative_tiebreaker,hit_points,maximum_hit_points,status,state_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("migration-combatant", "migration-encounter", "migration-campaign", null, "enemy", "enemies", 10, 0, 10, 10, "active", 0, AT, AT);
  db.prepare("INSERT INTO combat_mutation_revisions_v27(encounter_id,revision,updated_at) VALUES(?,?,?)")
    .run("migration-encounter", 1, AT);
  db.prepare(`INSERT INTO combat_commands_v27(encounter_id,command_id,actor_id,command_type,idempotency_key,
    canonical_request_json,request_digest,expected_revision,resulting_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run("migration-encounter", "migration-command", null, "start", "migration-idem", "{}", "0".repeat(64), 0, 1, AT);
  db.prepare(`INSERT INTO combat_conditions_v62(encounter_id,combatant_id,condition,source_combatant_id,
    source_command_id,expires_at_round,applied_at) VALUES(?,?,?,?,?,?,?)`)
    .run("migration-encounter", "migration-combatant", "prone", "migration-combatant", "migration-command", 1_000_000, AT);
}

describe("combat conditions schema migration", () => {
  it("widens only the predecessor CHECK and preserves existing rows", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    seedGraph(db);
    const predecessorSql = conditionTableSql(db).replace(COMBAT_CONDITIONS_CHECK, COMBAT_CONDITIONS_PREDECESSOR_CHECK);
    db.exec("CREATE TEMP TABLE combat_conditions_v62_upgrade AS SELECT * FROM combat_conditions_v62");
    db.exec("DROP TABLE combat_conditions_v62");
    db.exec(predecessorSql);
    db.exec("INSERT INTO combat_conditions_v62 SELECT * FROM combat_conditions_v62_upgrade");
    db.exec("DROP TABLE combat_conditions_v62_upgrade");
    expect(conditionTableSql(db)).toBe(predecessorSql);
    expect(() => db.prepare(`INSERT INTO combat_conditions_v62(encounter_id,combatant_id,condition,source_combatant_id,
      source_command_id,expires_at_round,applied_at) VALUES(?,?,?,?,?,?,?)`)
      .run("migration-encounter", "migration-combatant", "deafened", "migration-combatant", "migration-command", 1_000_000, AT))
      .toThrow(/CHECK/i);

    ensureCurrentSchema(db, ":memory:");
    expect(conditionTableSql(db)).toBe(predecessorSql.replace(COMBAT_CONDITIONS_PREDECESSOR_CHECK, COMBAT_CONDITIONS_CHECK));
    expect(db.prepare("SELECT condition FROM combat_conditions_v62 WHERE encounter_id=? AND combatant_id=?")
      .get("migration-encounter", "migration-combatant")).toEqual({ condition: "prone" });
    for (const condition of NEW_CONDITIONS) {
      db.prepare(`INSERT INTO combat_conditions_v62(encounter_id,combatant_id,condition,source_combatant_id,
        source_command_id,expires_at_round,applied_at) VALUES(?,?,?,?,?,?,?)`)
        .run("migration-encounter", "migration-combatant", condition, "migration-combatant", "migration-command", 1_000_000, AT);
    }
    expect(db.prepare("SELECT count(*) count FROM combat_conditions_v62 WHERE encounter_id=?")
      .get("migration-encounter")).toEqual({ count: 5 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("leaves an already current schema untouched", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(currentSql());
    seedGraph(db);
    const currentTableSql = conditionTableSql(db);
    expect(currentTableSql).toContain(COMBAT_CONDITIONS_CHECK);
    ensureCurrentSchema(db, ":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect(conditionTableSql(db)).toBe(currentTableSql);
    expect(db.prepare("SELECT condition FROM combat_conditions_v62 WHERE encounter_id=? AND combatant_id=?")
      .get("migration-encounter", "migration-combatant")).toEqual({ condition: "prone" });
    db.close();
  });
});
