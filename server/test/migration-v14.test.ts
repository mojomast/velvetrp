import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { makeTmpDataDir, removeFutureCharacterBuilderSchema, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const AT = "2030-04-05T06:07:08.009Z";
const LATER = "2030-04-05T06:07:09.010Z";
const dbPath = (dir: string) => path.join(dir, "velvet.sqlite");

/** Reuse the production migration chain to produce a faithful v13 database. */
function makeV13(dir: string): DatabaseDriver.Database {
  createRepository({ dataDir: dir }).close();
  const db = new DatabaseDriver(dbPath(dir));
  db.pragma("foreign_keys = OFF");
  removeFutureCharacterBuilderSchema(db);
  db.exec(`
    DROP TRIGGER campaign_timeline_events_immutable_delete; DROP TRIGGER campaign_timeline_events_require_native_event;
    DROP TRIGGER campaign_events_link_timeline; DROP TABLE campaign_timeline_events;
    DROP TABLE rpg_dice_terms;
    DROP TABLE rpg_dice_rolls;
    DROP TABLE command_receipts;
    DROP TABLE campaign_events;
    DROP TABLE campaign_commands;
    DROP TABLE rpg_actor_resources;
    DROP TRIGGER campaign_timelines_advance_revision;
    ALTER TABLE campaign_timelines DROP COLUMN revision;
    UPDATE meta SET value = '11' WHERE key = 'schemaVersion';
    CREATE TRIGGER reject_v14_marker BEFORE UPDATE OF value ON meta
      WHEN NEW.value = '14' BEGIN SELECT RAISE(ABORT, 'reject v14 marker'); END;
  `);
  db.close();
  expect(() => createRepository({ dataDir: dir })).toThrow("reject v14 marker");
  const v13 = new DatabaseDriver(dbPath(dir));
  expect(v13.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "13" });
  expect(v13.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v13'").all()).toEqual([]);
  v13.exec("DROP TRIGGER reject_v14_marker");
  return v13;
}

function seedActor(db: DatabaseDriver.Database): void {
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES ('campaign', 'Campaign', 'timeline', 'local-owner', ?, ?)`).run(AT, AT);
    db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES ('timeline', 'campaign', ?)").run(AT);
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES ('campaign', 'local-owner', 'owner', ?)`).run(AT);
  })();
  db.prepare(`INSERT INTO characters
    (id, name, age, archetype, boundaries, fictional_confirmed, is_real_person, created_at)
    VALUES ('persona', 'Persona', 30, 'hero', '', 1, 0, ?)`).run(AT);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile', 'Profile', 'Rules', '[]')").run();
  db.prepare(`INSERT INTO rpg_content_packs
    (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
    VALUES ('core', '1', 'profile', 'Core', 'Pack', '[]', 0)`).run();
  db.prepare(`INSERT INTO rpg_definitions
    (pack_id, pack_version, kind, definition_id, name, description, tags) VALUES
    ('core', '1', 'race', 'human', 'Human', 'Race', '[]'),
    ('core', '1', 'background', 'sage', 'Sage', 'Background', '[]')`).run();
  db.prepare("UPDATE rpg_content_packs SET sealed = 1").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES ('campaign', 'profile')").run();
  db.prepare("INSERT INTO campaign_content_packs VALUES ('campaign', 'core', '1', 'profile')").run();
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
}

function seedAttributeAudit(db: DatabaseDriver.Database): void {
  db.prepare(`INSERT INTO campaign_commands
    (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
      source_turn_id, type, attribute_id, value)
    VALUES ('campaign', 'old-command', 'old-key', 'timeline', 'actor', 0,
      NULL, 'set_actor_attribute', 'strength', 11)`).run();
  db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
  db.prepare(`INSERT INTO campaign_events
    (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
      revision, occurred_at, attribute_id, value_before, value_after)
    VALUES ('old-event', 'campaign', 'old-command', 'timeline', 'actor', NULL,
      'actor_attribute_set', 1, ?, 'strength', 10, 11)`).run(LATER);
  db.prepare(`INSERT INTO command_receipts
    (campaign_id, command_id, revision_before, revision_after, event_id)
    VALUES ('campaign', 'old-command', 0, 1, 'old-event')`).run();
}

function seedResourceAudit(db: DatabaseDriver.Database): void {
  db.prepare(`INSERT INTO campaign_commands
    (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
      source_turn_id, type, resource_name, resource_current, resource_max)
    VALUES ('campaign', 'resource-command', 'resource-key', 'timeline', 'actor', 1,
      'resource-turn', 'initialize_actor_resource', 'MP', 3, 9)`).run();
  db.prepare("UPDATE campaign_timelines SET revision = 2 WHERE id = 'timeline'").run();
  db.prepare(`INSERT INTO campaign_events
    (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
      revision, occurred_at, resource_name, resource_current, resource_max)
    VALUES ('resource-event', 'campaign', 'resource-command', 'timeline', 'actor',
      'resource-turn', 'actor_resource_initialized', 2, ?, 'MP', 3, 9)`).run(LATER);
  db.prepare(`INSERT INTO command_receipts
    (campaign_id, command_id, revision_before, revision_after, event_id)
    VALUES ('campaign', 'resource-command', 1, 2, 'resource-event')`).run();
}

const V13_PRESERVED_TABLES = [
  "rpg_actor_resources", "campaign_commands", "campaign_events", "command_receipts",
] as const;

function snapshotTables(db: DatabaseDriver.Database, tables: readonly string[]): Record<string, unknown[]> {
  return Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function completeSchema(db: DatabaseDriver.Database): unknown[] {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
}

const AUDIT_TABLES = [
  "rpg_actor_resources", "campaign_commands", "campaign_events", "command_receipts",
  "rpg_dice_rolls", "rpg_dice_terms",
  "campaigns", "campaign_timeline_history", "campaign_administration_commands",
  "campaign_administration_events", "campaign_administration_receipts", "campaign_checkpoints",
  "campaign_recaps", "campaign_imports", "campaign_export_manifests",
] as const;

function auditSchema(file: string): unknown[] {
  const db = new DatabaseDriver(file, { readonly: true });
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name IN (${AUDIT_TABLES.map(() => "?").join(",")})
       OR name = 'campaign_timelines_advance_revision'
    ORDER BY type, name`).all(...AUDIT_TABLES);
  db.close();
  return rows;
}

type DiceFixture = {
  expression: string;
  count: number;
  sides: number;
  selection: "all" | "keep_highest" | "keep_lowest" | "advantage" | "disadvantage";
  selectionCount: number | null;
  modifier: number;
  terms: Array<[value: number, kept: number]>;
  total: number;
};

function insertDiceFixture(db: DatabaseDriver.Database, fixture: DiceFixture): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
        source_turn_id, type, dice_expression, dice_count, dice_sides,
        dice_selection_type, dice_selection_count, dice_modifier)
      VALUES ('campaign', 'dice-command', 'dice-key', 'timeline', 'actor', 0, NULL,
        'roll_actor_dice', ?, ?, ?, ?, ?, ?)`).run(
      fixture.expression, fixture.count, fixture.sides, fixture.selection,
      fixture.selectionCount, fixture.modifier,
    );
    db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
    db.prepare(`INSERT INTO rpg_dice_rolls
      (event_id, campaign_id, command_id, expression, dice_count, dice_sides,
        selection_type, selection_count, modifier, total)
      VALUES ('dice-event', 'campaign', 'dice-command', ?, ?, ?, ?, ?, ?, ?)`).run(
      fixture.expression, fixture.count, fixture.sides, fixture.selection,
      fixture.selectionCount, fixture.modifier, fixture.total,
    );
    const term = db.prepare(
      "INSERT INTO rpg_dice_terms (event_id, position, value, kept) VALUES ('dice-event', ?, ?, ?)",
    );
    fixture.terms.forEach(([value, kept], position) => term.run(position, value, kept));
    db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type, revision, occurred_at)
      VALUES ('dice-event', 'campaign', 'dice-command', 'timeline', 'actor', NULL,
        'actor_dice_rolled', 1, ?)`).run(LATER);
    db.prepare(`INSERT INTO command_receipts
      (campaign_id, command_id, revision_before, revision_after, event_id)
      VALUES ('campaign', 'dice-command', 0, 1, 'dice-event')`).run();
  })();
}

function insertValidDiceAudit(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
        source_turn_id, type, dice_expression, dice_count, dice_sides,
        dice_selection_type, dice_selection_count, dice_modifier)
      VALUES ('campaign', 'dice-command', 'dice-key', 'timeline', 'actor', 0, NULL,
        'roll_actor_dice', '4d6kh3+2', 4, 6, 'keep_highest', 3, 2)`).run();
    db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
    db.prepare(`INSERT INTO rpg_dice_rolls
      (event_id, campaign_id, command_id, expression, dice_count, dice_sides,
        selection_type, selection_count, modifier, total)
      VALUES ('dice-event', 'campaign', 'dice-command', '4d6kh3+2', 4, 6,
        'keep_highest', 3, 2, 17)`).run();
    const term = db.prepare("INSERT INTO rpg_dice_terms (event_id, position, value, kept) VALUES ('dice-event', ?, ?, ?)");
    [[0, 6, 1], [1, 2, 0], [2, 5, 1], [3, 4, 1]].forEach((values) => term.run(...values));
    db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type, revision, occurred_at)
      VALUES ('dice-event', 'campaign', 'dice-command', 'timeline', 'actor', NULL,
        'actor_dice_rolled', 1, ?)`).run(LATER);
    db.prepare(`INSERT INTO command_receipts
      (campaign_id, command_id, revision_before, revision_after, event_id)
      VALUES ('campaign', 'dice-command', 0, 1, 'dice-event')`).run();
  })();
}

describe("schema v14 normalized dice audit", () => {
  it.each([
    ["missing", (db: DatabaseDriver.Database) => db.prepare("DELETE FROM meta WHERE key = 'schemaRevision'").run()],
    ["unsupported", (db: DatabaseDriver.Database) => db.prepare(
      "UPDATE meta SET value = '99' WHERE key = 'schemaRevision'",
    ).run()],
  ])("rejects a %s v13 schema revision before any migration mutation", (_label, alterRevision) => {
    const dir = makeTmpDataDir();
    const v13 = makeV13(dir);
    seedActor(v13);
    seedAttributeAudit(v13);
    alterRevision(v13);
    const schemaBefore = completeSchema(v13);
    const rowsBefore = snapshotTables(v13, V13_PRESERVED_TABLES);
    const metaBefore = v13.prepare("SELECT * FROM meta ORDER BY key").all();
    v13.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/unsupported schemaRevision/);
    const failed = new DatabaseDriver(dbPath(dir), { readonly: true });
    expect(completeSchema(failed)).toEqual(schemaBefore);
    expect(snapshotTables(failed, V13_PRESERVED_TABLES)).toEqual(rowsBefore);
    expect(failed.prepare("SELECT * FROM meta ORDER BY key").all()).toEqual(metaBefore);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v13'").all()).toEqual([]);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'rpg_dice_rolls'").get()).toBeUndefined();
    failed.close();
  });

  it("creates a symmetric empty fresh schema without dependency use", () => {
    const dir = makeTmpDataDir();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn((): number => { throw new Error("migration used RNG"); });
    createRepository({ dataDir: dir, clock: { now }, ids: { nextId }, rng: { integer } }).close();
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    const db = new DatabaseDriver(dbPath(dir), { readonly: true });
    for (const table of AUDIT_TABLES) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("preserves v13 rows, consumes no dependencies, creates no rolls, and matches fresh DDL", () => {
    const dir = makeTmpDataDir();
    const v13 = makeV13(dir);
    seedActor(v13);
    seedAttributeAudit(v13);
    v13.prepare(`INSERT INTO rpg_actor_resources
      (campaign_id, actor_id, name, current, max) VALUES ('campaign', 'actor', 'HP', 4, 10)`).run();
    const before = Object.fromEntries(["rpg_actor_resources", "campaign_commands", "campaign_events", "command_receipts"]
      .map((table) => [table, v13.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    v13.close();

    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn((): number => { throw new Error("migration used RNG"); });
    createRepository({ dataDir: dir, clock: { now }, ids: { nextId }, rng: { integer } }).close();
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    const migrated = new DatabaseDriver(dbPath(dir), { readonly: true });
    expect(migrated.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "34" });
    expect(migrated.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toEqual({ value: "1" });
    expect(migrated.prepare("SELECT * FROM rpg_actor_resources").all()).toEqual(before.rpg_actor_resources);
    expect(migrated.prepare("SELECT * FROM campaign_events").all()).toEqual(before.campaign_events);
    expect(migrated.prepare("SELECT * FROM command_receipts").all()).toEqual(before.command_receipts);
    expect(migrated.prepare("SELECT * FROM campaign_commands").get()).toEqual({
      ...(before.campaign_commands as unknown[])[0] as object,
      dice_expression: null, dice_count: null, dice_sides: null, dice_selection_type: null,
      dice_selection_count: null, dice_modifier: null,
    });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM rpg_dice_rolls").get()).toEqual({ count: 0 });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM rpg_dice_terms").get()).toEqual({ count: 0 });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();

    const freshDir = makeTmpDataDir();
    createRepository({ dataDir: freshDir }).close();
    expect(auditSchema(dbPath(dir))).toEqual(auditSchema(dbPath(freshDir)));
  });

  it("preserves both populated v13 audit variants and their old projections and immutability", () => {
    const dir = makeTmpDataDir();
    const v13 = makeV13(dir);
    seedActor(v13);
    seedAttributeAudit(v13);
    seedResourceAudit(v13);
    v13.prepare(`INSERT INTO rpg_actor_resources
      (campaign_id, actor_id, name, current, max) VALUES ('campaign', 'actor', 'MP', 3, 9)`).run();
    const before = snapshotTables(v13, V13_PRESERVED_TABLES);
    v13.close();

    createRepository({ dataDir: dir }).close();
    const migrated = new DatabaseDriver(dbPath(dir));
    expect(migrated.prepare("SELECT * FROM rpg_actor_resources ORDER BY rowid").all())
      .toEqual(before.rpg_actor_resources);
    expect(migrated.prepare("SELECT * FROM campaign_events ORDER BY rowid").all())
      .toEqual(before.campaign_events);
    expect(migrated.prepare("SELECT * FROM command_receipts ORDER BY rowid").all())
      .toEqual(before.command_receipts);
    expect(migrated.prepare(`SELECT campaign_id, command_id, idempotency_key, timeline_id, actor_id,
      expected_revision, source_turn_id, type, attribute_id, value, resource_name,
      resource_current, resource_max FROM campaign_commands ORDER BY rowid`).all())
      .toEqual(before.campaign_commands);
    for (const statement of [
      "UPDATE campaign_commands SET value = 12 WHERE command_id = 'old-command'",
      "DELETE FROM campaign_events WHERE event_id = 'resource-event'",
      "INSERT OR REPLACE INTO command_receipts SELECT * FROM command_receipts WHERE command_id = 'old-command'",
    ]) expect(() => migrated.exec(statement)).toThrow(/immutable/);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();

    const repository = createRepository({ dataDir: dir });
    expect(repository.listCampaignEvents("local-owner", "campaign", "timeline")).toEqual([
      expect.objectContaining({ type: "actor_attribute_set", data: {
        attributeId: "strength", valueBefore: 10, valueAfter: 11,
      } }),
      expect.objectContaining({ type: "actor_resource_initialized", data: { name: "MP", current: 3, max: 9 } }),
    ]);
    expect(repository.getCommandReceipt("local-owner", "campaign", "old-command")?.events[0]?.type)
      .toBe("actor_attribute_set");
    expect(repository.getCommandReceipt("local-owner", "campaign", "resource-command")?.events[0]?.type)
      .toBe("actor_resource_initialized");
    repository.close();
  });

  it.each([
    ["split variant payload", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER campaign_events_prevent_update; PRAGMA ignore_check_constraints = ON");
      db.prepare("UPDATE campaign_events SET resource_name = 'HP', resource_current = 1, resource_max = 2").run();
    }],
    ["command-only identity", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER campaign_events_prevent_delete; DROP TRIGGER command_receipts_prevent_delete");
      db.prepare("DELETE FROM command_receipts").run();
      db.prepare("DELETE FROM campaign_events").run();
    }],
    ["missing receipt", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER command_receipts_prevent_delete");
      db.prepare("DELETE FROM command_receipts").run();
    }],
    ["missing campaign parent", (db: DatabaseDriver.Database) => {
      db.pragma("foreign_keys = OFF");
      db.exec(`DROP TRIGGER campaign_commands_prevent_update; DROP TRIGGER campaign_events_prevent_update;
        DROP TRIGGER command_receipts_prevent_update`);
      db.prepare("UPDATE campaign_commands SET campaign_id = 'ghost'").run();
      db.prepare("UPDATE campaign_events SET campaign_id = 'ghost'").run();
      db.prepare("UPDATE command_receipts SET campaign_id = 'ghost'").run();
    }],
    ["missing timeline parent", (db: DatabaseDriver.Database) => {
      db.pragma("foreign_keys = OFF");
      db.exec("DROP TRIGGER campaign_commands_prevent_update; DROP TRIGGER campaign_events_prevent_update");
      db.prepare("UPDATE campaign_commands SET timeline_id = 'ghost'").run();
      db.prepare("UPDATE campaign_events SET timeline_id = 'ghost'").run();
    }],
    ["missing actor parent", (db: DatabaseDriver.Database) => {
      db.pragma("foreign_keys = OFF");
      db.exec("DROP TRIGGER campaign_commands_prevent_update; DROP TRIGGER campaign_events_prevent_update");
      db.prepare("UPDATE campaign_commands SET actor_id = 'ghost'").run();
      db.prepare("UPDATE campaign_events SET actor_id = 'ghost'").run();
    }],
    ["source-turn mismatch", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER campaign_events_prevent_update");
      db.prepare("UPDATE campaign_events SET source_turn_id = 'other-turn'").run();
    }],
    ["command revision mismatch", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER campaign_commands_prevent_update");
      db.prepare("UPDATE campaign_commands SET expected_revision = 1").run();
    }],
    ["receipt revisions mismatch", (db: DatabaseDriver.Database) => {
      db.pragma("foreign_keys = OFF");
      db.pragma("ignore_check_constraints = ON");
      db.exec("DROP TRIGGER command_receipts_prevent_update");
      db.prepare("UPDATE command_receipts SET revision_before = 1, revision_after = 2").run();
    }],
    ["receipt event identity mismatch", (db: DatabaseDriver.Database) => {
      db.pragma("foreign_keys = OFF");
      db.exec("DROP TRIGGER command_receipts_prevent_update");
      db.prepare("UPDATE command_receipts SET event_id = 'ghost-event'").run();
    }],
    ["attribute payload mismatch", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER campaign_events_prevent_update");
      db.prepare("UPDATE campaign_events SET value_after = 12").run();
    }],
    ["resource payload mismatch", (db: DatabaseDriver.Database) => {
      seedResourceAudit(db);
      db.exec("DROP TRIGGER campaign_events_prevent_update");
      db.prepare("UPDATE campaign_events SET resource_current = 4 WHERE event_id = 'resource-event'").run();
    }],
    ["resource actor association", (db: DatabaseDriver.Database) => {
      db.prepare(`INSERT INTO rpg_actor_resources
        (campaign_id, actor_id, name, current, max) VALUES ('campaign', 'actor', 'HP', 1, 2)`).run();
      db.pragma("foreign_keys = OFF");
      db.prepare("UPDATE rpg_actor_resources SET campaign_id = 'ghost'").run();
    }],
    ["resource value corruption", (db: DatabaseDriver.Database) => {
      db.prepare(`INSERT INTO rpg_actor_resources
        (campaign_id, actor_id, name, current, max) VALUES ('campaign', 'actor', 'HP', 1, 2)`).run();
      db.pragma("ignore_check_constraints = ON");
      db.prepare("UPDATE rpg_actor_resources SET current = 2.5").run();
    }],
    ["timeline revision history", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER campaign_timelines_advance_revision");
      db.prepare("UPDATE campaign_timelines SET revision = 2").run();
    }],
  ])("rejects broad semantic v13 corruption before DDL: %s", (_label, corrupt) => {
    const dir = makeTmpDataDir();
    const v13 = makeV13(dir);
    seedActor(v13);
    seedAttributeAudit(v13);
    corrupt(v13);
    const schemaBefore = completeSchema(v13);
    const rowsBefore = snapshotTables(v13, V13_PRESERVED_TABLES);
    v13.close();
    expect(() => createRepository({ dataDir: dir })).toThrow(/schema v13/);
    const failed = new DatabaseDriver(dbPath(dir), { readonly: true });
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "13" });
    expect(completeSchema(failed)).toEqual(schemaBefore);
    expect(snapshotTables(failed, V13_PRESERVED_TABLES)).toEqual(rowsBefore);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'rpg_dice_rolls'").get()).toBeUndefined();
    failed.close();
  });

  it("accepts only a complete normalized aggregate and seals it with the dice event", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir));
    db.pragma("foreign_keys = ON");
    seedActor(db);
    insertValidDiceAudit(db);
    expect(db.prepare("SELECT * FROM rpg_dice_terms ORDER BY position").all()).toEqual([
      { event_id: "dice-event", position: 0, value: 6, kept: 1 },
      { event_id: "dice-event", position: 1, value: 2, kept: 0 },
      { event_id: "dice-event", position: 2, value: 5, kept: 1 },
      { event_id: "dice-event", position: 3, value: 4, kept: 1 },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();

    const repository = createRepository({ dataDir: dir });
    expect(repository.listCampaignEvents("local-owner", "campaign", "timeline")).toEqual([
      expect.objectContaining({
        eventId: "dice-event",
        commandId: "dice-command",
        type: "actor_dice_rolled",
        data: expect.objectContaining({
          expression: "4d6kh3+2",
          terms: [
            { value: 6, kept: true },
            { value: 2, kept: false },
            { value: 5, kept: true },
            { value: 4, kept: true },
          ],
          total: 17,
        }),
      }),
    ]);
    expect(repository.getCommandReceipt("local-owner", "campaign", "dice-command"))
      .toEqual(expect.objectContaining({ commandId: "dice-command", events: [
        expect.objectContaining({ eventId: "dice-event", type: "actor_dice_rolled" }),
      ] }));
    repository.close();
  });

  it.each([
    ["all", { expression: "3d6", count: 3, sides: 6, selection: "all", selectionCount: null,
      modifier: 0, terms: [[1, 1], [6, 1], [3, 1]], total: 10 }],
    ["keep highest with positive modifier", { expression: "4d6kh2+5", count: 4, sides: 6,
      selection: "keep_highest", selectionCount: 2, modifier: 5,
      terms: [[4, 1], [4, 1], [2, 0], [1, 0]], total: 13 }],
    ["keep lowest with negative modifier", { expression: "4d8kl2-3", count: 4, sides: 8,
      selection: "keep_lowest", selectionCount: 2, modifier: -3,
      terms: [[7, 0], [2, 1], [2, 1], [8, 0]], total: 1 }],
    ["advantage tie keeps earlier term", { expression: "1d20adv", count: 1, sides: 20,
      selection: "advantage", selectionCount: null, modifier: 0,
      terms: [[12, 1], [12, 0]], total: 12 }],
    ["disadvantage tie keeps earlier term", { expression: "1d20dis+2", count: 1, sides: 20,
      selection: "disadvantage", selectionCount: null, modifier: 2,
      terms: [[9, 1], [9, 0]], total: 11 }],
  ] as Array<[string, DiceFixture]>)("accepts valid normalized mode: %s", (_label, fixture) => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir));
    db.pragma("foreign_keys = ON");
    seedActor(db);
    insertDiceFixture(db, fixture);
    expect(db.prepare("SELECT expression, selection_type, selection_count, modifier, total FROM rpg_dice_rolls").get())
      .toEqual({ expression: fixture.expression, selection_type: fixture.selection,
        selection_count: fixture.selectionCount, modifier: fixture.modifier, total: fixture.total });
    expect(db.prepare("SELECT value, kept FROM rpg_dice_terms ORDER BY position").all())
      .toEqual(fixture.terms.map(([value, kept]) => ({ value, kept })));
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it.each([
    ["fresh", "keep highest", { expression: "2d6kh1", count: 2, sides: 6,
      selection: "keep_highest", selectionCount: 1, modifier: 0,
      terms: [[4, 0], [4, 1]], total: 4 }],
    ["fresh", "keep lowest", { expression: "2d6kl1", count: 2, sides: 6,
      selection: "keep_lowest", selectionCount: 1, modifier: 0,
      terms: [[4, 0], [4, 1]], total: 4 }],
    ["fresh", "advantage", { expression: "1d20adv", count: 1, sides: 20,
      selection: "advantage", selectionCount: null, modifier: 0,
      terms: [[12, 0], [12, 1]], total: 12 }],
    ["fresh", "disadvantage", { expression: "1d20dis", count: 1, sides: 20,
      selection: "disadvantage", selectionCount: null, modifier: 0,
      terms: [[9, 0], [9, 1]], total: 9 }],
    ["migrated", "keep highest", { expression: "2d6kh1", count: 2, sides: 6,
      selection: "keep_highest", selectionCount: 1, modifier: 0,
      terms: [[4, 0], [4, 1]], total: 4 }],
    ["migrated", "keep lowest", { expression: "2d6kl1", count: 2, sides: 6,
      selection: "keep_lowest", selectionCount: 1, modifier: 0,
      terms: [[4, 0], [4, 1]], total: 4 }],
    ["migrated", "advantage", { expression: "1d20adv", count: 1, sides: 20,
      selection: "advantage", selectionCount: null, modifier: 0,
      terms: [[12, 0], [12, 1]], total: 12 }],
    ["migrated", "disadvantage", { expression: "1d20dis", count: 1, sides: 20,
      selection: "disadvantage", selectionCount: null, modifier: 0,
      terms: [[9, 0], [9, 1]], total: 9 }],
  ] as Array<["fresh" | "migrated", string, DiceFixture]>)
  ("directly rejects a later equal-value kept term on %s %s seal", (source, _mode, fixture) => {
    const dir=makeTmpDataDir();
    if (source === "migrated") { const v13=makeV13(dir); v13.close(); }
    createRepository({dataDir:dir}).close();
    const db=new DatabaseDriver(dbPath(dir)); db.pragma("foreign_keys = ON"); seedActor(db);
    expect(() => insertDiceFixture(db,fixture)).toThrow("campaign event must match");
    for (const table of ["campaign_commands","campaign_events","command_receipts","rpg_dice_rolls","rpg_dice_terms"]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),table).toEqual({count:0});
    }
    expect(db.prepare("SELECT revision FROM campaign_timelines WHERE id='timeline'").get()).toEqual({revision:0});
    expect(db.pragma("foreign_key_check")).toEqual([]); db.close();
  });

  it.each([
    ["command/roll mismatch", (db: DatabaseDriver.Database) => {
      db.prepare("UPDATE rpg_dice_rolls SET dice_sides = 8, expression = '2d8kh1'").run();
    }],
    ["term count", (db: DatabaseDriver.Database) => {
      db.prepare("DELETE FROM rpg_dice_terms WHERE position = 1").run();
    }],
    ["kept cardinality", (db: DatabaseDriver.Database) => {
      db.prepare("UPDATE rpg_dice_terms SET kept = 1").run();
    }],
    ["position gap", (db: DatabaseDriver.Database) => {
      db.prepare("UPDATE rpg_dice_terms SET position = 2 WHERE position = 1").run();
    }],
    ["term side value", (db: DatabaseDriver.Database) => {
      db.prepare("UPDATE rpg_dice_terms SET value = 7 WHERE position = 0").run();
    }],
    ["kept high/low semantics", (db: DatabaseDriver.Database) => {
      db.prepare("UPDATE rpg_dice_terms SET kept = CASE position WHEN 0 THEN 0 ELSE 1 END").run();
    }],
    ["aggregate total", (db: DatabaseDriver.Database) => {
      db.prepare("UPDATE rpg_dice_rolls SET total = 99").run();
    }],
  ])("rolls back the complete graph for invalid seal: %s", (_label, corrupt) => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir));
    db.pragma("foreign_keys = ON");
    seedActor(db);
    const invalid = db.transaction(() => {
      db.prepare(`INSERT INTO campaign_commands
        (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
          source_turn_id, type, dice_expression, dice_count, dice_sides,
          dice_selection_type, dice_selection_count, dice_modifier)
        VALUES ('campaign', 'dice-command', 'dice-key', 'timeline', 'actor', 0, NULL,
          'roll_actor_dice', '2d6kh1', 2, 6, 'keep_highest', 1, 0)`).run();
      db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline'").run();
      db.prepare(`INSERT INTO rpg_dice_rolls
        (event_id, campaign_id, command_id, expression, dice_count, dice_sides,
          selection_type, selection_count, modifier, total)
        VALUES ('dice-event', 'campaign', 'dice-command', '2d6kh1', 2, 6,
          'keep_highest', 1, 0, 6)`).run();
      db.prepare("INSERT INTO rpg_dice_terms VALUES ('dice-event', 0, 6, 1), ('dice-event', 1, 2, 0)").run();
      // The fixture is intentionally mutable only until its event seals it.
      // Drop immutability guards inside this doomed transaction so each test
      // can isolate the seal invariant; rollback restores the guards exactly.
      db.exec(`DROP TRIGGER rpg_dice_rolls_prevent_update;
        DROP TRIGGER rpg_dice_terms_prevent_update;
        DROP TRIGGER rpg_dice_terms_prevent_delete`);
      corrupt(db);
      db.prepare(`INSERT INTO campaign_events
        (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type, revision, occurred_at)
        VALUES ('dice-event', 'campaign', 'dice-command', 'timeline', 'actor', NULL,
          'actor_dice_rolled', 1, ?)`).run(LATER);
      db.prepare(`INSERT INTO command_receipts
        (campaign_id, command_id, revision_before, revision_after, event_id)
        VALUES ('campaign', 'dice-command', 0, 1, 'dice-event')`).run();
    });
    expect(() => invalid()).toThrow("campaign event must match");
    for (const table of ["campaign_commands", "campaign_events", "command_receipts", "rpg_dice_rolls", "rpg_dice_terms"]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    expect(db.prepare("SELECT revision FROM campaign_timelines WHERE id = 'timeline'").get()).toEqual({ revision: 0 });
    db.close();
  });

  it("enforces canonical command/roll columns and rejects incomplete or inconsistent aggregates", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir));
    db.pragma("foreign_keys = ON");
    seedActor(db);
    const command = db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
        source_turn_id, type, dice_expression, dice_count, dice_sides,
        dice_selection_type, dice_selection_count, dice_modifier)
      VALUES ('campaign', ?, ?, 'timeline', 'actor', 0, NULL, 'roll_actor_dice', ?, ?, ?, ?, ?, ?)`);
    expect(() => command.run("bad", "bad-key", "04d6", 4, 6, "all", null, 0)).toThrow();
    expect(() => command.run("bad", "bad-key", "2d6kh3", 2, 6, "keep_highest", 3, 0)).toThrow();
    command.run("dice-command", "dice-key", "2d6kh1", 2, 6, "keep_highest", 1, 0);
    db.prepare("UPDATE campaign_timelines SET revision = 1").run();
    expect(() => db.prepare(`INSERT INTO rpg_dice_rolls
      (event_id, campaign_id, command_id, expression, dice_count, dice_sides,
        selection_type, selection_count, modifier, total)
        VALUES ('dice-event', 'campaign', 'dice-command', '02d6kh1', 2, 6, 'keep_highest', 1, 0, 6)`).run()).toThrow();
    const incomplete = db.transaction(() => {
      db.prepare(`INSERT INTO rpg_dice_rolls
        (event_id, campaign_id, command_id, expression, dice_count, dice_sides,
          selection_type, selection_count, modifier, total)
        VALUES ('dice-event', 'campaign', 'dice-command', '2d6kh1', 2, 6, 'keep_highest', 1, 0, 2)`).run();
      db.prepare("INSERT INTO rpg_dice_terms VALUES ('dice-event', 0, 2, 1)").run();
      db.prepare(`INSERT INTO campaign_events
        (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type, revision, occurred_at)
        VALUES ('dice-event', 'campaign', 'dice-command', 'timeline', 'actor', NULL,
          'actor_dice_rolled', 1, ?)`).run(LATER);
    });
    expect(() => incomplete()).toThrow("campaign event must match");
    db.close();
  });

  it("has the exact reviewed column, key, deferred-link, and trigger shape without speculative fields", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir), { readonly: true });
    const columns = (table: string) => (db.pragma(`table_xinfo(${table})`) as Array<{ name: string }>).map((row) => row.name);
    expect(columns("campaign_commands")).toEqual([
      "campaign_id", "command_id", "idempotency_key", "timeline_id", "actor_id", "expected_revision",
      "source_turn_id", "type", "attribute_id", "value", "resource_name", "resource_current", "resource_max",
      "dice_expression", "dice_count", "dice_sides", "dice_selection_type", "dice_selection_count", "dice_modifier",
    ]);
    expect(columns("campaign_events")).toEqual([
      "event_id", "campaign_id", "command_id", "timeline_id", "actor_id", "source_turn_id", "type", "revision",
      "occurred_at", "attribute_id", "value_before", "value_after", "resource_name", "resource_current", "resource_max",
    ]);
    expect(columns("command_receipts")).toEqual([
      "campaign_id", "command_id", "revision_before", "revision_after", "event_id",
    ]);
    expect(columns("rpg_dice_rolls")).toEqual([
      "event_id", "campaign_id", "command_id", "expression", "dice_count", "dice_sides",
      "selection_type", "selection_count", "modifier", "total",
    ]);
    expect(columns("rpg_dice_terms")).toEqual(["event_id", "position", "value", "kept"]);

    const rollSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rpg_dice_rolls'")
      .pluck().get() as string;
    expect(rollSql).toContain("REFERENCES campaign_events(campaign_id, command_id, event_id) ON DELETE RESTRICT\n        DEFERRABLE INITIALLY DEFERRED");
    const foreignKeys = (table: string) => (db.pragma(`foreign_key_list(${table})`) as Array<{
      table: string; from: string; to: string; on_delete: string;
    }>).map(({ table: parent, from, to, on_delete }) => ({ parent, from, to, on_delete }));
    expect(foreignKeys("rpg_actor_resources")).toEqual([
      { parent: "campaign_actors", from: "campaign_id", to: "campaign_id", on_delete: "CASCADE" },
      { parent: "campaign_actors", from: "actor_id", to: "id", on_delete: "CASCADE" },
    ]);
    expect(foreignKeys("campaign_commands")).toEqual([
      { parent: "campaign_actors", from: "campaign_id", to: "campaign_id", on_delete: "RESTRICT" },
      { parent: "campaign_actors", from: "actor_id", to: "id", on_delete: "RESTRICT" },
      { parent: "campaign_timelines", from: "campaign_id", to: "campaign_id", on_delete: "RESTRICT" },
      { parent: "campaign_timelines", from: "timeline_id", to: "id", on_delete: "RESTRICT" },
    ]);
    expect(foreignKeys("campaign_events")).toEqual([
      { parent: "campaign_actors", from: "campaign_id", to: "campaign_id", on_delete: "RESTRICT" },
      { parent: "campaign_actors", from: "actor_id", to: "id", on_delete: "RESTRICT" },
      { parent: "campaign_timelines", from: "campaign_id", to: "campaign_id", on_delete: "RESTRICT" },
      { parent: "campaign_timelines", from: "timeline_id", to: "id", on_delete: "RESTRICT" },
      { parent: "campaign_commands", from: "campaign_id", to: "campaign_id", on_delete: "RESTRICT" },
      { parent: "campaign_commands", from: "command_id", to: "command_id", on_delete: "RESTRICT" },
    ]);
    expect(foreignKeys("command_receipts")).toEqual([
      { parent: "campaign_events", from: "campaign_id", to: "campaign_id", on_delete: "RESTRICT" },
      { parent: "campaign_events", from: "command_id", to: "command_id", on_delete: "RESTRICT" },
      { parent: "campaign_events", from: "event_id", to: "event_id", on_delete: "RESTRICT" },
      { parent: "campaign_events", from: "revision_after", to: "revision", on_delete: "RESTRICT" },
      { parent: "campaign_commands", from: "campaign_id", to: "campaign_id", on_delete: "RESTRICT" },
      { parent: "campaign_commands", from: "command_id", to: "command_id", on_delete: "RESTRICT" },
    ]);
    expect(foreignKeys("rpg_dice_rolls")).toEqual([
      { parent: "campaign_events", from: "campaign_id", to: "campaign_id", on_delete: "RESTRICT" },
      { parent: "campaign_events", from: "command_id", to: "command_id", on_delete: "RESTRICT" },
      { parent: "campaign_events", from: "event_id", to: "event_id", on_delete: "RESTRICT" },
      { parent: "campaign_commands", from: "campaign_id", to: "campaign_id", on_delete: "RESTRICT" },
      { parent: "campaign_commands", from: "command_id", to: "command_id", on_delete: "RESTRICT" },
    ]);
    expect(foreignKeys("rpg_dice_terms")).toEqual([
      { parent: "rpg_dice_rolls", from: "event_id", to: "event_id", on_delete: "RESTRICT" },
    ]);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'
      AND name IN ('campaign_timelines_advance_revision', 'campaign_events_require_matching_command',
        'rpg_dice_rolls_must_precede_event', 'rpg_dice_terms_must_precede_event') ORDER BY name`).all())
      .toEqual([
        { name: "campaign_events_require_matching_command" },
        { name: "campaign_timelines_advance_revision" },
        { name: "rpg_dice_rolls_must_precede_event" },
        { name: "rpg_dice_terms_must_precede_event" },
      ]);
    db.close();
  });

  it.each(["OFF", "ON"])("blocks alternate unique-identity REPLACE with recursive_triggers %s", (recursive) => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir));
    db.pragma("foreign_keys = ON");
    db.pragma(`recursive_triggers = ${recursive}`);
    seedActor(db);
    insertValidDiceAudit(db);
    for (const statement of [
      `INSERT OR REPLACE INTO campaign_commands
        (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
          source_turn_id, type, attribute_id, value)
        VALUES ('campaign', 'alternate-command', 'dice-key', 'timeline', 'actor', 1, NULL,
          'set_actor_attribute', 'strength', 12)`,
      `INSERT OR REPLACE INTO campaign_events
        (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
          revision, occurred_at, attribute_id, value_before, value_after)
        VALUES ('alternate-event', 'campaign', 'dice-command', 'timeline', 'actor', NULL,
          'actor_attribute_set', 1, '${LATER}', 'strength', 10, 12)`,
      `INSERT OR REPLACE INTO rpg_dice_rolls
        (event_id, campaign_id, command_id, expression, dice_count, dice_sides,
          selection_type, selection_count, modifier, total)
        VALUES ('alternate-roll', 'campaign', 'dice-command', '4d6kh3+2', 4, 6,
          'keep_highest', 3, 2, 17)`,
    ]) expect(() => db.exec(statement)).toThrow(/immutable|match|precede/);
    expect(db.prepare("SELECT event_id FROM rpg_dice_rolls").all()).toEqual([{ event_id: "dice-event" }]);
    expect(db.prepare("SELECT command_id FROM campaign_commands").all()).toEqual([{ command_id: "dice-command" }]);
    expect(db.prepare("SELECT event_id FROM campaign_events").all()).toEqual([{ event_id: "dice-event" }]);
    db.close();
  });

  it("makes rolls and ordered terms immutable, blocks REPLACE, and forbids post-event append or attachment", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir));
    db.pragma("foreign_keys = ON");
    seedActor(db);
    insertValidDiceAudit(db);
    for (const statement of [
      "UPDATE rpg_dice_rolls SET total = 18 WHERE event_id = 'dice-event'",
      "DELETE FROM rpg_dice_rolls WHERE event_id = 'dice-event'",
      "INSERT OR REPLACE INTO rpg_dice_rolls SELECT * FROM rpg_dice_rolls WHERE event_id = 'dice-event'",
      "UPDATE rpg_dice_terms SET value = 3 WHERE event_id = 'dice-event' AND position = 1",
      "DELETE FROM rpg_dice_terms WHERE event_id = 'dice-event' AND position = 1",
      "INSERT OR REPLACE INTO rpg_dice_terms SELECT * FROM rpg_dice_terms WHERE event_id = 'dice-event' AND position = 1",
      "INSERT INTO rpg_dice_terms VALUES ('dice-event', 4, 1, 0)",
    ]) expect(() => db.exec(statement)).toThrow(/immutable|precede/);
    db.close();

    const oldDir = makeTmpDataDir();
    createRepository({ dataDir: oldDir }).close();
    const old = new DatabaseDriver(dbPath(oldDir));
    old.pragma("foreign_keys = ON");
    seedActor(old);
    seedAttributeAudit(old);
    expect(() => old.prepare(`INSERT INTO rpg_dice_rolls
      (event_id, campaign_id, command_id, expression, dice_count, dice_sides,
        selection_type, selection_count, modifier, total)
      VALUES ('old-event', 'campaign', 'old-command', '1d6', 1, 6, 'all', NULL, 0, 4)`).run())
      .toThrow("dice roll must precede");
    old.close();
  });

  it("requires the deferred exact event link by commit and rolls an unsealed graph back", () => {
    const dir = makeTmpDataDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(dbPath(dir));
    db.pragma("foreign_keys = ON");
    seedActor(db);
    const unsealed = db.transaction(() => {
      db.prepare(`INSERT INTO campaign_commands
        (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
          source_turn_id, type, dice_expression, dice_count, dice_sides,
          dice_selection_type, dice_selection_count, dice_modifier)
        VALUES ('campaign', 'dice-command', 'dice-key', 'timeline', 'actor', 0, NULL,
          'roll_actor_dice', '1d6', 1, 6, 'all', NULL, 0)`).run();
      db.prepare(`INSERT INTO rpg_dice_rolls
        (event_id, campaign_id, command_id, expression, dice_count, dice_sides,
          selection_type, selection_count, modifier, total)
        VALUES ('dice-event', 'campaign', 'dice-command', '1d6', 1, 6, 'all', NULL, 0, 4)`).run();
      db.prepare("INSERT INTO rpg_dice_terms VALUES ('dice-event', 0, 4, 1)").run();
    });
    expect(() => unsealed()).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM campaign_commands").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM rpg_dice_rolls").get()).toEqual({ count: 0 });
    db.close();
  });

  it("rolls back a late migrated failure exactly and retries to fresh parity", () => {
    const dir = makeTmpDataDir();
    const v13 = makeV13(dir);
    seedActor(v13);
    seedAttributeAudit(v13);
    v13.exec(`CREATE TRIGGER fail_v14_late BEFORE UPDATE OF value ON meta
      WHEN NEW.value = '14' BEGIN SELECT RAISE(ABORT, 'late v14 failure'); END`);
    const schemaBefore = v13.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    const auditBefore = Object.fromEntries(["rpg_actor_resources", "campaign_commands", "campaign_events", "command_receipts"]
      .map((table) => [table, v13.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    v13.close();

    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn((): number => { throw new Error("migration used RNG"); });
    expect(() => createRepository({ dataDir: dir, clock: { now }, ids: { nextId }, rng: { integer } }))
      .toThrow("late v14 failure");
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    const failed = new DatabaseDriver(dbPath(dir));
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "13" });
    expect(failed.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schemaBefore);
    for (const [table, rows] of Object.entries(auditBefore)) {
      expect(failed.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(rows);
    }
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v13'").all()).toEqual([]);
    failed.exec("DROP TRIGGER fail_v14_late");
    failed.close();
    createRepository({ dataDir: dir, clock: { now }, ids: { nextId }, rng: { integer } }).close();
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    const freshDir = makeTmpDataDir();
    createRepository({ dataDir: freshDir }).close();
    expect(auditSchema(dbPath(dir))).toEqual(auditSchema(dbPath(freshDir)));
  });

  it("rolls back late fresh DDL and retries from an empty marker", () => {
    const dir = makeTmpDataDir();
    const db = new DatabaseDriver(dbPath(dir));
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE conflict_holder (value TEXT NOT NULL);
      CREATE INDEX idx_rpg_dice_rolls_command ON conflict_holder(value)`);
    const schemaBefore = completeSchema(db);
    const metaBefore = db.prepare("SELECT * FROM meta ORDER BY key").all();
    db.close();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn((): number => { throw new Error("migration used RNG"); });
    expect(() => createRepository({ dataDir: dir, clock: { now }, ids: { nextId }, rng: { integer } }))
      .toThrow(/idx_rpg_dice_rolls_command already exists/);
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    const failed = new DatabaseDriver(dbPath(dir));
    expect(completeSchema(failed)).toEqual(schemaBefore);
    expect(failed.prepare("SELECT * FROM meta ORDER BY key").all()).toEqual(metaBefore);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'rpg_dice_rolls'").get()).toBeUndefined();
    failed.exec("DROP INDEX idx_rpg_dice_rolls_command; DROP TABLE conflict_holder");
    failed.close();
    createRepository({ dataDir: dir, clock: { now }, ids: { nextId }, rng: { integer } }).close();
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    const retried = new DatabaseDriver(dbPath(dir), { readonly: true });
    expect(retried.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "34" });
    for (const table of AUDIT_TABLES) {
      expect(retried.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    expect(retried.pragma("foreign_key_check")).toEqual([]);
    retried.close();
    const freshDir = makeTmpDataDir();
    createRepository({ dataDir: freshDir }).close();
    expect(auditSchema(dbPath(dir))).toEqual(auditSchema(dbPath(freshDir)));
  });
});
