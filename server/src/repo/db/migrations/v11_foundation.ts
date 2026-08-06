// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";

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

export {
  assertCampaignContentPacksHaveExactSealedPacks,
  createCampaignContentPackSealedPinTriggers,
  createRpgCharactersV11,
  createRpgContentV10,
  createRpgFoundationV9,
  createSchemaV11,
};
