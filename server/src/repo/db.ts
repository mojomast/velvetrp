import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadLegacyDatabase, markLegacyMigrated } from "../legacy.js";
import { systemRuntime } from "../runtime.js";
import type { RuntimeDependencies } from "../runtime.js";
import type { Database } from "../types.js";
import { canonicalCatalogJson, deriveCatalogVisibility, validateContentCatalog } from "./contentCatalogRepo.js";
import { configureRepositoryDatabase } from "./repoContext.js";
import { progressionCatalogDigest, progressionReferenceKey, resolveInitialKnownPowers, resolveSelectedClassProgression } from "../characterProgressionCatalog.js";
import { assertCanonicalProgressionProfile, canonicalProgressionJson, canonicalStarterProgressionProfile,
  progressionProfileDigest, starterProgressionProfileId } from "../characterProgressionProfile.js";
import { assertPowerDefinitionExists, calculateAuthoritativeProgressionPreview, expectedKnownPowerSources, loadExactProgressionCatalog,
  type ProgressionRootRow } from "./characterProgressionPersistence.js";


const SCHEMA_VERSION = "26";
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
      createCampaignAdministrationV15(db);
      createContentCatalogV16(db);
      createContentCatalogV17(db);
      createContentCatalogV18(db);
      createCharacterBuilderV19(db);
      createCharacterBuilderProvenanceV20(db);
      createCharacterBuilderIntegrityV21(db);
      createCharacterBuilderIntegrityV22(db);
      createCharacterProgressionV23(db);
      createCharacterProgressionIntegrityV24(db);
      createResourcesInventoryEconomyRestV25(db);
      createChecksPowersEffectsV26(db);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)").run(SCHEMA_VERSION);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schemaRevision', ?)").run(SCHEMA_REVISION);
    })();
    assertCharacterBuilderLayoutV22(db);
    assertCharacterProgressionLayoutV23(db);
    assertCharacterProgressionLayoutV24(db);
    assertResourcesInventoryEconomyRestLayoutV25(db);
    assertChecksPowersEffectsLayoutV26(db);
    validateV20DraftAudit(db);
    validateCharacterProgressionV24(db);
    validateM15PersistenceV25(db);
    validateM16PersistenceV26(db);
    return;
  }
  let version = row.value;
  const futureBuilderArtifact = Number(version) < 19 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*character*_v19*' LIMIT 1`).get() as
      { type: string; name: string } | undefined;
  if (futureBuilderArtifact) {
    throw new Error(`schema marker ${version} cannot contain future v19 artifact ${futureBuilderArtifact.name}`);
  }
  const futureProvenanceArtifact = Number(version) < 20 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v20' OR name GLOB '*_v20_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureProvenanceArtifact) {
    throw new Error(`schema marker ${version} cannot contain future v20 artifact ${futureProvenanceArtifact.name}`);
  }
  const futureIntegrityArtifact = Number(version) < 21 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v21' OR name GLOB '*_v21_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureIntegrityArtifact) throw new Error(`schema marker ${version} cannot contain future v21 artifact ${futureIntegrityArtifact.name}`);
  const futureArchiveArtifact = Number(version) < 22 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v22' OR name GLOB '*_v22_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureArchiveArtifact) throw new Error(`schema marker ${version} cannot contain future v22 artifact ${futureArchiveArtifact.name}`);
  const futureProgressionArtifact = Number(version) < 23 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v23' OR name GLOB '*_v23_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureProgressionArtifact) throw new Error(`schema marker ${version} cannot contain future v23 artifact ${futureProgressionArtifact.name}`);
  const futureProgressionIntegrityArtifact = Number(version) < 24 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v24' OR name GLOB '*_v24_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureProgressionIntegrityArtifact) throw new Error(`schema marker ${version} cannot contain future v24 artifact ${futureProgressionIntegrityArtifact.name}`);
  const futureResourcesArtifact = Number(version) < 25 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v25' OR name GLOB '*_v25_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureResourcesArtifact) throw new Error(`schema marker ${version} cannot contain future v25 artifact ${futureResourcesArtifact.name}`);
  const futureChecksPowersEffectsArtifact = Number(version) < 26 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v26' OR name GLOB '*_v26_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureChecksPowersEffectsArtifact) throw new Error(`schema marker ${version} cannot contain future v26 artifact ${futureChecksPowersEffectsArtifact.name}`);
  if(Number(version)<18&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaign_catalog_command_provenance_v18'").get()){
    // Historical fixtures can rewind only their target marker. A genuine
    // pre-v18 database can never contain this future-derived sidecar.
    db.exec(`DROP TRIGGER IF EXISTS campaign_catalog_commands_validate_requested_v18;
      DROP TRIGGER IF EXISTS campaign_catalog_events_require_proposal_v18;
      DROP TRIGGER IF EXISTS campaign_catalog_receipts_require_proposal_v18;
      DROP TABLE campaign_catalog_command_provenance_v18;`);
  }
  if (Number(version) < 15 && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rpg_content_pack_publications'").get()) {
    // Historical migration fixtures intentionally rewind only their target
    // marker from a current database. Remove impossible future-derived
    // catalog sidecars before replaying the genuine old migration chain.
    db.exec(`
      DROP TABLE IF EXISTS campaign_catalog_command_provenance_v18;
      DROP TABLE IF EXISTS campaign_catalog_current_pins;
      DROP TABLE IF EXISTS campaign_catalog_current_selections;
      DROP TABLE IF EXISTS campaign_catalog_receipts;
      DROP TABLE IF EXISTS campaign_catalog_events;
      DROP TABLE IF EXISTS campaign_catalog_commands;
      DROP TABLE IF EXISTS rpg_catalog_publication_submissions;
      DROP TABLE IF EXISTS rpg_catalog_definition_visibility;
      DROP TABLE IF EXISTS rpg_catalog_publication_attestations;
      DROP TABLE IF EXISTS campaign_content_catalog_pins;
      DROP TABLE IF EXISTS campaign_content_catalog_selections;
      DROP TABLE IF EXISTS rpg_catalog_definitions;
      DROP TABLE IF EXISTS rpg_content_pack_publications;
      DROP TRIGGER IF EXISTS rpg_content_packs_prevent_replace_v16;
      DROP TRIGGER IF EXISTS rpg_definitions_prevent_replace_v16;
      DROP TRIGGER IF EXISTS campaign_administration_commands_reject_catalog_identity;
      DROP TRIGGER IF EXISTS campaign_administration_events_reject_catalog_revision;
      DROP TRIGGER IF EXISTS campaign_catalog_commands_validate_requested_v18;
      DROP TRIGGER IF EXISTS campaign_catalog_events_require_proposal_v18;
      DROP TRIGGER IF EXISTS campaign_catalog_receipts_require_proposal_v18;
    `);
  }
  const campaignTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaigns'").get();
  const hasAdministrationRevision = campaignTable && (db.prepare("PRAGMA table_info(campaigns)").all() as Array<{ name: string }>)
    .some((column) => column.name === "administration_revision");
  if (!hasAdministrationRevision) {
    // Migration fixtures and interrupted pre-v15 databases must not retain a
    // v15 trigger that references a column their genuine old campaign table
    // does not have. Final v15 creation reinstalls the exact triggers.
    db.exec(`DROP TRIGGER IF EXISTS campaign_administration_revision_advance;
      DROP TRIGGER IF EXISTS campaigns_prevent_updated_at_rewind;
      DROP TRIGGER IF EXISTS campaign_administration_commands_require_current_revision;
      DROP TRIGGER IF EXISTS campaign_administration_events_require_current_revision;
      DROP TRIGGER IF EXISTS campaign_administration_receipts_require_current_revision;`);
  }
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
  if (version === "14") {
    migrate14to15(db);
    version = "15";
  }
  if (version === "15") {
    migrate15to16(db);
    version = "16";
  }
  if (version === "16") {
    migrate16to17(db);
    version = "17";
  }
  if (version === "17") {
    migrate17to18(db);
    version = "18";
  }
  if (version === "18") {
    migrate18to19(db);
    version = "19";
  }
  if (version === "19") {
    migrate19to20(db);
    version = "20";
  }
  if (version === "20") {
    migrate20to21(db);
    version = "21";
  }
  if (version === "21") {
    migrate21to22(db);
    version = "22";
  }
  if (version === "22") {
    migrate22to23(db);
    version = "23";
  }
  if (version === "23") {
    migrate23to24(db);
    version = "24";
  }
  if (version === "24") {
    migrate24to25(db);
    version = "25";
  }
  if (version === "25") {
    migrate25to26(db);
    version = "26";
  }
  if (version !== SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion ${version}; expected ${SCHEMA_VERSION}`);
  }
  assertCurrentSchemaRevision(db);
  assertCharacterBuilderLayoutV22(db);
  assertCharacterProgressionLayoutV23(db);
  assertCharacterProgressionLayoutV24(db);
  assertResourcesInventoryEconomyRestLayoutV25(db);
  assertChecksPowersEffectsLayoutV26(db);
  validateV20DraftAudit(db);
  validateCharacterProgressionV23(db);
  validateCharacterProgressionV24(db);
  validateM15PersistenceV25(db);
  validateM16PersistenceV26(db);
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

function createCampaignAdministrationV15(db: DatabaseDriver.Database): void {
  const timelineEventTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaign_timeline_events'").get();
  if (timelineEventTable) {
    const eventForeignKey = (db.prepare("PRAGMA foreign_key_list(campaign_timeline_events)").all() as Array<{ table: string }>)
      .find((foreignKey) => foreignKey.table.startsWith("campaign_events"));
    if (eventForeignKey?.table !== "campaign_events") {
      // Old migration tests may start from a current fixture whose marker was
      // intentionally rewound. Rebuild only this empty derived v15 index after
      // v12-v14 table renames so no stale SQLite-retargeted FK survives.
      db.exec("DROP TRIGGER IF EXISTS campaign_events_link_timeline; DROP TABLE campaign_timeline_events;");
    }
  }
  const columns = new Set((db.prepare("PRAGMA table_info(campaigns)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("lifecycle_status")) db.exec(`ALTER TABLE campaigns ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_status IN ('draft','published','paused','completed','archived'))`);
  if (!columns.has("settings")) db.exec(`ALTER TABLE campaigns ADD COLUMN settings TEXT NOT NULL DEFAULT
    '{"maxPlayers":6,"allowPlayerDice":true,"safetyMode":"standard","recapVisibility":"members","gmNotes":""}'
    CHECK (json_valid(settings) AND json_type(settings)='object')`);
  if (!columns.has("administration_revision")) db.exec(`ALTER TABLE campaigns ADD COLUMN administration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(administration_revision)='integer' AND administration_revision BETWEEN 0 AND 9007199254740991)`);
  // Corrective v15 guards are recreated on every open so existing v15 files
  // receive tightened provenance checks without rebuilding immutable audit data.
  db.exec(`DROP TRIGGER IF EXISTS campaign_timeline_events_require_native_event;
    DROP TRIGGER IF EXISTS campaign_imported_timeline_events_require_identity;
    DROP TRIGGER IF EXISTS campaign_imported_administration_events_validate;
    DROP TRIGGER IF EXISTS campaign_imported_administration_receipts_validate;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_timeline_history (
      campaign_id TEXT NOT NULL, timeline_id TEXT NOT NULL, source_timeline_id TEXT,
      parent_timeline_id TEXT, created_by_command_id TEXT UNIQUE,
      forked_from_revision INTEGER CHECK (forked_from_revision IS NULL OR
        (typeof(forked_from_revision)='integer' AND forked_from_revision BETWEEN 0 AND 9007199254740991)),
      PRIMARY KEY (campaign_id,timeline_id), UNIQUE (campaign_id,source_timeline_id),
      FOREIGN KEY (campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,parent_timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,created_by_command_id)
        REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE,
      CHECK ((parent_timeline_id IS NULL AND forked_from_revision IS NULL) OR
        (parent_timeline_id IS NOT NULL AND forked_from_revision IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS campaign_administration_commands (
      command_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL, actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      expected_revision INTEGER NOT NULL CHECK (typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      type TEXT NOT NULL CHECK (type IN ('campaign_renamed','administration_updated','membership_added','membership_role_changed','membership_removed',
        'room_attached','room_detached','checkpoint_created','timeline_forked','recap_created','import_applied','export_created')),
      payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload)='object'), created_at TEXT NOT NULL,
      UNIQUE (campaign_id,idempotency_key), UNIQUE (campaign_id,command_id),
      UNIQUE (campaign_id,command_id,type,expected_revision)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_administration_commands_campaign ON campaign_administration_commands(campaign_id,expected_revision);
    CREATE TABLE IF NOT EXISTS campaign_administration_events (
      event_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL UNIQUE REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      revision_before INTEGER NOT NULL, revision INTEGER NOT NULL CHECK (revision=revision_before+1),
      type TEXT NOT NULL CHECK (type IN ('campaign_renamed','administration_updated','membership_added','membership_role_changed','membership_removed',
        'room_attached','room_detached','checkpoint_created','timeline_forked','recap_created','import_applied','export_created')),
      public_data TEXT NOT NULL CHECK (json_valid(public_data) AND json_type(public_data)='object'),
      private_data TEXT NOT NULL CHECK (json_valid(private_data) AND json_type(private_data)='object'), occurred_at TEXT NOT NULL,
      UNIQUE (campaign_id,revision),
      UNIQUE (campaign_id,command_id,event_id,type,revision_before,revision),
      FOREIGN KEY (campaign_id,command_id,type,revision_before)
        REFERENCES campaign_administration_commands(campaign_id,command_id,type,expected_revision) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS campaign_administration_receipts (
      command_id TEXT PRIMARY KEY REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL, type TEXT NOT NULL,
      revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL,
      result_data TEXT NOT NULL CHECK (json_valid(result_data)), CHECK (revision_after=revision_before+1),
      FOREIGN KEY (campaign_id,command_id,type,revision_before)
        REFERENCES campaign_administration_commands(campaign_id,command_id,type,expected_revision) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,command_id,event_id,type,revision_before,revision_after)
        REFERENCES campaign_administration_events(campaign_id,command_id,event_id,type,revision_before,revision) ON DELETE CASCADE,
      UNIQUE (campaign_id,event_id)
    );
    CREATE TABLE IF NOT EXISTS campaign_checkpoints (
      id TEXT PRIMARY KEY, source_checkpoint_id TEXT, campaign_id TEXT NOT NULL, timeline_id TEXT NOT NULL, timeline_revision INTEGER NOT NULL,
      label TEXT NOT NULL CHECK (label=trim(label) AND length(label) BETWEEN 1 AND 200), created_at TEXT NOT NULL,
      command_id TEXT NOT NULL REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_checkpoints_campaign ON campaign_checkpoints(campaign_id,created_at,id);
    CREATE TABLE IF NOT EXISTS campaign_recaps (
      id TEXT PRIMARY KEY, source_recap_id TEXT, campaign_id TEXT NOT NULL, timeline_id TEXT NOT NULL, through_revision INTEGER NOT NULL,
      selected_session_ids TEXT NOT NULL CHECK (json_valid(selected_session_ids) AND json_type(selected_session_ids)='array'),
      visibility TEXT NOT NULL CHECK (visibility IN ('members','gm-only')), text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 50000),
      created_at TEXT NOT NULL, command_id TEXT NOT NULL REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_recaps_campaign ON campaign_recaps(campaign_id,created_at,id);
    CREATE TABLE IF NOT EXISTS campaign_imports (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      package_hash TEXT NOT NULL CHECK (length(package_hash)=64), format_version INTEGER NOT NULL CHECK (format_version=1),
      applied_at TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS campaign_import_submissions (
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL, package_hash TEXT NOT NULL CHECK (length(package_hash)=64),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, PRIMARY KEY (principal_id,idempotency_key), UNIQUE (command_id),
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS campaign_export_manifests (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL CHECK (format_version=1), record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 10000),
      excluded TEXT NOT NULL CHECK (json_valid(excluded) AND json_type(excluded)='array'),
      package_json TEXT NOT NULL CHECK (json_valid(package_json) AND json_type(package_json)='object'),
      created_at TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS campaign_timeline_events (
      campaign_id TEXT NOT NULL, timeline_id TEXT NOT NULL, revision INTEGER NOT NULL,
      event_id TEXT NOT NULL, inherited INTEGER NOT NULL CHECK (inherited IN (0,1)),
      PRIMARY KEY (campaign_id,timeline_id,revision), UNIQUE (campaign_id,timeline_id,event_id),
      FOREIGN KEY (campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE CASCADE,
      FOREIGN KEY (event_id) REFERENCES campaign_events(event_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS campaign_imported_timeline_events (
      campaign_id TEXT NOT NULL, timeline_id TEXT NOT NULL, revision INTEGER NOT NULL,
      source_event_id TEXT NOT NULL, source_command_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      source_turn_id TEXT, type TEXT NOT NULL CHECK (type IN ('actor_attribute_set','actor_resource_initialized','actor_dice_rolled')),
      occurred_at TEXT NOT NULL, public_data TEXT NOT NULL CHECK (json_valid(public_data) AND json_type(public_data)='object'),
      PRIMARY KEY (campaign_id,timeline_id,revision),
      UNIQUE (campaign_id,timeline_id,source_event_id), UNIQUE (campaign_id,timeline_id,source_command_id),
      FOREIGN KEY (campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS campaign_imported_administration_events (
      campaign_id TEXT NOT NULL, revision INTEGER NOT NULL, source_event_id TEXT NOT NULL,
      source_command_id TEXT NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL,
      public_data TEXT NOT NULL CHECK (json_valid(public_data) AND json_type(public_data)='object'),
      PRIMARY KEY (campaign_id,revision), UNIQUE (campaign_id,source_event_id), UNIQUE (campaign_id,source_command_id),
      UNIQUE (campaign_id,source_command_id,type,revision,occurred_at),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS campaign_imported_administration_receipts (
      campaign_id TEXT NOT NULL, source_command_id TEXT NOT NULL, type TEXT NOT NULL,
      revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL, occurred_at TEXT NOT NULL,
      PRIMARY KEY (campaign_id,source_command_id), CHECK (revision_after=revision_before+1),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_imported_timeline_event_identity
      ON campaign_imported_timeline_events(campaign_id,timeline_id,source_event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_imported_timeline_command_identity
      ON campaign_imported_timeline_events(campaign_id,timeline_id,source_command_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_imported_administration_event_identity
      ON campaign_imported_administration_events(campaign_id,source_event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_imported_administration_command_identity
      ON campaign_imported_administration_events(campaign_id,source_command_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_imported_administration_receipt_provenance
      ON campaign_imported_administration_events(campaign_id,source_command_id,type,revision,occurred_at);
    CREATE TABLE IF NOT EXISTS campaign_checkpoint_attribute_snapshots (
      checkpoint_id TEXT NOT NULL REFERENCES campaign_checkpoints(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL, attribute_id TEXT NOT NULL, value INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id,actor_id,attribute_id)
    );
    CREATE TABLE IF NOT EXISTS campaign_checkpoint_resource_snapshots (
      checkpoint_id TEXT NOT NULL REFERENCES campaign_checkpoints(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL, name TEXT NOT NULL, current INTEGER NOT NULL, max INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id,actor_id,name)
    );
    CREATE TRIGGER IF NOT EXISTS campaign_administration_revision_advance BEFORE UPDATE OF administration_revision ON campaigns
      WHEN NEW.administration_revision<>OLD.administration_revision+1
      BEGIN SELECT RAISE(ABORT,'campaign administration revision must advance exactly once'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_commands_require_current_revision BEFORE INSERT ON campaign_administration_commands
      WHEN NOT EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=NEW.campaign_id
        AND campaign.administration_revision=NEW.expected_revision)
      BEGIN SELECT RAISE(ABORT,'campaign administration command revision is stale'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_events_require_current_revision BEFORE INSERT ON campaign_administration_events
      WHEN NOT EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=NEW.campaign_id
        AND campaign.administration_revision=NEW.revision)
      BEGIN SELECT RAISE(ABORT,'campaign administration event revision is not current'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_receipts_require_current_revision BEFORE INSERT ON campaign_administration_receipts
      WHEN NOT EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=NEW.campaign_id
        AND campaign.administration_revision=NEW.revision_after)
      BEGIN SELECT RAISE(ABORT,'campaign administration receipt revision is not current'); END;
    CREATE TRIGGER IF NOT EXISTS campaigns_prevent_updated_at_rewind BEFORE UPDATE OF updated_at ON campaigns
      WHEN NEW.updated_at < OLD.updated_at BEGIN SELECT RAISE(ABORT,'campaign updated_at cannot rewind'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_events_link_timeline AFTER INSERT ON campaign_events
      BEGIN INSERT INTO campaign_timeline_events (campaign_id,timeline_id,revision,event_id,inherited)
        VALUES (NEW.campaign_id,NEW.timeline_id,NEW.revision,NEW.event_id,0); END;
    CREATE TRIGGER IF NOT EXISTS campaign_timeline_history_immutable_update BEFORE UPDATE ON campaign_timeline_history
      BEGIN SELECT RAISE(ABORT,'campaign timeline history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_timeline_history_immutable_delete BEFORE DELETE ON campaign_timeline_history
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign timeline history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_commands_immutable_update BEFORE UPDATE ON campaign_administration_commands
      BEGIN SELECT RAISE(ABORT,'campaign administration commands are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_commands_immutable_delete BEFORE DELETE ON campaign_administration_commands
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign administration commands are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_events_immutable_update BEFORE UPDATE ON campaign_administration_events
      BEGIN SELECT RAISE(ABORT,'campaign administration events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_events_immutable_delete BEFORE DELETE ON campaign_administration_events
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign administration events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_receipts_immutable_update BEFORE UPDATE ON campaign_administration_receipts
      BEGIN SELECT RAISE(ABORT,'campaign administration receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_receipts_immutable_delete BEFORE DELETE ON campaign_administration_receipts
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign administration receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_checkpoints_immutable_update BEFORE UPDATE ON campaign_checkpoints
      BEGIN SELECT RAISE(ABORT,'campaign checkpoints are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_checkpoints_immutable_delete BEFORE DELETE ON campaign_checkpoints
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign checkpoints are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_recaps_immutable_update BEFORE UPDATE ON campaign_recaps
      BEGIN SELECT RAISE(ABORT,'campaign recaps are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_recaps_immutable_delete BEFORE DELETE ON campaign_recaps
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign recaps are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imports_immutable_update BEFORE UPDATE ON campaign_imports
      BEGIN SELECT RAISE(ABORT,'campaign imports are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imports_immutable_delete BEFORE DELETE ON campaign_imports
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign imports are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_import_submissions_immutable_update BEFORE UPDATE ON campaign_import_submissions
      BEGIN SELECT RAISE(ABORT,'campaign import submissions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_import_submissions_immutable_delete BEFORE DELETE ON campaign_import_submissions
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign import submissions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_export_manifests_immutable_update BEFORE UPDATE ON campaign_export_manifests
      BEGIN SELECT RAISE(ABORT,'campaign export manifests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_export_manifests_immutable_delete BEFORE DELETE ON campaign_export_manifests
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign export manifests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_timeline_events_immutable_update BEFORE UPDATE ON campaign_timeline_events
      BEGIN SELECT RAISE(ABORT,'campaign timeline event links are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_timeline_events_immutable_delete BEFORE DELETE ON campaign_timeline_events
      WHEN EXISTS (SELECT 1 FROM campaign_events event WHERE event.event_id=OLD.event_id)
      BEGIN SELECT RAISE(ABORT,'campaign timeline event links are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_timeline_events_require_native_event BEFORE INSERT ON campaign_timeline_events
      WHEN (NEW.inherited=0 AND NOT EXISTS (SELECT 1 FROM campaign_events event WHERE event.event_id=NEW.event_id
          AND event.campaign_id=NEW.campaign_id AND event.timeline_id=NEW.timeline_id AND event.revision=NEW.revision))
        OR (NEW.inherited=1 AND NOT EXISTS (SELECT 1 FROM campaign_timeline_history history
          JOIN campaign_timeline_events parent_link ON parent_link.campaign_id=history.campaign_id
            AND parent_link.timeline_id=history.parent_timeline_id AND parent_link.revision=NEW.revision
            AND parent_link.event_id=NEW.event_id
          WHERE history.campaign_id=NEW.campaign_id AND history.timeline_id=NEW.timeline_id
            AND history.parent_timeline_id IS NOT NULL AND NEW.revision<=history.forked_from_revision))
      BEGIN SELECT RAISE(ABORT,'campaign timeline event link provenance is invalid'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_timeline_events_require_identity BEFORE INSERT ON campaign_imported_timeline_events
      WHEN EXISTS (SELECT 1 FROM campaign_imported_timeline_events old WHERE old.campaign_id=NEW.campaign_id
        AND (old.source_event_id=NEW.source_event_id OR old.source_command_id=NEW.source_command_id)
        AND NOT (old.source_event_id=NEW.source_event_id AND old.source_command_id=NEW.source_command_id
          AND old.revision=NEW.revision AND old.actor_id=NEW.actor_id AND old.source_turn_id IS NEW.source_turn_id
          AND old.type=NEW.type AND old.occurred_at=NEW.occurred_at AND old.public_data=NEW.public_data))
      BEGIN SELECT RAISE(ABORT,'imported timeline event identity is inconsistent'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_timeline_events_validate_payload BEFORE INSERT ON campaign_imported_timeline_events
      WHEN (NEW.type='actor_attribute_set' AND NOT (json_type(NEW.public_data,'$.attributeId')='text'
          AND json_type(NEW.public_data,'$.valueBefore')='integer' AND json_type(NEW.public_data,'$.valueAfter')='integer'
          AND (SELECT COUNT(*) FROM json_each(NEW.public_data))=3))
        OR (NEW.type='actor_resource_initialized' AND NOT (json_type(NEW.public_data,'$.name')='text'
          AND json_type(NEW.public_data,'$.current')='integer' AND json_type(NEW.public_data,'$.max')='integer'
          AND (SELECT COUNT(*) FROM json_each(NEW.public_data))=3))
        OR (NEW.type='actor_dice_rolled' AND NOT (json_type(NEW.public_data,'$.expression')='text'
          AND json_type(NEW.public_data,'$.normalized')='object' AND json_type(NEW.public_data,'$.terms')='array'
          AND json_type(NEW.public_data,'$.modifier')='integer' AND json_type(NEW.public_data,'$.total')='integer'
          AND (SELECT COUNT(*) FROM json_each(NEW.public_data))=5))
      BEGIN SELECT RAISE(ABORT,'imported timeline event payload is invalid'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_timeline_events_immutable_update BEFORE UPDATE ON campaign_imported_timeline_events
      BEGIN SELECT RAISE(ABORT,'imported timeline events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_timeline_events_immutable_delete BEFORE DELETE ON campaign_imported_timeline_events
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'imported timeline events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_administration_events_immutable_update BEFORE UPDATE ON campaign_imported_administration_events
      BEGIN SELECT RAISE(ABORT,'imported administration events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_administration_events_immutable_delete BEFORE DELETE ON campaign_imported_administration_events
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'imported administration events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_administration_receipts_immutable_update BEFORE UPDATE ON campaign_imported_administration_receipts
      BEGIN SELECT RAISE(ABORT,'imported administration receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_administration_receipts_immutable_delete BEFORE DELETE ON campaign_imported_administration_receipts
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'imported administration receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_administration_events_validate BEFORE INSERT ON campaign_imported_administration_events
      WHEN NEW.type NOT IN ('campaign_renamed','administration_updated','membership_added','membership_role_changed','membership_removed',
        'room_attached','room_detached','checkpoint_created','timeline_forked','recap_created','catalog_configured','import_applied','export_created')
        OR NEW.revision<1 OR NEW.revision>9007199254740991
      BEGIN SELECT RAISE(ABORT,'imported administration event is invalid'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_administration_receipts_validate BEFORE INSERT ON campaign_imported_administration_receipts
      WHEN NEW.type NOT IN ('campaign_renamed','administration_updated','membership_added','membership_role_changed','membership_removed',
        'room_attached','room_detached','checkpoint_created','timeline_forked','recap_created','catalog_configured','import_applied','export_created')
        OR NEW.revision_before<0 OR NEW.revision_after>9007199254740991
        OR NOT EXISTS (SELECT 1 FROM campaign_imported_administration_events event
          WHERE event.campaign_id=NEW.campaign_id AND event.source_command_id=NEW.source_command_id
            AND event.type=NEW.type AND event.revision=NEW.revision_after AND event.occurred_at=NEW.occurred_at)
      BEGIN SELECT RAISE(ABORT,'imported administration receipt is inconsistent'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_checkpoint_attribute_snapshots_immutable_update BEFORE UPDATE ON campaign_checkpoint_attribute_snapshots
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_checkpoint_attribute_snapshots_immutable_delete BEFORE DELETE ON campaign_checkpoint_attribute_snapshots
      WHEN EXISTS (SELECT 1 FROM campaign_checkpoints checkpoint WHERE checkpoint.id=OLD.checkpoint_id)
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_checkpoint_resource_snapshots_immutable_update BEFORE UPDATE ON campaign_checkpoint_resource_snapshots
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_checkpoint_resource_snapshots_immutable_delete BEFORE DELETE ON campaign_checkpoint_resource_snapshots
      WHEN EXISTS (SELECT 1 FROM campaign_checkpoints checkpoint WHERE checkpoint.id=OLD.checkpoint_id)
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_timeline_history_prevent_replace BEFORE INSERT ON campaign_timeline_history
      WHEN EXISTS (SELECT 1 FROM campaign_timeline_history old WHERE old.campaign_id=NEW.campaign_id
        AND (old.timeline_id=NEW.timeline_id OR old.created_by_command_id=NEW.created_by_command_id))
      BEGIN SELECT RAISE(ABORT,'campaign timeline history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_commands_prevent_replace BEFORE INSERT ON campaign_administration_commands
      WHEN EXISTS (SELECT 1 FROM campaign_administration_commands old WHERE old.command_id=NEW.command_id
        OR (old.campaign_id=NEW.campaign_id AND old.idempotency_key=NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT,'campaign administration commands are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_events_prevent_replace BEFORE INSERT ON campaign_administration_events
      WHEN EXISTS (SELECT 1 FROM campaign_administration_events old WHERE old.event_id=NEW.event_id
        OR (old.campaign_id=NEW.campaign_id AND (old.command_id=NEW.command_id OR old.revision=NEW.revision)))
      BEGIN SELECT RAISE(ABORT,'campaign administration events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_administration_receipts_prevent_replace BEFORE INSERT ON campaign_administration_receipts
      WHEN EXISTS (SELECT 1 FROM campaign_administration_receipts old WHERE old.command_id=NEW.command_id
        OR (old.campaign_id=NEW.campaign_id AND old.event_id=NEW.event_id))
      BEGIN SELECT RAISE(ABORT,'campaign administration receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_checkpoints_prevent_replace BEFORE INSERT ON campaign_checkpoints
      WHEN EXISTS (SELECT 1 FROM campaign_checkpoints old WHERE old.id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'campaign checkpoints are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_recaps_prevent_replace BEFORE INSERT ON campaign_recaps
      WHEN EXISTS (SELECT 1 FROM campaign_recaps old WHERE old.id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'campaign recaps are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imports_prevent_replace BEFORE INSERT ON campaign_imports
      WHEN EXISTS (SELECT 1 FROM campaign_imports old WHERE old.id=NEW.id OR old.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'campaign imports are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_import_submissions_prevent_replace BEFORE INSERT ON campaign_import_submissions
      WHEN EXISTS (SELECT 1 FROM campaign_import_submissions old WHERE
        (old.principal_id=NEW.principal_id AND old.idempotency_key=NEW.idempotency_key) OR old.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'campaign import submissions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_export_manifests_prevent_replace BEFORE INSERT ON campaign_export_manifests
      WHEN EXISTS (SELECT 1 FROM campaign_export_manifests old WHERE old.id=NEW.id OR old.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'campaign export manifests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_timeline_events_prevent_replace BEFORE INSERT ON campaign_timeline_events
      WHEN EXISTS (SELECT 1 FROM campaign_timeline_events old WHERE old.campaign_id=NEW.campaign_id
        AND old.timeline_id=NEW.timeline_id AND (old.revision=NEW.revision OR old.event_id=NEW.event_id))
      BEGIN SELECT RAISE(ABORT,'campaign timeline event links are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_timeline_events_prevent_replace BEFORE INSERT ON campaign_imported_timeline_events
      WHEN EXISTS (SELECT 1 FROM campaign_imported_timeline_events old WHERE old.campaign_id=NEW.campaign_id
        AND old.timeline_id=NEW.timeline_id AND old.revision=NEW.revision)
      BEGIN SELECT RAISE(ABORT,'imported timeline events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_administration_events_prevent_replace BEFORE INSERT ON campaign_imported_administration_events
      WHEN EXISTS (SELECT 1 FROM campaign_imported_administration_events old WHERE old.campaign_id=NEW.campaign_id
        AND old.revision=NEW.revision)
      BEGIN SELECT RAISE(ABORT,'imported administration events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_imported_administration_receipts_prevent_replace BEFORE INSERT ON campaign_imported_administration_receipts
      WHEN EXISTS (SELECT 1 FROM campaign_imported_administration_receipts old WHERE old.campaign_id=NEW.campaign_id
        AND old.source_command_id=NEW.source_command_id)
      BEGIN SELECT RAISE(ABORT,'imported administration receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_checkpoint_attribute_snapshots_prevent_replace BEFORE INSERT ON campaign_checkpoint_attribute_snapshots
      WHEN EXISTS (SELECT 1 FROM campaign_checkpoint_attribute_snapshots old WHERE old.checkpoint_id=NEW.checkpoint_id
        AND old.actor_id=NEW.actor_id AND old.attribute_id=NEW.attribute_id)
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS campaign_checkpoint_resource_snapshots_prevent_replace BEFORE INSERT ON campaign_checkpoint_resource_snapshots
      WHEN EXISTS (SELECT 1 FROM campaign_checkpoint_resource_snapshots old WHERE old.checkpoint_id=NEW.checkpoint_id
        AND old.actor_id=NEW.actor_id AND old.name=NEW.name)
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
  `);
  db.prepare(`INSERT INTO campaign_timeline_history (campaign_id,timeline_id,source_timeline_id,parent_timeline_id,created_by_command_id,forked_from_revision)
    SELECT timeline.campaign_id,timeline.id,NULL,NULL,NULL,NULL FROM campaign_timelines timeline
    WHERE NOT EXISTS (SELECT 1 FROM campaign_timeline_history history
      WHERE history.campaign_id=timeline.campaign_id AND history.timeline_id=timeline.id)
    ORDER BY timeline.campaign_id,timeline.created_at,timeline.id`).run();
  db.prepare(`INSERT INTO campaign_timeline_events (campaign_id,timeline_id,revision,event_id,inherited)
    SELECT event.campaign_id,event.timeline_id,event.revision,event.event_id,0 FROM campaign_events event
    WHERE NOT EXISTS (SELECT 1 FROM campaign_timeline_events link WHERE link.event_id=event.event_id
      AND link.campaign_id=event.campaign_id AND link.timeline_id=event.timeline_id)
    ORDER BY event.campaign_id,event.timeline_id,event.revision`).run();
}

/** Additive v16 catalog sidecars; existing v10 content tables are unchanged. */
function createContentCatalogV16(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_content_pack_publications (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      validation_level TEXT NOT NULL CHECK (validation_level IN ('legacy-v10','validated-v1')),
      rules_engine TEXT CHECK (rules_engine IS NULL OR rules_engine='velvet-starter-v1'),
      manifest_digest TEXT CHECK (manifest_digest IS NULL OR (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*')),
      manifest_json TEXT CHECK (manifest_json IS NULL OR (json_valid(manifest_json) AND json_type(manifest_json)='object')),
      provenance_json TEXT CHECK (provenance_json IS NULL OR (json_valid(provenance_json) AND json_type(provenance_json)='object')),
      validation_report_json TEXT CHECK (validation_report_json IS NULL OR (json_valid(validation_report_json) AND json_type(validation_report_json)='object')),
      published_by_principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT, published_at TEXT,
      PRIMARY KEY (pack_id,pack_version),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_packs(pack_id,pack_version) ON DELETE RESTRICT,
      CHECK ((validation_level='legacy-v10' AND rules_engine IS NULL AND manifest_digest IS NULL AND manifest_json IS NULL
          AND provenance_json IS NULL AND validation_report_json IS NULL AND published_by_principal_id IS NULL AND published_at IS NULL)
        OR (validation_level='validated-v1' AND rules_engine='velvet-starter-v1' AND manifest_digest IS NOT NULL
          AND manifest_json IS NOT NULL AND provenance_json IS NOT NULL AND validation_report_json IS NOT NULL
          AND published_by_principal_id IS NOT NULL AND published_at IS NOT NULL))
    );
    CREATE INDEX idx_rpg_content_pack_publications_validation ON rpg_content_pack_publications(validation_level,pack_id,pack_version);
    CREATE TABLE rpg_catalog_definitions (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('race','background','class','class-level','skill','ability','spell','item','currency','enemy-template')),
      definition_id TEXT NOT NULL CHECK (length(definition_id) BETWEEN 1 AND 128 AND definition_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND json_type(definition_json)='object'),
      public_definition_json TEXT NOT NULL CHECK (json_valid(public_definition_json) AND json_type(public_definition_json)='object'),
      dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json) AND json_type(dependencies_json)='array'),
      PRIMARY KEY (pack_id,pack_version,kind,definition_id),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_packs(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE INDEX idx_rpg_catalog_definitions_pack ON rpg_catalog_definitions(pack_id,pack_version,kind,definition_id);
    CREATE TABLE campaign_content_catalog_selections (
      campaign_id TEXT PRIMARY KEY, rules_profile_id TEXT NOT NULL,
      selection_digest TEXT NOT NULL CHECK (length(selection_digest)=64 AND selection_digest NOT GLOB '*[^0-9a-f]*'),
      configured_by_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT, configured_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id,rules_profile_id) REFERENCES campaign_rules_profiles(campaign_id,rules_profile_id) ON DELETE CASCADE
    );
    CREATE TABLE campaign_content_catalog_pins (
      campaign_id TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (typeof(position)='integer' AND position BETWEEN 0 AND 63),
      PRIMARY KEY (campaign_id,pack_id), UNIQUE (campaign_id,position),
      FOREIGN KEY (campaign_id) REFERENCES campaign_content_catalog_selections(campaign_id) ON DELETE CASCADE,
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_content_catalog_pins_exact ON campaign_content_catalog_pins(pack_id,pack_version,campaign_id);
    CREATE TRIGGER rpg_content_pack_publications_require_validated_pack BEFORE INSERT ON rpg_content_pack_publications
      WHEN NEW.validation_level='validated-v1' AND NOT EXISTS (SELECT 1 FROM rpg_content_packs pack
        WHERE pack.pack_id=NEW.pack_id AND pack.pack_version=NEW.pack_version AND pack.sealed=1)
      BEGIN SELECT RAISE(ABORT,'validated publication requires an exact sealed pack'); END;
    CREATE TRIGGER campaign_content_catalog_pins_require_validated BEFORE INSERT ON campaign_content_catalog_pins
      WHEN NOT EXISTS (SELECT 1 FROM rpg_content_pack_publications publication WHERE publication.pack_id=NEW.pack_id
        AND publication.pack_version=NEW.pack_version AND publication.validation_level='validated-v1')
        OR NOT EXISTS (SELECT 1 FROM campaign_content_packs pin WHERE pin.campaign_id=NEW.campaign_id
          AND pin.pack_id=NEW.pack_id AND pin.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'campaign catalog pins require validated-v1 publication'); END;
    CREATE TRIGGER rpg_content_packs_prevent_replace_v16 BEFORE INSERT ON rpg_content_packs
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version AND old.sealed=1)
      BEGIN SELECT RAISE(ABORT,'sealed RPG content packs are immutable'); END;
    CREATE TRIGGER rpg_definitions_prevent_replace_v16 BEFORE INSERT ON rpg_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_definitions old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id)
      BEGIN SELECT RAISE(ABORT,'RPG definitions are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_immutable_update BEFORE UPDATE ON rpg_content_pack_publications BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_immutable_delete BEFORE DELETE ON rpg_content_pack_publications BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_prevent_replace BEFORE INSERT ON rpg_content_pack_publications
      WHEN EXISTS (SELECT 1 FROM rpg_content_pack_publications old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_immutable_update BEFORE UPDATE ON rpg_catalog_definitions BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_immutable_delete BEFORE DELETE ON rpg_catalog_definitions BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_prevent_sealed_insert BEFORE INSERT ON rpg_catalog_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs pack WHERE pack.pack_id=NEW.pack_id AND pack.pack_version=NEW.pack_version AND pack.sealed=1)
      BEGIN SELECT RAISE(ABORT,'sealed RPG content catalogs cannot accept definitions'); END;
    CREATE TRIGGER rpg_catalog_definitions_prevent_replace BEFORE INSERT ON rpg_catalog_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_catalog_definitions old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id)
      BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_selections_immutable_update BEFORE UPDATE ON campaign_content_catalog_selections BEGIN SELECT RAISE(ABORT,'campaign catalog selections are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_selections_immutable_delete BEFORE DELETE ON campaign_content_catalog_selections
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id) BEGIN SELECT RAISE(ABORT,'campaign catalog selections are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_selections_prevent_replace BEFORE INSERT ON campaign_content_catalog_selections
      WHEN EXISTS (SELECT 1 FROM campaign_content_catalog_selections old WHERE old.campaign_id=NEW.campaign_id) BEGIN SELECT RAISE(ABORT,'campaign catalog selections are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_pins_immutable_update BEFORE UPDATE ON campaign_content_catalog_pins BEGIN SELECT RAISE(ABORT,'campaign catalog pins are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_pins_immutable_delete BEFORE DELETE ON campaign_content_catalog_pins
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id) BEGIN SELECT RAISE(ABORT,'campaign catalog pins are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_pins_prevent_replace BEFORE INSERT ON campaign_content_catalog_pins
      WHEN EXISTS (SELECT 1 FROM campaign_content_catalog_pins old WHERE old.campaign_id=NEW.campaign_id
        AND (old.pack_id=NEW.pack_id OR old.position=NEW.position)) BEGIN SELECT RAISE(ABORT,'campaign catalog pins are immutable'); END;
  `);
  db.prepare(`INSERT INTO rpg_content_pack_publications
    (pack_id,pack_version,validation_level,rules_engine,manifest_digest,manifest_json,provenance_json,
      validation_report_json,published_by_principal_id,published_at)
    SELECT pack_id,pack_version,'legacy-v10',NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM rpg_content_packs
    WHERE sealed=1 ORDER BY pack_id COLLATE BINARY,pack_version COLLATE BINARY`).run();
}

/** Unused construction snapshot retained only as implementation history. */
function createContentCatalogV17LegacyCurrent(db: DatabaseDriver.Database): void {
  const retainedFixtureTables = ["rpg_content_pack_publications", "rpg_catalog_definitions",
    "campaign_content_catalog_selections", "campaign_content_catalog_pins"];
  const retainedCount = retainedFixtureTables.filter((name) => db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name)).length;
  if (retainedCount === retainedFixtureTables.length) {
    // Historical migration tests rewind a database marker after removing only
    // the version-under-test objects. Preserve complete later sidecars, but do
    // not accept a genuinely partial v16 attempt.
    db.prepare(`INSERT INTO rpg_content_pack_publications
      (pack_id,pack_version,validation_level,rules_engine,manifest_digest,manifest_json,provenance_json,
        validation_report_json,definition_count,definition_counts_json,published_by_principal_id,published_at)
      SELECT pack.pack_id,pack.pack_version,'legacy-v10',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM rpg_content_packs pack
      WHERE pack.sealed=1 AND NOT EXISTS (SELECT 1 FROM rpg_content_pack_publications publication
        WHERE publication.pack_id=pack.pack_id AND publication.pack_version=pack.pack_version)
      ORDER BY pack.pack_id COLLATE BINARY,pack.pack_version COLLATE BINARY`).run();
    // Rewinding older migration fixtures may have dropped and recreated the
    // v10 parent tables, which removes only triggers attached to those tables.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS rpg_content_packs_prevent_replace_v16 BEFORE INSERT ON rpg_content_packs
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version AND old.sealed=1)
      BEGIN SELECT RAISE(ABORT,'sealed RPG content packs are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS rpg_definitions_prevent_replace_v16 BEFORE INSERT ON rpg_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_definitions old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id)
      BEGIN SELECT RAISE(ABORT,'RPG definitions are immutable'); END;
    `);
    return;
  }
  db.exec(`
    CREATE TABLE rpg_content_pack_publications (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      validation_level TEXT NOT NULL CHECK (validation_level IN ('legacy-v10','validated-v1')),
      rules_engine TEXT CHECK (rules_engine IS NULL OR rules_engine='velvet-starter-v1'),
      manifest_digest TEXT CHECK (manifest_digest IS NULL OR (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*')),
      manifest_json TEXT CHECK (manifest_json IS NULL OR (json_valid(manifest_json) AND json_type(manifest_json)='object')),
      provenance_json TEXT CHECK (provenance_json IS NULL OR (json_valid(provenance_json) AND json_type(provenance_json)='object')),
      validation_report_json TEXT CHECK (validation_report_json IS NULL OR (json_valid(validation_report_json) AND json_type(validation_report_json)='object')),
      definition_count INTEGER CHECK (definition_count IS NULL OR (typeof(definition_count)='integer' AND definition_count BETWEEN 1 AND 1024)),
      definition_counts_json TEXT CHECK (definition_counts_json IS NULL OR (json_valid(definition_counts_json) AND json_type(definition_counts_json)='array')),
      published_by_principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT, published_at TEXT,
      PRIMARY KEY (pack_id,pack_version),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_packs(pack_id,pack_version) ON DELETE RESTRICT,
      CHECK ((validation_level='legacy-v10' AND rules_engine IS NULL AND manifest_digest IS NULL AND manifest_json IS NULL
          AND provenance_json IS NULL AND validation_report_json IS NULL AND definition_count IS NULL
          AND definition_counts_json IS NULL AND published_by_principal_id IS NULL AND published_at IS NULL)
        OR (validation_level='validated-v1' AND rules_engine='velvet-starter-v1' AND manifest_digest IS NOT NULL
          AND manifest_json IS NOT NULL AND provenance_json IS NOT NULL AND validation_report_json IS NOT NULL
          AND definition_count IS NOT NULL AND definition_counts_json IS NOT NULL
          AND published_by_principal_id IS NOT NULL AND published_at IS NOT NULL
          AND json_extract(manifest_json,'$.packId')=pack_id AND json_extract(manifest_json,'$.packVersion')=pack_version
          AND json_extract(manifest_json,'$.digest')=manifest_digest
          AND json_extract(manifest_json,'$.compatibility.catalogFormat')='validated-v1'
          AND json_extract(manifest_json,'$.compatibility.rulesEngine')='velvet-starter-v1'
          AND json_extract(validation_report_json,'$.valid')=1
          AND json_array_length(json_extract(validation_report_json,'$.issues'))=0
          AND json_extract(validation_report_json,'$.normalizedSummary.totalDefinitions')=definition_count
          AND json_extract(validation_report_json,'$.normalizedSummary.digest')=manifest_digest
          AND json_extract(validation_report_json,'$.normalizedSummary.counts')=definition_counts_json))
    );
    CREATE INDEX idx_rpg_content_pack_publications_validation ON rpg_content_pack_publications(validation_level,pack_id,pack_version);
    CREATE TABLE rpg_catalog_definitions (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('race','background','class','class-level','skill','ability','spell','item','currency','enemy-template')),
      definition_id TEXT NOT NULL CHECK (length(definition_id) BETWEEN 1 AND 128 AND definition_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND json_type(definition_json)='object'),
      public_definition_json TEXT NOT NULL CHECK (json_valid(public_definition_json) AND json_type(public_definition_json)='object'),
      dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json) AND json_type(dependencies_json)='array'),
      public_dependencies_json TEXT NOT NULL CHECK (json_valid(public_dependencies_json) AND json_type(public_dependencies_json)='array'),
      private_dependencies_json TEXT NOT NULL CHECK (json_valid(private_dependencies_json) AND json_type(private_dependencies_json)='array'),
      PRIMARY KEY (pack_id,pack_version,kind,definition_id),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_packs(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE INDEX idx_rpg_catalog_definitions_pack ON rpg_catalog_definitions(pack_id,pack_version,kind,definition_id);
    CREATE TABLE campaign_content_catalog_selections (
      campaign_id TEXT PRIMARY KEY, rules_profile_id TEXT NOT NULL,
      selection_digest TEXT NOT NULL CHECK (length(selection_digest)=64 AND selection_digest NOT GLOB '*[^0-9a-f]*'),
      configured_by_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT, configured_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id,rules_profile_id) REFERENCES campaign_rules_profiles(campaign_id,rules_profile_id) ON DELETE CASCADE
    );
    CREATE TABLE campaign_content_catalog_pins (
      campaign_id TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (typeof(position)='integer' AND position BETWEEN 0 AND 63),
      PRIMARY KEY (campaign_id,pack_id), UNIQUE (campaign_id,position),
      FOREIGN KEY (campaign_id) REFERENCES campaign_content_catalog_selections(campaign_id) ON DELETE CASCADE,
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_content_catalog_pins_exact ON campaign_content_catalog_pins(pack_id,pack_version,campaign_id);
    CREATE TABLE campaign_catalog_commands (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      expected_revision INTEGER NOT NULL CHECK (typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      request_digest TEXT NOT NULL CHECK (length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      requested_json TEXT NOT NULL CHECK (json_valid(requested_json) AND json_type(requested_json)='object'),
      created_at TEXT NOT NULL,
      PRIMARY KEY (campaign_id,command_id), UNIQUE (campaign_id,idempotency_key),
      UNIQUE (campaign_id,command_id,expected_revision), CHECK (command_id=idempotency_key),
      CHECK (json_extract(requested_json,'$.expectedRevision')=expected_revision
        AND json_extract(requested_json,'$.idempotencyKey')=idempotency_key)
    );
    CREATE TABLE campaign_catalog_events (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL,
      event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      revision_before INTEGER NOT NULL, revision INTEGER NOT NULL CHECK (revision=revision_before+1),
      occurred_at TEXT NOT NULL, public_data TEXT NOT NULL CHECK (json_valid(public_data) AND json_type(public_data)='object'),
      PRIMARY KEY (campaign_id,event_id), UNIQUE (campaign_id,command_id), UNIQUE (campaign_id,revision),
      FOREIGN KEY (campaign_id,command_id,revision_before) REFERENCES campaign_catalog_commands(campaign_id,command_id,expected_revision) ON DELETE RESTRICT,
      UNIQUE (campaign_id,command_id,event_id,revision_before,revision), CHECK (event_id=command_id)
    );
    CREATE TABLE campaign_catalog_receipts (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, event_id TEXT NOT NULL,
      revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL CHECK (revision_after=revision_before+1),
      result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json)='object'),
      PRIMARY KEY (campaign_id,command_id),
      FOREIGN KEY (campaign_id,command_id,event_id,revision_before,revision_after)
        REFERENCES campaign_catalog_events(campaign_id,command_id,event_id,revision_before,revision) ON DELETE RESTRICT
    );
    CREATE TRIGGER rpg_content_pack_publications_require_validated_pack BEFORE INSERT ON rpg_content_pack_publications
      WHEN NEW.validation_level='validated-v1' AND NOT EXISTS (SELECT 1 FROM rpg_content_packs pack
        WHERE pack.pack_id=NEW.pack_id AND pack.pack_version=NEW.pack_version AND pack.sealed=1)
      BEGIN SELECT RAISE(ABORT,'validated publication requires an exact sealed pack'); END;
    CREATE TRIGGER rpg_content_pack_publications_validate_graph BEFORE INSERT ON rpg_content_pack_publications
      WHEN NEW.validation_level='validated-v1' AND (
        json_extract(NEW.manifest_json,'$.compatibility.rulesProfileId') IS NOT (SELECT rules_profile_id FROM rpg_content_packs
          WHERE pack_id=NEW.pack_id AND pack_version=NEW.pack_version)
        OR json_extract(NEW.manifest_json,'$.name') IS NOT (SELECT name FROM rpg_content_packs
          WHERE pack_id=NEW.pack_id AND pack_version=NEW.pack_version)
        OR json_extract(NEW.manifest_json,'$.description') IS NOT (SELECT description FROM rpg_content_packs
          WHERE pack_id=NEW.pack_id AND pack_version=NEW.pack_version)
        OR json_extract(NEW.manifest_json,'$.tags') IS NOT (SELECT tags FROM rpg_content_packs
          WHERE pack_id=NEW.pack_id AND pack_version=NEW.pack_version)
        OR NEW.definition_count<>(SELECT COUNT(*) FROM rpg_catalog_definitions
          WHERE pack_id=NEW.pack_id AND pack_version=NEW.pack_version)
        OR json_array_length(NEW.definition_counts_json)<>10
        OR (SELECT COUNT(DISTINCT json_extract(count.value,'$.kind')) FROM json_each(NEW.definition_counts_json) count)<>10
        OR (SELECT SUM(json_extract(count.value,'$.count')) FROM json_each(NEW.definition_counts_json) count)<>NEW.definition_count
        OR EXISTS (SELECT 1 FROM json_each(NEW.definition_counts_json) count
          WHERE json_extract(count.value,'$.count')<>(SELECT COUNT(*) FROM rpg_catalog_definitions definition
            WHERE definition.pack_id=NEW.pack_id AND definition.pack_version=NEW.pack_version
              AND definition.kind=json_extract(count.value,'$.kind')))
      ) BEGIN SELECT RAISE(ABORT,'validated publication graph is inconsistent'); END;
    CREATE TRIGGER rpg_catalog_definitions_validate_identity BEFORE INSERT ON rpg_catalog_definitions
      WHEN json_extract(NEW.definition_json,'$.reference.packId') IS NOT NEW.pack_id
        OR json_extract(NEW.definition_json,'$.reference.packVersion') IS NOT NEW.pack_version
        OR json_extract(NEW.definition_json,'$.reference.kind') IS NOT NEW.kind
        OR json_extract(NEW.definition_json,'$.reference.definitionId') IS NOT NEW.definition_id
        OR json_extract(NEW.public_definition_json,'$.reference.packId') IS NOT NEW.pack_id
        OR json_extract(NEW.public_definition_json,'$.reference.packVersion') IS NOT NEW.pack_version
        OR json_extract(NEW.public_definition_json,'$.reference.kind') IS NOT NEW.kind
        OR json_extract(NEW.public_definition_json,'$.reference.definitionId') IS NOT NEW.definition_id
        OR json_type(NEW.public_definition_json,'$.private') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'catalog definition identity is inconsistent'); END;
    CREATE TRIGGER campaign_content_catalog_pins_require_validated BEFORE INSERT ON campaign_content_catalog_pins
      WHEN NOT EXISTS (SELECT 1 FROM rpg_content_pack_publications publication WHERE publication.pack_id=NEW.pack_id
        AND publication.pack_version=NEW.pack_version AND publication.validation_level='validated-v1')
        OR NOT EXISTS (SELECT 1 FROM campaign_content_packs pin WHERE pin.campaign_id=NEW.campaign_id
          AND pin.pack_id=NEW.pack_id AND pin.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'campaign catalog pins require validated-v1 publication'); END;
    CREATE TRIGGER rpg_content_packs_prevent_replace_v16 BEFORE INSERT ON rpg_content_packs
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version AND old.sealed=1)
      BEGIN SELECT RAISE(ABORT,'sealed RPG content packs are immutable'); END;
    CREATE TRIGGER rpg_definitions_prevent_replace_v16 BEFORE INSERT ON rpg_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_definitions old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id)
      BEGIN SELECT RAISE(ABORT,'RPG definitions are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_immutable_update BEFORE UPDATE ON rpg_content_pack_publications BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_immutable_delete BEFORE DELETE ON rpg_content_pack_publications BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_prevent_replace BEFORE INSERT ON rpg_content_pack_publications
      WHEN EXISTS (SELECT 1 FROM rpg_content_pack_publications old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_immutable_update BEFORE UPDATE ON rpg_catalog_definitions BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_immutable_delete BEFORE DELETE ON rpg_catalog_definitions BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_prevent_sealed_insert BEFORE INSERT ON rpg_catalog_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs pack WHERE pack.pack_id=NEW.pack_id
        AND pack.pack_version=NEW.pack_version AND pack.sealed=1)
      BEGIN SELECT RAISE(ABORT,'sealed RPG content catalogs cannot accept definitions'); END;
    CREATE TRIGGER rpg_catalog_definitions_prevent_replace BEFORE INSERT ON rpg_catalog_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_catalog_definitions old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id)
      BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_selections_require_open_command_insert BEFORE INSERT ON campaign_content_catalog_selections
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        WHERE command.campaign_id=NEW.campaign_id AND receipt.command_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'campaign catalog selection requires an open catalog command'); END;
    CREATE TRIGGER campaign_content_catalog_selections_require_open_command_update BEFORE UPDATE ON campaign_content_catalog_selections
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        WHERE command.campaign_id=NEW.campaign_id AND receipt.command_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'campaign catalog selection requires an open catalog command'); END;
    CREATE TRIGGER campaign_content_catalog_selections_require_open_command_delete BEFORE DELETE ON campaign_content_catalog_selections
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        WHERE command.campaign_id=OLD.campaign_id AND receipt.command_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'campaign catalog selection requires an open catalog command'); END;
    CREATE TRIGGER campaign_content_catalog_pins_require_open_command_insert BEFORE INSERT ON campaign_content_catalog_pins
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        WHERE command.campaign_id=NEW.campaign_id AND receipt.command_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'campaign catalog pins require an open catalog command'); END;
    CREATE TRIGGER campaign_content_catalog_pins_require_open_command_delete BEFORE DELETE ON campaign_content_catalog_pins
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        WHERE command.campaign_id=OLD.campaign_id AND receipt.command_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'campaign catalog pins require an open catalog command'); END;
    CREATE TRIGGER campaign_catalog_commands_immutable_update BEFORE UPDATE ON campaign_catalog_commands BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_commands_immutable_delete BEFORE DELETE ON campaign_catalog_commands BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_commands_prevent_replace BEFORE INSERT ON campaign_catalog_commands
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_commands old WHERE old.campaign_id=NEW.campaign_id
        AND (old.command_id=NEW.command_id OR old.idempotency_key=NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_immutable_update BEFORE UPDATE ON campaign_catalog_events BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_immutable_delete BEFORE DELETE ON campaign_catalog_events BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_prevent_replace BEFORE INSERT ON campaign_catalog_events
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_events old WHERE old.campaign_id=NEW.campaign_id
        AND (old.event_id=NEW.event_id OR old.command_id=NEW.command_id OR old.revision=NEW.revision))
      BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_immutable_update BEFORE UPDATE ON campaign_catalog_receipts BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_immutable_delete BEFORE DELETE ON campaign_catalog_receipts BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_prevent_replace BEFORE INSERT ON campaign_catalog_receipts
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_receipts old WHERE old.campaign_id=NEW.campaign_id AND old.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_validate_result BEFORE INSERT ON campaign_catalog_receipts
      WHEN json_extract(NEW.result_json,'$.campaignId') IS NOT NEW.campaign_id
        OR json_extract(NEW.result_json,'$.commandId') IS NOT NEW.command_id
        OR json_extract(NEW.result_json,'$.revisionBefore') IS NOT NEW.revision_before
        OR json_extract(NEW.result_json,'$.revisionAfter') IS NOT NEW.revision_after
      BEGIN SELECT RAISE(ABORT,'campaign catalog receipt result is inconsistent'); END;
  `);
  db.prepare(`INSERT INTO rpg_content_pack_publications
    (pack_id,pack_version,validation_level,rules_engine,manifest_digest,manifest_json,provenance_json,
      validation_report_json,definition_count,definition_counts_json,published_by_principal_id,published_at)
    SELECT pack_id,pack_version,'legacy-v10',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM rpg_content_packs
    WHERE sealed=1 ORDER BY pack_id COLLATE BINARY,pack_version COLLATE BINARY`).run();
}

function canonicalV17(value: unknown): string {
  const sort = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sort)
    : entry !== null && typeof entry === "object" ? Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, sort(child)])) : entry;
  return JSON.stringify(sort(value));
}

function v17DefinitionDependencies(definition: any): { publicRefs: unknown[]; privateRefs: unknown[] } {
  const mechanics = definition.mechanics ?? {};
  switch (definition.reference?.kind) {
    case "race": return { publicRefs: mechanics.abilityRefs ?? [], privateRefs: [] };
    case "background": return { publicRefs: [...(mechanics.skillRefs ?? []), ...(mechanics.itemRefs ?? []), mechanics.startingCurrency?.currency].filter(Boolean), privateRefs: [] };
    case "class": return { publicRefs: mechanics.levelRefs ?? [], privateRefs: [] };
    case "class-level": return { publicRefs: [mechanics.classRef, ...(mechanics.abilityRefs ?? []), ...(mechanics.spellRefs ?? [])].filter(Boolean), privateRefs: [] };
    case "item": return { publicRefs: [mechanics.price?.currency].filter(Boolean), privateRefs: [] };
    case "enemy-template": return { publicRefs: mechanics.abilityRefs ?? [], privateRefs: [...(definition.private?.hiddenAbilityRefs ?? []), ...(definition.private?.hiddenRefs ?? [])] };
    default: return { publicRefs: [], privateRefs: [] };
  }
}

function v17Reachable(rows: Array<{ key: string; kind: string; publicRefs: any[]; privateRefs: any[] }>): Set<string> {
  const keyOf = (ref: any) => `${ref.kind}\0${ref.definitionId}`;
  const keys = new Set(rows.map((row) => row.key)), all = new Map<string,string[]>(), publicEdges = new Map<string,string[]>();
  const directPrivate = new Set<string>(), incoming = new Map<string,number>();
  for (const row of rows) {
    const pub = row.publicRefs.map(keyOf).filter((key) => keys.has(key));
    const priv = row.privateRefs.map(keyOf).filter((key) => keys.has(key));
    publicEdges.set(row.key,pub); all.set(row.key,[...pub,...priv]);
    for (const key of pub) incoming.set(key,(incoming.get(key) ?? 0)+1);
    for (const key of priv) directPrivate.add(key);
  }
  const privateClosure = new Set<string>(), pendingPrivate=[...directPrivate];
  while (pendingPrivate.length) { const key=pendingPrivate.shift()!; if (privateClosure.has(key)) continue;
    privateClosure.add(key); pendingPrivate.push(...(all.get(key) ?? [])); }
  const roots = rows.filter((row) => !privateClosure.has(row.key)
    && (["race","background","class","enemy-template"].includes(row.kind) || (incoming.get(row.key) ?? 0)===0)).map((row)=>row.key);
  const reachable = new Set<string>();
  while (roots.length) { const key=roots.shift()!; if (reachable.has(key)) continue; reachable.add(key); roots.push(...(publicEdges.get(key) ?? [])); }
  return reachable;
}

function createContentCatalogV17(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_catalog_publication_attestations (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      definition_count INTEGER NOT NULL CHECK (typeof(definition_count)='integer' AND definition_count BETWEEN 1 AND 1024),
      definition_counts_json TEXT NOT NULL CHECK (json_valid(definition_counts_json) AND json_type(definition_counts_json)='array'),
      publication_digest TEXT NOT NULL CHECK (length(publication_digest)=64 AND publication_digest NOT GLOB '*[^0-9a-f]*'),
      public_projection_digest TEXT NOT NULL CHECK (length(public_projection_digest)=64 AND public_projection_digest NOT GLOB '*[^0-9a-f]*'),
      public_projection_count INTEGER NOT NULL CHECK (public_projection_count=definition_count),
      PRIMARY KEY (pack_id,pack_version),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE TABLE rpg_catalog_definition_visibility (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, kind TEXT NOT NULL, definition_id TEXT NOT NULL,
      public_definition_json TEXT NOT NULL CHECK (json_valid(public_definition_json) AND json_type(public_definition_json)='object'),
      public_dependencies_json TEXT NOT NULL CHECK (json_valid(public_dependencies_json) AND json_type(public_dependencies_json)='array'),
      private_dependencies_json TEXT NOT NULL CHECK (json_valid(private_dependencies_json) AND json_type(private_dependencies_json)='array'),
      row_digest TEXT NOT NULL CHECK (length(row_digest)=64 AND row_digest NOT GLOB '*[^0-9a-f]*'),
      publicly_reachable INTEGER NOT NULL CHECK (publicly_reachable IN (0,1)),
      PRIMARY KEY (pack_id,pack_version,kind,definition_id),
      FOREIGN KEY (pack_id,pack_version,kind,definition_id)
        REFERENCES rpg_catalog_definitions(pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT
    );
    CREATE TABLE rpg_catalog_publication_submissions (
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL CHECK (length(request_digest)=64),
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
      created_at TEXT NOT NULL, PRIMARY KEY (principal_id,idempotency_key), UNIQUE (pack_id,pack_version),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE TABLE campaign_catalog_current_selections (
      campaign_id TEXT PRIMARY KEY, rules_profile_id TEXT NOT NULL, selection_digest TEXT NOT NULL CHECK (length(selection_digest)=64),
      configured_by_principal_id TEXT NOT NULL REFERENCES principals(id), configured_at TEXT NOT NULL,
      open_command_id TEXT NOT NULL,
      FOREIGN KEY (campaign_id,rules_profile_id) REFERENCES campaign_rules_profiles(campaign_id,rules_profile_id) ON DELETE CASCADE
    );
    CREATE TABLE campaign_catalog_current_pins (
      campaign_id TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, position INTEGER NOT NULL,
      open_command_id TEXT NOT NULL, PRIMARY KEY (campaign_id,pack_id), UNIQUE (campaign_id,position),
      FOREIGN KEY (campaign_id) REFERENCES campaign_catalog_current_selections(campaign_id) ON DELETE CASCADE,
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE TABLE campaign_catalog_commands (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, actor_principal_id TEXT NOT NULL REFERENCES principals(id),
      expected_revision INTEGER NOT NULL, request_digest TEXT NOT NULL CHECK (length(request_digest)=64),
      target_selection_digest TEXT NOT NULL CHECK (length(target_selection_digest)=64),
      requested_json TEXT NOT NULL CHECK (json_valid(requested_json)), created_at TEXT NOT NULL,
      PRIMARY KEY (campaign_id,command_id), UNIQUE (campaign_id,idempotency_key),
      UNIQUE (campaign_id,command_id,expected_revision,target_selection_digest)
    );
    CREATE TABLE campaign_catalog_events (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, event_id TEXT NOT NULL,
      revision_before INTEGER NOT NULL, revision INTEGER NOT NULL CHECK (revision=revision_before+1),
      occurred_at TEXT NOT NULL, public_data TEXT NOT NULL CHECK (json_valid(public_data)),
      PRIMARY KEY (campaign_id,event_id), UNIQUE (campaign_id,command_id), UNIQUE (campaign_id,revision),
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_catalog_commands(campaign_id,command_id) ON DELETE RESTRICT,
      UNIQUE (campaign_id,command_id,event_id,revision_before,revision)
    );
    CREATE TABLE campaign_catalog_receipts (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, event_id TEXT NOT NULL,
      revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL CHECK (revision_after=revision_before+1),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)), PRIMARY KEY (campaign_id,command_id),
      FOREIGN KEY (campaign_id,command_id,event_id,revision_before,revision_after)
        REFERENCES campaign_catalog_events(campaign_id,command_id,event_id,revision_before,revision) ON DELETE RESTRICT
    );
    CREATE TRIGGER rpg_catalog_attestations_immutable_update BEFORE UPDATE ON rpg_catalog_publication_attestations BEGIN SELECT RAISE(ABORT,'catalog attestations are immutable'); END;
    CREATE TRIGGER rpg_catalog_attestations_immutable_delete BEFORE DELETE ON rpg_catalog_publication_attestations BEGIN SELECT RAISE(ABORT,'catalog attestations are immutable'); END;
    CREATE TRIGGER rpg_catalog_attestations_prevent_replace BEFORE INSERT ON rpg_catalog_publication_attestations
      WHEN EXISTS (SELECT 1 FROM rpg_catalog_publication_attestations old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'catalog attestations are immutable'); END;
    CREATE TRIGGER rpg_catalog_attestations_validate_insert BEFORE INSERT ON rpg_catalog_publication_attestations
      WHEN NEW.definition_count<>(SELECT COUNT(*) FROM rpg_catalog_definitions definition
          WHERE definition.pack_id=NEW.pack_id AND definition.pack_version=NEW.pack_version)
        OR NEW.public_projection_count<>(SELECT COUNT(*) FROM rpg_catalog_definition_visibility visibility
          WHERE visibility.pack_id=NEW.pack_id AND visibility.pack_version=NEW.pack_version)
        OR NEW.publication_digest IS NOT (SELECT publication.manifest_digest FROM rpg_content_pack_publications publication
          WHERE publication.pack_id=NEW.pack_id AND publication.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'catalog attestation graph is inconsistent'); END;
    CREATE TRIGGER rpg_catalog_visibility_immutable_update BEFORE UPDATE ON rpg_catalog_definition_visibility BEGIN SELECT RAISE(ABORT,'catalog visibility is immutable'); END;
    CREATE TRIGGER rpg_catalog_visibility_immutable_delete BEFORE DELETE ON rpg_catalog_definition_visibility BEGIN SELECT RAISE(ABORT,'catalog visibility is immutable'); END;
    CREATE TRIGGER rpg_catalog_visibility_prevent_replace BEFORE INSERT ON rpg_catalog_definition_visibility
      WHEN EXISTS (SELECT 1 FROM rpg_catalog_definition_visibility old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id) BEGIN SELECT RAISE(ABORT,'catalog visibility is immutable'); END;
    CREATE TRIGGER rpg_catalog_visibility_validate_insert BEFORE INSERT ON rpg_catalog_definition_visibility
      WHEN json_extract(NEW.public_definition_json,'$.reference.packId') IS NOT NEW.pack_id
        OR json_extract(NEW.public_definition_json,'$.reference.packVersion') IS NOT NEW.pack_version
        OR json_extract(NEW.public_definition_json,'$.reference.kind') IS NOT NEW.kind
        OR json_extract(NEW.public_definition_json,'$.reference.definitionId') IS NOT NEW.definition_id
        OR json_type(NEW.public_definition_json,'$.private') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'catalog visibility identity is inconsistent'); END;
    CREATE TRIGGER rpg_catalog_submissions_immutable_update BEFORE UPDATE ON rpg_catalog_publication_submissions BEGIN SELECT RAISE(ABORT,'catalog submissions are immutable'); END;
    CREATE TRIGGER rpg_catalog_submissions_immutable_delete BEFORE DELETE ON rpg_catalog_publication_submissions BEGIN SELECT RAISE(ABORT,'catalog submissions are immutable'); END;
    CREATE TRIGGER rpg_catalog_submissions_prevent_replace BEFORE INSERT ON rpg_catalog_publication_submissions
      WHEN EXISTS (SELECT 1 FROM rpg_catalog_publication_submissions old WHERE old.principal_id=NEW.principal_id
        AND old.idempotency_key=NEW.idempotency_key) BEGIN SELECT RAISE(ABORT,'catalog submissions are immutable'); END;
    CREATE TRIGGER rpg_catalog_submissions_validate_insert BEFORE INSERT ON rpg_catalog_publication_submissions
      WHEN json_extract(NEW.receipt_json,'$.packId') IS NOT NEW.pack_id
        OR json_extract(NEW.receipt_json,'$.packVersion') IS NOT NEW.pack_version
      BEGIN SELECT RAISE(ABORT,'catalog submission receipt is inconsistent'); END;
    CREATE TRIGGER campaign_catalog_commands_require_owner_revision BEFORE INSERT ON campaign_catalog_commands
      WHEN EXISTS (SELECT 1 FROM campaign_administration_commands command WHERE command.campaign_id=NEW.campaign_id
          AND (command.command_id=NEW.command_id OR command.idempotency_key=NEW.idempotency_key))
        OR NOT EXISTS (SELECT 1 FROM campaigns campaign JOIN campaign_memberships membership
        ON membership.campaign_id=campaign.id AND membership.principal_id=NEW.actor_principal_id AND membership.role='owner'
        JOIN principals principal ON principal.id=membership.principal_id WHERE campaign.id=NEW.campaign_id
          AND campaign.owner_principal_id=NEW.actor_principal_id AND campaign.owner_role='owner'
          AND campaign.administration_revision=NEW.expected_revision
          AND (SELECT COUNT(*) FROM campaign_memberships owners WHERE owners.campaign_id=campaign.id AND owners.role='owner')=1)
      BEGIN SELECT RAISE(ABORT,'catalog command requires canonical owner at current revision'); END;
    CREATE TRIGGER campaign_catalog_selection_bind_insert BEFORE INSERT ON campaign_catalog_current_selections
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command JOIN campaigns campaign ON campaign.id=command.campaign_id
        WHERE command.campaign_id=NEW.campaign_id AND campaign.administration_revision=command.expected_revision+1
        AND command.command_id=NEW.open_command_id AND command.actor_principal_id=NEW.configured_by_principal_id
        AND command.target_selection_digest=NEW.selection_digest
        AND json_extract(command.requested_json,'$.rulesProfileId')=NEW.rules_profile_id
        AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
        AND NOT EXISTS (SELECT 1 FROM campaign_imported_administration_receipts receipt
          WHERE receipt.campaign_id=NEW.campaign_id AND receipt.source_command_id=NEW.open_command_id
            AND receipt.type='catalog_configured')
      BEGIN SELECT RAISE(ABORT,'catalog selection must bind one exact open command'); END;
    CREATE TRIGGER campaign_catalog_pin_bind_insert BEFORE INSERT ON campaign_catalog_current_pins
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_current_selections selection JOIN campaign_catalog_commands command
        ON command.campaign_id=selection.campaign_id AND command.command_id=selection.open_command_id
        JOIN campaigns campaign ON campaign.id=command.campaign_id
        WHERE selection.campaign_id=NEW.campaign_id AND NEW.open_command_id=command.command_id
          AND campaign.administration_revision=command.expected_revision+1
          AND EXISTS (SELECT 1 FROM json_each(command.requested_json,'$.contentPacks') requested_pin
            WHERE CAST(requested_pin.key AS INTEGER)=NEW.position
              AND json_extract(requested_pin.value,'$.packId')=NEW.pack_id
              AND json_extract(requested_pin.value,'$.packVersion')=NEW.pack_version)
          AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
        AND NOT EXISTS (SELECT 1 FROM campaign_catalog_current_selections selection
          JOIN campaign_imported_administration_receipts receipt ON receipt.campaign_id=selection.campaign_id
            AND receipt.source_command_id=selection.open_command_id AND receipt.type='catalog_configured'
          WHERE selection.campaign_id=NEW.campaign_id AND selection.open_command_id=NEW.open_command_id)
      BEGIN SELECT RAISE(ABORT,'catalog pin must bind one exact open command'); END;
    CREATE TRIGGER campaign_catalog_selection_bind_delete BEFORE DELETE ON campaign_catalog_current_selections
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command JOIN campaigns campaign ON campaign.id=command.campaign_id
        WHERE command.campaign_id=OLD.campaign_id AND campaign.administration_revision=command.expected_revision+1
          AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'catalog selection delete requires one exact open command'); END;
    CREATE TRIGGER campaign_catalog_pin_bind_delete BEFORE DELETE ON campaign_catalog_current_pins
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command JOIN campaigns campaign ON campaign.id=command.campaign_id
        WHERE command.campaign_id=OLD.campaign_id AND campaign.administration_revision=command.expected_revision+1
          AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'catalog pin delete requires one exact open command'); END;
    CREATE TRIGGER campaign_catalog_selection_prevent_update BEFORE UPDATE ON campaign_catalog_current_selections
      BEGIN SELECT RAISE(ABORT,'catalog current selection cannot update'); END;
    CREATE TRIGGER campaign_catalog_pin_prevent_update BEFORE UPDATE ON campaign_catalog_current_pins
      BEGIN SELECT RAISE(ABORT,'catalog current pins cannot update'); END;
    CREATE TRIGGER campaign_catalog_commands_immutable_update BEFORE UPDATE ON campaign_catalog_commands BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_commands_immutable_delete BEFORE DELETE ON campaign_catalog_commands BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_commands_prevent_replace BEFORE INSERT ON campaign_catalog_commands
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_commands old WHERE old.campaign_id=NEW.campaign_id
        AND (old.command_id=NEW.command_id OR old.idempotency_key=NEW.idempotency_key)) BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_immutable_update BEFORE UPDATE ON campaign_catalog_events BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_immutable_delete BEFORE DELETE ON campaign_catalog_events BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_prevent_replace BEFORE INSERT ON campaign_catalog_events
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_events old WHERE old.campaign_id=NEW.campaign_id
        AND (old.event_id=NEW.event_id OR old.command_id=NEW.command_id OR old.revision=NEW.revision)) BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_validate_provenance BEFORE INSERT ON campaign_catalog_events
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        JOIN campaigns campaign ON campaign.id=command.campaign_id
        JOIN campaign_catalog_current_selections selection ON selection.campaign_id=command.campaign_id
        WHERE command.campaign_id=NEW.campaign_id AND command.command_id=NEW.command_id
          AND command.expected_revision=NEW.revision_before AND NEW.revision=command.expected_revision+1
          AND campaign.administration_revision=NEW.revision
          AND selection.open_command_id=command.command_id
          AND selection.selection_digest=command.target_selection_digest
          AND selection.configured_by_principal_id=command.actor_principal_id
          AND selection.rules_profile_id=json_extract(command.requested_json,'$.rulesProfileId')
          AND (SELECT COUNT(*) FROM campaign_catalog_current_pins pin WHERE pin.campaign_id=command.campaign_id)
            =json_array_length(command.requested_json,'$.contentPacks')
          AND NOT EXISTS (SELECT 1 FROM json_each(command.requested_json,'$.contentPacks') requested_pin
            WHERE NOT EXISTS (SELECT 1 FROM campaign_catalog_current_pins pin
              WHERE pin.campaign_id=command.campaign_id AND pin.position=CAST(requested_pin.key AS INTEGER)
                AND pin.pack_id=json_extract(requested_pin.value,'$.packId')
                AND pin.pack_version=json_extract(requested_pin.value,'$.packVersion')))
          AND json_extract(NEW.public_data,'$.content.campaignId')=NEW.campaign_id
          AND json_extract(NEW.public_data,'$.content.rulesProfileId')=selection.rules_profile_id
          AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt
            WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
        OR EXISTS (SELECT 1 FROM campaign_administration_events event
          WHERE event.campaign_id=NEW.campaign_id AND event.revision=NEW.revision)
        OR EXISTS (SELECT 1 FROM campaign_imported_administration_events event
          WHERE event.campaign_id=NEW.campaign_id AND event.revision=NEW.revision)
      BEGIN SELECT RAISE(ABORT,'campaign catalog event provenance is inconsistent'); END;
    CREATE TRIGGER campaign_catalog_receipts_immutable_update BEFORE UPDATE ON campaign_catalog_receipts BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_immutable_delete BEFORE DELETE ON campaign_catalog_receipts BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_prevent_replace BEFORE INSERT ON campaign_catalog_receipts
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_receipts old WHERE old.campaign_id=NEW.campaign_id AND old.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_validate_result BEFORE INSERT ON campaign_catalog_receipts
      WHEN json_extract(NEW.result_json,'$.campaignId') IS NOT NEW.campaign_id
        OR json_extract(NEW.result_json,'$.commandId') IS NOT NEW.command_id
        OR json_extract(NEW.result_json,'$.idempotencyKey') IS NOT NEW.command_id
        OR json_extract(NEW.result_json,'$.revisionBefore') IS NOT NEW.revision_before
        OR json_extract(NEW.result_json,'$.revisionAfter') IS NOT NEW.revision_after
        OR NOT EXISTS (SELECT 1 FROM campaign_catalog_events event JOIN campaigns campaign ON campaign.id=event.campaign_id
          WHERE event.campaign_id=NEW.campaign_id AND event.command_id=NEW.command_id AND event.event_id=NEW.event_id
            AND event.revision_before=NEW.revision_before AND event.revision=NEW.revision_after
            AND campaign.administration_revision=NEW.revision_after
            AND json_extract(event.public_data,'$.content')=json_extract(NEW.result_json,'$.content'))
      BEGIN SELECT RAISE(ABORT,'campaign catalog receipt result is inconsistent'); END;
    CREATE TRIGGER campaign_administration_commands_reject_catalog_identity BEFORE INSERT ON campaign_administration_commands
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_commands command WHERE command.campaign_id=NEW.campaign_id
        AND (command.command_id=NEW.command_id OR command.idempotency_key=NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT,'campaign command identity already belongs to catalog history'); END;
    CREATE TRIGGER campaign_administration_events_reject_catalog_revision BEFORE INSERT ON campaign_administration_events
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_events event
        WHERE event.campaign_id=NEW.campaign_id AND event.revision=NEW.revision)
      BEGIN SELECT RAISE(ABORT,'campaign administration revision already belongs to catalog history'); END;
  `);

  const publications = db.prepare(`SELECT publication.*,pack.rules_profile_id FROM rpg_content_pack_publications publication
    JOIN rpg_content_packs pack ON pack.pack_id=publication.pack_id AND pack.pack_version=publication.pack_version
    WHERE publication.validation_level='validated-v1' ORDER BY publication.pack_id,publication.pack_version`).all() as any[];
  const insertVisibility = db.prepare(`INSERT INTO rpg_catalog_definition_visibility
    (pack_id,pack_version,kind,definition_id,public_definition_json,public_dependencies_json,private_dependencies_json,row_digest,publicly_reachable)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const publication of publications) {
    const definitions = db.prepare(`SELECT * FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? ORDER BY kind,definition_id`)
      .all(publication.pack_id, publication.pack_version) as any[];
    if (definitions.length === 0) throw new Error("schema v16 validated publication has no catalog definitions");
    const fullDefinitions=definitions.map((row)=>JSON.parse(row.definition_json));
    const migrationInput={idempotencyKey:"schema-v16-derived-validation",manifest:JSON.parse(publication.manifest_json),
      definitions:fullDefinitions};
    const report=validateContentCatalog(migrationInput);
    if(!report.valid||report.normalizedSummary.digest!==publication.manifest_digest)
      throw new Error("schema v16 validated publication graph is invalid");
    const visibility=deriveCatalogVisibility(fullDefinitions);
    for (const entry of visibility.rows) {
      insertVisibility.run(publication.pack_id,publication.pack_version,entry.definition.reference.kind,
        entry.definition.reference.definitionId,entry.publicDefinitionJson,entry.publicDependenciesJson,
        entry.privateDependenciesJson,entry.rowDigest,entry.publiclyReachable ? 1 : 0);
    }
    db.prepare(`INSERT INTO rpg_catalog_publication_attestations VALUES (?,?,?,?,?,?,?)`)
      .run(publication.pack_id,publication.pack_version,definitions.length,
        canonicalCatalogJson(report.normalizedSummary.counts),publication.manifest_digest,visibility.aggregateDigest,definitions.length);
    const key = `migrated-${publication.manifest_digest.slice(0, 32)}`;
    const receipt = canonicalV17({ packId: publication.pack_id, packVersion: publication.pack_version });
    db.prepare(`INSERT INTO rpg_catalog_publication_submissions VALUES (?,?,?,?,?,?,?)`)
      .run(publication.published_by_principal_id,key,publication.manifest_digest,publication.pack_id,publication.pack_version,receipt,publication.published_at);
  }
  const selections=db.prepare(`SELECT selection.*,campaign.administration_revision,campaign.updated_at,campaign.owner_principal_id
    FROM campaign_content_catalog_selections selection JOIN campaigns campaign ON campaign.id=selection.campaign_id
    ORDER BY selection.campaign_id`).all() as any[];
  for(const selection of selections){
    const pins=db.prepare(`SELECT pin.pack_id,pin.pack_version,publication.manifest_digest FROM campaign_content_catalog_pins pin
      JOIN rpg_content_pack_publications publication ON publication.pack_id=pin.pack_id AND publication.pack_version=pin.pack_version
      WHERE pin.campaign_id=? ORDER BY pin.position`).all(selection.campaign_id) as any[];
    if(!pins.length) throw new Error("schema v16 catalog selection has no pins");
    const commandId="migrated-v16-catalog", before=selection.administration_revision, after=before+1;
    const at=new Date(Math.max(Date.parse(selection.configured_at),Date.parse(selection.updated_at)+1)).toISOString();
    const request={rulesProfileId:selection.rules_profile_id,contentPacks:pins.map((pin)=>({packId:pin.pack_id,packVersion:pin.pack_version})),
      expectedRevision:before,idempotencyKey:commandId};
    const requestDigest=createHash("sha256").update(canonicalV17(request)).digest("hex");
    db.prepare(`INSERT INTO campaign_catalog_commands VALUES (?,?,?,?,?,?,?,?,?)`).run(selection.campaign_id,commandId,commandId,
      selection.owner_principal_id,before,requestDigest,selection.selection_digest,canonicalV17(request),at);
    db.prepare(`UPDATE campaigns SET administration_revision=?,updated_at=? WHERE id=?`).run(after,at,selection.campaign_id);
    db.prepare(`INSERT INTO campaign_catalog_current_selections VALUES (?,?,?,?,?,?)`).run(selection.campaign_id,
      selection.rules_profile_id,selection.selection_digest,selection.owner_principal_id,at,commandId);
    const insertPin=db.prepare(`INSERT INTO campaign_catalog_current_pins VALUES (?,?,?,?,?)`);
    pins.forEach((pin,index)=>insertPin.run(selection.campaign_id,pin.pack_id,pin.pack_version,index,commandId));
    const content={campaignId:selection.campaign_id,compatible:true,rulesProfileId:selection.rules_profile_id,
      contentPacks:pins.map((pin)=>({packId:pin.pack_id,packVersion:pin.pack_version,digest:pin.manifest_digest})),issues:[]};
    const receipt={campaignId:selection.campaign_id,commandId,idempotencyKey:commandId,revisionBefore:before,
      revisionAfter:after,configuredAt:at,content};
    db.prepare(`INSERT INTO campaign_catalog_events VALUES (?,?,?,?,?,?,?)`).run(selection.campaign_id,commandId,commandId,before,after,at,
      canonicalV17({content}));
    db.prepare(`INSERT INTO campaign_catalog_receipts VALUES (?,?,?,?,?,?)`).run(selection.campaign_id,commandId,commandId,before,after,canonicalV17(receipt));
  }
}

/** Additive v18 provenance closure for catalog commands. */
function createContentCatalogV18(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE campaign_catalog_command_provenance_v18 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL,
      proposed_event_id TEXT NOT NULL, proposed_event_type TEXT NOT NULL CHECK (proposed_event_type='catalog_configured'),
      actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      proposed_public_data TEXT NOT NULL CHECK (json_valid(proposed_public_data) AND json_type(proposed_public_data)='object'),
      proposed_result_json TEXT NOT NULL CHECK (json_valid(proposed_result_json) AND json_type(proposed_result_json)='object'),
      PRIMARY KEY (campaign_id,command_id), UNIQUE (campaign_id,proposed_event_id),
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_catalog_commands(campaign_id,command_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_catalog_command_provenance_v18_event
      ON campaign_catalog_command_provenance_v18(campaign_id,proposed_event_id);
    CREATE TRIGGER campaign_catalog_commands_validate_requested_v18 BEFORE INSERT ON campaign_catalog_commands
      WHEN json(NEW.requested_json)<>NEW.requested_json
        OR NEW.requested_json<>(SELECT json_object(
          'contentPacks',(SELECT json_group_array(json(item)) FROM (SELECT json_object(
            'packId',json_extract(pin.value,'$.packId'),'packVersion',json_extract(pin.value,'$.packVersion')) item
            FROM json_each(NEW.requested_json,'$.contentPacks') pin ORDER BY CAST(pin.key AS INTEGER))),
          'expectedRevision',NEW.expected_revision,'idempotencyKey',NEW.idempotency_key,
          'rulesProfileId',json_extract(NEW.requested_json,'$.rulesProfileId')))
        OR json_type(NEW.requested_json,'$.contentPacks')<>'array'
        OR json_array_length(NEW.requested_json,'$.contentPacks') NOT BETWEEN 1 AND 64
        OR json_extract(NEW.requested_json,'$.expectedRevision') IS NOT NEW.expected_revision
        OR json_extract(NEW.requested_json,'$.idempotencyKey') IS NOT NEW.idempotency_key
        OR json_type(NEW.requested_json,'$.rulesProfileId')<>'text'
        OR EXISTS (SELECT 1 FROM json_each(NEW.requested_json,'$.contentPacks') requested
          LEFT JOIN rpg_content_pack_publications publication
            ON publication.pack_id=json_extract(requested.value,'$.packId')
            AND publication.pack_version=json_extract(requested.value,'$.packVersion')
            AND publication.validation_level='validated-v1'
          LEFT JOIN rpg_content_packs pack ON pack.pack_id=publication.pack_id AND pack.pack_version=publication.pack_version
          WHERE publication.pack_id IS NULL OR pack.sealed<>1
            OR pack.rules_profile_id<>json_extract(NEW.requested_json,'$.rulesProfileId'))
        OR EXISTS (SELECT 1 FROM json_each(NEW.requested_json,'$.contentPacks') left_pin
          JOIN json_each(NEW.requested_json,'$.contentPacks') right_pin ON CAST(right_pin.key AS INTEGER)>CAST(left_pin.key AS INTEGER)
          WHERE json_extract(left_pin.value,'$.packId')>json_extract(right_pin.value,'$.packId')
            OR (json_extract(left_pin.value,'$.packId')=json_extract(right_pin.value,'$.packId')
              AND json_extract(left_pin.value,'$.packVersion')>=json_extract(right_pin.value,'$.packVersion')))
      BEGIN SELECT RAISE(ABORT,'catalog command requested pins are not canonical authoritative publications'); END;
    CREATE TRIGGER campaign_catalog_command_provenance_v18_validate BEFORE INSERT ON campaign_catalog_command_provenance_v18
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        WHERE command.campaign_id=NEW.campaign_id AND command.command_id=NEW.command_id
          AND command.actor_principal_id=NEW.actor_principal_id
          AND json(command.requested_json)=command.requested_json
          AND command.requested_json=(SELECT json_object(
            'contentPacks',(SELECT json_group_array(json(item)) FROM (SELECT json_object(
              'packId',json_extract(pin.value,'$.packId'),'packVersion',json_extract(pin.value,'$.packVersion')) item
              FROM json_each(command.requested_json,'$.contentPacks') pin ORDER BY CAST(pin.key AS INTEGER))),
            'expectedRevision',command.expected_revision,'idempotencyKey',command.idempotency_key,
            'rulesProfileId',json_extract(command.requested_json,'$.rulesProfileId')))
          AND json_array_length(command.requested_json,'$.contentPacks') BETWEEN 1 AND 64
          AND json_extract(command.requested_json,'$.expectedRevision')=command.expected_revision
          AND json_extract(command.requested_json,'$.idempotencyKey')=command.idempotency_key
          AND NOT EXISTS (SELECT 1 FROM json_each(command.requested_json,'$.contentPacks') requested
            LEFT JOIN rpg_content_pack_publications publication
              ON publication.pack_id=json_extract(requested.value,'$.packId')
              AND publication.pack_version=json_extract(requested.value,'$.packVersion')
              AND publication.validation_level='validated-v1'
            LEFT JOIN rpg_content_packs pack ON pack.pack_id=publication.pack_id AND pack.pack_version=publication.pack_version
            WHERE publication.pack_id IS NULL OR pack.sealed<>1
              OR pack.rules_profile_id<>json_extract(command.requested_json,'$.rulesProfileId'))
          AND NEW.proposed_event_type='catalog_configured'
          AND json(NEW.proposed_public_data)=NEW.proposed_public_data
          AND json(NEW.proposed_result_json)=NEW.proposed_result_json
          AND json_extract(NEW.proposed_public_data,'$.content.campaignId')=command.campaign_id
          AND json_extract(NEW.proposed_public_data,'$.content.compatible')=1
          AND json_extract(NEW.proposed_public_data,'$.content.rulesProfileId')=json_extract(command.requested_json,'$.rulesProfileId')
          AND json_type(NEW.proposed_public_data,'$.content.issues')='array'
          AND json_array_length(NEW.proposed_public_data,'$.content.issues')=0
          AND json_array_length(NEW.proposed_public_data,'$.content.contentPacks')=json_array_length(command.requested_json,'$.contentPacks')
          AND NOT EXISTS (SELECT 1 FROM json_each(command.requested_json,'$.contentPacks') requested
            JOIN rpg_content_pack_publications publication
              ON publication.pack_id=json_extract(requested.value,'$.packId')
              AND publication.pack_version=json_extract(requested.value,'$.packVersion')
            WHERE json_extract(NEW.proposed_public_data,'$.content.contentPacks['||requested.key||'].packId') IS NOT publication.pack_id
              OR json_extract(NEW.proposed_public_data,'$.content.contentPacks['||requested.key||'].packVersion') IS NOT publication.pack_version
              OR json_extract(NEW.proposed_public_data,'$.content.contentPacks['||requested.key||'].digest') IS NOT publication.manifest_digest)
          AND json_extract(NEW.proposed_result_json,'$.campaignId')=command.campaign_id
          AND json_extract(NEW.proposed_result_json,'$.commandId')=command.command_id
          AND json_extract(NEW.proposed_result_json,'$.idempotencyKey')=command.idempotency_key
          AND json_extract(NEW.proposed_result_json,'$.revisionBefore')=command.expected_revision
          AND json_extract(NEW.proposed_result_json,'$.revisionAfter')=command.expected_revision+1
          AND json_extract(NEW.proposed_result_json,'$.configuredAt')=command.created_at
          AND json_extract(NEW.proposed_result_json,'$.content')=json_extract(NEW.proposed_public_data,'$.content')
          AND NEW.proposed_public_data=(SELECT json_object('content',json_object(
            'campaignId',command.campaign_id,'compatible',json('true'),
            'contentPacks',(SELECT json_group_array(json(item)) FROM (SELECT json_object(
              'digest',publication.manifest_digest,'packId',publication.pack_id,'packVersion',publication.pack_version) item
              FROM json_each(command.requested_json,'$.contentPacks') requested
              JOIN rpg_content_pack_publications publication
                ON publication.pack_id=json_extract(requested.value,'$.packId')
                AND publication.pack_version=json_extract(requested.value,'$.packVersion')
              ORDER BY CAST(requested.key AS INTEGER))),
            'issues',json('[]'),'rulesProfileId',json_extract(command.requested_json,'$.rulesProfileId'))))
          AND NEW.proposed_result_json=(SELECT json_object(
            'campaignId',command.campaign_id,'commandId',command.command_id,'configuredAt',command.created_at,
            'content',json(json_extract(NEW.proposed_public_data,'$.content')),'idempotencyKey',command.idempotency_key,
            'revisionAfter',command.expected_revision+1,'revisionBefore',command.expected_revision)))
      BEGIN SELECT RAISE(ABORT,'catalog proposed event/result provenance is inconsistent'); END;
    CREATE TRIGGER campaign_catalog_command_provenance_v18_immutable_update BEFORE UPDATE ON campaign_catalog_command_provenance_v18
      BEGIN SELECT RAISE(ABORT,'catalog proposed provenance is immutable'); END;
    CREATE TRIGGER campaign_catalog_command_provenance_v18_immutable_delete BEFORE DELETE ON campaign_catalog_command_provenance_v18
      BEGIN SELECT RAISE(ABORT,'catalog proposed provenance is immutable'); END;
    CREATE TRIGGER campaign_catalog_command_provenance_v18_prevent_replace BEFORE INSERT ON campaign_catalog_command_provenance_v18
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_command_provenance_v18 old WHERE old.campaign_id=NEW.campaign_id
        AND (old.command_id=NEW.command_id OR old.proposed_event_id=NEW.proposed_event_id))
      BEGIN SELECT RAISE(ABORT,'catalog proposed provenance is immutable'); END;
    CREATE TRIGGER campaign_catalog_events_require_proposal_v18 BEFORE INSERT ON campaign_catalog_events
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_command_provenance_v18 proposal
        JOIN campaign_catalog_commands command ON command.campaign_id=proposal.campaign_id AND command.command_id=proposal.command_id
        WHERE proposal.campaign_id=NEW.campaign_id AND proposal.command_id=NEW.command_id
          AND proposal.proposed_event_id=NEW.event_id AND proposal.proposed_event_type='catalog_configured'
          AND proposal.actor_principal_id=command.actor_principal_id
          AND NEW.revision_before=command.expected_revision AND NEW.revision=command.expected_revision+1
          AND NEW.public_data=proposal.proposed_public_data)
      BEGIN SELECT RAISE(ABORT,'catalog event does not match its exact proposal'); END;
    CREATE TRIGGER campaign_catalog_receipts_require_proposal_v18 BEFORE INSERT ON campaign_catalog_receipts
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_command_provenance_v18 proposal
        WHERE proposal.campaign_id=NEW.campaign_id AND proposal.command_id=NEW.command_id
          AND proposal.proposed_event_id=NEW.event_id AND NEW.result_json=proposal.proposed_result_json)
      BEGIN SELECT RAISE(ABORT,'catalog receipt does not match its exact proposal'); END;
  `);
  const rows=db.prepare(`SELECT command.campaign_id,command.command_id,command.actor_principal_id,
      event.event_id,event.public_data,receipt.result_json
    FROM campaign_catalog_commands command
    LEFT JOIN campaign_catalog_events event ON event.campaign_id=command.campaign_id AND event.command_id=command.command_id
    LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
    ORDER BY command.campaign_id,command.command_id`).all() as any[];
  const insert=db.prepare(`INSERT INTO campaign_catalog_command_provenance_v18
    (campaign_id,command_id,proposed_event_id,proposed_event_type,actor_principal_id,proposed_public_data,proposed_result_json)
    VALUES (?,?,?,'catalog_configured',?,?,?)`);
  for(const row of rows){
    if(!row.event_id||!row.public_data||!row.result_json) throw new Error("schema v17 catalog audit is incomplete");
    insert.run(row.campaign_id,row.command_id,row.event_id,row.actor_principal_id,row.public_data,row.result_json);
  }
}

/** Additive v19r1 character-draft, final snapshot, and grant provenance. */
function createCharacterBuilderV19(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE character_drafts_v19 (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      persona_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      controller_principal_id TEXT NOT NULL,
      created_by_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('active','abandoned','finalized')),
      durability TEXT NOT NULL CHECK (durability IN ('durable','expiring')),
      expires_at TEXT CHECK ((durability='durable' AND expires_at IS NULL) OR
        (durability='expiring' AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at AND substr(expires_at,12,2) BETWEEN '00' AND '23')),
      revision INTEGER NOT NULL CHECK (typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      rules_profile_id TEXT NOT NULL REFERENCES rpg_rules_profiles(rules_profile_id) ON DELETE RESTRICT,
      allocation_json TEXT NOT NULL CHECK (json_valid(allocation_json) AND json_type(allocation_json)='object'),
      selections_json TEXT NOT NULL CHECK (json_valid(selections_json) AND json_type(selections_json)='object'),
      created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      CHECK (updated_at>=created_at),
      UNIQUE (campaign_id,id),
      FOREIGN KEY (campaign_id,controller_principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_character_drafts_v19_campaign ON character_drafts_v19(campaign_id,status,updated_at,id);
    CREATE INDEX idx_character_drafts_v19_controller ON character_drafts_v19(campaign_id,controller_principal_id,status);

    CREATE TABLE character_draft_pins_v19 (
      draft_id TEXT NOT NULL REFERENCES character_drafts_v19(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (typeof(position)='integer' AND position BETWEEN 0 AND 63),
      pack_id TEXT NOT NULL,
      pack_version TEXT NOT NULL,
      publication_digest TEXT NOT NULL CHECK (publication_digest GLOB '[0-9a-f]*' AND length(publication_digest)=64),
      PRIMARY KEY (draft_id,position), UNIQUE (draft_id,pack_id),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE INDEX idx_character_draft_pins_v19_publication ON character_draft_pins_v19(pack_id,pack_version);

    CREATE TABLE character_draft_commands_v19 (
      draft_id TEXT NOT NULL REFERENCES character_drafts_v19(id) ON DELETE RESTRICT,
      command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      type TEXT NOT NULL CHECK (type IN ('create','update','abandon','finalize')),
      expected_revision INTEGER NOT NULL CHECK (typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740991),
      requested_json TEXT NOT NULL CHECK (json_valid(requested_json) AND json_type(requested_json)='object'),
      request_digest TEXT NOT NULL CHECK (request_digest GLOB '[0-9a-f]*' AND length(request_digest)=64),
      created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY (draft_id,command_id),
      UNIQUE (campaign_id,actor_principal_id,idempotency_key),
      FOREIGN KEY (campaign_id,draft_id) REFERENCES character_drafts_v19(campaign_id,id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_character_draft_commands_v19_retry ON character_draft_commands_v19(campaign_id,actor_principal_id,idempotency_key);

    CREATE TABLE character_draft_events_v19 (
      draft_id TEXT NOT NULL, command_id TEXT NOT NULL, event_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('draft_created','draft_updated','draft_abandoned','draft_finalized')),
      revision_before INTEGER NOT NULL CHECK (typeof(revision_before)='integer' AND revision_before BETWEEN 0 AND 9007199254740991),
      revision INTEGER NOT NULL CHECK (typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      public_data TEXT NOT NULL CHECK (json_valid(public_data) AND json_type(public_data)='object'),
      PRIMARY KEY (draft_id,event_id), UNIQUE (draft_id,command_id),
      FOREIGN KEY (draft_id,command_id) REFERENCES character_draft_commands_v19(draft_id,command_id) ON DELETE RESTRICT
    );

    CREATE TABLE character_draft_receipts_v19 (
      draft_id TEXT NOT NULL, command_id TEXT NOT NULL, event_id TEXT NOT NULL,
      revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json)='object'),
      PRIMARY KEY (draft_id,command_id), UNIQUE (draft_id,event_id),
      FOREIGN KEY (draft_id,command_id) REFERENCES character_draft_commands_v19(draft_id,command_id) ON DELETE RESTRICT,
      FOREIGN KEY (draft_id,event_id) REFERENCES character_draft_events_v19(draft_id,event_id) ON DELETE RESTRICT
    );

    CREATE TABLE character_draft_revisions_v19 (
      draft_id TEXT NOT NULL REFERENCES character_drafts_v19(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK (typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      status TEXT NOT NULL CHECK (status IN ('active','abandoned','finalized')),
      snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
      command_id TEXT NOT NULL,
      PRIMARY KEY (draft_id,revision), UNIQUE (draft_id,command_id),
      FOREIGN KEY (draft_id,command_id) REFERENCES character_draft_commands_v19(draft_id,command_id) ON DELETE RESTRICT
    );

    CREATE TABLE character_derived_snapshots_v19 (
      draft_id TEXT PRIMARY KEY REFERENCES character_drafts_v19(id) ON DELETE RESTRICT,
      campaign_id TEXT NOT NULL, campaign_character_id TEXT NOT NULL UNIQUE,
      sheet_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL UNIQUE,
      calculator_version TEXT NOT NULL CHECK (calculator_version='velvet-character-derived-v1'),
      derived_json TEXT NOT NULL CHECK (json_valid(derived_json) AND json_type(derived_json)='object'),
      created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY (campaign_id,campaign_character_id) REFERENCES campaign_characters(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id,sheet_id,campaign_character_id) REFERENCES rpg_campaign_sheets(campaign_id,id,campaign_character_id) ON DELETE RESTRICT,
      FOREIGN KEY (campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT
    );

    CREATE TABLE character_starting_grants_v19 (
      draft_id TEXT NOT NULL REFERENCES character_derived_snapshots_v19(draft_id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK (typeof(position)='integer' AND position BETWEEN 0 AND 63),
      kind TEXT NOT NULL CHECK (kind IN ('item','currency')),
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, definition_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (typeof(amount)='integer' AND amount BETWEEN 0 AND 1000000),
      source TEXT NOT NULL CHECK (source IN ('background-kit','background-currency')),
      grant_json TEXT NOT NULL CHECK (json_valid(grant_json) AND json_type(grant_json)='object'),
      PRIMARY KEY (draft_id,position),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );

    CREATE TRIGGER character_drafts_v19_revision_guard BEFORE UPDATE ON character_drafts_v19
      WHEN OLD.status<>'active' OR NEW.revision<>OLD.revision+1
        OR NEW.id<>OLD.id OR NEW.campaign_id<>OLD.campaign_id OR NEW.persona_id<>OLD.persona_id
        OR NEW.controller_principal_id<>OLD.controller_principal_id OR NEW.created_by_principal_id<>OLD.created_by_principal_id
        OR NEW.durability<>OLD.durability OR NEW.expires_at IS NOT OLD.expires_at
        OR NEW.rules_profile_id<>OLD.rules_profile_id OR NEW.allocation_json<>OLD.allocation_json OR NEW.created_at<>OLD.created_at
        OR NEW.updated_at<OLD.updated_at
        OR NEW.status NOT IN ('active','abandoned','finalized')
      BEGIN SELECT RAISE(ABORT,'character draft must advance exactly once from active state'); END;
    CREATE TRIGGER character_drafts_v19_prevent_delete BEFORE DELETE ON character_drafts_v19
      BEGIN SELECT RAISE(ABORT,'character drafts are retained'); END;
    CREATE TRIGGER character_draft_pins_v19_immutable_update BEFORE UPDATE ON character_draft_pins_v19 BEGIN SELECT RAISE(ABORT,'character draft pins are immutable'); END;
    CREATE TRIGGER character_draft_pins_v19_immutable_delete BEFORE DELETE ON character_draft_pins_v19 BEGIN SELECT RAISE(ABORT,'character draft pins are immutable'); END;
    CREATE TRIGGER character_draft_pins_v19_prevent_replace BEFORE INSERT ON character_draft_pins_v19
      WHEN EXISTS (SELECT 1 FROM character_draft_pins_v19 old WHERE old.draft_id=NEW.draft_id AND (old.position=NEW.position OR old.pack_id=NEW.pack_id))
      BEGIN SELECT RAISE(ABORT,'character draft pins are immutable'); END;
    CREATE TRIGGER character_draft_commands_v19_immutable_update BEFORE UPDATE ON character_draft_commands_v19 BEGIN SELECT RAISE(ABORT,'character draft commands are immutable'); END;
    CREATE TRIGGER character_draft_commands_v19_immutable_delete BEFORE DELETE ON character_draft_commands_v19 BEGIN SELECT RAISE(ABORT,'character draft commands are immutable'); END;
    CREATE TRIGGER character_draft_events_v19_immutable_update BEFORE UPDATE ON character_draft_events_v19 BEGIN SELECT RAISE(ABORT,'character draft events are immutable'); END;
    CREATE TRIGGER character_draft_events_v19_immutable_delete BEFORE DELETE ON character_draft_events_v19 BEGIN SELECT RAISE(ABORT,'character draft events are immutable'); END;
    CREATE TRIGGER character_draft_receipts_v19_immutable_update BEFORE UPDATE ON character_draft_receipts_v19 BEGIN SELECT RAISE(ABORT,'character draft receipts are immutable'); END;
    CREATE TRIGGER character_draft_receipts_v19_immutable_delete BEFORE DELETE ON character_draft_receipts_v19 BEGIN SELECT RAISE(ABORT,'character draft receipts are immutable'); END;
    CREATE TRIGGER character_draft_revisions_v19_immutable_update BEFORE UPDATE ON character_draft_revisions_v19 BEGIN SELECT RAISE(ABORT,'character draft revisions are immutable'); END;
    CREATE TRIGGER character_draft_revisions_v19_immutable_delete BEFORE DELETE ON character_draft_revisions_v19 BEGIN SELECT RAISE(ABORT,'character draft revisions are immutable'); END;
    CREATE TRIGGER character_derived_snapshots_v19_immutable_update BEFORE UPDATE ON character_derived_snapshots_v19 BEGIN SELECT RAISE(ABORT,'derived character snapshots are immutable'); END;
    CREATE TRIGGER character_derived_snapshots_v19_immutable_delete BEFORE DELETE ON character_derived_snapshots_v19 BEGIN SELECT RAISE(ABORT,'derived character snapshots are immutable'); END;
    CREATE TRIGGER character_starting_grants_v19_immutable_update BEFORE UPDATE ON character_starting_grants_v19 BEGIN SELECT RAISE(ABORT,'starting grants are immutable'); END;
    CREATE TRIGGER character_starting_grants_v19_immutable_delete BEFORE DELETE ON character_starting_grants_v19 BEGIN SELECT RAISE(ABORT,'starting grants are immutable'); END;
  `);
}

/** Additive v20r1 closure for exact draft command/event/receipt provenance. */
function createCharacterBuilderProvenanceV20(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE character_draft_command_provenance_v20 (
      draft_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      actor_principal_id TEXT NOT NULL,
      proposed_event_id TEXT NOT NULL CHECK (length(proposed_event_id) BETWEEN 1 AND 128 AND proposed_event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      proposed_event_type TEXT NOT NULL CHECK (proposed_event_type IN ('draft_created','draft_updated','draft_abandoned','draft_finalized')),
      proposed_event_json TEXT NOT NULL CHECK (json_valid(proposed_event_json) AND json_type(proposed_event_json)='object'),
      proposed_result_json TEXT NOT NULL CHECK (json_valid(proposed_result_json) AND json_type(proposed_result_json)='object'),
      PRIMARY KEY (draft_id,command_id), UNIQUE (draft_id,proposed_event_id),
      FOREIGN KEY (draft_id,command_id) REFERENCES character_draft_commands_v19(draft_id,command_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_character_draft_command_provenance_v20_campaign
      ON character_draft_command_provenance_v20(campaign_id,actor_principal_id,command_id);

    CREATE TABLE character_draft_campaign_deletions_v20 (
      campaign_id TEXT PRIMARY KEY CHECK (length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*')
    );
    CREATE TABLE character_builder_layout_attestation_v20 (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      layout_digest TEXT NOT NULL CHECK (length(layout_digest)=64 AND layout_digest GLOB '[0-9a-f]*')
    );

    CREATE TRIGGER character_draft_command_provenance_v20_validate BEFORE INSERT ON character_draft_command_provenance_v20
      WHEN json(NEW.proposed_event_json)<>NEW.proposed_event_json OR json(NEW.proposed_result_json)<>NEW.proposed_result_json
        OR NOT EXISTS (SELECT 1 FROM character_draft_commands_v19 command
          JOIN character_drafts_v19 draft ON draft.id=command.draft_id AND draft.campaign_id=command.campaign_id
          WHERE command.draft_id=NEW.draft_id AND command.command_id=NEW.command_id
            AND command.campaign_id=NEW.campaign_id AND command.actor_principal_id=NEW.actor_principal_id
            AND json(command.requested_json)=command.requested_json
            AND json_extract(command.requested_json,'$.idempotencyKey')=command.idempotency_key
            AND (command.type='create' OR json_extract(command.requested_json,'$.expectedRevision')=command.expected_revision)
            AND NEW.proposed_event_type=CASE command.type WHEN 'create' THEN 'draft_created' WHEN 'update' THEN 'draft_updated'
              WHEN 'abandon' THEN 'draft_abandoned' WHEN 'finalize' THEN 'draft_finalized' END
            AND json_extract(NEW.proposed_event_json,'$.actorPrincipalId')=command.actor_principal_id
            AND json_extract(NEW.proposed_event_json,'$.campaignId')=command.campaign_id
            AND json_extract(NEW.proposed_event_json,'$.commandId')=command.command_id
            AND json_extract(NEW.proposed_event_json,'$.draftId')=command.draft_id
            AND json_extract(NEW.proposed_event_json,'$.eventId')=NEW.proposed_event_id
            AND json_extract(NEW.proposed_event_json,'$.occurredAt')=command.created_at
            AND json_extract(NEW.proposed_event_json,'$.type')=NEW.proposed_event_type
            AND json_extract(NEW.proposed_event_json,'$.revisionBefore')=command.expected_revision
            AND json_extract(NEW.proposed_event_json,'$.revision')=CASE command.type WHEN 'create' THEN command.expected_revision ELSE command.expected_revision+1 END
            AND json_extract(NEW.proposed_event_json,'$.publicData.draftId')=command.draft_id
            AND json_extract(NEW.proposed_event_json,'$.publicData.revision')=json_extract(NEW.proposed_event_json,'$.revision')
            AND json_extract(NEW.proposed_event_json,'$.publicData.status')=CASE command.type WHEN 'abandon' THEN 'abandoned'
              WHEN 'finalize' THEN 'finalized' ELSE 'active' END
            AND json_extract(NEW.proposed_result_json,'$.draft.id')=command.draft_id
            AND json_extract(NEW.proposed_result_json,'$.draft.campaignId')=command.campaign_id
            AND json_extract(NEW.proposed_result_json,'$.draft.revision')=json_extract(NEW.proposed_event_json,'$.revision')
            AND json_extract(NEW.proposed_result_json,'$.draft.status')=json_extract(NEW.proposed_event_json,'$.publicData.status')
            AND json_extract(NEW.proposed_result_json,'$.receipt.draftId')=command.draft_id
            AND json_extract(NEW.proposed_result_json,'$.receipt.commandId')=command.command_id
            AND json_extract(NEW.proposed_result_json,'$.receipt.idempotencyKey')=command.idempotency_key
            AND json_extract(NEW.proposed_result_json,'$.receipt.revisionBefore')=command.expected_revision
            AND json_extract(NEW.proposed_result_json,'$.receipt.revisionAfter')=json_extract(NEW.proposed_event_json,'$.revision')
            AND json_extract(NEW.proposed_result_json,'$.receipt.occurredAt')=command.created_at
            AND (command.type='finalize' OR json_extract(NEW.proposed_result_json,'$.receipt.type')=command.type)
            AND (command.type<>'finalize' OR json_extract(NEW.proposed_result_json,'$.receipt.eventId')=NEW.proposed_event_id))
      BEGIN SELECT RAISE(ABORT,'character draft proposal is inconsistent'); END;
    CREATE TRIGGER character_draft_command_provenance_v20_immutable_update BEFORE UPDATE ON character_draft_command_provenance_v20
      BEGIN SELECT RAISE(ABORT,'character draft proposals are immutable'); END;
    CREATE TRIGGER character_draft_command_provenance_v20_immutable_delete BEFORE DELETE ON character_draft_command_provenance_v20
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'character draft proposals are immutable'); END;
    CREATE TRIGGER character_draft_command_provenance_v20_prevent_replace BEFORE INSERT ON character_draft_command_provenance_v20
      WHEN EXISTS (SELECT 1 FROM character_draft_command_provenance_v20 old WHERE old.draft_id=NEW.draft_id
        AND (old.command_id=NEW.command_id OR old.proposed_event_id=NEW.proposed_event_id))
      BEGIN SELECT RAISE(ABORT,'character draft proposals are immutable'); END;

    CREATE TRIGGER character_draft_events_require_proposal_v20 BEFORE INSERT ON character_draft_events_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_command_provenance_v20 proposal
        JOIN character_draft_commands_v19 command ON command.draft_id=proposal.draft_id AND command.command_id=proposal.command_id
        JOIN character_drafts_v19 draft ON draft.id=command.draft_id AND draft.campaign_id=command.campaign_id
        WHERE proposal.draft_id=NEW.draft_id AND proposal.command_id=NEW.command_id
          AND proposal.proposed_event_id=NEW.event_id AND proposal.proposed_event_type=NEW.type
          AND NEW.occurred_at=command.created_at AND NEW.revision_before=command.expected_revision
          AND NEW.revision=CASE command.type WHEN 'create' THEN command.expected_revision ELSE command.expected_revision+1 END
          AND draft.revision=NEW.revision
          AND draft.status=CASE command.type WHEN 'abandon' THEN 'abandoned' WHEN 'finalize' THEN 'finalized' ELSE 'active' END
          AND NEW.public_data=json_object('draftId',NEW.draft_id,'revision',NEW.revision,'status',draft.status)
          AND proposal.proposed_event_json=json_object(
            'actorPrincipalId',command.actor_principal_id,'campaignId',command.campaign_id,'commandId',command.command_id,
            'draftId',command.draft_id,'eventId',NEW.event_id,'occurredAt',NEW.occurred_at,'publicData',json(NEW.public_data),
            'revision',NEW.revision,'revisionBefore',NEW.revision_before,'type',NEW.type))
      BEGIN SELECT RAISE(ABORT,'character draft event does not match its exact proposal'); END;
    CREATE TRIGGER character_draft_receipts_require_proposal_v20 BEFORE INSERT ON character_draft_receipts_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_command_provenance_v20 proposal
        JOIN character_draft_events_v19 event ON event.draft_id=proposal.draft_id AND event.command_id=proposal.command_id
        WHERE proposal.draft_id=NEW.draft_id AND proposal.command_id=NEW.command_id
          AND proposal.proposed_event_id=NEW.event_id AND event.event_id=NEW.event_id
          AND NEW.revision_before=event.revision_before AND NEW.revision_after=event.revision
          AND NEW.result_json=proposal.proposed_result_json)
      BEGIN SELECT RAISE(ABORT,'character draft receipt does not match its exact proposal'); END;

    DROP TRIGGER character_drafts_v19_prevent_delete;
    DROP TRIGGER character_draft_pins_v19_immutable_delete;
    DROP TRIGGER character_draft_commands_v19_immutable_delete;
    DROP TRIGGER character_draft_events_v19_immutable_delete;
    DROP TRIGGER character_draft_receipts_v19_immutable_delete;
    DROP TRIGGER character_draft_revisions_v19_immutable_delete;
    DROP TRIGGER character_derived_snapshots_v19_immutable_delete;
    DROP TRIGGER character_starting_grants_v19_immutable_delete;
    DROP TRIGGER campaign_content_catalog_selections_immutable_delete;
    DROP TRIGGER campaign_content_catalog_pins_immutable_delete;
    DROP TRIGGER campaign_catalog_selection_bind_delete;
    DROP TRIGGER campaign_catalog_pin_bind_delete;
    DROP TRIGGER campaign_catalog_commands_immutable_delete;
    DROP TRIGGER campaign_catalog_events_immutable_delete;
    DROP TRIGGER campaign_catalog_receipts_immutable_delete;
    DROP TRIGGER campaign_catalog_command_provenance_v18_immutable_delete;

    CREATE TRIGGER character_drafts_v19_prevent_delete BEFORE DELETE ON character_drafts_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'character drafts are retained'); END;
    CREATE TRIGGER character_draft_pins_v19_immutable_delete BEFORE DELETE ON character_draft_pins_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker
        JOIN character_drafts_v19 draft ON draft.id=OLD.draft_id AND draft.campaign_id=marker.campaign_id)
      BEGIN SELECT RAISE(ABORT,'character draft pins are immutable'); END;
    CREATE TRIGGER character_draft_commands_v19_immutable_delete BEFORE DELETE ON character_draft_commands_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'character draft commands are immutable'); END;
    CREATE TRIGGER character_draft_events_v19_immutable_delete BEFORE DELETE ON character_draft_events_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker
        JOIN character_drafts_v19 draft ON draft.id=OLD.draft_id AND draft.campaign_id=marker.campaign_id)
      BEGIN SELECT RAISE(ABORT,'character draft events are immutable'); END;
    CREATE TRIGGER character_draft_receipts_v19_immutable_delete BEFORE DELETE ON character_draft_receipts_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker
        JOIN character_drafts_v19 draft ON draft.id=OLD.draft_id AND draft.campaign_id=marker.campaign_id)
      BEGIN SELECT RAISE(ABORT,'character draft receipts are immutable'); END;
    CREATE TRIGGER character_draft_revisions_v19_immutable_delete BEFORE DELETE ON character_draft_revisions_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker
        JOIN character_drafts_v19 draft ON draft.id=OLD.draft_id AND draft.campaign_id=marker.campaign_id)
      BEGIN SELECT RAISE(ABORT,'character draft revisions are immutable'); END;
    CREATE TRIGGER character_derived_snapshots_v19_immutable_delete BEFORE DELETE ON character_derived_snapshots_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'derived character snapshots are immutable'); END;
    CREATE TRIGGER character_starting_grants_v19_immutable_delete BEFORE DELETE ON character_starting_grants_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker
        JOIN character_drafts_v19 draft ON draft.id=OLD.draft_id AND draft.campaign_id=marker.campaign_id)
      BEGIN SELECT RAISE(ABORT,'starting grants are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_selections_immutable_delete BEFORE DELETE ON campaign_content_catalog_selections
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign catalog selections are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_pins_immutable_delete BEFORE DELETE ON campaign_content_catalog_pins
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign catalog pins are immutable'); END;
    CREATE TRIGGER campaign_catalog_selection_bind_delete BEFORE DELETE ON campaign_catalog_current_selections
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
        AND NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command JOIN campaigns campaign ON campaign.id=command.campaign_id
          WHERE command.campaign_id=OLD.campaign_id AND campaign.administration_revision=command.expected_revision+1
            AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'catalog selection delete requires one exact open command'); END;
    CREATE TRIGGER campaign_catalog_pin_bind_delete BEFORE DELETE ON campaign_catalog_current_pins
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
        AND NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command JOIN campaigns campaign ON campaign.id=command.campaign_id
          WHERE command.campaign_id=OLD.campaign_id AND campaign.administration_revision=command.expected_revision+1
            AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'catalog pin delete requires one exact open command'); END;
    CREATE TRIGGER campaign_catalog_commands_immutable_delete BEFORE DELETE ON campaign_catalog_commands
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_immutable_delete BEFORE DELETE ON campaign_catalog_events
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_immutable_delete BEFORE DELETE ON campaign_catalog_receipts
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_command_provenance_v18_immutable_delete BEFORE DELETE ON campaign_catalog_command_provenance_v18
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_campaign_deletions_v20 marker WHERE marker.campaign_id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'catalog proposed provenance is immutable'); END;

    CREATE TRIGGER campaigns_delete_character_drafts_v20 BEFORE DELETE ON campaigns
      BEGIN
        INSERT INTO character_draft_campaign_deletions_v20(campaign_id) VALUES (OLD.id);
        DELETE FROM character_starting_grants_v19 WHERE draft_id IN (SELECT id FROM character_drafts_v19 WHERE campaign_id=OLD.id);
        DELETE FROM character_derived_snapshots_v19 WHERE campaign_id=OLD.id;
        DELETE FROM character_draft_revisions_v19 WHERE draft_id IN (SELECT id FROM character_drafts_v19 WHERE campaign_id=OLD.id);
        DELETE FROM character_draft_receipts_v19 WHERE draft_id IN (SELECT id FROM character_drafts_v19 WHERE campaign_id=OLD.id);
        DELETE FROM character_draft_events_v19 WHERE draft_id IN (SELECT id FROM character_drafts_v19 WHERE campaign_id=OLD.id);
        DELETE FROM character_draft_command_provenance_v20 WHERE campaign_id=OLD.id;
        DELETE FROM character_draft_commands_v19 WHERE campaign_id=OLD.id;
        DELETE FROM character_draft_pins_v19 WHERE draft_id IN (SELECT id FROM character_drafts_v19 WHERE campaign_id=OLD.id);
        DELETE FROM character_drafts_v19 WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_receipts WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_events WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_command_provenance_v18 WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_commands WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_current_pins WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_current_selections WHERE campaign_id=OLD.id;
        DELETE FROM campaign_content_catalog_pins WHERE campaign_id=OLD.id;
        DELETE FROM campaign_content_catalog_selections WHERE campaign_id=OLD.id;
      END;
    CREATE TRIGGER campaigns_clear_character_draft_deletion_v20 AFTER DELETE ON campaigns
      BEGIN DELETE FROM character_draft_campaign_deletions_v20 WHERE campaign_id=OLD.id; END;
    CREATE TRIGGER character_draft_campaign_deletions_v20_validate BEFORE INSERT ON character_draft_campaign_deletions_v20
      WHEN NOT EXISTS (SELECT 1 FROM campaigns WHERE id=NEW.campaign_id)
      BEGIN SELECT RAISE(ABORT,'character draft campaign deletion marker is invalid'); END;
    CREATE TRIGGER character_draft_campaign_deletions_v20_immutable_update BEFORE UPDATE ON character_draft_campaign_deletions_v20
      BEGIN SELECT RAISE(ABORT,'character draft campaign deletion marker is immutable'); END;
    CREATE TRIGGER character_draft_campaign_deletions_v20_guard_delete BEFORE DELETE ON character_draft_campaign_deletions_v20
      WHEN EXISTS (SELECT 1 FROM campaigns WHERE id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'character draft campaign deletion marker is campaign-owned'); END;
    CREATE TRIGGER character_builder_layout_attestation_v20_immutable_update BEFORE UPDATE ON character_builder_layout_attestation_v20
      BEGIN SELECT RAISE(ABORT,'character builder layout attestation is immutable'); END;
    CREATE TRIGGER character_builder_layout_attestation_v20_immutable_delete BEFORE DELETE ON character_builder_layout_attestation_v20
      BEGIN SELECT RAISE(ABORT,'character builder layout attestation is immutable'); END;
  `);
  sealCharacterBuilderLayoutV20(db);
}

/**
 * Additive v21r1 closure. The legacy v20 marker table cannot be removed
 * without a destructive migration, so v21 makes it permanently inert and
 * forbids physical campaign deletion. Campaign lifecycle uses archive.
 */
function createCharacterBuilderIntegrityV21(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE UNIQUE INDEX uq_character_draft_commands_v21_revision ON character_draft_commands_v19(
      draft_id, CASE type WHEN 'create' THEN expected_revision ELSE expected_revision+1 END);
    CREATE UNIQUE INDEX uq_character_draft_events_v21_revision ON character_draft_events_v19(draft_id,revision);
    CREATE UNIQUE INDEX uq_character_draft_receipts_v21_revision ON character_draft_receipts_v19(draft_id,revision_after);
    CREATE UNIQUE INDEX uq_character_draft_proposals_v21_revision ON character_draft_command_provenance_v20(
      draft_id,CAST(json_extract(proposed_event_json,'$.revision') AS INTEGER));

    CREATE TRIGGER campaigns_require_repository_delete_v21 BEFORE DELETE ON campaigns
      WHEN velvet_campaign_delete_authorized(OLD.id)<>1
      BEGIN SELECT RAISE(ABORT,'physical campaign deletion requires repository authorization'); END;
    CREATE TRIGGER character_draft_campaign_deletions_v21_forbid_insert
      BEFORE INSERT ON character_draft_campaign_deletions_v20
      WHEN velvet_campaign_delete_authorized(NEW.campaign_id)<>1
      BEGIN SELECT RAISE(ABORT,'character draft deletion capability is disabled'); END;
    CREATE TRIGGER character_draft_campaign_deletions_v21_forbid_update
      BEFORE UPDATE ON character_draft_campaign_deletions_v20
      WHEN velvet_campaign_delete_authorized(OLD.campaign_id)<>1
      BEGIN SELECT RAISE(ABORT,'character draft deletion capability is disabled'); END;
    CREATE TRIGGER character_draft_campaign_deletions_v21_forbid_delete
      BEFORE DELETE ON character_draft_campaign_deletions_v20
      WHEN velvet_campaign_delete_authorized(OLD.campaign_id)<>1
      BEGIN SELECT RAISE(ABORT,'character draft deletion capability is disabled'); END;

    CREATE TRIGGER character_draft_events_require_proposal_v21 BEFORE INSERT ON character_draft_events_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_command_provenance_v20 proposal
        JOIN character_draft_commands_v19 command ON command.draft_id=proposal.draft_id AND command.command_id=proposal.command_id
        JOIN character_drafts_v19 draft ON draft.id=command.draft_id AND draft.campaign_id=command.campaign_id
        JOIN character_draft_revisions_v19 history ON history.draft_id=command.draft_id AND history.command_id=command.command_id
          AND history.revision=NEW.revision
        WHERE proposal.draft_id=NEW.draft_id AND proposal.command_id=NEW.command_id
          AND proposal.proposed_event_id=NEW.event_id AND proposal.proposed_event_type=NEW.type
          AND NEW.occurred_at=command.created_at AND NEW.revision_before=command.expected_revision
          AND NEW.revision=CASE command.type WHEN 'create' THEN command.expected_revision ELSE command.expected_revision+1 END
          AND draft.revision=NEW.revision AND history.status=draft.status
          AND history.snapshot_json=proposal.proposed_result_json->>'$.draft'
          AND draft.status=CASE command.type WHEN 'abandon' THEN 'abandoned' WHEN 'finalize' THEN 'finalized' ELSE 'active' END
          AND NEW.public_data=json_object('draftId',NEW.draft_id,'revision',NEW.revision,'status',draft.status)
          AND proposal.proposed_event_json=json_object(
            'actorPrincipalId',command.actor_principal_id,'campaignId',command.campaign_id,'commandId',command.command_id,
            'draftId',command.draft_id,'eventId',NEW.event_id,'occurredAt',NEW.occurred_at,'publicData',json(NEW.public_data),
            'revision',NEW.revision,'revisionBefore',NEW.revision_before,'type',NEW.type))
      BEGIN SELECT RAISE(ABORT,'character draft event does not match its exact revision proposal'); END;
    CREATE TRIGGER character_draft_receipts_require_proposal_v21 BEFORE INSERT ON character_draft_receipts_v19
      WHEN NOT EXISTS (SELECT 1 FROM character_draft_command_provenance_v20 proposal
        JOIN character_draft_events_v19 event ON event.draft_id=proposal.draft_id AND event.command_id=proposal.command_id
        JOIN character_draft_revisions_v19 history ON history.draft_id=proposal.draft_id AND history.command_id=proposal.command_id
          AND history.revision=event.revision
        WHERE proposal.draft_id=NEW.draft_id AND proposal.command_id=NEW.command_id
          AND proposal.proposed_event_id=NEW.event_id AND event.event_id=NEW.event_id
          AND NEW.revision_before=event.revision_before AND NEW.revision_after=event.revision
          AND history.snapshot_json=proposal.proposed_result_json->>'$.draft'
          AND NEW.result_json=proposal.proposed_result_json)
      BEGIN SELECT RAISE(ABORT,'character draft receipt does not match its exact revision proposal'); END;

    CREATE TABLE character_builder_layout_attestation_v21 (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      layout_digest TEXT NOT NULL CHECK (length(layout_digest)=64 AND layout_digest GLOB '[0-9a-f]*')
    );
    CREATE TRIGGER character_builder_layout_attestation_v21_immutable_update BEFORE UPDATE ON character_builder_layout_attestation_v21
      BEGIN SELECT RAISE(ABORT,'character builder v21 layout attestation is immutable'); END;
    CREATE TRIGGER character_builder_layout_attestation_v21_immutable_delete BEFORE DELETE ON character_builder_layout_attestation_v21
      BEGIN SELECT RAISE(ABORT,'character builder v21 layout attestation is immutable'); END;
  `);
  sealCharacterBuilderLayoutV21(db);
}

/** Additive v22r1 makes the legacy deletion capability inert without dropping prior DDL. */
function createCharacterBuilderIntegrityV22(db:DatabaseDriver.Database):void{
  db.exec(`
    CREATE TRIGGER campaigns_prevent_physical_delete_v22 BEFORE DELETE ON campaigns
      BEGIN SELECT RAISE(ABORT,'campaigns are archived, not physically deleted'); END;

    CREATE TRIGGER character_draft_campaign_deletions_v22_inert_insert BEFORE INSERT ON character_draft_campaign_deletions_v20
      BEGIN SELECT RAISE(ABORT,'character draft deletion marker is inert'); END;
    CREATE TRIGGER character_draft_campaign_deletions_v22_inert_update BEFORE UPDATE ON character_draft_campaign_deletions_v20
      BEGIN SELECT RAISE(ABORT,'character draft deletion marker is inert'); END;
    CREATE TRIGGER character_draft_campaign_deletions_v22_inert_delete BEFORE DELETE ON character_draft_campaign_deletions_v20
      BEGIN SELECT RAISE(ABORT,'character draft deletion marker is inert'); END;

    CREATE TRIGGER character_drafts_v22_retain_delete BEFORE DELETE ON character_drafts_v19
      BEGIN SELECT RAISE(ABORT,'character drafts are retained'); END;
    CREATE TRIGGER character_draft_pins_v22_retain_delete BEFORE DELETE ON character_draft_pins_v19
      BEGIN SELECT RAISE(ABORT,'character draft pins are immutable'); END;
    CREATE TRIGGER character_draft_commands_v22_retain_delete BEFORE DELETE ON character_draft_commands_v19
      BEGIN SELECT RAISE(ABORT,'character draft commands are immutable'); END;
    CREATE TRIGGER character_draft_events_v22_retain_delete BEFORE DELETE ON character_draft_events_v19
      BEGIN SELECT RAISE(ABORT,'character draft events are immutable'); END;
    CREATE TRIGGER character_draft_receipts_v22_retain_delete BEFORE DELETE ON character_draft_receipts_v19
      BEGIN SELECT RAISE(ABORT,'character draft receipts are immutable'); END;
    CREATE TRIGGER character_draft_revisions_v22_retain_delete BEFORE DELETE ON character_draft_revisions_v19
      BEGIN SELECT RAISE(ABORT,'character draft revisions are immutable'); END;
    CREATE TRIGGER character_derived_snapshots_v22_retain_delete BEFORE DELETE ON character_derived_snapshots_v19
      BEGIN SELECT RAISE(ABORT,'derived character snapshots are immutable'); END;
    CREATE TRIGGER character_starting_grants_v22_retain_delete BEFORE DELETE ON character_starting_grants_v19
      BEGIN SELECT RAISE(ABORT,'starting grants are immutable'); END;
    CREATE TRIGGER character_draft_command_provenance_v22_retain_delete BEFORE DELETE ON character_draft_command_provenance_v20
      BEGIN SELECT RAISE(ABORT,'character draft proposals are immutable'); END;

    CREATE TABLE character_builder_layout_attestation_v22 (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      layout_digest TEXT NOT NULL CHECK (length(layout_digest)=64 AND layout_digest GLOB '[0-9a-f]*')
    );
    CREATE TRIGGER character_builder_layout_attestation_v22_immutable_update BEFORE UPDATE ON character_builder_layout_attestation_v22
      BEGIN SELECT RAISE(ABORT,'character builder v22 layout attestation is immutable'); END;
    CREATE TRIGGER character_builder_layout_attestation_v22_immutable_delete BEFORE DELETE ON character_builder_layout_attestation_v22
      BEGIN SELECT RAISE(ABORT,'character builder v22 layout attestation is immutable'); END;
  `);
  sealCharacterBuilderLayoutV22(db);
}

/** Additive v23r1 single-class progression ledger and immutable audit graph. */
function createCharacterProgressionV23(db:DatabaseDriver.Database):void{
  db.exec(`
    CREATE TABLE rpg_progression_profiles_v23 (
      profile_id TEXT PRIMARY KEY CHECK(length(profile_id) BETWEEN 1 AND 128 AND profile_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      rules_profile_id TEXT NOT NULL REFERENCES rpg_rules_profiles(rules_profile_id) ON DELETE RESTRICT,
      mode TEXT NOT NULL CHECK(mode IN ('xp','milestone')),
      max_level INTEGER NOT NULL CHECK(typeof(max_level)='integer' AND max_level BETWEEN 1 AND 20),
      thresholds_json TEXT NOT NULL CHECK(json_valid(thresholds_json) AND json_type(thresholds_json)='array'),
      profile_digest TEXT NOT NULL CHECK(length(profile_digest)=64 AND profile_digest GLOB '[0-9a-f]*'),
      UNIQUE(rules_profile_id,mode)
    );
    CREATE TABLE character_progression_v23 (
      campaign_character_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL, sheet_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL UNIQUE,
      profile_id TEXT NOT NULL REFERENCES rpg_progression_profiles_v23(profile_id) ON DELETE RESTRICT,
      class_pack_id TEXT NOT NULL, class_pack_version TEXT NOT NULL, class_kind TEXT NOT NULL DEFAULT 'class' CHECK(class_kind='class'), class_definition_id TEXT NOT NULL,
      level INTEGER NOT NULL CHECK(typeof(level)='integer' AND level BETWEEN 1 AND 20),
      total_xp INTEGER NOT NULL CHECK(typeof(total_xp)='integer' AND total_xp BETWEEN 0 AND 9007199254740991),
      milestone_count INTEGER NOT NULL CHECK(typeof(milestone_count)='integer' AND milestone_count BETWEEN 0 AND 19),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      derived_json TEXT NOT NULL CHECK(json_valid(derived_json) AND json_type(derived_json)='object'),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      CHECK(updated_at>=created_at), UNIQUE(campaign_id,campaign_character_id),
      FOREIGN KEY(campaign_id,campaign_character_id) REFERENCES campaign_characters(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,sheet_id,campaign_character_id) REFERENCES rpg_campaign_sheets(campaign_id,id,campaign_character_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(class_pack_id,class_pack_version,class_kind,class_definition_id) REFERENCES rpg_definitions(pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_character_progression_v23_campaign ON character_progression_v23(campaign_id,campaign_character_id);
    CREATE TABLE character_progression_commands_v23 (
      campaign_character_id TEXT NOT NULL REFERENCES character_progression_v23(campaign_character_id) ON DELETE RESTRICT,
      command_id TEXT NOT NULL, campaign_id TEXT NOT NULL, actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      type TEXT NOT NULL CHECK(type IN ('grant-xp','grant-milestone','correct-xp','apply-levels')),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      requested_json TEXT NOT NULL CHECK(json_valid(requested_json) AND json_type(requested_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest GLOB '[0-9a-f]*'),
      proposed_result_json TEXT NOT NULL CHECK(json_valid(proposed_result_json) AND json_type(proposed_result_json)='object'),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_character_id,command_id), UNIQUE(campaign_id,actor_principal_id,idempotency_key),
      UNIQUE(campaign_character_id,expected_revision), FOREIGN KEY(campaign_id,campaign_character_id) REFERENCES character_progression_v23(campaign_id,campaign_character_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_character_progression_commands_v23_retry ON character_progression_commands_v23(campaign_id,actor_principal_id,idempotency_key);
    CREATE TABLE character_progression_ledger_v23 (
      entry_id TEXT PRIMARY KEY, campaign_character_id TEXT NOT NULL, command_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('xp','milestone','correction')), xp_delta INTEGER NOT NULL CHECK(typeof(xp_delta)='integer' AND xp_delta BETWEEN -1000000 AND 1000000),
      milestone_delta INTEGER NOT NULL CHECK(typeof(milestone_delta)='integer' AND milestone_delta BETWEEN -1 AND 1),
      correction_of_entry_id TEXT UNIQUE REFERENCES character_progression_ledger_v23(entry_id) ON DELETE RESTRICT,
      reason TEXT NOT NULL CHECK(reason=trim(reason) AND length(reason) BETWEEN 1 AND 500), occurred_at TEXT NOT NULL,
      CHECK((kind='xp' AND xp_delta>0 AND milestone_delta=0 AND correction_of_entry_id IS NULL) OR
        (kind='milestone' AND xp_delta=0 AND milestone_delta=1 AND correction_of_entry_id IS NULL) OR
        (kind='correction' AND correction_of_entry_id IS NOT NULL AND (xp_delta<0 OR milestone_delta=-1))),
      FOREIGN KEY(campaign_character_id,command_id) REFERENCES character_progression_commands_v23(campaign_character_id,command_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_character_progression_ledger_v23_character ON character_progression_ledger_v23(campaign_character_id,occurred_at,entry_id);
    CREATE TABLE character_level_advancements_v23 (
      advancement_id TEXT PRIMARY KEY, campaign_character_id TEXT NOT NULL, command_id TEXT NOT NULL,
      level INTEGER NOT NULL CHECK(typeof(level)='integer' AND level BETWEEN 2 AND 20), position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 18),
      preview_token TEXT NOT NULL CHECK(length(preview_token)=64 AND preview_token GLOB '[0-9a-f]*'),
      selections_json TEXT NOT NULL CHECK(json_valid(selections_json) AND json_type(selections_json)='array'), changes_json TEXT NOT NULL CHECK(json_valid(changes_json) AND json_type(changes_json)='object'),
      applied_at TEXT NOT NULL, UNIQUE(campaign_character_id,level), UNIQUE(campaign_character_id,command_id,position),
      FOREIGN KEY(campaign_character_id,command_id) REFERENCES character_progression_commands_v23(campaign_character_id,command_id) ON DELETE RESTRICT
    );
    CREATE TABLE character_progression_pending_choices_v23 (
      campaign_character_id TEXT NOT NULL REFERENCES character_progression_v23(campaign_character_id) ON DELETE RESTRICT,
      level INTEGER NOT NULL, choice_id TEXT NOT NULL, choice_json TEXT NOT NULL CHECK(json_valid(choice_json) AND json_type(choice_json)='object'),
      PRIMARY KEY(campaign_character_id,level,choice_id)
    );
    CREATE TABLE character_known_powers_v23 (
      campaign_character_id TEXT NOT NULL REFERENCES character_progression_v23(campaign_character_id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK(kind IN ('ability','spell')), pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, definition_id TEXT NOT NULL,
      source_level INTEGER NOT NULL CHECK(typeof(source_level)='integer' AND source_level BETWEEN 1 AND 20), source_choice_id TEXT,
      granted_by_command_id TEXT, granted_at TEXT NOT NULL, PRIMARY KEY(campaign_character_id,kind,pack_id,pack_version,definition_id),
      FOREIGN KEY(campaign_character_id,granted_by_command_id) REFERENCES character_progression_commands_v23(campaign_character_id,command_id) ON DELETE RESTRICT
    );
    CREATE TABLE character_progression_snapshots_v23 (
      campaign_character_id TEXT NOT NULL, revision INTEGER NOT NULL, command_id TEXT, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object'), created_at TEXT NOT NULL,
      PRIMARY KEY(campaign_character_id,revision), UNIQUE(campaign_character_id,command_id),
      FOREIGN KEY(campaign_character_id) REFERENCES character_progression_v23(campaign_character_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_character_id,command_id) REFERENCES character_progression_commands_v23(campaign_character_id,command_id) ON DELETE RESTRICT
    );
    CREATE TABLE character_progression_receipts_v23 (
      campaign_character_id TEXT NOT NULL, command_id TEXT NOT NULL, revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL,
      result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'), PRIMARY KEY(campaign_character_id,command_id),
      UNIQUE(campaign_character_id,revision_after), CHECK(revision_after=revision_before+1),
      FOREIGN KEY(campaign_character_id,command_id) REFERENCES character_progression_commands_v23(campaign_character_id,command_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_character_id,revision_after) REFERENCES character_progression_snapshots_v23(campaign_character_id,revision) ON DELETE RESTRICT
    );
    CREATE TABLE character_progression_layout_attestation_v23 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), prior_layout_digest TEXT NOT NULL CHECK(length(prior_layout_digest)=64),
      current_layout_digest TEXT NOT NULL CHECK(length(current_layout_digest)=64)
    );

    CREATE TRIGGER rpg_progression_profiles_v23_immutable_update BEFORE UPDATE ON rpg_progression_profiles_v23 BEGIN SELECT RAISE(ABORT,'progression profiles are immutable'); END;
    CREATE TRIGGER rpg_progression_profiles_v23_immutable_delete BEFORE DELETE ON rpg_progression_profiles_v23 BEGIN SELECT RAISE(ABORT,'progression profiles are immutable'); END;
    CREATE TRIGGER character_progression_v23_revision_guard BEFORE UPDATE ON character_progression_v23 WHEN NEW.revision<>OLD.revision+1 OR NEW.campaign_character_id<>OLD.campaign_character_id OR NEW.campaign_id<>OLD.campaign_id OR NEW.sheet_id<>OLD.sheet_id OR NEW.actor_id<>OLD.actor_id OR NEW.profile_id<>OLD.profile_id OR NEW.class_pack_id<>OLD.class_pack_id OR NEW.class_pack_version<>OLD.class_pack_version OR NEW.class_kind<>OLD.class_kind OR NEW.class_definition_id<>OLD.class_definition_id OR NEW.created_at<>OLD.created_at OR NEW.level<OLD.level OR NEW.updated_at<OLD.updated_at BEGIN SELECT RAISE(ABORT,'progression root must advance exactly once without deleveling'); END;
    CREATE TRIGGER character_progression_v23_retain_delete BEFORE DELETE ON character_progression_v23 BEGIN SELECT RAISE(ABORT,'character progression is retained'); END;
    CREATE TRIGGER character_progression_commands_v23_immutable_update BEFORE UPDATE ON character_progression_commands_v23 BEGIN SELECT RAISE(ABORT,'progression commands are immutable'); END;
    CREATE TRIGGER character_progression_commands_v23_immutable_delete BEFORE DELETE ON character_progression_commands_v23 BEGIN SELECT RAISE(ABORT,'progression commands are immutable'); END;
    CREATE TRIGGER character_progression_commands_v23_prevent_replace BEFORE INSERT ON character_progression_commands_v23 WHEN EXISTS(SELECT 1 FROM character_progression_commands_v23 old WHERE old.campaign_character_id=NEW.campaign_character_id AND (old.command_id=NEW.command_id OR old.expected_revision=NEW.expected_revision) OR old.campaign_id=NEW.campaign_id AND old.actor_principal_id=NEW.actor_principal_id AND old.idempotency_key=NEW.idempotency_key) BEGIN SELECT RAISE(ABORT,'progression commands are immutable'); END;
    CREATE TRIGGER character_progression_ledger_v23_immutable_update BEFORE UPDATE ON character_progression_ledger_v23 BEGIN SELECT RAISE(ABORT,'progression ledger is append-only'); END;
    CREATE TRIGGER character_progression_ledger_v23_immutable_delete BEFORE DELETE ON character_progression_ledger_v23 BEGIN SELECT RAISE(ABORT,'progression ledger is append-only'); END;
    CREATE TRIGGER character_progression_ledger_v23_exact_correction BEFORE INSERT ON character_progression_ledger_v23 WHEN NEW.kind='correction' AND NOT EXISTS(SELECT 1 FROM character_progression_ledger_v23 original WHERE original.entry_id=NEW.correction_of_entry_id AND original.campaign_character_id=NEW.campaign_character_id AND original.kind IN ('xp','milestone') AND NEW.xp_delta=-original.xp_delta AND NEW.milestone_delta=-original.milestone_delta) BEGIN SELECT RAISE(ABORT,'progression correction must exactly compensate its source'); END;
    CREATE TRIGGER character_level_advancements_v23_immutable_update BEFORE UPDATE ON character_level_advancements_v23 BEGIN SELECT RAISE(ABORT,'level advancements are immutable'); END;
    CREATE TRIGGER character_level_advancements_v23_immutable_delete BEFORE DELETE ON character_level_advancements_v23 BEGIN SELECT RAISE(ABORT,'level advancements are immutable'); END;
    CREATE TRIGGER character_known_powers_v23_immutable_update BEFORE UPDATE ON character_known_powers_v23 BEGIN SELECT RAISE(ABORT,'known powers are immutable'); END;
    CREATE TRIGGER character_known_powers_v23_immutable_delete BEFORE DELETE ON character_known_powers_v23 BEGIN SELECT RAISE(ABORT,'known powers are immutable'); END;
    CREATE TRIGGER character_progression_snapshots_v23_immutable_update BEFORE UPDATE ON character_progression_snapshots_v23 BEGIN SELECT RAISE(ABORT,'progression snapshots are immutable'); END;
    CREATE TRIGGER character_progression_snapshots_v23_immutable_delete BEFORE DELETE ON character_progression_snapshots_v23 BEGIN SELECT RAISE(ABORT,'progression snapshots are immutable'); END;
    CREATE TRIGGER character_progression_receipts_v23_immutable_update BEFORE UPDATE ON character_progression_receipts_v23 BEGIN SELECT RAISE(ABORT,'progression receipts are immutable'); END;
    CREATE TRIGGER character_progression_receipts_v23_immutable_delete BEFORE DELETE ON character_progression_receipts_v23 BEGIN SELECT RAISE(ABORT,'progression receipts are immutable'); END;
    CREATE TRIGGER character_progression_layout_attestation_v23_immutable_update BEFORE UPDATE ON character_progression_layout_attestation_v23 BEGIN SELECT RAISE(ABORT,'progression layout attestation is immutable'); END;
    CREATE TRIGGER character_progression_layout_attestation_v23_immutable_delete BEFORE DELETE ON character_progression_layout_attestation_v23 BEGIN SELECT RAISE(ABORT,'progression layout attestation is immutable'); END;
  `);
  installProgressionProfilesV23(db);
  backfillCharacterProgressionV23(db);
  const current=characterProgressionLayoutDigestV23(db);
  db.prepare("INSERT INTO character_progression_layout_attestation_v23(singleton,prior_layout_digest,current_layout_digest) VALUES(1,?,?)")
    .run(V22_BUILDER_LAYOUT_DIGEST,current);
}

/** Additive v24r1 repairs exact catalog, profile, pending, power, and event provenance. */
function createCharacterProgressionIntegrityV24(db:DatabaseDriver.Database):void{
  const xp=canonicalStarterProgressionProfile("xp"),milestone=canonicalStarterProgressionProfile("milestone");
  db.exec(`
    CREATE TABLE character_progression_bootstrap_v24 (
      campaign_character_id TEXT PRIMARY KEY REFERENCES character_progression_v23(campaign_character_id) ON DELETE RESTRICT,
      race_pack_id TEXT NOT NULL, race_pack_version TEXT NOT NULL, race_kind TEXT NOT NULL CHECK(race_kind='race'), race_definition_id TEXT NOT NULL,
      class_progression_json TEXT NOT NULL CHECK(json_valid(class_progression_json) AND json_type(class_progression_json)='array'),
      class_progression_digest TEXT NOT NULL CHECK(length(class_progression_digest)=64 AND class_progression_digest GLOB '[0-9a-f]*'),
      initial_powers_json TEXT NOT NULL CHECK(json_valid(initial_powers_json) AND json_type(initial_powers_json)='array'),
      initial_powers_digest TEXT NOT NULL CHECK(length(initial_powers_digest)=64 AND initial_powers_digest GLOB '[0-9a-f]*'),
      created_at TEXT NOT NULL,
      FOREIGN KEY(race_pack_id,race_pack_version,race_kind,race_definition_id) REFERENCES rpg_definitions(pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT
    );
    CREATE TABLE character_progression_pending_snapshots_v24 (
      campaign_character_id TEXT NOT NULL, revision INTEGER NOT NULL, command_id TEXT,
      pending_json TEXT NOT NULL CHECK(json_valid(pending_json) AND json_type(pending_json)='array'),
      pending_digest TEXT NOT NULL CHECK(length(pending_digest)=64 AND pending_digest GLOB '[0-9a-f]*'), created_at TEXT NOT NULL,
      PRIMARY KEY(campaign_character_id,revision), UNIQUE(campaign_character_id,command_id),
      FOREIGN KEY(campaign_character_id) REFERENCES character_progression_bootstrap_v24(campaign_character_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_character_id,command_id) REFERENCES character_progression_commands_v23(campaign_character_id,command_id) ON DELETE RESTRICT
    );
    CREATE TABLE character_progression_command_proposals_v24 (
      campaign_character_id TEXT NOT NULL, command_id TEXT NOT NULL, proposed_event_id TEXT NOT NULL,
      proposed_event_type TEXT NOT NULL CHECK(proposed_event_type IN ('progress_granted','progress_corrected','levels_applied')),
      proposed_event_json TEXT NOT NULL CHECK(json_valid(proposed_event_json) AND json_type(proposed_event_json)='object'),
      proposed_result_json TEXT NOT NULL CHECK(json_valid(proposed_result_json) AND json_type(proposed_result_json)='object'),
      PRIMARY KEY(campaign_character_id,command_id), UNIQUE(campaign_character_id,proposed_event_id),
      FOREIGN KEY(campaign_character_id,command_id) REFERENCES character_progression_commands_v23(campaign_character_id,command_id) ON DELETE RESTRICT
    );
    CREATE TABLE character_progression_events_v24 (
      event_id TEXT PRIMARY KEY, campaign_character_id TEXT NOT NULL, command_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('progress_granted','progress_corrected','levels_applied')),
      revision_before INTEGER NOT NULL, revision INTEGER NOT NULL, occurred_at TEXT NOT NULL,
      public_data TEXT NOT NULL CHECK(json_valid(public_data) AND json_type(public_data)='object'),
      UNIQUE(campaign_character_id,command_id), UNIQUE(campaign_character_id,revision),
      FOREIGN KEY(campaign_character_id,command_id) REFERENCES character_progression_command_proposals_v24(campaign_character_id,command_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_character_progression_events_v24_character ON character_progression_events_v24(campaign_character_id,revision);
    CREATE TABLE character_known_power_sources_v24 (
      campaign_character_id TEXT NOT NULL, kind TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, definition_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('race','class-level','advancement-fixed','advancement-choice')),
      source_reference_json TEXT NOT NULL CHECK(json_valid(source_reference_json) AND json_type(source_reference_json)='object'),
      source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest GLOB '[0-9a-f]*'),
      PRIMARY KEY(campaign_character_id,kind,pack_id,pack_version,definition_id),
      FOREIGN KEY(campaign_character_id,kind,pack_id,pack_version,definition_id)
        REFERENCES character_known_powers_v23(campaign_character_id,kind,pack_id,pack_version,definition_id) ON DELETE RESTRICT
    );
    CREATE TABLE character_progression_layout_attestation_v24 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), prior_layout_digest TEXT NOT NULL CHECK(length(prior_layout_digest)=64),
      current_layout_digest TEXT NOT NULL CHECK(length(current_layout_digest)=64)
    );

    CREATE TRIGGER rpg_progression_profiles_v24_canonical_insert BEFORE INSERT ON rpg_progression_profiles_v23
      WHEN NOT ((NEW.profile_id='${xp.profileId}' AND NEW.rules_profile_id='${xp.rulesProfileId}' AND NEW.mode='xp'
          AND NEW.max_level=${xp.maxLevel} AND NEW.thresholds_json='${canonicalProgressionJson(xp.thresholds)}' AND NEW.profile_digest='${progressionProfileDigest("xp")}')
        OR (NEW.profile_id='${milestone.profileId}' AND NEW.rules_profile_id='${milestone.rulesProfileId}' AND NEW.mode='milestone'
          AND NEW.max_level=${milestone.maxLevel} AND NEW.thresholds_json='${canonicalProgressionJson(milestone.thresholds)}' AND NEW.profile_digest='${progressionProfileDigest("milestone")}'))
      BEGIN SELECT RAISE(ABORT,'progression profile requires canonical server provenance'); END;
    CREATE TRIGGER character_progression_pending_choices_v24_inert_insert BEFORE INSERT ON character_progression_pending_choices_v23 BEGIN SELECT RAISE(ABORT,'legacy pending choices are inert'); END;
    CREATE TRIGGER character_progression_pending_choices_v24_inert_update BEFORE UPDATE ON character_progression_pending_choices_v23 BEGIN SELECT RAISE(ABORT,'legacy pending choices are inert'); END;
    CREATE TRIGGER character_progression_pending_choices_v24_inert_delete BEFORE DELETE ON character_progression_pending_choices_v23 BEGIN SELECT RAISE(ABORT,'legacy pending choices are inert'); END;
    CREATE TRIGGER character_progression_bootstrap_v24_immutable_update BEFORE UPDATE ON character_progression_bootstrap_v24 BEGIN SELECT RAISE(ABORT,'progression bootstrap is immutable'); END;
    CREATE TRIGGER character_progression_bootstrap_v24_immutable_delete BEFORE DELETE ON character_progression_bootstrap_v24 BEGIN SELECT RAISE(ABORT,'progression bootstrap is immutable'); END;
    CREATE TRIGGER character_progression_pending_snapshots_v24_immutable_update BEFORE UPDATE ON character_progression_pending_snapshots_v24 BEGIN SELECT RAISE(ABORT,'progression pending snapshots are immutable'); END;
    CREATE TRIGGER character_progression_pending_snapshots_v24_immutable_delete BEFORE DELETE ON character_progression_pending_snapshots_v24 BEGIN SELECT RAISE(ABORT,'progression pending snapshots are immutable'); END;
    CREATE TRIGGER character_progression_pending_snapshots_v24_prevent_replace BEFORE INSERT ON character_progression_pending_snapshots_v24
      WHEN EXISTS(SELECT 1 FROM character_progression_pending_snapshots_v24 old WHERE old.campaign_character_id=NEW.campaign_character_id
        AND (old.revision=NEW.revision OR old.command_id IS NEW.command_id)) BEGIN SELECT RAISE(ABORT,'progression pending snapshots are immutable'); END;
    CREATE TRIGGER character_progression_command_proposals_v24_immutable_update BEFORE UPDATE ON character_progression_command_proposals_v24 BEGIN SELECT RAISE(ABORT,'progression proposals are immutable'); END;
    CREATE TRIGGER character_progression_command_proposals_v24_immutable_delete BEFORE DELETE ON character_progression_command_proposals_v24 BEGIN SELECT RAISE(ABORT,'progression proposals are immutable'); END;
    CREATE TRIGGER character_progression_command_proposals_v24_validate BEFORE INSERT ON character_progression_command_proposals_v24
      WHEN NOT EXISTS(SELECT 1 FROM character_progression_commands_v23 command WHERE command.campaign_character_id=NEW.campaign_character_id
        AND command.command_id=NEW.command_id AND command.proposed_result_json=NEW.proposed_result_json
        AND json_extract(NEW.proposed_event_json,'$.campaignCharacterId')=command.campaign_character_id
        AND json_extract(NEW.proposed_event_json,'$.commandId')=command.command_id
        AND json_extract(NEW.proposed_event_json,'$.eventId')=NEW.proposed_event_id
        AND json_extract(NEW.proposed_event_json,'$.type')=NEW.proposed_event_type
        AND json_extract(NEW.proposed_event_json,'$.revision')=command.expected_revision+1
        AND json_extract(NEW.proposed_event_json,'$.occurredAt')=command.created_at)
      BEGIN SELECT RAISE(ABORT,'progression proposal must match its exact command'); END;
    CREATE TRIGGER character_progression_events_v24_immutable_update BEFORE UPDATE ON character_progression_events_v24 BEGIN SELECT RAISE(ABORT,'progression events are immutable'); END;
    CREATE TRIGGER character_progression_events_v24_immutable_delete BEFORE DELETE ON character_progression_events_v24 BEGIN SELECT RAISE(ABORT,'progression events are immutable'); END;
    CREATE TRIGGER character_progression_events_v24_require_proposal BEFORE INSERT ON character_progression_events_v24
      WHEN NOT EXISTS(SELECT 1 FROM character_progression_command_proposals_v24 proposal
        JOIN character_progression_commands_v23 command ON command.campaign_character_id=proposal.campaign_character_id AND command.command_id=proposal.command_id
        WHERE proposal.campaign_character_id=NEW.campaign_character_id AND proposal.command_id=NEW.command_id
          AND proposal.proposed_event_id=NEW.event_id AND proposal.proposed_event_type=NEW.type
          AND command.expected_revision=NEW.revision_before AND NEW.revision=NEW.revision_before+1
          AND command.created_at=NEW.occurred_at
          AND proposal.proposed_event_json=json_object('campaignCharacterId',NEW.campaign_character_id,'commandId',NEW.command_id,
            'eventId',NEW.event_id,'occurredAt',NEW.occurred_at,'publicData',json(NEW.public_data),
            'revision',NEW.revision,'type',NEW.type))
      BEGIN SELECT RAISE(ABORT,'progression event must match its exact proposal'); END;
    CREATE TRIGGER character_progression_receipts_v24_require_event BEFORE INSERT ON character_progression_receipts_v23
      WHEN NOT EXISTS(SELECT 1 FROM character_progression_command_proposals_v24 proposal
        JOIN character_progression_events_v24 event ON event.campaign_character_id=proposal.campaign_character_id AND event.command_id=proposal.command_id
          AND event.event_id=proposal.proposed_event_id AND event.type=proposal.proposed_event_type
        WHERE proposal.campaign_character_id=NEW.campaign_character_id AND proposal.command_id=NEW.command_id
          AND proposal.proposed_result_json=NEW.result_json AND event.revision=NEW.revision_after AND event.revision_before=NEW.revision_before)
      BEGIN SELECT RAISE(ABORT,'progression receipt must match its exact event proposal'); END;
    CREATE TRIGGER character_known_power_sources_v24_immutable_update BEFORE UPDATE ON character_known_power_sources_v24 BEGIN SELECT RAISE(ABORT,'known power provenance is immutable'); END;
    CREATE TRIGGER character_known_power_sources_v24_immutable_delete BEFORE DELETE ON character_known_power_sources_v24 BEGIN SELECT RAISE(ABORT,'known power provenance is immutable'); END;
    CREATE TRIGGER character_progression_layout_attestation_v24_immutable_update BEFORE UPDATE ON character_progression_layout_attestation_v24 BEGIN SELECT RAISE(ABORT,'progression v24 layout attestation is immutable'); END;
    CREATE TRIGGER character_progression_layout_attestation_v24_immutable_delete BEFORE DELETE ON character_progression_layout_attestation_v24 BEGIN SELECT RAISE(ABORT,'progression v24 layout attestation is immutable'); END;
  `);
  backfillCharacterProgressionIntegrityV24(db);
  const current=characterProgressionLayoutDigestV24(db);
  db.prepare("INSERT INTO character_progression_layout_attestation_v24(singleton,prior_layout_digest,current_layout_digest) VALUES(1,?,?)")
    .run(V23_PROGRESSION_LAYOUT_DIGEST,current);
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

function migrate14to15(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    // The v14 gameplay audit graph is intentionally only read here. All v15
    // DDL is additive, preserving closed commands, events, receipts and rolls.
    createCampaignAdministrationV15(db);
    db.prepare("UPDATE meta SET value = '15' WHERE key = 'schemaVersion'").run();
  })();
}

function migrate15to16(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createContentCatalogV16(db);
    db.prepare("UPDATE meta SET value = '16' WHERE key = 'schemaVersion'").run();
  })();
}

function requireCatalogSchemaLayout(
  db: DatabaseDriver.Database,
  version: "v16"|"v17"|"v18",
  tables: Record<string,string[]>,
  indexes: readonly string[],
  triggers: readonly string[],
): void {
  for(const [table,columns] of Object.entries(tables)){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      throw new Error(`schema ${version} artifact ${table} is missing`);
    const actual=(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map((column)=>column.name);
    if(JSON.stringify(actual)!==JSON.stringify(columns)) throw new Error(`schema ${version} artifact ${table} columns are incompatible`);
  }
  for(const name of indexes){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name))
      throw new Error(`schema ${version} artifact ${name} is missing`);
  }
  for(const name of triggers){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))
      throw new Error(`schema ${version} artifact ${name} is missing`);
  }
  const tableNames=Object.keys(tables),placeholders=tableNames.map(()=>"?").join(",");
  const actualIndexes=(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'
    AND tbl_name IN (${placeholders}) ORDER BY name`).all(...tableNames) as Array<{name:string}>).map((row)=>row.name);
  if(JSON.stringify(actualIndexes)!==JSON.stringify([...indexes].sort()))
    throw new Error(`schema ${version} catalog indexes are incompatible`);
  const expectedTableTriggers=(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN
    (${triggers.map(()=>"?").join(",")}) AND tbl_name IN (${placeholders}) ORDER BY name`)
    .all(...triggers,...tableNames) as Array<{name:string}>).map((row)=>row.name);
  const actualTableTriggers=(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${placeholders}) ORDER BY name`)
    .all(...tableNames) as Array<{name:string}>).map((row)=>row.name);
  if(JSON.stringify(actualTableTriggers)!==JSON.stringify(expectedTableTriggers))
    throw new Error(`schema ${version} catalog triggers are incompatible`);
  const actualCatalogTables=(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND
    (name='rpg_content_pack_publications' OR name GLOB 'rpg_catalog_*' OR name GLOB 'campaign_content_catalog_*'
      OR name GLOB 'campaign_catalog_*') ORDER BY name`).all() as Array<{name:string}>).map((row)=>row.name);
  if(JSON.stringify(actualCatalogTables)!==JSON.stringify([...tableNames].sort()))
    throw new Error(`schema ${version} catalog tables are incompatible`);
}

const V16_CATALOG_TABLES:Record<string,string[]>={
  rpg_content_pack_publications:["pack_id","pack_version","validation_level","rules_engine","manifest_digest","manifest_json",
    "provenance_json","validation_report_json","published_by_principal_id","published_at"],
  rpg_catalog_definitions:["pack_id","pack_version","kind","definition_id","definition_json","public_definition_json","dependencies_json"],
  campaign_content_catalog_selections:["campaign_id","rules_profile_id","selection_digest","configured_by_principal_id","configured_at"],
  campaign_content_catalog_pins:["campaign_id","pack_id","pack_version","position"],
};
const V16_CATALOG_INDEXES=["idx_rpg_content_pack_publications_validation","idx_rpg_catalog_definitions_pack",
  "idx_campaign_content_catalog_pins_exact"] as const;
const V16_CATALOG_TRIGGERS=["rpg_content_pack_publications_require_validated_pack","campaign_content_catalog_pins_require_validated",
  "rpg_content_packs_prevent_replace_v16","rpg_definitions_prevent_replace_v16","rpg_content_pack_publications_immutable_update",
  "rpg_content_pack_publications_immutable_delete","rpg_content_pack_publications_prevent_replace","rpg_catalog_definitions_immutable_update",
  "rpg_catalog_definitions_immutable_delete","rpg_catalog_definitions_prevent_sealed_insert","rpg_catalog_definitions_prevent_replace",
  "campaign_content_catalog_selections_immutable_update","campaign_content_catalog_selections_immutable_delete",
  "campaign_content_catalog_selections_prevent_replace","campaign_content_catalog_pins_immutable_update",
  "campaign_content_catalog_pins_immutable_delete","campaign_content_catalog_pins_prevent_replace"] as const;

const V17_CATALOG_TABLES:Record<string,string[]>={
  rpg_catalog_publication_attestations:["pack_id","pack_version","definition_count","definition_counts_json","publication_digest",
    "public_projection_digest","public_projection_count"],
  rpg_catalog_definition_visibility:["pack_id","pack_version","kind","definition_id","public_definition_json",
    "public_dependencies_json","private_dependencies_json","row_digest","publicly_reachable"],
  rpg_catalog_publication_submissions:["principal_id","idempotency_key","request_digest","pack_id","pack_version","receipt_json","created_at"],
  campaign_catalog_current_selections:["campaign_id","rules_profile_id","selection_digest","configured_by_principal_id","configured_at","open_command_id"],
  campaign_catalog_current_pins:["campaign_id","pack_id","pack_version","position","open_command_id"],
  campaign_catalog_commands:["campaign_id","command_id","idempotency_key","actor_principal_id","expected_revision","request_digest",
    "target_selection_digest","requested_json","created_at"],
  campaign_catalog_events:["campaign_id","command_id","event_id","revision_before","revision","occurred_at","public_data"],
  campaign_catalog_receipts:["campaign_id","command_id","event_id","revision_before","revision_after","result_json"],
};
const V17_CATALOG_TRIGGERS=["rpg_catalog_attestations_immutable_update","rpg_catalog_attestations_immutable_delete",
  "rpg_catalog_attestations_prevent_replace","rpg_catalog_attestations_validate_insert","rpg_catalog_visibility_immutable_update",
  "rpg_catalog_visibility_immutable_delete","rpg_catalog_visibility_prevent_replace","rpg_catalog_visibility_validate_insert",
  "rpg_catalog_submissions_immutable_update","rpg_catalog_submissions_immutable_delete","rpg_catalog_submissions_prevent_replace",
  "rpg_catalog_submissions_validate_insert","campaign_catalog_commands_require_owner_revision","campaign_catalog_selection_bind_insert",
  "campaign_catalog_pin_bind_insert","campaign_catalog_selection_bind_delete","campaign_catalog_pin_bind_delete",
  "campaign_catalog_selection_prevent_update","campaign_catalog_pin_prevent_update","campaign_catalog_commands_immutable_update",
  "campaign_catalog_commands_immutable_delete","campaign_catalog_commands_prevent_replace","campaign_catalog_events_immutable_update",
  "campaign_catalog_events_immutable_delete","campaign_catalog_events_prevent_replace","campaign_catalog_events_validate_provenance",
  "campaign_catalog_receipts_immutable_update","campaign_catalog_receipts_immutable_delete","campaign_catalog_receipts_prevent_replace",
  "campaign_catalog_receipts_validate_result","campaign_administration_commands_reject_catalog_identity",
  "campaign_administration_events_reject_catalog_revision"] as const;

const V18_CATALOG_TABLES:Record<string,string[]>={
  campaign_catalog_command_provenance_v18:["campaign_id","command_id","proposed_event_id","proposed_event_type",
    "actor_principal_id","proposed_public_data","proposed_result_json"],
};
const V18_CATALOG_INDEXES=["idx_campaign_catalog_command_provenance_v18_event"] as const;
const V18_CATALOG_TRIGGERS=["campaign_catalog_commands_validate_requested_v18","campaign_catalog_command_provenance_v18_validate",
  "campaign_catalog_command_provenance_v18_immutable_update","campaign_catalog_command_provenance_v18_immutable_delete",
  "campaign_catalog_command_provenance_v18_prevent_replace","campaign_catalog_events_require_proposal_v18",
  "campaign_catalog_receipts_require_proposal_v18"] as const;

const V18_CHARACTER_AGGREGATE_TABLES:Record<string,string[]>={
  campaign_characters:["id","campaign_id","character_id","created_at","updated_at"],
  rpg_campaign_sheets:["id","campaign_id","campaign_character_id","race_pack_id","race_pack_version","race_kind","race_definition_id",
    "background_pack_id","background_pack_version","background_kind","background_definition_id","created_at","updated_at"],
  rpg_character_classes:["campaign_id","sheet_id","position","pack_id","pack_version","kind","definition_id","level"],
  rpg_character_attributes:["campaign_id","sheet_id","position","attribute_id","value"],
  rpg_character_proficiencies:["campaign_id","sheet_id","position","category","proficiency_id"],
  rpg_character_choices:["campaign_id","sheet_id","position","choice_id","pack_id","pack_version","kind","definition_id"],
  campaign_actors:["id","campaign_id","campaign_character_id","sheet_id","kind","control","created_at","updated_at"],
  campaign_actor_private_state:["actor_id","campaign_id","controller_principal_id","private_notes"],
  rpg_actor_resources:["campaign_id","actor_id","name","current","max"],
};
const V18_CHARACTER_AGGREGATE_INDEXES=["idx_campaign_characters_character","idx_rpg_campaign_sheets_character",
  "idx_rpg_campaign_sheets_race_pin","idx_rpg_campaign_sheets_race_definition","idx_rpg_campaign_sheets_background_pin",
  "idx_rpg_campaign_sheets_background_definition","idx_rpg_character_classes_sheet","idx_rpg_character_classes_pin",
  "idx_rpg_character_classes_definition","idx_rpg_character_attributes_sheet","idx_rpg_character_proficiencies_sheet",
  "idx_rpg_character_choices_sheet","idx_rpg_character_choices_pin","idx_rpg_character_choices_definition",
  "idx_campaign_actors_character","idx_campaign_actors_sheet","idx_campaign_actor_private_state_actor",
  "idx_campaign_actor_private_state_controller","idx_rpg_actor_resources_actor"] as const;

const V19_BUILDER_TABLES:Record<string,string[]>={
  character_drafts_v19:["id","campaign_id","persona_id","controller_principal_id","created_by_principal_id","status","durability",
    "expires_at","revision","rules_profile_id","allocation_json","selections_json","created_at","updated_at"],
  character_draft_pins_v19:["draft_id","position","pack_id","pack_version","publication_digest"],
  character_draft_commands_v19:["draft_id","command_id","campaign_id","actor_principal_id","idempotency_key","type","expected_revision",
    "requested_json","request_digest","created_at"],
  character_draft_events_v19:["draft_id","command_id","event_id","type","revision_before","revision","occurred_at","public_data"],
  character_draft_receipts_v19:["draft_id","command_id","event_id","revision_before","revision_after","result_json"],
  character_draft_revisions_v19:["draft_id","revision","status","snapshot_json","command_id"],
  character_derived_snapshots_v19:["draft_id","campaign_id","campaign_character_id","sheet_id","actor_id","calculator_version","derived_json","created_at"],
  character_starting_grants_v19:["draft_id","position","kind","pack_id","pack_version","definition_id","amount","source","grant_json"],
};
const V19_BUILDER_INDEXES=["idx_character_drafts_v19_campaign","idx_character_drafts_v19_controller",
  "idx_character_draft_pins_v19_publication","idx_character_draft_commands_v19_retry"] as const;
const V19_BUILDER_TRIGGERS=["character_drafts_v19_revision_guard","character_drafts_v19_prevent_delete",
  "character_draft_pins_v19_immutable_update","character_draft_pins_v19_immutable_delete","character_draft_pins_v19_prevent_replace",
  "character_draft_commands_v19_immutable_update","character_draft_commands_v19_immutable_delete",
  "character_draft_events_v19_immutable_update","character_draft_events_v19_immutable_delete",
  "character_draft_receipts_v19_immutable_update","character_draft_receipts_v19_immutable_delete",
  "character_draft_revisions_v19_immutable_update","character_draft_revisions_v19_immutable_delete",
  "character_derived_snapshots_v19_immutable_update","character_derived_snapshots_v19_immutable_delete",
  "character_starting_grants_v19_immutable_update","character_starting_grants_v19_immutable_delete"] as const;
const V19_BUILDER_LAYOUT_DIGEST="b9f68f6132c31c0da9640f6aebd17f6ba7be442d166196361d0576f6b8dc2cfd";
const V20_BUILDER_LAYOUT_DIGEST="af4fed8eb181b4af8a420899376f0f3cc4b28cbb088165072cf7507ecbea7cdc";
const V21_BUILDER_LAYOUT_DIGEST="08436907f6cb64d75dc3b8acc81d400401118715a47fca41e5d5e0de97c630e6";
const V22_BUILDER_LAYOUT_DIGEST="21f7c0c17a9ee210f1271bd1abaa6ac41d7d753acd2417f63c8ea4ce8c711599";
const V20_BUILDER_TABLES:Record<string,string[]>={
  character_draft_command_provenance_v20:["draft_id","command_id","campaign_id","actor_principal_id","proposed_event_id",
    "proposed_event_type","proposed_event_json","proposed_result_json"],
  character_draft_campaign_deletions_v20:["campaign_id"],
  character_builder_layout_attestation_v20:["singleton","layout_digest"],
};
const V20_BUILDER_INDEXES=["idx_character_draft_command_provenance_v20_campaign"] as const;
const V20_BUILDER_TRIGGERS=[...V19_BUILDER_TRIGGERS,
  "character_draft_command_provenance_v20_validate","character_draft_command_provenance_v20_immutable_update",
  "character_draft_command_provenance_v20_immutable_delete","character_draft_command_provenance_v20_prevent_replace",
  "character_draft_events_require_proposal_v20","character_draft_receipts_require_proposal_v20",
  "character_draft_campaign_deletions_v20_validate","character_draft_campaign_deletions_v20_immutable_update",
  "character_draft_campaign_deletions_v20_guard_delete","character_builder_layout_attestation_v20_immutable_update",
  "character_builder_layout_attestation_v20_immutable_delete"] as const;
const V20_CAMPAIGN_TRIGGERS=["campaigns_delete_character_drafts_v20","campaigns_clear_character_draft_deletion_v20"] as const;
const V20_CASCADE_GUARD_TRIGGERS=["campaign_content_catalog_selections_immutable_delete","campaign_content_catalog_pins_immutable_delete",
  "campaign_catalog_selection_bind_delete","campaign_catalog_pin_bind_delete","campaign_catalog_commands_immutable_delete",
  "campaign_catalog_events_immutable_delete","campaign_catalog_receipts_immutable_delete","campaign_catalog_command_provenance_v18_immutable_delete"] as const;
const V21_BUILDER_TABLES:Record<string,string[]>={
  character_draft_command_provenance_v20:V20_BUILDER_TABLES.character_draft_command_provenance_v20!,
  character_draft_campaign_deletions_v20:V20_BUILDER_TABLES.character_draft_campaign_deletions_v20!,
  character_builder_layout_attestation_v20:V20_BUILDER_TABLES.character_builder_layout_attestation_v20!,
  character_builder_layout_attestation_v21:["singleton","layout_digest"],
};
const V21_BUILDER_INDEXES=[...V19_BUILDER_INDEXES,...V20_BUILDER_INDEXES,"uq_character_draft_commands_v21_revision","uq_character_draft_events_v21_revision",
  "uq_character_draft_receipts_v21_revision","uq_character_draft_proposals_v21_revision"] as const;
const V21_BUILDER_TRIGGERS=[...V20_BUILDER_TRIGGERS,
  "character_draft_events_require_proposal_v21","character_draft_receipts_require_proposal_v21",
  "character_builder_layout_attestation_v21_immutable_update","character_builder_layout_attestation_v21_immutable_delete",
  "character_draft_campaign_deletions_v21_forbid_insert","character_draft_campaign_deletions_v21_forbid_update",
  "character_draft_campaign_deletions_v21_forbid_delete"] as const;
const V21_CAMPAIGN_TRIGGERS=[...V20_CAMPAIGN_TRIGGERS,"campaigns_require_repository_delete_v21"] as const;
const V22_BUILDER_TABLES:Record<string,string[]>={
  ...V21_BUILDER_TABLES,
  character_builder_layout_attestation_v22:["singleton","layout_digest"],
};
const V22_BUILDER_TRIGGERS=[...V21_BUILDER_TRIGGERS,
  "character_draft_campaign_deletions_v22_inert_insert","character_draft_campaign_deletions_v22_inert_update",
  "character_draft_campaign_deletions_v22_inert_delete","character_drafts_v22_retain_delete",
  "character_draft_pins_v22_retain_delete","character_draft_commands_v22_retain_delete",
  "character_draft_events_v22_retain_delete","character_draft_receipts_v22_retain_delete",
  "character_draft_revisions_v22_retain_delete","character_derived_snapshots_v22_retain_delete",
  "character_starting_grants_v22_retain_delete","character_draft_command_provenance_v22_retain_delete",
  "character_builder_layout_attestation_v22_immutable_update","character_builder_layout_attestation_v22_immutable_delete"] as const;
const V22_CAMPAIGN_TRIGGERS=[...V21_CAMPAIGN_TRIGGERS,"campaigns_prevent_physical_delete_v22"] as const;

function requireBuilderSchemaLayout(db:DatabaseDriver.Database,version:"v19"|"v20"|"v21"|"v22",tables:Record<string,string[]>,
  indexes:readonly string[],triggers:readonly string[]):void{
  for(const [table,columns] of Object.entries(tables)){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error(`schema ${version} builder artifact ${table} is missing`);
    const actual=(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map((column)=>column.name);
    if(JSON.stringify(actual)!==JSON.stringify(columns))throw new Error(`schema ${version} builder artifact ${table} columns are incompatible`);
  }
  const names=Object.keys(tables),placeholders=names.map(()=>"?").join(",");
  const actualIndexes=(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'
    AND tbl_name IN (${placeholders}) ORDER BY name`).all(...names) as Array<{name:string}>).map((row)=>row.name);
  if(JSON.stringify(actualIndexes)!==JSON.stringify([...indexes].sort()))throw new Error(`schema ${version} builder indexes are incompatible`);
  const actualTriggers=(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${placeholders}) ORDER BY name`).all(...names) as Array<{name:string}>).map((row)=>row.name);
  const tableTriggers=triggers.filter((name)=>!V20_CAMPAIGN_TRIGGERS.includes(name as typeof V20_CAMPAIGN_TRIGGERS[number])).sort();
  if(JSON.stringify(actualTriggers)!==JSON.stringify(tableTriggers))throw new Error(`schema ${version} builder triggers are incompatible`);
}
function assertCanonicalV19BuilderSql(db:DatabaseDriver.Database):void{
  const names=Object.keys(V19_BUILDER_TABLES);
  const rows=(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
    AND tbl_name IN (${names.map(()=>"?").join(",")}) ORDER BY type,name`).all(...names) as Array<{type:string;name:string;tbl_name:string;sql:string}>)
    .map((row)=>({...row,sql:row.sql.replace(/\s+/g," ").trim()}));
  const actual=createHash("sha256").update(canonicalV17(rows)).digest("hex");
  if(actual!==V19_BUILDER_LAYOUT_DIGEST)throw new Error(`schema v19 builder canonical SQL is incompatible (${actual})`);
}

function characterBuilderLayoutRowsV20(db:DatabaseDriver.Database):unknown[]{
  const tables=[...Object.keys(V19_BUILDER_TABLES),...Object.keys(V20_BUILDER_TABLES)];
  const rows=db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND
    (tbl_name IN (${tables.map(()=>"?").join(",")}) OR name GLOB 'character_*_v19*' OR name GLOB 'character_*_v20*'
      OR name IN (${[...V20_CAMPAIGN_TRIGGERS,...V20_CASCADE_GUARD_TRIGGERS].map(()=>"?").join(",")})) ORDER BY type,name`)
    .all(...tables,...V20_CAMPAIGN_TRIGGERS,...V20_CASCADE_GUARD_TRIGGERS) as Array<{type:string;name:string;tbl_name:string;sql:string}>;
  return rows;
}
function characterBuilderLayoutDigestV20(db:DatabaseDriver.Database):string{
  return createHash("sha256").update(canonicalV17(characterBuilderLayoutRowsV20(db))).digest("hex");
}
function sealCharacterBuilderLayoutV20(db:DatabaseDriver.Database):void{
  db.prepare("INSERT INTO character_builder_layout_attestation_v20(singleton,layout_digest) VALUES (1,?)")
    .run(characterBuilderLayoutDigestV20(db));
}
function assertCharacterBuilderLayoutV20(db:DatabaseDriver.Database):void{
  requireBuilderSchemaLayout(db,"v20",{...V19_BUILDER_TABLES,...V20_BUILDER_TABLES},
    [...V19_BUILDER_INDEXES,...V20_BUILDER_INDEXES],V20_BUILDER_TRIGGERS);
  const campaigns=(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='campaigns' AND name GLOB '*character_draft*_v20'
    ORDER BY name`).all() as Array<{name:string}>).map((row)=>row.name);
  if(JSON.stringify(campaigns)!==JSON.stringify([...V20_CAMPAIGN_TRIGGERS].sort()))throw new Error("schema v20 builder campaign triggers are incompatible");
  const row=db.prepare("SELECT layout_digest FROM character_builder_layout_attestation_v20 WHERE singleton=1").get() as {layout_digest:string}|undefined;
  const actual=characterBuilderLayoutDigestV20(db);
  if(!row||row.layout_digest!==V20_BUILDER_LAYOUT_DIGEST||actual!==V20_BUILDER_LAYOUT_DIGEST)
    throw new Error(`schema v20 builder canonical SQL is incompatible (${actual})`);
}
function characterBuilderLayoutRowsV21(db:DatabaseDriver.Database):unknown[]{
  const tables=[...Object.keys(V19_BUILDER_TABLES),...Object.keys(V21_BUILDER_TABLES)];
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND
    (tbl_name IN (${tables.map(()=>"?").join(",")}) OR name GLOB 'character_*_v19*' OR name GLOB 'character_*_v20*'
      OR name GLOB 'character_*_v21*' OR name IN (${[...V20_CASCADE_GUARD_TRIGGERS,...V21_CAMPAIGN_TRIGGERS].map(()=>"?").join(",")}))
    ORDER BY type,name`).all(...tables,...V20_CASCADE_GUARD_TRIGGERS,...V21_CAMPAIGN_TRIGGERS);
}
function characterBuilderLayoutDigestV21(db:DatabaseDriver.Database):string{
  return createHash("sha256").update(canonicalV17(characterBuilderLayoutRowsV21(db))).digest("hex");
}
function sealCharacterBuilderLayoutV21(db:DatabaseDriver.Database):void{
  db.prepare("INSERT INTO character_builder_layout_attestation_v21(singleton,layout_digest) VALUES (1,?)")
    .run(characterBuilderLayoutDigestV21(db));
}
function assertCharacterBuilderLayoutV21(db:DatabaseDriver.Database):void{
  requireBuilderSchemaLayout(db,"v21",{...V19_BUILDER_TABLES,...V21_BUILDER_TABLES},V21_BUILDER_INDEXES,V21_BUILDER_TRIGGERS);
  const deletionMarkers=(db.prepare("SELECT COUNT(*) count FROM character_draft_campaign_deletions_v20").get() as {count:number}).count;
  if(deletionMarkers!==0)throw new Error("schema v21 has an enabled character draft deletion capability");
  const campaignTriggers=(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='campaigns' AND name GLOB '*_v21*' ORDER BY name").all() as Array<{name:string}>).map((value)=>value.name);
  if(JSON.stringify(campaignTriggers)!==JSON.stringify(["campaigns_require_repository_delete_v21"]))throw new Error("schema v21 campaign deletion guard is incompatible");
  const row=db.prepare("SELECT layout_digest FROM character_builder_layout_attestation_v21 WHERE singleton=1").get() as {layout_digest:string}|undefined;
  const actual=characterBuilderLayoutDigestV21(db);
  if(!row||row.layout_digest!==V21_BUILDER_LAYOUT_DIGEST||actual!==V21_BUILDER_LAYOUT_DIGEST)
    throw new Error(`schema v21 builder canonical SQL is incompatible (${actual})`);
}

function characterBuilderLayoutRowsV22(db:DatabaseDriver.Database):unknown[]{
  const tables=[...Object.keys(V19_BUILDER_TABLES),...Object.keys(V22_BUILDER_TABLES)];
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND
    (tbl_name IN (${tables.map(()=>"?").join(",")}) OR name GLOB 'character_*_v19*' OR name GLOB 'character_*_v20*'
      OR name GLOB 'character_*_v21*' OR name GLOB 'character_*_v22*'
      OR name IN (${[...V20_CASCADE_GUARD_TRIGGERS,...V22_CAMPAIGN_TRIGGERS].map(()=>"?").join(",")}))
    ORDER BY type,name`).all(...tables,...V20_CASCADE_GUARD_TRIGGERS,...V22_CAMPAIGN_TRIGGERS);
}
function characterBuilderLayoutDigestV22(db:DatabaseDriver.Database):string{
  return createHash("sha256").update(canonicalV17(characterBuilderLayoutRowsV22(db))).digest("hex");
}
function sealCharacterBuilderLayoutV22(db:DatabaseDriver.Database):void{
  db.prepare("INSERT INTO character_builder_layout_attestation_v22(singleton,layout_digest) VALUES (1,?)")
    .run(characterBuilderLayoutDigestV22(db));
}
function assertCharacterBuilderLayoutV22(db:DatabaseDriver.Database):void{
  requireBuilderSchemaLayout(db,"v22",{...V19_BUILDER_TABLES,...V22_BUILDER_TABLES},V21_BUILDER_INDEXES,V22_BUILDER_TRIGGERS);
  const deletionMarkers=(db.prepare("SELECT COUNT(*) count FROM character_draft_campaign_deletions_v20").get() as {count:number}).count;
  if(deletionMarkers!==0)throw new Error("schema v22 has a non-inert character draft deletion marker");
  const campaignTriggers=(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='campaigns' AND name GLOB '*_v22*' ORDER BY name").all() as Array<{name:string}>).map((value)=>value.name);
  if(JSON.stringify(campaignTriggers)!==JSON.stringify(["campaigns_prevent_physical_delete_v22"]))throw new Error("schema v22 campaign archive guard is incompatible");
  const row=db.prepare("SELECT layout_digest FROM character_builder_layout_attestation_v22 WHERE singleton=1").get() as {layout_digest:string}|undefined;
  const actual=characterBuilderLayoutDigestV22(db);
  if(!row||row.layout_digest!==V22_BUILDER_LAYOUT_DIGEST||actual!==V22_BUILDER_LAYOUT_DIGEST)
    throw new Error(`schema v22 builder canonical SQL is incompatible (${actual})`);
}

function requireCharacterBuilderPriorLayout(db:DatabaseDriver.Database):void{
  for(const [table,columns] of Object.entries(V18_CHARACTER_AGGREGATE_TABLES)){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      throw new Error(`schema v18 character artifact ${table} is missing`);
    const actual=(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map((column)=>column.name);
    if(JSON.stringify(actual)!==JSON.stringify(columns))throw new Error(`schema v18 character artifact ${table} columns are incompatible`);
  }
  const tables=Object.keys(V18_CHARACTER_AGGREGATE_TABLES),placeholders=tables.map(()=>"?").join(",");
  const indexes=(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'
    AND tbl_name IN (${placeholders}) ORDER BY name`).all(...tables) as Array<{name:string}>).map((row)=>row.name);
  if(JSON.stringify(indexes)!==JSON.stringify([...V18_CHARACTER_AGGREGATE_INDEXES].sort()))
    throw new Error("schema v18 character indexes are incompatible");
  const triggers=db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${placeholders}) ORDER BY name`).all(...tables);
  if(triggers.length)throw new Error("schema v18 character triggers are incompatible");
}

function migrate16to17(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    requireCatalogSchemaLayout(db,"v16",V16_CATALOG_TABLES,V16_CATALOG_INDEXES,V16_CATALOG_TRIGGERS);
    createContentCatalogV17(db);
    db.prepare("UPDATE meta SET value='17' WHERE key='schemaVersion'").run();
  })();
}

function migrate17to18(db: DatabaseDriver.Database):void{
  db.transaction(()=>{
    requireCatalogSchemaLayout(db,"v17",{...V16_CATALOG_TABLES,...V17_CATALOG_TABLES},V16_CATALOG_INDEXES,
      [...V16_CATALOG_TRIGGERS,...V17_CATALOG_TRIGGERS]);
    createContentCatalogV18(db);
    db.prepare("UPDATE meta SET value='18' WHERE key='schemaVersion'").run();
  })();
}

function migrate18to19(db: DatabaseDriver.Database):void{
  db.transaction(()=>{
    requireCatalogSchemaLayout(db,"v18",{...V16_CATALOG_TABLES,...V17_CATALOG_TABLES,...V18_CATALOG_TABLES},
      [...V16_CATALOG_INDEXES,...V18_CATALOG_INDEXES],
      [...V16_CATALOG_TRIGGERS,...V17_CATALOG_TRIGGERS,...V18_CATALOG_TRIGGERS]);
    requireCharacterBuilderPriorLayout(db);
    createCharacterBuilderV19(db);
    db.prepare("UPDATE meta SET value='19' WHERE key='schemaVersion'").run();
  })();
}

interface V19DraftAuditMigrationRow {
  draft_id:string;command_id:string;campaign_id:string;actor_principal_id:string;idempotency_key:string;command_type:string;
  expected_revision:number;requested_json:string;created_at:string;event_id:string;event_type:string;revision_before:number;revision:number;
  occurred_at:string;public_data:string;receipt_event_id:string;receipt_before:number;receipt_after:number;result_json:string;
  snapshot_revision:number;revision_status:string;snapshot_json:string;
}
function validateV19DraftAuditForMigration(db:DatabaseDriver.Database):Array<V19DraftAuditMigrationRow&{proposed_event_json:string}>{
  const counts=db.prepare(`SELECT
    (SELECT COUNT(*) FROM character_draft_commands_v19) commands,
    (SELECT COUNT(*) FROM character_draft_events_v19) events,
    (SELECT COUNT(*) FROM character_draft_receipts_v19) receipts,
    (SELECT COUNT(*) FROM character_draft_revisions_v19) revisions`).get() as Record<string,number>;
  if(counts.commands!==counts.events||counts.commands!==counts.receipts||counts.commands!==counts.revisions)
    throw new Error("schema v19 character draft audit is incomplete");
  const rows=db.prepare(`SELECT command.draft_id,command.command_id,command.campaign_id,command.actor_principal_id,
      command.idempotency_key,command.type command_type,command.expected_revision,command.requested_json,command.created_at,
      event.event_id,event.type event_type,event.revision_before,event.revision,event.occurred_at,event.public_data,
      receipt.event_id receipt_event_id,receipt.revision_before receipt_before,receipt.revision_after receipt_after,receipt.result_json,
      revision.revision snapshot_revision,revision.status revision_status,revision.snapshot_json
    FROM character_draft_commands_v19 command
    JOIN character_draft_events_v19 event ON event.draft_id=command.draft_id AND event.command_id=command.command_id
    JOIN character_draft_receipts_v19 receipt ON receipt.draft_id=command.draft_id AND receipt.command_id=command.command_id
    JOIN character_draft_revisions_v19 revision ON revision.draft_id=command.draft_id AND revision.command_id=command.command_id
    ORDER BY command.draft_id,command.command_id`).all() as V19DraftAuditMigrationRow[];
  if(rows.length!==counts.commands)throw new Error("schema v19 character draft audit is incomplete");
  const validated=rows.map((row)=>{
    let result:Record<string,any>,snapshot:unknown,requested:Record<string,any>;
    try{result=JSON.parse(row.result_json);snapshot=JSON.parse(row.snapshot_json);requested=JSON.parse(row.requested_json);}catch{throw new Error("schema v19 character draft audit is malformed");}
    const expectedType={create:"draft_created",update:"draft_updated",abandon:"draft_abandoned",finalize:"draft_finalized"}[row.command_type];
    const expectedRevision=row.command_type==="create"?row.expected_revision:row.expected_revision+1;
    const expectedStatus=row.command_type==="abandon"?"abandoned":row.command_type==="finalize"?"finalized":"active";
    const publicData={draftId:row.draft_id,revision:expectedRevision,status:expectedStatus};
    if(!expectedType||row.event_type!==expectedType||row.revision_before!==row.expected_revision||row.revision!==expectedRevision
      ||row.receipt_before!==row.expected_revision||row.receipt_after!==expectedRevision||row.receipt_event_id!==row.event_id
      ||row.occurred_at!==row.created_at||row.snapshot_revision!==expectedRevision||row.revision_status!==expectedStatus
      ||row.public_data!==canonicalV17(publicData)
      ||row.requested_json!==canonicalV17(requested)||requested.idempotencyKey!==row.idempotency_key
      ||(row.command_type!=="create"&&requested.expectedRevision!==row.expected_revision)
      ||row.result_json!==canonicalV17(result)||row.snapshot_json!==canonicalV17(snapshot)
      ||canonicalV17(result.draft)!==row.snapshot_json||result.draft?.id!==row.draft_id||result.draft?.campaignId!==row.campaign_id
      ||result.draft?.revision!==expectedRevision||result.draft?.status!==expectedStatus
      ||result.receipt?.draftId!==row.draft_id||result.receipt?.commandId!==row.command_id
      ||result.receipt?.idempotencyKey!==row.idempotency_key||result.receipt?.revisionBefore!==row.expected_revision
      ||result.receipt?.revisionAfter!==expectedRevision||result.receipt?.occurredAt!==row.created_at
      ||(row.command_type==="finalize"?result.receipt?.eventId!==row.event_id:result.receipt?.type!==row.command_type))
      throw new Error("schema v19 character draft audit is inconsistent");
    const event={actorPrincipalId:row.actor_principal_id,campaignId:row.campaign_id,commandId:row.command_id,draftId:row.draft_id,
      eventId:row.event_id,occurredAt:row.occurred_at,publicData,revision:row.revision,revisionBefore:row.revision_before,type:row.event_type};
    return {...row,proposed_event_json:canonicalV17(event)};
  });
  const roots=db.prepare(`SELECT draft.*,history.revision history_revision,history.snapshot_json,
      creator.actor_principal_id creator_actor_principal_id
    FROM character_drafts_v19 draft
    JOIN character_draft_revisions_v19 history ON history.draft_id=draft.id AND history.revision=(
      SELECT max(candidate.revision) FROM character_draft_revisions_v19 candidate WHERE candidate.draft_id=draft.id)
    JOIN character_draft_commands_v19 creator ON creator.draft_id=draft.id AND creator.type='create'
    ORDER BY draft.id`).all() as Array<Record<string,any>>;
  const rootCount=(db.prepare("SELECT COUNT(*) count FROM character_drafts_v19").get() as {count:number}).count;
  if(roots.length!==rootCount)throw new Error("schema v19 character draft root has no latest immutable revision");
  const pinRows=db.prepare(`SELECT pack_id,pack_version,publication_digest FROM character_draft_pins_v19 WHERE draft_id=? ORDER BY position`);
  for(const root of roots){
    let snapshot:Record<string,any>,allocation:unknown,selections:unknown;
    try{snapshot=JSON.parse(root.snapshot_json);allocation=JSON.parse(root.allocation_json);selections=JSON.parse(root.selections_json);}
    catch{throw new Error("schema v19 character draft root is malformed");}
    const pins=(pinRows.all(root.id) as Array<Record<string,string>>).map((pin)=>({packId:pin.pack_id,packVersion:pin.pack_version,
      publicationDigest:pin.publication_digest}));
    if(root.history_revision!==root.revision||root.created_by_principal_id!==root.creator_actor_principal_id
      ||snapshot.id!==root.id||snapshot.campaignId!==root.campaign_id
      ||snapshot.personaId!==root.persona_id||snapshot.controllerPrincipalId!==root.controller_principal_id
      ||snapshot.status!==root.status||snapshot.durability!==root.durability||snapshot.expiresAt!==root.expires_at
      ||snapshot.revision!==root.revision||snapshot.rulesProfileId!==root.rules_profile_id
      ||snapshot.createdAt!==root.created_at||snapshot.updatedAt!==root.updated_at
      ||canonicalV17(snapshot.allocation)!==canonicalV17(allocation)||canonicalV17(snapshot.selections)!==canonicalV17(selections)
      ||canonicalV17(snapshot.pins)!==canonicalV17(pins))throw new Error("schema v19 character draft root drifted from latest immutable revision");
  }
  return validated;
}

/** Re-attest immutable audit data as well as DDL on every current startup. */
function validateV20DraftAudit(db:DatabaseDriver.Database):void{
  const expected=validateV19DraftAuditForMigration(db);
  const rows=db.prepare(`SELECT draft_id,command_id,campaign_id,actor_principal_id,proposed_event_id,
      proposed_event_type,proposed_event_json,proposed_result_json
    FROM character_draft_command_provenance_v20 ORDER BY draft_id,command_id`).all() as Array<Record<string,string>>;
  if(rows.length!==expected.length)throw new Error("schema v20 character draft provenance is incomplete");
  for(let index=0;index<rows.length;index+=1){
    const actual=rows[index]!,source=expected[index]!;
    if(actual.draft_id!==source.draft_id||actual.command_id!==source.command_id||actual.campaign_id!==source.campaign_id
      ||actual.actor_principal_id!==source.actor_principal_id||actual.proposed_event_id!==source.event_id
      ||actual.proposed_event_type!==source.event_type||actual.proposed_event_json!==source.proposed_event_json
      ||actual.proposed_result_json!==source.result_json)throw new Error("schema v20 character draft provenance is inconsistent");
  }
}

function migrate19to20(db:DatabaseDriver.Database):void{
  db.transaction(()=>{
    requireBuilderSchemaLayout(db,"v19",V19_BUILDER_TABLES,V19_BUILDER_INDEXES,V19_BUILDER_TRIGGERS);
    assertCanonicalV19BuilderSql(db);
    const proposals=validateV19DraftAuditForMigration(db);
    createCharacterBuilderProvenanceV20(db);
    const insert=db.prepare(`INSERT INTO character_draft_command_provenance_v20
      (draft_id,command_id,campaign_id,actor_principal_id,proposed_event_id,proposed_event_type,proposed_event_json,proposed_result_json)
      VALUES (?,?,?,?,?,?,?,?)`);
    for(const row of proposals)insert.run(row.draft_id,row.command_id,row.campaign_id,row.actor_principal_id,row.event_id,row.event_type,
      row.proposed_event_json,row.result_json);
    db.prepare("UPDATE meta SET value='20' WHERE key='schemaVersion'").run();
  })();
}

function migrate20to21(db:DatabaseDriver.Database):void{
  db.transaction(()=>{
    assertCharacterBuilderLayoutV20(db);
    validateV20DraftAudit(db);
    const markerCount=(db.prepare("SELECT COUNT(*) count FROM character_draft_campaign_deletions_v20").get() as {count:number}).count;
    if(markerCount!==0)throw new Error("schema v20 contains a persistent character draft deletion capability");
    createCharacterBuilderIntegrityV21(db);
    db.prepare("UPDATE meta SET value='21' WHERE key='schemaVersion'").run();
  })();
}

function migrate21to22(db:DatabaseDriver.Database):void{
  db.transaction(()=>{
    assertCharacterBuilderLayoutV21(db);
    validateV20DraftAudit(db);
    createCharacterBuilderIntegrityV22(db);
    db.prepare("UPDATE meta SET value='22' WHERE key='schemaVersion'").run();
  })();
}

const V23_PROGRESSION_LAYOUT_DIGEST="f68e713487a2e7a56f12781c30362bc710b14858b086bda543bd3184b0745a73";
function installProgressionProfilesV23(db:DatabaseDriver.Database):void{
  if(!db.prepare("SELECT 1 FROM rpg_rules_profiles WHERE rules_profile_id='velvet:rules:starter-v1'").get())return;
  const insert=db.prepare(`INSERT OR IGNORE INTO rpg_progression_profiles_v23
    (profile_id,rules_profile_id,mode,max_level,thresholds_json,profile_digest) VALUES (?,'velvet:rules:starter-v1',?,3,?,?)`);
  for(const mode of ["xp","milestone"] as const){
    const value=canonicalStarterProgressionProfile(mode);
    insert.run(value.profileId,mode,canonicalProgressionJson(value.thresholds),progressionProfileDigest(mode));
  }
}
function backfillCharacterProgressionV23(db:DatabaseDriver.Database):void{
  installProgressionProfilesV23(db);
  if(!db.prepare("SELECT 1 FROM rpg_progression_profiles_v23 WHERE profile_id=?").get(starterProgressionProfileId("xp")))return;
  const rows=db.prepare(`SELECT snapshot.campaign_character_id,snapshot.campaign_id,snapshot.sheet_id,snapshot.actor_id,
      snapshot.derived_json,snapshot.created_at,class.pack_id,class.pack_version,class.definition_id,class.level
    FROM character_derived_snapshots_v19 snapshot JOIN rpg_character_classes class ON class.sheet_id=snapshot.sheet_id AND class.position=0
    JOIN character_drafts_v19 draft ON draft.id=snapshot.draft_id AND draft.status='finalized'
    WHERE class.level=1 AND NOT EXISTS(SELECT 1 FROM character_progression_v23 progression WHERE progression.campaign_character_id=snapshot.campaign_character_id)
    ORDER BY snapshot.campaign_character_id`).all() as Array<Record<string,any>>;
  const root=db.prepare(`INSERT INTO character_progression_v23(campaign_character_id,campaign_id,sheet_id,actor_id,profile_id,
    class_pack_id,class_pack_version,class_kind,class_definition_id,level,total_xp,milestone_count,revision,derived_json,created_at,updated_at)
    VALUES(?,?,?,? ,?,?,?,'class',?,1,0,0,0,?,?,?)`);
  const snapshot=db.prepare("INSERT INTO character_progression_snapshots_v23(campaign_character_id,revision,command_id,snapshot_json,created_at) VALUES(?,0,NULL,?,?)");
  const power=db.prepare(`INSERT INTO character_known_powers_v23(campaign_character_id,kind,pack_id,pack_version,definition_id,
    source_level,source_choice_id,granted_by_command_id,granted_at) VALUES(?,?,?,?,?,1,NULL,NULL,?)`);
  for(const row of rows){
    const classRow=db.prepare("SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? AND kind='class' AND definition_id=?")
      .get(row.pack_id,row.pack_version,row.definition_id) as {definition_json:string}|undefined;if(!classRow)continue;
    const selectedClass=JSON.parse(classRow.definition_json) as any,statement=db.prepare("SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? AND kind='class-level' AND definition_id=?");
    let levels:any[];try{const referenced=(selectedClass.mechanics.levelRefs as Array<any>).map((reference)=>{const found=statement.get(reference.packId,reference.packVersion,reference.definitionId) as {definition_json:string}|undefined;if(!found)throw new Error("missing");return JSON.parse(found.definition_json);});
      levels=resolveSelectedClassProgression({selectedClass,availableDefinitions:referenced,profileMaximum:3});}catch{continue;}
    const raceRow=db.prepare(`SELECT definition.definition_json FROM rpg_campaign_sheets sheet JOIN rpg_catalog_definitions definition
      ON definition.pack_id=sheet.race_pack_id AND definition.pack_version=sheet.race_pack_version AND definition.kind='race' AND definition.definition_id=sheet.race_definition_id WHERE sheet.id=?`).get(row.sheet_id) as {definition_json:string}|undefined;
    if(!raceRow)continue;let initial;try{initial=resolveInitialKnownPowers({selectedRace:JSON.parse(raceRow.definition_json),levels});}catch{continue;}
    root.run(row.campaign_character_id,row.campaign_id,row.sheet_id,row.actor_id,starterProgressionProfileId("xp"),row.pack_id,row.pack_version,
      row.definition_id,row.derived_json,row.created_at,row.created_at);
    snapshot.run(row.campaign_character_id,canonicalV17({campaignCharacterId:row.campaign_character_id,level:1,totalXp:0,milestoneCount:0,
      revision:0,derived:JSON.parse(row.derived_json)}),row.created_at);
    for(const source of initial)power.run(row.campaign_character_id,source.reference.kind,source.reference.packId,source.reference.packVersion,source.reference.definitionId,row.created_at);
  }
}
function characterProgressionLayoutRowsV23(db:DatabaseDriver.Database):unknown[]{
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
    AND name NOT GLOB '*_v24*'
    AND (name GLOB '*progression*_v23*' OR name GLOB 'character_level_advancements_v23*' OR name GLOB 'character_known_powers_v23*'
      OR tbl_name GLOB '*progression*_v23*' OR tbl_name IN ('character_level_advancements_v23','character_known_powers_v23'))
    ORDER BY type,name`).all();
}
function characterProgressionLayoutDigestV23(db:DatabaseDriver.Database):string{
  const rows=(characterProgressionLayoutRowsV23(db) as Array<Record<string,any>>).map((row)=>({...row,sql:row.sql?.replace(/\s+/g," ").trim()}));
  return createHash("sha256").update(canonicalV17(rows)).digest("hex");
}
function assertCharacterProgressionLayoutV23(db:DatabaseDriver.Database):void{
  const row=db.prepare("SELECT prior_layout_digest,current_layout_digest FROM character_progression_layout_attestation_v23 WHERE singleton=1").get() as {prior_layout_digest:string;current_layout_digest:string}|undefined;
  const actual=characterProgressionLayoutDigestV23(db);
  if(!row||row.prior_layout_digest!==V22_BUILDER_LAYOUT_DIGEST||row.current_layout_digest!==actual
    ||actual!==V23_PROGRESSION_LAYOUT_DIGEST)
    throw new Error(`schema v23 progression canonical SQL is incompatible (${actual})`);
  const expectedTables=["rpg_progression_profiles_v23","character_progression_v23","character_progression_commands_v23",
    "character_progression_ledger_v23","character_level_advancements_v23","character_progression_pending_choices_v23",
    "character_known_powers_v23","character_progression_snapshots_v23","character_progression_receipts_v23","character_progression_layout_attestation_v23"];
  for(const table of expectedTables)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error(`schema v23 progression artifact ${table} is missing`);
}
function validateCharacterProgressionV23(db:DatabaseDriver.Database):void{
  const invalid=db.prepare(`SELECT root.campaign_character_id FROM character_progression_v23 root
    LEFT JOIN character_progression_snapshots_v23 snapshot ON snapshot.campaign_character_id=root.campaign_character_id AND snapshot.revision=root.revision
    WHERE snapshot.campaign_character_id IS NULL OR root.total_xp<>coalesce((SELECT sum(xp_delta) FROM character_progression_ledger_v23 ledger WHERE ledger.campaign_character_id=root.campaign_character_id),0)
      OR root.milestone_count<>coalesce((SELECT sum(milestone_delta) FROM character_progression_ledger_v23 ledger WHERE ledger.campaign_character_id=root.campaign_character_id),0)
      OR root.level<>(SELECT level FROM rpg_character_classes class WHERE class.sheet_id=root.sheet_id AND class.position=0)
      OR json_extract(snapshot.snapshot_json,'$.campaignCharacterId')<>root.campaign_character_id
      OR json_extract(snapshot.snapshot_json,'$.revision')<>root.revision OR json_extract(snapshot.snapshot_json,'$.level')<>root.level
      OR json_extract(snapshot.snapshot_json,'$.totalXp')<>root.total_xp OR json_extract(snapshot.snapshot_json,'$.milestoneCount')<>root.milestone_count
      OR json(snapshot.snapshot_json->'$.derived')<>json(root.derived_json) LIMIT 1`).get();
  if(invalid)throw new Error("schema v23 progression root-ledger-snapshot integrity is inconsistent");
  const incomplete=db.prepare(`SELECT command.command_id FROM character_progression_commands_v23 command
    LEFT JOIN character_progression_receipts_v23 receipt ON receipt.campaign_character_id=command.campaign_character_id AND receipt.command_id=command.command_id
    LEFT JOIN character_progression_snapshots_v23 snapshot ON snapshot.campaign_character_id=command.campaign_character_id AND snapshot.command_id=command.command_id
    WHERE receipt.command_id IS NULL OR snapshot.command_id IS NULL OR receipt.result_json<>command.proposed_result_json
      OR receipt.revision_before<>command.expected_revision OR receipt.revision_after<>command.expected_revision+1 LIMIT 1`).get();
  if(incomplete)throw new Error("schema v23 progression command provenance is incomplete");
  const graphForgery=db.prepare(`SELECT root.campaign_character_id FROM character_progression_v23 root WHERE
    (SELECT count(*) FROM character_progression_snapshots_v23 snapshot WHERE snapshot.campaign_character_id=root.campaign_character_id)
      <>1+(SELECT count(*) FROM character_progression_commands_v23 command WHERE command.campaign_character_id=root.campaign_character_id)
    OR (SELECT count(*) FROM character_level_advancements_v23 advancement WHERE advancement.campaign_character_id=root.campaign_character_id)<>root.level-1
    OR EXISTS(SELECT 1 FROM character_level_advancements_v23 advancement JOIN character_progression_commands_v23 command
      ON command.campaign_character_id=advancement.campaign_character_id AND command.command_id=advancement.command_id
      WHERE advancement.campaign_character_id=root.campaign_character_id AND (command.type<>'apply-levels'
        OR json_extract(advancement.changes_json,'$.level')<>advancement.level
        OR json_extract(command.requested_json,'$.previewToken')<>advancement.preview_token))
    OR EXISTS(SELECT 1 FROM character_progression_ledger_v23 ledger JOIN character_progression_commands_v23 command
      ON command.campaign_character_id=ledger.campaign_character_id AND command.command_id=ledger.command_id
      WHERE ledger.campaign_character_id=root.campaign_character_id AND
        ((ledger.kind='xp' AND command.type<>'grant-xp') OR (ledger.kind='milestone' AND command.type<>'grant-milestone')
          OR (ledger.kind='correction' AND command.type<>'correct-xp')))
    OR EXISTS(SELECT 1 FROM character_known_powers_v23 power WHERE power.campaign_character_id=root.campaign_character_id
      AND ((power.source_level=1 AND power.granted_by_command_id IS NOT NULL) OR (power.source_level>1 AND NOT EXISTS(
        SELECT 1 FROM character_level_advancements_v23 advancement WHERE advancement.campaign_character_id=power.campaign_character_id
          AND advancement.command_id=power.granted_by_command_id AND advancement.level=power.source_level
          AND EXISTS(SELECT 1 FROM json_each(advancement.changes_json,
            CASE power.kind WHEN 'ability' THEN '$.fixedAbilities' ELSE '$.spells' END) ref
            WHERE json_extract(ref.value,'$.packId')=power.pack_id AND json_extract(ref.value,'$.packVersion')=power.pack_version
              AND json_extract(ref.value,'$.kind')=power.kind AND json_extract(ref.value,'$.definitionId')=power.definition_id)
          OR power.kind='ability' AND EXISTS(SELECT 1 FROM json_each(advancement.changes_json,'$.selectedAbilities') ref
            WHERE json_extract(ref.value,'$.packId')=power.pack_id AND json_extract(ref.value,'$.packVersion')=power.pack_version
              AND json_extract(ref.value,'$.definitionId')=power.definition_id))))) LIMIT 1`).get();
  if(graphForgery)throw new Error("schema v23 progression advancement provenance is inconsistent");
  const commands=db.prepare(`SELECT command.*,receipt.revision_before,receipt.revision_after,receipt.result_json,snapshot.snapshot_json
    FROM character_progression_commands_v23 command JOIN character_progression_receipts_v23 receipt
      ON receipt.campaign_character_id=command.campaign_character_id AND receipt.command_id=command.command_id
    JOIN character_progression_snapshots_v23 snapshot ON snapshot.campaign_character_id=command.campaign_character_id AND snapshot.command_id=command.command_id
    ORDER BY command.campaign_character_id,command.expected_revision`).all() as Array<Record<string,any>>;
  for(const command of commands){
    let request:any,result:any,snapshot:any;try{request=JSON.parse(command.requested_json);result=JSON.parse(command.result_json);snapshot=JSON.parse(command.snapshot_json);}catch{throw new Error("schema v23 progression command provenance is malformed");}
    if(command.requested_json!==canonicalV17(request)||command.result_json!==canonicalV17(result)
      ||command.request_digest!==createHash("sha256").update(canonicalV17(request)).digest("hex")
      ||request.idempotencyKey!==command.idempotency_key||result.receipt?.commandId!==command.command_id
      ||result.receipt?.campaignCharacterId!==command.campaign_character_id||result.receipt?.idempotencyKey!==command.idempotency_key
      ||result.receipt?.type!==command.type||result.receipt?.revisionBefore!==command.expected_revision
      ||result.receipt?.revisionAfter!==command.expected_revision+1||result.progression?.revision!==command.expected_revision+1
      ||result.progression?.campaignCharacterId!==command.campaign_character_id||snapshot.revision!==command.expected_revision+1
      ||snapshot.level!==result.progression?.level||snapshot.totalXp!==result.progression?.totalXp
      ||snapshot.milestoneCount!==result.progression?.milestoneCount||canonicalV17(snapshot.derived)!==canonicalV17(result.progression?.derived))
      throw new Error("schema v23 progression command provenance is inconsistent");
  }
}
function progressionEventForCommandV24(db:DatabaseDriver.Database,command:Record<string,any>,persistedEventId?:string){
  const eventId=persistedEventId??`pv24:${createHash("sha256").update(`${command.campaign_character_id}\0${command.command_id}`).digest("hex").slice(0,48)}`;
  let type:"progress_granted"|"progress_corrected"|"levels_applied",publicData:Record<string,unknown>;
  if(command.type==="grant-xp"||command.type==="grant-milestone"){
    const ledger=db.prepare("SELECT kind,xp_delta,milestone_delta FROM character_progression_ledger_v23 WHERE campaign_character_id=? AND command_id=?")
      .get(command.campaign_character_id,command.command_id) as any;
    if(!ledger)throw new Error("progression grant event has no exact ledger source");
    type="progress_granted";publicData={kind:"grant",mode:ledger.kind==="xp"?"xp":"milestone",amount:ledger.kind==="xp"?ledger.xp_delta:ledger.milestone_delta};
  }else if(command.type==="correct-xp"){
    const ledger=db.prepare("SELECT correction_of_entry_id,reason FROM character_progression_ledger_v23 WHERE campaign_character_id=? AND command_id=? AND kind='correction'")
      .get(command.campaign_character_id,command.command_id) as any;
    if(!ledger)throw new Error("progression correction event has no exact ledger source");
    type="progress_corrected";publicData={kind:"correction",correctedEntryId:ledger.correction_of_entry_id,reason:ledger.reason};
  }else{
    const levels=(db.prepare("SELECT level FROM character_level_advancements_v23 WHERE campaign_character_id=? AND command_id=? ORDER BY position")
      .all(command.campaign_character_id,command.command_id) as Array<{level:number}>).map((row)=>row.level);
    if(!levels.length)throw new Error("progression apply event has no exact advancement source");
    type="levels_applied";publicData={kind:"advancement",levels};
  }
  const event={campaignCharacterId:command.campaign_character_id,commandId:command.command_id,eventId,occurredAt:command.created_at,
    publicData,revision:command.expected_revision+1,type};
  return {eventId,type,event,publicData};
}
function expectedPowerSourcesV24(db:DatabaseDriver.Database,row:ProgressionRootRow,catalog:ReturnType<typeof loadExactProgressionCatalog>){
  return expectedKnownPowerSources(db,row,catalog);
}
function backfillCharacterProgressionIntegrityV24(db:DatabaseDriver.Database):void{
  for(const profile of db.prepare("SELECT * FROM rpg_progression_profiles_v23 ORDER BY profile_id").all() as Array<any>)assertCanonicalProgressionProfile(profile);
  const roots=db.prepare("SELECT * FROM character_progression_v23 ORDER BY campaign_character_id").all() as ProgressionRootRow[];
  const insertBootstrap=db.prepare(`INSERT INTO character_progression_bootstrap_v24(campaign_character_id,race_pack_id,race_pack_version,race_kind,race_definition_id,
    class_progression_json,class_progression_digest,initial_powers_json,initial_powers_digest,created_at) VALUES(?,?,?,'race',?,?,?,?,?,?)`);
  const insertSource=db.prepare(`INSERT INTO character_known_power_sources_v24(campaign_character_id,kind,pack_id,pack_version,definition_id,source_kind,source_reference_json,source_digest)
    VALUES(?,?,?,?,?,?,?,?)`);
  const insertPending=db.prepare(`INSERT INTO character_progression_pending_snapshots_v24(campaign_character_id,revision,command_id,pending_json,pending_digest,created_at) VALUES(?,?,?,?,?,?)`);
  for(const row of roots){
    let catalog:ReturnType<typeof loadExactProgressionCatalog>;
    try{catalog=loadExactProgressionCatalog(db,row);}catch(error){
      const commands=(db.prepare("SELECT count(*) count FROM character_progression_commands_v23 WHERE campaign_character_id=?").get(row.campaign_character_id) as {count:number}).count;
      if(commands)throw error;continue;
    }
    const sheet=db.prepare("SELECT race_pack_id,race_pack_version,race_definition_id FROM rpg_campaign_sheets WHERE id=?").get(row.sheet_id) as any;
    const levelsJson=canonicalV17(catalog.levels),initialJson=canonicalV17(catalog.initialPowers);
    insertBootstrap.run(row.campaign_character_id,sheet.race_pack_id,sheet.race_pack_version,sheet.race_definition_id,levelsJson,
      progressionCatalogDigest(catalog.levels),initialJson,progressionCatalogDigest(catalog.initialPowers),row.created_at);
    const expected=expectedPowerSourcesV24(db,row,catalog);
    const actual=db.prepare("SELECT kind,pack_id,pack_version,definition_id FROM character_known_powers_v23 WHERE campaign_character_id=?")
      .all(row.campaign_character_id) as Array<any>;
    if(actual.length!==expected.size)throw new Error("known powers do not equal exact selected race/class and advancement grants");
    for(const power of actual){const key=progressionReferenceKey({kind:power.kind,packId:power.pack_id,packVersion:power.pack_version,definitionId:power.definition_id});const source=expected.get(key);
      if(!source)throw new Error("known power has no exact selected source provenance");const sourceJson=canonicalV17(source.sourceReference);
      insertSource.run(row.campaign_character_id,power.kind,power.pack_id,power.pack_version,power.definition_id,source.sourceKind,sourceJson,progressionCatalogDigest(source.sourceReference));}
    const initialPending:unknown[]=[];
    insertPending.run(row.campaign_character_id,0,null,canonicalV17(initialPending),progressionCatalogDigest(initialPending),row.created_at);
    const commands=db.prepare(`SELECT command_id,expected_revision,proposed_result_json,created_at FROM character_progression_commands_v23
      WHERE campaign_character_id=? ORDER BY expected_revision`).all(row.campaign_character_id) as Array<Record<string,any>>;
    for(const command of commands){const result=JSON.parse(command.proposed_result_json),pending=result.progression?.pendingChoices;
      if(!Array.isArray(pending))throw new Error("progression command has no exact pending choice result");
      insertPending.run(row.campaign_character_id,command.expected_revision+1,command.command_id,canonicalV17(pending),progressionCatalogDigest(pending),command.created_at);}
  }
  const proposal=db.prepare(`INSERT INTO character_progression_command_proposals_v24(campaign_character_id,command_id,proposed_event_id,proposed_event_type,proposed_event_json,proposed_result_json) VALUES(?,?,?,?,?,?)`);
  const eventInsert=db.prepare(`INSERT INTO character_progression_events_v24(event_id,campaign_character_id,command_id,type,revision_before,revision,occurred_at,public_data) VALUES(?,?,?,?,?,?,?,?)`);
  for(const command of db.prepare(`SELECT command.* FROM character_progression_commands_v23 command
      JOIN character_progression_bootstrap_v24 bootstrap ON bootstrap.campaign_character_id=command.campaign_character_id
      ORDER BY command.campaign_character_id,command.expected_revision`).all() as Array<Record<string,any>>){
    const resolved=progressionEventForCommandV24(db,command),eventJson=canonicalV17(resolved.event),publicJson=canonicalV17(resolved.publicData);
    proposal.run(command.campaign_character_id,command.command_id,resolved.eventId,resolved.type,eventJson,command.proposed_result_json);
    eventInsert.run(resolved.eventId,command.campaign_character_id,command.command_id,resolved.type,command.expected_revision,command.expected_revision+1,command.created_at,publicJson);
  }
}
// SHA-256 of the canonicalized sqlite_master rows selected by
// characterProgressionLayoutRowsV24. Keep this fixed so startup detects DDL
// drift instead of blessing whichever schema happened to be created.
const V24_PROGRESSION_LAYOUT_DIGEST="e056d9df1ec9f9c00cc1aba740f2acc91b40cc7b03a5716cb75e79ec8df6bec8";
function characterProgressionLayoutRowsV24(db:DatabaseDriver.Database):unknown[]{return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
  AND (name GLOB '*_v24' OR name GLOB '*_v24_*' OR tbl_name GLOB '*_v24' OR tbl_name GLOB '*_v24_*') ORDER BY type,name`).all();}
function characterProgressionLayoutDigestV24(db:DatabaseDriver.Database):string{const rows=(characterProgressionLayoutRowsV24(db) as Array<any>).map((row)=>({...row,sql:row.sql?.replace(/\s+/g," ").trim()}));return createHash("sha256").update(canonicalV17(rows)).digest("hex");}
function assertCharacterProgressionLayoutV24(db:DatabaseDriver.Database):void{const row=db.prepare("SELECT prior_layout_digest,current_layout_digest FROM character_progression_layout_attestation_v24 WHERE singleton=1").get() as any;
  const actual=characterProgressionLayoutDigestV24(db);if(!row||row.prior_layout_digest!==V23_PROGRESSION_LAYOUT_DIGEST||row.current_layout_digest!==actual||actual!==V24_PROGRESSION_LAYOUT_DIGEST)throw new Error(`schema v24 progression canonical SQL is incompatible (${actual})`);}
function validateCharacterProgressionV24(db:DatabaseDriver.Database):void{
  for(const profile of db.prepare("SELECT * FROM rpg_progression_profiles_v23 ORDER BY profile_id").all() as Array<any>)assertCanonicalProgressionProfile(profile);
  const roots=db.prepare(`SELECT root.* FROM character_progression_v23 root JOIN character_progression_bootstrap_v24 bootstrap ON bootstrap.campaign_character_id=root.campaign_character_id ORDER BY root.campaign_character_id`).all() as ProgressionRootRow[];
  for(const row of roots){const catalog=loadExactProgressionCatalog(db,row),bootstrap=db.prepare("SELECT * FROM character_progression_bootstrap_v24 WHERE campaign_character_id=?").get(row.campaign_character_id) as any;
    const sheet=db.prepare("SELECT race_pack_id,race_pack_version,race_definition_id FROM rpg_campaign_sheets WHERE id=?").get(row.sheet_id) as any;
    const levelsJson=canonicalV17(catalog.levels),initialJson=canonicalV17(catalog.initialPowers);if(bootstrap.race_pack_id!==sheet.race_pack_id||bootstrap.race_pack_version!==sheet.race_pack_version
      ||bootstrap.race_kind!=="race"||bootstrap.race_definition_id!==sheet.race_definition_id||bootstrap.class_progression_json!==levelsJson||bootstrap.class_progression_digest!==progressionCatalogDigest(catalog.levels)
      ||bootstrap.initial_powers_json!==initialJson||bootstrap.initial_powers_digest!==progressionCatalogDigest(catalog.initialPowers))throw new Error("progression bootstrap catalog provenance is inconsistent");
    const expected=expectedPowerSourcesV24(db,row,catalog),actual=db.prepare(`SELECT power.*,source.source_kind,source.source_reference_json,source.source_digest
      FROM character_known_powers_v23 power LEFT JOIN character_known_power_sources_v24 source ON source.campaign_character_id=power.campaign_character_id AND source.kind=power.kind
        AND source.pack_id=power.pack_id AND source.pack_version=power.pack_version AND source.definition_id=power.definition_id WHERE power.campaign_character_id=?`).all(row.campaign_character_id) as Array<any>;
    if(actual.length!==expected.size)throw new Error("known power provenance is incomplete");for(const power of actual){const reference={kind:power.kind,packId:power.pack_id,packVersion:power.pack_version,definitionId:power.definition_id};assertPowerDefinitionExists(db,reference);const source=expected.get(progressionReferenceKey(reference));
      if(!source||power.source_kind!==source.sourceKind||power.source_reference_json!==canonicalV17(source.sourceReference)||power.source_digest!==progressionCatalogDigest(source.sourceReference))throw new Error("known power exact source provenance is inconsistent");}
    const pendingRows=db.prepare("SELECT * FROM character_progression_pending_snapshots_v24 WHERE campaign_character_id=? ORDER BY revision").all(row.campaign_character_id) as Array<any>;
    if(pendingRows.length!==row.revision+1)throw new Error("progression pending choice provenance is incomplete");
    for(const pending of pendingRows){let expected:unknown[]=[],commandId:null|string=null,createdAt=row.created_at;
      if(pending.revision>0){const command=db.prepare("SELECT command_id,proposed_result_json,created_at FROM character_progression_commands_v23 WHERE campaign_character_id=? AND expected_revision=?")
        .get(row.campaign_character_id,pending.revision-1) as any;if(!command)throw new Error("progression pending choice has no exact command");
        const result=JSON.parse(command.proposed_result_json);expected=result.progression?.pendingChoices;commandId=command.command_id;createdAt=command.created_at;}
      const expectedJson=canonicalV17(expected);if(!Array.isArray(expected)||pending.command_id!==commandId||pending.created_at!==createdAt
        ||pending.pending_json!==expectedJson||pending.pending_digest!==progressionCatalogDigest(expected))throw new Error("progression pending choice provenance is inconsistent");}
    const preview=calculateAuthoritativeProgressionPreview(db,row),current=pendingRows.at(-1),currentJson=canonicalV17(preview.pendingChoices);
    if(!current||current.revision!==row.revision||current.pending_json!==currentJson||current.pending_digest!==progressionCatalogDigest(preview.pendingChoices))throw new Error("progression pending choice provenance is inconsistent");
  }
  const unsupportedCommand=db.prepare(`SELECT 1 FROM character_progression_commands_v23 command LEFT JOIN character_progression_bootstrap_v24 bootstrap
    ON bootstrap.campaign_character_id=command.campaign_character_id WHERE bootstrap.campaign_character_id IS NULL LIMIT 1`).get();if(unsupportedCommand)throw new Error("unsupported progression root has command history");
  const commands=db.prepare(`SELECT command.*,proposal.*,event.event_id actual_event_id,event.type actual_type,event.revision_before,event.revision,event.occurred_at,event.public_data,receipt.result_json
    FROM character_progression_commands_v23 command JOIN character_progression_bootstrap_v24 bootstrap ON bootstrap.campaign_character_id=command.campaign_character_id
    LEFT JOIN character_progression_command_proposals_v24 proposal ON proposal.campaign_character_id=command.campaign_character_id AND proposal.command_id=command.command_id
    LEFT JOIN character_progression_events_v24 event ON event.campaign_character_id=command.campaign_character_id AND event.command_id=command.command_id
    LEFT JOIN character_progression_receipts_v23 receipt ON receipt.campaign_character_id=command.campaign_character_id AND receipt.command_id=command.command_id`).all() as Array<any>;
  for(const command of commands){const expected=progressionEventForCommandV24(db,command,command.proposed_event_id),eventJson=canonicalV17(expected.event),publicJson=canonicalV17(expected.publicData);
    if(command.proposed_event_id!==expected.eventId||command.proposed_event_type!==expected.type||command.proposed_event_json!==eventJson
      ||command.proposed_result_json!==command.result_json||command.actual_event_id!==expected.eventId||command.actual_type!==expected.type
      ||command.revision_before!==command.expected_revision||command.revision!==command.expected_revision+1||command.occurred_at!==command.created_at||command.public_data!==publicJson)
      throw new Error("progression command/proposal/event/receipt provenance is inconsistent");}
}
function migrate22to23(db:DatabaseDriver.Database):void{
  db.transaction(()=>{
    assertCharacterBuilderLayoutV22(db);validateV20DraftAudit(db);
    createCharacterProgressionV23(db);
    db.prepare("UPDATE meta SET value='23' WHERE key='schemaVersion'").run();
  })();
}
function migrate23to24(db:DatabaseDriver.Database):void{db.transaction(()=>{assertCharacterProgressionLayoutV23(db);validateCharacterProgressionV23(db);createCharacterProgressionIntegrityV24(db);db.prepare("UPDATE meta SET value='24' WHERE key='schemaVersion'").run();})();}

/** Additive v25r1 persistence foundation for resources, possessions, economy, trade, and rest. */
function createResourcesInventoryEconomyRestV25(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_actor_resource_charges_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, resource_name TEXT NOT NULL,
      current_charges INTEGER NOT NULL CHECK(typeof(current_charges)='integer' AND current_charges BETWEEN 0 AND 9007199254740991),
      maximum_charges INTEGER NOT NULL CHECK(typeof(maximum_charges)='integer' AND maximum_charges BETWEEN 0 AND 9007199254740991),
      CHECK(current_charges<=maximum_charges), PRIMARY KEY(campaign_id,actor_id,resource_name),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(actor_id,resource_name) REFERENCES rpg_actor_resources(actor_id,name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_actor_resource_ammunition_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, resource_name TEXT NOT NULL,
      current_ammunition INTEGER NOT NULL CHECK(typeof(current_ammunition)='integer' AND current_ammunition BETWEEN 0 AND 9007199254740991),
      maximum_ammunition INTEGER NOT NULL CHECK(typeof(maximum_ammunition)='integer' AND maximum_ammunition BETWEEN 0 AND 9007199254740991),
      CHECK(current_ammunition<=maximum_ammunition), PRIMARY KEY(campaign_id,actor_id,resource_name),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(actor_id,resource_name) REFERENCES rpg_actor_resources(actor_id,name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_actor_resource_bindings_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, resource_name TEXT NOT NULL,
      binding_key TEXT NOT NULL CHECK(length(binding_key) BETWEEN 1 AND 128 AND binding_key=trim(binding_key)),
      binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND json_type(binding_json)='object'),
      PRIMARY KEY(campaign_id,actor_id,resource_name),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(actor_id,resource_name) REFERENCES rpg_actor_resources(actor_id,name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_actor_resource_capacities_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, resource_name TEXT NOT NULL,
      used_capacity INTEGER NOT NULL CHECK(typeof(used_capacity)='integer' AND used_capacity BETWEEN 0 AND 9007199254740991),
      maximum_capacity INTEGER NOT NULL CHECK(typeof(maximum_capacity)='integer' AND maximum_capacity BETWEEN 0 AND 9007199254740991),
      CHECK(used_capacity<=maximum_capacity), PRIMARY KEY(campaign_id,actor_id,resource_name),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(actor_id,resource_name) REFERENCES rpg_actor_resources(actor_id,name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_inventory_entries_v25 (
      entry_id TEXT PRIMARY KEY CHECK(length(entry_id) BETWEEN 1 AND 128 AND entry_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, item_pack_id TEXT NOT NULL, item_pack_version TEXT NOT NULL,
      item_kind TEXT NOT NULL CHECK(item_kind='item'), item_definition_id TEXT NOT NULL,
      entry_mode TEXT NOT NULL CHECK(entry_mode IN ('stackable','instanced')),
      quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 1 AND 9007199254740991),
      instance_key TEXT, slot_key TEXT CHECK(slot_key IS NULL OR (length(slot_key) BETWEEN 1 AND 128 AND slot_key=trim(slot_key))),
      equipped INTEGER NOT NULL DEFAULT 0 CHECK(typeof(equipped)='integer' AND equipped IN (0,1)),
       created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      CHECK((entry_mode='stackable' AND instance_key IS NULL) OR (entry_mode='instanced' AND instance_key IS NOT NULL AND quantity=1)),
      CHECK(equipped=0 OR slot_key IS NOT NULL), UNIQUE(campaign_id,actor_id,instance_key),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,item_pack_id,item_pack_version,item_kind,item_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE UNIQUE INDEX uq_rpg_inventory_entries_v25_equipped_slot ON rpg_inventory_entries_v25(campaign_id,actor_id,slot_key) WHERE equipped=1;
    CREATE INDEX idx_rpg_inventory_entries_v25_actor ON rpg_inventory_entries_v25(campaign_id,actor_id,created_at);
    -- This sidecar turns an otherwise global catalog definition into an exact,
    -- campaign-pinned identity.  The current-pins parent has no key containing
    -- pack_version, so its actual (campaign_id,pack_id) key is used here and a
    -- guard below verifies the version before the sidecar can be inserted.
    CREATE TABLE rpg_campaign_catalog_definitions_v25 (
      campaign_id TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      kind TEXT NOT NULL, definition_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,pack_id,pack_version,kind,definition_id),
      FOREIGN KEY(campaign_id,pack_id) REFERENCES campaign_catalog_current_pins(campaign_id,pack_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(pack_id,pack_version,kind,definition_id) REFERENCES rpg_catalog_definitions(pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER rpg_campaign_catalog_definitions_v25_require_exact_pin BEFORE INSERT ON rpg_campaign_catalog_definitions_v25
      WHEN NOT EXISTS(SELECT 1 FROM campaign_catalog_current_pins pin WHERE pin.campaign_id=NEW.campaign_id AND pin.pack_id=NEW.pack_id AND pin.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'campaign catalog definition requires an exact current pin'); END;
    CREATE TABLE rpg_wallets_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      currency_code TEXT NOT NULL CHECK(length(currency_code) BETWEEN 3 AND 16 AND currency_code NOT GLOB '*[^A-Z0-9._:-]*'),
      balance_minor INTEGER NOT NULL CHECK(typeof(balance_minor)='integer' AND balance_minor BETWEEN -9007199254740991 AND 9007199254740991),
       updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,currency_code),
       FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,currency_code) REFERENCES rpg_currency_references_v25(campaign_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_currency_ledger_v25 (
      entry_id TEXT PRIMARY KEY CHECK(length(entry_id) BETWEEN 1 AND 128 AND entry_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, currency_code TEXT NOT NULL, delta_minor INTEGER NOT NULL
        CHECK(typeof(delta_minor)='integer' AND delta_minor BETWEEN -9007199254740991 AND 9007199254740991 AND delta_minor<>0),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason=trim(reason)), reference_type TEXT NOT NULL CHECK(length(reference_type) BETWEEN 1 AND 64), reference_id TEXT,
       occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY(campaign_id,actor_id,currency_code) REFERENCES rpg_wallets_v25(campaign_id,actor_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,currency_code) REFERENCES rpg_currency_references_v25(campaign_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX idx_rpg_currency_ledger_v25_wallet ON rpg_currency_ledger_v25(campaign_id,actor_id,currency_code,occurred_at,entry_id);
    CREATE TABLE rpg_shop_definitions_v25 (
      shop_id TEXT PRIMARY KEY CHECK(length(shop_id) BETWEEN 1 AND 128 AND shop_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL,
       name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name=trim(name)), created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,shop_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_shop_stock_v25 (
      stock_id TEXT PRIMARY KEY CHECK(length(stock_id) BETWEEN 1 AND 128 AND stock_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, shop_id TEXT NOT NULL,
      item_pack_id TEXT NOT NULL, item_pack_version TEXT NOT NULL, item_kind TEXT NOT NULL CHECK(item_kind='item'), item_definition_id TEXT NOT NULL,
      available_quantity INTEGER NOT NULL CHECK(typeof(available_quantity)='integer' AND available_quantity BETWEEN 0 AND 9007199254740991),
      unit_price_minor INTEGER NOT NULL CHECK(typeof(unit_price_minor)='integer' AND unit_price_minor BETWEEN 0 AND 9007199254740991), currency_code TEXT NOT NULL,
       UNIQUE(campaign_id,stock_id),
       UNIQUE(campaign_id,stock_id,shop_id,currency_code),
       UNIQUE(campaign_id,shop_id,item_pack_id,item_pack_version,item_kind,item_definition_id),
       FOREIGN KEY(campaign_id,shop_id) REFERENCES rpg_shop_definitions_v25(campaign_id,shop_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,item_pack_id,item_pack_version,item_kind,item_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,currency_code) REFERENCES rpg_currency_references_v25(campaign_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_shop_quotes_v25 (
       quote_id TEXT PRIMARY KEY CHECK(length(quote_id) BETWEEN 1 AND 128 AND quote_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, stock_id TEXT NOT NULL, shop_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 1 AND 9007199254740991), unit_price_minor INTEGER NOT NULL CHECK(typeof(unit_price_minor)='integer' AND unit_price_minor BETWEEN 0 AND 9007199254740991), currency_code TEXT NOT NULL,
       quoted_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',quoted_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',quoted_at)=quoted_at AND substr(quoted_at,12,2) BETWEEN '00' AND '23'), expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at AND substr(expires_at,12,2) BETWEEN '00' AND '23'), CHECK(expires_at>quoted_at),
       UNIQUE(campaign_id,quote_id,actor_id,shop_id),
       FOREIGN KEY(campaign_id,stock_id,shop_id,currency_code) REFERENCES rpg_shop_stock_v25(campaign_id,stock_id,shop_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,currency_code) REFERENCES rpg_currency_references_v25(campaign_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_trade_proposals_v25 (
      trade_id TEXT PRIMARY KEY CHECK(length(trade_id) BETWEEN 1 AND 128 AND trade_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, proposer_actor_id TEXT NOT NULL, recipient_actor_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','accepted','declined','cancelled','settled')), offer_json TEXT NOT NULL CHECK(json_valid(offer_json) AND json_type(offer_json)='object'), request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
       created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'), expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at AND substr(expires_at,12,2) BETWEEN '00' AND '23'), CHECK(proposer_actor_id<>recipient_actor_id AND expires_at>created_at),
      UNIQUE(campaign_id,trade_id),
      FOREIGN KEY(campaign_id,proposer_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,recipient_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_trade_settlement_receipts_v25 (
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) BETWEEN 1 AND 128 AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'), trade_id TEXT NOT NULL UNIQUE, campaign_id TEXT NOT NULL,
       settlement_json TEXT NOT NULL CHECK(json_valid(settlement_json) AND json_type(settlement_json)='object'), settled_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',settled_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',settled_at)=settled_at AND substr(settled_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY(campaign_id,trade_id) REFERENCES rpg_trade_proposals_v25(campaign_id,trade_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_rest_receipts_v25 (
       receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) BETWEEN 1 AND 128 AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      rest_kind TEXT NOT NULL CHECK(rest_kind IN ('short','long')), changed_resources_json TEXT NOT NULL CHECK(json_valid(changed_resources_json) AND json_type(changed_resources_json)='array'),
       occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
       FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m15_receipts_v25(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    -- currency_code is an opaque local key, never a semantic currency label:
    -- this sidecar gives it one exact campaign-pinned catalog currency.
    CREATE TABLE rpg_currency_references_v25 (
      campaign_id TEXT NOT NULL, currency_code TEXT NOT NULL CHECK(length(currency_code) BETWEEN 1 AND 128 AND currency_code NOT GLOB '*[^A-Za-z0-9._:-]*'),
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind='currency'), definition_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,currency_code), UNIQUE(campaign_id,pack_id,pack_version,kind,definition_id),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,pack_id,pack_version,kind,definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(pack_id,pack_version,kind,definition_id) REFERENCES rpg_catalog_definitions(pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_purchase_receipts_v25 (
      purchase_id TEXT PRIMARY KEY CHECK(length(purchase_id) BETWEEN 1 AND 128), quote_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL, shop_id TEXT NOT NULL, buyer_actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity>0), total_json TEXT NOT NULL CHECK(json_valid(total_json) AND json_type(total_json)='object'),
      purchased_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',purchased_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',purchased_at)=purchased_at AND substr(purchased_at,12,2) BETWEEN '00' AND '23'), idempotency_key TEXT NOT NULL,
      FOREIGN KEY(campaign_id,quote_id,buyer_actor_id,shop_id) REFERENCES rpg_shop_quotes_v25(campaign_id,quote_id,actor_id,shop_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,buyer_actor_id,command_id,resulting_revision) REFERENCES rpg_m15_receipts_v25(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER rpg_purchase_receipts_v25_immutable_update BEFORE UPDATE ON rpg_purchase_receipts_v25 BEGIN SELECT RAISE(ABORT,'purchase receipts are immutable'); END;
    CREATE TRIGGER rpg_purchase_receipts_v25_immutable_delete BEFORE DELETE ON rpg_purchase_receipts_v25 BEGIN SELECT RAISE(ABORT,'purchase receipts are immutable'); END;
    -- M1.5 mutations use a new sidecar revision stream rather than changing
    -- the pre-existing campaign actor or resource aggregates.  One stream per
    -- campaign actor gives every resource, possession, money, trade, purchase,
    -- and rest command a common optimistic-concurrency boundary.
    CREATE TABLE rpg_m15_mutation_revisions_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_m15_commands_v25 (
      command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      command_family TEXT NOT NULL CHECK(command_family IN ('resource','inventory','economy','purchase','trade','rest')),
      command_type TEXT NOT NULL CHECK(length(command_type) BETWEEN 1 AND 128 AND command_type=trim(command_type)),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest GLOB '[0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991 AND resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,command_id),
      UNIQUE(campaign_id,actor_id,idempotency_key), UNIQUE(campaign_id,actor_id,resulting_revision), UNIQUE(campaign_id,actor_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES rpg_m15_mutation_revisions_v25(campaign_id,actor_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX idx_rpg_m15_commands_v25_retry ON rpg_m15_commands_v25(campaign_id,actor_id,idempotency_key);
    CREATE TABLE rpg_m15_receipts_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      canonical_result_json TEXT NOT NULL CHECK(json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest GLOB '[0-9a-f]*'),
      changed_keys_json TEXT NOT NULL CHECK(json_valid(changed_keys_json) AND json_type(changed_keys_json)='array'),
      changed_keys_digest TEXT NOT NULL CHECK(length(changed_keys_digest)=64 AND changed_keys_digest GLOB '[0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,command_id), UNIQUE(campaign_id,actor_id,resulting_revision), UNIQUE(campaign_id,actor_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m15_commands_v25(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_m15_receipt_changed_keys_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
      changed_key TEXT NOT NULL CHECK(length(changed_key) BETWEEN 1 AND 256 AND changed_key=trim(changed_key)),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      PRIMARY KEY(campaign_id,actor_id,command_id,changed_key),
      UNIQUE(campaign_id,actor_id,changed_key,resulting_revision),
      FOREIGN KEY(campaign_id,actor_id,command_id) REFERENCES rpg_m15_receipts_v25(campaign_id,actor_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    -- A cross-actor command advances a counterpart stream without inventing a
    -- second client command.  This immutable relation is its audit receipt.
    CREATE TABLE rpg_m15_counterpart_receipts_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
      counterpart_actor_id TEXT NOT NULL, revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL,
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,command_id,counterpart_actor_id),
      UNIQUE(campaign_id,counterpart_actor_id,revision_after),
      CHECK(actor_id<>counterpart_actor_id AND revision_after=revision_before+1),
      FOREIGN KEY(campaign_id,actor_id,command_id) REFERENCES rpg_m15_commands_v25(campaign_id,actor_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,counterpart_actor_id) REFERENCES rpg_m15_mutation_revisions_v25(campaign_id,actor_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX idx_rpg_m15_receipt_changed_keys_v25_conflicts ON rpg_m15_receipt_changed_keys_v25(campaign_id,actor_id,changed_key,resulting_revision);
    CREATE TABLE rpg_resources_inventory_economy_layout_attestation_v25 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), prior_layout_digest TEXT NOT NULL CHECK(length(prior_layout_digest)=64), current_layout_digest TEXT NOT NULL CHECK(length(current_layout_digest)=64)
    );
    CREATE TRIGGER rpg_currency_ledger_v25_immutable_update BEFORE UPDATE ON rpg_currency_ledger_v25 BEGIN SELECT RAISE(ABORT,'currency ledger is append-only'); END;
    CREATE TRIGGER rpg_currency_ledger_v25_immutable_delete BEFORE DELETE ON rpg_currency_ledger_v25 BEGIN SELECT RAISE(ABORT,'currency ledger is append-only'); END;
    CREATE TRIGGER rpg_shop_quotes_v25_immutable_update BEFORE UPDATE ON rpg_shop_quotes_v25 BEGIN SELECT RAISE(ABORT,'shop quotes are immutable'); END;
    CREATE TRIGGER rpg_shop_quotes_v25_immutable_delete BEFORE DELETE ON rpg_shop_quotes_v25 BEGIN SELECT RAISE(ABORT,'shop quotes are immutable'); END;
    CREATE TRIGGER rpg_trade_settlement_receipts_v25_immutable_update BEFORE UPDATE ON rpg_trade_settlement_receipts_v25 BEGIN SELECT RAISE(ABORT,'trade settlement receipts are immutable'); END;
    CREATE TRIGGER rpg_trade_settlement_receipts_v25_immutable_delete BEFORE DELETE ON rpg_trade_settlement_receipts_v25 BEGIN SELECT RAISE(ABORT,'trade settlement receipts are immutable'); END;
    CREATE TRIGGER rpg_rest_receipts_v25_immutable_update BEFORE UPDATE ON rpg_rest_receipts_v25 BEGIN SELECT RAISE(ABORT,'rest receipts are immutable'); END;
    CREATE TRIGGER rpg_rest_receipts_v25_immutable_delete BEFORE DELETE ON rpg_rest_receipts_v25 BEGIN SELECT RAISE(ABORT,'rest receipts are immutable'); END;
    CREATE TRIGGER rpg_m15_mutation_revisions_v25_revision_guard BEFORE UPDATE ON rpg_m15_mutation_revisions_v25
      WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.actor_id<>OLD.actor_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
      BEGIN SELECT RAISE(ABORT,'M1.5 mutation revision must advance exactly once'); END;
    CREATE TRIGGER rpg_m15_mutation_revisions_v25_retain_delete BEFORE DELETE ON rpg_m15_mutation_revisions_v25 BEGIN SELECT RAISE(ABORT,'M1.5 mutation revisions are retained'); END;
    CREATE TRIGGER rpg_m15_commands_v25_immutable_update BEFORE UPDATE ON rpg_m15_commands_v25 BEGIN SELECT RAISE(ABORT,'M1.5 commands are immutable'); END;
    CREATE TRIGGER rpg_m15_commands_v25_immutable_delete BEFORE DELETE ON rpg_m15_commands_v25 BEGIN SELECT RAISE(ABORT,'M1.5 commands are immutable'); END;
    CREATE TRIGGER rpg_m15_commands_v25_prevent_replace BEFORE INSERT ON rpg_m15_commands_v25 WHEN EXISTS(
      SELECT 1 FROM rpg_m15_commands_v25 old WHERE old.campaign_id=NEW.campaign_id AND old.actor_id=NEW.actor_id AND (old.command_id=NEW.command_id OR old.idempotency_key=NEW.idempotency_key OR old.resulting_revision=NEW.resulting_revision)
    ) BEGIN SELECT RAISE(ABORT,'M1.5 commands are immutable'); END;
    CREATE TRIGGER rpg_m15_receipts_v25_immutable_update BEFORE UPDATE ON rpg_m15_receipts_v25 BEGIN SELECT RAISE(ABORT,'M1.5 receipts are immutable'); END;
    CREATE TRIGGER rpg_m15_receipts_v25_immutable_delete BEFORE DELETE ON rpg_m15_receipts_v25 BEGIN SELECT RAISE(ABORT,'M1.5 receipts are immutable'); END;
    CREATE TRIGGER rpg_m15_receipts_v25_require_command BEFORE INSERT ON rpg_m15_receipts_v25 WHEN NOT EXISTS(
      SELECT 1 FROM rpg_m15_commands_v25 command WHERE command.campaign_id=NEW.campaign_id AND command.actor_id=NEW.actor_id AND command.command_id=NEW.command_id AND command.resulting_revision=NEW.resulting_revision AND command.created_at=NEW.occurred_at
    ) BEGIN SELECT RAISE(ABORT,'M1.5 receipt must match its exact command'); END;
    CREATE TRIGGER rpg_m15_receipt_changed_keys_v25_immutable_update BEFORE UPDATE ON rpg_m15_receipt_changed_keys_v25 BEGIN SELECT RAISE(ABORT,'M1.5 changed keys are append-only'); END;
    CREATE TRIGGER rpg_m15_receipt_changed_keys_v25_immutable_delete BEFORE DELETE ON rpg_m15_receipt_changed_keys_v25 BEGIN SELECT RAISE(ABORT,'M1.5 changed keys are append-only'); END;
    CREATE TRIGGER rpg_m15_receipt_changed_keys_v25_require_receipt BEFORE INSERT ON rpg_m15_receipt_changed_keys_v25 WHEN NOT EXISTS(
      SELECT 1 FROM rpg_m15_receipts_v25 receipt WHERE receipt.campaign_id=NEW.campaign_id AND receipt.actor_id=NEW.actor_id AND receipt.command_id=NEW.command_id AND receipt.resulting_revision=NEW.resulting_revision
    ) BEGIN SELECT RAISE(ABORT,'M1.5 changed key must match its exact receipt'); END;
    CREATE TRIGGER rpg_m15_counterpart_receipts_v25_immutable_update BEFORE UPDATE ON rpg_m15_counterpart_receipts_v25 BEGIN SELECT RAISE(ABORT,'M1.5 counterpart receipts are immutable'); END;
    CREATE TRIGGER rpg_m15_counterpart_receipts_v25_immutable_delete BEFORE DELETE ON rpg_m15_counterpart_receipts_v25 BEGIN SELECT RAISE(ABORT,'M1.5 counterpart receipts are immutable'); END;
    CREATE TRIGGER rpg_wallets_v25_no_negative_insert BEFORE INSERT ON rpg_wallets_v25 WHEN NEW.balance_minor<0 BEGIN SELECT RAISE(ABORT,'wallet balance cannot be negative'); END;
    CREATE TRIGGER rpg_wallets_v25_no_negative_update BEFORE UPDATE OF balance_minor ON rpg_wallets_v25 WHEN NEW.balance_minor<0 BEGIN SELECT RAISE(ABORT,'wallet balance cannot be negative'); END;
    CREATE TRIGGER rpg_shop_quotes_v25_total_range BEFORE INSERT ON rpg_shop_quotes_v25
      WHEN NEW.unit_price_minor>0 AND NEW.quantity>9007199254740991/NEW.unit_price_minor
      BEGIN SELECT RAISE(ABORT,'quote total exceeds supported currency range'); END;
    CREATE TRIGGER rpg_trade_proposals_v25_immutable_terms BEFORE UPDATE OF campaign_id,proposer_actor_id,recipient_actor_id,offer_json,request_json,created_at,expires_at ON rpg_trade_proposals_v25 BEGIN SELECT RAISE(ABORT,'trade terms are immutable'); END;
    CREATE TRIGGER rpg_resources_inventory_economy_layout_attestation_v25_immutable_update BEFORE UPDATE ON rpg_resources_inventory_economy_layout_attestation_v25 BEGIN SELECT RAISE(ABORT,'v25 layout attestation is immutable'); END;
    CREATE TRIGGER rpg_resources_inventory_economy_layout_attestation_v25_immutable_delete BEFORE DELETE ON rpg_resources_inventory_economy_layout_attestation_v25 BEGIN SELECT RAISE(ABORT,'v25 layout attestation is immutable'); END;
  `);
  const current = resourcesInventoryEconomyRestLayoutDigestV25(db);
  db.prepare("INSERT INTO rpg_resources_inventory_economy_layout_attestation_v25(singleton,prior_layout_digest,current_layout_digest) VALUES(1,?,?)").run(V24_PROGRESSION_LAYOUT_DIGEST, current);
}
const V25_RESOURCES_INVENTORY_ECONOMY_LAYOUT_DIGEST = "a5e3a58f8014978315d20440a0ac087871edac95323d059327faa2fe0a983ef7";
function resourcesInventoryEconomyRestLayoutRowsV25(db: DatabaseDriver.Database): unknown[] { return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name GLOB '*_v25' OR name GLOB '*_v25_*' OR tbl_name GLOB '*_v25' OR tbl_name GLOB '*_v25_*') ORDER BY type,name`).all(); }
function resourcesInventoryEconomyRestLayoutDigestV25(db: DatabaseDriver.Database): string { const rows = (resourcesInventoryEconomyRestLayoutRowsV25(db) as Array<any>).map((row) => ({...row, sql: row.sql?.replace(/\s+/g, " ").trim()})); return createHash("sha256").update(canonicalV17(rows)).digest("hex"); }
function assertResourcesInventoryEconomyRestLayoutV25(db: DatabaseDriver.Database): void { const row = db.prepare("SELECT prior_layout_digest,current_layout_digest FROM rpg_resources_inventory_economy_layout_attestation_v25 WHERE singleton=1").get() as any; const actual = resourcesInventoryEconomyRestLayoutDigestV25(db); if (!row || row.prior_layout_digest !== V24_PROGRESSION_LAYOUT_DIGEST || row.current_layout_digest !== actual || actual !== V25_RESOURCES_INVENTORY_ECONOMY_LAYOUT_DIGEST) throw new Error(`schema v25 resources/inventory/economy canonical SQL is incompatible (${actual})`); }
/** Re-attests the immutable M1.5 command graph after the fixed DDL attestation. */
function validateM15PersistenceV25(db: DatabaseDriver.Database): void {
  const digest = (value: unknown) => createHash("sha256").update(canonicalV17(value)).digest("hex");
  const commands = db.prepare(`SELECT command.*, receipt.resulting_revision receipt_revision, receipt.canonical_result_json,
      receipt.result_digest, receipt.changed_keys_json, receipt.changed_keys_digest, receipt.occurred_at
    FROM rpg_m15_commands_v25 command LEFT JOIN rpg_m15_receipts_v25 receipt
      ON receipt.campaign_id=command.campaign_id AND receipt.actor_id=command.actor_id AND receipt.command_id=command.command_id
    ORDER BY command.campaign_id,command.actor_id,command.resulting_revision`).all() as Array<any>;
  const commandCount = (db.prepare("SELECT count(*) count FROM rpg_m15_commands_v25").get() as {count:number}).count;
  const receiptCount = (db.prepare("SELECT count(*) count FROM rpg_m15_receipts_v25").get() as {count:number}).count;
  if (commands.length !== commandCount || receiptCount !== commandCount) throw new Error("M1.5 command receipt graph is incomplete");
  for (const command of commands) {
    let request: any, result: any, changedKeys: unknown;
    try { request = JSON.parse(command.canonical_request_json); result = JSON.parse(command.canonical_result_json); changedKeys = JSON.parse(command.changed_keys_json); }
    catch { throw new Error("M1.5 command receipt graph is malformed"); }
    if (!command.canonical_result_json || command.canonical_request_json !== canonicalV17(request)
      || command.request_digest !== digest(request) || command.canonical_result_json !== canonicalV17(result)
      || command.result_digest !== digest(result) || !Array.isArray(changedKeys)
      || changedKeys.some((key) => typeof key !== "string")
      || command.changed_keys_json !== canonicalV17([...new Set(changedKeys)].sort())
      || command.changed_keys_digest !== digest(changedKeys)
      || command.receipt_revision !== command.resulting_revision || command.occurred_at !== command.created_at
      || result?.receipt?.commandId !== command.command_id || result.receipt?.idempotencyKey !== command.idempotency_key
      || result.receipt?.revisionBefore !== command.expected_revision || result.receipt?.revisionAfter !== command.resulting_revision
      || result.receipt?.occurredAt !== command.created_at || canonicalV17(result.receipt?.changedKeys) !== command.changed_keys_json)
      throw new Error("M1.5 command receipt provenance is inconsistent");
    const keyRows = db.prepare(`SELECT changed_key,resulting_revision FROM rpg_m15_receipt_changed_keys_v25
      WHERE campaign_id=? AND actor_id=? AND command_id=? ORDER BY changed_key`).all(command.campaign_id,command.actor_id,command.command_id) as Array<any>;
    if (keyRows.some((row) => row.resulting_revision !== command.resulting_revision)
      || canonicalV17(keyRows.map((row) => row.changed_key)) !== command.changed_keys_json)
      throw new Error("M1.5 changed-key provenance is inconsistent");
  }
  const roots = db.prepare("SELECT * FROM rpg_m15_mutation_revisions_v25 ORDER BY campaign_id,actor_id").all() as Array<any>;
  for (const root of roots) {
    const history = db.prepare(`SELECT resulting_revision revision,expected_revision revision_before,created_at occurred_at FROM rpg_m15_commands_v25 WHERE campaign_id=? AND actor_id=?
      UNION ALL SELECT revision_after,revision_before,occurred_at FROM rpg_m15_counterpart_receipts_v25 WHERE campaign_id=? AND counterpart_actor_id=?
      ORDER BY revision`).all(root.campaign_id,root.actor_id,root.campaign_id,root.actor_id) as Array<any>;
    if (history.length !== root.revision || history.some((row,index) => row.revision !== index+1 || row.revision_before !== index)
      || (history.length > 0 && root.updated_at !== history.at(-1)!.occurred_at))
      throw new Error("M1.5 revision root history is inconsistent");
  }
  const counterparts = db.prepare(`SELECT counterpart.*,command.created_at FROM rpg_m15_counterpart_receipts_v25 counterpart
    LEFT JOIN rpg_m15_commands_v25 command ON command.campaign_id=counterpart.campaign_id AND command.actor_id=counterpart.actor_id AND command.command_id=counterpart.command_id
    ORDER BY counterpart.campaign_id,counterpart.actor_id,counterpart.command_id,counterpart.counterpart_actor_id`).all() as Array<any>;
  for (const counterpart of counterparts) if (!counterpart.created_at || counterpart.actor_id===counterpart.counterpart_actor_id
    || counterpart.revision_after!==counterpart.revision_before+1 || counterpart.occurred_at!==counterpart.created_at)
    throw new Error("M1.5 counterpart revision provenance is inconsistent");
  const requireOne = (table:string, predicate:string, message:string) => {
    const invalid = db.prepare(`SELECT command.command_id FROM rpg_m15_commands_v25 command LEFT JOIN ${table} receipt ON ${predicate}
      WHERE ${message} LIMIT 1`).get(); if (invalid) throw new Error("M1.5 domain receipt provenance is inconsistent");
  };
  requireOne("rpg_purchase_receipts_v25", "receipt.purchase_id=command.command_id AND receipt.campaign_id=command.campaign_id AND receipt.buyer_actor_id=command.actor_id AND receipt.command_id=command.command_id AND receipt.resulting_revision=command.resulting_revision", "command.command_type='purchase_from_shop' AND (receipt.purchase_id IS NULL OR receipt.purchased_at<>command.created_at OR receipt.idempotency_key<>command.idempotency_key)");
  requireOne("rpg_rest_receipts_v25", "receipt.receipt_id=command.command_id AND receipt.campaign_id=command.campaign_id AND receipt.actor_id=command.actor_id AND receipt.command_id=command.command_id AND receipt.resulting_revision=command.resulting_revision", "command.command_family='rest' AND (receipt.receipt_id IS NULL OR receipt.occurred_at<>command.created_at OR (command.command_type='take_short_rest' AND receipt.rest_kind<>'short') OR (command.command_type='take_long_rest' AND receipt.rest_kind<>'long'))");
  requireOne("rpg_trade_settlement_receipts_v25", "receipt.receipt_id=command.command_id AND receipt.campaign_id=command.campaign_id", "command.command_type='accept_bilateral_trade' AND (receipt.receipt_id IS NULL OR receipt.settled_at<>command.created_at)");
  const orphanDomain = db.prepare(`SELECT 1 FROM rpg_purchase_receipts_v25 receipt LEFT JOIN rpg_m15_commands_v25 command ON command.command_id=receipt.command_id AND command.campaign_id=receipt.campaign_id AND command.actor_id=receipt.buyer_actor_id AND command.resulting_revision=receipt.resulting_revision WHERE command.command_id IS NULL OR command.command_type<>'purchase_from_shop'
    UNION ALL SELECT 1 FROM rpg_rest_receipts_v25 receipt LEFT JOIN rpg_m15_commands_v25 command ON command.command_id=receipt.command_id AND command.campaign_id=receipt.campaign_id AND command.actor_id=receipt.actor_id AND command.resulting_revision=receipt.resulting_revision WHERE command.command_id IS NULL OR command.command_family<>'rest'
    UNION ALL SELECT 1 FROM rpg_trade_settlement_receipts_v25 receipt LEFT JOIN rpg_m15_commands_v25 command ON command.command_id=receipt.receipt_id AND command.campaign_id=receipt.campaign_id WHERE command.command_id IS NULL OR command.command_type<>'accept_bilateral_trade' LIMIT 1`).get();
  if (orphanDomain) throw new Error("M1.5 domain receipt provenance is inconsistent");
}
function migrate24to25(db: DatabaseDriver.Database): void { db.transaction(() => { assertCharacterProgressionLayoutV24(db); validateCharacterProgressionV24(db); createResourcesInventoryEconomyRestV25(db); db.prepare("UPDATE meta SET value='25' WHERE key='schemaVersion'").run(); })(); }

/** Additive v26r1 persistence for deterministic checks, powers, and typed effects. */
function createChecksPowersEffectsV26(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_m16_mutation_revisions_v26 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_m16_commands_v26 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      command_family TEXT NOT NULL CHECK(command_family IN ('check','power','effect')), command_type TEXT NOT NULL CHECK(command_type IN ('resolve_check','use_power','apply_effect','remove_effect','advance_effect_duration')),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(length(canonical_request_json) BETWEEN 2 AND 32768 AND json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest GLOB '[0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,command_id), UNIQUE(campaign_id,actor_id,idempotency_key), UNIQUE(campaign_id,actor_id,resulting_revision), UNIQUE(campaign_id,actor_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES rpg_m16_mutation_revisions_v26(campaign_id,actor_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_m16_receipts_v26 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      canonical_result_json TEXT NOT NULL CHECK(length(canonical_result_json) BETWEEN 2 AND 32768 AND json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest GLOB '[0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,command_id), UNIQUE(campaign_id,actor_id,resulting_revision), UNIQUE(campaign_id,actor_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_commands_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_m16_events_v26 (
      event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('check_resolved','power_used','effect_applied','effect_removed','effect_duration_advanced')),
      event_json TEXT NOT NULL CHECK(length(event_json) BETWEEN 2 AND 32768 AND json_valid(event_json) AND json_type(event_json)='object'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,actor_id,command_id),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_receipts_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_check_results_v26 (
      check_id TEXT PRIMARY KEY CHECK(length(check_id) BETWEEN 1 AND 128 AND check_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      check_kind TEXT NOT NULL CHECK(check_kind IN ('ability','skill','save','attack','opposed')), check_key TEXT NOT NULL CHECK(check_key IN ('might','agility','resolve','insight','presence','craft','melee','ranged','spell','defense')),
      target_actor_id TEXT, difficulty INTEGER CHECK(typeof(difficulty)='integer' AND difficulty BETWEEN 0 AND 1000),
      dice_json TEXT NOT NULL CHECK(length(dice_json) BETWEEN 2 AND 4096 AND json_valid(dice_json) AND json_type(dice_json)='array' AND json_array_length(dice_json) BETWEEN 1 AND 32),
      result_json TEXT NOT NULL CHECK(length(result_json) BETWEEN 2 AND 8192 AND json_valid(result_json) AND json_type(result_json)='object'), total INTEGER NOT NULL CHECK(typeof(total)='integer' AND total BETWEEN -9007199254740991 AND 9007199254740991),
      resolved_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at)=resolved_at AND substr(resolved_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,actor_id,command_id),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_receipts_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,target_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_power_uses_v26 (
      power_use_id TEXT PRIMARY KEY CHECK(length(power_use_id) BETWEEN 1 AND 128 AND power_use_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      power_pack_id TEXT NOT NULL, power_pack_version TEXT NOT NULL, power_kind TEXT NOT NULL CHECK(power_kind IN ('ability','spell')), power_definition_id TEXT NOT NULL,
      slot_kind TEXT NOT NULL CHECK(slot_kind IN ('none','slot','charge','resource')), slot_level INTEGER CHECK(typeof(slot_level)='integer' AND slot_level BETWEEN 0 AND 20),
      target_actor_id TEXT, use_json TEXT NOT NULL CHECK(length(use_json) BETWEEN 2 AND 8192 AND json_valid(use_json) AND json_type(use_json)='object'),
      used_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',used_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',used_at)=used_at AND substr(used_at,12,2) BETWEEN '00' AND '23'),
      CHECK((slot_kind='slot' AND slot_level IS NOT NULL) OR (slot_kind<>'slot' AND slot_level IS NULL)), UNIQUE(campaign_id,actor_id,command_id),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_receipts_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,target_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,power_pack_id,power_pack_version,power_kind,power_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_power_use_costs_v26 (
      power_use_id TEXT NOT NULL, cost_ordinal INTEGER NOT NULL CHECK(typeof(cost_ordinal)='integer' AND cost_ordinal BETWEEN 0 AND 31),
      cost_kind TEXT NOT NULL CHECK(cost_kind IN ('slot','charge','resource')), resource_name TEXT NOT NULL CHECK(length(resource_name) BETWEEN 1 AND 128 AND resource_name=trim(resource_name)), amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 1 AND 1000000),
      PRIMARY KEY(power_use_id,cost_ordinal),
      FOREIGN KEY(power_use_id) REFERENCES rpg_power_uses_v26(power_use_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_effect_modifier_vocabulary_v26 (
      modifier_kind TEXT PRIMARY KEY CHECK(modifier_kind IN ('flat','proficiency','advantage','resistance','vulnerability','immunity'))
    );
    INSERT INTO rpg_effect_modifier_vocabulary_v26(modifier_kind) VALUES ('flat'),('proficiency'),('advantage'),('resistance'),('vulnerability'),('immunity');
    CREATE TABLE rpg_active_effects_v26 (
      effect_id TEXT PRIMARY KEY CHECK(length(effect_id) BETWEEN 1 AND 128 AND effect_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      source_pack_id TEXT, source_pack_version TEXT, source_kind TEXT CHECK(source_kind IS NULL OR source_kind IN ('ability','spell')), source_definition_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','removed','expired')), concentration_key TEXT,
      duration_kind TEXT NOT NULL CHECK(duration_kind IN ('until_removed','rounds','until_timestamp')), remaining_rounds INTEGER, expires_at TEXT,
      recovery_kind TEXT NOT NULL CHECK(recovery_kind IN ('none','short_rest','long_rest')), state_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 0 AND 9007199254740991), last_lifecycle_event_id TEXT,
      applied_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',applied_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',applied_at)=applied_at AND substr(applied_at,12,2) BETWEEN '00' AND '23'), updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'), ended_at TEXT CHECK(ended_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ',ended_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',ended_at)=ended_at AND substr(ended_at,12,2) BETWEEN '00' AND '23')),
      CHECK((source_pack_id IS NULL AND source_pack_version IS NULL AND source_kind IS NULL AND source_definition_id IS NULL) OR (source_pack_id IS NOT NULL AND source_pack_version IS NOT NULL AND source_kind IS NOT NULL AND source_definition_id IS NOT NULL)),
      CHECK((duration_kind='rounds' AND remaining_rounds BETWEEN 0 AND 100000 AND expires_at IS NULL) OR (duration_kind='until_timestamp' AND remaining_rounds IS NULL AND expires_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at AND substr(expires_at,12,2) BETWEEN '00' AND '23') OR (duration_kind='until_removed' AND remaining_rounds IS NULL AND expires_at IS NULL)),
      CHECK((status='active' AND ended_at IS NULL) OR (status<>'active' AND ended_at IS NOT NULL)),
      UNIQUE(campaign_id,actor_id,command_id),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_receipts_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,source_pack_id,source_pack_version,source_kind,source_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE UNIQUE INDEX uq_rpg_active_effects_v26_concentration ON rpg_active_effects_v26(campaign_id,actor_id,concentration_key) WHERE status='active' AND concentration_key IS NOT NULL;
    CREATE TABLE rpg_effect_lifecycle_events_v26 (
      lifecycle_event_id TEXT PRIMARY KEY CHECK(length(lifecycle_event_id) BETWEEN 1 AND 128 AND lifecycle_event_id NOT GLOB '*[^A-Za-z0-9._:-]*'), effect_id TEXT NOT NULL, campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      lifecycle_kind TEXT NOT NULL CHECK(lifecycle_kind IN ('applied','removed','concentration_replaced','duration_advanced')), remaining_rounds INTEGER CHECK(remaining_rounds IS NULL OR (typeof(remaining_rounds)='integer' AND remaining_rounds BETWEEN 0 AND 100000)),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,actor_id,command_id,effect_id),
      FOREIGN KEY(effect_id) REFERENCES rpg_active_effects_v26(effect_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_receipts_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_effect_modifiers_v26 (
      effect_id TEXT NOT NULL, modifier_ordinal INTEGER NOT NULL CHECK(typeof(modifier_ordinal)='integer' AND modifier_ordinal BETWEEN 0 AND 127),
      modifier_kind TEXT NOT NULL CHECK(modifier_kind IN ('flat','proficiency','advantage','resistance','vulnerability','immunity')), applies_to_id TEXT NOT NULL CHECK(length(applies_to_id) BETWEEN 1 AND 128 AND applies_to_id=trim(applies_to_id)),
      amount INTEGER CHECK(typeof(amount)='integer' AND amount BETWEEN -10000 AND 10000),
      PRIMARY KEY(effect_id,modifier_ordinal),
      FOREIGN KEY(effect_id) REFERENCES rpg_active_effects_v26(effect_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(modifier_kind) REFERENCES rpg_effect_modifier_vocabulary_v26(modifier_kind) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK((modifier_kind='flat' AND amount IS NOT NULL) OR (modifier_kind='proficiency' AND amount BETWEEN 0 AND 10000) OR (modifier_kind IN ('advantage','resistance','vulnerability','immunity') AND amount IS NULL))
    );
    CREATE TABLE rpg_checks_powers_effects_layout_attestation_v26 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), prior_layout_digest TEXT NOT NULL CHECK(length(prior_layout_digest)=64), current_layout_digest TEXT NOT NULL CHECK(length(current_layout_digest)=64)
    );
    CREATE TRIGGER rpg_m16_mutation_revisions_v26_revision_guard BEFORE UPDATE ON rpg_m16_mutation_revisions_v26 WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.actor_id<>OLD.actor_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at BEGIN SELECT RAISE(ABORT,'M1.6 mutation revision must advance exactly once'); END;
    CREATE TRIGGER rpg_m16_mutation_revisions_v26_retain_delete BEFORE DELETE ON rpg_m16_mutation_revisions_v26 BEGIN SELECT RAISE(ABORT,'M1.6 mutation revisions are retained'); END;
    CREATE TRIGGER rpg_m16_commands_v26_immutable_update BEFORE UPDATE ON rpg_m16_commands_v26 BEGIN SELECT RAISE(ABORT,'M1.6 commands are immutable'); END;
    CREATE TRIGGER rpg_m16_commands_v26_immutable_delete BEFORE DELETE ON rpg_m16_commands_v26 BEGIN SELECT RAISE(ABORT,'M1.6 commands are immutable'); END;
    CREATE TRIGGER rpg_m16_receipts_v26_immutable_update BEFORE UPDATE ON rpg_m16_receipts_v26 BEGIN SELECT RAISE(ABORT,'M1.6 receipts are immutable'); END;
    CREATE TRIGGER rpg_m16_receipts_v26_immutable_delete BEFORE DELETE ON rpg_m16_receipts_v26 BEGIN SELECT RAISE(ABORT,'M1.6 receipts are immutable'); END;
    CREATE TRIGGER rpg_m16_events_v26_immutable_update BEFORE UPDATE ON rpg_m16_events_v26 BEGIN SELECT RAISE(ABORT,'M1.6 events are immutable'); END;
    CREATE TRIGGER rpg_m16_events_v26_immutable_delete BEFORE DELETE ON rpg_m16_events_v26 BEGIN SELECT RAISE(ABORT,'M1.6 events are immutable'); END;
    CREATE TRIGGER rpg_check_results_v26_immutable_update BEFORE UPDATE ON rpg_check_results_v26 BEGIN SELECT RAISE(ABORT,'check results are immutable'); END;
    CREATE TRIGGER rpg_check_results_v26_immutable_delete BEFORE DELETE ON rpg_check_results_v26 BEGIN SELECT RAISE(ABORT,'check results are immutable'); END;
    CREATE TRIGGER rpg_power_uses_v26_immutable_update BEFORE UPDATE ON rpg_power_uses_v26 BEGIN SELECT RAISE(ABORT,'power uses are immutable'); END;
    CREATE TRIGGER rpg_power_uses_v26_immutable_delete BEFORE DELETE ON rpg_power_uses_v26 BEGIN SELECT RAISE(ABORT,'power uses are immutable'); END;
    CREATE TRIGGER rpg_power_use_costs_v26_immutable_update BEFORE UPDATE ON rpg_power_use_costs_v26 BEGIN SELECT RAISE(ABORT,'power use costs are immutable'); END;
    CREATE TRIGGER rpg_power_use_costs_v26_immutable_delete BEFORE DELETE ON rpg_power_use_costs_v26 BEGIN SELECT RAISE(ABORT,'power use costs are immutable'); END;
    CREATE TRIGGER rpg_effect_lifecycle_events_v26_immutable_update BEFORE UPDATE ON rpg_effect_lifecycle_events_v26 BEGIN SELECT RAISE(ABORT,'effect lifecycle events are immutable'); END;
    CREATE TRIGGER rpg_effect_lifecycle_events_v26_immutable_delete BEFORE DELETE ON rpg_effect_lifecycle_events_v26 BEGIN SELECT RAISE(ABORT,'effect lifecycle events are immutable'); END;
    CREATE TRIGGER rpg_effect_lifecycle_events_v26_require_command BEFORE INSERT ON rpg_effect_lifecycle_events_v26
      WHEN NOT EXISTS(SELECT 1 FROM rpg_m16_commands_v26 command WHERE command.campaign_id=NEW.campaign_id AND command.actor_id=NEW.actor_id AND command.command_id=NEW.command_id AND command.resulting_revision=NEW.resulting_revision AND ((NEW.lifecycle_kind='applied' AND command.command_type='apply_effect') OR (NEW.lifecycle_kind='concentration_replaced' AND command.command_type='apply_effect') OR (NEW.lifecycle_kind='removed' AND command.command_type='remove_effect') OR (NEW.lifecycle_kind='duration_advanced' AND command.command_type='advance_effect_duration')))
      BEGIN SELECT RAISE(ABORT,'effect lifecycle event must match its exact command'); END;
    CREATE TRIGGER rpg_active_effects_v26_lifecycle_guard BEFORE UPDATE ON rpg_active_effects_v26
      WHEN NEW.effect_id<>OLD.effect_id OR NEW.campaign_id<>OLD.campaign_id OR NEW.actor_id<>OLD.actor_id OR NEW.command_id<>OLD.command_id OR NEW.resulting_revision<>OLD.resulting_revision OR NEW.applied_at<>OLD.applied_at OR NEW.state_revision<>OLD.state_revision+1 OR NEW.updated_at<OLD.updated_at OR NEW.last_lifecycle_event_id IS NULL OR NOT EXISTS(SELECT 1 FROM rpg_effect_lifecycle_events_v26 event WHERE event.lifecycle_event_id=NEW.last_lifecycle_event_id AND event.effect_id=NEW.effect_id AND event.campaign_id=NEW.campaign_id AND event.actor_id=NEW.actor_id AND event.occurred_at=NEW.updated_at AND ((NOT (NEW.remaining_rounds IS OLD.remaining_rounds) AND event.lifecycle_kind='duration_advanced') OR (NEW.remaining_rounds IS OLD.remaining_rounds AND NEW.status<>OLD.status AND event.lifecycle_kind IN ('removed','concentration_replaced'))))
      BEGIN SELECT RAISE(ABORT,'active effects advance only from an immutable lifecycle event'); END;
    CREATE TRIGGER rpg_effect_modifiers_v26_immutable_update BEFORE UPDATE ON rpg_effect_modifiers_v26 BEGIN SELECT RAISE(ABORT,'effect modifiers are immutable'); END;
    CREATE TRIGGER rpg_effect_modifiers_v26_immutable_delete BEFORE DELETE ON rpg_effect_modifiers_v26 BEGIN SELECT RAISE(ABORT,'effect modifiers are immutable'); END;
    CREATE TRIGGER rpg_checks_powers_effects_layout_attestation_v26_immutable_update BEFORE UPDATE ON rpg_checks_powers_effects_layout_attestation_v26 BEGIN SELECT RAISE(ABORT,'v26 layout attestation is immutable'); END;
    CREATE TRIGGER rpg_checks_powers_effects_layout_attestation_v26_immutable_delete BEFORE DELETE ON rpg_checks_powers_effects_layout_attestation_v26 BEGIN SELECT RAISE(ABORT,'v26 layout attestation is immutable'); END;
  `);
  const current = checksPowersEffectsLayoutDigestV26(db);
  db.prepare("INSERT INTO rpg_checks_powers_effects_layout_attestation_v26(singleton,prior_layout_digest,current_layout_digest) VALUES(1,?,?)").run(V25_RESOURCES_INVENTORY_ECONOMY_LAYOUT_DIGEST, current);
}
const V26_CHECKS_POWERS_EFFECTS_LAYOUT_DIGEST = "7e3fe64f425173022d119f156f60eb36b26af2c97f29d40975f5579caa660f6a";
function checksPowersEffectsLayoutRowsV26(db: DatabaseDriver.Database): unknown[] { return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name GLOB '*_v26' OR name GLOB '*_v26_*' OR tbl_name GLOB '*_v26' OR tbl_name GLOB '*_v26_*') ORDER BY type,name`).all(); }
function checksPowersEffectsLayoutDigestV26(db: DatabaseDriver.Database): string { const rows = (checksPowersEffectsLayoutRowsV26(db) as Array<any>).map((row) => ({...row, sql: row.sql?.replace(/\s+/g, " ").trim()})); return createHash("sha256").update(canonicalV17(rows)).digest("hex"); }
function assertChecksPowersEffectsLayoutV26(db: DatabaseDriver.Database): void { const row = db.prepare("SELECT prior_layout_digest,current_layout_digest FROM rpg_checks_powers_effects_layout_attestation_v26 WHERE singleton=1").get() as any; const actual = checksPowersEffectsLayoutDigestV26(db); if (!row || row.prior_layout_digest !== V25_RESOURCES_INVENTORY_ECONOMY_LAYOUT_DIGEST || row.current_layout_digest !== actual || actual !== V26_CHECKS_POWERS_EFFECTS_LAYOUT_DIGEST) throw new Error(`schema v26 checks/powers/effects canonical SQL is incompatible (${actual})`); }
function validateM16PersistenceV26(db: DatabaseDriver.Database): void {
  const commands = db.prepare(`SELECT command.*,receipt.resulting_revision receipt_revision,receipt.occurred_at FROM rpg_m16_commands_v26 command LEFT JOIN rpg_m16_receipts_v26 receipt ON receipt.campaign_id=command.campaign_id AND receipt.actor_id=command.actor_id AND receipt.command_id=command.command_id ORDER BY command.campaign_id,command.actor_id,command.resulting_revision`).all() as Array<any>;
  if (commands.length !== (db.prepare("SELECT count(*) count FROM rpg_m16_receipts_v26").get() as {count:number}).count) throw new Error("M1.6 command receipt graph is incomplete");
  for (const command of commands) { let request:any; try { request=JSON.parse(command.canonical_request_json); } catch { throw new Error("M1.6 command provenance is malformed"); } if (command.canonical_request_json!==canonicalV17(request) || command.request_digest!==createHash("sha256").update(canonicalV17(request)).digest("hex") || command.receipt_revision!==command.resulting_revision || command.occurred_at!==command.created_at) throw new Error("M1.6 command receipt provenance is inconsistent"); }
  const roots=db.prepare("SELECT * FROM rpg_m16_mutation_revisions_v26 ORDER BY campaign_id,actor_id").all() as Array<any>;
  for (const root of roots) { const history=db.prepare("SELECT expected_revision,resulting_revision,created_at FROM rpg_m16_commands_v26 WHERE campaign_id=? AND actor_id=? ORDER BY resulting_revision").all(root.campaign_id,root.actor_id) as Array<any>; if(history.length!==root.revision || history.some((row,index)=>row.expected_revision!==index || row.resulting_revision!==index+1) || (history.length>0 && root.updated_at!==history.at(-1)!.created_at)) throw new Error("M1.6 revision root history is inconsistent"); }
}
function migrate25to26(db: DatabaseDriver.Database): void { db.transaction(() => { assertResourcesInventoryEconomyRestLayoutV25(db); validateM15PersistenceV25(db); createChecksPowersEffectsV26(db); db.prepare("UPDATE meta SET value='26' WHERE key='schemaVersion'").run(); })(); }

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
