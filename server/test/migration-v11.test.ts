import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { deleteCampaignForCorruptionTest, makeTmpDataDir, removeFutureCharacterBuilderSchema, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const V11_TABLES = [
  "campaign_characters",
  "rpg_campaign_sheets",
  "rpg_character_classes",
  "rpg_character_attributes",
  "rpg_character_proficiencies",
  "rpg_character_choices",
  "campaign_actors",
  "campaign_actor_private_state",
] as const;
const AT = "2030-04-05T06:07:08.009Z";

function databasePath(dir: string): string {
  return path.join(dir, "velvet.sqlite");
}

function createCampaign(db: DatabaseDriver.Database, id: string): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, ?, ?, 'local-owner', ?, ?)`).run(id, `Campaign ${id}`, `${id}-timeline`, AT, AT);
    db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES (?, ?, ?)")
      .run(`${id}-timeline`, id, AT);
    db.prepare("INSERT INTO campaign_memberships VALUES (?, 'local-owner', 'owner', ?)").run(id, AT);
  })();
}

function seedV10Data(db: DatabaseDriver.Database): void {
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO principals VALUES ('principal-player', 'Player', 0)").run();
  createCampaign(db, "campaign-one");
  createCampaign(db, "campaign-two");
  db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-one', 'principal-player', 'player', ?)").run(AT);
  db.prepare(`INSERT INTO characters VALUES
    ('persona-one', 'Persona', 30, 'guide', 'fictional', 1, 0, ?),
    ('persona-two', 'Other persona', 31, 'scout', 'fictional', 1, 0, ?)`).run(AT, AT);
  db.prepare(`INSERT INTO sessions VALUES
    ('session-one', 'persona-one', 'Preserved session', 'active', 'default', NULL, ?, NULL, NULL)`).run(AT);
  db.prepare("INSERT INTO session_characters VALUES ('session-one', 'persona-one', 0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES ('session-one', 'campaign-one', ?)").run(AT);
  db.prepare(`INSERT INTO rpg_rules_profiles VALUES
    ('profile-main', 'Main rules', 'Preserved profile', '["core","core"]')`).run();
  db.prepare(`INSERT INTO rpg_content_packs VALUES
    ('pack-core', '1.0.0', 'profile-main', 'Core', 'Preserved pack', '["core"]', 0),
    ('pack-core', '2.0.0', 'profile-main', 'Core 2', 'Other exact version', '[]', 0)`).run();
  const definitions = [
    ["race", "human"], ["background", "guide"], ["class", "fighter"], ["item", "rope"],
    ["spell", "light"], ["ability", "focus"], ["enemy", "rat"],
  ] as const;
  const insertDefinition = db.prepare(`INSERT INTO rpg_definitions
    VALUES ('pack-core', '1.0.0', ?, ?, ?, 'Preserved definition', '[]')`);
  for (const [kind, id] of definitions) insertDefinition.run(kind, id, id);
  db.prepare("UPDATE rpg_content_packs SET sealed = 1 WHERE sealed = 0").run();
  for (const campaignId of ["campaign-one", "campaign-two"]) {
    db.prepare("INSERT INTO campaign_rules_profiles VALUES (?, 'profile-main')").run(campaignId);
    db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'pack-core', '1.0.0', 'profile-main')").run(campaignId);
  }
}

function createRepresentativeV10(dir: string): string {
  const repository = createRepository({ dataDir: dir });
  repository.close();
  const dbPath = databasePath(dir);
  const db = new DatabaseDriver(dbPath);
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
  `);
  for (const table of [...V11_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  db.exec("DROP INDEX uq_campaign_content_packs_exact_pin");
  db.exec("DROP TRIGGER campaign_content_packs_require_sealed_insert");
  db.exec("DROP TRIGGER campaign_content_packs_require_sealed_update");
  db.prepare("UPDATE meta SET value = '10' WHERE key = 'schemaVersion'").run();
  db.prepare("DELETE FROM meta WHERE key = 'schemaRevision'").run();
  seedV10Data(db);
  db.close();
  return dbPath;
}

function representativeSnapshot(dbPath: string): Record<string, unknown[]> {
  const db = new DatabaseDriver(dbPath, { readonly: true });
  const tables = [
    "principals", "campaigns", "campaign_timelines", "campaign_memberships", "characters", "sessions",
    "session_characters", "campaign_sessions", "rpg_rules_profiles", "rpg_content_packs", "rpg_definitions",
    "campaign_rules_profiles", "campaign_content_packs",
  ];
  const snapshot = Object.fromEntries(tables.map((table) => [table, db.prepare(table === "campaign_timelines"
    ? "SELECT id, campaign_id, created_at FROM campaign_timelines ORDER BY rowid"
    : `SELECT * FROM ${table} ORDER BY rowid`).all()]));
  db.close();
  return snapshot;
}

function v11Schema(dbPath: string): unknown[] {
  const db = new DatabaseDriver(dbPath, { readonly: true });
  const placeholders = V11_TABLES.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name IN (${placeholders}) OR name = 'uq_campaign_content_packs_exact_pin'
    ORDER BY type, name`).all(...V11_TABLES);
  db.close();
  return rows;
}

function sealedPinTriggerSchema(dbPath: string): unknown[] {
  const db = new DatabaseDriver(dbPath, { readonly: true });
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name IN ('campaign_content_packs_require_sealed_insert', 'campaign_content_packs_require_sealed_update')
    ORDER BY name`).all();
  db.close();
  return rows;
}

function makeOldV11(db: DatabaseDriver.Database): void {
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
    DROP TRIGGER campaign_content_packs_require_sealed_insert;
    DROP TRIGGER campaign_content_packs_require_sealed_update;
    UPDATE meta SET value = '11' WHERE key = 'schemaVersion';
    DELETE FROM meta WHERE key = 'schemaRevision';
  `);
}

function openSeededV11(): { db: DatabaseDriver.Database; dir: string } {
  const dir = makeTmpDataDir();
  const repository = createRepository({ dataDir: dir });
  repository.close();
  const db = new DatabaseDriver(databasePath(dir));
  seedV10Data(db);
  return { db, dir };
}

function insertCampaignCharacter(
  db: DatabaseDriver.Database,
  id = "campaign-character-one",
  campaignId = "campaign-one",
  characterId = "persona-one",
): void {
  db.prepare("INSERT INTO campaign_characters VALUES (?, ?, ?, ?, ?)").run(id, campaignId, characterId, AT, AT);
}

function insertSheet(
  db: DatabaseDriver.Database,
  id = "sheet-one",
  campaignId = "campaign-one",
  campaignCharacterId = "campaign-character-one",
): void {
  db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
    (?, ?, ?, 'pack-core', '1.0.0', 'race', 'human',
     'pack-core', '1.0.0', 'background', 'guide', ?, ?)`).run(id, campaignId, campaignCharacterId, AT, AT);
}

function insertCompleteAggregate(db: DatabaseDriver.Database): void {
  insertCampaignCharacter(db);
  insertSheet(db);
  db.prepare(`INSERT INTO rpg_character_classes VALUES
    ('campaign-one', 'sheet-one', 0, 'pack-core', '1.0.0', 'class', 'fighter', 1)`).run();
  db.prepare("INSERT INTO rpg_character_attributes VALUES ('campaign-one', 'sheet-one', 0, 'strength', 10)").run();
  db.prepare("INSERT INTO rpg_character_proficiencies VALUES ('campaign-one', 'sheet-one', 0, 'skill', 'survival')").run();
  db.prepare(`INSERT INTO rpg_character_choices VALUES
    ('campaign-one', 'sheet-one', 0, 'starting-item', 'pack-core', '1.0.0', 'item', 'rope')`).run();
  db.prepare(`INSERT INTO campaign_actors VALUES
    ('actor-one', 'campaign-one', 'campaign-character-one', 'sheet-one', 'player-character', 'principal', ?, ?)`).run(AT, AT);
  db.prepare(`INSERT INTO campaign_actor_private_state VALUES
    ('actor-one', 'campaign-one', 'principal-player', 'private')`).run();
}

describe("schema v11 campaign sheets and actors", () => {
  it("uses identical fresh and migrated DDL, exactly preserves v10 data, creates no aggregates, and consumes no dependencies", () => {
    const migratedDir = makeTmpDataDir();
    const migratedPath = createRepresentativeV10(migratedDir);
    const before = representativeSnapshot(migratedPath);
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const migrated = createRepository({ dataDir: migratedDir, clock: { now: clockNow }, ids: { nextId } });
    migrated.close();

    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(representativeSnapshot(migratedPath)).toEqual(before);

    const freshDir = makeTmpDataDir();
    const freshClock = vi.fn(() => new Date());
    const freshId = vi.fn(() => "unused");
    const fresh = createRepository({ dataDir: freshDir, clock: { now: freshClock }, ids: { nextId: freshId } });
    fresh.close();
    expect(freshClock).not.toHaveBeenCalled();
    expect(freshId).not.toHaveBeenCalled();
    expect(v11Schema(migratedPath)).toEqual(v11Schema(databasePath(freshDir)));

    for (const dbPath of [migratedPath, databasePath(freshDir)]) {
      const db = new DatabaseDriver(dbPath, { readonly: true });
      expect((db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("32");
      expect((db.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get() as { value: string }).value).toBe("1");
      for (const table of V11_TABLES) {
        expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
      }
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{ name: string }>;
      expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
        "uq_campaign_content_packs_exact_pin",
        "idx_campaign_characters_character",
        "idx_rpg_campaign_sheets_character",
        "idx_rpg_campaign_sheets_race_pin",
        "idx_rpg_campaign_sheets_race_definition",
        "idx_rpg_campaign_sheets_background_pin",
        "idx_rpg_campaign_sheets_background_definition",
        "idx_rpg_character_classes_sheet",
        "idx_rpg_character_classes_pin",
        "idx_rpg_character_classes_definition",
        "idx_rpg_character_attributes_sheet",
        "idx_rpg_character_proficiencies_sheet",
        "idx_rpg_character_choices_sheet",
        "idx_rpg_character_choices_pin",
        "idx_rpg_character_choices_definition",
        "idx_campaign_actors_character",
        "idx_campaign_actors_sheet",
        "idx_campaign_actor_private_state_actor",
        "idx_campaign_actor_private_state_controller",
      ]));
      expect(db.pragma("foreign_key_check")).toEqual([]);
      db.close();
    }
  });

  it.each(["unsealed", "missing"])("rejects a v10 %s exact pin atomically, then repairs and retries", (malformation) => {
    const dir = makeTmpDataDir();
    const dbPath = createRepresentativeV10(dir);
    const malformed = new DatabaseDriver(dbPath);
    if (malformation === "unsealed") {
      malformed.prepare(`INSERT INTO rpg_content_packs VALUES
        ('pack-invalid', '1.0.0', 'profile-main', 'Invalid', 'Unsealed exact pack', '[]', 0)`).run();
      malformed.prepare(`UPDATE campaign_content_packs
        SET pack_id = 'pack-invalid' WHERE campaign_id = 'campaign-one'`).run();
    } else {
      malformed.pragma("foreign_keys = OFF");
      malformed.prepare(`UPDATE campaign_content_packs
        SET pack_version = '3.0.0' WHERE campaign_id = 'campaign-one'`).run();
    }
    malformed.close();
    const before = representativeSnapshot(dbPath);
    const baselineV11Schema = v11Schema(dbPath);
    const baselineSealedPinTriggers = sealedPinTriggerSchema(dbPath);
    expect(baselineV11Schema).toEqual([]);
    expect(baselineSealedPinTriggers).toEqual([]);
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");

    expect(() => createRepository({ dataDir: dir, clock: { now: clockNow }, ids: { nextId } }))
      .toThrow(/schema v11 correction blocked:.*exact sealed RPG content pack/);
    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(representativeSnapshot(dbPath)).toEqual(before);
    expect(v11Schema(dbPath)).toEqual(baselineV11Schema);
    expect(sealedPinTriggerSchema(dbPath)).toEqual(baselineSealedPinTriggers);

    const failed = new DatabaseDriver(dbPath);
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "10" });
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toBeUndefined();
    if (malformation === "unsealed") {
      failed.prepare("UPDATE rpg_content_packs SET sealed = 1 WHERE pack_id = 'pack-invalid'").run();
    } else {
      failed.prepare(`INSERT INTO rpg_content_packs VALUES
        ('pack-core', '3.0.0', 'profile-main', 'Core 3', 'Repaired exact pack', '[]', 1)`).run();
    }
    failed.close();

    const retried = createRepository({ dataDir: dir, clock: { now: clockNow }, ids: { nextId } });
    retried.close();
    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    const repaired = new DatabaseDriver(dbPath, { readonly: true });
    expect(repaired.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "32" });
    expect(repaired.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toEqual({ value: "1" });
    repaired.close();
    expect(v11Schema(dbPath)).not.toEqual(baselineV11Schema);
    expect(sealedPinTriggerSchema(dbPath)).toHaveLength(2);
  });

  it("corrects an old valid v11 atomically without changing rows or consuming dependencies", () => {
    const dir = makeTmpDataDir();
    const dbPath = databasePath(dir);
    const initial = createRepository({ dataDir: dir });
    initial.close();
    const db = new DatabaseDriver(dbPath);
    seedV10Data(db);
    makeOldV11(db);
    db.close();
    const before = representativeSnapshot(dbPath);
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");

    const corrected = createRepository({ dataDir: dir, clock: { now: clockNow }, ids: { nextId } });
    corrected.close();
    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(representativeSnapshot(dbPath)).toEqual(before);
    const verify = new DatabaseDriver(dbPath, { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toEqual({ value: "1" });
    for (const table of V11_TABLES) {
      expect((verify.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
    }
    verify.close();

    const freshDir = makeTmpDataDir();
    const fresh = createRepository({ dataDir: freshDir });
    fresh.close();
    expect(sealedPinTriggerSchema(dbPath)).toEqual(sealedPinTriggerSchema(databasePath(freshDir)));
  });

  it.each(["unsealed", "missing"])("rejects an old v11 %s exact pin without partial correction, then repairs and retries", (malformation) => {
    const dir = makeTmpDataDir();
    const dbPath = databasePath(dir);
    const initial = createRepository({ dataDir: dir });
    initial.close();
    const db = new DatabaseDriver(dbPath);
    db.pragma("foreign_keys = ON");
    createCampaign(db, "campaign-one");
    db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile-main', 'Main', 'Description', '[]')").run();
    if (malformation === "unsealed") {
      db.prepare(`INSERT INTO rpg_content_packs VALUES
        ('pack-core', '1.0.0', 'profile-main', 'Core', 'Description', '[]', 0)`).run();
    }
    db.prepare("INSERT INTO campaign_rules_profiles VALUES ('campaign-one', 'profile-main')").run();
    makeOldV11(db);
    if (malformation === "missing") db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO campaign_content_packs VALUES ('campaign-one', 'pack-core', '1.0.0', 'profile-main')").run();
    db.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/schema v11 correction blocked:.*exact sealed RPG content pack/);
    const failed = new DatabaseDriver(dbPath);
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toBeUndefined();
    expect(sealedPinTriggerSchema(dbPath)).toEqual([]);
    if (malformation === "missing") {
      failed.pragma("foreign_keys = ON");
      failed.prepare(`INSERT INTO rpg_content_packs VALUES
        ('pack-core', '1.0.0', 'profile-main', 'Core', 'Description', '[]', 0)`).run();
    }
    failed.prepare("UPDATE rpg_content_packs SET sealed = 1 WHERE pack_id = 'pack-core' AND pack_version = '1.0.0'").run();
    failed.close();

    const retried = createRepository({ dataDir: dir });
    retried.close();
    const repaired = new DatabaseDriver(dbPath, { readonly: true });
    expect(repaired.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toEqual({ value: "1" });
    expect(repaired.prepare("SELECT * FROM campaign_content_packs").all()).toHaveLength(1);
    repaired.close();
    expect(sealedPinTriggerSchema(dbPath)).toHaveLength(2);
  });

  it("rolls back a corrective trigger conflict and remains retryable", () => {
    const dir = makeTmpDataDir();
    const dbPath = databasePath(dir);
    const initial = createRepository({ dataDir: dir });
    initial.close();
    const db = new DatabaseDriver(dbPath);
    makeOldV11(db);
    db.exec(`CREATE TRIGGER campaign_content_packs_require_sealed_update
      BEFORE UPDATE ON campaign_content_packs BEGIN SELECT RAISE(ABORT, 'conflict'); END`);
    db.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/trigger campaign_content_packs_require_sealed_update already exists/);
    const failed = new DatabaseDriver(dbPath);
    expect(failed.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get()).toBeUndefined();
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_content_packs_require_sealed_insert'").get())
      .toBeUndefined();
    failed.exec("DROP TRIGGER campaign_content_packs_require_sealed_update");
    failed.close();

    const retried = createRepository({ dataDir: dir });
    retried.close();
    expect(sealedPinTriggerSchema(dbPath)).toHaveLength(2);
  });

  it("performs no schema writes when revision 1 reopens and rejects unknown revisions", () => {
    const dir = makeTmpDataDir();
    const dbPath = databasePath(dir);
    const initial = createRepository({ dataDir: dir });
    initial.close();
    const before = new DatabaseDriver(dbPath);
    const schemaVersion = before.pragma("schema_version", { simple: true });
    const schema = before.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    before.close();
    const reopened = createRepository({ dataDir: dir });
    reopened.close();
    const after = new DatabaseDriver(dbPath);
    expect(after.pragma("schema_version", { simple: true })).toBe(schemaVersion);
    expect(after.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schema);
    after.prepare("UPDATE meta SET value = 'unexpected' WHERE key = 'schemaRevision'").run();
    after.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("unsupported schemaRevision unexpected; expected 1");
  });

  it("enforces resource IDs, canonical times, same-campaign links, cardinality, actor authorization, and literals", () => {
    const { db } = openSeededV11();
    db.pragma("foreign_keys = ON");
    expect(() => insertCampaignCharacter(db, "bad id")).toThrow();
    expect(() => db.prepare("INSERT INTO campaign_characters VALUES ('bad-time', 'campaign-one', 'persona-one', 'bad', ?)").run(AT)).toThrow();
    expect(() => insertCampaignCharacter(db, "missing-persona", "campaign-one", "missing")).toThrow();
    insertCampaignCharacter(db);
    expect(() => insertCampaignCharacter(db, "duplicate-persona")).toThrow();
    insertCampaignCharacter(db, "campaign-character-two", "campaign-two", "persona-one");

    expect(() => insertSheet(db, "bad sheet")).toThrow();
    expect(() => db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
      ('bad-link', 'campaign-two', 'campaign-character-one', 'pack-core', '1.0.0', 'race', 'human',
       'pack-core', '1.0.0', 'background', 'guide', ?, ?)`).run(AT, AT)).toThrow();
    insertSheet(db);
    expect(() => insertSheet(db, "second-sheet")).toThrow();
    expect(() => db.prepare(`INSERT INTO campaign_actors VALUES
      ('bad-kind', 'campaign-one', 'campaign-character-one', 'sheet-one', 'npc', 'principal', ?, ?)`).run(AT, AT)).toThrow();
    expect(() => db.prepare(`INSERT INTO campaign_actors VALUES
      ('bad-control', 'campaign-one', 'campaign-character-one', 'sheet-one', 'player-character', 'ai', ?, ?)`).run(AT, AT)).toThrow();
    expect(() => db.prepare(`INSERT INTO campaign_actors VALUES
      ('bad-link', 'campaign-two', 'campaign-character-two', 'sheet-one', 'player-character', 'principal', ?, ?)`).run(AT, AT)).toThrow();
    db.prepare(`INSERT INTO campaign_actors VALUES
      ('actor-one', 'campaign-one', 'campaign-character-one', 'sheet-one', 'player-character', 'principal', ?, ?)`).run(AT, AT);
    expect(() => db.prepare(`INSERT INTO campaign_actors VALUES
      ('actor-two', 'campaign-one', 'campaign-character-one', 'sheet-one', 'player-character', 'principal', ?, ?)`).run(AT, AT)).toThrow();
    const astral = "\u{1F9B9}";
    db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor-one', 'campaign-one', 'principal-player', ?)")
      .run(astral.repeat(4000));
    expect((db.prepare("SELECT length(private_notes) AS length FROM campaign_actor_private_state").get() as { length: number }).length)
      .toBe(4000);
    db.prepare("DELETE FROM campaign_actor_private_state").run();
    expect(() => db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor-one', 'campaign-one', 'principal-player', ?)")
      .run(astral.repeat(4001))).toThrow();
    expect(() => db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor-one', 'campaign-two', 'principal-player', NULL)").run()).toThrow();
    expect(() => db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor-one', 'campaign-one', 'local-owner-missing', NULL)").run()).toThrow();
    db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor-one', 'campaign-one', 'principal-player', NULL)").run();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("enforces exact campaign pins, exact definitions, bounds, positions, and contract duplicate identities", () => {
    const { db } = openSeededV11();
    db.pragma("foreign_keys = ON");
    insertCampaignCharacter(db);
    expect(() => db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
      ('sheet-unpinned', 'campaign-one', 'campaign-character-one', 'pack-core', '2.0.0', 'race', 'human',
       'pack-core', '1.0.0', 'background', 'guide', ?, ?)`).run(AT, AT)).toThrow();
    expect(() => db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
      ('sheet-wrong-definition', 'campaign-one', 'campaign-character-one', 'pack-core', '1.0.0', 'race', 'guide',
       'pack-core', '1.0.0', 'background', 'guide', ?, ?)`).run(AT, AT)).toThrow();
    expect(() => db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
      ('sheet-unpinned-background', 'campaign-one', 'campaign-character-one', 'pack-core', '1.0.0', 'race', 'human',
       'pack-core', '2.0.0', 'background', 'guide', ?, ?)`).run(AT, AT)).toThrow();
    expect(() => db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
      ('sheet-wrong-background', 'campaign-one', 'campaign-character-one', 'pack-core', '1.0.0', 'race', 'human',
       'pack-core', '1.0.0', 'background', 'human', ?, ?)`).run(AT, AT)).toThrow();
    insertSheet(db);
    expect((db.prepare("SELECT COUNT(*) AS count FROM rpg_character_classes").get() as { count: number }).count).toBe(0);

    const classInsert = db.prepare(`INSERT INTO rpg_character_classes VALUES
      ('campaign-one', 'sheet-one', ?, 'pack-core', ?, 'class', ?, ?)`);
    for (const position of [-1, 16, 1.5]) expect(() => classInsert.run(position, "1.0.0", "fighter", 1)).toThrow();
    for (const level of [0, 101, 1.5]) expect(() => classInsert.run(0, "1.0.0", "fighter", level)).toThrow();
    expect(() => classInsert.run(0, "2.0.0", "fighter", 1)).toThrow();
    expect(() => classInsert.run(0, "1.0.0", "human", 1)).toThrow();
    expect(() => db.prepare(`INSERT INTO rpg_character_classes VALUES
      ('campaign-two', 'sheet-one', 0, 'pack-core', '1.0.0', 'class', 'fighter', 1)`).run()).toThrow();
    classInsert.run(3, "1.0.0", "fighter", 1);
    expect(() => classInsert.run(4, "1.0.0", "fighter", 2)).toThrow();

    const attributeInsert = db.prepare("INSERT INTO rpg_character_attributes VALUES ('campaign-one', 'sheet-one', ?, ?, ?)");
    for (const position of [-1, 64, 1.5]) expect(() => attributeInsert.run(position, "strength", 10)).toThrow();
    for (const value of [-1001, 1001, 1.5]) expect(() => attributeInsert.run(0, "strength", value)).toThrow();
    expect(() => attributeInsert.run(0, "bad id", 10)).toThrow();
    expect(() => db.prepare("INSERT INTO rpg_character_attributes VALUES ('campaign-two', 'sheet-one', 0, 'strength', 10)").run()).toThrow();
    attributeInsert.run(5, "strength", 10);
    expect(() => attributeInsert.run(6, "strength", 11)).toThrow();

    const proficiencyInsert = db.prepare(`INSERT INTO rpg_character_proficiencies
      VALUES ('campaign-one', 'sheet-one', ?, ?, ?)`);
    for (const position of [-1, 128, 1.5]) expect(() => proficiencyInsert.run(position, "skill", "survival")).toThrow();
    expect(() => proficiencyInsert.run(0, "invalid", "survival")).toThrow();
    expect(() => proficiencyInsert.run(0, "skill", "bad id")).toThrow();
    expect(() => db.prepare(`INSERT INTO rpg_character_proficiencies
      VALUES ('campaign-two', 'sheet-one', 0, 'skill', 'survival')`).run()).toThrow();
    proficiencyInsert.run(7, "skill", "survival");
    expect(() => proficiencyInsert.run(8, "skill", "survival")).toThrow();
    proficiencyInsert.run(8, "language", "survival");

    const choiceInsert = db.prepare(`INSERT INTO rpg_character_choices VALUES
      ('campaign-one', 'sheet-one', ?, ?, 'pack-core', ?, ?, ?)`);
    for (const position of [-1, 128, 1.5]) expect(() => choiceInsert.run(position, "choice", "1.0.0", "item", "rope")).toThrow();
    expect(() => choiceInsert.run(0, "bad id", "1.0.0", "item", "rope")).toThrow();
    expect(() => choiceInsert.run(0, "choice", "2.0.0", "item", "rope")).toThrow();
    expect(() => choiceInsert.run(0, "choice", "1.0.0", "spell", "rope")).toThrow();
    expect(() => db.prepare(`INSERT INTO rpg_character_choices VALUES
      ('campaign-two', 'sheet-one', 0, 'choice', 'pack-core', '1.0.0', 'item', 'rope')`).run()).toThrow();
    choiceInsert.run(9, "choice", "1.0.0", "item", "rope");
    expect(() => choiceInsert.run(10, "choice", "1.0.0", "item", "rope")).toThrow();

    expect((db.prepare("SELECT position FROM rpg_character_classes").get() as { position: number }).position).toBe(3);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("restricts personas, pins, and controllers while cascading aggregate/campaign children and retaining global content", () => {
    const { db } = openSeededV11();
    db.pragma("foreign_keys = ON");
    insertCompleteAggregate(db);
    expect(() => db.prepare("DELETE FROM characters WHERE id = 'persona-one'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM campaign_content_packs WHERE campaign_id = 'campaign-one'").run()).toThrow();
    expect(() => db.prepare(`DELETE FROM campaign_memberships
      WHERE campaign_id = 'campaign-one' AND principal_id = 'principal-player'`).run()).toThrow();

    db.prepare("DELETE FROM campaign_characters WHERE id = 'campaign-character-one'").run();
    for (const table of V11_TABLES.slice(1)) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
    }
    expect(db.prepare("SELECT id FROM characters WHERE id = 'persona-one'").get()).toEqual({ id: "persona-one" });
    insertCompleteAggregate(db);
    deleteCampaignForCorruptionTest(db,"campaign-one");db.prepare("DELETE FROM campaigns WHERE id = 'campaign-one'").run();
    for (const table of V11_TABLES) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
    }
    expect(db.prepare("SELECT id FROM characters WHERE id = 'persona-one'").get()).toEqual({ id: "persona-one" });
    expect((db.prepare("SELECT COUNT(*) AS count FROM rpg_rules_profiles").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM rpg_content_packs").get() as { count: number }).count).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS count FROM rpg_definitions").get() as { count: number }).count).toBe(7);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("rolls back a late migrated failure completely and remains retryable", () => {
    const dir = makeTmpDataDir();
    const dbPath = createRepresentativeV10(dir);
    const before = representativeSnapshot(dbPath);
    const conflict = new DatabaseDriver(dbPath);
    conflict.exec("CREATE TABLE campaign_actor_private_state (sentinel TEXT NOT NULL)");
    conflict.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/campaign_actor_private_state already exists/);
    const verify = new DatabaseDriver(dbPath);
    expect((verify.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("10");
    for (const table of V11_TABLES.slice(0, -1)) {
      expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
    }
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'uq_campaign_content_packs_exact_pin'").get()).toBeUndefined();
    verify.exec("DROP TABLE campaign_actor_private_state");
    verify.close();
    expect(representativeSnapshot(dbPath)).toEqual(before);

    const retried = createRepository({ dataDir: dir });
    retried.close();
    const migrated = new DatabaseDriver(dbPath, { readonly: true });
    expect((migrated.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("32");
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("rolls back a late fresh-schema failure completely and remains retryable", () => {
    const dir = makeTmpDataDir();
    const dbPath = databasePath(dir);
    const db = new DatabaseDriver(dbPath);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE campaign_actor_private_state (sentinel TEXT NOT NULL)");
    db.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/campaign_actor_private_state already exists/);
    const verify = new DatabaseDriver(dbPath);
    expect(verify.prepare("SELECT * FROM meta").all()).toEqual([]);
    for (const table of V11_TABLES.slice(0, -1)) {
      expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
    }
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'campaign_content_packs'").get()).toBeUndefined();
    verify.exec("DROP TABLE campaign_actor_private_state");
    verify.close();

    const retried = createRepository({ dataDir: dir });
    retried.close();
    const fresh = new DatabaseDriver(dbPath, { readonly: true });
    expect((fresh.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("32");
    expect(fresh.pragma("foreign_key_check")).toEqual([]);
    fresh.close();
  });
});
