import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { deleteCampaignForCorruptionTest, makeTmpDataDir, removeFutureCharacterBuilderSchema, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const V10_TABLES = [
  "rpg_rules_profiles",
  "rpg_content_packs",
  "rpg_definitions",
  "campaign_rules_profiles",
  "campaign_content_packs",
] as const;

const V11_TABLES = [
  "campaign_actor_private_state",
  "campaign_actors",
  "rpg_character_choices",
  "rpg_character_proficiencies",
  "rpg_character_attributes",
  "rpg_character_classes",
  "rpg_campaign_sheets",
  "campaign_characters",
] as const;

function databasePath(dir: string): string {
  return path.join(dir, "velvet.sqlite");
}

function createRepresentativeV9(dir: string): string {
  const repository = createRepository({ dataDir: dir });
  repository.close();
  const dbPath = databasePath(dir);
  const db = new DatabaseDriver(dbPath);
  db.pragma("foreign_keys = ON");
  const at = "2030-04-05T06:07:08.009Z";
  db.transaction(() => {
    db.prepare("INSERT INTO principals VALUES ('principal-gm', 'GM', 0)").run();
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES ('campaign-v9', 'Preserved campaign', 'timeline-v9', 'local-owner', ?, ?)`).run(at, at);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
      VALUES ('timeline-v9', 'campaign-v9', ?)`).run(at);
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-v9', 'local-owner', 'owner', ?)").run(at);
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-v9', 'principal-gm', 'gm', ?)").run(at);
    db.prepare(`INSERT INTO characters VALUES (
      'character-v9', 'Preserved character', 30, 'guide', 'fictional', 1, 0, ?
    )`).run(at);
    db.prepare(`INSERT INTO sessions VALUES (
      'session-v9', 'character-v9', 'Preserved session', 'active', 'default', NULL, ?, NULL, NULL
    )`).run(at);
    db.prepare("INSERT INTO session_characters VALUES ('session-v9', 'character-v9', 0)").run();
    db.prepare("INSERT INTO campaign_sessions VALUES ('session-v9', 'campaign-v9', ?)").run(at);
  })();
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
  for (const table of V11_TABLES) db.exec(`DROP TABLE ${table}`);
  for (const table of [...V10_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  db.prepare("UPDATE meta SET value = '9' WHERE key = 'schemaVersion'").run();
  db.prepare("DELETE FROM meta WHERE key = 'schemaRevision'").run();
  db.close();
  return dbPath;
}

function representativeSnapshot(dbPath: string): Record<string, unknown[]> {
  const db = new DatabaseDriver(dbPath, { readonly: true });
  const snapshot = {
    campaigns: db.prepare("SELECT * FROM campaigns").all(),
    timelines: db.prepare("SELECT id, campaign_id, created_at FROM campaign_timelines").all(),
    memberships: db.prepare("SELECT * FROM campaign_memberships ORDER BY principal_id").all(),
    sessions: db.prepare("SELECT * FROM sessions").all(),
    sessionCharacters: db.prepare("SELECT * FROM session_characters").all(),
    attachments: db.prepare("SELECT * FROM campaign_sessions").all(),
  };
  db.close();
  return snapshot;
}

function v10Schema(dbPath: string): unknown[] {
  const db = new DatabaseDriver(dbPath, { readonly: true });
  const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name LIKE 'rpg_rules_profiles%' OR name LIKE 'rpg_content_packs%'
      OR name LIKE 'rpg_definitions%' OR name LIKE 'campaign_rules_profiles%'
      OR name LIKE 'campaign_content_packs%' OR name LIKE 'idx_rpg_%'
      OR name LIKE 'idx_campaign_rules_profiles_%' OR name LIKE 'idx_campaign_content_packs_%'
    ORDER BY type, name`).all();
  db.close();
  return schema;
}

function insertProfile(db: DatabaseDriver.Database, id = "profile-main"): void {
  db.prepare(`INSERT INTO rpg_rules_profiles
    (rules_profile_id, name, description, tags) VALUES (?, 'Main rules', 'Metadata only', '["core","core","fantasy"]')`).run(id);
}

function insertPack(
  db: DatabaseDriver.Database,
  packId = "pack-core",
  packVersion = "1.0.0+build.1",
  profileId = "profile-main",
): void {
  db.prepare(`INSERT INTO rpg_content_packs
    (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
    VALUES (?, ?, ?, 'Core pack', 'Immutable metadata', '["core","core"]', 0)`).run(packId, packVersion, profileId);
}

function sealPack(db: DatabaseDriver.Database, packId = "pack-core", packVersion = "1.0.0+build.1"): void {
  db.prepare("UPDATE rpg_content_packs SET sealed = 1 WHERE pack_id = ? AND pack_version = ? AND sealed = 0")
    .run(packId, packVersion);
}

function insertCampaign(db: DatabaseDriver.Database, campaignId = "campaign-content"): void {
  const at = "2030-04-05T06:07:08.009Z";
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, 'Content campaign', ?, 'local-owner', ?, ?)`).run(campaignId, `${campaignId}-timeline`, at, at);
    db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES (?, ?, ?)")
      .run(`${campaignId}-timeline`, campaignId, at);
    db.prepare("INSERT INTO campaign_memberships VALUES (?, 'local-owner', 'owner', ?)").run(campaignId, at);
  })();
}

describe("schema v10 RPG rules and content", () => {
  it("uses identical fresh and migrated DDL, preserves representative v9 data, and creates no content", () => {
    const migratedDir = makeTmpDataDir();
    const migratedPath = createRepresentativeV9(migratedDir);
    const before = representativeSnapshot(migratedPath);
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");

    const migratedRepository = createRepository({
      dataDir: migratedDir,
      clock: { now: clockNow },
      ids: { nextId },
    });
    migratedRepository.close();

    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(representativeSnapshot(migratedPath)).toEqual(before);

    const freshDir = makeTmpDataDir();
    const freshClock = vi.fn(() => new Date());
    const freshId = vi.fn(() => "unused");
    const freshRepository = createRepository({
      dataDir: freshDir,
      clock: { now: freshClock },
      ids: { nextId: freshId },
    });
    freshRepository.close();
    expect(freshClock).not.toHaveBeenCalled();
    expect(freshId).not.toHaveBeenCalled();
    expect(v10Schema(migratedPath)).toEqual(v10Schema(databasePath(freshDir)));

    for (const dbPath of [migratedPath, databasePath(freshDir)]) {
      const db = new DatabaseDriver(dbPath, { readonly: true });
      expect((db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("33");
      for (const table of V10_TABLES) {
        expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
      }
      expect(db.pragma("foreign_key_check")).toEqual([]);
      db.close();
    }
  });

  it("has only the additive metadata columns and explicit foreign-key indexes", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    repository.close();
    const db = new DatabaseDriver(databasePath(dir));

    expect((db.pragma("table_info(rpg_rules_profiles)") as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "rules_profile_id", "name", "description", "tags",
    ]);
    expect((db.pragma("table_info(rpg_content_packs)") as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "pack_id", "pack_version", "rules_profile_id", "name", "description", "tags", "sealed",
    ]);
    expect((db.pragma("table_info(rpg_definitions)") as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "pack_id", "pack_version", "kind", "definition_id", "name", "description", "tags",
    ]);
    expect((db.pragma("table_info(campaign_rules_profiles)") as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "campaign_id", "rules_profile_id",
    ]);
    expect((db.pragma("table_info(campaign_content_packs)") as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "campaign_id", "pack_id", "pack_version", "rules_profile_id",
    ]);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>;
    expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "idx_rpg_content_packs_profile",
      "idx_rpg_definitions_pack",
      "idx_campaign_rules_profiles_profile",
      "idx_campaign_content_packs_profile",
      "idx_campaign_content_packs_pack",
    ]));
    db.close();
  });

  it("enforces exact pack versions, profile ownership, campaign selection, and one pin per pack ID", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    repository.close();
    const db = new DatabaseDriver(databasePath(dir));
    db.pragma("foreign_keys = ON");
    insertProfile(db);
    insertProfile(db, "profile-other");
    insertPack(db);
    insertPack(db, "pack-core", "2", "profile-main");
    insertPack(db, "pack-other", "1", "profile-other");
    insertCampaign(db);

    expect(() => insertPack(db, "pack-missing", "1", "profile-missing")).toThrow();
    expect(() => db.prepare(`INSERT INTO rpg_definitions VALUES
      ('pack-core', 'missing', 'class', 'fighter', 'Fighter', 'A class', '[]')`).run()).toThrow();
    db.prepare(`INSERT INTO rpg_definitions VALUES
      ('pack-core', '1.0.0+build.1', 'class', 'fighter', 'Fighter', 'A class', '[]')`).run();
    db.prepare(`INSERT INTO rpg_definitions VALUES
      ('pack-core', '1.0.0+build.1', 'race', 'fighter', 'Fighter folk', 'A race', '[]')`).run();
    sealPack(db);
    sealPack(db, "pack-core", "2");
    sealPack(db, "pack-other", "1");

    expect(() => db.prepare("INSERT INTO campaign_rules_profiles VALUES ('missing-campaign', 'profile-main')").run()).toThrow();
    db.prepare("INSERT INTO campaign_rules_profiles VALUES ('campaign-content', 'profile-main')").run();
    expect(() => db.prepare(`INSERT INTO campaign_content_packs VALUES
      ('campaign-content', 'pack-other', '1', 'profile-other')`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO campaign_content_packs VALUES
      ('campaign-content', 'pack-core', 'missing', 'profile-main')`).run()).toThrow();
    db.prepare(`INSERT INTO campaign_content_packs VALUES
      ('campaign-content', 'pack-core', '1.0.0+build.1', 'profile-main')`).run();
    expect(() => db.prepare(`INSERT INTO campaign_content_packs VALUES
      ('campaign-content', 'pack-core', '2', 'profile-main')`).run()).toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("requires exact sealed packs when campaign pins are inserted or retargeted", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    repository.close();
    const db = new DatabaseDriver(databasePath(dir));
    db.pragma("foreign_keys = ON");
    insertProfile(db);
    insertPack(db);
    insertPack(db, "pack-next", "1");
    insertCampaign(db);
    db.prepare("INSERT INTO campaign_rules_profiles VALUES ('campaign-content', 'profile-main')").run();

    const insertPin = db.prepare(`INSERT INTO campaign_content_packs VALUES
      ('campaign-content', ?, ?, 'profile-main')`);
    expect(() => insertPin.run("pack-core", "1.0.0+build.1"))
      .toThrow("campaign content packs require an exact sealed RPG content pack");
    sealPack(db);
    insertPin.run("pack-core", "1.0.0+build.1");
    expect(() => db.prepare(`UPDATE campaign_content_packs
      SET pack_id = 'pack-next', pack_version = '1' WHERE campaign_id = 'campaign-content'`).run())
      .toThrow("campaign content packs require an exact sealed RPG content pack");
    expect(db.prepare("SELECT pack_id, pack_version FROM campaign_content_packs").get())
      .toEqual({ pack_id: "pack-core", pack_version: "1.0.0+build.1" });
    sealPack(db, "pack-next", "1");
    db.prepare(`UPDATE campaign_content_packs
      SET pack_id = 'pack-next', pack_version = '1' WHERE campaign_id = 'campaign-content'`).run();
    expect(db.prepare("SELECT pack_id, pack_version FROM campaign_content_packs").get())
      .toEqual({ pack_id: "pack-next", pack_version: "1" });
    db.close();
  });

  it("preserves ordered duplicate tags and rejects invalid arrays, tags, versions, and definition kinds", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    repository.close();
    const db = new DatabaseDriver(databasePath(dir));
    db.pragma("foreign_keys = ON");
    insertProfile(db);
    expect(db.prepare("SELECT tags FROM rpg_rules_profiles WHERE rules_profile_id = 'profile-main'").get()).toEqual({
      tags: '["core","core","fantasy"]',
    });

    const invalidTags = [
      "not-json",
      "{}",
      JSON.stringify(Array.from({ length: 33 }, (_, index) => `tag${index}`)),
      '[""]',
      '[" leading"]',
      '["bad tag"]',
      '[1]',
      JSON.stringify(["x".repeat(65)]),
    ];
    for (const [index, tags] of invalidTags.entries()) {
      expect(() => db.prepare(`INSERT INTO rpg_rules_profiles
        (rules_profile_id, name, description, tags) VALUES (?, 'Invalid', 'Invalid tags', ?)`).run(`invalid-${index}`, tags)).toThrow();
    }
    for (const version of ["", "-first", "with/slash", "x".repeat(65)]) {
      expect(() => insertPack(db, `pack-${version.length}`, version)).toThrow();
    }
    insertPack(db);
    expect(() => db.prepare(`INSERT INTO rpg_definitions VALUES
      ('pack-core', '1.0.0+build.1', 'feat', 'invalid', 'Invalid', 'Invalid kind', '[]')`).run()).toThrow();
    for (const kind of ["class", "race", "background", "item", "spell", "ability", "enemy"]) {
      db.prepare(`INSERT INTO rpg_definitions VALUES
        ('pack-core', '1.0.0+build.1', ?, ?, ?, 'Valid definition', '["ordered","ordered"]')`)
        .run(kind, `${kind}-id`, kind);
    }
    sealPack(db);
    expect((db.prepare("SELECT COUNT(*) AS count FROM rpg_definitions").get() as { count: number }).count).toBe(7);
    db.close();
  });

  it("keeps packs and definitions immutable, restricts globals, and cascades only campaign selections and pins", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    repository.close();
    const db = new DatabaseDriver(databasePath(dir));
    db.pragma("foreign_keys = ON");
    insertProfile(db);
    insertPack(db);
    db.prepare(`INSERT INTO rpg_definitions VALUES
      ('pack-core', '1.0.0+build.1', 'class', 'fighter', 'Fighter', 'A class', '[]')`).run();
    sealPack(db);
    insertCampaign(db);
    db.prepare("INSERT INTO campaign_rules_profiles VALUES ('campaign-content', 'profile-main')").run();
    db.prepare(`INSERT INTO campaign_content_packs VALUES
      ('campaign-content', 'pack-core', '1.0.0+build.1', 'profile-main')`).run();

    expect(() => db.prepare("UPDATE rpg_content_packs SET name = 'Changed'").run()).toThrow("RPG content packs are immutable");
    expect(() => db.prepare("DELETE FROM rpg_content_packs").run()).toThrow("RPG content packs are immutable");
    expect(() => db.prepare("UPDATE rpg_definitions SET name = 'Changed'").run()).toThrow("RPG definitions are immutable");
    expect(() => db.prepare("DELETE FROM rpg_definitions").run()).toThrow("RPG definitions are immutable");
    expect(() => db.prepare(`INSERT INTO rpg_definitions VALUES
      ('pack-core', '1.0.0+build.1', 'class', 'rogue', 'Rogue', 'A class', '[]')`).run())
      .toThrow("sealed RPG content packs cannot accept definitions");
    expect(() => db.prepare("UPDATE rpg_rules_profiles SET name = 'Changed'").run())
      .toThrow("referenced RPG rules profiles are immutable");
    expect(() => db.prepare("DELETE FROM rpg_rules_profiles WHERE rules_profile_id = 'profile-main'").run()).toThrow();

    deleteCampaignForCorruptionTest(db,"campaign-content");db.prepare("DELETE FROM campaigns WHERE id = 'campaign-content'").run();
    expect(db.prepare("SELECT * FROM campaign_rules_profiles").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM campaign_content_packs").all()).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM rpg_rules_profiles").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM rpg_content_packs").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM rpg_definitions").get() as { count: number }).count).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("exposes only sealed aggregates and permits only the exact one-way seal transition", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    repository.close();
    const db = new DatabaseDriver(databasePath(dir));
    db.pragma("foreign_keys = ON");
    insertProfile(db);
    insertPack(db);
    db.prepare(`INSERT INTO rpg_definitions VALUES
      ('pack-core', '1.0.0+build.1', 'class', 'fighter', 'Fighter', 'A class', '[]')`).run();

    const reads = createRepository({ dataDir: dir });
    expect(reads.listContentPacks("local-owner")).toEqual([]);
    expect(reads.getContentPack("local-owner", { packId: "pack-core", packVersion: "1.0.0+build.1" })).toBeNull();
    expect(reads.listContentPackDefinitions("local-owner", { packId: "pack-core", packVersion: "1.0.0+build.1" })).toEqual([]);
    expect(() => db.prepare("UPDATE rpg_content_packs SET sealed = 1, name = 'Changed'").run())
      .toThrow("RPG content packs are immutable");
    sealPack(db);
    expect(reads.listContentPacks("local-owner")).toHaveLength(1);
    expect(reads.listContentPackDefinitions("local-owner", { packId: "pack-core", packVersion: "1.0.0+build.1" })).toHaveLength(1);
    expect(() => db.prepare("UPDATE rpg_content_packs SET sealed = 0").run()).toThrow("RPG content packs are immutable");
    expect(() => db.prepare("UPDATE rpg_content_packs SET sealed = 1").run()).toThrow("RPG content packs are immutable");
    reads.close();
    db.close();
  });

  it("allows unreferenced profile correction but rejects updates after pack or campaign reference", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    repository.close();
    const db = new DatabaseDriver(databasePath(dir));
    db.pragma("foreign_keys = ON");
    insertProfile(db);
    db.prepare("UPDATE rpg_rules_profiles SET name = 'Corrected rules' WHERE rules_profile_id = 'profile-main'").run();
    expect(db.prepare("SELECT name FROM rpg_rules_profiles WHERE rules_profile_id = 'profile-main'").get())
      .toEqual({ name: "Corrected rules" });
    insertPack(db);
    expect(() => db.prepare("UPDATE rpg_rules_profiles SET description = 'Changed' WHERE rules_profile_id = 'profile-main'").run())
      .toThrow("referenced RPG rules profiles are immutable");

    insertProfile(db, "profile-selected");
    insertCampaign(db);
    db.prepare("INSERT INTO campaign_rules_profiles VALUES ('campaign-content', 'profile-selected')").run();
    expect(() => db.prepare("UPDATE rpg_rules_profiles SET name = 'Changed' WHERE rules_profile_id = 'profile-selected'").run())
      .toThrow("referenced RPG rules profiles are immutable");
    db.close();
  });

  it("rolls back late migration failure completely and remains retryable", () => {
    const dir = makeTmpDataDir();
    const dbPath = createRepresentativeV9(dir);
    const before = representativeSnapshot(dbPath);
    const conflict = new DatabaseDriver(dbPath);
    conflict.exec("CREATE TABLE campaign_content_packs (sentinel TEXT NOT NULL)");
    conflict.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/campaign_content_packs already exists/);

    const verify = new DatabaseDriver(dbPath);
    expect((verify.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("9");
    for (const table of V10_TABLES.slice(0, -1)) {
      expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
    }
    expect(verify.pragma("table_info(campaign_content_packs)")).toEqual([
      expect.objectContaining({ name: "sentinel", type: "TEXT", notnull: 1 }),
    ]);
    verify.exec("DROP TABLE campaign_content_packs");
    verify.close();
    expect(representativeSnapshot(dbPath)).toEqual(before);

    const repository = createRepository({ dataDir: dir });
    repository.close();
    const migrated = new DatabaseDriver(dbPath, { readonly: true });
    expect((migrated.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("33");
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("rolls back late fresh-schema failure completely and remains retryable", () => {
    const dir = makeTmpDataDir();
    const dbPath = databasePath(dir);
    const db = new DatabaseDriver(dbPath);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE campaign_content_packs (sentinel TEXT NOT NULL)");
    db.close();

    expect(() => createRepository({ dataDir: dir })).toThrow(/campaign_content_packs already exists/);
    const verify = new DatabaseDriver(dbPath);
    expect(verify.prepare("SELECT * FROM meta").all()).toEqual([]);
    for (const table of V10_TABLES.slice(0, -1)) {
      expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
    }
    verify.exec("DROP TABLE campaign_content_packs");
    verify.close();

    const repository = createRepository({ dataDir: dir });
    repository.close();
    const retried = new DatabaseDriver(dbPath, { readonly: true });
    expect((retried.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("33");
    expect(retried.pragma("foreign_key_check")).toEqual([]);
    retried.close();
  });
});
