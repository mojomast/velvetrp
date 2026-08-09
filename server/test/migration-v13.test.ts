import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { deleteCampaignForCorruptionTest, makeTmpDataDir, removeFutureCharacterBuilderSchema, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const AT = "2030-04-05T06:07:08.009Z";
const LATER = "2030-04-05T06:07:09.010Z";

const dbPath = (dir: string) => path.join(dir, "velvet.sqlite");

function seedActor(db: DatabaseDriver.Database): void {
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES ('campaign', 'Campaign', 'timeline', 'local-owner', ?, ?)`).run(AT, AT);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
      VALUES ('timeline', 'campaign', ?)`).run(AT);
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES ('campaign', 'local-owner', 'owner', ?)`).run(AT);
  })();
  db.prepare(`INSERT INTO characters
    (id, name, age, archetype, boundaries, fictional_confirmed, is_real_person, created_at)
    VALUES ('persona', 'Persona', 30, 'hero', '', 1, 0, ?)`).run(AT);
  db.prepare(`INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags)
    VALUES ('profile', 'Profile', 'Rules', '[]')`).run();
  db.prepare(`INSERT INTO rpg_content_packs
    (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
    VALUES ('core', '1', 'profile', 'Core', 'Pack', '[]', 0)`).run();
  db.prepare(`INSERT INTO rpg_definitions
    (pack_id, pack_version, kind, definition_id, name, description, tags) VALUES
    ('core', '1', 'race', 'human', 'Human', 'Race', '[]'),
    ('core', '1', 'background', 'sage', 'Sage', 'Background', '[]')`).run();
  db.prepare("UPDATE rpg_content_packs SET sealed = 1").run();
  db.prepare("INSERT INTO campaign_rules_profiles (campaign_id, rules_profile_id) VALUES ('campaign', 'profile')").run();
  db.prepare(`INSERT INTO campaign_content_packs
    (campaign_id, pack_id, pack_version, rules_profile_id) VALUES ('campaign', 'core', '1', 'profile')`).run();
  db.prepare(`INSERT INTO campaign_characters
    (id, campaign_id, character_id, created_at, updated_at) VALUES ('cc', 'campaign', 'persona', ?, ?)`).run(AT, AT);
  db.prepare(`INSERT INTO rpg_campaign_sheets
    (id, campaign_id, campaign_character_id, race_pack_id, race_pack_version, race_kind, race_definition_id,
     background_pack_id, background_pack_version, background_kind, background_definition_id, created_at, updated_at)
    VALUES ('sheet', 'campaign', 'cc', 'core', '1', 'race', 'human',
      'core', '1', 'background', 'sage', ?, ?)`).run(AT, AT);
  db.prepare(`INSERT INTO rpg_character_attributes
    (campaign_id, sheet_id, position, attribute_id, value) VALUES ('campaign', 'sheet', 0, 'strength', 10)`).run();
  db.prepare(`INSERT INTO campaign_actors
    (id, campaign_id, campaign_character_id, sheet_id, kind, control, created_at, updated_at)
    VALUES ('actor', 'campaign', 'cc', 'sheet', 'player-character', 'principal', ?, ?)`).run(AT, AT);

  db.prepare(`INSERT INTO sessions
    (id, character_id, title, state, preset_id, active_leaf_id, created_at, stopped_at, stop_reason)
    VALUES ('session', 'persona', 'Session', 'active', 'default', NULL, ?, NULL, NULL)`).run(AT);
  db.prepare(`INSERT INTO session_characters (session_id, character_id, position)
    VALUES ('session', 'persona', 0)`).run();
  db.prepare(`INSERT INTO messages
    (id, session_id, role, speaker_character_id, content, parent_id, swipe_group_id, swipe_index,
     seq, status, prompt_tokens, completion_tokens, total_tokens, usage_source, usage_model, created_at)
    VALUES ('message', 'session', 'character', 'persona', 'Preserved', NULL, 'message', 0,
      0, 'final', 2, 3, 5, 'provider', 'model', ?)`).run(AT);
  db.prepare("UPDATE sessions SET active_leaf_id = 'message' WHERE id = 'session'").run();
  db.prepare(`INSERT INTO memories
    (id, character_id, kind, content, source_turn_id, created_at, user_approved, forgotten_at)
    VALUES ('memory', 'persona', 'fact', 'Remembered', 'message', ?, 1, NULL)`).run(AT);
  db.prepare(`INSERT INTO lore
    (id, character_id, keys, content, enabled, insertion_order, created_at)
    VALUES ('lore', 'persona', '["key"]', 'Lore', 1, 1, ?)`).run(AT);
  db.prepare("INSERT INTO lore_characters (lore_id, character_id) VALUES ('lore', 'persona')").run();
  db.prepare(`INSERT INTO usage_events
    (id, session_id, source_message_id, kind, prompt_tokens, completion_tokens, total_tokens,
     usage_source, usage_model, created_at)
    VALUES ('usage', 'session', 'message', 'character_reply', 2, 3, 5, 'provider', 'model', ?)`).run(AT);
  db.prepare("INSERT INTO settings (id, payload) VALUES ('fixture-v13', '{\"setting\":true}')").run();
  db.prepare("INSERT INTO provider (id, payload) VALUES ('fixture-v13', '{\"provider\":true}')").run();
}

function seedSecondActor(db: DatabaseDriver.Database): void {
  db.prepare(`INSERT INTO characters
    (id, name, age, archetype, boundaries, fictional_confirmed, is_real_person, created_at)
    VALUES ('persona-two', 'Persona two', 30, 'hero', '', 1, 0, ?)`).run(AT);
  db.prepare(`INSERT INTO campaign_characters
    (id, campaign_id, character_id, created_at, updated_at)
    VALUES ('cc-two', 'campaign', 'persona-two', ?, ?)`).run(AT, AT);
  db.prepare(`INSERT INTO rpg_campaign_sheets
    (id, campaign_id, campaign_character_id, race_pack_id, race_pack_version, race_kind, race_definition_id,
     background_pack_id, background_pack_version, background_kind, background_definition_id, created_at, updated_at)
    VALUES ('sheet-two', 'campaign', 'cc-two', 'core', '1', 'race', 'human',
      'core', '1', 'background', 'sage', ?, ?)`).run(AT, AT);
  db.prepare(`INSERT INTO campaign_actors
    (id, campaign_id, campaign_character_id, sheet_id, kind, control, created_at, updated_at)
    VALUES ('actor-two', 'campaign', 'cc-two', 'sheet-two', 'player-character', 'principal', ?, ?)`).run(AT, AT);
}

const BROAD_TABLES = [
  "characters", "sessions", "session_characters", "messages", "memories", "lore", "lore_characters",
  "settings", "provider", "usage_events", "campaigns", "campaign_timelines", "campaign_memberships",
  "rpg_rules_profiles", "rpg_content_packs", "rpg_definitions", "campaign_rules_profiles",
  "campaign_content_packs", "campaign_characters", "rpg_campaign_sheets", "rpg_character_attributes",
  "campaign_actors",
] as const;

function broadSnapshot(db: DatabaseDriver.Database): Record<string, unknown[]> {
  return Object.fromEntries(BROAD_TABLES.map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function completeAuditSnapshot(db: DatabaseDriver.Database): Record<string, unknown[]> {
  return Object.fromEntries(["campaign_commands", "campaign_events", "command_receipts"].map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

/** Stop the normal chain after its real v11->v12 migration with a failure at
 * the final v13 marker write. This exercises the entire rebuild while producing
 * a faithful, clean v12 fixture without duplicating production v12 DDL. */
function makeV12(dir: string): DatabaseDriver.Database {
  createRepository({ dataDir: dir }).close();
  const db = new DatabaseDriver(dbPath(dir));
  db.pragma("foreign_keys = OFF");
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
    UPDATE meta SET value = '11' WHERE key = 'schemaVersion';
    CREATE TRIGGER reject_v13_marker BEFORE UPDATE OF value ON meta
      WHEN NEW.value = '13'
      BEGIN SELECT RAISE(ABORT, 'reject v13 marker'); END;
  `);
  db.close();
  expect(() => createRepository({ dataDir: dir })).toThrow("reject v13 marker");
  const v12 = new DatabaseDriver(dbPath(dir));
  expect(v12.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "12" });
  expect(v12.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v12'").all()).toEqual([]);
  expect(v12.prepare("SELECT name FROM sqlite_master WHERE name = 'rpg_actor_resources'").get()).toBeUndefined();
  v12.exec("DROP TRIGGER reject_v13_marker");
  return v12;
}

function seedV12Audit(db: DatabaseDriver.Database): void {
  db.prepare(`INSERT INTO campaign_commands
    (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
     source_turn_id, type, attribute_id, value)
    VALUES ('campaign', 'old-command', 'old-key', 'timeline', 'actor', 0,
      'old-turn', 'set_actor_attribute', 'strength', 11)`).run();
  db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
  db.prepare(`INSERT INTO campaign_events
    (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
     revision, occurred_at, attribute_id, value_before, value_after)
    VALUES ('old-event', 'campaign', 'old-command', 'timeline', 'actor', 'old-turn',
      'actor_attribute_set', 1, ?, 'strength', 10, 11)`).run(LATER);
  db.prepare(`INSERT INTO command_receipts
    (campaign_id, command_id, revision_before, revision_after, event_id)
    VALUES ('campaign', 'old-command', 0, 1, 'old-event')`).run();
}

function auditSchema(file: string): unknown[] {
  const db = new DatabaseDriver(file, { readonly: true });
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name IN ('rpg_actor_resources', 'campaign_commands', 'campaign_events', 'command_receipts')
       OR name LIKE 'idx_rpg_actor_resources_%' OR name LIKE 'idx_campaign_commands_%'
       OR name LIKE 'idx_campaign_events_%' OR name LIKE 'idx_command_receipts_%'
    ORDER BY type, name`).all();
  db.close();
  return rows;
}

describe("schema v13 actor resources and union audit", () => {
  it("atomically rebuilds faithful v12 audit rows with fresh-identical DDL", () => {
    const dir = makeTmpDataDir();
    const v12 = makeV12(dir);
    seedActor(v12);
    v12.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value)
      VALUES ('campaign', 'old-command', 'old-key', 'timeline', 'actor', 0,
        'old-turn', 'set_actor_attribute', 'strength', 11)`).run();
    v12.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
    v12.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after)
      VALUES ('old-event', 'campaign', 'old-command', 'timeline', 'actor', 'old-turn',
        'actor_attribute_set', 1, ?, 'strength', 10, 11)`).run(LATER);
    v12.prepare(`INSERT INTO command_receipts
      (campaign_id, command_id, revision_before, revision_after, event_id)
      VALUES ('campaign', 'old-command', 0, 1, 'old-event')`).run();
    const broadBefore = broadSnapshot(v12);
    const before = {
      command: v12.prepare("SELECT * FROM campaign_commands").get(),
      event: v12.prepare("SELECT * FROM campaign_events").get(),
      receipt: v12.prepare("SELECT * FROM command_receipts").get(),
    };
    v12.close();

    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    createRepository({ dataDir: dir, clock: { now }, ids: { nextId } }).close();
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();

    const migrated = new DatabaseDriver(dbPath(dir), { readonly: true });
    expect(migrated.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "38" });
    expect(migrated.prepare("SELECT * FROM campaign_commands").get()).toEqual({
      ...(before.command as object), resource_name: null, resource_current: null, resource_max: null,
      dice_expression: null, dice_count: null, dice_sides: null, dice_selection_type: null,
      dice_selection_count: null, dice_modifier: null,
    });
    expect(migrated.prepare("SELECT * FROM campaign_events").get()).toEqual({
      ...(before.event as object), resource_name: null, resource_current: null, resource_max: null,
    });
    expect(migrated.prepare("SELECT * FROM command_receipts").get()).toEqual(before.receipt);
    expect(broadSnapshot(migrated)).toEqual(broadBefore);
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM rpg_actor_resources").get()).toEqual({ count: 0 });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();

    const freshDir = makeTmpDataDir();
    const freshNow = vi.fn(() => new Date());
    const freshId = vi.fn(() => "unused");
    createRepository({ dataDir: freshDir, clock: { now: freshNow }, ids: { nextId: freshId } }).close();
    expect(freshNow).not.toHaveBeenCalled();
    expect(freshId).not.toHaveBeenCalled();
    const freshDb = new DatabaseDriver(dbPath(freshDir), { readonly: true });
    expect(freshDb.prepare("SELECT COUNT(*) AS count FROM rpg_actor_resources").get()).toEqual({ count: 0 });
    freshDb.close();
    expect(auditSchema(dbPath(dir))).toEqual(auditSchema(dbPath(freshDir)));
  });

  it("rejects semantically mismatched v12 audit rows before rebuilding", () => {
    const dir = makeTmpDataDir();
    const v12 = makeV12(dir);
    seedActor(v12);
    v12.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value)
      VALUES ('campaign', 'old-command', 'old-key', 'timeline', 'actor', 0,
        'old-turn', 'set_actor_attribute', 'strength', 11)`).run();
    v12.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
    v12.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after)
      VALUES ('old-event', 'campaign', 'old-command', 'timeline', 'actor', 'old-turn',
        'actor_attribute_set', 1, ?, 'strength', 10, 11)`).run(LATER);
    v12.prepare(`INSERT INTO command_receipts
      (campaign_id, command_id, revision_before, revision_after, event_id)
      VALUES ('campaign', 'old-command', 0, 1, 'old-event')`).run();
    v12.exec("DROP TRIGGER campaign_events_prevent_update");
    v12.prepare("UPDATE campaign_events SET source_turn_id = NULL WHERE event_id = 'old-event'").run();
    const before = completeAuditSnapshot(v12);
    v12.close();

    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    expect(() => createRepository({ dataDir: dir, clock: { now }, ids: { nextId } }))
      .toThrow("schema v12 command audit is incomplete");
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    const failed = new DatabaseDriver(dbPath(dir), { readonly: true });
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "12" });
    expect(completeAuditSnapshot(failed)).toEqual(before);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v12'").all()).toEqual([]);
    failed.close();
  });

  it.each([
    ["empty history", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER campaign_timelines_advance_revision");
      db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
    }],
    ["trailing gap", (db: DatabaseDriver.Database) => {
      seedV12Audit(db);
      db.exec("DROP TRIGGER campaign_timelines_advance_revision");
      db.prepare("UPDATE campaign_timelines SET revision = 2 WHERE id = 'timeline'").run();
    }],
  ])("rejects v12 timeline revision %s before rebuilding", (_label, corrupt) => {
    const dir = makeTmpDataDir();
    const v12 = makeV12(dir);
    seedActor(v12);
    corrupt(v12);
    v12.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("timeline revision history is incomplete");
    const failed = new DatabaseDriver(dbPath(dir), { readonly: true });
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "12" });
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v12'").all()).toEqual([]);
    failed.close();
  });

  it.each([
    ["command-only identity", (db: DatabaseDriver.Database) => {
      db.prepare(`INSERT INTO campaign_commands
        (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
         source_turn_id, type, attribute_id, value)
        VALUES ('campaign', 'old-command', 'old-key', 'timeline', 'actor', 0,
          NULL, 'set_actor_attribute', 'strength', 11)`).run();
    }],
    ["missing actor parent", (db: DatabaseDriver.Database) => {
      seedV12Audit(db);
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM campaign_actors WHERE id = 'actor'").run();
    }],
    ["missing campaign parent", (db: DatabaseDriver.Database) => {
      seedV12Audit(db);
      db.pragma("foreign_keys = OFF");
      deleteCampaignForCorruptionTest(db,"campaign");db.prepare("DELETE FROM campaigns WHERE id = 'campaign'").run();
    }],
    ["event payload mismatch", (db: DatabaseDriver.Database) => {
      seedV12Audit(db);
      db.exec("DROP TRIGGER campaign_events_prevent_update");
      db.prepare("UPDATE campaign_events SET value_after = 12 WHERE event_id = 'old-event'").run();
    }],
    ["receipt revision mismatch", (db: DatabaseDriver.Database) => {
      seedV12Audit(db);
      db.pragma("foreign_keys = OFF");
      db.exec("DROP TRIGGER command_receipts_prevent_update");
      db.prepare("UPDATE command_receipts SET revision_before = 1, revision_after = 2 WHERE command_id = 'old-command'").run();
    }],
  ])("rejects incomplete v12 audit branch: %s", (_label, corrupt) => {
    const dir = makeTmpDataDir();
    const v12 = makeV12(dir);
    seedActor(v12);
    corrupt(v12);
    v12.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("schema v12 command audit is incomplete");
    const failed = new DatabaseDriver(dbPath(dir), { readonly: true });
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "12" });
    failed.close();
  });

  it("enforces exact names, integer bounds, case identity, composite FKs, and unaudited cascade", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir));
    seedActor(db);
    seedSecondActor(db);
    db.transaction(() => {
      db.prepare(`INSERT INTO campaigns
        (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
        VALUES ('campaign-other', 'Other', 'timeline-other', 'local-owner', ?, ?)`).run(AT, AT);
      db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
        VALUES ('timeline-other', 'campaign-other', ?)`).run(AT);
      db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
        VALUES ('campaign-other', 'local-owner', 'owner', ?)`).run(AT);
    })();

    const insert = db.prepare(`INSERT INTO rpg_actor_resources
      (campaign_id, actor_id, name, current, max) VALUES (?, ?, ?, ?, ?)`);
    insert.run("campaign", "actor", "a", 0, 0);
    insert.run("campaign", "actor", "x".repeat(128), 1_000_000, 1_000_000);
    insert.run("campaign", "actor", "HP", 4, 10);
    insert.run("campaign", "actor", "hp", 4, 10);
    insert.run("campaign", "actor-two", "HP", 2, 8);

    for (const name of ["", "x".repeat(129), "has space", "slash/name", `nul\0suffix`]) {
      expect(() => insert.run("campaign", "actor", name, 0, 0)).toThrow();
    }
    for (const [current, max] of [
      [-1, 0], [0, -1], [0.5, 1], ["one", 1], [0, 1_000_001], [3, 2],
    ] as Array<[unknown, unknown]>) {
      expect(() => insert.run("campaign", "actor", `bad-${String(current)}-${String(max)}`, current, max)).toThrow();
    }
    expect(() => insert.run("campaign", "actor", "HP", 1, 1)).toThrow();
    expect(() => insert.run("campaign", "missing", "mana", 1, 2)).toThrow();
    expect(() => insert.run("campaign-other", "actor", "mana", 1, 2)).toThrow();

    expect(db.prepare("SELECT actor_id, name FROM rpg_actor_resources WHERE name = 'HP' ORDER BY actor_id").all())
      .toEqual([{ actor_id: "actor", name: "HP" }, { actor_id: "actor-two", name: "HP" }]);
    db.prepare("DELETE FROM campaign_actors WHERE id = 'actor-two'").run();
    expect(db.prepare("SELECT 1 FROM rpg_actor_resources WHERE actor_id = 'actor-two'").get()).toBeUndefined();
    db.prepare(`INSERT INTO campaign_actors
      (id, campaign_id, campaign_character_id, sheet_id, kind, control, created_at, updated_at)
      VALUES ('actor-two', 'campaign', 'cc-two', 'sheet-two', 'player-character', 'principal', ?, ?)`).run(AT, AT);
    insert.run("campaign", "actor-two", "campaign-cascade", 1, 1);
    deleteCampaignForCorruptionTest(db,"campaign");db.prepare("DELETE FROM campaigns WHERE id = 'campaign'").run();
    expect(db.prepare("SELECT 1 FROM rpg_actor_resources").get()).toBeUndefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("rejects embedded NUL resource names in state, commands, and events", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir));
    seedActor(db);
    const nul = `hp\0hidden`;
    expect(() => db.prepare(`INSERT INTO rpg_actor_resources
      (campaign_id, actor_id, name, current, max) VALUES ('campaign', 'actor', ?, 1, 2)`).run(nul)).toThrow();
    expect(() => db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, resource_name, resource_current, resource_max)
      VALUES ('campaign', 'nul-command', 'nul-key', 'timeline', 'actor', 0,
        NULL, 'initialize_actor_resource', ?, 1, 2)`).run(nul)).toThrow();

    db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, resource_name, resource_current, resource_max)
      VALUES ('campaign', 'resource-command', 'resource-key', 'timeline', 'actor', 0,
        NULL, 'initialize_actor_resource', 'hp', 1, 2)`).run();
    db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
    expect(() => db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, resource_name, resource_current, resource_max)
      VALUES ('nul-event', 'campaign', 'resource-command', 'timeline', 'actor', NULL,
        'actor_resource_initialized', 1, ?, ?, 1, 2)`).run(LATER, nul)).toThrow();
    db.close();
  });

  it("rolls back a late v12 rebuild exactly and retries to fresh parity", () => {
    const dir = makeTmpDataDir();
    const v12 = makeV12(dir);
    seedActor(v12);
    v12.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value)
      VALUES ('campaign', 'old-command', 'old-key', 'timeline', 'actor', 0,
        NULL, 'set_actor_attribute', 'strength', 11)`).run();
    v12.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
    v12.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after)
      VALUES ('old-event', 'campaign', 'old-command', 'timeline', 'actor', NULL,
        'actor_attribute_set', 1, ?, 'strength', 10, 11)`).run(LATER);
    v12.prepare(`INSERT INTO command_receipts
      (campaign_id, command_id, revision_before, revision_after, event_id)
      VALUES ('campaign', 'old-command', 0, 1, 'old-event')`).run();
    v12.exec(`CREATE TRIGGER reject_v13_marker BEFORE UPDATE OF value ON meta
      WHEN NEW.value = '13'
      BEGIN SELECT RAISE(ABORT, 'late v13 failure'); END`);
    const schemaBefore = v12.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
      ORDER BY type, name`).all();
    const broadBefore = broadSnapshot(v12);
    const auditBefore = completeAuditSnapshot(v12);
    v12.close();

    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    expect(() => createRepository({ dataDir: dir, clock: { now }, ids: { nextId } })).toThrow("late v13 failure");
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    const failed = new DatabaseDriver(dbPath(dir));
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "12" });
    expect(failed.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all())
      .toEqual(schemaBefore);
    expect(broadSnapshot(failed)).toEqual(broadBefore);
    expect(completeAuditSnapshot(failed)).toEqual(auditBefore);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v12'").all()).toEqual([]);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'rpg_actor_resources'").get()).toBeUndefined();
    failed.exec("DROP TRIGGER reject_v13_marker");
    failed.close();

    createRepository({ dataDir: dir, clock: { now }, ids: { nextId } }).close();
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    const freshDir = makeTmpDataDir();
    createRepository({ dataDir: freshDir }).close();
    expect(auditSchema(dbPath(dir))).toEqual(auditSchema(dbPath(freshDir)));
  });

  it("rolls back a late fresh v13 DDL conflict and retries from an empty marker", () => {
    const dir = makeTmpDataDir();
    const file = dbPath(dir);
    const conflict = new DatabaseDriver(file);
    conflict.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE conflict_holder (value TEXT NOT NULL);
      CREATE INDEX idx_campaign_events_actor ON conflict_holder(value);
    `);
    conflict.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/idx_campaign_events_actor already exists/);
    const failed = new DatabaseDriver(file);
    expect(failed.prepare("SELECT * FROM meta").all()).toEqual([]);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'rpg_actor_resources'").get()).toBeUndefined();
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_commands'").get()).toBeUndefined();
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v12'").all()).toEqual([]);
    failed.exec("DROP INDEX idx_campaign_events_actor; DROP TABLE conflict_holder");
    failed.close();

    createRepository({ dataDir: dir }).close();
    const retried = new DatabaseDriver(file, { readonly: true });
    expect(retried.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "38" });
    expect(retried.prepare("SELECT COUNT(*) AS count FROM rpg_actor_resources").get()).toEqual({ count: 0 });
    expect(retried.pragma("foreign_key_check")).toEqual([]);
    retried.close();
  });

  it("enforces exact resource state and both discriminated audit variants", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir));
    seedActor(db);
    const insertResource = db.prepare(`INSERT INTO rpg_actor_resources
      (campaign_id, actor_id, name, current, max) VALUES ('campaign', 'actor', ?, ?, ?)`);
    insertResource.run("HP", 4, 10);
    insertResource.run("hp", 2, 8);
    for (const values of [["bad name", 1, 2], ["mana", -1, 2], ["mana", 3, 2], ["mana", 1, 1000001]] as const) {
      expect(() => insertResource.run(...values)).toThrow();
    }
    expect(() => insertResource.run("HP", 1, 2)).toThrow();

    expect(() => db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value, resource_name, resource_current, resource_max)
      VALUES ('campaign', 'mixed-command', 'mixed-key', 'timeline', 'actor', 0, NULL,
        'initialize_actor_resource', 'strength', 1, 'stamina', 3, 7)`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value, resource_name, resource_current, resource_max)
      VALUES ('campaign', 'mixed-command', 'mixed-key', 'timeline', 'actor', 0, NULL,
        'set_actor_attribute', 'strength', 11, 'stamina', 3, 7)`).run()).toThrow();

    db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, resource_name, resource_current, resource_max)
      VALUES ('campaign', 'resource-command', 'resource-key', 'timeline', 'actor', 0,
        NULL, 'initialize_actor_resource', 'stamina', 3, 7)`).run();
    db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
    expect(() => db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after)
      VALUES ('mixed', 'campaign', 'resource-command', 'timeline', 'actor', NULL,
        'actor_attribute_set', 1, ?, 'strength', 10, 11)`).run(LATER)).toThrow();
    expect(() => db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after,
       resource_name, resource_current, resource_max)
      VALUES ('mixed', 'campaign', 'resource-command', 'timeline', 'actor', NULL,
        'actor_resource_initialized', 1, ?, 'strength', 10, 11, 'stamina', 3, 7)`).run(LATER)).toThrow();
    db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, resource_name, resource_current, resource_max)
      VALUES ('resource-event', 'campaign', 'resource-command', 'timeline', 'actor', NULL,
        'actor_resource_initialized', 1, ?, 'stamina', 3, 7)`).run(LATER);
    db.prepare(`INSERT INTO command_receipts
      (campaign_id, command_id, revision_before, revision_after, event_id)
      VALUES ('campaign', 'resource-command', 0, 1, 'resource-event')`).run();
    for (const statement of [
      "UPDATE campaign_commands SET resource_current = 4 WHERE command_id = 'resource-command'",
      "DELETE FROM campaign_commands WHERE command_id = 'resource-command'",
      "INSERT OR REPLACE INTO campaign_commands SELECT * FROM campaign_commands WHERE command_id = 'resource-command'",
      "UPDATE campaign_events SET resource_current = 4 WHERE event_id = 'resource-event'",
      "DELETE FROM campaign_events WHERE event_id = 'resource-event'",
      "INSERT OR REPLACE INTO campaign_events SELECT * FROM campaign_events WHERE event_id = 'resource-event'",
      "UPDATE command_receipts SET event_id = 'other' WHERE command_id = 'resource-command'",
      "DELETE FROM command_receipts WHERE command_id = 'resource-command'",
      "INSERT OR REPLACE INTO command_receipts SELECT * FROM command_receipts WHERE command_id = 'resource-command'",
    ]) {
      expect(() => db.exec(statement)).toThrow(/immutable/);
    }
    expect(() => db.prepare("DELETE FROM campaign_actors WHERE id = 'actor'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM campaigns WHERE id = 'campaign'").run()).toThrow();
    const resourceFks = db.pragma("foreign_key_list(rpg_actor_resources)") as Array<{
      table: string; from: string; to: string; on_delete: string;
    }>;
    expect(resourceFks).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "campaign_actors", from: "campaign_id", to: "campaign_id", on_delete: "CASCADE" }),
      expect.objectContaining({ table: "campaign_actors", from: "actor_id", to: "id", on_delete: "CASCADE" }),
    ]));
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();

    const repository = createRepository({ dataDir: dir });
    expect(repository.listCampaignEvents("local-owner", "campaign", "timeline")).toEqual([
      expect.objectContaining({ type: "actor_resource_initialized", data: { name: "stamina", current: 3, max: 7 } }),
    ]);
    expect(repository.getCommandReceipt("local-owner", "campaign", "resource-command")?.events[0]?.type)
      .toBe("actor_resource_initialized");

    const corrupt = new DatabaseDriver(dbPath(dir));
    corrupt.exec("DROP TRIGGER campaign_events_prevent_update; PRAGMA ignore_check_constraints = ON");
    corrupt.prepare("UPDATE campaign_events SET attribute_id = 'strength' WHERE event_id = 'resource-event'").run();
    expect(() => repository.listCampaignEvents("local-owner", "campaign", "timeline"))
      .toThrow("audit record is incomplete");
    expect(() => repository.getCommandReceipt("local-owner", "campaign", "resource-command"))
      .toThrow("audit record is incomplete");
    corrupt.prepare("UPDATE campaign_events SET attribute_id = NULL WHERE event_id = 'resource-event'").run();
    corrupt.exec("DROP TRIGGER campaign_commands_prevent_update");
    corrupt.prepare("UPDATE campaign_commands SET attribute_id = 'strength' WHERE command_id = 'resource-command'").run();
    expect(() => repository.listCampaignEvents("local-owner", "campaign", "timeline"))
      .toThrow("audit record is incomplete");
    expect(() => repository.getCommandReceipt("local-owner", "campaign", "resource-command"))
      .toThrow("audit record is incomplete");
    corrupt.prepare("UPDATE campaign_commands SET attribute_id = NULL WHERE command_id = 'resource-command'").run();
    corrupt.close();
    repository.close();

    const cascade = new DatabaseDriver(dbPath(dir));
    cascade.pragma("foreign_keys = ON");
    cascade.exec(`
      DROP TRIGGER command_receipts_prevent_delete;
      DROP TRIGGER campaign_events_prevent_delete;
      DROP TRIGGER campaign_commands_prevent_delete;
      DELETE FROM command_receipts;
      DELETE FROM campaign_events;
      DELETE FROM campaign_commands;
      DELETE FROM campaign_actors WHERE id = 'actor';
    `);
    expect(cascade.prepare("SELECT name FROM rpg_actor_resources").all()).toEqual([]);
    cascade.close();
  });
});
