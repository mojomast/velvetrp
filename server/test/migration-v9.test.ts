import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { ADVENTURE_GENERATION_V35_MANAGED_OBJECTS } from "../src/repo/db/migrations/v35_adventure_generation.js";
import { ADVENTURE_HARDENING_V36_MANAGED_OBJECTS, restoreAdventureGenerationV35Guards } from "../src/repo/db/migrations/v36_adventure_hardening.js";
import { TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS } from "../src/repo/db/migrations/v37_tool_execution_bindings.js";
import { deleteCampaignForCorruptionTest, makeTmpDataDir, removeFutureCharacterBuilderSchema, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const V8_TABLES = [
  "characters",
  "sessions",
  "consent_events",
  "session_characters",
  "messages",
  "memories",
  "summaries",
  "session_context",
  "lore",
  "lore_characters",
  "settings",
  "provider",
  "usage_events",
] as const;

function createRepresentativeV8(dir: string): string {
  const repository = createRepository({ dataDir: dir });
  repository.close();
  const dbPath = path.join(dir, "velvet.sqlite");
  const db = new DatabaseDriver(dbPath);
    db.pragma("foreign_keys = OFF");
    // Remove exact empty future adventure layouts before intentionally dismantling their v9 parents.
    for (const [index, inventory] of [TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS, ADVENTURE_HARDENING_V36_MANAGED_OBJECTS, ADVENTURE_GENERATION_V35_MANAGED_OBJECTS].entries()) {
      const names = inventory.map(([, name]) => name);
      const objects = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type,name`)
        .all(...names) as Array<{ type: string; name: string }>;
      for (const object of objects) if (object.type === "trigger") db.exec(`DROP TRIGGER "${object.name}"`);
      for (const object of objects) if (object.type === "index") db.exec(`DROP INDEX IF EXISTS "${object.name}"`);
      const tables = objects.filter((object) => object.type === "table").map((object) => object.name).reverse();
      for (const table of tables) db.exec(`DROP TABLE "${table}"`);
      if (index === 1) restoreAdventureGenerationV35Guards(db);
    }
    removeFutureCharacterBuilderSchema(db);
    db.exec(`
    DROP TRIGGER campaign_timeline_events_immutable_delete; DROP TRIGGER campaign_timeline_events_require_native_event;
    DROP TRIGGER campaign_events_link_timeline; DROP TABLE campaign_timeline_events;
    DROP TABLE rpg_dice_terms;
    DROP TABLE rpg_dice_rolls;
    DROP TABLE rpg_actor_resources;
    DROP TABLE command_receipts;
    DROP TABLE campaign_events;
    DROP TABLE campaign_commands;
    DROP TRIGGER campaign_timelines_advance_revision;
    ALTER TABLE campaign_timelines DROP COLUMN revision;
    DROP TABLE campaign_actor_private_state;
    DROP TABLE campaign_actors;
    DROP TABLE rpg_character_choices;
    DROP TABLE rpg_character_proficiencies;
    DROP TABLE rpg_character_attributes;
    DROP TABLE rpg_character_classes;
    DROP TABLE rpg_campaign_sheets;
    DROP TABLE campaign_characters;
    DROP TABLE campaign_content_packs;
    DROP TABLE campaign_rules_profiles;
    DROP TABLE rpg_definitions;
    DROP TABLE rpg_content_packs;
    DROP TABLE rpg_rules_profiles;
    DROP TABLE campaign_sessions;
    DROP TABLE campaign_memberships;
    DROP TABLE campaign_timelines;
    DROP TABLE campaigns;
    DROP TABLE application_owner;
    DROP TABLE principals;
    UPDATE meta SET value = '8' WHERE key = 'schemaVersion';
    DELETE FROM meta WHERE key = 'schemaRevision';

    INSERT INTO characters VALUES (
      'character/legacy', 'Legacy', 31, 'archivist', 'fictional only', 1, 0,
      '2025-01-01T00:00:00.000Z'
    );
    INSERT INTO sessions VALUES (
      'session/legacy', 'character/legacy', 'Preserved session', 'active', 'default', NULL,
      '2025-01-01T00:01:00.000Z', NULL, NULL
    );
    INSERT INTO consent_events VALUES (
      'consent/legacy', 'session/legacy', 0, '2025-01-01T00:01:00.000Z',
      'scene-created', 1, 'preserved'
    );
    INSERT INTO session_characters VALUES ('session/legacy', 'character/legacy', 0);
    INSERT INTO messages VALUES (
      'message/legacy', 'session/legacy', 'character', 'character/legacy', 'Preserved reply',
      NULL, 'message/legacy', 0, 0, 'final', 10, 5, 15, 'provider', 'legacy-model',
      '2025-01-01T00:02:00.000Z'
    );
    UPDATE sessions SET active_leaf_id = 'message/legacy' WHERE id = 'session/legacy';
    INSERT INTO memories VALUES (
      'memory/legacy', 'character/legacy', 'fact', 'Preserved fact', 'message/legacy',
      '2025-01-01T00:03:00.000Z', 1, NULL
    );
    INSERT INTO summaries VALUES (
      'session/legacy', 'Preserved summary', '["event"]', 'steady', '2025-01-01T00:04:00.000Z'
    );
    INSERT INTO session_context VALUES (
      'session/legacy', 'Manual canon', '2025-01-01T00:05:00.000Z',
      'Synthesized facts', '2025-01-01T00:06:00.000Z'
    );
    INSERT INTO lore VALUES (
      'lore/legacy', 'character/legacy', '["archive"]', 'Preserved lore', 1, 1,
      '2025-01-01T00:07:00.000Z'
    );
    INSERT INTO lore_characters VALUES ('lore/legacy', 'character/legacy');
    INSERT INTO settings VALUES ('harness', '{"id":"harness","updatedAt":"2025-01-01T00:08:00.000Z"}');
    INSERT INTO provider VALUES ('provider', '{"id":"provider","updatedAt":"2025-01-01T00:09:00.000Z"}');
    INSERT INTO usage_events VALUES (
      'usage/legacy', 'session/legacy', 'message/legacy', 'character_reply', 10, 5, 15,
      'provider', 'legacy-model', '2025-01-01T00:02:00.000Z'
    );
  `);
  db.close();
  return dbPath;
}

function snapshotV8(dbPath: string): Record<string, unknown[]> {
  const db = new DatabaseDriver(dbPath, { readonly: true });
  const snapshot = Object.fromEntries(V8_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  db.close();
  return snapshot;
}

function v9Schema(dbPath: string): unknown[] {
  const db = new DatabaseDriver(dbPath, { readonly: true });
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name = 'application_owner' OR name LIKE 'application_owner_%'
      OR name = 'principals' OR name LIKE 'idx_principals_%'
      OR name LIKE 'campaign%' OR name LIKE 'idx_campaign%'
    ORDER BY type, name`).all();
  db.close();
  return rows;
}

describe("schema v9 campaign foundation", () => {
  it("creates the fresh schema without consuming repository dependencies", () => {
    const dir = makeTmpDataDir();
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({ dataDir: dir, clock: { now: clockNow }, ids: { nextId } });
    repository.close();

    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    const db = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    db.pragma("foreign_keys = ON");
      expect((db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("37");
    expect(db.prepare("SELECT * FROM principals").all()).toEqual([{
      id: "local-owner",
      display_name: "Local owner",
      is_local: 1,
    }]);
    expect(db.prepare("SELECT * FROM application_owner").all()).toEqual([{ singleton: 1, principal_id: "local-owner" }]);
    for (const table of ["campaigns", "campaign_timelines", "campaign_memberships", "campaign_sessions"]) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("enforces campaign, timeline, membership, and session-attachment invariants", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    repository.close();
    const db = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    db.pragma("foreign_keys = ON");
    const at = "2030-04-05T06:07:08.009Z";

    expect(() => db.prepare(
      "INSERT INTO principals (id, display_name, is_local) VALUES (?, 'Invalid', 0)",
    ).run("invalid id")).toThrow();
    expect(() => db.prepare(
      "INSERT INTO principals (id, display_name, is_local) VALUES ('second-local', 'Second', 1)",
    ).run()).toThrow();
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES ('principal-gm', 'GM', 0)").run();
    expect(() => db.prepare("DELETE FROM application_owner").run()).toThrow("application owner is required");
    db.prepare("UPDATE application_owner SET principal_id = 'principal-gm' WHERE singleton = 1").run();
    expect(db.prepare("SELECT principal_id FROM application_owner").get()).toEqual({ principal_id: "principal-gm" });
    db.prepare("UPDATE application_owner SET principal_id = 'local-owner' WHERE singleton = 1").run();

    const createCampaign = db.transaction((campaignId: string, timelineId: string) => {
      db.prepare(`INSERT INTO campaigns
        (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
        VALUES (?, ?, ?, 'local-owner', ?, ?)`).run(campaignId, `Campaign ${campaignId}`, timelineId, at, at);
      db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES (?, ?, ?)")
        .run(timelineId, campaignId, at);
      db.prepare("INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at) VALUES (?, 'local-owner', 'owner', ?)")
        .run(campaignId, at);
    });
    createCampaign("campaign-one", "timeline-one");
    createCampaign("campaign-two", "timeline-two");

    expect(() => db.prepare(
      "INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    ).run("campaign-one", "principal-gm", at)).toThrow();
    expect(() => db.prepare(
      "INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at) VALUES (?, ?, 'invalid', ?)",
    ).run("campaign-two", "principal-gm", at)).toThrow();
    expect(() => db.prepare(
      "UPDATE campaign_memberships SET role = 'gm' WHERE campaign_id = 'campaign-one' AND principal_id = 'local-owner'",
    ).run()).toThrow();
    expect(() => db.prepare(
      "DELETE FROM campaign_memberships WHERE campaign_id = 'campaign-one' AND principal_id = 'local-owner'",
    ).run()).toThrow();
    expect(() => db.prepare("UPDATE campaigns SET active_timeline_id = 'timeline-two' WHERE id = 'campaign-one'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM campaign_timelines WHERE id = 'timeline-one'").run()).toThrow();
    expect(() => db.prepare(
      `INSERT INTO campaigns
        (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
        VALUES ('bad-time', 'Bad', 'bad-line', 'local-owner', 'xxxx-xx-xxTxx:xx:xx.xxxZ', ?)`,
    ).run(at)).toThrow();
    expect(() => db.prepare(
      "INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES ('bad-timeline', 'campaign-one', 'not-a-time')",
    ).run()).toThrow();
    expect(() => db.prepare(
      "INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES ('late-timeline', 'campaign-one', '2030-04-05T24:00:00.000Z')",
    ).run()).toThrow();
    expect(() => db.prepare(
      `INSERT INTO campaigns
        (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
        VALUES ('bad-date', 'Bad', 'bad-date-line', 'local-owner', '2030-02-31T06:07:08.009Z', ?)`,
    ).run(at)).toThrow();

    db.prepare(`INSERT INTO characters VALUES (
      'character-existing', 'Existing', 30, 'captain', 'fictional', 1, 0, ?
    )`).run(at);
    db.prepare(`INSERT INTO sessions VALUES (
      'session-existing', 'character-existing', 'Existing session', 'setup', 'default', NULL, ?, NULL, NULL
    )`).run(at);
    db.prepare("INSERT INTO session_characters VALUES ('session-existing', 'character-existing', 0)").run();
    db.prepare("INSERT INTO campaign_sessions (session_id, campaign_id, attached_at) VALUES (?, ?, ?)")
      .run("session-existing", "campaign-one", at);
    expect(() => db.prepare("INSERT INTO campaign_sessions (session_id, campaign_id, attached_at) VALUES (?, ?, ?)")
      .run("session-existing", "campaign-two", at)).toThrow();

    deleteCampaignForCorruptionTest(db,"campaign-one");db.prepare("DELETE FROM campaigns WHERE id = 'campaign-one'").run();
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'session-existing'").get()).toEqual({ id: "session-existing" });
    expect(db.prepare("SELECT * FROM campaign_sessions WHERE session_id = 'session-existing'").get()).toBeUndefined();
    db.prepare("INSERT INTO campaign_sessions (session_id, campaign_id, attached_at) VALUES (?, ?, ?)")
      .run("session-existing", "campaign-two", at);
    db.prepare("DELETE FROM sessions WHERE id = 'session-existing'").run();
    expect(db.prepare("SELECT * FROM campaign_sessions WHERE session_id = 'session-existing'").get()).toBeUndefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("migrates representative v8 data without implicit RPG records or rewrites", () => {
    const dir = makeTmpDataDir();
    const dbPath = createRepresentativeV8(dir);
    const before = snapshotV8(dbPath);
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");

    const repository = createRepository({ dataDir: dir, clock: { now: clockNow }, ids: { nextId } });
    repository.close();

    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(snapshotV8(dbPath)).toEqual(before);
    const db = new DatabaseDriver(dbPath, { readonly: true });
    expect((db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("37");
    expect(db.prepare("SELECT id FROM principals").all()).toEqual([{ id: "local-owner" }]);
    expect(db.prepare("SELECT * FROM application_owner").all()).toEqual([{ singleton: 1, principal_id: "local-owner" }]);
    expect(db.prepare("SELECT * FROM campaigns").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM campaign_timelines").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM campaign_memberships").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM campaign_sessions").all()).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();

    const freshDir = makeTmpDataDir();
    const freshRepository = createRepository({ dataDir: freshDir });
    freshRepository.close();
    expect(v9Schema(dbPath)).toEqual(v9Schema(path.join(freshDir, "velvet.sqlite")));

    const attach = new DatabaseDriver(dbPath);
    attach.pragma("foreign_keys = ON");
    const at = "2030-04-05T06:07:08.009Z";
    attach.transaction(() => {
      attach.prepare(`INSERT INTO campaigns
        (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
        VALUES ('campaign-migrated', 'Migrated', 'timeline-migrated', 'local-owner', ?, ?)`).run(at, at);
      attach.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
        VALUES ('timeline-migrated', 'campaign-migrated', ?)`).run(at);
      attach.prepare("INSERT INTO campaign_memberships VALUES ('campaign-migrated', 'local-owner', 'owner', ?)").run(at);
      attach.prepare("INSERT INTO campaign_sessions VALUES ('session/legacy', 'campaign-migrated', ?)").run(at);
    })();
    expect(attach.prepare("SELECT session_id FROM campaign_sessions").all()).toEqual([{ session_id: "session/legacy" }]);
    attach.close();
  });

  it("rolls back v9 DDL, owner seed, and schemaVersion together and remains retryable", () => {
    const dir = makeTmpDataDir();
    const dbPath = createRepresentativeV8(dir);
    const before = snapshotV8(dbPath);
    const conflict = new DatabaseDriver(dbPath);
    conflict.exec("CREATE TABLE campaign_sessions (sentinel TEXT NOT NULL)");
    conflict.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/campaign_sessions already exists/);

    const verify = new DatabaseDriver(dbPath);
    expect((verify.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("8");
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'principals'").get()).toBeUndefined();
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'application_owner'").get()).toBeUndefined();
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'campaigns'").get()).toBeUndefined();
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_timelines'").get()).toBeUndefined();
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_memberships'").get()).toBeUndefined();
    expect(verify.pragma("table_info(campaign_sessions)")).toEqual([
      expect.objectContaining({ name: "sentinel", type: "TEXT", notnull: 1 }),
    ]);
    verify.exec("DROP TABLE campaign_sessions");
    verify.close();
    expect(snapshotV8(dbPath)).toEqual(before);

    const repository = createRepository({ dataDir: dir });
    repository.close();
    const migrated = new DatabaseDriver(dbPath, { readonly: true });
    expect((migrated.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("37");
    expect(migrated.prepare("SELECT id FROM principals").all()).toEqual([{ id: "local-owner" }]);
    migrated.close();
  });
});
