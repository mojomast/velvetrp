import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { makeTmpDataDir, removeFutureCharacterBuilderSchema, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const AT = "2030-04-05T06:07:08.009Z";
const LATER = "2030-04-05T06:07:09.010Z";
const V12_TABLES = ["campaign_commands", "campaign_events", "command_receipts"] as const;

function databasePath(dir: string): string {
  return path.join(dir, "velvet.sqlite");
}

function removeV12(db: DatabaseDriver.Database): void {
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
  `);
}

function createRepresentativeV11(dir: string, unmarked = false): string {
  const repository = createRepository({ dataDir: dir });
  repository.close();
  const dbPath = databasePath(dir);
  const db = new DatabaseDriver(dbPath);
  removeV12(db);
  if (unmarked) {
    db.exec(`
      DROP TRIGGER campaign_content_packs_require_sealed_insert;
      DROP TRIGGER campaign_content_packs_require_sealed_update;
      DELETE FROM meta WHERE key = 'schemaRevision';
    `);
  }
  seedAggregate(db, "one");
  db.close();
  return dbPath;
}

function seedAggregate(db: DatabaseDriver.Database, suffix: string): void {
  const campaignId = `campaign-${suffix}`;
  const timelineId = `timeline-${suffix}`;
  const personaId = `persona-${suffix}`;
  const campaignCharacterId = `campaign-character-${suffix}`;
  const sheetId = `sheet-${suffix}`;
  const actorId = `actor-${suffix}`;
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, ?, ?, 'local-owner', ?, ?)`).run(campaignId, `Campaign ${suffix}`, timelineId, AT, AT);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
      VALUES (?, ?, ?)`).run(timelineId, campaignId, AT);
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES (?, 'local-owner', 'owner', ?)`).run(campaignId, AT);
  })();
  db.prepare(`INSERT INTO characters
    (id, name, age, archetype, boundaries, fictional_confirmed, is_real_person, created_at)
    VALUES (?, ?, 30, 'guide', 'fictional', 1, 0, ?)`).run(personaId, `Persona ${suffix}`, AT);
  db.prepare(`INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags)
    VALUES (?, ?, 'Rules', '[]')`).run(`profile-${suffix}`, `Profile ${suffix}`);
  db.prepare(`INSERT INTO rpg_content_packs
    (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
    VALUES (?, '1', ?, ?, 'Pack', '[]', 0)`).run(`pack-${suffix}`, `profile-${suffix}`, `Pack ${suffix}`);
  for (const [kind, definitionId] of [
    ["race", "human"], ["background", "guide"], ["class", "fighter"], ["item", "rope"],
  ] as const) {
    db.prepare(`INSERT INTO rpg_definitions
      (pack_id, pack_version, kind, definition_id, name, description, tags)
      VALUES (?, '1', ?, ?, ?, 'Definition', '[]')`)
      .run(`pack-${suffix}`, kind, definitionId, definitionId);
  }
  db.prepare("UPDATE rpg_content_packs SET sealed = 1 WHERE pack_id = ?").run(`pack-${suffix}`);
  db.prepare("INSERT INTO campaign_rules_profiles (campaign_id, rules_profile_id) VALUES (?, ?)")
    .run(campaignId, `profile-${suffix}`);
  db.prepare(`INSERT INTO campaign_content_packs
    (campaign_id, pack_id, pack_version, rules_profile_id) VALUES (?, ?, '1', ?)`)
    .run(campaignId, `pack-${suffix}`, `profile-${suffix}`);
  db.prepare(`INSERT INTO campaign_characters
    (id, campaign_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(campaignCharacterId, campaignId, personaId, AT, AT);
  db.prepare(`INSERT INTO rpg_campaign_sheets
    (id, campaign_id, campaign_character_id,
     race_pack_id, race_pack_version, race_kind, race_definition_id,
     background_pack_id, background_pack_version, background_kind, background_definition_id,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, '1', 'race', 'human', ?, '1', 'background', 'guide', ?, ?)`)
    .run(sheetId, campaignId, campaignCharacterId, `pack-${suffix}`, `pack-${suffix}`, AT, AT);
  db.prepare(`INSERT INTO rpg_character_attributes
    (campaign_id, sheet_id, position, attribute_id, value) VALUES (?, ?, 0, 'strength', 10)`)
    .run(campaignId, sheetId);
  db.prepare(`INSERT INTO rpg_character_classes
    (campaign_id, sheet_id, position, pack_id, pack_version, kind, definition_id, level)
    VALUES (?, ?, 0, ?, '1', 'class', 'fighter', 2)`).run(campaignId, sheetId, `pack-${suffix}`);
  db.prepare(`INSERT INTO rpg_character_proficiencies
    (campaign_id, sheet_id, position, category, proficiency_id)
    VALUES (?, ?, 0, 'skill', 'survival')`).run(campaignId, sheetId);
  db.prepare(`INSERT INTO rpg_character_choices
    (campaign_id, sheet_id, position, choice_id, pack_id, pack_version, kind, definition_id)
    VALUES (?, ?, 0, 'starting-item', ?, '1', 'item', 'rope')`).run(campaignId, sheetId, `pack-${suffix}`);
  db.prepare(`INSERT INTO campaign_actors
    (id, campaign_id, campaign_character_id, sheet_id, kind, control, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'player-character', 'principal', ?, ?)`)
    .run(actorId, campaignId, campaignCharacterId, sheetId, AT, AT);
  db.prepare(`INSERT INTO campaign_actor_private_state
    (actor_id, campaign_id, controller_principal_id, private_notes)
    VALUES (?, ?, 'local-owner', ?)`).run(actorId, campaignId, `Private note ${suffix}`);

  const sessionId = `session-${suffix}`;
  const messageId = `message-${suffix}`;
  db.prepare(`INSERT INTO sessions
    (id, character_id, title, state, preset_id, active_leaf_id, created_at, stopped_at, stop_reason)
    VALUES (?, ?, ?, 'active', 'default', NULL, ?, NULL, NULL)`).run(sessionId, personaId, `Session ${suffix}`, AT);
  db.prepare(`INSERT INTO session_characters (session_id, character_id, position)
    VALUES (?, ?, 0)`).run(sessionId, personaId);
  db.prepare(`INSERT INTO messages
    (id, session_id, role, speaker_character_id, content, parent_id, swipe_group_id, swipe_index,
     seq, status, prompt_tokens, completion_tokens, total_tokens, usage_source, usage_model, created_at)
    VALUES (?, ?, 'character', ?, ?, NULL, ?, 0, 0, 'final', 8, 5, 13, 'provider', 'fixture-model', ?)`)
    .run(messageId, sessionId, personaId, `Preserved reply ${suffix}`, messageId, AT);
  db.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?").run(messageId, sessionId);
  db.prepare(`INSERT INTO memories
    (id, character_id, kind, content, source_turn_id, created_at, user_approved, forgotten_at)
    VALUES (?, ?, 'fact', ?, ?, ?, 1, NULL)`)
    .run(`memory-${suffix}`, personaId, `Preserved memory ${suffix}`, messageId, AT);
  db.prepare(`INSERT INTO lore
    (id, character_id, keys, content, enabled, insertion_order, created_at)
    VALUES (?, ?, '["preserved"]', ?, 1, 1, ?)`)
    .run(`lore-${suffix}`, personaId, `Preserved lore ${suffix}`, AT);
  db.prepare("INSERT INTO lore_characters (lore_id, character_id) VALUES (?, ?)")
    .run(`lore-${suffix}`, personaId);
  db.prepare("INSERT INTO settings (id, payload) VALUES (?, ?)")
    .run(`fixture-${suffix}`, JSON.stringify({ preserved: suffix }));
  db.prepare("INSERT INTO provider (id, payload) VALUES (?, ?)")
    .run(`fixture-${suffix}`, JSON.stringify({ provider: suffix }));
  db.prepare(`INSERT INTO usage_events
    (id, session_id, source_message_id, kind, prompt_tokens, completion_tokens, total_tokens,
     usage_source, usage_model, created_at)
    VALUES (?, ?, ?, 'character_reply', 8, 5, 13, 'provider', 'fixture-model', ?)`)
    .run(`usage-${suffix}`, sessionId, messageId, AT);
}

function insertCommand(
  db: DatabaseDriver.Database,
  suffix = "one",
  commandId = "command-one",
  idempotencyKey = "key-one",
  sourceTurnId: string | null = "turn-one",
  expectedRevision = 0,
): void {
  db.prepare(`INSERT INTO campaign_commands
    (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
     source_turn_id, type, attribute_id, value)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'set_actor_attribute', 'strength', 11)`)
    .run(`campaign-${suffix}`, commandId, idempotencyKey, `timeline-${suffix}`, `actor-${suffix}`, expectedRevision, sourceTurnId);
}

function insertEvent(
  db: DatabaseDriver.Database,
  suffix = "one",
  eventId = "event-one",
  commandId = "command-one",
  sourceTurnId: string | null = "turn-one",
  revision = 1,
): void {
  db.prepare(`INSERT INTO campaign_events
    (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
     revision, occurred_at, attribute_id, value_before, value_after)
    VALUES (?, ?, ?, ?, ?, ?, 'actor_attribute_set', ?, ?, 'strength', 10, 11)`)
    .run(eventId, `campaign-${suffix}`, commandId, `timeline-${suffix}`, `actor-${suffix}`, sourceTurnId, revision, LATER);
}

function insertReceipt(
  db: DatabaseDriver.Database,
  suffix = "one",
  commandId = "command-one",
  eventId = "event-one",
  before = 0,
  after = 1,
): void {
  db.prepare(`INSERT INTO command_receipts
    (campaign_id, command_id, revision_before, revision_after, event_id)
    VALUES (?, ?, ?, ?, ?)`).run(`campaign-${suffix}`, commandId, before, after, eventId);
}

function representativeSnapshot(dbPath: string): Record<string, unknown[]> {
  const db = new DatabaseDriver(dbPath, { readonly: true });
  const tables = [
    "characters", "sessions", "session_characters", "messages", "memories", "lore", "lore_characters",
    "settings", "provider", "usage_events", "campaigns", "campaign_timelines", "campaign_memberships", "rpg_rules_profiles",
    "rpg_content_packs", "rpg_definitions", "campaign_rules_profiles", "campaign_content_packs",
    "campaign_characters", "rpg_campaign_sheets", "rpg_character_classes", "rpg_character_attributes",
    "rpg_character_proficiencies", "rpg_character_choices", "campaign_actors",
    "campaign_actor_private_state",
  ];
  const snapshot = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  db.close();
  return snapshot;
}

function v12Schema(dbPath: string): unknown[] {
  const db = new DatabaseDriver(dbPath, { readonly: true });
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name IN ('campaign_timelines', 'campaign_commands', 'campaign_events', 'command_receipts')
       OR name LIKE 'idx_campaign_commands_%' OR name LIKE 'idx_campaign_events_%'
       OR name LIKE 'idx_command_receipts_%'
    ORDER BY type, name`).all();
  db.close();
  return rows;
}

describe("schema v12 command audit persistence", () => {
  it.each([
    ["revision-1 migrated", false],
    ["unmarked corrected", true],
  ])("gives fresh and %s databases identical DDL while preserving v11 rows", (_label, unmarked) => {
    const migratedDir = makeTmpDataDir();
    const migratedPath = createRepresentativeV11(migratedDir, unmarked);
    const before = representativeSnapshot(migratedPath);
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const migrated = createRepository({ dataDir: migratedDir, clock: { now: clockNow }, ids: { nextId } });
    migrated.close();

    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    const after = representativeSnapshot(migratedPath);
    expect(after).toEqual({
      ...before,
      campaign_timelines: (before.campaign_timelines as Array<Record<string, unknown>>).map((row) => ({ ...row, revision: 0 })),
    });

    const freshDir = makeTmpDataDir();
    const fresh = createRepository({ dataDir: freshDir });
    fresh.close();
    expect(v12Schema(migratedPath)).toEqual(v12Schema(databasePath(freshDir)));

    for (const dbPath of [migratedPath, databasePath(freshDir)]) {
      const db = new DatabaseDriver(dbPath, { readonly: true });
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "33" });
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toEqual({ value: "1" });
      expect((db.pragma("table_info(campaign_timelines)") as Array<{ name: string; dflt_value: string | null }>).at(-1))
        .toEqual(expect.objectContaining({ name: "revision", dflt_value: "0" }));
      for (const table of V12_TABLES) {
        expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
      }
      expect(db.pragma("foreign_key_check")).toEqual([]);
      db.close();
    }
  });

  it("uses only explicit normalized audit columns", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(databasePath(dir), { readonly: true });
    const columns = (table: string) => (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(({ name }) => name);
    expect(columns("campaign_commands")).toEqual([
      "campaign_id", "command_id", "idempotency_key", "timeline_id", "actor_id", "expected_revision",
      "source_turn_id", "type", "attribute_id", "value", "resource_name", "resource_current", "resource_max",
      "dice_expression", "dice_count", "dice_sides", "dice_selection_type", "dice_selection_count", "dice_modifier",
    ]);
    expect(columns("campaign_events")).toEqual([
      "event_id", "campaign_id", "command_id", "timeline_id", "actor_id", "source_turn_id", "type",
      "revision", "occurred_at", "attribute_id", "value_before", "value_after",
      "resource_name", "resource_current", "resource_max",
    ]);
    expect(columns("command_receipts")).toEqual([
      "campaign_id", "command_id", "revision_before", "revision_after", "event_id",
    ]);
    for (const forbidden of ["json", "payload", "data", "created_at", "updated_at", "attribute_definition_id"]) {
      expect(columns("campaign_commands")).not.toContain(forbidden);
    }
    db.close();
  });

  it("enforces campaign-scoped command identity, complete envelopes, and same-campaign restricted parents", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(databasePath(dir));
    seedAggregate(db, "one");
    seedAggregate(db, "two");
    insertCommand(db);
    expect(() => insertCommand(db, "one", "command-one", "key-other")).toThrow();
    expect(() => insertCommand(db, "one", "command-other", "key-one")).toThrow();
    insertCommand(db, "two", "command-one", "key-one");
    expect(() => db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value)
      VALUES ('campaign-one', 'cross', 'cross', 'timeline-two', 'actor-one', 0,
       NULL, 'set_actor_attribute', 'strength', 11)`).run()).toThrow();
    for (const [column, value] of [["expected_revision", 9007199254740991], ["value", 1001], ["type", "generic"]] as const) {
      expect(() => db.prepare(`UPDATE campaign_commands SET ${column} = ? WHERE campaign_id = 'campaign-one'`).run(value))
        .toThrow("campaign commands are immutable");
    }
    expect(() => db.prepare("DELETE FROM campaign_timelines WHERE id = 'timeline-one'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM campaign_actors WHERE id = 'actor-one'").run()).toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("allows timeline revisions to advance only by exactly one", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(databasePath(dir));
    seedAggregate(db, "one");
    const update = db.prepare("UPDATE campaign_timelines SET revision = ? WHERE id = 'timeline-one'");
    for (const invalid of [0, -1, 2]) {
      expect(() => update.run(invalid)).toThrow("campaign timeline revision must advance exactly once");
    }
    expect(db.prepare("SELECT revision FROM campaign_timelines WHERE id = 'timeline-one'").get()).toEqual({ revision: 0 });
    update.run(1);
    for (const invalid of [0, 1, 3]) {
      expect(() => update.run(invalid)).toThrow("campaign timeline revision must advance exactly once");
    }
    update.run(2);
    expect(db.prepare("SELECT revision FROM campaign_timelines WHERE id = 'timeline-one'").get()).toEqual({ revision: 2 });
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at, revision)
      VALUES ('timeline-max', 'campaign-one', ?, ?)`).run(AT, Number.MAX_SAFE_INTEGER);
    expect(() => db.prepare("UPDATE campaign_timelines SET revision = revision + 1 WHERE id = 'timeline-max'").run())
      .toThrow();
    expect(db.prepare("SELECT revision FROM campaign_timelines WHERE id = 'timeline-max'").get())
      .toEqual({ revision: Number.MAX_SAFE_INTEGER });
    db.close();
  });

  it("rejects events when the command revision is skipped or the timeline is lagging or ahead", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(databasePath(dir));
    seedAggregate(db, "one");
    insertCommand(db);

    // The command expects event revision 1, but the timeline has not advanced.
    expect(() => insertEvent(db)).toThrow("campaign event must match its command envelope");
    db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline-one'").run();
    // Revision 2 skips the command's exact expectedRevision + 1.
    expect(() => insertEvent(db, "one", "event-skipped", "command-one", "turn-one", 2))
      .toThrow("campaign event must match its command envelope");
    insertEvent(db);

    insertCommand(db, "one", "command-two", "key-two", "turn-two", 1);
    db.prepare("UPDATE campaign_timelines SET revision = 2 WHERE id = 'timeline-one'").run();
    db.prepare("UPDATE campaign_timelines SET revision = 3 WHERE id = 'timeline-one'").run();
    // The event matches expectedRevision + 1 but is behind the current timeline.
    expect(() => insertEvent(db, "one", "event-ahead", "command-two", "turn-two", 2))
      .toThrow("campaign event must match its command envelope");
    expect((db.prepare("SELECT COUNT(*) AS count FROM campaign_events").get() as { count: number }).count).toBe(1);
    db.close();
  });

  it("enforces matching immutable events, global IDs, one event per command and timeline revision", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(databasePath(dir));
    seedAggregate(db, "one");
    insertCommand(db);
    db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline-one'").run();
    const mismatches = [
      ["timeline_id", "missing"], ["actor_id", "missing"], ["source_turn_id", "other-turn"],
      ["attribute_id", "dexterity"], ["value_after", 12],
    ] as const;
    for (const [column, value] of mismatches) {
      const event = {
        timeline_id: "timeline-one",
        actor_id: "actor-one",
        source_turn_id: "turn-one" as string | null,
        attribute_id: "strength",
        value_after: 11 as string | number,
        [column]: value,
      };
      expect(() => db.prepare(`INSERT INTO campaign_events
        (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
         revision, occurred_at, attribute_id, value_before, value_after)
        VALUES ('event-bad', 'campaign-one', 'command-one', ?, ?, ?,
         'actor_attribute_set', 1, ?, ?, 10, ?)`)
        .run(event.timeline_id, event.actor_id, event.source_turn_id, LATER, event.attribute_id, event.value_after)).toThrow();
    }
    expect(() => db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after)
      VALUES ('bad-time', 'campaign-one', 'command-one', 'timeline-one', 'actor-one', 'turn-one',
       'actor_attribute_set', 1, 'not-a-time', 'strength', 10, 11)`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after)
      VALUES ('same', 'campaign-one', 'command-one', 'timeline-one', 'actor-one', 'turn-one',
       'actor_attribute_set', 1, ?, 'strength', 10, 10)`).run(LATER)).toThrow();
    insertEvent(db);
    expect(() => insertEvent(db, "one", "event-two")).toThrow();
    expect(() => db.prepare("UPDATE campaign_events SET occurred_at = ?").run(AT)).toThrow("campaign events are immutable");
    expect(() => db.prepare("DELETE FROM campaign_events").run()).toThrow("campaign events are immutable");
    db.close();
  });

  it("matches nullable source turns in both directions and keeps event IDs global across campaigns", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(databasePath(dir));
    seedAggregate(db, "one");
    seedAggregate(db, "two");
    db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id IN ('timeline-one', 'timeline-two')").run();

    insertCommand(db, "one", "command-null", "key-null", null);
    expect(() => insertEvent(db, "one", "event-null-mismatch", "command-null", "turn-present"))
      .toThrow("campaign event must match its command envelope");
    insertCommand(db, "one", "command-present", "key-present", "turn-present");
    expect(() => insertEvent(db, "one", "event-present-mismatch", "command-present", null))
      .toThrow("campaign event must match its command envelope");

    insertCommand(db, "one", "command-one", "key-one");
    insertCommand(db, "two", "command-two", "key-two", "turn-two");
    insertEvent(db, "one", "event-global", "command-one");
    expect(() => insertEvent(db, "two", "event-global", "command-two", "turn-two"))
      .toThrow();
    insertEvent(db, "two", "event-other", "command-two", "turn-two");
    expect(db.prepare("SELECT event_id, campaign_id FROM campaign_events ORDER BY event_id").all()).toEqual([
      { event_id: "event-global", campaign_id: "campaign-one" },
      { event_id: "event-other", campaign_id: "campaign-two" },
    ]);
    db.close();
  });

  it("requires exact expected-revision receipts and makes commands, events, and receipts undeletable", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(databasePath(dir));
    seedAggregate(db, "one");
    insertCommand(db);
    db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline-one'").run();
    insertEvent(db);
    expect(() => insertReceipt(db, "one", "command-one", "event-one", 1, 2))
      .toThrow("command receipt must match its expected revision");
    expect(() => insertReceipt(db, "one", "command-one", "event-one", 0, 2)).toThrow();
    expect(() => insertReceipt(db, "one", "command-one", "missing", 0, 1)).toThrow();
    insertReceipt(db);
    expect(() => insertReceipt(db)).toThrow();
    expect(() => db.prepare("UPDATE command_receipts SET event_id = 'other'").run()).toThrow("command receipts are immutable");
    expect(() => db.prepare("DELETE FROM command_receipts").run()).toThrow("command receipts are immutable");
    expect(() => db.prepare("DELETE FROM campaign_events").run()).toThrow("campaign events are immutable");
    expect(() => db.prepare("DELETE FROM campaign_commands").run()).toThrow("campaign commands are immutable");
    expect(() => db.prepare("DELETE FROM campaigns WHERE id = 'campaign-one'").run()).toThrow();
    db.prepare("DELETE FROM rpg_character_attributes WHERE campaign_id = 'campaign-one'").run();
    expect(db.prepare("SELECT COUNT(*) AS commands FROM campaign_commands").get()).toEqual({ commands: 1 });
    expect(db.prepare("SELECT COUNT(*) AS events FROM campaign_events").get()).toEqual({ events: 1 });
    expect(db.prepare("SELECT COUNT(*) AS receipts FROM command_receipts").get()).toEqual({ receipts: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("blocks INSERT OR REPLACE for every immutable unique identity with recursive triggers disabled", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(databasePath(dir));
    db.pragma("recursive_triggers = OFF");
    seedAggregate(db, "one");
    insertCommand(db);
    db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline-one'").run();
    insertEvent(db);
    insertReceipt(db);
    const before = Object.fromEntries(V12_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));

    expect(() => db.exec("INSERT OR REPLACE INTO campaign_commands SELECT * FROM campaign_commands"))
      .toThrow("campaign commands are immutable");
    expect(() => db.exec(`INSERT OR REPLACE INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value, resource_name, resource_current, resource_max)
      SELECT campaign_id, 'replacement-command', idempotency_key, timeline_id, actor_id,
        expected_revision, source_turn_id, type, attribute_id, value,
        resource_name, resource_current, resource_max FROM campaign_commands`))
      .toThrow("campaign commands are immutable");
    expect(() => db.exec("INSERT OR REPLACE INTO campaign_events SELECT * FROM campaign_events"))
      .toThrow("campaign events are immutable");
    expect(() => db.exec(`INSERT OR REPLACE INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after,
       resource_name, resource_current, resource_max)
      SELECT 'replacement-event', campaign_id, command_id, timeline_id, actor_id, source_turn_id,
        type, revision, occurred_at, attribute_id, value_before, value_after,
        resource_name, resource_current, resource_max FROM campaign_events`))
      .toThrow("campaign events are immutable");
    expect(() => db.exec("INSERT OR REPLACE INTO command_receipts SELECT * FROM command_receipts"))
      .toThrow("command receipts are immutable");
    expect(Object.fromEntries(V12_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])))
      .toEqual(before);
    db.close();
  });

  it("corrects malformed unmarked v11 before attempting v12 and remains repairable", () => {
    const dir = makeTmpDataDir();
    const dbPath = createRepresentativeV11(dir, true);
    const malformed = new DatabaseDriver(dbPath);
    malformed.pragma("foreign_keys = OFF");
    malformed.prepare("UPDATE campaign_content_packs SET pack_version = 'missing' WHERE campaign_id = 'campaign-one'").run();
    malformed.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/schema v11 correction blocked/);
    const failed = new DatabaseDriver(dbPath);
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "11" });
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toBeUndefined();
    expect(failed.pragma("table_info(campaign_timelines)")).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "revision" })]));
    for (const table of V12_TABLES) {
      expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table)).toBeUndefined();
    }
    failed.pragma("foreign_keys = OFF");
    failed.prepare("UPDATE campaign_content_packs SET pack_version = '1' WHERE campaign_id = 'campaign-one'").run();
    failed.close();
    createRepository({ dataDir: dir }).close();
    const repaired = new DatabaseDriver(dbPath, { readonly: true });
    expect(repaired.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "33" });
    expect(repaired.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toEqual({ value: "1" });
    repaired.close();
  });

  it("commits a valid unmarked-v11 correction before a failed v12 migration, then retries v12", () => {
    const dir = makeTmpDataDir();
    const dbPath = createRepresentativeV11(dir, true);
    const before = representativeSnapshot(dbPath);
    const conflict = new DatabaseDriver(dbPath);
    conflict.exec("CREATE TABLE command_receipts (sentinel TEXT NOT NULL)");
    conflict.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/command_receipts already exists/);
    const failed = new DatabaseDriver(dbPath);
    // v11 correction is intentionally its own committed transaction.
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "11" });
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toEqual({ value: "1" });
    expect(failed.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'
      AND name LIKE 'campaign_content_packs_require_sealed_%' ORDER BY name`).all()).toEqual([
      { name: "campaign_content_packs_require_sealed_insert" },
      { name: "campaign_content_packs_require_sealed_update" },
    ]);
    // The later v12 transaction rolls back its ALTER and all preceding DDL.
    expect((failed.pragma("table_info(campaign_timelines)") as Array<{ name: string }>).some(({ name }) => name === "revision"))
      .toBe(false);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_commands'").get()).toBeUndefined();
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_events'").get()).toBeUndefined();
    failed.exec("DROP TABLE command_receipts");
    failed.close();
    expect(representativeSnapshot(dbPath)).toEqual(before);

    createRepository({ dataDir: dir }).close();
    const retried = new DatabaseDriver(dbPath, { readonly: true });
    expect(retried.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "33" });
    expect(retried.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toEqual({ value: "1" });
    for (const table of V12_TABLES) {
      expect(retried.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table)).toEqual({ name: table });
    }
    expect(retried.pragma("foreign_key_check")).toEqual([]);
    retried.close();
  });

  it("rolls back a late migrated v12 failure and retries without partial DDL", () => {
    const dir = makeTmpDataDir();
    const dbPath = createRepresentativeV11(dir);
    const before = representativeSnapshot(dbPath);
    const conflict = new DatabaseDriver(dbPath);
    conflict.exec("CREATE TABLE command_receipts (sentinel TEXT NOT NULL)");
    conflict.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/command_receipts already exists/);
    const failed = new DatabaseDriver(dbPath);
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "11" });
    expect((failed.pragma("table_info(campaign_timelines)") as Array<{ name: string }>).some(({ name }) => name === "revision")).toBe(false);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_commands'").get()).toBeUndefined();
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_events'").get()).toBeUndefined();
    failed.exec("DROP TABLE command_receipts");
    failed.close();
    expect(representativeSnapshot(dbPath)).toEqual(before);

    createRepository({ dataDir: dir }).close();
    const retried = new DatabaseDriver(dbPath, { readonly: true });
    expect(retried.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "33" });
    expect(retried.pragma("foreign_key_check")).toEqual([]);
    retried.close();
  });

  it("rolls back a late fresh v12 failure and retries from an empty marker", () => {
    const dir = makeTmpDataDir();
    const dbPath = databasePath(dir);
    const db = new DatabaseDriver(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE command_receipts (sentinel TEXT NOT NULL);
    `);
    db.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/command_receipts already exists/);
    const failed = new DatabaseDriver(dbPath);
    expect(failed.prepare("SELECT * FROM meta").all()).toEqual([]);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_timelines'").get()).toBeUndefined();
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_commands'").get()).toBeUndefined();
    failed.exec("DROP TABLE command_receipts");
    failed.close();

    createRepository({ dataDir: dir }).close();
    const retried = new DatabaseDriver(dbPath, { readonly: true });
    expect(retried.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "33" });
    expect(retried.pragma("foreign_key_check")).toEqual([]);
    retried.close();
  });

  it("reopens revision 1 without schema writes and rejects unknown revisions", () => {
    const dir = makeTmpDataDir();
    const dbPath = databasePath(dir);
    createRepository({ dataDir: dir }).close();
    const before = new DatabaseDriver(dbPath);
    const schemaVersion = before.pragma("schema_version", { simple: true });
    const schema = before.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    before.close();
    createRepository({ dataDir: dir }).close();
    const after = new DatabaseDriver(dbPath);
    expect(after.pragma("schema_version", { simple: true })).toBe(schemaVersion);
    expect(after.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schema);
    after.prepare("UPDATE meta SET value = 'unexpected' WHERE key = 'schemaRevision'").run();
    after.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("unsupported schemaRevision unexpected; expected 1");
  });
});
