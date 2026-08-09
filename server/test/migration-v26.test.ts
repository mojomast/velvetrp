import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { removeFutureCombatFoundationV27 } from "./helpers.js";

const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "velvet-v26-"));
const file = (dir: string) => path.join(dir, "velvet.sqlite");

function layout(dir: string): unknown[] {
  const db = new DatabaseDriver(file(dir), { readonly: true });
  const result = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return result;
}

/** Deliberately remove only the additive v26 fixture artifacts. */
function rewindToV25(dir: string): void {
  const db = new DatabaseDriver(file(dir));
  removeFutureCombatFoundationV27(db);
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v26' OR name GLOB '*_v26_*')").all() as Array<{ name: string }>;
  for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB '*_v26' OR name GLOB '*_v26_*')").all() as Array<{ name: string }>;
  for (const { name } of tables) db.exec(`DROP TABLE ${name}`);
  db.prepare("UPDATE meta SET value='25' WHERE key='schemaVersion'").run();
  db.close();
}

describe("additive schema v26r1 checks, powers, and deterministic effects migration", () => {
  it("creates identical canonical layout fresh and from v25", () => {
    const migrated = makeDir();
    createRepository({ dataDir: migrated }).close();
    rewindToV25(migrated);
    createRepository({ dataDir: migrated }).close();
    const db = new DatabaseDriver(file(migrated), { readonly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "35" });
    expect(db.prepare("SELECT prior_layout_digest,current_layout_digest FROM rpg_checks_powers_effects_layout_attestation_v26").get()).toEqual({
      prior_layout_digest: "a5e3a58f8014978315d20440a0ac087871edac95323d059327faa2fe0a983ef7",
      current_layout_digest: "7e3fe64f425173022d119f156f60eb36b26af2c97f29d40975f5579caa660f6a",
    });
    for (const name of ["rpg_check_results_v26", "rpg_power_uses_v26", "rpg_power_use_costs_v26", "rpg_active_effects_v26", "rpg_effect_modifiers_v26", "rpg_m16_commands_v26", "rpg_m16_receipts_v26", "rpg_m16_events_v26"]) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)).toBeTruthy();
    }
    const checkSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_check_results_v26'").get() as { sql: string }).sql;
    const powerSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_power_uses_v26'").get() as { sql: string }).sql;
    const effectSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_active_effects_v26'").get() as { sql: string }).sql;
    expect(checkSql).toContain("json_array_length(dice_json) BETWEEN 1 AND 32");
    expect(powerSql).toContain("power_kind IN ('ability','spell')");
    expect(powerSql).toContain("REFERENCES rpg_campaign_catalog_definitions_v25");
    expect(effectSql).toContain("concentration_key");
    expect(effectSql).toContain("duration_kind IN ('until_removed','rounds','until_timestamp')");
    const modifierSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_effect_modifiers_v26'").get() as { sql: string }).sql;
    expect(modifierSql).toContain("modifier_kind IN ('flat','proficiency','advantage','resistance','vulnerability','immunity')");
    expect(db.prepare("SELECT modifier_kind FROM rpg_effect_modifier_vocabulary_v26 ORDER BY modifier_kind").all()).toEqual([
      { modifier_kind: "advantage" }, { modifier_kind: "flat" }, { modifier_kind: "immunity" },
      { modifier_kind: "proficiency" }, { modifier_kind: "resistance" }, { modifier_kind: "vulnerability" },
    ]);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rpg_effect_lifecycle_events_v26'").get()).toBeTruthy();
    const lifecycleSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_effect_lifecycle_events_v26'").get() as { sql: string }).sql;
    const lifecycleTriggerSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_effect_lifecycle_events_v26_require_command'").get() as { sql: string }).sql;
    const stateTriggerSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_active_effects_v26_lifecycle_guard'").get() as { sql: string }).sql;
    expect(lifecycleSql).toContain("'concentration_replaced'");
    expect(lifecycleSql).toContain("UNIQUE(campaign_id,actor_id,command_id,effect_id)");
    expect(lifecycleTriggerSql).toContain("NEW.lifecycle_kind='concentration_replaced' AND command.command_type='apply_effect'");
    expect(stateTriggerSql).toContain("event.lifecycle_kind IN ('removed','concentration_replaced')");
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='uq_rpg_active_effects_v26_concentration'").get()).toBeTruthy();
    db.close();
    const fresh = makeDir();
    createRepository({ dataDir: fresh }).close();
    expect(layout(migrated)).toEqual(layout(fresh));
  });

  it("rolls back v26 DDL when the v26 marker fails", () => {
    const dir = makeDir();
    createRepository({ dataDir: dir }).close();
    rewindToV25(dir);
    const db = new DatabaseDriver(file(dir));
    db.exec("CREATE TRIGGER reject_schema_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='26' BEGIN SELECT RAISE(ABORT,'reject v26 marker'); END;");
    db.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("reject v26 marker");
    const rolledBack = new DatabaseDriver(file(dir));
    expect(rolledBack.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "25" });
    expect(rolledBack.prepare("SELECT 1 FROM sqlite_master WHERE name='rpg_check_results_v26'").get()).toBeUndefined();
    rolledBack.close();
  });

  it("allows one apply command to replace concentration through immutable lifecycle facts", () => {
    const dir = makeDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(file(dir));
    db.pragma("foreign_keys = OFF");
    const at = "2035-01-01T00:00:00.000Z";
    db.transaction(() => {
      db.prepare("INSERT INTO rpg_m16_commands_v26(campaign_id,actor_id,command_id,command_family,command_type,idempotency_key,canonical_request_json,request_digest,expected_revision,resulting_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run("campaign", "actor", "apply", "effect", "apply_effect", "apply-key", "{}", "0".repeat(64), 0, 1, at);
      const effect = (effectId: string, commandId: string) => db.prepare("INSERT INTO rpg_active_effects_v26(effect_id,campaign_id,actor_id,command_id,resulting_revision,source_pack_id,source_pack_version,source_kind,source_definition_id,status,concentration_key,duration_kind,remaining_rounds,expires_at,recovery_kind,state_revision,last_lifecycle_event_id,applied_at,updated_at,ended_at) VALUES(?,?,?,?,?,NULL,NULL,NULL,NULL,'active','concentration','until_removed',NULL,NULL,'none',0,NULL,?,?,NULL)")
        .run(effectId, "campaign", "actor", commandId, 1, at, at);
      effect("prior", "prior-apply");
      db.prepare("INSERT INTO rpg_effect_lifecycle_events_v26(lifecycle_event_id,effect_id,campaign_id,actor_id,command_id,resulting_revision,lifecycle_kind,remaining_rounds,occurred_at) VALUES(?,?,?,?,?,?,?,NULL,?)")
        .run("replaced", "prior", "campaign", "actor", "apply", 1, "concentration_replaced", at);
      db.prepare("UPDATE rpg_active_effects_v26 SET status='removed',state_revision=1,last_lifecycle_event_id='replaced',updated_at=?,ended_at=? WHERE effect_id='prior'").run(at, at);
      effect("next", "apply");
      db.prepare("INSERT INTO rpg_effect_lifecycle_events_v26(lifecycle_event_id,effect_id,campaign_id,actor_id,command_id,resulting_revision,lifecycle_kind,remaining_rounds,occurred_at) VALUES(?,?,?,?,?,?,?,NULL,?)")
        .run("applied", "next", "campaign", "actor", "apply", 1, "applied", at);
    })();
    expect(db.prepare("SELECT status,last_lifecycle_event_id FROM rpg_active_effects_v26 WHERE effect_id='prior'").get()).toEqual({ status: "removed", last_lifecycle_event_id: "replaced" });
    expect(() => db.prepare("UPDATE rpg_active_effects_v26 SET status='removed',state_revision=1,updated_at=?,ended_at=? WHERE effect_id='next'").run(at, at)).toThrow("active effects advance only from an immutable lifecycle event");
    db.close();
  });

  it("attests DDL and rejects future artifacts before v26", () => {
    const drift = makeDir();
    createRepository({ dataDir: drift }).close();
    const db = new DatabaseDriver(file(drift));
    db.exec("DROP TRIGGER rpg_m16_events_v26_immutable_update; CREATE TRIGGER rpg_m16_events_v26_immutable_update BEFORE UPDATE ON rpg_m16_events_v26 BEGIN SELECT 1; END;");
    db.close();
    expect(() => createRepository({ dataDir: drift })).toThrow("schema v26 checks/powers/effects canonical SQL is incompatible");

    const future = makeDir();
    createRepository({ dataDir: future }).close();
    const futureDb = new DatabaseDriver(file(future));
    futureDb.prepare("UPDATE meta SET value='25' WHERE key='schemaVersion'").run();
    futureDb.close();
    expect(() => createRepository({ dataDir: future })).toThrow("cannot contain future v26 artifact");
  });
});
