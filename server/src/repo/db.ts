import DatabaseDriver from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadLegacyDatabase, markLegacyMigrated } from "../legacy.js";
import { systemRuntime } from "../runtime.js";
import type { RuntimeDependencies } from "../runtime.js";
import type { Database } from "../types.js";
import { configureRepositoryDatabase } from "./repoContext.js";


const SCHEMA_VERSION = "14";
const SCHEMA_REVISION = "1";
const SQLITE_FILENAME = "velvet.sqlite";

export function resolveDataDir(): string {
  const override = process.env.VELVET_DATA_DIR;
  return path.resolve(override && override.trim() !== "" ? override : path.join(process.cwd(), "data"));
}

let connection: { dir: string; db: DatabaseDriver.Database } | null = null;

export function openRepositoryDatabase(dir: string, dependencies: RuntimeDependencies): DatabaseDriver.Database {
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort, matches previous behavior
  }
  const db = new DatabaseDriver(path.join(dir, SQLITE_FILENAME));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    ensureSchema(db);
    migrateLegacyIfPresent(db, dir, dependencies);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function getDb(): DatabaseDriver.Database {
  const dir = resolveDataDir();
  if (connection && connection.dir === dir) return connection.db;
  if (connection) {
    connection.db.close();
    connection = null;
  }
  const db = openRepositoryDatabase(dir, systemRuntime);
  connection = { dir, db };
  return db;
}

configureRepositoryDatabase(getDb);

export function closeRepo(): void {
  if (connection) {
    connection.db.close();
    connection = null;
  }
}

function ensureSchema(db: DatabaseDriver.Database): void {
  const hasMeta = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  ).get();
  if (!hasMeta) {
    db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string } | undefined;
  if (!row) {
    db.transaction(() => {
      createSchemaV11(db);
      createTimelineRevisionV12(db);
      createRpgCommandAuditV14(db);
      createCampaignEventMatchingTriggerV14(db);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)").run(SCHEMA_VERSION);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schemaRevision', ?)").run(SCHEMA_REVISION);
    })();
    return;
  }
  let version = row.value;
  if (version === "2") {
    migrate2to3(db);
    version = "3";
  }
  if (version === "3") {
    migrate3to4(db);
    version = "4";
  }
  if (version === "4") {
    migrate4to5(db);
    version = "5";
  }
  if (version === "5") {
    migrate5to6(db);
    version = "6";
  }
  if (version === "6") {
    migrate6to7(db);
    version = "7";
  }
  if (version === "7") {
    migrate7to8(db);
    version = "8";
  }
  if (version === "8") {
    migrate8to9(db);
    version = "9";
  }
  if (version === "9") {
    migrate9to10(db);
    version = "10";
  }
  if (version === "10") {
    migrate10to11(db);
    version = "11";
  }
  if (version === "11") {
    // Revision-1 repairs are part of the v11 contract and must complete before
    // v12 builds foreign keys on top of that schema.
    ensureSchemaRevisionV11(db);
    migrate11to12(db);
    version = "12";
  }
  if (version === "12") {
    migrate12to13(db);
    version = "13";
  }
  if (version === "13") {
    // V13 revision compatibility must be established before its destructive
    // table rebuild begins. Keep the current-schema assertion below as a
    // post-migration guard as well.
    assertCurrentSchemaRevision(db);
    migrate13to14(db);
    version = "14";
  }
  if (version !== SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion ${version}; expected ${SCHEMA_VERSION}`);
  }
  assertCurrentSchemaRevision(db);
}

function assertCurrentSchemaRevision(db: DatabaseDriver.Database): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get() as { value: string } | undefined;
  if (row?.value !== SCHEMA_REVISION) {
    throw new Error(`unsupported schemaRevision ${row?.value ?? "missing"}; expected ${SCHEMA_REVISION}`);
  }
}

function ensureSchemaRevisionV11(db: DatabaseDriver.Database): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get() as { value: string } | undefined;
  if (row?.value === SCHEMA_REVISION) return;
  if (row) {
    throw new Error(`unsupported schemaRevision ${row.value}; expected ${SCHEMA_REVISION}`);
  }
  db.transaction(() => {
    assertCampaignContentPacksHaveExactSealedPacks(db);
    createCampaignContentPackSealedPinTriggers(db);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schemaRevision', ?)").run(SCHEMA_REVISION);
  })();
}

function assertCampaignContentPacksHaveExactSealedPacks(db: DatabaseDriver.Database): void {
  const invalidPin = db.prepare(`SELECT cp.campaign_id, cp.pack_id, cp.pack_version, cp.rules_profile_id
    FROM campaign_content_packs cp
    WHERE NOT EXISTS (
      SELECT 1 FROM rpg_content_packs p
      WHERE p.pack_id = cp.pack_id AND p.pack_version = cp.pack_version
        AND p.rules_profile_id = cp.rules_profile_id AND p.sealed = 1
    )
    ORDER BY cp.campaign_id, cp.pack_id
    LIMIT 1`).get() as {
      campaign_id: string;
      pack_id: string;
      pack_version: string;
      rules_profile_id: string;
    } | undefined;
  if (invalidPin) {
    throw new Error(
      `schema v11 correction blocked: campaign content pin ${invalidPin.campaign_id}/${invalidPin.pack_id}` +
      `@${invalidPin.pack_version} (${invalidPin.rules_profile_id}) has no exact sealed RPG content pack; repair it and retry`,
    );
  }
}

function createSchemaV11(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      age INTEGER NOT NULL,
      archetype TEXT NOT NULL,
      boundaries TEXT NOT NULL,
      safe_word TEXT NOT NULL,
      fictional_confirmed INTEGER NOT NULL,
      is_real_person INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      active_leaf_id TEXT REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED,
      created_at TEXT NOT NULL,
      stopped_at TEXT,
      stop_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS consent_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      scope TEXT NOT NULL,
      granted INTEGER NOT NULL,
      note TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_characters (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL,
      PRIMARY KEY (session_id, character_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      speaker_character_id TEXT REFERENCES characters(id) ON DELETE RESTRICT,
      content TEXT NOT NULL,
      parent_id TEXT REFERENCES messages(id),
      swipe_group_id TEXT,
      swipe_index INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'final',
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      usage_source TEXT,
      usage_model TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      user_approved INTEGER NOT NULL,
      forgotten_at TEXT
    );
    CREATE TABLE IF NOT EXISTS summaries (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      key_events TEXT NOT NULL,
      emotional_beat TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_context (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      source_of_truth TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synthesized_source TEXT NOT NULL DEFAULT '',
      synthesized_updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS lore (
      id TEXT PRIMARY KEY,
      character_id TEXT,
      keys TEXT NOT NULL,
      content TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      insertion_order REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lore_characters (
      lore_id TEXT NOT NULL REFERENCES lore(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      PRIMARY KEY (lore_id, character_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_message_id TEXT UNIQUE,
      kind TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      usage_source TEXT NOT NULL,
      usage_model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id, created_at);
  `);
  createRpgFoundationV9(db);
  createRpgContentV10(db);
  createCampaignContentPackSealedPinTriggers(db);
  createRpgCharactersV11(db);
}

function createRpgFoundationV9(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE principals (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 100),
      is_local INTEGER NOT NULL CHECK (is_local IN (0, 1))
    );
    CREATE UNIQUE INDEX idx_principals_one_local ON principals(is_local) WHERE is_local = 1;
    CREATE TABLE application_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id) ON DELETE RESTRICT
    );
    CREATE TRIGGER application_owner_prevent_delete
      BEFORE DELETE ON application_owner
      BEGIN SELECT RAISE(ABORT, 'application owner is required'); END;

    CREATE TABLE campaigns (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
      active_timeline_id TEXT NOT NULL
        CHECK (length(active_timeline_id) BETWEEN 1 AND 128 AND active_timeline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      owner_principal_id TEXT NOT NULL
        CHECK (length(owner_principal_id) BETWEEN 1 AND 128 AND owner_principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      owner_role TEXT NOT NULL DEFAULT 'owner' CHECK (owner_role = 'owner'),
      created_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
        AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
        AND substr(created_at, 12, 2) BETWEEN '00' AND '23'
      ),
      updated_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
        AND updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
        AND substr(updated_at, 12, 2) BETWEEN '00' AND '23'
      ),
      CHECK (updated_at >= created_at),
      FOREIGN KEY (id, active_timeline_id) REFERENCES campaign_timelines(campaign_id, id)
        DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (id, owner_principal_id, owner_role)
        REFERENCES campaign_memberships(campaign_id, principal_id, role)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX idx_campaigns_active_timeline ON campaigns(active_timeline_id);

    CREATE TABLE campaign_timelines (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      created_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
        AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
        AND substr(created_at, 12, 2) BETWEEN '00' AND '23'
      ),
      UNIQUE (campaign_id, id)
    );
    CREATE INDEX idx_campaign_timelines_campaign ON campaign_timelines(campaign_id, created_at, id);

    CREATE TABLE campaign_memberships (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      role TEXT NOT NULL CHECK (role IN ('owner', 'gm', 'player', 'observer')),
      created_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
        AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
        AND substr(created_at, 12, 2) BETWEEN '00' AND '23'
      ),
      PRIMARY KEY (campaign_id, principal_id),
      UNIQUE (campaign_id, principal_id, role)
    );
    CREATE UNIQUE INDEX idx_campaign_memberships_one_owner
      ON campaign_memberships(campaign_id) WHERE role = 'owner';
    CREATE INDEX idx_campaign_memberships_principal
      ON campaign_memberships(principal_id, campaign_id);

    CREATE TABLE campaign_sessions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      attached_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', attached_at) IS NOT NULL
        AND attached_at = strftime('%Y-%m-%dT%H:%M:%fZ', attached_at)
        AND substr(attached_at, 12, 2) BETWEEN '00' AND '23'
      )
    );
    CREATE INDEX idx_campaign_sessions_campaign
      ON campaign_sessions(campaign_id, attached_at, session_id);

    INSERT INTO principals (id, display_name, is_local) VALUES ('local-owner', 'Local owner', 1);
    INSERT INTO application_owner (singleton, principal_id) VALUES (1, 'local-owner');
  `);
}

function createRpgContentV10(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_rules_profiles (
      rules_profile_id TEXT PRIMARY KEY
        CHECK (length(rules_profile_id) BETWEEN 1 AND 128 AND rules_profile_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      name TEXT NOT NULL CHECK (name = trim(name) AND length(name) BETWEEN 1 AND 200),
      description TEXT NOT NULL CHECK (description = trim(description) AND length(description) BETWEEN 1 AND 4000),
      tags TEXT NOT NULL CHECK (
        json_valid(tags) AND json_type(tags) = 'array' AND json_array_length(tags) <= 32
      )
    );

    CREATE TABLE rpg_content_packs (
      pack_id TEXT NOT NULL
        CHECK (length(pack_id) BETWEEN 1 AND 128 AND pack_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      pack_version TEXT NOT NULL CHECK (
        length(pack_version) BETWEEN 1 AND 64
        AND pack_version NOT GLOB '*[^A-Za-z0-9._+-]*'
        AND substr(pack_version, 1, 1) GLOB '[A-Za-z0-9]'
      ),
      rules_profile_id TEXT NOT NULL,
      name TEXT NOT NULL CHECK (name = trim(name) AND length(name) BETWEEN 1 AND 200),
      description TEXT NOT NULL CHECK (description = trim(description) AND length(description) BETWEEN 1 AND 4000),
      tags TEXT NOT NULL CHECK (
        json_valid(tags) AND json_type(tags) = 'array' AND json_array_length(tags) <= 32
      ),
      sealed INTEGER NOT NULL CHECK (sealed IN (0, 1)),
      PRIMARY KEY (pack_id, pack_version),
      UNIQUE (pack_id, pack_version, rules_profile_id),
      FOREIGN KEY (rules_profile_id) REFERENCES rpg_rules_profiles(rules_profile_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_rpg_content_packs_profile ON rpg_content_packs(rules_profile_id);

    CREATE TABLE rpg_definitions (
      pack_id TEXT NOT NULL,
      pack_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('class', 'race', 'background', 'item', 'spell', 'ability', 'enemy')),
      definition_id TEXT NOT NULL
        CHECK (length(definition_id) BETWEEN 1 AND 128 AND definition_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      name TEXT NOT NULL CHECK (name = trim(name) AND length(name) BETWEEN 1 AND 200),
      description TEXT NOT NULL CHECK (description = trim(description) AND length(description) BETWEEN 1 AND 4000),
      tags TEXT NOT NULL CHECK (
        json_valid(tags) AND json_type(tags) = 'array' AND json_array_length(tags) <= 32
      ),
      PRIMARY KEY (pack_id, pack_version, kind, definition_id),
      FOREIGN KEY (pack_id, pack_version) REFERENCES rpg_content_packs(pack_id, pack_version) ON DELETE RESTRICT
    );
    CREATE INDEX idx_rpg_definitions_pack ON rpg_definitions(pack_id, pack_version);

    CREATE TABLE campaign_rules_profiles (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
      rules_profile_id TEXT NOT NULL REFERENCES rpg_rules_profiles(rules_profile_id) ON DELETE RESTRICT,
      UNIQUE (campaign_id, rules_profile_id)
    );
    CREATE INDEX idx_campaign_rules_profiles_profile ON campaign_rules_profiles(rules_profile_id);

    CREATE TABLE campaign_content_packs (
      campaign_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      pack_version TEXT NOT NULL,
      rules_profile_id TEXT NOT NULL,
      PRIMARY KEY (campaign_id, pack_id),
      FOREIGN KEY (campaign_id, rules_profile_id)
        REFERENCES campaign_rules_profiles(campaign_id, rules_profile_id) ON DELETE CASCADE,
      FOREIGN KEY (pack_id, pack_version, rules_profile_id)
        REFERENCES rpg_content_packs(pack_id, pack_version, rules_profile_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_content_packs_profile
      ON campaign_content_packs(campaign_id, rules_profile_id);
    CREATE INDEX idx_campaign_content_packs_pack
      ON campaign_content_packs(pack_id, pack_version, rules_profile_id);

    CREATE TRIGGER rpg_rules_profiles_tags_insert
      BEFORE INSERT ON rpg_rules_profiles
      WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.tags)
        WHERE type <> 'text' OR value <> trim(value) OR length(value) NOT BETWEEN 1 AND 64
          OR value GLOB '*[^A-Za-z0-9._:-]*'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid RPG content tag'); END;
    CREATE TRIGGER rpg_rules_profiles_tags_update
      BEFORE UPDATE OF tags ON rpg_rules_profiles
      WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.tags)
        WHERE type <> 'text' OR value <> trim(value) OR length(value) NOT BETWEEN 1 AND 64
          OR value GLOB '*[^A-Za-z0-9._:-]*'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid RPG content tag'); END;
    CREATE TRIGGER rpg_content_packs_tags_insert
      BEFORE INSERT ON rpg_content_packs
      WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.tags)
        WHERE type <> 'text' OR value <> trim(value) OR length(value) NOT BETWEEN 1 AND 64
          OR value GLOB '*[^A-Za-z0-9._:-]*'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid RPG content tag'); END;
    CREATE TRIGGER rpg_content_packs_tags_update
      BEFORE UPDATE OF tags ON rpg_content_packs
      WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.tags)
        WHERE type <> 'text' OR value <> trim(value) OR length(value) NOT BETWEEN 1 AND 64
          OR value GLOB '*[^A-Za-z0-9._:-]*'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid RPG content tag'); END;
    CREATE TRIGGER rpg_definitions_tags_insert
      BEFORE INSERT ON rpg_definitions
      WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.tags)
        WHERE type <> 'text' OR value <> trim(value) OR length(value) NOT BETWEEN 1 AND 64
          OR value GLOB '*[^A-Za-z0-9._:-]*'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid RPG content tag'); END;
    CREATE TRIGGER rpg_definitions_tags_update
      BEFORE UPDATE OF tags ON rpg_definitions
      WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.tags)
        WHERE type <> 'text' OR value <> trim(value) OR length(value) NOT BETWEEN 1 AND 64
          OR value GLOB '*[^A-Za-z0-9._:-]*'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid RPG content tag'); END;

    CREATE TRIGGER rpg_rules_profiles_prevent_referenced_update
      BEFORE UPDATE ON rpg_rules_profiles
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs WHERE rules_profile_id = OLD.rules_profile_id)
        OR EXISTS (SELECT 1 FROM campaign_rules_profiles WHERE rules_profile_id = OLD.rules_profile_id)
      BEGIN SELECT RAISE(ABORT, 'referenced RPG rules profiles are immutable'); END;
    CREATE TRIGGER rpg_content_packs_prevent_update
      BEFORE UPDATE ON rpg_content_packs
      WHEN NOT (
        OLD.sealed = 0 AND NEW.sealed = 1
        AND NEW.pack_id = OLD.pack_id AND NEW.pack_version = OLD.pack_version
        AND NEW.rules_profile_id = OLD.rules_profile_id AND NEW.name = OLD.name
        AND NEW.description = OLD.description AND NEW.tags = OLD.tags
      )
      BEGIN SELECT RAISE(ABORT, 'RPG content packs are immutable'); END;
    CREATE TRIGGER rpg_content_packs_prevent_delete
      BEFORE DELETE ON rpg_content_packs
      BEGIN SELECT RAISE(ABORT, 'RPG content packs are immutable'); END;
    CREATE TRIGGER rpg_definitions_prevent_update
      BEFORE UPDATE ON rpg_definitions
      BEGIN SELECT RAISE(ABORT, 'RPG definitions are immutable'); END;
    CREATE TRIGGER rpg_definitions_prevent_delete
      BEFORE DELETE ON rpg_definitions
      BEGIN SELECT RAISE(ABORT, 'RPG definitions are immutable'); END;
    CREATE TRIGGER rpg_definitions_prevent_sealed_insert
      BEFORE INSERT ON rpg_definitions
      WHEN EXISTS (
        SELECT 1 FROM rpg_content_packs
        WHERE pack_id = NEW.pack_id AND pack_version = NEW.pack_version AND sealed = 1
      )
      BEGIN SELECT RAISE(ABORT, 'sealed RPG content packs cannot accept definitions'); END;
  `);
}

function createCampaignContentPackSealedPinTriggers(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TRIGGER campaign_content_packs_require_sealed_insert
      BEFORE INSERT ON campaign_content_packs
      WHEN NOT EXISTS (
        SELECT 1 FROM rpg_content_packs p
        WHERE p.pack_id = NEW.pack_id AND p.pack_version = NEW.pack_version
          AND p.rules_profile_id = NEW.rules_profile_id AND p.sealed = 1
      )
      BEGIN SELECT RAISE(ABORT, 'campaign content packs require an exact sealed RPG content pack'); END;
    CREATE TRIGGER campaign_content_packs_require_sealed_update
      BEFORE UPDATE OF pack_id, pack_version, rules_profile_id ON campaign_content_packs
      WHEN NOT EXISTS (
        SELECT 1 FROM rpg_content_packs p
        WHERE p.pack_id = NEW.pack_id AND p.pack_version = NEW.pack_version
          AND p.rules_profile_id = NEW.rules_profile_id AND p.sealed = 1
      )
      BEGIN SELECT RAISE(ABORT, 'campaign content packs require an exact sealed RPG content pack'); END;
  `);
}

function createRpgCharactersV11(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE UNIQUE INDEX uq_campaign_content_packs_exact_pin
      ON campaign_content_packs(campaign_id, pack_id, pack_version);

    CREATE TABLE campaign_characters (
      id TEXT PRIMARY KEY
        CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      character_id TEXT NOT NULL CHECK (length(character_id) >= 1),
      created_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
        AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
        AND substr(created_at, 12, 2) BETWEEN '00' AND '23'
      ),
      updated_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
        AND updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
        AND substr(updated_at, 12, 2) BETWEEN '00' AND '23'
      ),
      CHECK (updated_at >= created_at),
      UNIQUE (campaign_id, character_id),
      UNIQUE (campaign_id, id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_characters_character ON campaign_characters(character_id);

    CREATE TABLE rpg_campaign_sheets (
      id TEXT PRIMARY KEY
        CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      campaign_character_id TEXT NOT NULL,
      race_pack_id TEXT NOT NULL,
      race_pack_version TEXT NOT NULL,
      race_kind TEXT NOT NULL CHECK (race_kind = 'race'),
      race_definition_id TEXT NOT NULL,
      background_pack_id TEXT NOT NULL,
      background_pack_version TEXT NOT NULL,
      background_kind TEXT NOT NULL CHECK (background_kind = 'background'),
      background_definition_id TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
        AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
        AND substr(created_at, 12, 2) BETWEEN '00' AND '23'
      ),
      updated_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
        AND updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
        AND substr(updated_at, 12, 2) BETWEEN '00' AND '23'
      ),
      CHECK (updated_at >= created_at),
      UNIQUE (campaign_character_id),
      UNIQUE (campaign_id, id),
      UNIQUE (campaign_id, id, campaign_character_id),
      FOREIGN KEY (campaign_id, campaign_character_id)
        REFERENCES campaign_characters(campaign_id, id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id, race_pack_id, race_pack_version)
        REFERENCES campaign_content_packs(campaign_id, pack_id, pack_version) ON DELETE NO ACTION,
      FOREIGN KEY (race_pack_id, race_pack_version, race_kind, race_definition_id)
        REFERENCES rpg_definitions(pack_id, pack_version, kind, definition_id) ON DELETE NO ACTION,
      FOREIGN KEY (campaign_id, background_pack_id, background_pack_version)
        REFERENCES campaign_content_packs(campaign_id, pack_id, pack_version) ON DELETE NO ACTION,
      FOREIGN KEY (background_pack_id, background_pack_version, background_kind, background_definition_id)
        REFERENCES rpg_definitions(pack_id, pack_version, kind, definition_id) ON DELETE NO ACTION
    );
    CREATE INDEX idx_rpg_campaign_sheets_character
      ON rpg_campaign_sheets(campaign_id, campaign_character_id);
    CREATE INDEX idx_rpg_campaign_sheets_race_pin
      ON rpg_campaign_sheets(campaign_id, race_pack_id, race_pack_version);
    CREATE INDEX idx_rpg_campaign_sheets_race_definition
      ON rpg_campaign_sheets(race_pack_id, race_pack_version, race_kind, race_definition_id);
    CREATE INDEX idx_rpg_campaign_sheets_background_pin
      ON rpg_campaign_sheets(campaign_id, background_pack_id, background_pack_version);
    CREATE INDEX idx_rpg_campaign_sheets_background_definition
      ON rpg_campaign_sheets(background_pack_id, background_pack_version, background_kind, background_definition_id);

    CREATE TABLE rpg_character_classes (
      campaign_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position BETWEEN 0 AND 15),
      pack_id TEXT NOT NULL,
      pack_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'class'),
      definition_id TEXT NOT NULL,
      level INTEGER NOT NULL CHECK (typeof(level) = 'integer' AND level BETWEEN 1 AND 100),
      PRIMARY KEY (sheet_id, position),
      UNIQUE (sheet_id, pack_id, pack_version, definition_id),
      FOREIGN KEY (campaign_id, sheet_id)
        REFERENCES rpg_campaign_sheets(campaign_id, id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id, pack_id, pack_version)
        REFERENCES campaign_content_packs(campaign_id, pack_id, pack_version) ON DELETE NO ACTION,
      FOREIGN KEY (pack_id, pack_version, kind, definition_id)
        REFERENCES rpg_definitions(pack_id, pack_version, kind, definition_id) ON DELETE NO ACTION
    );
    CREATE INDEX idx_rpg_character_classes_sheet ON rpg_character_classes(campaign_id, sheet_id);
    CREATE INDEX idx_rpg_character_classes_pin ON rpg_character_classes(campaign_id, pack_id, pack_version);
    CREATE INDEX idx_rpg_character_classes_definition
      ON rpg_character_classes(pack_id, pack_version, kind, definition_id);

    CREATE TABLE rpg_character_attributes (
      campaign_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position BETWEEN 0 AND 63),
      attribute_id TEXT NOT NULL
        CHECK (length(attribute_id) BETWEEN 1 AND 128 AND attribute_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      value INTEGER NOT NULL CHECK (typeof(value) = 'integer' AND value BETWEEN -1000 AND 1000),
      PRIMARY KEY (sheet_id, position),
      UNIQUE (sheet_id, attribute_id),
      FOREIGN KEY (campaign_id, sheet_id)
        REFERENCES rpg_campaign_sheets(campaign_id, id) ON DELETE CASCADE
    );
    CREATE INDEX idx_rpg_character_attributes_sheet ON rpg_character_attributes(campaign_id, sheet_id);

    CREATE TABLE rpg_character_proficiencies (
      campaign_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position BETWEEN 0 AND 127),
      category TEXT NOT NULL CHECK (category IN ('skill', 'saving-throw', 'tool', 'weapon', 'armor', 'language')),
      proficiency_id TEXT NOT NULL
        CHECK (length(proficiency_id) BETWEEN 1 AND 128 AND proficiency_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY (sheet_id, position),
      UNIQUE (sheet_id, category, proficiency_id),
      FOREIGN KEY (campaign_id, sheet_id)
        REFERENCES rpg_campaign_sheets(campaign_id, id) ON DELETE CASCADE
    );
    CREATE INDEX idx_rpg_character_proficiencies_sheet ON rpg_character_proficiencies(campaign_id, sheet_id);

    CREATE TABLE rpg_character_choices (
      campaign_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position BETWEEN 0 AND 127),
      choice_id TEXT NOT NULL
        CHECK (length(choice_id) BETWEEN 1 AND 128 AND choice_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      pack_id TEXT NOT NULL,
      pack_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('class', 'race', 'background', 'item', 'spell', 'ability', 'enemy')),
      definition_id TEXT NOT NULL,
      PRIMARY KEY (sheet_id, position),
      UNIQUE (sheet_id, choice_id),
      FOREIGN KEY (campaign_id, sheet_id)
        REFERENCES rpg_campaign_sheets(campaign_id, id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id, pack_id, pack_version)
        REFERENCES campaign_content_packs(campaign_id, pack_id, pack_version) ON DELETE NO ACTION,
      FOREIGN KEY (pack_id, pack_version, kind, definition_id)
        REFERENCES rpg_definitions(pack_id, pack_version, kind, definition_id) ON DELETE NO ACTION
    );
    CREATE INDEX idx_rpg_character_choices_sheet ON rpg_character_choices(campaign_id, sheet_id);
    CREATE INDEX idx_rpg_character_choices_pin ON rpg_character_choices(campaign_id, pack_id, pack_version);
    CREATE INDEX idx_rpg_character_choices_definition
      ON rpg_character_choices(pack_id, pack_version, kind, definition_id);

    CREATE TABLE campaign_actors (
      id TEXT PRIMARY KEY
        CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      campaign_character_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'player-character'),
      control TEXT NOT NULL CHECK (control = 'principal'),
      created_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
        AND created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
        AND substr(created_at, 12, 2) BETWEEN '00' AND '23'
      ),
      updated_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
        AND updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
        AND substr(updated_at, 12, 2) BETWEEN '00' AND '23'
      ),
      CHECK (updated_at >= created_at),
      UNIQUE (campaign_character_id),
      UNIQUE (campaign_id, id),
      FOREIGN KEY (campaign_id, campaign_character_id)
        REFERENCES campaign_characters(campaign_id, id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id, sheet_id, campaign_character_id)
        REFERENCES rpg_campaign_sheets(campaign_id, id, campaign_character_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_campaign_actors_character ON campaign_actors(campaign_id, campaign_character_id);
    CREATE INDEX idx_campaign_actors_sheet ON campaign_actors(campaign_id, sheet_id, campaign_character_id);

    CREATE TABLE campaign_actor_private_state (
      actor_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      controller_principal_id TEXT NOT NULL,
      private_notes TEXT CHECK (private_notes IS NULL OR length(private_notes) <= 4000),
      FOREIGN KEY (campaign_id, actor_id)
        REFERENCES campaign_actors(campaign_id, id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id, controller_principal_id)
        REFERENCES campaign_memberships(campaign_id, principal_id) ON DELETE NO ACTION
    );
    CREATE INDEX idx_campaign_actor_private_state_actor
      ON campaign_actor_private_state(campaign_id, actor_id);
    CREATE INDEX idx_campaign_actor_private_state_controller
      ON campaign_actor_private_state(campaign_id, controller_principal_id);
  `);
}

function createRpgCommandAuditV12(db: DatabaseDriver.Database): void {
  db.exec(`
    ALTER TABLE campaign_timelines ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991);
    CREATE TRIGGER campaign_timelines_advance_revision
      BEFORE UPDATE OF revision ON campaign_timelines
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'campaign timeline revision must advance exactly once'); END;

    CREATE TABLE campaign_commands (
      campaign_id TEXT NOT NULL,
      command_id TEXT NOT NULL
        CHECK (length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      idempotency_key TEXT NOT NULL
        CHECK (length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      timeline_id TEXT NOT NULL
        CHECK (length(timeline_id) BETWEEN 1 AND 128 AND timeline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT NOT NULL
        CHECK (length(actor_id) BETWEEN 1 AND 128 AND actor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      expected_revision INTEGER NOT NULL CHECK (
        typeof(expected_revision) = 'integer' AND expected_revision BETWEEN 0 AND 9007199254740990
      ),
      source_turn_id TEXT CHECK (
        source_turn_id IS NULL OR (
          length(source_turn_id) BETWEEN 1 AND 128 AND source_turn_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      ),
      type TEXT NOT NULL CHECK (type = 'set_actor_attribute'),
      attribute_id TEXT NOT NULL
        CHECK (length(attribute_id) BETWEEN 1 AND 128 AND attribute_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      value INTEGER NOT NULL CHECK (typeof(value) = 'integer' AND value BETWEEN -1000 AND 1000),
      PRIMARY KEY (campaign_id, command_id),
      UNIQUE (campaign_id, idempotency_key),
      FOREIGN KEY (campaign_id, timeline_id)
        REFERENCES campaign_timelines(campaign_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, actor_id)
        REFERENCES campaign_actors(campaign_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_commands_timeline
      ON campaign_commands(campaign_id, timeline_id);
    CREATE INDEX idx_campaign_commands_actor
      ON campaign_commands(campaign_id, actor_id);

    CREATE TABLE campaign_events (
      event_id TEXT PRIMARY KEY
        CHECK (length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      timeline_id TEXT NOT NULL
        CHECK (length(timeline_id) BETWEEN 1 AND 128 AND timeline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT NOT NULL
        CHECK (length(actor_id) BETWEEN 1 AND 128 AND actor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      source_turn_id TEXT CHECK (
        source_turn_id IS NULL OR (
          length(source_turn_id) BETWEEN 1 AND 128 AND source_turn_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      ),
      type TEXT NOT NULL CHECK (type = 'actor_attribute_set'),
      revision INTEGER NOT NULL CHECK (
        typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991
      ),
      occurred_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS NOT NULL
        AND occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at)
        AND substr(occurred_at, 12, 2) BETWEEN '00' AND '23'
      ),
      attribute_id TEXT NOT NULL
        CHECK (length(attribute_id) BETWEEN 1 AND 128 AND attribute_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      value_before INTEGER NOT NULL CHECK (typeof(value_before) = 'integer' AND value_before BETWEEN -1000 AND 1000),
      value_after INTEGER NOT NULL CHECK (typeof(value_after) = 'integer' AND value_after BETWEEN -1000 AND 1000),
      CHECK (value_after <> value_before),
      UNIQUE (campaign_id, command_id),
      UNIQUE (campaign_id, timeline_id, revision),
      UNIQUE (campaign_id, command_id, event_id, revision),
      FOREIGN KEY (campaign_id, command_id)
        REFERENCES campaign_commands(campaign_id, command_id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, timeline_id)
        REFERENCES campaign_timelines(campaign_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, actor_id)
        REFERENCES campaign_actors(campaign_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_events_actor
      ON campaign_events(campaign_id, actor_id);

    CREATE TABLE command_receipts (
      campaign_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      revision_before INTEGER NOT NULL CHECK (
        typeof(revision_before) = 'integer' AND revision_before BETWEEN 0 AND 9007199254740990
      ),
      revision_after INTEGER NOT NULL CHECK (
        typeof(revision_after) = 'integer' AND revision_after BETWEEN 1 AND 9007199254740991
      ),
      event_id TEXT NOT NULL,
      CHECK (revision_after = revision_before + 1),
      PRIMARY KEY (campaign_id, command_id),
      FOREIGN KEY (campaign_id, command_id)
        REFERENCES campaign_commands(campaign_id, command_id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, command_id, event_id, revision_after)
        REFERENCES campaign_events(campaign_id, command_id, event_id, revision) ON DELETE RESTRICT
    );
    CREATE INDEX idx_command_receipts_event
      ON command_receipts(campaign_id, command_id, event_id, revision_after);

    -- INSERT OR REPLACE deletes conflicting rows before inserting unless an
    -- insert trigger rejects the statement first. Guard every unique identity
    -- so immutability does not depend on PRAGMA recursive_triggers.
    CREATE TRIGGER campaign_commands_prevent_replace
      BEFORE INSERT ON campaign_commands
      WHEN EXISTS (
        SELECT 1 FROM campaign_commands command
        WHERE (command.campaign_id = NEW.campaign_id AND command.command_id = NEW.command_id)
           OR (command.campaign_id = NEW.campaign_id AND command.idempotency_key = NEW.idempotency_key)
      )
      BEGIN SELECT RAISE(ABORT, 'campaign commands are immutable'); END;
    CREATE TRIGGER campaign_events_prevent_replace
      BEFORE INSERT ON campaign_events
      WHEN EXISTS (
        SELECT 1 FROM campaign_events event
        WHERE event.event_id = NEW.event_id
           OR (event.campaign_id = NEW.campaign_id AND event.command_id = NEW.command_id)
           OR (event.campaign_id = NEW.campaign_id AND event.timeline_id = NEW.timeline_id
             AND event.revision = NEW.revision)
      )
      BEGIN SELECT RAISE(ABORT, 'campaign events are immutable'); END;
    CREATE TRIGGER command_receipts_prevent_replace
      BEFORE INSERT ON command_receipts
      WHEN EXISTS (
        SELECT 1 FROM command_receipts receipt
        WHERE receipt.campaign_id = NEW.campaign_id AND receipt.command_id = NEW.command_id
      )
      BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;

    CREATE TRIGGER campaign_events_require_matching_command
      BEFORE INSERT ON campaign_events
      WHEN NOT EXISTS (
        SELECT 1 FROM campaign_commands command
        WHERE command.campaign_id = NEW.campaign_id
          AND command.command_id = NEW.command_id
          AND command.timeline_id = NEW.timeline_id
          AND command.actor_id = NEW.actor_id
          AND command.source_turn_id IS NEW.source_turn_id
          AND command.attribute_id = NEW.attribute_id
          AND command.value = NEW.value_after
          AND command.expected_revision + 1 = NEW.revision
          AND EXISTS (
            SELECT 1 FROM campaign_timelines timeline
            WHERE timeline.campaign_id = NEW.campaign_id
              AND timeline.id = NEW.timeline_id
              AND timeline.revision = NEW.revision
          )
      )
      BEGIN SELECT RAISE(ABORT, 'campaign event must match its command envelope'); END;

    CREATE TRIGGER command_receipts_require_expected_revision
      BEFORE INSERT ON command_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM campaign_commands command
        WHERE command.campaign_id = NEW.campaign_id
          AND command.command_id = NEW.command_id
          AND command.expected_revision = NEW.revision_before
      )
      BEGIN SELECT RAISE(ABORT, 'command receipt must match its expected revision'); END;

    CREATE TRIGGER campaign_commands_prevent_update
      BEFORE UPDATE ON campaign_commands
      BEGIN SELECT RAISE(ABORT, 'campaign commands are immutable'); END;
    CREATE TRIGGER campaign_commands_prevent_delete
      BEFORE DELETE ON campaign_commands
      BEGIN SELECT RAISE(ABORT, 'campaign commands are immutable'); END;
    CREATE TRIGGER campaign_events_prevent_update
      BEFORE UPDATE ON campaign_events
      BEGIN SELECT RAISE(ABORT, 'campaign events are immutable'); END;
    CREATE TRIGGER campaign_events_prevent_delete
      BEFORE DELETE ON campaign_events
      BEGIN SELECT RAISE(ABORT, 'campaign events are immutable'); END;
    CREATE TRIGGER command_receipts_prevent_update
      BEFORE UPDATE ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;
    CREATE TRIGGER command_receipts_prevent_delete
      BEFORE DELETE ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;
  `);
}

/** The timeline revision is shared by v12 and v13, but fresh databases create
 * the final v13 audit tables directly rather than creating and rebuilding v12. */
function createTimelineRevisionV12(db: DatabaseDriver.Database): void {
  db.exec(`
    ALTER TABLE campaign_timelines ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991);
    CREATE TRIGGER campaign_timelines_advance_revision
      BEFORE UPDATE OF revision ON campaign_timelines
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'campaign timeline revision must advance exactly once'); END;
  `);
}

/** Final union-aware audit schema. Keep this as the single source of DDL for
 * both fresh databases and the v12 rebuild so their sqlite_master rows match. */
function createRpgCommandAuditV13(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_actor_resources (
      campaign_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      name TEXT NOT NULL
        CHECK (length(name) BETWEEN 1 AND 128 AND instr(name, char(0)) = 0
          AND name NOT GLOB '*[^A-Za-z0-9._:-]*'),
      current INTEGER NOT NULL CHECK (typeof(current) = 'integer' AND current BETWEEN 0 AND 1000000),
      max INTEGER NOT NULL CHECK (typeof(max) = 'integer' AND max BETWEEN 0 AND 1000000),
      CHECK (current <= max),
      PRIMARY KEY (actor_id, name),
      FOREIGN KEY (campaign_id, actor_id)
        REFERENCES campaign_actors(campaign_id, id) ON DELETE CASCADE
    );
    CREATE INDEX idx_rpg_actor_resources_actor
      ON rpg_actor_resources(campaign_id, actor_id, name);

    CREATE TABLE campaign_commands (
      campaign_id TEXT NOT NULL,
      command_id TEXT NOT NULL
        CHECK (length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      idempotency_key TEXT NOT NULL
        CHECK (length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      timeline_id TEXT NOT NULL
        CHECK (length(timeline_id) BETWEEN 1 AND 128 AND timeline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT NOT NULL
        CHECK (length(actor_id) BETWEEN 1 AND 128 AND actor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      expected_revision INTEGER NOT NULL CHECK (
        typeof(expected_revision) = 'integer' AND expected_revision BETWEEN 0 AND 9007199254740990
      ),
      source_turn_id TEXT CHECK (
        source_turn_id IS NULL OR (
          length(source_turn_id) BETWEEN 1 AND 128 AND source_turn_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      ),
      type TEXT NOT NULL CHECK (type IN ('set_actor_attribute', 'initialize_actor_resource')),
      attribute_id TEXT CHECK (
        attribute_id IS NULL OR (
          length(attribute_id) BETWEEN 1 AND 128 AND attribute_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      ),
      value INTEGER CHECK (value IS NULL OR (typeof(value) = 'integer' AND value BETWEEN -1000 AND 1000)),
      resource_name TEXT CHECK (
        resource_name IS NULL OR (
          length(resource_name) BETWEEN 1 AND 128 AND instr(resource_name, char(0)) = 0
          AND resource_name NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      ),
      resource_current INTEGER CHECK (
        resource_current IS NULL OR (typeof(resource_current) = 'integer' AND resource_current BETWEEN 0 AND 1000000)
      ),
      resource_max INTEGER CHECK (
        resource_max IS NULL OR (typeof(resource_max) = 'integer' AND resource_max BETWEEN 0 AND 1000000)
      ),
      CHECK (
        (type = 'set_actor_attribute'
          AND attribute_id IS NOT NULL AND value IS NOT NULL
          AND resource_name IS NULL AND resource_current IS NULL AND resource_max IS NULL)
        OR
        (type = 'initialize_actor_resource'
          AND attribute_id IS NULL AND value IS NULL
          AND resource_name IS NOT NULL AND resource_current IS NOT NULL AND resource_max IS NOT NULL
          AND resource_current <= resource_max)
      ),
      PRIMARY KEY (campaign_id, command_id),
      UNIQUE (campaign_id, idempotency_key),
      FOREIGN KEY (campaign_id, timeline_id)
        REFERENCES campaign_timelines(campaign_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, actor_id)
        REFERENCES campaign_actors(campaign_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_commands_timeline
      ON campaign_commands(campaign_id, timeline_id);
    CREATE INDEX idx_campaign_commands_actor
      ON campaign_commands(campaign_id, actor_id);

    CREATE TABLE campaign_events (
      event_id TEXT PRIMARY KEY
        CHECK (length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      timeline_id TEXT NOT NULL
        CHECK (length(timeline_id) BETWEEN 1 AND 128 AND timeline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT NOT NULL
        CHECK (length(actor_id) BETWEEN 1 AND 128 AND actor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      source_turn_id TEXT CHECK (
        source_turn_id IS NULL OR (
          length(source_turn_id) BETWEEN 1 AND 128 AND source_turn_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      ),
      type TEXT NOT NULL CHECK (type IN ('actor_attribute_set', 'actor_resource_initialized')),
      revision INTEGER NOT NULL CHECK (
        typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991
      ),
      occurred_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS NOT NULL
        AND occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at)
        AND substr(occurred_at, 12, 2) BETWEEN '00' AND '23'
      ),
      attribute_id TEXT CHECK (
        attribute_id IS NULL OR (
          length(attribute_id) BETWEEN 1 AND 128 AND attribute_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      ),
      value_before INTEGER CHECK (
        value_before IS NULL OR (typeof(value_before) = 'integer' AND value_before BETWEEN -1000 AND 1000)
      ),
      value_after INTEGER CHECK (
        value_after IS NULL OR (typeof(value_after) = 'integer' AND value_after BETWEEN -1000 AND 1000)
      ),
      resource_name TEXT CHECK (
        resource_name IS NULL OR (
          length(resource_name) BETWEEN 1 AND 128 AND instr(resource_name, char(0)) = 0
          AND resource_name NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      ),
      resource_current INTEGER CHECK (
        resource_current IS NULL OR (typeof(resource_current) = 'integer' AND resource_current BETWEEN 0 AND 1000000)
      ),
      resource_max INTEGER CHECK (
        resource_max IS NULL OR (typeof(resource_max) = 'integer' AND resource_max BETWEEN 0 AND 1000000)
      ),
      CHECK (
        (type = 'actor_attribute_set'
          AND attribute_id IS NOT NULL AND value_before IS NOT NULL AND value_after IS NOT NULL
          AND value_after <> value_before
          AND resource_name IS NULL AND resource_current IS NULL AND resource_max IS NULL)
        OR
        (type = 'actor_resource_initialized'
          AND attribute_id IS NULL AND value_before IS NULL AND value_after IS NULL
          AND resource_name IS NOT NULL AND resource_current IS NOT NULL AND resource_max IS NOT NULL
          AND resource_current <= resource_max)
      ),
      UNIQUE (campaign_id, command_id),
      UNIQUE (campaign_id, timeline_id, revision),
      UNIQUE (campaign_id, command_id, event_id, revision),
      FOREIGN KEY (campaign_id, command_id)
        REFERENCES campaign_commands(campaign_id, command_id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, timeline_id)
        REFERENCES campaign_timelines(campaign_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, actor_id)
        REFERENCES campaign_actors(campaign_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_events_actor ON campaign_events(campaign_id, actor_id);

    CREATE TABLE command_receipts (
      campaign_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      revision_before INTEGER NOT NULL CHECK (
        typeof(revision_before) = 'integer' AND revision_before BETWEEN 0 AND 9007199254740990
      ),
      revision_after INTEGER NOT NULL CHECK (
        typeof(revision_after) = 'integer' AND revision_after BETWEEN 1 AND 9007199254740991
      ),
      event_id TEXT NOT NULL,
      CHECK (revision_after = revision_before + 1),
      PRIMARY KEY (campaign_id, command_id),
      FOREIGN KEY (campaign_id, command_id)
        REFERENCES campaign_commands(campaign_id, command_id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, command_id, event_id, revision_after)
        REFERENCES campaign_events(campaign_id, command_id, event_id, revision) ON DELETE RESTRICT
    );
    CREATE INDEX idx_command_receipts_event
      ON command_receipts(campaign_id, command_id, event_id, revision_after);

    CREATE TRIGGER campaign_commands_prevent_replace
      BEFORE INSERT ON campaign_commands
      WHEN EXISTS (SELECT 1 FROM campaign_commands command
        WHERE (command.campaign_id = NEW.campaign_id AND command.command_id = NEW.command_id)
           OR (command.campaign_id = NEW.campaign_id AND command.idempotency_key = NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT, 'campaign commands are immutable'); END;
    CREATE TRIGGER campaign_events_prevent_replace
      BEFORE INSERT ON campaign_events
      WHEN EXISTS (SELECT 1 FROM campaign_events event
        WHERE event.event_id = NEW.event_id
           OR (event.campaign_id = NEW.campaign_id AND event.command_id = NEW.command_id)
           OR (event.campaign_id = NEW.campaign_id AND event.timeline_id = NEW.timeline_id
             AND event.revision = NEW.revision))
      BEGIN SELECT RAISE(ABORT, 'campaign events are immutable'); END;
    CREATE TRIGGER command_receipts_prevent_replace
      BEFORE INSERT ON command_receipts
      WHEN EXISTS (SELECT 1 FROM command_receipts receipt
        WHERE receipt.campaign_id = NEW.campaign_id AND receipt.command_id = NEW.command_id)
      BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;

    CREATE TRIGGER command_receipts_require_expected_revision
      BEFORE INSERT ON command_receipts
      WHEN NOT EXISTS (SELECT 1 FROM campaign_commands command
        WHERE command.campaign_id = NEW.campaign_id AND command.command_id = NEW.command_id
          AND command.expected_revision = NEW.revision_before)
      BEGIN SELECT RAISE(ABORT, 'command receipt must match its expected revision'); END;

    CREATE TRIGGER campaign_commands_prevent_update BEFORE UPDATE ON campaign_commands
      BEGIN SELECT RAISE(ABORT, 'campaign commands are immutable'); END;
    CREATE TRIGGER campaign_commands_prevent_delete BEFORE DELETE ON campaign_commands
      BEGIN SELECT RAISE(ABORT, 'campaign commands are immutable'); END;
    CREATE TRIGGER campaign_events_prevent_update BEFORE UPDATE ON campaign_events
      BEGIN SELECT RAISE(ABORT, 'campaign events are immutable'); END;
    CREATE TRIGGER campaign_events_prevent_delete BEFORE DELETE ON campaign_events
      BEGIN SELECT RAISE(ABORT, 'campaign events are immutable'); END;
    CREATE TRIGGER command_receipts_prevent_update BEFORE UPDATE ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;
    CREATE TRIGGER command_receipts_prevent_delete BEFORE DELETE ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;
  `);
}

function createCampaignEventMatchingTriggerV13(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TRIGGER campaign_events_require_matching_command
      BEFORE INSERT ON campaign_events
      WHEN NOT EXISTS (
        SELECT 1 FROM campaign_commands command
        WHERE command.campaign_id = NEW.campaign_id AND command.command_id = NEW.command_id
          AND command.timeline_id = NEW.timeline_id AND command.actor_id = NEW.actor_id
          AND command.source_turn_id IS NEW.source_turn_id
          AND command.expected_revision + 1 = NEW.revision
          AND ((command.type = 'set_actor_attribute' AND NEW.type = 'actor_attribute_set'
              AND command.attribute_id = NEW.attribute_id AND command.value = NEW.value_after
              AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
              AND NEW.resource_name IS NULL AND NEW.resource_current IS NULL AND NEW.resource_max IS NULL)
            OR (command.type = 'initialize_actor_resource' AND NEW.type = 'actor_resource_initialized'
              AND command.attribute_id IS NULL AND command.value IS NULL
              AND NEW.attribute_id IS NULL AND NEW.value_before IS NULL AND NEW.value_after IS NULL
              AND command.resource_name = NEW.resource_name
              AND command.resource_current = NEW.resource_current
              AND command.resource_max = NEW.resource_max))
          AND EXISTS (SELECT 1 FROM campaign_timelines timeline
            WHERE timeline.campaign_id = NEW.campaign_id AND timeline.id = NEW.timeline_id
              AND timeline.revision = NEW.revision)
      )
      BEGIN SELECT RAISE(ABORT, 'campaign event must match its command envelope'); END;
  `);
}

/** Final v14 audit schema. Dice results are normalized rather than serialized:
 * this lets SQLite validate the complete aggregate before the event seals it. */
function createRpgCommandAuditV14(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_actor_resources (
      campaign_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128 AND instr(name, char(0)) = 0
        AND name NOT GLOB '*[^A-Za-z0-9._:-]*'),
      current INTEGER NOT NULL CHECK (typeof(current) = 'integer' AND current BETWEEN 0 AND 1000000),
      max INTEGER NOT NULL CHECK (typeof(max) = 'integer' AND max BETWEEN 0 AND 1000000),
      CHECK (current <= max),
      PRIMARY KEY (actor_id, name),
      FOREIGN KEY (campaign_id, actor_id) REFERENCES campaign_actors(campaign_id, id) ON DELETE CASCADE
    );
    CREATE INDEX idx_rpg_actor_resources_actor ON rpg_actor_resources(campaign_id, actor_id, name);

    CREATE TABLE campaign_commands (
      campaign_id TEXT NOT NULL,
      command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 128
        AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128
        AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      timeline_id TEXT NOT NULL CHECK (length(timeline_id) BETWEEN 1 AND 128
        AND timeline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128
        AND actor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      expected_revision INTEGER NOT NULL CHECK (typeof(expected_revision) = 'integer'
        AND expected_revision BETWEEN 0 AND 9007199254740990),
      source_turn_id TEXT CHECK (source_turn_id IS NULL OR (length(source_turn_id) BETWEEN 1 AND 128
        AND source_turn_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
      type TEXT NOT NULL CHECK (type IN ('set_actor_attribute', 'initialize_actor_resource', 'roll_actor_dice')),
      attribute_id TEXT CHECK (attribute_id IS NULL OR (length(attribute_id) BETWEEN 1 AND 128
        AND attribute_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
      value INTEGER CHECK (value IS NULL OR (typeof(value) = 'integer' AND value BETWEEN -1000 AND 1000)),
      resource_name TEXT CHECK (resource_name IS NULL OR (length(resource_name) BETWEEN 1 AND 128
        AND instr(resource_name, char(0)) = 0 AND resource_name NOT GLOB '*[^A-Za-z0-9._:-]*')),
      resource_current INTEGER CHECK (resource_current IS NULL OR (typeof(resource_current) = 'integer'
        AND resource_current BETWEEN 0 AND 1000000)),
      resource_max INTEGER CHECK (resource_max IS NULL OR (typeof(resource_max) = 'integer'
        AND resource_max BETWEEN 0 AND 1000000)),
      dice_expression TEXT CHECK (dice_expression IS NULL OR length(dice_expression) BETWEEN 3 AND 24),
      dice_count INTEGER CHECK (dice_count IS NULL OR (typeof(dice_count) = 'integer' AND dice_count BETWEEN 1 AND 100)),
      dice_sides INTEGER CHECK (dice_sides IS NULL OR (typeof(dice_sides) = 'integer' AND dice_sides BETWEEN 2 AND 1000)),
      dice_selection_type TEXT CHECK (dice_selection_type IS NULL OR dice_selection_type IN
        ('all', 'keep_highest', 'keep_lowest', 'advantage', 'disadvantage')),
      dice_selection_count INTEGER CHECK (dice_selection_count IS NULL OR
        (typeof(dice_selection_count) = 'integer' AND dice_selection_count BETWEEN 1 AND 100)),
      dice_modifier INTEGER CHECK (dice_modifier IS NULL OR
        (typeof(dice_modifier) = 'integer' AND dice_modifier BETWEEN -1000 AND 1000)),
      CHECK (
        (type = 'set_actor_attribute' AND attribute_id IS NOT NULL AND value IS NOT NULL
          AND resource_name IS NULL AND resource_current IS NULL AND resource_max IS NULL
          AND dice_expression IS NULL AND dice_count IS NULL AND dice_sides IS NULL
          AND dice_selection_type IS NULL AND dice_selection_count IS NULL AND dice_modifier IS NULL)
        OR (type = 'initialize_actor_resource' AND attribute_id IS NULL AND value IS NULL
          AND resource_name IS NOT NULL AND resource_current IS NOT NULL AND resource_max IS NOT NULL
          AND resource_current <= resource_max AND dice_expression IS NULL AND dice_count IS NULL
          AND dice_sides IS NULL AND dice_selection_type IS NULL AND dice_selection_count IS NULL
          AND dice_modifier IS NULL)
        OR (type = 'roll_actor_dice' AND attribute_id IS NULL AND value IS NULL
          AND resource_name IS NULL AND resource_current IS NULL AND resource_max IS NULL
          AND dice_expression IS NOT NULL AND dice_count IS NOT NULL AND dice_sides IS NOT NULL
          AND dice_selection_type IS NOT NULL AND dice_modifier IS NOT NULL
          AND ((dice_selection_type = 'all' AND dice_selection_count IS NULL)
            OR (dice_selection_type IN ('keep_highest', 'keep_lowest')
              AND dice_selection_count IS NOT NULL AND dice_selection_count <= dice_count)
            OR (dice_selection_type IN ('advantage', 'disadvantage')
              AND dice_selection_count IS NULL AND dice_count = 1))
          AND dice_expression = CAST(dice_count AS TEXT) || 'd' || CAST(dice_sides AS TEXT)
            || CASE dice_selection_type
              WHEN 'all' THEN '' WHEN 'keep_highest' THEN 'kh' || CAST(dice_selection_count AS TEXT)
              WHEN 'keep_lowest' THEN 'kl' || CAST(dice_selection_count AS TEXT)
              WHEN 'advantage' THEN 'adv' ELSE 'dis' END
            || CASE WHEN dice_modifier = 0 THEN '' WHEN dice_modifier > 0
              THEN '+' || CAST(dice_modifier AS TEXT) ELSE CAST(dice_modifier AS TEXT) END)
      ),
      PRIMARY KEY (campaign_id, command_id),
      UNIQUE (campaign_id, idempotency_key),
      FOREIGN KEY (campaign_id, timeline_id) REFERENCES campaign_timelines(campaign_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, actor_id) REFERENCES campaign_actors(campaign_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_commands_timeline ON campaign_commands(campaign_id, timeline_id);
    CREATE INDEX idx_campaign_commands_actor ON campaign_commands(campaign_id, actor_id);

    CREATE TABLE campaign_events (
      event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128
        AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      timeline_id TEXT NOT NULL CHECK (length(timeline_id) BETWEEN 1 AND 128
        AND timeline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128
        AND actor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      source_turn_id TEXT CHECK (source_turn_id IS NULL OR (length(source_turn_id) BETWEEN 1 AND 128
        AND source_turn_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
      type TEXT NOT NULL CHECK (type IN ('actor_attribute_set', 'actor_resource_initialized', 'actor_dice_rolled')),
      revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
      occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS NOT NULL
        AND occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at)
        AND substr(occurred_at, 12, 2) BETWEEN '00' AND '23'),
      attribute_id TEXT CHECK (attribute_id IS NULL OR (length(attribute_id) BETWEEN 1 AND 128
        AND attribute_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
      value_before INTEGER CHECK (value_before IS NULL OR (typeof(value_before) = 'integer'
        AND value_before BETWEEN -1000 AND 1000)),
      value_after INTEGER CHECK (value_after IS NULL OR (typeof(value_after) = 'integer'
        AND value_after BETWEEN -1000 AND 1000)),
      resource_name TEXT CHECK (resource_name IS NULL OR (length(resource_name) BETWEEN 1 AND 128
        AND instr(resource_name, char(0)) = 0 AND resource_name NOT GLOB '*[^A-Za-z0-9._:-]*')),
      resource_current INTEGER CHECK (resource_current IS NULL OR (typeof(resource_current) = 'integer'
        AND resource_current BETWEEN 0 AND 1000000)),
      resource_max INTEGER CHECK (resource_max IS NULL OR (typeof(resource_max) = 'integer'
        AND resource_max BETWEEN 0 AND 1000000)),
      CHECK (
        (type = 'actor_attribute_set' AND attribute_id IS NOT NULL
          AND value_before IS NOT NULL AND value_after IS NOT NULL AND value_after <> value_before
          AND resource_name IS NULL AND resource_current IS NULL AND resource_max IS NULL)
        OR (type = 'actor_resource_initialized' AND attribute_id IS NULL
          AND value_before IS NULL AND value_after IS NULL AND resource_name IS NOT NULL
          AND resource_current IS NOT NULL AND resource_max IS NOT NULL AND resource_current <= resource_max)
        OR (type = 'actor_dice_rolled' AND attribute_id IS NULL AND value_before IS NULL
          AND value_after IS NULL AND resource_name IS NULL AND resource_current IS NULL AND resource_max IS NULL)
      ),
      UNIQUE (campaign_id, command_id),
      UNIQUE (campaign_id, timeline_id, revision),
      UNIQUE (campaign_id, command_id, event_id),
      UNIQUE (campaign_id, command_id, event_id, revision),
      FOREIGN KEY (campaign_id, command_id) REFERENCES campaign_commands(campaign_id, command_id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, timeline_id) REFERENCES campaign_timelines(campaign_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, actor_id) REFERENCES campaign_actors(campaign_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_events_actor ON campaign_events(campaign_id, actor_id);

    CREATE TABLE command_receipts (
      campaign_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      revision_before INTEGER NOT NULL CHECK (typeof(revision_before) = 'integer'
        AND revision_before BETWEEN 0 AND 9007199254740990),
      revision_after INTEGER NOT NULL CHECK (typeof(revision_after) = 'integer'
        AND revision_after BETWEEN 1 AND 9007199254740991),
      event_id TEXT NOT NULL,
      CHECK (revision_after = revision_before + 1),
      PRIMARY KEY (campaign_id, command_id),
      FOREIGN KEY (campaign_id, command_id) REFERENCES campaign_commands(campaign_id, command_id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, command_id, event_id, revision_after)
        REFERENCES campaign_events(campaign_id, command_id, event_id, revision) ON DELETE RESTRICT
    );
    CREATE INDEX idx_command_receipts_event
      ON command_receipts(campaign_id, command_id, event_id, revision_after);

    CREATE TABLE rpg_dice_rolls (
      event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128
        AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      expression TEXT NOT NULL CHECK (length(expression) BETWEEN 3 AND 24),
      dice_count INTEGER NOT NULL CHECK (typeof(dice_count) = 'integer' AND dice_count BETWEEN 1 AND 100),
      dice_sides INTEGER NOT NULL CHECK (typeof(dice_sides) = 'integer' AND dice_sides BETWEEN 2 AND 1000),
      selection_type TEXT NOT NULL CHECK (selection_type IN
        ('all', 'keep_highest', 'keep_lowest', 'advantage', 'disadvantage')),
      selection_count INTEGER CHECK (selection_count IS NULL OR
        (typeof(selection_count) = 'integer' AND selection_count BETWEEN 1 AND 100)),
      modifier INTEGER NOT NULL CHECK (typeof(modifier) = 'integer' AND modifier BETWEEN -1000 AND 1000),
      total INTEGER NOT NULL CHECK (typeof(total) = 'integer' AND total BETWEEN -1000 AND 101000),
      CHECK ((selection_type = 'all' AND selection_count IS NULL)
        OR (selection_type IN ('keep_highest', 'keep_lowest')
          AND selection_count IS NOT NULL AND selection_count <= dice_count)
        OR (selection_type IN ('advantage', 'disadvantage')
          AND selection_count IS NULL AND dice_count = 1)),
      CHECK (expression = CAST(dice_count AS TEXT) || 'd' || CAST(dice_sides AS TEXT)
        || CASE selection_type
          WHEN 'all' THEN '' WHEN 'keep_highest' THEN 'kh' || CAST(selection_count AS TEXT)
          WHEN 'keep_lowest' THEN 'kl' || CAST(selection_count AS TEXT)
          WHEN 'advantage' THEN 'adv' ELSE 'dis' END
        || CASE WHEN modifier = 0 THEN '' WHEN modifier > 0 THEN '+' || CAST(modifier AS TEXT)
          ELSE CAST(modifier AS TEXT) END),
      UNIQUE (campaign_id, command_id),
      UNIQUE (campaign_id, command_id, event_id),
      FOREIGN KEY (campaign_id, command_id) REFERENCES campaign_commands(campaign_id, command_id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id, command_id, event_id)
        REFERENCES campaign_events(campaign_id, command_id, event_id) ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX idx_rpg_dice_rolls_command ON rpg_dice_rolls(campaign_id, command_id);

    CREATE TABLE rpg_dice_terms (
      event_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position BETWEEN 0 AND 99),
      value INTEGER NOT NULL CHECK (typeof(value) = 'integer' AND value BETWEEN 1 AND 1000),
      kept INTEGER NOT NULL CHECK (typeof(kept) = 'integer' AND kept IN (0, 1)),
      PRIMARY KEY (event_id, position),
      FOREIGN KEY (event_id) REFERENCES rpg_dice_rolls(event_id) ON DELETE RESTRICT
    );

    CREATE TRIGGER campaign_commands_prevent_replace BEFORE INSERT ON campaign_commands
      WHEN EXISTS (SELECT 1 FROM campaign_commands command
        WHERE (command.campaign_id = NEW.campaign_id AND command.command_id = NEW.command_id)
          OR (command.campaign_id = NEW.campaign_id AND command.idempotency_key = NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT, 'campaign commands are immutable'); END;
    CREATE TRIGGER campaign_events_prevent_replace BEFORE INSERT ON campaign_events
      WHEN EXISTS (SELECT 1 FROM campaign_events event WHERE event.event_id = NEW.event_id
        OR (event.campaign_id = NEW.campaign_id AND event.command_id = NEW.command_id)
        OR (event.campaign_id = NEW.campaign_id AND event.timeline_id = NEW.timeline_id
          AND event.revision = NEW.revision))
      BEGIN SELECT RAISE(ABORT, 'campaign events are immutable'); END;
    CREATE TRIGGER command_receipts_prevent_replace BEFORE INSERT ON command_receipts
      WHEN EXISTS (SELECT 1 FROM command_receipts receipt
        WHERE receipt.campaign_id = NEW.campaign_id AND receipt.command_id = NEW.command_id)
      BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;
    CREATE TRIGGER rpg_dice_rolls_prevent_replace BEFORE INSERT ON rpg_dice_rolls
      WHEN EXISTS (SELECT 1 FROM rpg_dice_rolls roll WHERE roll.event_id = NEW.event_id
        OR (roll.campaign_id = NEW.campaign_id AND roll.command_id = NEW.command_id))
      BEGIN SELECT RAISE(ABORT, 'dice rolls are immutable'); END;
    CREATE TRIGGER rpg_dice_terms_prevent_replace BEFORE INSERT ON rpg_dice_terms
      WHEN EXISTS (SELECT 1 FROM rpg_dice_terms term
        WHERE term.event_id = NEW.event_id AND term.position = NEW.position)
      BEGIN SELECT RAISE(ABORT, 'dice terms are immutable'); END;

    CREATE TRIGGER rpg_dice_rolls_must_precede_event BEFORE INSERT ON rpg_dice_rolls
      WHEN EXISTS (SELECT 1 FROM campaign_events event WHERE event.event_id = NEW.event_id
        OR (event.campaign_id = NEW.campaign_id AND event.command_id = NEW.command_id))
      BEGIN SELECT RAISE(ABORT, 'dice roll must precede its event'); END;
    CREATE TRIGGER rpg_dice_terms_must_precede_event BEFORE INSERT ON rpg_dice_terms
      WHEN EXISTS (SELECT 1 FROM campaign_events event WHERE event.event_id = NEW.event_id)
      BEGIN SELECT RAISE(ABORT, 'dice terms must precede their event'); END;

    CREATE TRIGGER command_receipts_require_expected_revision BEFORE INSERT ON command_receipts
      WHEN NOT EXISTS (SELECT 1 FROM campaign_commands command
        WHERE command.campaign_id = NEW.campaign_id AND command.command_id = NEW.command_id
          AND command.expected_revision = NEW.revision_before)
      BEGIN SELECT RAISE(ABORT, 'command receipt must match its expected revision'); END;

    CREATE TRIGGER campaign_commands_prevent_update BEFORE UPDATE ON campaign_commands
      BEGIN SELECT RAISE(ABORT, 'campaign commands are immutable'); END;
    CREATE TRIGGER campaign_commands_prevent_delete BEFORE DELETE ON campaign_commands
      BEGIN SELECT RAISE(ABORT, 'campaign commands are immutable'); END;
    CREATE TRIGGER campaign_events_prevent_update BEFORE UPDATE ON campaign_events
      BEGIN SELECT RAISE(ABORT, 'campaign events are immutable'); END;
    CREATE TRIGGER campaign_events_prevent_delete BEFORE DELETE ON campaign_events
      BEGIN SELECT RAISE(ABORT, 'campaign events are immutable'); END;
    CREATE TRIGGER command_receipts_prevent_update BEFORE UPDATE ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;
    CREATE TRIGGER command_receipts_prevent_delete BEFORE DELETE ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;
    CREATE TRIGGER rpg_dice_rolls_prevent_update BEFORE UPDATE ON rpg_dice_rolls
      BEGIN SELECT RAISE(ABORT, 'dice rolls are immutable'); END;
    CREATE TRIGGER rpg_dice_rolls_prevent_delete BEFORE DELETE ON rpg_dice_rolls
      BEGIN SELECT RAISE(ABORT, 'dice rolls are immutable'); END;
    CREATE TRIGGER rpg_dice_terms_prevent_update BEFORE UPDATE ON rpg_dice_terms
      BEGIN SELECT RAISE(ABORT, 'dice terms are immutable'); END;
    CREATE TRIGGER rpg_dice_terms_prevent_delete BEFORE DELETE ON rpg_dice_terms
      BEGIN SELECT RAISE(ABORT, 'dice terms are immutable'); END;
  `);
}

function createCampaignEventMatchingTriggerV14(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TRIGGER campaign_events_require_matching_command BEFORE INSERT ON campaign_events
      WHEN NOT EXISTS (
        SELECT 1 FROM campaign_commands command
        WHERE command.campaign_id = NEW.campaign_id AND command.command_id = NEW.command_id
          AND command.timeline_id = NEW.timeline_id AND command.actor_id = NEW.actor_id
          AND command.source_turn_id IS NEW.source_turn_id
          AND command.expected_revision + 1 = NEW.revision
          AND EXISTS (SELECT 1 FROM campaign_timelines timeline
            WHERE timeline.campaign_id = NEW.campaign_id AND timeline.id = NEW.timeline_id
              AND timeline.revision = NEW.revision)
          AND (
            (command.type = 'set_actor_attribute' AND NEW.type = 'actor_attribute_set'
              AND command.attribute_id = NEW.attribute_id AND command.value = NEW.value_after
              AND command.resource_name IS NULL AND command.resource_current IS NULL
              AND command.resource_max IS NULL AND command.dice_expression IS NULL
              AND NEW.resource_name IS NULL AND NEW.resource_current IS NULL AND NEW.resource_max IS NULL
              AND NOT EXISTS (SELECT 1 FROM rpg_dice_rolls roll WHERE roll.event_id = NEW.event_id))
            OR (command.type = 'initialize_actor_resource' AND NEW.type = 'actor_resource_initialized'
              AND command.attribute_id IS NULL AND command.value IS NULL AND command.dice_expression IS NULL
              AND NEW.attribute_id IS NULL AND NEW.value_before IS NULL AND NEW.value_after IS NULL
              AND command.resource_name = NEW.resource_name
              AND command.resource_current = NEW.resource_current AND command.resource_max = NEW.resource_max
              AND NOT EXISTS (SELECT 1 FROM rpg_dice_rolls roll WHERE roll.event_id = NEW.event_id))
            OR (command.type = 'roll_actor_dice' AND NEW.type = 'actor_dice_rolled'
              AND command.attribute_id IS NULL AND command.value IS NULL
              AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
              AND NEW.attribute_id IS NULL AND NEW.value_before IS NULL AND NEW.value_after IS NULL
              AND NEW.resource_name IS NULL AND NEW.resource_current IS NULL AND NEW.resource_max IS NULL
              AND EXISTS (
                SELECT 1 FROM rpg_dice_rolls roll
                WHERE roll.event_id = NEW.event_id AND roll.campaign_id = NEW.campaign_id
                  AND roll.command_id = NEW.command_id AND roll.expression = command.dice_expression
                  AND roll.dice_count = command.dice_count AND roll.dice_sides = command.dice_sides
                  AND roll.selection_type = command.dice_selection_type
                  AND roll.selection_count IS command.dice_selection_count
                  AND roll.modifier = command.dice_modifier
                  AND (SELECT COUNT(*) FROM rpg_dice_terms term WHERE term.event_id = roll.event_id)
                    = CASE WHEN roll.selection_type IN ('advantage', 'disadvantage') THEN 2 ELSE roll.dice_count END
                  AND (SELECT COALESCE(MIN(term.position), 0) FROM rpg_dice_terms term
                    WHERE term.event_id = roll.event_id) = 0
                  AND (SELECT COALESCE(MAX(term.position), -1) FROM rpg_dice_terms term
                    WHERE term.event_id = roll.event_id)
                    = CASE WHEN roll.selection_type IN ('advantage', 'disadvantage') THEN 1 ELSE roll.dice_count - 1 END
                  AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms term
                    WHERE term.event_id = roll.event_id AND term.value > roll.dice_sides)
                  AND (SELECT COUNT(*) FROM rpg_dice_terms term
                    WHERE term.event_id = roll.event_id AND term.kept = 1)
                    = CASE WHEN roll.selection_type IN ('keep_highest', 'keep_lowest') THEN roll.selection_count
                      WHEN roll.selection_type IN ('advantage', 'disadvantage') THEN 1 ELSE roll.dice_count END
                  AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms kept
                    JOIN rpg_dice_terms discarded ON discarded.event_id = kept.event_id
                    WHERE kept.event_id = roll.event_id AND kept.kept = 1 AND discarded.kept = 0
                      AND ((roll.selection_type IN ('keep_highest', 'advantage')
                          AND (kept.value < discarded.value
                            OR (kept.value = discarded.value AND kept.position > discarded.position)))
                        OR (roll.selection_type IN ('keep_lowest', 'disadvantage')
                          AND (kept.value > discarded.value
                            OR (kept.value = discarded.value AND kept.position > discarded.position)))))
                  AND roll.total = roll.modifier + (SELECT COALESCE(SUM(term.value), 0)
                    FROM rpg_dice_terms term WHERE term.event_id = roll.event_id AND term.kept = 1)
              ))
          )
      )
      BEGIN SELECT RAISE(ABORT, 'campaign event must match its command envelope'); END;
  `);
}

function migrate2to3(db: DatabaseDriver.Database): void {
  const run = db.transaction(() => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN parent_id TEXT REFERENCES messages(id);
      ALTER TABLE messages ADD COLUMN swipe_group_id TEXT;
      ALTER TABLE messages ADD COLUMN swipe_index INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'final';
      ALTER TABLE sessions ADD COLUMN active_leaf_id TEXT REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED;
      CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
    `);
    // Backfill: legacy data is linear, so chain parents by insertion order and
    // point each session's active leaf at its final message.
    const sessionIds = db.prepare("SELECT DISTINCT session_id AS id FROM messages").all() as Array<{ id: string }>;
    const ordered = db.prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC");
    const update = db.prepare("UPDATE messages SET seq = ?, parent_id = ?, swipe_group_id = id WHERE id = ?");
    const setLeaf = db.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?");
    for (const { id: sessionId } of sessionIds) {
      const rows = ordered.all(sessionId) as Array<{ id: string }>;
      let prev: string | null = null;
      rows.forEach((m, seq) => {
        update.run(seq, prev, m.id);
        prev = m.id;
      });
      if (prev !== null) setLeaf.run(prev, sessionId);
    }
    db.prepare("UPDATE meta SET value = '3' WHERE key = 'schemaVersion'").run();
  });
  run();
}

function migrate3to4(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER;
      ALTER TABLE messages ADD COLUMN completion_tokens INTEGER;
      ALTER TABLE messages ADD COLUMN total_tokens INTEGER;
      ALTER TABLE messages ADD COLUMN usage_source TEXT;
      ALTER TABLE messages ADD COLUMN usage_model TEXT;
    `);
    db.prepare("UPDATE meta SET value = '4' WHERE key = 'schemaVersion'").run();
  })();
}

function migrate4to5(db: DatabaseDriver.Database): void {
  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE session_characters (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL,
        PRIMARY KEY (session_id, character_id)
      );
      ALTER TABLE messages ADD COLUMN speaker_character_id TEXT REFERENCES characters(id) ON DELETE RESTRICT;
      CREATE TABLE lore_characters (
        lore_id TEXT NOT NULL REFERENCES lore(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        PRIMARY KEY (lore_id, character_id)
      );
    `);
    db.prepare(`INSERT INTO session_characters (session_id, character_id, position)
      SELECT id, character_id, 0 FROM sessions`).run();
    db.prepare(`UPDATE messages SET speaker_character_id = (
      SELECT character_id FROM sessions WHERE sessions.id = messages.session_id
    ) WHERE role = 'character'`).run();
    const hasLore = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lore'").get();
    if (hasLore) {
      db.prepare(`INSERT INTO lore_characters (lore_id, character_id)
        SELECT lore.id, lore.character_id FROM lore JOIN characters ON characters.id = lore.character_id
        WHERE lore.character_id IS NOT NULL`).run();
    }
    // Keep the version marker in the same transaction as DDL and backfills so
    // an interrupted migration rolls back to a clean, retryable v4 database.
    db.prepare("UPDATE meta SET value = '5' WHERE key = 'schemaVersion'").run();
  });
  run();
}

function migrate5to6(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE session_context (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        source_of_truth TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare("UPDATE meta SET value = '6' WHERE key = 'schemaVersion'").run();
  })();
}

function migrate6to7(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE session_context ADD COLUMN synthesized_source TEXT NOT NULL DEFAULT '';
      ALTER TABLE session_context ADD COLUMN synthesized_updated_at TEXT;
    `);
    db.prepare("UPDATE meta SET value = '7' WHERE key = 'schemaVersion'").run();
  })();
}

function migrate7to8(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_message_id TEXT UNIQUE,
        kind TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        usage_source TEXT NOT NULL,
        usage_model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_usage_events_session ON usage_events(session_id, created_at);
      INSERT INTO usage_events (id, session_id, source_message_id, kind, prompt_tokens, completion_tokens, total_tokens, usage_source, usage_model, created_at)
      SELECT 'message-' || id, session_id, id, 'character_reply', prompt_tokens, completion_tokens, total_tokens,
        COALESCE(usage_source, 'estimated'), usage_model, created_at
      FROM messages WHERE prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL AND total_tokens IS NOT NULL AND usage_model IS NOT NULL;
    `);
    db.prepare("UPDATE meta SET value = '8' WHERE key = 'schemaVersion'").run();
  })();
}

function migrate8to9(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createRpgFoundationV9(db);
    db.prepare("UPDATE meta SET value = '9' WHERE key = 'schemaVersion'").run();
  })();
}

function migrate9to10(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createRpgContentV10(db);
    db.prepare("UPDATE meta SET value = '10' WHERE key = 'schemaVersion'").run();
  })();
}

function migrate10to11(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    assertCampaignContentPacksHaveExactSealedPacks(db);
    createRpgCharactersV11(db);
    createCampaignContentPackSealedPinTriggers(db);
    db.prepare("UPDATE meta SET value = '11' WHERE key = 'schemaVersion'").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('schemaRevision', ?)").run(SCHEMA_REVISION);
  })();
}

function migrate11to12(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createRpgCommandAuditV12(db);
    // Keep the marker last so no partially-created v12 schema can be reported
    // as current after a failed DDL statement.
    db.prepare("UPDATE meta SET value = '12' WHERE key = 'schemaVersion'").run();
  })();
}

function assertV12CommandAuditIsComplete(db: DatabaseDriver.Database): void {
  const invalid = db.prepare(`SELECT 1
    FROM (
      SELECT campaign_id, command_id FROM campaign_commands
      UNION
      SELECT campaign_id, command_id FROM campaign_events
      UNION
      SELECT campaign_id, command_id FROM command_receipts
    ) identity
    LEFT JOIN campaign_commands command
      ON command.campaign_id = identity.campaign_id AND command.command_id = identity.command_id
    LEFT JOIN campaign_events event
      ON event.campaign_id = identity.campaign_id AND event.command_id = identity.command_id
    LEFT JOIN command_receipts receipt
      ON receipt.campaign_id = identity.campaign_id AND receipt.command_id = identity.command_id
    LEFT JOIN campaign_timelines timeline
      ON timeline.campaign_id = event.campaign_id AND timeline.id = event.timeline_id
    LEFT JOIN campaign_actors actor
      ON actor.campaign_id = event.campaign_id AND actor.id = event.actor_id
    LEFT JOIN campaigns campaign ON campaign.id = identity.campaign_id
    WHERE command.command_id IS NULL OR event.event_id IS NULL OR receipt.command_id IS NULL
      OR campaign.id IS NULL OR timeline.id IS NULL OR actor.id IS NULL
      OR command.timeline_id <> event.timeline_id OR command.actor_id <> event.actor_id
      OR command.source_turn_id IS NOT event.source_turn_id
      OR command.type <> 'set_actor_attribute' OR event.type <> 'actor_attribute_set'
      OR command.attribute_id <> event.attribute_id OR command.value <> event.value_after
      OR command.expected_revision + 1 <> event.revision
      OR timeline.revision < event.revision
      OR receipt.revision_before <> command.expected_revision
      OR receipt.revision_after <> event.revision OR receipt.event_id <> event.event_id
    LIMIT 1`).get();
  if (invalid) throw new Error("schema v12 command audit is incomplete");
  const revisionGap = db.prepare(`SELECT 1
    FROM campaign_timelines timeline
    LEFT JOIN (
      SELECT campaign_id, timeline_id, COUNT(*) AS event_count
      FROM campaign_events
      GROUP BY campaign_id, timeline_id
    ) history ON history.campaign_id = timeline.campaign_id AND history.timeline_id = timeline.id
    WHERE timeline.revision <> COALESCE(history.event_count, 0)
    LIMIT 1`).get();
  if (revisionGap) throw new Error("schema v12 timeline revision history is incomplete");
}

function migrate12to13(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    assertV12CommandAuditIsComplete(db);
    // Renaming the complete v12 graph first lets SQLite retarget its internal
    // foreign keys. The final tables can then be created with exactly the same
    // SQL used by a fresh database.
    db.exec(`
      DROP TRIGGER campaign_commands_prevent_replace;
      DROP TRIGGER campaign_events_prevent_replace;
      DROP TRIGGER command_receipts_prevent_replace;
      DROP TRIGGER campaign_events_require_matching_command;
      DROP TRIGGER command_receipts_require_expected_revision;
      DROP TRIGGER campaign_commands_prevent_update;
      DROP TRIGGER campaign_commands_prevent_delete;
      DROP TRIGGER campaign_events_prevent_update;
      DROP TRIGGER campaign_events_prevent_delete;
      DROP TRIGGER command_receipts_prevent_update;
      DROP TRIGGER command_receipts_prevent_delete;
      ALTER TABLE command_receipts RENAME TO command_receipts_v12;
      ALTER TABLE campaign_events RENAME TO campaign_events_v12;
      ALTER TABLE campaign_commands RENAME TO campaign_commands_v12;
      DROP INDEX idx_command_receipts_event;
      DROP INDEX idx_campaign_events_actor;
      DROP INDEX idx_campaign_commands_actor;
      DROP INDEX idx_campaign_commands_timeline;
    `);
    createRpgCommandAuditV13(db);
    db.exec(`
      INSERT INTO campaign_commands
        (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
         source_turn_id, type, attribute_id, value,
         resource_name, resource_current, resource_max)
      SELECT campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
        source_turn_id, type, attribute_id, value, NULL, NULL, NULL
      FROM campaign_commands_v12;
      INSERT INTO campaign_events
        (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
         revision, occurred_at, attribute_id, value_before, value_after,
         resource_name, resource_current, resource_max)
      SELECT event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
        revision, occurred_at, attribute_id, value_before, value_after, NULL, NULL, NULL
      FROM campaign_events_v12;
      INSERT INTO command_receipts
        (campaign_id, command_id, revision_before, revision_after, event_id)
      SELECT campaign_id, command_id, revision_before, revision_after, event_id
      FROM command_receipts_v12;
      DROP TABLE command_receipts_v12;
      DROP TABLE campaign_events_v12;
      DROP TABLE campaign_commands_v12;
    `);
    createCampaignEventMatchingTriggerV13(db);
    db.prepare("UPDATE meta SET value = '13' WHERE key = 'schemaVersion'").run();
  })();
}

function assertV13CommandAuditIsComplete(db: DatabaseDriver.Database): void {
  const invalid = db.prepare(`SELECT 1
    FROM (
      SELECT campaign_id, command_id FROM campaign_commands
      UNION SELECT campaign_id, command_id FROM campaign_events
      UNION SELECT campaign_id, command_id FROM command_receipts
    ) identity
    LEFT JOIN campaign_commands command
      ON command.campaign_id = identity.campaign_id AND command.command_id = identity.command_id
    LEFT JOIN campaign_events event
      ON event.campaign_id = identity.campaign_id AND event.command_id = identity.command_id
    LEFT JOIN command_receipts receipt
      ON receipt.campaign_id = identity.campaign_id AND receipt.command_id = identity.command_id
    LEFT JOIN campaigns campaign ON campaign.id = identity.campaign_id
    LEFT JOIN campaign_timelines timeline
      ON timeline.campaign_id = event.campaign_id AND timeline.id = event.timeline_id
    LEFT JOIN campaign_actors actor
      ON actor.campaign_id = event.campaign_id AND actor.id = event.actor_id
    WHERE command.command_id IS NULL OR event.event_id IS NULL OR receipt.command_id IS NULL
      OR campaign.id IS NULL OR timeline.id IS NULL OR actor.id IS NULL
      OR command.timeline_id <> event.timeline_id OR command.actor_id <> event.actor_id
      OR command.source_turn_id IS NOT event.source_turn_id
      OR command.expected_revision + 1 <> event.revision OR timeline.revision < event.revision
      OR receipt.revision_before IS NULL OR receipt.revision_after IS NULL OR receipt.event_id IS NULL
      OR receipt.revision_before <> command.expected_revision
      OR receipt.revision_after <> event.revision OR receipt.event_id <> event.event_id
      OR COALESCE((
        (command.type = 'set_actor_attribute' AND event.type = 'actor_attribute_set'
          AND command.attribute_id IS NOT NULL AND command.value IS NOT NULL
          AND event.attribute_id IS NOT NULL AND event.value_before IS NOT NULL AND event.value_after IS NOT NULL
          AND event.value_before <> event.value_after
          AND command.attribute_id = event.attribute_id AND command.value = event.value_after
          AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
          AND event.resource_name IS NULL AND event.resource_current IS NULL AND event.resource_max IS NULL)
        OR (command.type = 'initialize_actor_resource' AND event.type = 'actor_resource_initialized'
          AND command.attribute_id IS NULL AND command.value IS NULL
          AND event.attribute_id IS NULL AND event.value_before IS NULL AND event.value_after IS NULL
          AND command.resource_name IS NOT NULL AND command.resource_current IS NOT NULL AND command.resource_max IS NOT NULL
          AND event.resource_name IS NOT NULL AND event.resource_current IS NOT NULL AND event.resource_max IS NOT NULL
          AND command.resource_current <= command.resource_max AND event.resource_current <= event.resource_max
          AND command.resource_name = event.resource_name
          AND command.resource_current = event.resource_current AND command.resource_max = event.resource_max)
      ), 0) = 0
    LIMIT 1`).get();
  if (invalid) throw new Error("schema v13 command audit is incomplete");

  const invalidResource = db.prepare(`SELECT 1 FROM rpg_actor_resources resource
    LEFT JOIN campaign_actors actor
      ON actor.campaign_id = resource.campaign_id AND actor.id = resource.actor_id
    WHERE actor.id IS NULL OR resource.name IS NULL OR resource.current IS NULL OR resource.max IS NULL
      OR typeof(resource.current) <> 'integer' OR typeof(resource.max) <> 'integer'
      OR resource.current < 0 OR resource.max > 1000000 OR resource.current > resource.max
      OR length(resource.name) NOT BETWEEN 1 AND 128 OR instr(resource.name, char(0)) <> 0
      OR resource.name GLOB '*[^A-Za-z0-9._:-]*'
    LIMIT 1`).get();
  if (invalidResource) throw new Error("schema v13 actor resources are incomplete");

  const revisionGap = db.prepare(`SELECT 1 FROM campaign_timelines timeline
    LEFT JOIN (SELECT campaign_id, timeline_id, COUNT(*) AS event_count
      FROM campaign_events GROUP BY campaign_id, timeline_id) history
      ON history.campaign_id = timeline.campaign_id AND history.timeline_id = timeline.id
    WHERE timeline.revision <> COALESCE(history.event_count, 0) LIMIT 1`).get();
  if (revisionGap) throw new Error("schema v13 timeline revision history is incomplete");
}

function migrate13to14(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    assertV13CommandAuditIsComplete(db);
    db.exec(`
      DROP TRIGGER campaign_commands_prevent_replace;
      DROP TRIGGER campaign_events_prevent_replace;
      DROP TRIGGER command_receipts_prevent_replace;
      DROP TRIGGER campaign_events_require_matching_command;
      DROP TRIGGER command_receipts_require_expected_revision;
      DROP TRIGGER campaign_commands_prevent_update;
      DROP TRIGGER campaign_commands_prevent_delete;
      DROP TRIGGER campaign_events_prevent_update;
      DROP TRIGGER campaign_events_prevent_delete;
      DROP TRIGGER command_receipts_prevent_update;
      DROP TRIGGER command_receipts_prevent_delete;
      ALTER TABLE command_receipts RENAME TO command_receipts_v13;
      ALTER TABLE campaign_events RENAME TO campaign_events_v13;
      ALTER TABLE campaign_commands RENAME TO campaign_commands_v13;
      ALTER TABLE rpg_actor_resources RENAME TO rpg_actor_resources_v13;
      DROP INDEX idx_command_receipts_event;
      DROP INDEX idx_campaign_events_actor;
      DROP INDEX idx_campaign_commands_actor;
      DROP INDEX idx_campaign_commands_timeline;
      DROP INDEX idx_rpg_actor_resources_actor;
    `);
    createRpgCommandAuditV14(db);
    db.exec(`
      INSERT INTO rpg_actor_resources (campaign_id, actor_id, name, current, max)
        SELECT campaign_id, actor_id, name, current, max FROM rpg_actor_resources_v13 ORDER BY rowid;
      INSERT INTO campaign_commands
        (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
          source_turn_id, type, attribute_id, value, resource_name, resource_current, resource_max,
          dice_expression, dice_count, dice_sides, dice_selection_type, dice_selection_count, dice_modifier)
        SELECT campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
          source_turn_id, type, attribute_id, value, resource_name, resource_current, resource_max,
          NULL, NULL, NULL, NULL, NULL, NULL
        FROM campaign_commands_v13 ORDER BY rowid;
      INSERT INTO campaign_events
        (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
          revision, occurred_at, attribute_id, value_before, value_after,
          resource_name, resource_current, resource_max)
        SELECT event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
          revision, occurred_at, attribute_id, value_before, value_after,
          resource_name, resource_current, resource_max FROM campaign_events_v13 ORDER BY rowid;
      INSERT INTO command_receipts (campaign_id, command_id, revision_before, revision_after, event_id)
        SELECT campaign_id, command_id, revision_before, revision_after, event_id
        FROM command_receipts_v13 ORDER BY rowid;
      DROP TABLE command_receipts_v13;
      DROP TABLE campaign_events_v13;
      DROP TABLE campaign_commands_v13;
      DROP TABLE rpg_actor_resources_v13;
    `);
    createCampaignEventMatchingTriggerV14(db);
    db.prepare("UPDATE meta SET value = '14' WHERE key = 'schemaVersion'").run();
  })();
}

function migrateLegacyIfPresent(db: DatabaseDriver.Database, dir: string, dependencies: RuntimeDependencies): void {
  const legacy = loadLegacyDatabase(dir, dependencies);
  if (!legacy) return;
  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM characters) AS characters,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM messages) AS messages`,
    )
    .get() as { characters: number; sessions: number; messages: number };
  if (counts.characters > 0 || counts.sessions > 0 || counts.messages > 0) {
    console.warn(
      `[velvet] legacy db.json found in ${dir} but migration was skipped because the SQLite database already contains data. ` +
        `The legacy file was left untouched; resolve it manually to avoid stale data.`,
    );
    return;
  }
  const run = db.transaction((data: Database) => {
    const insertCharacter = db.prepare(
      `INSERT INTO characters (id, name, age, archetype, boundaries, safe_word, fictional_confirmed, is_real_person, created_at)
       VALUES (@id, @name, @age, @archetype, @boundaries, @safeWord, @fictionalConfirmed, @isRealPerson, @createdAt)`,
    );
    for (const c of data.characters) {
      insertCharacter.run({
        ...c,
        fictionalConfirmed: c.fictionalConfirmed ? 1 : 0,
        isRealPerson: c.isRealPerson ? 1 : 0,
      });
    }
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, character_id, title, state, preset_id, active_leaf_id, created_at, stopped_at, stop_reason)
       VALUES (@id, @characterId, @title, @state, @presetId, NULL, @createdAt, @stoppedAt, @stopReason)`,
    );
    const insertConsent = db.prepare(
      `INSERT INTO consent_events (id, session_id, seq, at, scope, granted, note)
       VALUES (@id, @sessionId, @seq, @at, @scope, @granted, @note)`,
    );
    const insertSessionCharacter = db.prepare(
      "INSERT INTO session_characters (session_id, character_id, position) VALUES (?, ?, 0)",
    );
    for (const s of data.sessions) {
      if (!data.characters.some((c) => c.id === s.characterId)) continue;
      insertSession.run(s);
      insertSessionCharacter.run(s.id, s.characterId);
      s.consentLog.forEach((event, seq) => {
        insertConsent.run({
          id: event.id,
          sessionId: s.id,
          seq,
          at: event.at,
          scope: event.scope,
          granted: event.granted ? 1 : 0,
          note: event.note,
        });
      });
    }
    const sessionIds = new Set(data.sessions.map((s) => s.id));
    const insertMessage = db.prepare(
      `INSERT INTO messages (id, session_id, role, speaker_character_id, content, parent_id, swipe_group_id, swipe_index, seq, status, created_at)
        VALUES (@id, @sessionId, @role, @speakerCharacterId, @content, @parentId, @swipeGroupId, @swipeIndex, @seq, @status, @createdAt)`,
    );
    const setLeaf = db.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?");
    const legacyBySession = new Map<string, typeof data.messages>();
    for (const m of data.messages) {
      if (!sessionIds.has(m.sessionId)) continue;
      const bucket = legacyBySession.get(m.sessionId) ?? [];
      bucket.push(m);
      legacyBySession.set(m.sessionId, bucket);
    }
    for (const [sessionId, messages] of legacyBySession) {
      const ordered = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let prev: string | null = null;
      ordered.forEach((m, seq) => {
        insertMessage.run({
          ...m,
          speakerCharacterId: m.role === "character" ? data.sessions.find((s) => s.id === sessionId)?.characterId ?? null : null,
          parentId: prev,
          swipeGroupId: m.id,
          swipeIndex: 0,
          seq,
          status: "final",
        });
        prev = m.id;
      });
      if (prev !== null) setLeaf.run(prev, sessionId);
    }
    const characterIds = new Set(data.characters.map((c) => c.id));
    const insertMemory = db.prepare(
      `INSERT INTO memories (id, character_id, kind, content, source_turn_id, created_at, user_approved, forgotten_at)
       VALUES (@id, @characterId, @kind, @content, @sourceTurnId, @createdAt, @userApproved, @forgottenAt)`,
    );
    for (const m of data.memories) {
      if (!characterIds.has(m.characterId)) continue;
      insertMemory.run({ ...m, userApproved: m.userApproved ? 1 : 0 });
    }
    const insertSummary = db.prepare(
      `INSERT INTO summaries (session_id, summary, key_events, emotional_beat, updated_at)
       VALUES (@sessionId, @summary, @keyEvents, @emotionalBeat, @updatedAt)`,
    );
    for (const s of data.summaries) {
      if (!sessionIds.has(s.sessionId)) continue;
      insertSummary.run({ ...s, keyEvents: JSON.stringify(s.keyEvents) });
    }
    const insertLore = db.prepare(
      `INSERT INTO lore (id, character_id, keys, content, enabled, insertion_order, created_at)
       VALUES (@id, @characterId, @keys, @content, @enabled, @insertionOrder, @createdAt)`,
    );
    const insertLoreCharacter = db.prepare("INSERT INTO lore_characters (lore_id, character_id) VALUES (?, ?)");
    for (const entry of data.lore) {
      if (entry.characterId !== null && !characterIds.has(entry.characterId)) continue;
      insertLore.run({ ...entry, keys: JSON.stringify(entry.keys), enabled: entry.enabled ? 1 : 0 });
      if (entry.characterId) insertLoreCharacter.run(entry.id, entry.characterId);
    }
    db.prepare("INSERT INTO settings (id, payload) VALUES ('harness', ?)").run(JSON.stringify(data.settings));
    db.prepare("INSERT INTO provider (id, payload) VALUES ('provider', ?)").run(JSON.stringify(data.provider));
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacyMigratedAt', ?)").run(
      dependencies.clock.now().toISOString(),
    );
  });
  run(legacy);
  markLegacyMigrated(dir);
}
