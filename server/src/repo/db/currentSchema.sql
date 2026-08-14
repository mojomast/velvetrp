-- The complete disposable-development schema. Edit this file directly for schema changes.
-- Existing databases must match it exactly; startup never upgrades or rewrites them.

CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      age INTEGER NOT NULL,
      archetype TEXT NOT NULL,
      boundaries TEXT NOT NULL,
      fictional_confirmed INTEGER NOT NULL,
      is_real_person INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
CREATE TABLE sessions (
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
CREATE TABLE consent_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      scope TEXT NOT NULL,
      granted INTEGER NOT NULL,
      note TEXT NOT NULL
    );
CREATE TABLE session_characters (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL,
      PRIMARY KEY (session_id, character_id)
    );
CREATE TABLE messages (
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
CREATE INDEX idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX idx_messages_parent ON messages(parent_id);
CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      user_approved INTEGER NOT NULL,
      forgotten_at TEXT
    );
CREATE TABLE summaries (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      key_events TEXT NOT NULL,
      emotional_beat TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE session_context (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      source_of_truth TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synthesized_source TEXT NOT NULL DEFAULT '',
      synthesized_updated_at TEXT
    );
CREATE TABLE lore (
      id TEXT PRIMARY KEY,
      character_id TEXT,
      keys TEXT NOT NULL,
      content TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      insertion_order REAL NOT NULL,
      created_at TEXT NOT NULL
    );
CREATE TABLE lore_characters (
      lore_id TEXT NOT NULL REFERENCES lore(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      PRIMARY KEY (lore_id, character_id)
    );
CREATE TABLE settings (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
CREATE TABLE provider (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
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
      ), lifecycle_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_status IN ('draft','published','paused','completed','archived')), settings TEXT NOT NULL DEFAULT
    '{"maxPlayers":6,"allowPlayerDice":true,"safetyMode":"standard","recapVisibility":"members","gmNotes":""}'
    CHECK (json_valid(settings) AND json_type(settings)='object'), administration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(administration_revision)='integer' AND administration_revision BETWEEN 0 AND 9007199254740991),
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
      ), revision INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
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
CREATE TRIGGER campaign_timelines_advance_revision
      BEFORE UPDATE OF revision ON campaign_timelines
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'campaign timeline revision must advance exactly once'); END;
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
CREATE TABLE campaign_timeline_history (
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
CREATE TABLE campaign_administration_commands (
      command_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL, actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      expected_revision INTEGER NOT NULL CHECK (typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      type TEXT NOT NULL CHECK (type IN ('campaign_renamed','administration_updated','membership_added','membership_role_changed','membership_removed',
        'room_attached','room_detached','checkpoint_created','timeline_forked','recap_created','import_applied','export_created')),
      payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload)='object'), created_at TEXT NOT NULL,
      UNIQUE (campaign_id,idempotency_key), UNIQUE (campaign_id,command_id),
      UNIQUE (campaign_id,command_id,type,expected_revision)
    );
CREATE INDEX idx_campaign_administration_commands_campaign ON campaign_administration_commands(campaign_id,expected_revision);
CREATE TABLE campaign_administration_events (
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
CREATE TABLE campaign_administration_receipts (
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
CREATE TABLE campaign_checkpoints (
      id TEXT PRIMARY KEY, source_checkpoint_id TEXT, campaign_id TEXT NOT NULL, timeline_id TEXT NOT NULL, timeline_revision INTEGER NOT NULL,
      label TEXT NOT NULL CHECK (label=trim(label) AND length(label) BETWEEN 1 AND 200), created_at TEXT NOT NULL,
      command_id TEXT NOT NULL REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE
    );
CREATE INDEX idx_campaign_checkpoints_campaign ON campaign_checkpoints(campaign_id,created_at,id);
CREATE TABLE campaign_recaps (
      id TEXT PRIMARY KEY, source_recap_id TEXT, campaign_id TEXT NOT NULL, timeline_id TEXT NOT NULL, through_revision INTEGER NOT NULL,
      selected_session_ids TEXT NOT NULL CHECK (json_valid(selected_session_ids) AND json_type(selected_session_ids)='array'),
      visibility TEXT NOT NULL CHECK (visibility IN ('members','gm-only')), text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 50000),
      created_at TEXT NOT NULL, command_id TEXT NOT NULL REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE
    );
CREATE INDEX idx_campaign_recaps_campaign ON campaign_recaps(campaign_id,created_at,id);
CREATE TABLE campaign_imports (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      package_hash TEXT NOT NULL CHECK (length(package_hash)=64), format_version INTEGER NOT NULL CHECK (format_version=1),
      applied_at TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE
    );
CREATE TABLE campaign_import_submissions (
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL, package_hash TEXT NOT NULL CHECK (length(package_hash)=64),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, PRIMARY KEY (principal_id,idempotency_key), UNIQUE (command_id),
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE
    );
CREATE TABLE campaign_export_manifests (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL CHECK (format_version=1), record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 10000),
      excluded TEXT NOT NULL CHECK (json_valid(excluded) AND json_type(excluded)='array'),
      package_json TEXT NOT NULL CHECK (json_valid(package_json) AND json_type(package_json)='object'),
      created_at TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE REFERENCES campaign_administration_commands(command_id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_administration_commands(campaign_id,command_id) ON DELETE CASCADE
    );
CREATE TABLE campaign_timeline_events (
      campaign_id TEXT NOT NULL, timeline_id TEXT NOT NULL, revision INTEGER NOT NULL,
      event_id TEXT NOT NULL, inherited INTEGER NOT NULL CHECK (inherited IN (0,1)),
      PRIMARY KEY (campaign_id,timeline_id,revision), UNIQUE (campaign_id,timeline_id,event_id),
      FOREIGN KEY (campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE CASCADE,
      FOREIGN KEY (event_id) REFERENCES campaign_events(event_id) ON DELETE CASCADE
    );
CREATE TABLE campaign_imported_timeline_events (
      campaign_id TEXT NOT NULL, timeline_id TEXT NOT NULL, revision INTEGER NOT NULL,
      source_event_id TEXT NOT NULL, source_command_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      source_turn_id TEXT, type TEXT NOT NULL CHECK (type IN ('actor_attribute_set','actor_resource_initialized','actor_dice_rolled')),
      occurred_at TEXT NOT NULL, public_data TEXT NOT NULL CHECK (json_valid(public_data) AND json_type(public_data)='object'),
      PRIMARY KEY (campaign_id,timeline_id,revision),
      UNIQUE (campaign_id,timeline_id,source_event_id), UNIQUE (campaign_id,timeline_id,source_command_id),
      FOREIGN KEY (campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE CASCADE
    );
CREATE TABLE campaign_imported_administration_events (
      campaign_id TEXT NOT NULL, revision INTEGER NOT NULL, source_event_id TEXT NOT NULL,
      source_command_id TEXT NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL,
      public_data TEXT NOT NULL CHECK (json_valid(public_data) AND json_type(public_data)='object'),
      PRIMARY KEY (campaign_id,revision), UNIQUE (campaign_id,source_event_id), UNIQUE (campaign_id,source_command_id),
      UNIQUE (campaign_id,source_command_id,type,revision,occurred_at),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );
CREATE TABLE campaign_imported_administration_receipts (
      campaign_id TEXT NOT NULL, source_command_id TEXT NOT NULL, type TEXT NOT NULL,
      revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL, occurred_at TEXT NOT NULL,
      PRIMARY KEY (campaign_id,source_command_id), CHECK (revision_after=revision_before+1),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );
CREATE UNIQUE INDEX idx_campaign_imported_timeline_event_identity
      ON campaign_imported_timeline_events(campaign_id,timeline_id,source_event_id);
CREATE UNIQUE INDEX idx_campaign_imported_timeline_command_identity
      ON campaign_imported_timeline_events(campaign_id,timeline_id,source_command_id);
CREATE UNIQUE INDEX idx_campaign_imported_administration_event_identity
      ON campaign_imported_administration_events(campaign_id,source_event_id);
CREATE UNIQUE INDEX idx_campaign_imported_administration_command_identity
      ON campaign_imported_administration_events(campaign_id,source_command_id);
CREATE UNIQUE INDEX idx_campaign_imported_administration_receipt_provenance
      ON campaign_imported_administration_events(campaign_id,source_command_id,type,revision,occurred_at);
CREATE TABLE campaign_checkpoint_attribute_snapshots (
      checkpoint_id TEXT NOT NULL REFERENCES campaign_checkpoints(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL, attribute_id TEXT NOT NULL, value INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id,actor_id,attribute_id)
    );
CREATE TABLE campaign_checkpoint_resource_snapshots (
      checkpoint_id TEXT NOT NULL REFERENCES campaign_checkpoints(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL, name TEXT NOT NULL, current INTEGER NOT NULL, max INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id,actor_id,name)
    );
CREATE TRIGGER campaign_administration_revision_advance BEFORE UPDATE OF administration_revision ON campaigns
      WHEN NEW.administration_revision<>OLD.administration_revision+1
      BEGIN SELECT RAISE(ABORT,'campaign administration revision must advance exactly once'); END;
CREATE TRIGGER campaign_administration_commands_require_current_revision BEFORE INSERT ON campaign_administration_commands
      WHEN NOT EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=NEW.campaign_id
        AND campaign.administration_revision=NEW.expected_revision)
      BEGIN SELECT RAISE(ABORT,'campaign administration command revision is stale'); END;
CREATE TRIGGER campaign_administration_events_require_current_revision BEFORE INSERT ON campaign_administration_events
      WHEN NOT EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=NEW.campaign_id
        AND campaign.administration_revision=NEW.revision)
      BEGIN SELECT RAISE(ABORT,'campaign administration event revision is not current'); END;
CREATE TRIGGER campaign_administration_receipts_require_current_revision BEFORE INSERT ON campaign_administration_receipts
      WHEN NOT EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=NEW.campaign_id
        AND campaign.administration_revision=NEW.revision_after)
      BEGIN SELECT RAISE(ABORT,'campaign administration receipt revision is not current'); END;
CREATE TRIGGER campaigns_prevent_updated_at_rewind BEFORE UPDATE OF updated_at ON campaigns
      WHEN NEW.updated_at < OLD.updated_at BEGIN SELECT RAISE(ABORT,'campaign updated_at cannot rewind'); END;
CREATE TRIGGER campaign_events_link_timeline AFTER INSERT ON campaign_events
      BEGIN INSERT INTO campaign_timeline_events (campaign_id,timeline_id,revision,event_id,inherited)
        VALUES (NEW.campaign_id,NEW.timeline_id,NEW.revision,NEW.event_id,0); END;
CREATE TRIGGER campaign_timeline_history_immutable_update BEFORE UPDATE ON campaign_timeline_history
      BEGIN SELECT RAISE(ABORT,'campaign timeline history is immutable'); END;
CREATE TRIGGER campaign_timeline_history_immutable_delete BEFORE DELETE ON campaign_timeline_history
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign timeline history is immutable'); END;
CREATE TRIGGER campaign_administration_commands_immutable_update BEFORE UPDATE ON campaign_administration_commands
      BEGIN SELECT RAISE(ABORT,'campaign administration commands are immutable'); END;
CREATE TRIGGER campaign_administration_commands_immutable_delete BEFORE DELETE ON campaign_administration_commands
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign administration commands are immutable'); END;
CREATE TRIGGER campaign_administration_events_immutable_update BEFORE UPDATE ON campaign_administration_events
      BEGIN SELECT RAISE(ABORT,'campaign administration events are immutable'); END;
CREATE TRIGGER campaign_administration_events_immutable_delete BEFORE DELETE ON campaign_administration_events
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign administration events are immutable'); END;
CREATE TRIGGER campaign_administration_receipts_immutable_update BEFORE UPDATE ON campaign_administration_receipts
      BEGIN SELECT RAISE(ABORT,'campaign administration receipts are immutable'); END;
CREATE TRIGGER campaign_administration_receipts_immutable_delete BEFORE DELETE ON campaign_administration_receipts
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign administration receipts are immutable'); END;
CREATE TRIGGER campaign_checkpoints_immutable_update BEFORE UPDATE ON campaign_checkpoints
      BEGIN SELECT RAISE(ABORT,'campaign checkpoints are immutable'); END;
CREATE TRIGGER campaign_checkpoints_immutable_delete BEFORE DELETE ON campaign_checkpoints
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign checkpoints are immutable'); END;
CREATE TRIGGER campaign_recaps_immutable_update BEFORE UPDATE ON campaign_recaps
      BEGIN SELECT RAISE(ABORT,'campaign recaps are immutable'); END;
CREATE TRIGGER campaign_recaps_immutable_delete BEFORE DELETE ON campaign_recaps
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign recaps are immutable'); END;
CREATE TRIGGER campaign_imports_immutable_update BEFORE UPDATE ON campaign_imports
      BEGIN SELECT RAISE(ABORT,'campaign imports are immutable'); END;
CREATE TRIGGER campaign_imports_immutable_delete BEFORE DELETE ON campaign_imports
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign imports are immutable'); END;
CREATE TRIGGER campaign_import_submissions_immutable_update BEFORE UPDATE ON campaign_import_submissions
      BEGIN SELECT RAISE(ABORT,'campaign import submissions are immutable'); END;
CREATE TRIGGER campaign_import_submissions_immutable_delete BEFORE DELETE ON campaign_import_submissions
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign import submissions are immutable'); END;
CREATE TRIGGER campaign_export_manifests_immutable_update BEFORE UPDATE ON campaign_export_manifests
      BEGIN SELECT RAISE(ABORT,'campaign export manifests are immutable'); END;
CREATE TRIGGER campaign_export_manifests_immutable_delete BEFORE DELETE ON campaign_export_manifests
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'campaign export manifests are immutable'); END;
CREATE TRIGGER campaign_timeline_events_immutable_update BEFORE UPDATE ON campaign_timeline_events
      BEGIN SELECT RAISE(ABORT,'campaign timeline event links are immutable'); END;
CREATE TRIGGER campaign_timeline_events_immutable_delete BEFORE DELETE ON campaign_timeline_events
      WHEN EXISTS (SELECT 1 FROM campaign_events event WHERE event.event_id=OLD.event_id)
      BEGIN SELECT RAISE(ABORT,'campaign timeline event links are immutable'); END;
CREATE TRIGGER campaign_timeline_events_require_native_event BEFORE INSERT ON campaign_timeline_events
      WHEN (NEW.inherited=0 AND NOT EXISTS (SELECT 1 FROM campaign_events event WHERE event.event_id=NEW.event_id
          AND event.campaign_id=NEW.campaign_id AND event.timeline_id=NEW.timeline_id AND event.revision=NEW.revision))
        OR (NEW.inherited=1 AND NOT EXISTS (SELECT 1 FROM campaign_timeline_history history
          JOIN campaign_timeline_events parent_link ON parent_link.campaign_id=history.campaign_id
            AND parent_link.timeline_id=history.parent_timeline_id AND parent_link.revision=NEW.revision
            AND parent_link.event_id=NEW.event_id
          WHERE history.campaign_id=NEW.campaign_id AND history.timeline_id=NEW.timeline_id
            AND history.parent_timeline_id IS NOT NULL AND NEW.revision<=history.forked_from_revision))
      BEGIN SELECT RAISE(ABORT,'campaign timeline event link provenance is invalid'); END;
CREATE TRIGGER campaign_imported_timeline_events_require_identity BEFORE INSERT ON campaign_imported_timeline_events
      WHEN EXISTS (SELECT 1 FROM campaign_imported_timeline_events old WHERE old.campaign_id=NEW.campaign_id
        AND (old.source_event_id=NEW.source_event_id OR old.source_command_id=NEW.source_command_id)
        AND NOT (old.source_event_id=NEW.source_event_id AND old.source_command_id=NEW.source_command_id
          AND old.revision=NEW.revision AND old.actor_id=NEW.actor_id AND old.source_turn_id IS NEW.source_turn_id
          AND old.type=NEW.type AND old.occurred_at=NEW.occurred_at AND old.public_data=NEW.public_data))
      BEGIN SELECT RAISE(ABORT,'imported timeline event identity is inconsistent'); END;
CREATE TRIGGER campaign_imported_timeline_events_validate_payload BEFORE INSERT ON campaign_imported_timeline_events
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
CREATE TRIGGER campaign_imported_timeline_events_immutable_update BEFORE UPDATE ON campaign_imported_timeline_events
      BEGIN SELECT RAISE(ABORT,'imported timeline events are immutable'); END;
CREATE TRIGGER campaign_imported_timeline_events_immutable_delete BEFORE DELETE ON campaign_imported_timeline_events
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'imported timeline events are immutable'); END;
CREATE TRIGGER campaign_imported_administration_events_immutable_update BEFORE UPDATE ON campaign_imported_administration_events
      BEGIN SELECT RAISE(ABORT,'imported administration events are immutable'); END;
CREATE TRIGGER campaign_imported_administration_events_immutable_delete BEFORE DELETE ON campaign_imported_administration_events
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'imported administration events are immutable'); END;
CREATE TRIGGER campaign_imported_administration_receipts_immutable_update BEFORE UPDATE ON campaign_imported_administration_receipts
      BEGIN SELECT RAISE(ABORT,'imported administration receipts are immutable'); END;
CREATE TRIGGER campaign_imported_administration_receipts_immutable_delete BEFORE DELETE ON campaign_imported_administration_receipts
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id)
      BEGIN SELECT RAISE(ABORT,'imported administration receipts are immutable'); END;
CREATE TRIGGER campaign_imported_administration_events_validate BEFORE INSERT ON campaign_imported_administration_events
      WHEN NEW.type NOT IN ('campaign_renamed','administration_updated','membership_added','membership_role_changed','membership_removed',
        'room_attached','room_detached','checkpoint_created','timeline_forked','recap_created','catalog_configured','import_applied','export_created')
        OR NEW.revision<1 OR NEW.revision>9007199254740991
      BEGIN SELECT RAISE(ABORT,'imported administration event is invalid'); END;
CREATE TRIGGER campaign_imported_administration_receipts_validate BEFORE INSERT ON campaign_imported_administration_receipts
      WHEN NEW.type NOT IN ('campaign_renamed','administration_updated','membership_added','membership_role_changed','membership_removed',
        'room_attached','room_detached','checkpoint_created','timeline_forked','recap_created','catalog_configured','import_applied','export_created')
        OR NEW.revision_before<0 OR NEW.revision_after>9007199254740991
        OR NOT EXISTS (SELECT 1 FROM campaign_imported_administration_events event
          WHERE event.campaign_id=NEW.campaign_id AND event.source_command_id=NEW.source_command_id
            AND event.type=NEW.type AND event.revision=NEW.revision_after AND event.occurred_at=NEW.occurred_at)
      BEGIN SELECT RAISE(ABORT,'imported administration receipt is inconsistent'); END;
CREATE TRIGGER campaign_checkpoint_attribute_snapshots_immutable_update BEFORE UPDATE ON campaign_checkpoint_attribute_snapshots
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
CREATE TRIGGER campaign_checkpoint_attribute_snapshots_immutable_delete BEFORE DELETE ON campaign_checkpoint_attribute_snapshots
      WHEN EXISTS (SELECT 1 FROM campaign_checkpoints checkpoint WHERE checkpoint.id=OLD.checkpoint_id)
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
CREATE TRIGGER campaign_checkpoint_resource_snapshots_immutable_update BEFORE UPDATE ON campaign_checkpoint_resource_snapshots
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
CREATE TRIGGER campaign_checkpoint_resource_snapshots_immutable_delete BEFORE DELETE ON campaign_checkpoint_resource_snapshots
      WHEN EXISTS (SELECT 1 FROM campaign_checkpoints checkpoint WHERE checkpoint.id=OLD.checkpoint_id)
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
CREATE TRIGGER campaign_timeline_history_prevent_replace BEFORE INSERT ON campaign_timeline_history
      WHEN EXISTS (SELECT 1 FROM campaign_timeline_history old WHERE old.campaign_id=NEW.campaign_id
        AND (old.timeline_id=NEW.timeline_id OR old.created_by_command_id=NEW.created_by_command_id))
      BEGIN SELECT RAISE(ABORT,'campaign timeline history is immutable'); END;
CREATE TRIGGER campaign_administration_commands_prevent_replace BEFORE INSERT ON campaign_administration_commands
      WHEN EXISTS (SELECT 1 FROM campaign_administration_commands old WHERE old.command_id=NEW.command_id
        OR (old.campaign_id=NEW.campaign_id AND old.idempotency_key=NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT,'campaign administration commands are immutable'); END;
CREATE TRIGGER campaign_administration_events_prevent_replace BEFORE INSERT ON campaign_administration_events
      WHEN EXISTS (SELECT 1 FROM campaign_administration_events old WHERE old.event_id=NEW.event_id
        OR (old.campaign_id=NEW.campaign_id AND (old.command_id=NEW.command_id OR old.revision=NEW.revision)))
      BEGIN SELECT RAISE(ABORT,'campaign administration events are immutable'); END;
CREATE TRIGGER campaign_administration_receipts_prevent_replace BEFORE INSERT ON campaign_administration_receipts
      WHEN EXISTS (SELECT 1 FROM campaign_administration_receipts old WHERE old.command_id=NEW.command_id
        OR (old.campaign_id=NEW.campaign_id AND old.event_id=NEW.event_id))
      BEGIN SELECT RAISE(ABORT,'campaign administration receipts are immutable'); END;
CREATE TRIGGER campaign_checkpoints_prevent_replace BEFORE INSERT ON campaign_checkpoints
      WHEN EXISTS (SELECT 1 FROM campaign_checkpoints old WHERE old.id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'campaign checkpoints are immutable'); END;
CREATE TRIGGER campaign_recaps_prevent_replace BEFORE INSERT ON campaign_recaps
      WHEN EXISTS (SELECT 1 FROM campaign_recaps old WHERE old.id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'campaign recaps are immutable'); END;
CREATE TRIGGER campaign_imports_prevent_replace BEFORE INSERT ON campaign_imports
      WHEN EXISTS (SELECT 1 FROM campaign_imports old WHERE old.id=NEW.id OR old.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'campaign imports are immutable'); END;
CREATE TRIGGER campaign_import_submissions_prevent_replace BEFORE INSERT ON campaign_import_submissions
      WHEN EXISTS (SELECT 1 FROM campaign_import_submissions old WHERE
        (old.principal_id=NEW.principal_id AND old.idempotency_key=NEW.idempotency_key) OR old.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'campaign import submissions are immutable'); END;
CREATE TRIGGER campaign_export_manifests_prevent_replace BEFORE INSERT ON campaign_export_manifests
      WHEN EXISTS (SELECT 1 FROM campaign_export_manifests old WHERE old.id=NEW.id OR old.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'campaign export manifests are immutable'); END;
CREATE TRIGGER campaign_timeline_events_prevent_replace BEFORE INSERT ON campaign_timeline_events
      WHEN EXISTS (SELECT 1 FROM campaign_timeline_events old WHERE old.campaign_id=NEW.campaign_id
        AND old.timeline_id=NEW.timeline_id AND (old.revision=NEW.revision OR old.event_id=NEW.event_id))
      BEGIN SELECT RAISE(ABORT,'campaign timeline event links are immutable'); END;
CREATE TRIGGER campaign_imported_timeline_events_prevent_replace BEFORE INSERT ON campaign_imported_timeline_events
      WHEN EXISTS (SELECT 1 FROM campaign_imported_timeline_events old WHERE old.campaign_id=NEW.campaign_id
        AND old.timeline_id=NEW.timeline_id AND old.revision=NEW.revision)
      BEGIN SELECT RAISE(ABORT,'imported timeline events are immutable'); END;
CREATE TRIGGER campaign_imported_administration_events_prevent_replace BEFORE INSERT ON campaign_imported_administration_events
      WHEN EXISTS (SELECT 1 FROM campaign_imported_administration_events old WHERE old.campaign_id=NEW.campaign_id
        AND old.revision=NEW.revision)
      BEGIN SELECT RAISE(ABORT,'imported administration events are immutable'); END;
CREATE TRIGGER campaign_imported_administration_receipts_prevent_replace BEFORE INSERT ON campaign_imported_administration_receipts
      WHEN EXISTS (SELECT 1 FROM campaign_imported_administration_receipts old WHERE old.campaign_id=NEW.campaign_id
        AND old.source_command_id=NEW.source_command_id)
      BEGIN SELECT RAISE(ABORT,'imported administration receipts are immutable'); END;
CREATE TRIGGER campaign_checkpoint_attribute_snapshots_prevent_replace BEFORE INSERT ON campaign_checkpoint_attribute_snapshots
      WHEN EXISTS (SELECT 1 FROM campaign_checkpoint_attribute_snapshots old WHERE old.checkpoint_id=NEW.checkpoint_id
        AND old.actor_id=NEW.actor_id AND old.attribute_id=NEW.attribute_id)
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
CREATE TRIGGER campaign_checkpoint_resource_snapshots_prevent_replace BEFORE INSERT ON campaign_checkpoint_resource_snapshots
      WHEN EXISTS (SELECT 1 FROM campaign_checkpoint_resource_snapshots old WHERE old.checkpoint_id=NEW.checkpoint_id
        AND old.actor_id=NEW.actor_id AND old.name=NEW.name)
      BEGIN SELECT RAISE(ABORT,'checkpoint snapshots are immutable'); END;
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
CREATE TRIGGER campaign_content_catalog_selections_prevent_replace BEFORE INSERT ON campaign_content_catalog_selections
      WHEN EXISTS (SELECT 1 FROM campaign_content_catalog_selections old WHERE old.campaign_id=NEW.campaign_id) BEGIN SELECT RAISE(ABORT,'campaign catalog selections are immutable'); END;
CREATE TRIGGER campaign_content_catalog_pins_immutable_update BEFORE UPDATE ON campaign_content_catalog_pins BEGIN SELECT RAISE(ABORT,'campaign catalog pins are immutable'); END;
CREATE TRIGGER campaign_content_catalog_pins_prevent_replace BEFORE INSERT ON campaign_content_catalog_pins
      WHEN EXISTS (SELECT 1 FROM campaign_content_catalog_pins old WHERE old.campaign_id=NEW.campaign_id
        AND (old.pack_id=NEW.pack_id OR old.position=NEW.position)) BEGIN SELECT RAISE(ABORT,'campaign catalog pins are immutable'); END;
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
CREATE TRIGGER campaign_catalog_selection_prevent_update BEFORE UPDATE ON campaign_catalog_current_selections
      BEGIN SELECT RAISE(ABORT,'catalog current selection cannot update'); END;
CREATE TRIGGER campaign_catalog_pin_prevent_update BEFORE UPDATE ON campaign_catalog_current_pins
      BEGIN SELECT RAISE(ABORT,'catalog current pins cannot update'); END;
CREATE TRIGGER campaign_catalog_commands_immutable_update BEFORE UPDATE ON campaign_catalog_commands BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
CREATE TRIGGER campaign_catalog_commands_prevent_replace BEFORE INSERT ON campaign_catalog_commands
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_commands old WHERE old.campaign_id=NEW.campaign_id
        AND (old.command_id=NEW.command_id OR old.idempotency_key=NEW.idempotency_key)) BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
CREATE TRIGGER campaign_catalog_events_immutable_update BEFORE UPDATE ON campaign_catalog_events BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
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
CREATE TRIGGER character_draft_pins_v19_immutable_update BEFORE UPDATE ON character_draft_pins_v19 BEGIN SELECT RAISE(ABORT,'character draft pins are immutable'); END;
CREATE TRIGGER character_draft_pins_v19_prevent_replace BEFORE INSERT ON character_draft_pins_v19
      WHEN EXISTS (SELECT 1 FROM character_draft_pins_v19 old WHERE old.draft_id=NEW.draft_id AND (old.position=NEW.position OR old.pack_id=NEW.pack_id))
      BEGIN SELECT RAISE(ABORT,'character draft pins are immutable'); END;
CREATE TRIGGER character_draft_commands_v19_immutable_update BEFORE UPDATE ON character_draft_commands_v19 BEGIN SELECT RAISE(ABORT,'character draft commands are immutable'); END;
CREATE TRIGGER character_draft_events_v19_immutable_update BEFORE UPDATE ON character_draft_events_v19 BEGIN SELECT RAISE(ABORT,'character draft events are immutable'); END;
CREATE TRIGGER character_draft_receipts_v19_immutable_update BEFORE UPDATE ON character_draft_receipts_v19 BEGIN SELECT RAISE(ABORT,'character draft receipts are immutable'); END;
CREATE TRIGGER character_draft_revisions_v19_immutable_update BEFORE UPDATE ON character_draft_revisions_v19 BEGIN SELECT RAISE(ABORT,'character draft revisions are immutable'); END;
CREATE TRIGGER character_derived_snapshots_v19_immutable_update BEFORE UPDATE ON character_derived_snapshots_v19 BEGIN SELECT RAISE(ABORT,'derived character snapshots are immutable'); END;
CREATE TRIGGER character_starting_grants_v19_immutable_update BEFORE UPDATE ON character_starting_grants_v19 BEGIN SELECT RAISE(ABORT,'starting grants are immutable'); END;
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
CREATE TRIGGER rpg_progression_profiles_v24_canonical_insert BEFORE INSERT ON rpg_progression_profiles_v23
      WHEN NOT ((NEW.profile_id='velvet:progression:starter-v1:xp' AND NEW.rules_profile_id='velvet:rules:starter-v1' AND NEW.mode='xp'
          AND NEW.max_level=3 AND NEW.thresholds_json='[{"level":1,"xp":0},{"level":2,"xp":300},{"level":3,"xp":900}]' AND NEW.profile_digest='24022841512715b487268aa61f59e4a6ceb63ad32b6db5647600bb2eaac82975')
        OR (NEW.profile_id='velvet:progression:starter-v1:milestone' AND NEW.rules_profile_id='velvet:rules:starter-v1' AND NEW.mode='milestone'
          AND NEW.max_level=3 AND NEW.thresholds_json='[{"level":1,"xp":0},{"level":2,"xp":300},{"level":3,"xp":900}]' AND NEW.profile_digest='472a70b91437947fda61ff36a6bf618f92de21d77560bc51218e437d5b8d0a13'))
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
CREATE TABLE encounter (
      encounter_id TEXT PRIMARY KEY CHECK(length(encounter_id) BETWEEN 1 AND 128 AND encounter_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, session_id TEXT NOT NULL,
      encounter_kind TEXT NOT NULL CHECK(encounter_kind IN ('prepared','improvised')),
      -- These values are the public EncounterStatus contract.  Creation may
      -- immediately activate an encounter, but it must not invent a private
      -- terminal vocabulary that clients cannot represent.
      status TEXT NOT NULL CHECK(status IN ('preparing','active','completed','escaped')),
      round_number INTEGER NOT NULL DEFAULT 0 CHECK(typeof(round_number)='integer' AND round_number BETWEEN 0 AND 1000000),
      current_turn_combatant_id TEXT, state_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 0 AND 9007199254740991),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      CHECK(updated_at>=created_at),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id,current_turn_combatant_id) REFERENCES combatant(encounter_id,combatant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE UNIQUE INDEX uq_encounter_active_session_v27 ON encounter(session_id) WHERE status='active';
CREATE INDEX idx_encounter_campaign_session_v27 ON encounter(campaign_id,session_id,created_at);
CREATE TABLE combat_mutation_revisions_v27 (
      encounter_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY(encounter_id) REFERENCES encounter(encounter_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE combat_commands_v27 (
      encounter_id TEXT NOT NULL, command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT, command_type TEXT NOT NULL CHECK(command_type IN ('start','advance_turn','resolve_action','flee','remove_combatant','grant_rewards','close')),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(length(canonical_request_json) BETWEEN 2 AND 32768 AND json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest GLOB '[0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(encounter_id,command_id), UNIQUE(encounter_id,idempotency_key), UNIQUE(encounter_id,resulting_revision), UNIQUE(encounter_id,command_id,resulting_revision),
      FOREIGN KEY(encounter_id) REFERENCES combat_mutation_revisions_v27(encounter_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE combat_receipts_v27 (
      encounter_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      canonical_result_json TEXT NOT NULL CHECK(length(canonical_result_json) BETWEEN 2 AND 32768 AND json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest GLOB '[0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(encounter_id,command_id), UNIQUE(encounter_id,resulting_revision), UNIQUE(encounter_id,command_id,resulting_revision),
      FOREIGN KEY(encounter_id,command_id,resulting_revision) REFERENCES combat_commands_v27(encounter_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE combat_events_v27 (
      event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'), encounter_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('encounter_state_changed','combatant_state_changed','combat_action_resolved','rewards_granted')),
      event_json TEXT NOT NULL CHECK(length(event_json) BETWEEN 2 AND 32768 AND json_valid(event_json) AND json_type(event_json)='object'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(encounter_id,event_id), UNIQUE(encounter_id,command_id,event_type),
      FOREIGN KEY(encounter_id,command_id,resulting_revision) REFERENCES combat_receipts_v27(encounter_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE combatant (
      combatant_id TEXT PRIMARY KEY CHECK(length(combatant_id) BETWEEN 1 AND 128 AND combatant_id NOT GLOB '*[^A-Za-z0-9._:-]*'), encounter_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
      actor_id TEXT, combatant_kind TEXT NOT NULL CHECK(combatant_kind IN ('actor','enemy')),
      -- Server-spawned enemies retain the historical insert shape; actor joins
      -- must provide their contract team explicitly.
      team TEXT NOT NULL DEFAULT 'enemies' CHECK(team IN ('allies','enemies')),
      enemy_pack_id TEXT, enemy_pack_version TEXT, enemy_kind TEXT CHECK(enemy_kind IS NULL OR enemy_kind='enemy'), enemy_definition_id TEXT,
      enemy_tactic TEXT NOT NULL DEFAULT 'basic_attack' CHECK(enemy_tactic IN ('basic_attack')),
      initiative INTEGER NOT NULL CHECK(typeof(initiative)='integer' AND initiative BETWEEN -1000000 AND 1000000), initiative_tiebreaker INTEGER NOT NULL CHECK(typeof(initiative_tiebreaker)='integer' AND initiative_tiebreaker BETWEEN 0 AND 1000000),
      hit_points INTEGER NOT NULL CHECK(typeof(hit_points)='integer' AND hit_points BETWEEN -1000000 AND 1000000), maximum_hit_points INTEGER NOT NULL CHECK(typeof(maximum_hit_points)='integer' AND maximum_hit_points BETWEEN 1 AND 1000000),
      status TEXT NOT NULL CHECK(status IN ('active','defeated','fled','removed')), state_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 0 AND 9007199254740991),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      CHECK(updated_at>=created_at), CHECK((combatant_kind='actor' AND actor_id IS NOT NULL AND enemy_pack_id IS NULL AND enemy_pack_version IS NULL AND enemy_kind IS NULL AND enemy_definition_id IS NULL) OR (combatant_kind='enemy' AND actor_id IS NULL AND ((enemy_pack_id IS NULL AND enemy_pack_version IS NULL AND enemy_kind IS NULL AND enemy_definition_id IS NULL) OR (enemy_pack_id IS NOT NULL AND enemy_pack_version IS NOT NULL AND enemy_kind='enemy' AND enemy_definition_id IS NOT NULL)))),
      UNIQUE(encounter_id,combatant_id),
      FOREIGN KEY(encounter_id) REFERENCES encounter(encounter_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,enemy_pack_id,enemy_pack_version,enemy_kind,enemy_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE UNIQUE INDEX uq_combatant_actor_encounter_v27 ON combatant(encounter_id,actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_combatant_turn_order_v27 ON combatant(encounter_id,status,initiative DESC,initiative_tiebreaker,combatant_id);
CREATE TABLE combat_log (
      log_id TEXT PRIMARY KEY CHECK(length(log_id) BETWEEN 1 AND 128 AND log_id NOT GLOB '*[^A-Za-z0-9._:-]*'), encounter_id TEXT NOT NULL, combatant_id TEXT,
      event_id TEXT NOT NULL, log_ordinal INTEGER NOT NULL CHECK(typeof(log_ordinal)='integer' AND log_ordinal BETWEEN 0 AND 1000000),
      log_kind TEXT NOT NULL CHECK(log_kind IN ('encounter_state','turn','action','damage','defeat','flee','removal','reward')),
      log_json TEXT NOT NULL CHECK(length(log_json) BETWEEN 2 AND 32768 AND json_valid(log_json) AND json_type(log_json)='object'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(encounter_id,event_id,log_ordinal),
      FOREIGN KEY(encounter_id,combatant_id) REFERENCES combatant(encounter_id,combatant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id,event_id) REFERENCES combat_events_v27(encounter_id,event_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE reward_bundle (
      reward_bundle_id TEXT PRIMARY KEY CHECK(length(reward_bundle_id) BETWEEN 1 AND 128 AND reward_bundle_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, encounter_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
      recipient_actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,reward_bundle_id), UNIQUE(encounter_id,source_event_id,recipient_actor_id),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id) REFERENCES encounter(encounter_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id,source_event_id) REFERENCES combat_events_v27(encounter_id,event_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,recipient_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE reward_entry_v27 (
      reward_entry_id TEXT PRIMARY KEY CHECK(length(reward_entry_id) BETWEEN 1 AND 128 AND reward_entry_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, reward_bundle_id TEXT NOT NULL, entry_ordinal INTEGER NOT NULL CHECK(typeof(entry_ordinal)='integer' AND entry_ordinal BETWEEN 0 AND 127),
      reward_kind TEXT NOT NULL CHECK(reward_kind='currency'), amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 1 AND 1000000),
      currency_code TEXT NOT NULL CHECK(length(currency_code) BETWEEN 1 AND 128 AND currency_code NOT GLOB '*[^A-Za-z0-9._:-]*'),
      currency_pack_id TEXT NOT NULL, currency_pack_version TEXT NOT NULL, currency_kind TEXT NOT NULL CHECK(currency_kind='currency'), currency_definition_id TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(reward_bundle_id,entry_ordinal), UNIQUE(campaign_id,reward_entry_id),
      FOREIGN KEY(campaign_id,reward_bundle_id) REFERENCES reward_bundle(campaign_id,reward_bundle_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,currency_code) REFERENCES rpg_currency_references_v25(campaign_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,currency_pack_id,currency_pack_version,currency_kind,currency_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE reward_claim_v27 (
      reward_claim_id TEXT PRIMARY KEY CHECK(length(reward_claim_id) BETWEEN 1 AND 128 AND reward_claim_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, reward_bundle_id TEXT NOT NULL, encounter_id TEXT NOT NULL, command_id TEXT NOT NULL,
      claim_state TEXT NOT NULL CHECK(claim_state='recorded'),
      claimed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at)=claimed_at AND substr(claimed_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(reward_bundle_id), UNIQUE(encounter_id,command_id),
      FOREIGN KEY(campaign_id,reward_bundle_id) REFERENCES reward_bundle(campaign_id,reward_bundle_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id,command_id) REFERENCES combat_commands_v27(encounter_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TRIGGER encounter_campaign_session_ancestry_v27 BEFORE INSERT ON encounter WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions s WHERE s.session_id=NEW.session_id AND s.campaign_id=NEW.campaign_id) BEGIN SELECT RAISE(ABORT,'encounter session must belong to campaign'); END;
CREATE TRIGGER combat_command_actor_ancestry_v27 BEFORE INSERT ON combat_commands_v27 WHEN NEW.actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM encounter e JOIN campaign_actors a ON a.campaign_id=e.campaign_id AND a.id=NEW.actor_id WHERE e.encounter_id=NEW.encounter_id) BEGIN SELECT RAISE(ABORT,'combat command actor must belong to encounter campaign'); END;
CREATE TRIGGER encounter_state_guard_v27 BEFORE UPDATE ON encounter WHEN NEW.encounter_id<>OLD.encounter_id OR NEW.campaign_id<>OLD.campaign_id OR NEW.session_id<>OLD.session_id OR NEW.encounter_kind<>OLD.encounter_kind OR NEW.state_revision<>OLD.state_revision+1 OR NEW.updated_at<OLD.updated_at OR NOT EXISTS(SELECT 1 FROM combat_log l JOIN combat_events_v27 e ON e.event_id=l.event_id WHERE l.encounter_id=OLD.encounter_id AND l.log_kind='encounter_state' AND e.event_type='encounter_state_changed' AND e.occurred_at=NEW.updated_at) BEGIN SELECT RAISE(ABORT,'encounter state requires immutable combat event'); END;
CREATE TRIGGER combatant_ancestry_v27 BEFORE INSERT ON combatant WHEN NOT EXISTS(SELECT 1 FROM encounter e WHERE e.encounter_id=NEW.encounter_id AND e.campaign_id=NEW.campaign_id) BEGIN SELECT RAISE(ABORT,'combatant must belong to encounter campaign'); END;
CREATE TRIGGER combatant_state_guard_v27 BEFORE UPDATE ON combatant WHEN NEW.combatant_id<>OLD.combatant_id OR NEW.encounter_id<>OLD.encounter_id OR NEW.campaign_id<>OLD.campaign_id OR NEW.combatant_kind<>OLD.combatant_kind OR NEW.team<>OLD.team OR NOT (NEW.actor_id IS OLD.actor_id) OR NOT (NEW.enemy_pack_id IS OLD.enemy_pack_id) OR NOT (NEW.enemy_pack_version IS OLD.enemy_pack_version) OR NOT (NEW.enemy_kind IS OLD.enemy_kind) OR NOT (NEW.enemy_definition_id IS OLD.enemy_definition_id) OR NEW.enemy_tactic<>OLD.enemy_tactic OR NEW.initiative<>OLD.initiative OR NEW.initiative_tiebreaker<>OLD.initiative_tiebreaker OR NEW.maximum_hit_points<>OLD.maximum_hit_points OR NEW.state_revision<>OLD.state_revision+1 OR NEW.updated_at<OLD.updated_at OR NOT EXISTS(SELECT 1 FROM combat_log l JOIN combat_events_v27 e ON e.event_id=l.event_id WHERE l.encounter_id=OLD.encounter_id AND l.combatant_id=OLD.combatant_id AND e.event_type='combatant_state_changed' AND e.occurred_at=NEW.updated_at) BEGIN SELECT RAISE(ABORT,'combatant state requires immutable combat event'); END;
CREATE TRIGGER combat_mutation_revisions_v27_guard BEFORE UPDATE ON combat_mutation_revisions_v27 WHEN NEW.encounter_id<>OLD.encounter_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at BEGIN SELECT RAISE(ABORT,'combat mutation revision must advance exactly once'); END;
CREATE TRIGGER combat_mutation_revisions_v27_retain BEFORE DELETE ON combat_mutation_revisions_v27 BEGIN SELECT RAISE(ABORT,'combat mutation revisions are retained'); END;
CREATE TRIGGER combat_commands_v27_immutable_update BEFORE UPDATE ON combat_commands_v27 BEGIN SELECT RAISE(ABORT,'combat commands are immutable'); END;
CREATE TRIGGER combat_commands_v27_immutable_delete BEFORE DELETE ON combat_commands_v27 BEGIN SELECT RAISE(ABORT,'combat commands are immutable'); END;
CREATE TRIGGER combat_receipts_v27_immutable_update BEFORE UPDATE ON combat_receipts_v27 BEGIN SELECT RAISE(ABORT,'combat receipts are immutable'); END;
CREATE TRIGGER combat_receipts_v27_immutable_delete BEFORE DELETE ON combat_receipts_v27 BEGIN SELECT RAISE(ABORT,'combat receipts are immutable'); END;
CREATE TRIGGER combat_events_v27_immutable_update BEFORE UPDATE ON combat_events_v27 BEGIN SELECT RAISE(ABORT,'combat events are immutable'); END;
CREATE TRIGGER combat_events_v27_immutable_delete BEFORE DELETE ON combat_events_v27 BEGIN SELECT RAISE(ABORT,'combat events are immutable'); END;
CREATE TRIGGER combat_log_immutable_update_v27 BEFORE UPDATE ON combat_log BEGIN SELECT RAISE(ABORT,'combat logs are immutable'); END;
CREATE TRIGGER combat_log_immutable_delete_v27 BEFORE DELETE ON combat_log BEGIN SELECT RAISE(ABORT,'combat logs are immutable'); END;
CREATE TRIGGER reward_bundle_immutable_update_v27 BEFORE UPDATE ON reward_bundle BEGIN SELECT RAISE(ABORT,'reward bundles are immutable'); END;
CREATE TRIGGER reward_bundle_immutable_delete_v27 BEFORE DELETE ON reward_bundle BEGIN SELECT RAISE(ABORT,'reward bundles are immutable'); END;
CREATE TRIGGER reward_bundle_server_lifecycle_source_v27 BEFORE INSERT ON reward_bundle WHEN NOT EXISTS(SELECT 1 FROM encounter e JOIN combat_events_v27 event ON event.encounter_id=e.encounter_id AND event.event_id=NEW.source_event_id JOIN combat_commands_v27 command ON command.encounter_id=event.encounter_id AND command.command_id=event.command_id WHERE e.encounter_id=NEW.encounter_id AND e.campaign_id=NEW.campaign_id AND event.event_type='rewards_granted' AND command.command_type='grant_rewards' AND event.occurred_at=NEW.created_at) BEGIN SELECT RAISE(ABORT,'reward bundle requires server lifecycle reward event'); END;
CREATE TRIGGER reward_entry_v27_immutable_update BEFORE UPDATE ON reward_entry_v27 BEGIN SELECT RAISE(ABORT,'reward entries are immutable'); END;
CREATE TRIGGER reward_entry_v27_immutable_delete BEFORE DELETE ON reward_entry_v27 BEGIN SELECT RAISE(ABORT,'reward entries are immutable'); END;
CREATE TRIGGER reward_entry_v27_bundle_timestamp BEFORE INSERT ON reward_entry_v27 WHEN NOT EXISTS(SELECT 1 FROM reward_bundle bundle WHERE bundle.campaign_id=NEW.campaign_id AND bundle.reward_bundle_id=NEW.reward_bundle_id AND bundle.created_at=NEW.created_at) BEGIN SELECT RAISE(ABORT,'reward entry must share immutable bundle timestamp'); END;
CREATE TRIGGER reward_entry_v27_currency_identity BEFORE INSERT ON reward_entry_v27 WHEN NOT EXISTS(SELECT 1 FROM rpg_currency_references_v25 reference WHERE reference.campaign_id=NEW.campaign_id AND reference.currency_code=NEW.currency_code AND reference.pack_id=NEW.currency_pack_id AND reference.pack_version=NEW.currency_pack_version AND reference.kind=NEW.currency_kind AND reference.definition_id=NEW.currency_definition_id) BEGIN SELECT RAISE(ABORT,'reward currency must match its exact wallet reference'); END;
CREATE TRIGGER reward_claim_v27_immutable_update BEFORE UPDATE ON reward_claim_v27 BEGIN SELECT RAISE(ABORT,'reward claims are immutable'); END;
CREATE TRIGGER reward_claim_v27_immutable_delete BEFORE DELETE ON reward_claim_v27 BEGIN SELECT RAISE(ABORT,'reward claims are immutable'); END;
CREATE TRIGGER reward_claim_v27_exact_command BEFORE INSERT ON reward_claim_v27 WHEN NOT EXISTS(SELECT 1 FROM reward_bundle bundle JOIN combat_commands_v27 command ON command.encounter_id=NEW.encounter_id AND command.command_id=NEW.command_id WHERE bundle.campaign_id=NEW.campaign_id AND bundle.reward_bundle_id=NEW.reward_bundle_id AND bundle.encounter_id=NEW.encounter_id AND command.command_type='grant_rewards' AND command.created_at=NEW.claimed_at AND json_extract(command.canonical_request_json,'$.type')='claim_reward_bundle' AND json_extract(command.canonical_request_json,'$.rewardClaimId')=NEW.reward_claim_id AND json_extract(command.canonical_request_json,'$.rewardBundleId')=NEW.reward_bundle_id AND json_extract(command.canonical_request_json,'$.recipientActorId')=bundle.recipient_actor_id) BEGIN SELECT RAISE(ABORT,'reward claim must match its exact server command'); END;
CREATE TABLE campaign_locations_v28 (
      location_id TEXT PRIMARY KEY CHECK(length(location_id) BETWEEN 1 AND 128 AND location_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL,
      parent_location_id TEXT, public_name TEXT NOT NULL CHECK(length(trim(public_name)) BETWEEN 1 AND 200 AND public_name=trim(public_name)),
      public_description TEXT NOT NULL DEFAULT '' CHECK(length(public_description)<=4000), visibility TEXT NOT NULL CHECK(visibility IN ('public','discovered','gm')),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,location_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,parent_location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(parent_location_id IS NULL OR parent_location_id<>location_id)
    );
CREATE INDEX idx_campaign_locations_v28_hierarchy ON campaign_locations_v28(campaign_id,parent_location_id,location_id);
CREATE TABLE campaign_location_private_state_v28 (
      campaign_id TEXT NOT NULL, location_id TEXT NOT NULL, gm_notes TEXT NOT NULL CHECK(length(gm_notes)<=8000),
      PRIMARY KEY(campaign_id,location_id), FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE campaign_location_connections_v28 (
      connection_id TEXT PRIMARY KEY CHECK(length(connection_id) BETWEEN 1 AND 128 AND connection_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL,
      from_location_id TEXT NOT NULL, to_location_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('public','discovered','gm')),
      route_state TEXT NOT NULL CHECK(route_state IN ('open','closed')), requirement_kind TEXT NOT NULL CHECK(requirement_kind IN ('none','discovery','faction_reputation')),
      required_faction_id TEXT, minimum_reputation INTEGER,
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,connection_id), UNIQUE(campaign_id,from_location_id,to_location_id),
      FOREIGN KEY(campaign_id,from_location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,to_location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,required_faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(from_location_id<>to_location_id), CHECK((requirement_kind IN ('none','discovery') AND required_faction_id IS NULL AND minimum_reputation IS NULL) OR (requirement_kind='faction_reputation' AND required_faction_id IS NOT NULL AND minimum_reputation BETWEEN -1000000 AND 1000000))
    );
CREATE INDEX idx_campaign_location_connections_v28_route ON campaign_location_connections_v28(campaign_id,from_location_id,route_state,to_location_id);
CREATE TABLE campaign_location_discoveries_v28 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, location_id TEXT NOT NULL, discovered_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',discovered_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',discovered_at)=discovered_at AND substr(discovered_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,location_id), FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE campaign_npcs_v28 (
      npc_id TEXT PRIMARY KEY CHECK(length(npc_id) BETWEEN 1 AND 128 AND npc_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, persona_id TEXT NOT NULL,
      speech_control TEXT NOT NULL CHECK(speech_control IN ('manual','automated')), public_name TEXT NOT NULL CHECK(length(trim(public_name)) BETWEEN 1 AND 200 AND public_name=trim(public_name)),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,npc_id), UNIQUE(campaign_id,persona_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(persona_id) REFERENCES characters(id) ON DELETE RESTRICT
    );
CREATE TABLE campaign_npc_private_state_v28 (
      campaign_id TEXT NOT NULL, npc_id TEXT NOT NULL, private_goals TEXT NOT NULL CHECK(length(private_goals)<=8000), gm_notes TEXT NOT NULL CHECK(length(gm_notes)<=8000), merchant_state_json TEXT CHECK(merchant_state_json IS NULL OR (json_valid(merchant_state_json) AND json_type(merchant_state_json)='object' AND length(merchant_state_json)<=16000)),
      PRIMARY KEY(campaign_id,npc_id), FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE campaign_factions_v28 (
      faction_id TEXT PRIMARY KEY CHECK(length(faction_id) BETWEEN 1 AND 128 AND faction_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL,
      public_name TEXT NOT NULL CHECK(length(trim(public_name)) BETWEEN 1 AND 200 AND public_name=trim(public_name)), visibility TEXT NOT NULL CHECK(visibility IN ('public','discovered','gm')),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,faction_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE campaign_faction_private_state_v28 (
      campaign_id TEXT NOT NULL, faction_id TEXT NOT NULL, gm_notes TEXT NOT NULL CHECK(length(gm_notes)<=8000), PRIMARY KEY(campaign_id,faction_id),
      FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE campaign_actor_faction_memberships_v28 (
      campaign_id TEXT NOT NULL, faction_id TEXT NOT NULL, actor_id TEXT NOT NULL, membership_role TEXT NOT NULL CHECK(membership_role IN ('member','leader','ally','enemy')),
      joined_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',joined_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',joined_at)=joined_at AND substr(joined_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,faction_id,actor_id), FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE campaign_npc_faction_memberships_v28 (
      campaign_id TEXT NOT NULL, faction_id TEXT NOT NULL, npc_id TEXT NOT NULL, membership_role TEXT NOT NULL CHECK(membership_role IN ('member','leader','ally','enemy')),
      joined_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',joined_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',joined_at)=joined_at AND substr(joined_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,faction_id,npc_id), FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE campaign_faction_relations_v28 (
      campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, from_faction_id TEXT NOT NULL, to_faction_id TEXT NOT NULL, relation TEXT NOT NULL CHECK(relation IN ('allied','neutral','hostile')), updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,from_faction_id,to_faction_id), FOREIGN KEY(campaign_id,from_faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,to_faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, CHECK(from_faction_id<>to_faction_id)
    );
CREATE TABLE campaign_npc_relationships_v28 (
      campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, actor_id TEXT NOT NULL, npc_id TEXT NOT NULL, disposition INTEGER NOT NULL CHECK(typeof(disposition)='integer' AND disposition BETWEEN -1000 AND 1000), updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,npc_id), FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE campaign_reputation_ledger_v28 (
      entry_id TEXT PRIMARY KEY CHECK(length(entry_id) BETWEEN 1 AND 128 AND entry_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, actor_id TEXT NOT NULL, faction_id TEXT NOT NULL, delta INTEGER NOT NULL CHECK(typeof(delta)='integer' AND delta BETWEEN -1000000 AND 1000000), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500 AND reason=trim(reason)), command_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'), UNIQUE(campaign_id,session_id,command_id,entry_id), FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE world_mutation_revisions_v28 (
      campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991), updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,session_id), FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE world_commands_v28 (
      campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'), actor_id TEXT NOT NULL, command_type TEXT NOT NULL CHECK(command_type IN ('travel','discover_location','set_npc_relationship','change_reputation','set_faction_relation','set_actor_location')), idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'), canonical_request_json TEXT NOT NULL CHECK(length(canonical_request_json) BETWEEN 2 AND 32768 AND json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'), request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest GLOB '[0-9a-f]*'), expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990), resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1), created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,session_id,command_id), UNIQUE(campaign_id,session_id,idempotency_key), UNIQUE(campaign_id,session_id,resulting_revision), UNIQUE(campaign_id,session_id,command_id,resulting_revision), FOREIGN KEY(campaign_id,session_id) REFERENCES world_mutation_revisions_v28(campaign_id,session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE world_receipts_v28 (campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991), canonical_result_json TEXT NOT NULL CHECK(length(canonical_result_json) BETWEEN 2 AND 32768 AND json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'), result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest GLOB '[0-9a-f]*'), occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'), PRIMARY KEY(campaign_id,session_id,command_id), UNIQUE(campaign_id,session_id,resulting_revision), UNIQUE(campaign_id,session_id,command_id,resulting_revision), FOREIGN KEY(campaign_id,session_id,command_id,resulting_revision) REFERENCES world_commands_v28(campaign_id,session_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE world_events_v28 (event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('travelled','location_discovered','actor_location_set','npc_relationship_changed','reputation_changed','faction_relation_changed')), event_json TEXT NOT NULL CHECK(length(event_json) BETWEEN 2 AND 32768 AND json_valid(event_json) AND json_type(event_json)='object'), occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'), UNIQUE(campaign_id,session_id,event_id), UNIQUE(campaign_id,session_id,command_id,event_type), FOREIGN KEY(campaign_id,session_id,command_id,resulting_revision) REFERENCES world_receipts_v28(campaign_id,session_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE campaign_actor_locations_v28 (campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, location_id TEXT NOT NULL, session_id TEXT NOT NULL, state_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 0 AND 9007199254740991), updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'), PRIMARY KEY(campaign_id,actor_id,session_id), FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE world_travel_party_members_v28 (campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, actor_id TEXT NOT NULL, PRIMARY KEY(campaign_id,session_id,command_id,actor_id), FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE world_travel_destinations_v28 (campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, connection_id TEXT NOT NULL, destination_location_id TEXT NOT NULL, PRIMARY KEY(campaign_id,session_id,command_id), FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,connection_id) REFERENCES campaign_location_connections_v28(campaign_id,connection_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,destination_location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE world_travel_npc_party_members_v28 (campaign_id TEXT NOT NULL, session_id TEXT NOT NULL, command_id TEXT NOT NULL, npc_id TEXT NOT NULL, PRIMARY KEY(campaign_id,session_id,command_id,npc_id), FOREIGN KEY(campaign_id,session_id,command_id) REFERENCES world_commands_v28(campaign_id,session_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
CREATE TRIGGER world_mutation_revisions_v28_campaign_session_ancestry BEFORE INSERT ON world_mutation_revisions_v28 WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'world session must belong to campaign'); END;
CREATE TRIGGER world_commands_v28_campaign_session_ancestry BEFORE INSERT ON world_commands_v28 WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'world command session must belong to campaign'); END;
CREATE TRIGGER world_mutation_revisions_v28_guard BEFORE UPDATE ON world_mutation_revisions_v28 WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.session_id<>OLD.session_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at BEGIN SELECT RAISE(ABORT,'world mutation revision must advance exactly once'); END;
CREATE TRIGGER world_commands_v28_immutable_update BEFORE UPDATE ON world_commands_v28 BEGIN SELECT RAISE(ABORT,'world commands are immutable'); END;
CREATE TRIGGER world_commands_v28_immutable_delete BEFORE DELETE ON world_commands_v28 BEGIN SELECT RAISE(ABORT,'world commands are immutable'); END;
CREATE TRIGGER world_receipts_v28_immutable_update BEFORE UPDATE ON world_receipts_v28 BEGIN SELECT RAISE(ABORT,'world receipts are immutable'); END;
CREATE TRIGGER world_receipts_v28_immutable_delete BEFORE DELETE ON world_receipts_v28 BEGIN SELECT RAISE(ABORT,'world receipts are immutable'); END;
CREATE TRIGGER world_events_v28_immutable_update BEFORE UPDATE ON world_events_v28 BEGIN SELECT RAISE(ABORT,'world events are immutable'); END;
CREATE TRIGGER world_events_v28_immutable_delete BEFORE DELETE ON world_events_v28 BEGIN SELECT RAISE(ABORT,'world events are immutable'); END;
CREATE TRIGGER campaign_reputation_ledger_v28_immutable_update BEFORE UPDATE ON campaign_reputation_ledger_v28 BEGIN SELECT RAISE(ABORT,'reputation ledger is immutable'); END;
CREATE TRIGGER campaign_reputation_ledger_v28_immutable_delete BEFORE DELETE ON campaign_reputation_ledger_v28 BEGIN SELECT RAISE(ABORT,'reputation ledger is immutable'); END;
CREATE TRIGGER campaign_actor_locations_v28_ancestry BEFORE INSERT ON campaign_actor_locations_v28 WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'actor location session must belong to campaign'); END;
CREATE TRIGGER campaign_npcs_v28_persona_not_campaign_character BEFORE INSERT ON campaign_npcs_v28 WHEN EXISTS(SELECT 1 FROM campaign_actors a JOIN campaign_characters cc ON cc.id=a.campaign_character_id AND cc.campaign_id=a.campaign_id WHERE a.campaign_id=NEW.campaign_id AND cc.character_id=NEW.persona_id) BEGIN SELECT RAISE(ABORT,'campaign character persona cannot become NPC'); END;
CREATE TRIGGER campaign_actors_v28_persona_not_npc BEFORE INSERT ON campaign_actors WHEN EXISTS(SELECT 1 FROM campaign_characters cc JOIN campaign_npcs_v28 n ON n.campaign_id=NEW.campaign_id AND n.persona_id=cc.character_id WHERE cc.id=NEW.campaign_character_id AND cc.campaign_id=NEW.campaign_id) BEGIN SELECT RAISE(ABORT,'NPC persona cannot become campaign character'); END;
CREATE TRIGGER campaign_actor_locations_v28_guard BEFORE UPDATE ON campaign_actor_locations_v28 WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.actor_id<>OLD.actor_id OR NEW.session_id<>OLD.session_id OR NEW.state_revision<>OLD.state_revision+1 OR NEW.updated_at<OLD.updated_at OR NOT EXISTS(SELECT 1 FROM world_events_v28 WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id AND event_type IN ('travelled','actor_location_set') AND occurred_at=NEW.updated_at) BEGIN SELECT RAISE(ABORT,'actor location requires immutable world event'); END;
CREATE TRIGGER world_travel_party_members_v28_command_type BEFORE INSERT ON world_travel_party_members_v28 WHEN NOT EXISTS(SELECT 1 FROM world_commands_v28 WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id AND command_id=NEW.command_id AND command_type='travel') BEGIN SELECT RAISE(ABORT,'travel party member requires travel command'); END;
CREATE TRIGGER world_travel_destinations_v28_command_type BEFORE INSERT ON world_travel_destinations_v28 WHEN NOT EXISTS(SELECT 1 FROM world_commands_v28 WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id AND command_id=NEW.command_id AND command_type='travel') BEGIN SELECT RAISE(ABORT,'travel destination requires travel command'); END;
CREATE TABLE quest_storylines (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE quests (
      id TEXT PRIMARY KEY,
      storyline_id TEXT NOT NULL REFERENCES quest_storylines(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE quest_clues (
      id TEXT PRIMARY KEY,
      quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      discovered_by_character_id TEXT REFERENCES characters(id),
      discovered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE quest_rewards (
      id TEXT PRIMARY KEY,
      quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount INTEGER,
      label TEXT NOT NULL,
      granted_to_character_id TEXT REFERENCES characters(id),
      granted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE quest_objective_completions (
      id TEXT PRIMARY KEY,
      quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      completed_by_character_id TEXT REFERENCES characters(id),
      completed_at TEXT NOT NULL
    );
CREATE INDEX idx_quests_campaign ON quests(campaign_id);
CREATE INDEX idx_quest_clues_quest ON quest_clues(quest_id);
CREATE INDEX idx_quest_rewards_quest ON quest_rewards(quest_id);
CREATE INDEX idx_storylines_campaign ON quest_storylines(campaign_id);
CREATE TABLE campaign_import_dry_runs_v30 (
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      import_id TEXT NOT NULL CHECK (length(import_id) BETWEEN 1 AND 128
        AND import_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      package_json TEXT NOT NULL CHECK (json_valid(package_json) AND json_type(package_json)='object'
        AND length(CAST(package_json AS BLOB)) <= 1000000),
      package_hash TEXT NOT NULL CHECK (length(package_hash)=64
        AND package_hash NOT GLOB '*[^a-f0-9]*'),
      report_json TEXT NOT NULL CHECK (json_valid(report_json) AND json_type(report_json)='object'
        AND length(CAST(report_json AS BLOB)) <= 100000),
      created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
        AND created_at=strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
      PRIMARY KEY (principal_id, import_id),
      UNIQUE (principal_id, package_hash),
      CHECK (import_id='import-' || substr(package_hash,1,32))
    );
CREATE TRIGGER campaign_import_dry_runs_v30_immutable_update
      BEFORE UPDATE ON campaign_import_dry_runs_v30
      BEGIN SELECT RAISE(ABORT,'campaign import dry runs are immutable'); END;
CREATE TRIGGER campaign_import_dry_runs_v30_immutable_delete
      BEFORE DELETE ON campaign_import_dry_runs_v30
      BEGIN SELECT RAISE(ABORT,'campaign import dry runs are immutable'); END;
CREATE TRIGGER campaign_import_dry_runs_v30_prevent_replace
      BEFORE INSERT ON campaign_import_dry_runs_v30
      WHEN EXISTS (SELECT 1 FROM campaign_import_dry_runs_v30 old
        WHERE (old.principal_id=NEW.principal_id AND old.import_id=NEW.import_id)
          OR (old.principal_id=NEW.principal_id AND old.package_hash=NEW.package_hash))
      BEGIN SELECT RAISE(ABORT,'campaign import dry runs are immutable'); END;
CREATE TABLE encounter_lifecycle_v31 (
      encounter_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name=trim(name)),
      create_idempotency_key TEXT NOT NULL CHECK(length(create_idempotency_key) BETWEEN 1 AND 128
        AND create_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_create_request_json TEXT NOT NULL CHECK(length(canonical_create_request_json) BETWEEN 2 AND 32768
        AND json_valid(canonical_create_request_json) AND json_type(canonical_create_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      UNIQUE(campaign_id,create_idempotency_key),
      FOREIGN KEY(encounter_id) REFERENCES encounter(encounter_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE INDEX idx_encounter_lifecycle_v31_campaign
      ON encounter_lifecycle_v31(campaign_id,encounter_id);
CREATE TABLE encounter_enemy_provenance_v31 (
      combatant_id TEXT PRIMARY KEY,
      encounter_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      pack_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind='enemy-template'),
      definition_id TEXT NOT NULL,
      FOREIGN KEY(encounter_id,combatant_id) REFERENCES combatant(encounter_id,combatant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,pack_id,pack_version,kind,definition_id)
        REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE INDEX idx_encounter_enemy_provenance_v31_encounter
      ON encounter_enemy_provenance_v31(encounter_id,combatant_id);
CREATE TRIGGER encounter_lifecycle_v31_exact_ancestry BEFORE INSERT ON encounter_lifecycle_v31
      WHEN NOT EXISTS(SELECT 1 FROM encounter e WHERE e.encounter_id=NEW.encounter_id
        AND e.campaign_id=NEW.campaign_id AND e.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT,'encounter lifecycle metadata must match encounter ancestry'); END;
CREATE TRIGGER encounter_lifecycle_v31_immutable_update BEFORE UPDATE ON encounter_lifecycle_v31
      BEGIN SELECT RAISE(ABORT,'encounter lifecycle metadata is immutable'); END;
CREATE TRIGGER encounter_lifecycle_v31_immutable_delete BEFORE DELETE ON encounter_lifecycle_v31
      BEGIN SELECT RAISE(ABORT,'encounter lifecycle metadata is immutable'); END;
CREATE TRIGGER encounter_enemy_provenance_v31_exact_combatant BEFORE INSERT ON encounter_enemy_provenance_v31
      WHEN NOT EXISTS(SELECT 1 FROM combatant c WHERE c.combatant_id=NEW.combatant_id
        AND c.encounter_id=NEW.encounter_id AND c.campaign_id=NEW.campaign_id AND c.combatant_kind='enemy')
      BEGIN SELECT RAISE(ABORT,'enemy provenance must match an enemy combatant'); END;
CREATE TRIGGER encounter_enemy_provenance_v31_immutable_update BEFORE UPDATE ON encounter_enemy_provenance_v31
      BEGIN SELECT RAISE(ABORT,'enemy provenance is immutable'); END;
CREATE TRIGGER encounter_enemy_provenance_v31_immutable_delete BEFORE DELETE ON encounter_enemy_provenance_v31
      BEGIN SELECT RAISE(ABORT,'enemy provenance is immutable'); END;
CREATE TABLE world_narrative_revisions_v32 (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23')
    );
CREATE TABLE world_narrative_commands_v32 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL,
      resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 128 AND resource_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      command_type TEXT NOT NULL CHECK(command_type IN ('create_npc','change_npc_relationship','create_faction','change_faction_reputation')),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,command_id),UNIQUE(campaign_id,idempotency_key),UNIQUE(campaign_id,resulting_revision),
      UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id) REFERENCES world_narrative_revisions_v32(campaign_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE world_narrative_receipts_v32 (
      campaign_id TEXT NOT NULL,command_id TEXT NOT NULL,resulting_revision INTEGER NOT NULL,
      canonical_result_json TEXT NOT NULL CHECK(json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,command_id),UNIQUE(campaign_id,resulting_revision),
      UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES world_narrative_commands_v32(campaign_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE world_narrative_events_v32 (
      event_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,command_id TEXT NOT NULL,resulting_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('npc_created','npc_relationship_changed','faction_created','faction_reputation_changed')),
      event_json TEXT NOT NULL CHECK(json_valid(event_json) AND json_type(event_json)='object'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,command_id),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES world_narrative_receipts_v32(campaign_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE campaign_npc_metadata_v32 (
      npc_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,public_state_json TEXT NOT NULL,
      private_state_json TEXT NOT NULL,created_command_id TEXT NOT NULL,created_at TEXT NOT NULL,
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES world_narrative_commands_v32(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(json_valid(public_state_json) AND json_type(public_state_json)='object'),
      CHECK(json_valid(private_state_json) AND json_type(private_state_json)='object')
    );
CREATE TABLE campaign_npc_relationships_v32 (
      campaign_id TEXT NOT NULL,npc_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      affinity INTEGER NOT NULL CHECK(typeof(affinity)='integer' AND affinity BETWEEN -1000 AND 1000),
      trust INTEGER NOT NULL CHECK(typeof(trust)='integer' AND trust BETWEEN -1000 AND 1000),
      fear INTEGER NOT NULL CHECK(typeof(fear)='integer' AND fear BETWEEN -1000 AND 1000),
      last_command_id TEXT NOT NULL,updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,npc_id,actor_id),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,last_command_id) REFERENCES world_narrative_commands_v32(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE campaign_faction_metadata_v32 (
      faction_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,public_state_json TEXT NOT NULL,
      private_state_json TEXT NOT NULL,created_command_id TEXT NOT NULL,created_at TEXT NOT NULL,
      FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES world_narrative_commands_v32(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(json_valid(public_state_json) AND json_type(public_state_json)='object'),
      CHECK(json_valid(private_state_json) AND json_type(private_state_json)='object')
    );
CREATE TABLE campaign_faction_reputation_v32 (
      entry_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,faction_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      delta INTEGER NOT NULL CHECK(typeof(delta)='integer' AND delta BETWEEN -10000 AND 10000 AND delta<>0),reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason=trim(reason)),
      command_id TEXT NOT NULL,recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at AND substr(recorded_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,command_id) REFERENCES world_narrative_commands_v32(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TRIGGER world_narrative_commands_v32_immutable_update BEFORE UPDATE ON world_narrative_commands_v32 BEGIN SELECT RAISE(ABORT,'world narrative commands are immutable'); END;
CREATE TRIGGER world_narrative_commands_v32_immutable_delete BEFORE DELETE ON world_narrative_commands_v32 BEGIN SELECT RAISE(ABORT,'world narrative commands are immutable'); END;
CREATE TRIGGER world_narrative_receipts_v32_immutable_update BEFORE UPDATE ON world_narrative_receipts_v32 BEGIN SELECT RAISE(ABORT,'world narrative receipts are immutable'); END;
CREATE TRIGGER world_narrative_receipts_v32_immutable_delete BEFORE DELETE ON world_narrative_receipts_v32 BEGIN SELECT RAISE(ABORT,'world narrative receipts are immutable'); END;
CREATE TRIGGER world_narrative_events_v32_immutable_update BEFORE UPDATE ON world_narrative_events_v32 BEGIN SELECT RAISE(ABORT,'world narrative events are immutable'); END;
CREATE TRIGGER world_narrative_events_v32_immutable_delete BEFORE DELETE ON world_narrative_events_v32 BEGIN SELECT RAISE(ABORT,'world narrative events are immutable'); END;
CREATE TRIGGER campaign_npc_metadata_v32_immutable_update BEFORE UPDATE ON campaign_npc_metadata_v32 BEGIN SELECT RAISE(ABORT,'NPC metadata is immutable'); END;
CREATE TRIGGER campaign_npc_metadata_v32_immutable_delete BEFORE DELETE ON campaign_npc_metadata_v32 BEGIN SELECT RAISE(ABORT,'NPC metadata is immutable'); END;
CREATE TRIGGER campaign_faction_metadata_v32_immutable_update BEFORE UPDATE ON campaign_faction_metadata_v32 BEGIN SELECT RAISE(ABORT,'faction metadata is immutable'); END;
CREATE TRIGGER campaign_faction_metadata_v32_immutable_delete BEFORE DELETE ON campaign_faction_metadata_v32 BEGIN SELECT RAISE(ABORT,'faction metadata is immutable'); END;
CREATE TRIGGER campaign_faction_reputation_v32_immutable_update BEFORE UPDATE ON campaign_faction_reputation_v32 BEGIN SELECT RAISE(ABORT,'faction reputation is immutable'); END;
CREATE TRIGGER campaign_faction_reputation_v32_immutable_delete BEFORE DELETE ON campaign_faction_reputation_v32 BEGIN SELECT RAISE(ABORT,'faction reputation is immutable'); END;
CREATE UNIQUE INDEX uq_quest_campaign_id_v33 ON quests(campaign_id,id);
CREATE UNIQUE INDEX uq_quest_reward_ancestry_v33 ON quest_rewards(campaign_id,quest_id,id);
CREATE TABLE quest_domain_revisions_v33 (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL
    );
CREATE TABLE quest_domain_commands_v33 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, quest_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      command_type TEXT NOT NULL CHECK(command_type IN ('create','accept','advance-objective','abandon','claim-reward')),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1), created_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,command_id), UNIQUE(campaign_id,idempotency_key), UNIQUE(campaign_id,resulting_revision),
      UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id) REFERENCES quest_domain_revisions_v33(campaign_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );
CREATE TABLE quest_domain_receipts_v33 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      canonical_result_json TEXT NOT NULL CHECK(json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*'), occurred_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,command_id), UNIQUE(campaign_id,resulting_revision),
      UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES quest_domain_commands_v33(campaign_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE quest_domain_events_v33 (
      event_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('quest-created','quest-accepted','objective-advanced','quest-completed','quest-abandoned','reward-claimed')),
      event_json TEXT NOT NULL CHECK(json_valid(event_json) AND json_type(event_json)='object'), occurred_at TEXT NOT NULL,
      UNIQUE(campaign_id,command_id),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES quest_domain_receipts_v33(campaign_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE quest_definitions_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')),
      created_command_id TEXT NOT NULL, PRIMARY KEY(campaign_id,quest_id),
      FOREIGN KEY(campaign_id,quest_id) REFERENCES quests(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE quest_objectives_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, objective_id TEXT NOT NULL, description TEXT NOT NULL,
      target_progress INTEGER NOT NULL CHECK(typeof(target_progress)='integer' AND target_progress BETWEEN 1 AND 1000000),
      sort_order INTEGER NOT NULL CHECK(typeof(sort_order)='integer' AND sort_order>=0),
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')), created_command_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,quest_id,objective_id), UNIQUE(campaign_id,objective_id),
      FOREIGN KEY(campaign_id,quest_id) REFERENCES quest_definitions_v33(campaign_id,quest_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE quest_objective_dependencies_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, objective_id TEXT NOT NULL, dependency_objective_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,quest_id,objective_id,dependency_objective_id), CHECK(objective_id<>dependency_objective_id),
      FOREIGN KEY(campaign_id,quest_id,objective_id) REFERENCES quest_objectives_v33(campaign_id,quest_id,objective_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,quest_id,dependency_objective_id) REFERENCES quest_objectives_v33(campaign_id,quest_id,objective_id) ON DELETE RESTRICT
    );
CREATE TABLE quest_objective_progress_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, objective_id TEXT NOT NULL,
      progress INTEGER NOT NULL CHECK(typeof(progress)='integer' AND progress BETWEEN 0 AND 1000000),
      completed_at TEXT, last_command_id TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,quest_id,objective_id),
      FOREIGN KEY(campaign_id,quest_id,objective_id) REFERENCES quest_objectives_v33(campaign_id,quest_id,objective_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,last_command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE quest_reward_definitions_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, reward_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')), created_command_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,quest_id,reward_id), UNIQUE(campaign_id,reward_id),
      FOREIGN KEY(campaign_id,quest_id,reward_id) REFERENCES quest_rewards(campaign_id,quest_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE quest_reward_claims_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, reward_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      command_id TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY(campaign_id,quest_id,reward_id),
      FOREIGN KEY(campaign_id,quest_id,reward_id) REFERENCES quest_reward_definitions_v33(campaign_id,quest_id,reward_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE quest_journal_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, entry_id TEXT NOT NULL, text TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')), command_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,entry_id),
      FOREIGN KEY(campaign_id,quest_id) REFERENCES quests(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TRIGGER quest_domain_commands_v33_immutable_update BEFORE UPDATE ON quest_domain_commands_v33 BEGIN SELECT RAISE(ABORT,'quest commands are immutable'); END;
CREATE TRIGGER quest_domain_commands_v33_immutable_delete BEFORE DELETE ON quest_domain_commands_v33 BEGIN SELECT RAISE(ABORT,'quest commands are immutable'); END;
CREATE TRIGGER quest_domain_receipts_v33_immutable_update BEFORE UPDATE ON quest_domain_receipts_v33 BEGIN SELECT RAISE(ABORT,'quest receipts are immutable'); END;
CREATE TRIGGER quest_domain_receipts_v33_immutable_delete BEFORE DELETE ON quest_domain_receipts_v33 BEGIN SELECT RAISE(ABORT,'quest receipts are immutable'); END;
CREATE TRIGGER quest_domain_events_v33_immutable_update BEFORE UPDATE ON quest_domain_events_v33 BEGIN SELECT RAISE(ABORT,'quest events are immutable'); END;
CREATE TRIGGER quest_domain_events_v33_immutable_delete BEFORE DELETE ON quest_domain_events_v33 BEGIN SELECT RAISE(ABORT,'quest events are immutable'); END;
CREATE TRIGGER quest_definitions_v33_immutable_update BEFORE UPDATE ON quest_definitions_v33 BEGIN SELECT RAISE(ABORT,'quest definitions are immutable'); END;
CREATE TRIGGER quest_definitions_v33_immutable_delete BEFORE DELETE ON quest_definitions_v33 BEGIN SELECT RAISE(ABORT,'quest definitions are immutable'); END;
CREATE TRIGGER quest_objectives_v33_immutable_update BEFORE UPDATE ON quest_objectives_v33 BEGIN SELECT RAISE(ABORT,'quest objectives are immutable'); END;
CREATE TRIGGER quest_objectives_v33_immutable_delete BEFORE DELETE ON quest_objectives_v33 BEGIN SELECT RAISE(ABORT,'quest objectives are immutable'); END;
CREATE TRIGGER quest_objective_dependencies_v33_immutable_update BEFORE UPDATE ON quest_objective_dependencies_v33 BEGIN SELECT RAISE(ABORT,'quest dependencies are immutable'); END;
CREATE TRIGGER quest_objective_dependencies_v33_immutable_delete BEFORE DELETE ON quest_objective_dependencies_v33 BEGIN SELECT RAISE(ABORT,'quest dependencies are immutable'); END;
CREATE TRIGGER quest_reward_definitions_v33_immutable_update BEFORE UPDATE ON quest_reward_definitions_v33 BEGIN SELECT RAISE(ABORT,'quest rewards are immutable'); END;
CREATE TRIGGER quest_reward_definitions_v33_immutable_delete BEFORE DELETE ON quest_reward_definitions_v33 BEGIN SELECT RAISE(ABORT,'quest rewards are immutable'); END;
CREATE TRIGGER quest_reward_claims_v33_immutable_update BEFORE UPDATE ON quest_reward_claims_v33 BEGIN SELECT RAISE(ABORT,'quest claims are immutable'); END;
CREATE TRIGGER quest_reward_claims_v33_immutable_delete BEFORE DELETE ON quest_reward_claims_v33 BEGIN SELECT RAISE(ABORT,'quest claims are immutable'); END;
CREATE TRIGGER quest_journal_v33_immutable_update BEFORE UPDATE ON quest_journal_v33 BEGIN SELECT RAISE(ABORT,'quest journal is immutable'); END;
CREATE TRIGGER quest_journal_v33_immutable_delete BEFORE DELETE ON quest_journal_v33 BEGIN SELECT RAISE(ABORT,'quest journal is immutable'); END;
CREATE UNIQUE INDEX uq_storyline_campaign_id_v34 ON quest_storylines(campaign_id,id);
CREATE TABLE story_campaign_revisions_v34 (campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT
      CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at));
CREATE TABLE story_commands_v34 (campaign_id TEXT NOT NULL,command_id TEXT NOT NULL,storyline_id TEXT NOT NULL,principal_id TEXT NOT NULL,
      command_type TEXT NOT NULL CHECK(command_type IN ('create-storyline','reveal-node','resolve-node','reveal-clue','answer-plot-point')),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991 AND resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(principal_id) BETWEEN 1 AND 128 AND principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,command_id),UNIQUE(campaign_id,idempotency_key),UNIQUE(campaign_id,resulting_revision),UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id) REFERENCES story_campaign_revisions_v34(campaign_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,storyline_id) REFERENCES quest_storylines(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT);
CREATE TABLE story_receipts_v34 (campaign_id TEXT NOT NULL,command_id TEXT NOT NULL,resulting_revision INTEGER NOT NULL,
      canonical_result_json TEXT NOT NULL CHECK(json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
      CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,command_id),UNIQUE(campaign_id,resulting_revision),UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES story_commands_v34(campaign_id,command_id,resulting_revision) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE story_events_v34 (event_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,command_id TEXT NOT NULL,resulting_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('storyline-created','node-revealed','node-resolved','clue-revealed','plot-point-answered')),
      event_json TEXT NOT NULL CHECK(json_valid(event_json) AND json_type(event_json)='object'),
      occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
      CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),UNIQUE(campaign_id,command_id),
      CHECK(length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES story_receipts_v34(campaign_id,command_id,resulting_revision) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE story_metadata_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      summary TEXT CHECK(summary IS NULL OR length(summary)<=4000),status TEXT NOT NULL CHECK(status IN ('active','completed','abandoned')),
      created_command_id TEXT NOT NULL CHECK(length(created_command_id) BETWEEN 1 AND 128 AND created_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),PRIMARY KEY(campaign_id,storyline_id),
      FOREIGN KEY(campaign_id,storyline_id) REFERENCES quest_storylines(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE story_nodes_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 128 AND node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200 AND title=trim(title)),description TEXT CHECK(description IS NULL OR length(description)<=4000),
      gm_notes TEXT CHECK(gm_notes IS NULL OR length(gm_notes)<=4000),
      reveal_threshold INTEGER NOT NULL CHECK(typeof(reveal_threshold)='integer' AND reveal_threshold BETWEEN 0 AND 1000),
      sort_order INTEGER NOT NULL CHECK(typeof(sort_order)='integer' AND sort_order BETWEEN 0 AND 999),
      created_command_id TEXT NOT NULL CHECK(length(created_command_id) BETWEEN 1 AND 128 AND created_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,storyline_id,node_id),UNIQUE(campaign_id,node_id),FOREIGN KEY(campaign_id,storyline_id) REFERENCES story_metadata_v34(campaign_id,storyline_id),
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE story_node_state_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 128 AND node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),status TEXT NOT NULL CHECK(status IN ('hidden','revealed','resolved')),
      last_command_id TEXT NOT NULL CHECK(length(last_command_id) BETWEEN 1 AND 128 AND last_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),PRIMARY KEY(campaign_id,storyline_id,node_id),
      FOREIGN KEY(campaign_id,storyline_id,node_id) REFERENCES story_nodes_v34(campaign_id,storyline_id,node_id),
      FOREIGN KEY(campaign_id,last_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE story_edges_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      edge_id TEXT NOT NULL CHECK(length(edge_id) BETWEEN 1 AND 128 AND edge_id NOT GLOB '*[^A-Za-z0-9._:-]*'),kind TEXT NOT NULL CHECK(kind IN ('sequence','requires')),
      from_node_id TEXT NOT NULL CHECK(length(from_node_id) BETWEEN 1 AND 128 AND from_node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      to_node_id TEXT NOT NULL CHECK(length(to_node_id) BETWEEN 1 AND 128 AND to_node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      created_command_id TEXT NOT NULL CHECK(length(created_command_id) BETWEEN 1 AND 128 AND created_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(from_node_id<>to_node_id),PRIMARY KEY(campaign_id,storyline_id,edge_id),UNIQUE(campaign_id,edge_id),
      UNIQUE(campaign_id,storyline_id,kind,from_node_id,to_node_id),
      FOREIGN KEY(campaign_id,storyline_id,from_node_id) REFERENCES story_nodes_v34(campaign_id,storyline_id,node_id),
      FOREIGN KEY(campaign_id,storyline_id,to_node_id) REFERENCES story_nodes_v34(campaign_id,storyline_id,node_id),
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE story_plot_points_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      plot_point_id TEXT NOT NULL CHECK(length(plot_point_id) BETWEEN 1 AND 128 AND plot_point_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 128 AND node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      question TEXT NOT NULL CHECK(length(question)<=4000),answer TEXT NOT NULL CHECK(length(answer)<=4000),gm_notes TEXT CHECK(gm_notes IS NULL OR length(gm_notes)<=4000),
      created_command_id TEXT NOT NULL CHECK(length(created_command_id) BETWEEN 1 AND 128 AND created_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,storyline_id,plot_point_id),UNIQUE(campaign_id,plot_point_id),FOREIGN KEY(campaign_id,storyline_id,node_id) REFERENCES story_nodes_v34(campaign_id,storyline_id,node_id),
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE story_plot_point_answers_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      plot_point_id TEXT NOT NULL CHECK(length(plot_point_id) BETWEEN 1 AND 128 AND plot_point_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      player_answer TEXT NOT NULL CHECK(length(player_answer)<=4000 AND length(trim(player_answer))>0),
      command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      answered_at TEXT NOT NULL CHECK(length(answered_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',answered_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',answered_at)=answered_at),
      PRIMARY KEY(campaign_id,storyline_id,plot_point_id),FOREIGN KEY(campaign_id,storyline_id,plot_point_id) REFERENCES story_plot_points_v34(campaign_id,storyline_id,plot_point_id),
      FOREIGN KEY(campaign_id,command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE story_clues_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      clue_id TEXT NOT NULL CHECK(length(clue_id) BETWEEN 1 AND 128 AND clue_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200 AND title=trim(title)),content TEXT NOT NULL CHECK(length(content)<=4000),
      truth TEXT NOT NULL CHECK(length(truth)<=4000),gm_notes TEXT CHECK(gm_notes IS NULL OR length(gm_notes)<=4000),
      reveal_threshold INTEGER NOT NULL CHECK(typeof(reveal_threshold)='integer' AND reveal_threshold BETWEEN 1 AND 1000),
      created_command_id TEXT NOT NULL CHECK(length(created_command_id) BETWEEN 1 AND 128 AND created_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,storyline_id,clue_id),UNIQUE(campaign_id,clue_id),FOREIGN KEY(campaign_id,storyline_id) REFERENCES story_metadata_v34(campaign_id,storyline_id),
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE story_clue_sources_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      clue_id TEXT NOT NULL CHECK(length(clue_id) BETWEEN 1 AND 128 AND clue_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128 AND source_id NOT GLOB '*[^A-Za-z0-9._:-]*'),source_kind TEXT NOT NULL CHECK(source_kind IN ('node','plot-point')),
      target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 128 AND target_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,storyline_id,clue_id,source_id),UNIQUE(campaign_id,storyline_id,clue_id,source_kind,target_id),
      FOREIGN KEY(campaign_id,storyline_id,clue_id) REFERENCES story_clues_v34(campaign_id,storyline_id,clue_id));
CREATE TABLE story_discoveries_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      clue_id TEXT NOT NULL CHECK(length(clue_id) BETWEEN 1 AND 128 AND clue_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      discovered_at TEXT NOT NULL CHECK(length(discovered_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',discovered_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',discovered_at)=discovered_at),
      PRIMARY KEY(campaign_id,storyline_id,clue_id),FOREIGN KEY(campaign_id,storyline_id,clue_id) REFERENCES story_clues_v34(campaign_id,storyline_id,clue_id),
      FOREIGN KEY(campaign_id,command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TRIGGER story_campaign_revisions_v34_conflict_insert BEFORE INSERT ON story_campaign_revisions_v34
      WHEN EXISTS(SELECT 1 FROM story_campaign_revisions_v34 old WHERE old.campaign_id=NEW.campaign_id)
      BEGIN SELECT RAISE(ABORT,'story revision identity is sealed'); END;
CREATE TRIGGER story_campaign_revisions_v34_guard_update BEFORE UPDATE ON story_campaign_revisions_v34
      WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'story revision must advance exactly once'); END;
CREATE TRIGGER story_campaign_revisions_v34_guard_delete BEFORE DELETE ON story_campaign_revisions_v34 BEGIN SELECT RAISE(ABORT,'story revisions cannot be deleted'); END;
CREATE TRIGGER story_commands_v34_conflict_insert BEFORE INSERT ON story_commands_v34
      WHEN EXISTS(SELECT 1 FROM story_commands_v34 old WHERE old.campaign_id=NEW.campaign_id AND
        (old.command_id=NEW.command_id OR old.idempotency_key=NEW.idempotency_key OR old.resulting_revision=NEW.resulting_revision))
      BEGIN SELECT RAISE(ABORT,'story command identity is sealed'); END;
CREATE TRIGGER story_commands_v34_authorize_payload BEFORE INSERT ON story_commands_v34
      WHEN NOT EXISTS(SELECT 1 FROM campaign_memberships membership WHERE membership.campaign_id=NEW.campaign_id
          AND membership.principal_id=NEW.principal_id AND membership.role IN ('owner','gm'))
        OR (NEW.command_type='create-storyline' AND (SELECT count(*) FROM json_each(NEW.canonical_request_json))<>4)
        OR (NEW.command_type<>'create-storyline' AND (SELECT count(*) FROM json_each(NEW.canonical_request_json))<>6)
        OR json_extract(NEW.canonical_request_json,'$.expectedRevision') IS NOT NEW.expected_revision
        OR json_extract(NEW.canonical_request_json,'$.idempotencyKey') IS NOT NEW.idempotency_key
        OR (NEW.command_type='create-storyline' AND (json_extract(NEW.canonical_request_json,'$.campaignId') IS NOT NEW.campaign_id
          OR json_extract(NEW.canonical_request_json,'$.storyline.storylineId') IS NOT NEW.storyline_id
          OR json_type(NEW.canonical_request_json,'$.storyline')<>'object'
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.storyline'))<>7
          OR typeof(json_extract(NEW.canonical_request_json,'$.storyline.title'))<>'text'
          OR length(json_extract(NEW.canonical_request_json,'$.storyline.title')) NOT BETWEEN 1 AND 200
          OR json_extract(NEW.canonical_request_json,'$.storyline.title')<>trim(json_extract(NEW.canonical_request_json,'$.storyline.title'))
          OR json_type(NEW.canonical_request_json,'$.storyline.summary') IS NULL OR json_type(NEW.canonical_request_json,'$.storyline.summary') NOT IN ('null','text')
          OR length(COALESCE(json_extract(NEW.canonical_request_json,'$.storyline.summary'),''))>4000
          OR json_type(NEW.canonical_request_json,'$.storyline.nodes')<>'array'
          OR json_type(NEW.canonical_request_json,'$.storyline.edges')<>'array'
          OR json_type(NEW.canonical_request_json,'$.storyline.plotPoints')<>'array'
          OR json_type(NEW.canonical_request_json,'$.storyline.clues')<>'array'
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.storyline.nodes'))>1000
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.storyline.edges'))>10000
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.storyline.plotPoints'))>10000
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.storyline.clues'))>10000
          OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json,'$.storyline.nodes') item WHERE json_type(item.value)<>'object'
            OR (SELECT count(*) FROM json_each(item.value))<>5 OR typeof(json_extract(item.value,'$.nodeId'))<>'text'
            OR typeof(json_extract(item.value,'$.title'))<>'text' OR length(json_extract(item.value,'$.title')) NOT BETWEEN 1 AND 200
            OR json_type(item.value,'$.description') IS NULL OR json_type(item.value,'$.description') NOT IN ('null','text')
            OR json_type(item.value,'$.gmNotes') IS NULL OR json_type(item.value,'$.gmNotes') NOT IN ('null','text')
            OR length(COALESCE(json_extract(item.value,'$.description'),''))>4000 OR length(COALESCE(json_extract(item.value,'$.gmNotes'),''))>4000
            OR typeof(json_extract(item.value,'$.revealThreshold'))<>'integer' OR json_extract(item.value,'$.revealThreshold') NOT BETWEEN 0 AND 1000)
          OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json,'$.storyline.edges') item WHERE json_type(item.value)<>'object'
            OR (SELECT count(*) FROM json_each(item.value))<>4 OR typeof(json_extract(item.value,'$.edgeId'))<>'text'
            OR json_extract(item.value,'$.kind') NOT IN ('sequence','requires') OR typeof(json_extract(item.value,'$.fromNodeId'))<>'text' OR typeof(json_extract(item.value,'$.toNodeId'))<>'text')
          OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json,'$.storyline.plotPoints') item WHERE json_type(item.value)<>'object'
            OR (SELECT count(*) FROM json_each(item.value))<>5 OR typeof(json_extract(item.value,'$.plotPointId'))<>'text' OR typeof(json_extract(item.value,'$.nodeId'))<>'text'
            OR typeof(json_extract(item.value,'$.question'))<>'text' OR length(json_extract(item.value,'$.question'))>4000
            OR typeof(json_extract(item.value,'$.answer'))<>'text' OR length(json_extract(item.value,'$.answer'))>4000
            OR json_type(item.value,'$.gmNotes') IS NULL OR json_type(item.value,'$.gmNotes') NOT IN ('null','text')
            OR length(COALESCE(json_extract(item.value,'$.gmNotes'),''))>4000)
          OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json,'$.storyline.clues') item WHERE json_type(item.value)<>'object'
            OR (SELECT count(*) FROM json_each(item.value))<>7 OR typeof(json_extract(item.value,'$.clueId'))<>'text'
            OR typeof(json_extract(item.value,'$.title'))<>'text' OR length(json_extract(item.value,'$.title')) NOT BETWEEN 1 AND 200
            OR typeof(json_extract(item.value,'$.content'))<>'text' OR length(json_extract(item.value,'$.content'))>4000
            OR typeof(json_extract(item.value,'$.truth'))<>'text' OR length(json_extract(item.value,'$.truth'))>4000
            OR json_type(item.value,'$.gmNotes') IS NULL OR json_type(item.value,'$.gmNotes') NOT IN ('null','text')
            OR length(COALESCE(json_extract(item.value,'$.gmNotes'),''))>4000 OR typeof(json_extract(item.value,'$.revealThreshold'))<>'integer'
            OR json_extract(item.value,'$.revealThreshold') NOT BETWEEN 1 AND 1000 OR json_type(item.value,'$.sources')<>'array'
            OR json_extract(item.value,'$.revealThreshold')>(SELECT count(*) FROM json_each(item.value,'$.sources'))
            OR EXISTS(SELECT 1 FROM json_each(item.value,'$.sources') source WHERE json_type(source.value)<>'object'
              OR (SELECT count(*) FROM json_each(source.value))<>3 OR typeof(json_extract(source.value,'$.sourceId'))<>'text'
              OR json_extract(source.value,'$.kind') NOT IN ('node','plot-point') OR typeof(json_extract(source.value,'$.targetId'))<>'text'))))
        OR (NEW.command_type<>'create-storyline' AND (json_extract(NEW.canonical_request_json,'$.storylineId') IS NOT NEW.storyline_id
          OR json_extract(NEW.canonical_request_json,'$.kind') IS NOT NEW.command_type
          OR typeof(json_extract(NEW.canonical_request_json,'$.targetId'))<>'text'
          OR length(json_extract(NEW.canonical_request_json,'$.targetId')) NOT BETWEEN 1 AND 128
          OR json_extract(NEW.canonical_request_json,'$.targetId') GLOB '*[^A-Za-z0-9._:-]*'))
        OR (NEW.command_type IN ('reveal-node','resolve-node','reveal-clue') AND
          (json_type(NEW.canonical_request_json,'$.data')<>'object' OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.data'))<>0))
        OR (NEW.command_type='answer-plot-point' AND (json_type(NEW.canonical_request_json,'$.data')<>'object'
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.data'))<>1
          OR typeof(json_extract(NEW.canonical_request_json,'$.data.answer'))<>'text'
          OR length(json_extract(NEW.canonical_request_json,'$.data.answer'))>4000 OR length(trim(json_extract(NEW.canonical_request_json,'$.data.answer')))=0))
        OR (NEW.command_type IN ('reveal-node','resolve-node') AND NOT EXISTS(SELECT 1 FROM story_nodes_v34 node WHERE node.campaign_id=NEW.campaign_id AND node.storyline_id=NEW.storyline_id AND node.node_id=json_extract(NEW.canonical_request_json,'$.targetId')))
        OR (NEW.command_type='reveal-clue' AND NOT EXISTS(SELECT 1 FROM story_clues_v34 clue WHERE clue.campaign_id=NEW.campaign_id AND clue.storyline_id=NEW.storyline_id AND clue.clue_id=json_extract(NEW.canonical_request_json,'$.targetId')))
        OR (NEW.command_type='answer-plot-point' AND NOT EXISTS(SELECT 1 FROM story_plot_points_v34 point WHERE point.campaign_id=NEW.campaign_id AND point.storyline_id=NEW.storyline_id AND point.plot_point_id=json_extract(NEW.canonical_request_json,'$.targetId')))
      BEGIN SELECT RAISE(ABORT,'story command authorization or payload is invalid'); END;
CREATE TRIGGER story_commands_v34_immutable_update BEFORE UPDATE ON story_commands_v34 BEGIN SELECT RAISE(ABORT,'story commands are immutable'); END;
CREATE TRIGGER story_commands_v34_immutable_delete BEFORE DELETE ON story_commands_v34 BEGIN SELECT RAISE(ABORT,'story commands are immutable'); END;
CREATE TRIGGER story_receipts_v34_conflict_insert BEFORE INSERT ON story_receipts_v34
      WHEN EXISTS(SELECT 1 FROM story_receipts_v34 old WHERE old.campaign_id=NEW.campaign_id AND (old.command_id=NEW.command_id OR old.resulting_revision=NEW.resulting_revision))
      BEGIN SELECT RAISE(ABORT,'story receipt identity is sealed'); END;
CREATE TRIGGER story_receipts_v34_validate_payload BEFORE INSERT ON story_receipts_v34
      WHEN (SELECT count(*) FROM json_each(NEW.canonical_result_json))<>4 OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.command_id=NEW.command_id
        AND command.resulting_revision=NEW.resulting_revision AND command.created_at=NEW.occurred_at
        AND json_extract(NEW.canonical_result_json,'$.campaignId')=NEW.campaign_id
        AND json_extract(NEW.canonical_result_json,'$.receipt.commandId')=NEW.command_id
        AND json_extract(NEW.canonical_result_json,'$.receipt.idempotencyKey')=command.idempotency_key
        AND json_extract(NEW.canonical_result_json,'$.receipt.revisionBefore')=command.expected_revision
        AND json_extract(NEW.canonical_result_json,'$.receipt.revisionAfter')=command.resulting_revision
        AND json_extract(NEW.canonical_result_json,'$.receipt.occurredAt')=NEW.occurred_at
        AND (command.command_type<>'create-storyline' OR (
          (SELECT count(*) FROM story_metadata_v34 metadata WHERE metadata.campaign_id=command.campaign_id AND metadata.storyline_id=command.storyline_id)=1
          AND (SELECT count(*) FROM story_nodes_v34 node WHERE node.campaign_id=command.campaign_id AND node.storyline_id=command.storyline_id)
            =(SELECT count(*) FROM json_each(command.canonical_request_json,'$.storyline.nodes'))
          AND (SELECT count(*) FROM story_edges_v34 edge WHERE edge.campaign_id=command.campaign_id AND edge.storyline_id=command.storyline_id)
            =(SELECT count(*) FROM json_each(command.canonical_request_json,'$.storyline.edges'))
          AND (SELECT count(*) FROM story_plot_points_v34 point WHERE point.campaign_id=command.campaign_id AND point.storyline_id=command.storyline_id)
            =(SELECT count(*) FROM json_each(command.canonical_request_json,'$.storyline.plotPoints'))
          AND (SELECT count(*) FROM story_clues_v34 clue WHERE clue.campaign_id=command.campaign_id AND clue.storyline_id=command.storyline_id)
            =(SELECT count(*) FROM json_each(command.canonical_request_json,'$.storyline.clues'))
          AND (SELECT count(*) FROM story_clue_sources_v34 source WHERE source.campaign_id=command.campaign_id AND source.storyline_id=command.storyline_id)
            =(SELECT count(*) FROM json_each(command.canonical_request_json,'$.storyline.clues') clue_item JOIN json_each(clue_item.value,'$.sources'))))
      )
      BEGIN SELECT RAISE(ABORT,'story receipt payload is invalid'); END;
CREATE TRIGGER story_receipts_v34_immutable_update BEFORE UPDATE ON story_receipts_v34 BEGIN SELECT RAISE(ABORT,'story receipts are immutable'); END;
CREATE TRIGGER story_receipts_v34_immutable_delete BEFORE DELETE ON story_receipts_v34 BEGIN SELECT RAISE(ABORT,'story receipts are immutable'); END;
CREATE TRIGGER story_events_v34_conflict_insert BEFORE INSERT ON story_events_v34
      WHEN EXISTS(SELECT 1 FROM story_events_v34 old WHERE old.event_id=NEW.event_id OR (old.campaign_id=NEW.campaign_id AND old.command_id=NEW.command_id))
      BEGIN SELECT RAISE(ABORT,'story event identity is sealed'); END;
CREATE TRIGGER story_events_v34_validate_payload BEFORE INSERT ON story_events_v34
      WHEN (NEW.event_type='storyline-created' AND (SELECT count(*) FROM json_each(NEW.event_json))<>1)
        OR (NEW.event_type<>'storyline-created' AND (SELECT count(*) FROM json_each(NEW.event_json))<>3)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.command_id=NEW.command_id
        AND command.resulting_revision=NEW.resulting_revision AND command.created_at=NEW.occurred_at
        AND NEW.event_type=CASE command.command_type WHEN 'create-storyline' THEN 'storyline-created' WHEN 'reveal-node' THEN 'node-revealed'
          WHEN 'resolve-node' THEN 'node-resolved' WHEN 'reveal-clue' THEN 'clue-revealed' ELSE 'plot-point-answered' END
        AND json_extract(NEW.event_json,'$.storylineId')=command.storyline_id
        AND (command.command_type='create-storyline' OR (json_extract(NEW.event_json,'$.kind')=command.command_type
          AND json_extract(NEW.event_json,'$.targetId')=json_extract(command.canonical_request_json,'$.targetId'))))
      BEGIN SELECT RAISE(ABORT,'story event payload is invalid'); END;
CREATE TRIGGER story_events_v34_immutable_update BEFORE UPDATE ON story_events_v34 BEGIN SELECT RAISE(ABORT,'story events are immutable'); END;
CREATE TRIGGER story_events_v34_immutable_delete BEFORE DELETE ON story_events_v34 BEGIN SELECT RAISE(ABORT,'story events are immutable'); END;
CREATE TRIGGER story_discoveries_v34_immutable_update BEFORE UPDATE ON story_discoveries_v34 BEGIN SELECT RAISE(ABORT,'story discoveries are immutable'); END;
CREATE TRIGGER story_discoveries_v34_immutable_delete BEFORE DELETE ON story_discoveries_v34 BEGIN SELECT RAISE(ABORT,'story discoveries are immutable'); END;
CREATE TRIGGER story_root_v34_command_backed_insert BEFORE INSERT ON quest_storylines
      WHEN EXISTS(SELECT 1 FROM quest_storylines old WHERE old.id=NEW.id)
        OR length(NEW.id) NOT BETWEEN 1 AND 128 OR NEW.id GLOB '*[^A-Za-z0-9._:-]*'
        OR length(NEW.campaign_id) NOT BETWEEN 1 AND 128 OR NEW.campaign_id GLOB '*[^A-Za-z0-9._:-]*'
        OR length(NEW.title) NOT BETWEEN 1 AND 200 OR NEW.title<>trim(NEW.title) OR (NEW.description IS NOT NULL AND length(NEW.description)>4000)
        OR NEW.status<>'active' OR length(NEW.created_at)<>24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at)<>NEW.created_at
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.id AND command.command_type='create-storyline'
          AND command.created_at=NEW.created_at AND json_extract(command.canonical_request_json,'$.storyline.title')=NEW.title
          AND json_extract(command.canonical_request_json,'$.storyline.summary') IS NEW.description)
      BEGIN SELECT RAISE(ABORT,'v34 storyline roots require a create command'); END;
CREATE TRIGGER story_root_v34_metadata_update BEFORE UPDATE ON quest_storylines
      WHEN EXISTS(SELECT 1 FROM story_metadata_v34 metadata WHERE metadata.campaign_id=OLD.campaign_id AND metadata.storyline_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'v34 storyline roots are immutable'); END;
CREATE TRIGGER story_root_v34_metadata_delete BEFORE DELETE ON quest_storylines
      WHEN EXISTS(SELECT 1 FROM story_metadata_v34 metadata WHERE metadata.campaign_id=OLD.campaign_id AND metadata.storyline_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'v34 storyline roots are immutable'); END;
CREATE TRIGGER story_metadata_v34_guard_insert BEFORE INSERT ON story_metadata_v34
      WHEN EXISTS(SELECT 1 FROM story_metadata_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.storyline_id=NEW.storyline_id)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id
        AND command.command_id=NEW.created_command_id AND command.command_type='create-storyline' AND command.created_at=NEW.updated_at
        AND json_extract(command.canonical_request_json,'$.storyline.summary') IS NEW.summary AND NEW.status='active'
        AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story metadata provenance is invalid'); END;
CREATE TRIGGER story_nodes_v34_guard_insert BEFORE INSERT ON story_nodes_v34
      WHEN EXISTS(SELECT 1 FROM story_nodes_v34 old WHERE old.campaign_id=NEW.campaign_id AND (old.node_id=NEW.node_id OR (old.storyline_id=NEW.storyline_id AND old.node_id=NEW.node_id)))
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command JOIN json_each(command.canonical_request_json,'$.storyline.nodes') item
        WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id AND command.command_id=NEW.created_command_id
          AND command.command_type='create-storyline' AND CAST(item.key AS INTEGER)=NEW.sort_order
          AND json_extract(item.value,'$.nodeId')=NEW.node_id AND json_extract(item.value,'$.title')=NEW.title
          AND json_extract(item.value,'$.description') IS NEW.description AND json_extract(item.value,'$.gmNotes') IS NEW.gm_notes
          AND json_extract(item.value,'$.revealThreshold')=NEW.reveal_threshold
          AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story node provenance is invalid'); END;
CREATE TRIGGER story_edges_v34_guard_insert BEFORE INSERT ON story_edges_v34
      WHEN EXISTS(SELECT 1 FROM story_edges_v34 old WHERE old.campaign_id=NEW.campaign_id AND (old.edge_id=NEW.edge_id OR
        (old.storyline_id=NEW.storyline_id AND old.kind=NEW.kind AND old.from_node_id=NEW.from_node_id AND old.to_node_id=NEW.to_node_id)))
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command JOIN json_each(command.canonical_request_json,'$.storyline.edges') item
        WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id AND command.command_id=NEW.created_command_id
          AND command.command_type='create-storyline' AND json_extract(item.value,'$.edgeId')=NEW.edge_id AND json_extract(item.value,'$.kind')=NEW.kind
          AND json_extract(item.value,'$.fromNodeId')=NEW.from_node_id AND json_extract(item.value,'$.toNodeId')=NEW.to_node_id
          AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story edge provenance is invalid'); END;
CREATE TRIGGER story_edges_v34_reject_cycle BEFORE INSERT ON story_edges_v34
      WHEN EXISTS(WITH RECURSIVE reachable(node_id) AS (
        SELECT NEW.to_node_id UNION SELECT edge.to_node_id FROM story_edges_v34 edge JOIN reachable ON edge.from_node_id=reachable.node_id
          WHERE edge.campaign_id=NEW.campaign_id AND edge.storyline_id=NEW.storyline_id)
        SELECT 1 FROM reachable WHERE node_id=NEW.from_node_id)
      BEGIN SELECT RAISE(ABORT,'story edges contain a cycle'); END;
CREATE TRIGGER story_plot_points_v34_guard_insert BEFORE INSERT ON story_plot_points_v34
      WHEN EXISTS(SELECT 1 FROM story_plot_points_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.plot_point_id=NEW.plot_point_id)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command JOIN json_each(command.canonical_request_json,'$.storyline.plotPoints') item
        WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id AND command.command_id=NEW.created_command_id
          AND command.command_type='create-storyline' AND json_extract(item.value,'$.plotPointId')=NEW.plot_point_id
          AND json_extract(item.value,'$.nodeId')=NEW.node_id AND json_extract(item.value,'$.question')=NEW.question
          AND json_extract(item.value,'$.answer')=NEW.answer AND json_extract(item.value,'$.gmNotes') IS NEW.gm_notes
          AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story plot point provenance is invalid'); END;
CREATE TRIGGER story_clues_v34_guard_insert BEFORE INSERT ON story_clues_v34
      WHEN EXISTS(SELECT 1 FROM story_clues_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.clue_id=NEW.clue_id)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command JOIN json_each(command.canonical_request_json,'$.storyline.clues') item
        WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id AND command.command_id=NEW.created_command_id
          AND command.command_type='create-storyline' AND json_extract(item.value,'$.clueId')=NEW.clue_id
          AND json_extract(item.value,'$.title')=NEW.title AND json_extract(item.value,'$.content')=NEW.content
          AND json_extract(item.value,'$.truth')=NEW.truth AND json_extract(item.value,'$.gmNotes') IS NEW.gm_notes
          AND json_extract(item.value,'$.revealThreshold')=NEW.reveal_threshold
          AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story clue provenance is invalid'); END;
CREATE TRIGGER story_clue_sources_v34_validate_target BEFORE INSERT ON story_clue_sources_v34
      WHEN (NEW.source_kind='node' AND NOT EXISTS(SELECT 1 FROM story_nodes_v34 node WHERE node.campaign_id=NEW.campaign_id AND node.storyline_id=NEW.storyline_id AND node.node_id=NEW.target_id))
        OR (NEW.source_kind='plot-point' AND NOT EXISTS(SELECT 1 FROM story_plot_points_v34 point WHERE point.campaign_id=NEW.campaign_id AND point.storyline_id=NEW.storyline_id AND point.plot_point_id=NEW.target_id))
      BEGIN SELECT RAISE(ABORT,'story clue source target is invalid'); END;
CREATE TRIGGER story_clue_sources_v34_guard_insert BEFORE INSERT ON story_clue_sources_v34
      WHEN EXISTS(SELECT 1 FROM story_clue_sources_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.storyline_id=NEW.storyline_id AND old.clue_id=NEW.clue_id
        AND (old.source_id=NEW.source_id OR (old.source_kind=NEW.source_kind AND old.target_id=NEW.target_id)))
        OR NOT EXISTS(SELECT 1 FROM story_clues_v34 clue JOIN story_commands_v34 command ON command.campaign_id=clue.campaign_id AND command.command_id=clue.created_command_id
        JOIN json_each(command.canonical_request_json,'$.storyline.clues') clue_item JOIN json_each(clue_item.value,'$.sources') source_item
        WHERE clue.campaign_id=NEW.campaign_id AND clue.storyline_id=NEW.storyline_id AND clue.clue_id=NEW.clue_id AND command.storyline_id=NEW.storyline_id
          AND json_extract(clue_item.value,'$.clueId')=NEW.clue_id AND json_extract(source_item.value,'$.sourceId')=NEW.source_id
          AND json_extract(source_item.value,'$.kind')=NEW.source_kind AND json_extract(source_item.value,'$.targetId')=NEW.target_id
          AND command.command_type='create-storyline' AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story clue source provenance is invalid'); END;
CREATE TRIGGER story_node_state_v34_guard_insert BEFORE INSERT ON story_node_state_v34
      WHEN EXISTS(SELECT 1 FROM story_node_state_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.storyline_id=NEW.storyline_id AND old.node_id=NEW.node_id)
        OR NEW.status<>'hidden' OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id
          AND command.storyline_id=NEW.storyline_id AND command.command_id=NEW.last_command_id AND command.command_type='create-storyline'
          AND command.created_at=NEW.updated_at AND EXISTS(SELECT 1 FROM json_each(command.canonical_request_json,'$.storyline.nodes') item
            WHERE json_extract(item.value,'$.nodeId')=NEW.node_id))
      BEGIN SELECT RAISE(ABORT,'story node initial state provenance is invalid'); END;
CREATE TRIGGER story_node_state_v34_guard_update BEFORE UPDATE ON story_node_state_v34
      WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.storyline_id<>OLD.storyline_id OR NEW.node_id<>OLD.node_id
        OR NOT ((OLD.status='hidden' AND NEW.status='revealed') OR (OLD.status='revealed' AND NEW.status='resolved'))
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id
          AND command.command_id=NEW.last_command_id AND command.command_type=CASE NEW.status WHEN 'revealed' THEN 'reveal-node' ELSE 'resolve-node' END
          AND json_extract(command.canonical_request_json,'$.targetId')=NEW.node_id AND command.created_at=NEW.updated_at)
        OR (NEW.status IN ('revealed','resolved') AND EXISTS(SELECT 1 FROM story_edges_v34 edge JOIN story_node_state_v34 required
          ON required.campaign_id=edge.campaign_id AND required.storyline_id=edge.storyline_id AND required.node_id=edge.from_node_id
          WHERE edge.campaign_id=NEW.campaign_id AND edge.storyline_id=NEW.storyline_id AND edge.to_node_id=NEW.node_id
            AND edge.kind='requires' AND required.status<>'resolved'))
        OR (NEW.status='revealed' AND (SELECT count(*) FROM story_edges_v34 edge JOIN story_node_state_v34 contributor
          ON contributor.campaign_id=edge.campaign_id AND contributor.storyline_id=edge.storyline_id AND contributor.node_id=edge.from_node_id
          WHERE edge.campaign_id=NEW.campaign_id AND edge.storyline_id=NEW.storyline_id AND edge.to_node_id=NEW.node_id
            AND contributor.status='resolved') < (SELECT node.reveal_threshold FROM story_nodes_v34 node
              WHERE node.campaign_id=NEW.campaign_id AND node.storyline_id=NEW.storyline_id AND node.node_id=NEW.node_id))
      BEGIN SELECT RAISE(ABORT,'story node state transition provenance is invalid'); END;
CREATE TRIGGER story_node_state_v34_guard_delete BEFORE DELETE ON story_node_state_v34 BEGIN SELECT RAISE(ABORT,'story node state cannot be deleted'); END;
CREATE TRIGGER story_plot_point_answers_v34_guard_insert BEFORE INSERT ON story_plot_point_answers_v34
      WHEN EXISTS(SELECT 1 FROM story_plot_point_answers_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.storyline_id=NEW.storyline_id AND old.plot_point_id=NEW.plot_point_id)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id
        AND command.command_id=NEW.command_id AND command.command_type='answer-plot-point' AND command.created_at=NEW.answered_at
        AND json_extract(command.canonical_request_json,'$.targetId')=NEW.plot_point_id
        AND json_extract(command.canonical_request_json,'$.data.answer')=NEW.player_answer)
      BEGIN SELECT RAISE(ABORT,'story plot point answer provenance is invalid'); END;
CREATE TRIGGER story_plot_point_answers_v34_immutable_update BEFORE UPDATE ON story_plot_point_answers_v34 BEGIN SELECT RAISE(ABORT,'story plot point answers are immutable'); END;
CREATE TRIGGER story_plot_point_answers_v34_immutable_delete BEFORE DELETE ON story_plot_point_answers_v34 BEGIN SELECT RAISE(ABORT,'story plot point answers are immutable'); END;
CREATE TRIGGER story_discoveries_v34_guard_insert BEFORE INSERT ON story_discoveries_v34
      WHEN EXISTS(SELECT 1 FROM story_discoveries_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.storyline_id=NEW.storyline_id AND old.clue_id=NEW.clue_id)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id
        AND command.command_id=NEW.command_id AND command.command_type='reveal-clue' AND command.created_at=NEW.discovered_at
        AND json_extract(command.canonical_request_json,'$.targetId')=NEW.clue_id)
        OR (SELECT count(*) FROM story_clue_sources_v34 source WHERE source.campaign_id=NEW.campaign_id AND source.storyline_id=NEW.storyline_id
          AND source.clue_id=NEW.clue_id AND ((source.source_kind='node' AND EXISTS(SELECT 1 FROM story_node_state_v34 state
            WHERE state.campaign_id=source.campaign_id AND state.storyline_id=source.storyline_id AND state.node_id=source.target_id AND state.status<>'hidden'))
          OR (source.source_kind='plot-point' AND EXISTS(SELECT 1 FROM story_plot_point_answers_v34 answer WHERE answer.campaign_id=source.campaign_id
            AND answer.storyline_id=source.storyline_id AND answer.plot_point_id=source.target_id))))
          < (SELECT clue.reveal_threshold FROM story_clues_v34 clue WHERE clue.campaign_id=NEW.campaign_id AND clue.storyline_id=NEW.storyline_id AND clue.clue_id=NEW.clue_id)
      BEGIN SELECT RAISE(ABORT,'story discovery provenance is invalid'); END;
CREATE TRIGGER story_metadata_v34_immutable_update BEFORE UPDATE ON story_metadata_v34 BEGIN SELECT RAISE(ABORT,'story metadata is immutable'); END;
CREATE TRIGGER story_metadata_v34_immutable_delete BEFORE DELETE ON story_metadata_v34 BEGIN SELECT RAISE(ABORT,'story metadata is immutable'); END;
CREATE TRIGGER story_nodes_v34_immutable_update BEFORE UPDATE ON story_nodes_v34 BEGIN SELECT RAISE(ABORT,'story nodes are immutable'); END;
CREATE TRIGGER story_nodes_v34_immutable_delete BEFORE DELETE ON story_nodes_v34 BEGIN SELECT RAISE(ABORT,'story nodes are immutable'); END;
CREATE TRIGGER story_edges_v34_immutable_update BEFORE UPDATE ON story_edges_v34 BEGIN SELECT RAISE(ABORT,'story edges are immutable'); END;
CREATE TRIGGER story_edges_v34_immutable_delete BEFORE DELETE ON story_edges_v34 BEGIN SELECT RAISE(ABORT,'story edges are immutable'); END;
CREATE TRIGGER story_plot_points_v34_immutable_update BEFORE UPDATE ON story_plot_points_v34 BEGIN SELECT RAISE(ABORT,'story plot points are immutable'); END;
CREATE TRIGGER story_plot_points_v34_immutable_delete BEFORE DELETE ON story_plot_points_v34 BEGIN SELECT RAISE(ABORT,'story plot points are immutable'); END;
CREATE TRIGGER story_clues_v34_immutable_update BEFORE UPDATE ON story_clues_v34 BEGIN SELECT RAISE(ABORT,'story clues are immutable'); END;
CREATE TRIGGER story_clues_v34_immutable_delete BEFORE DELETE ON story_clues_v34 BEGIN SELECT RAISE(ABORT,'story clues are immutable'); END;
CREATE TRIGGER story_clue_sources_v34_immutable_update BEFORE UPDATE ON story_clue_sources_v34 BEGIN SELECT RAISE(ABORT,'story clue sources are immutable'); END;
CREATE TRIGGER story_clue_sources_v34_immutable_delete BEFORE DELETE ON story_clue_sources_v34 BEGIN SELECT RAISE(ABORT,'story clue sources are immutable'); END;
CREATE UNIQUE INDEX uq_campaign_sessions_campaign_session_v35 ON campaign_sessions(campaign_id,session_id);
CREATE TABLE adventure_turns (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      timeline_id TEXT NOT NULL CHECK(length(timeline_id) BETWEEN 1 AND 128 AND timeline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 128 AND session_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128 AND actor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 128 AND principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      declaration TEXT NOT NULL CHECK(length(trim(declaration)) BETWEEN 1 AND 8000),
      mode TEXT NOT NULL CHECK(mode IN ('original','narration-retry','narration-swipe')),
      prior_turn_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('declared','proposed','awaiting-confirmation','mechanics-committed','narrating','completed','cancelled','failed')),
      narration_status TEXT NOT NULL CHECK(narration_status IN ('none','pending','in-progress','completed','failed')),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      campaign_revision INTEGER NOT NULL CHECK(typeof(campaign_revision)='integer' AND campaign_revision BETWEEN 0 AND 9007199254740991),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND updated_at>=created_at),
      CHECK((mode='original' AND prior_turn_id IS NULL) OR (mode<>'original' AND prior_turn_id IS NOT NULL AND prior_turn_id<>id)),
      CHECK((state IN ('declared','proposed','awaiting-confirmation') AND narration_status='none') OR
        (state='mechanics-committed' AND narration_status IN ('none','pending')) OR
        (state='narrating' AND narration_status IN ('pending','in-progress','failed')) OR
        (state='completed' AND narration_status='completed') OR (state IN ('cancelled','failed'))),
      UNIQUE(campaign_id,id), UNIQUE(campaign_id,idempotency_key),
      FOREIGN KEY(campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,prior_turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT
    );
CREATE INDEX idx_adventure_turns_session_v35 ON adventure_turns(session_id,created_at,id);
CREATE INDEX idx_adventure_turns_campaign_state_v35 ON adventure_turns(campaign_id,state,updated_at,id);
CREATE TABLE tool_proposals (
      proposal_id TEXT PRIMARY KEY CHECK(length(proposal_id) BETWEEN 1 AND 128 AND proposal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 31),
      tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 128 AND tool_name NOT GLOB '*[^A-Za-z0-9._:-]*'),
      arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json)='object' AND length(arguments_json)<=32768),
      requires_confirmation INTEGER NOT NULL CHECK(typeof(requires_confirmation)='integer' AND requires_confirmation IN (0,1)),
      confirmation_expires_at TEXT CHECK((requires_confirmation=0 AND confirmation_expires_at IS NULL) OR
        (requires_confirmation=1 AND length(confirmation_expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',confirmation_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',confirmation_expires_at)=confirmation_expires_at)),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      proposed_at TEXT NOT NULL CHECK(length(proposed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',proposed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',proposed_at)=proposed_at),
      UNIQUE(campaign_id,turn_id,position), UNIQUE(campaign_id,turn_id,idempotency_key), UNIQUE(campaign_id,turn_id,proposal_id),
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT
    );
CREATE INDEX idx_tool_proposals_turn_v35 ON tool_proposals(campaign_id,turn_id,position);
CREATE TABLE confirmation_decisions (
      decision_id TEXT PRIMARY KEY CHECK(length(decision_id) BETWEEN 1 AND 128 AND decision_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','expired')),
      expected_turn_revision INTEGER NOT NULL CHECK(typeof(expected_turn_revision)='integer' AND expected_turn_revision BETWEEN 0 AND 9007199254740990),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
      decided_at TEXT NOT NULL CHECK(length(decided_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',decided_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',decided_at)=decided_at),
      CHECK((decision='expired' AND decided_at>=expires_at) OR (decision<>'expired' AND decided_at<expires_at)),
      UNIQUE(campaign_id,turn_id,proposal_id), UNIQUE(campaign_id,turn_id,idempotency_key),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );
CREATE TABLE provider_call_metadata (
      record_id TEXT PRIMARY KEY CHECK(length(record_id) BETWEEN 1 AND 128 AND record_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, call_id TEXT NOT NULL CHECK(length(call_id) BETWEEN 1 AND 128 AND call_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      phase TEXT NOT NULL CHECK(phase IN ('started','succeeded','failed','cancelled')), provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 128),
      model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 256), attempt INTEGER NOT NULL CHECK(typeof(attempt)='integer' AND attempt BETWEEN 1 AND 32),
      prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR (typeof(prompt_tokens)='integer' AND prompt_tokens BETWEEN 0 AND 1000000000)),
      completion_tokens INTEGER CHECK(completion_tokens IS NULL OR (typeof(completion_tokens)='integer' AND completion_tokens BETWEEN 0 AND 1000000000)),
      outcome_code TEXT CHECK(outcome_code IS NULL OR length(outcome_code) BETWEEN 1 AND 128),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      recorded_at TEXT NOT NULL CHECK(length(recorded_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at),
      CHECK((phase='started' AND prompt_tokens IS NULL AND completion_tokens IS NULL AND outcome_code IS NULL) OR
        (phase<>'started' AND outcome_code IS NOT NULL)),
      UNIQUE(campaign_id,turn_id,call_id,phase), UNIQUE(campaign_id,turn_id,idempotency_key),
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT
    );
CREATE INDEX idx_provider_calls_turn_v35 ON provider_call_metadata(campaign_id,turn_id,call_id,recorded_at);
CREATE TABLE generation_drafts (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL,
      timeline_id TEXT NOT NULL, session_id TEXT, principal_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('encounter','location','npc','faction','quest','storyline','content-pack')),
      staged_content_json TEXT NOT NULL CHECK(json_valid(staged_content_json) AND json_type(staged_content_json)='object' AND length(staged_content_json)<=1048576),
      validation_json TEXT NOT NULL CHECK(json_valid(validation_json) AND json_type(validation_json)='object' AND length(validation_json)<=262144),
      state TEXT NOT NULL CHECK(state IN ('staged','in-review','approved','rejected','applied','cancelled')),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      campaign_revision INTEGER NOT NULL CHECK(typeof(campaign_revision)='integer' AND campaign_revision BETWEEN 0 AND 9007199254740991),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND updated_at>=created_at),
      UNIQUE(campaign_id,id), UNIQUE(campaign_id,idempotency_key),
      FOREIGN KEY(campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );
CREATE INDEX idx_generation_drafts_campaign_v35 ON generation_drafts(campaign_id,state,updated_at,id);
CREATE TABLE review_decisions (
      decision_id TEXT PRIMARY KEY CHECK(length(decision_id) BETWEEN 1 AND 128 AND decision_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, draft_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')), notes TEXT CHECK(notes IS NULL OR length(notes)<=4000),
      expected_draft_revision INTEGER NOT NULL CHECK(typeof(expected_draft_revision)='integer' AND expected_draft_revision BETWEEN 0 AND 9007199254740990),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      decided_at TEXT NOT NULL CHECK(length(decided_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',decided_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',decided_at)=decided_at),
      UNIQUE(campaign_id,draft_id), UNIQUE(campaign_id,draft_id,idempotency_key),
      FOREIGN KEY(campaign_id,draft_id) REFERENCES generation_drafts(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );
CREATE TABLE final_receipt_links (
      link_id TEXT PRIMARY KEY CHECK(length(link_id) BETWEEN 1 AND 128 AND link_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, turn_id TEXT, draft_id TEXT, command_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      linked_at TEXT NOT NULL CHECK(length(linked_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',linked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',linked_at)=linked_at),
      CHECK((turn_id IS NULL)<>(draft_id IS NULL)), UNIQUE(campaign_id,command_id),
      UNIQUE(campaign_id,turn_id,idempotency_key), UNIQUE(campaign_id,draft_id,idempotency_key),
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,draft_id) REFERENCES generation_drafts(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,command_id) REFERENCES command_receipts(campaign_id,command_id) ON DELETE RESTRICT
    );
CREATE INDEX idx_final_receipt_links_turn_v35 ON final_receipt_links(campaign_id,turn_id,linked_at);
CREATE INDEX idx_final_receipt_links_draft_v35 ON final_receipt_links(campaign_id,draft_id,linked_at);
CREATE TRIGGER adventure_turns_conflict_insert_v35 BEFORE INSERT ON adventure_turns WHEN EXISTS(SELECT 1 FROM adventure_turns old
      WHERE old.id=NEW.id OR (old.campaign_id=NEW.campaign_id AND old.idempotency_key=NEW.idempotency_key)) OR
      NOT EXISTS(SELECT 1 FROM campaigns campaign WHERE campaign.id=NEW.campaign_id AND campaign.active_timeline_id=NEW.timeline_id) OR
      NOT EXISTS(SELECT 1 FROM campaign_sessions attached WHERE attached.campaign_id=NEW.campaign_id AND attached.session_id=NEW.session_id) OR
      NOT EXISTS(SELECT 1 FROM campaign_actors actor WHERE actor.campaign_id=NEW.campaign_id AND actor.id=NEW.actor_id) OR
      NOT EXISTS(SELECT 1 FROM campaign_memberships member WHERE member.campaign_id=NEW.campaign_id AND member.principal_id=NEW.principal_id) OR
      (NEW.prior_turn_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM adventure_turns prior WHERE prior.campaign_id=NEW.campaign_id AND prior.id=NEW.prior_turn_id
        AND prior.timeline_id=NEW.timeline_id AND prior.session_id=NEW.session_id AND prior.actor_id=NEW.actor_id))
      BEGIN SELECT RAISE(ABORT,'adventure turn identity or ancestry is invalid'); END;
CREATE TRIGGER adventure_turns_guard_delete_v35 BEFORE DELETE ON adventure_turns BEGIN SELECT RAISE(ABORT,'adventure turns cannot be deleted'); END;
CREATE TRIGGER generation_drafts_conflict_insert_v35 BEFORE INSERT ON generation_drafts WHEN EXISTS(SELECT 1 FROM generation_drafts old
      WHERE old.id=NEW.id OR (old.campaign_id=NEW.campaign_id AND old.idempotency_key=NEW.idempotency_key)) OR
      NOT EXISTS(SELECT 1 FROM campaigns campaign WHERE campaign.id=NEW.campaign_id AND campaign.active_timeline_id=NEW.timeline_id) OR
      NOT EXISTS(SELECT 1 FROM campaign_memberships member WHERE member.campaign_id=NEW.campaign_id AND member.principal_id=NEW.principal_id) OR
      (NEW.session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM campaign_sessions attached WHERE attached.campaign_id=NEW.campaign_id AND attached.session_id=NEW.session_id))
      BEGIN SELECT RAISE(ABORT,'generation draft identity or ancestry is invalid'); END;
CREATE TRIGGER generation_drafts_guard_delete_v35 BEFORE DELETE ON generation_drafts BEGIN SELECT RAISE(ABORT,'generation drafts cannot be deleted'); END;
CREATE TRIGGER provider_call_metadata_guard_insert_v35 BEFORE INSERT ON provider_call_metadata WHEN EXISTS(SELECT 1 FROM provider_call_metadata old WHERE old.record_id=NEW.record_id OR
      (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.idempotency_key=NEW.idempotency_key OR (old.call_id=NEW.call_id AND old.phase=NEW.phase)))) OR
      (NEW.phase='started' AND EXISTS(SELECT 1 FROM provider_call_metadata old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND old.call_id=NEW.call_id)) OR
      (NEW.phase<>'started' AND NOT EXISTS(SELECT 1 FROM provider_call_metadata start WHERE start.campaign_id=NEW.campaign_id AND start.turn_id=NEW.turn_id AND start.call_id=NEW.call_id AND start.phase='started' AND start.provider=NEW.provider AND start.model=NEW.model AND start.attempt=NEW.attempt AND start.recorded_at<=NEW.recorded_at))
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate provider call metadata'); END;
CREATE TRIGGER final_receipt_links_guard_insert_v35 BEFORE INSERT ON final_receipt_links WHEN EXISTS(SELECT 1 FROM final_receipt_links old WHERE old.link_id=NEW.link_id OR
      (old.campaign_id=NEW.campaign_id AND (old.command_id=NEW.command_id OR (old.turn_id IS NEW.turn_id AND old.draft_id IS NEW.draft_id AND old.idempotency_key=NEW.idempotency_key)))) OR
      (NEW.turn_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM adventure_turns turn WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id
        AND (turn.state IN ('mechanics-committed','narrating','completed') OR (turn.state='proposed' AND NOT EXISTS(
          SELECT 1 FROM tool_proposals proposal WHERE proposal.campaign_id=turn.campaign_id AND proposal.turn_id=turn.id AND proposal.requires_confirmation=1))))) OR
      (NEW.draft_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM generation_drafts draft WHERE draft.campaign_id=NEW.campaign_id AND draft.id=NEW.draft_id AND draft.state IN ('approved','applied')))
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate final receipt link'); END;
CREATE TRIGGER tool_proposals_immutable_update_v35 BEFORE UPDATE ON tool_proposals BEGIN SELECT RAISE(ABORT,'tool_proposals records are immutable'); END;
CREATE TRIGGER tool_proposals_immutable_delete_v35 BEFORE DELETE ON tool_proposals BEGIN SELECT RAISE(ABORT,'tool_proposals records are immutable'); END;
CREATE TRIGGER confirmation_decisions_immutable_update_v35 BEFORE UPDATE ON confirmation_decisions BEGIN SELECT RAISE(ABORT,'confirmation_decisions records are immutable'); END;
CREATE TRIGGER confirmation_decisions_immutable_delete_v35 BEFORE DELETE ON confirmation_decisions BEGIN SELECT RAISE(ABORT,'confirmation_decisions records are immutable'); END;
CREATE TRIGGER provider_call_metadata_immutable_update_v35 BEFORE UPDATE ON provider_call_metadata BEGIN SELECT RAISE(ABORT,'provider_call_metadata records are immutable'); END;
CREATE TRIGGER provider_call_metadata_immutable_delete_v35 BEFORE DELETE ON provider_call_metadata BEGIN SELECT RAISE(ABORT,'provider_call_metadata records are immutable'); END;
CREATE TRIGGER review_decisions_immutable_update_v35 BEFORE UPDATE ON review_decisions BEGIN SELECT RAISE(ABORT,'review_decisions records are immutable'); END;
CREATE TRIGGER review_decisions_immutable_delete_v35 BEFORE DELETE ON review_decisions BEGIN SELECT RAISE(ABORT,'review_decisions records are immutable'); END;
CREATE TRIGGER final_receipt_links_immutable_update_v35 BEFORE UPDATE ON final_receipt_links BEGIN SELECT RAISE(ABORT,'final_receipt_links records are immutable'); END;
CREATE TRIGGER final_receipt_links_immutable_delete_v35 BEFORE DELETE ON final_receipt_links BEGIN SELECT RAISE(ABORT,'final_receipt_links records are immutable'); END;
CREATE TABLE adventure_coordination_commands_v36(
      command_id TEXT PRIMARY KEY, aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('turn','draft')),
      campaign_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      mutation_type TEXT NOT NULL CHECK(length(mutation_type) BETWEEN 1 AND 64), idempotency_key TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN -1 AND 9007199254740990),
      expected_campaign_revision INTEGER NOT NULL CHECK(typeof(expected_campaign_revision)='integer' AND expected_campaign_revision BETWEEN 0 AND 9007199254740991),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 0 AND 9007199254740991),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'), created_at TEXT NOT NULL,
      UNIQUE(aggregate_kind,campaign_id,aggregate_id,idempotency_key), UNIQUE(aggregate_kind,campaign_id,aggregate_id,resulting_revision),
      UNIQUE(command_id,aggregate_kind,campaign_id,aggregate_id,principal_id,expected_revision,resulting_revision),
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT);
CREATE INDEX idx_adventure_coordination_commands_aggregate_v36 ON adventure_coordination_commands_v36(aggregate_kind,campaign_id,aggregate_id,resulting_revision);
CREATE TABLE adventure_coordination_events_v36(
      event_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, aggregate_kind TEXT NOT NULL, campaign_id TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, mutation_type TEXT NOT NULL, expected_revision INTEGER NOT NULL, resulting_revision INTEGER NOT NULL,
      resulting_state TEXT NOT NULL, narration_status TEXT, event_json TEXT NOT NULL CHECK(json_valid(event_json) AND json_type(event_json)='object'), occurred_at TEXT NOT NULL,
      UNIQUE(aggregate_kind,campaign_id,aggregate_id,resulting_revision),
      FOREIGN KEY(command_id,aggregate_kind,campaign_id,aggregate_id,principal_id,expected_revision,resulting_revision)
        REFERENCES adventure_coordination_commands_v36(command_id,aggregate_kind,campaign_id,aggregate_id,principal_id,expected_revision,resulting_revision) ON DELETE RESTRICT);
CREATE TABLE adventure_coordination_receipts_v36(
      command_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, aggregate_kind TEXT NOT NULL, campaign_id TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL, resulting_revision INTEGER NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),
      FOREIGN KEY(command_id) REFERENCES adventure_coordination_commands_v36(command_id) ON DELETE RESTRICT,
      FOREIGN KEY(event_id) REFERENCES adventure_coordination_events_v36(event_id) ON DELETE RESTRICT);
CREATE TABLE turn_mechanics_links_v36(
      link_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, root_turn_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL, command_id TEXT NOT NULL, source_turn_id TEXT NOT NULL, linked_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,proposal_id), UNIQUE(campaign_id,command_id),
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,root_turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,command_id) REFERENCES command_receipts(campaign_id,command_id) ON DELETE RESTRICT);
CREATE INDEX idx_turn_mechanics_links_turn_v36 ON turn_mechanics_links_v36(campaign_id,root_turn_id,linked_at,link_id);
CREATE TABLE generation_draft_apply_receipts_v36(
      receipt_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, draft_id TEXT NOT NULL UNIQUE, review_decision_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, expected_draft_revision INTEGER NOT NULL, resulting_draft_revision INTEGER NOT NULL,
      result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'), applied_at TEXT NOT NULL,
      FOREIGN KEY(campaign_id,draft_id) REFERENCES generation_drafts(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(review_decision_id) REFERENCES review_decisions(decision_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT);
CREATE TRIGGER adventure_coordination_commands_validate_v36 BEFORE INSERT ON adventure_coordination_commands_v36 WHEN
      EXISTS(SELECT 1 FROM adventure_coordination_commands_v36 old WHERE old.command_id=NEW.command_id OR
        (old.aggregate_kind=NEW.aggregate_kind AND old.campaign_id=NEW.campaign_id AND old.aggregate_id=NEW.aggregate_id AND old.idempotency_key=NEW.idempotency_key)) OR
      (NEW.mutation_type<>'migration-snapshot' AND ((NOT EXISTS(SELECT 1 FROM adventure_coordination_events_v36 prior WHERE prior.aggregate_kind=NEW.aggregate_kind AND prior.campaign_id=NEW.campaign_id AND prior.aggregate_id=NEW.aggregate_id) AND NEW.expected_revision<>-1)
        OR (EXISTS(SELECT 1 FROM adventure_coordination_events_v36 prior WHERE prior.aggregate_kind=NEW.aggregate_kind AND prior.campaign_id=NEW.campaign_id AND prior.aggregate_id=NEW.aggregate_id) AND NEW.expected_revision<>(SELECT max(resulting_revision) FROM adventure_coordination_events_v36 prior WHERE prior.aggregate_kind=NEW.aggregate_kind AND prior.campaign_id=NEW.campaign_id AND prior.aggregate_id=NEW.aggregate_id))
        OR NEW.resulting_revision<>NEW.expected_revision+1))
      BEGIN SELECT RAISE(ABORT,'invalid adventure coordination command'); END;
CREATE TRIGGER adventure_coordination_events_validate_v36 BEFORE INSERT ON adventure_coordination_events_v36 WHEN
      EXISTS(SELECT 1 FROM adventure_coordination_events_v36 old WHERE old.event_id=NEW.event_id OR old.command_id=NEW.command_id OR
        (old.aggregate_kind=NEW.aggregate_kind AND old.campaign_id=NEW.campaign_id AND old.aggregate_id=NEW.aggregate_id AND old.resulting_revision=NEW.resulting_revision)) OR
      (NEW.aggregate_kind='turn' AND NOT EXISTS(SELECT 1 FROM adventure_turns turn WHERE turn.campaign_id=NEW.campaign_id
        AND turn.id=NEW.aggregate_id AND turn.revision=NEW.resulting_revision)) OR
      (NEW.aggregate_kind='draft' AND NOT EXISTS(SELECT 1 FROM generation_drafts draft WHERE draft.campaign_id=NEW.campaign_id
        AND draft.id=NEW.aggregate_id AND draft.revision=NEW.resulting_revision))
      BEGIN SELECT RAISE(ABORT,'invalid adventure coordination event'); END;
CREATE TRIGGER adventure_coordination_receipts_validate_v36 BEFORE INSERT ON adventure_coordination_receipts_v36 WHEN
      EXISTS(SELECT 1 FROM adventure_coordination_receipts_v36 old WHERE old.command_id=NEW.command_id OR old.event_id=NEW.event_id) OR
      NOT EXISTS(SELECT 1 FROM adventure_coordination_events_v36 event WHERE event.event_id=NEW.event_id AND event.command_id=NEW.command_id
        AND event.aggregate_kind=NEW.aggregate_kind AND event.campaign_id=NEW.campaign_id AND event.aggregate_id=NEW.aggregate_id
        AND event.expected_revision=NEW.expected_revision AND event.resulting_revision=NEW.resulting_revision)
      BEGIN SELECT RAISE(ABORT,'invalid adventure coordination receipt'); END;
CREATE TRIGGER turn_mechanics_links_validate_v36 BEFORE INSERT ON turn_mechanics_links_v36 WHEN
      EXISTS(SELECT 1 FROM turn_mechanics_links_v36 old WHERE old.link_id=NEW.link_id OR (old.campaign_id=NEW.campaign_id AND (old.command_id=NEW.command_id OR (old.turn_id=NEW.turn_id AND old.proposal_id=NEW.proposal_id)))) OR
      NEW.turn_id<>NEW.root_turn_id OR NEW.source_turn_id<>NEW.root_turn_id OR
      NOT EXISTS(SELECT 1 FROM tool_proposals proposal LEFT JOIN confirmation_decisions decision ON decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id
        WHERE proposal.campaign_id=NEW.campaign_id AND proposal.turn_id=NEW.turn_id AND proposal.proposal_id=NEW.proposal_id AND
          (proposal.requires_confirmation=0 OR decision.decision='approved')) OR
      NOT EXISTS(SELECT 1 FROM adventure_turns turn JOIN campaigns campaign ON campaign.id=turn.campaign_id AND campaign.active_timeline_id=turn.timeline_id
        JOIN campaign_commands command ON command.campaign_id=turn.campaign_id AND command.command_id=NEW.command_id
          AND command.timeline_id=turn.timeline_id AND command.actor_id=turn.actor_id AND command.source_turn_id=turn.id
        JOIN command_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        JOIN campaign_events event ON event.campaign_id=receipt.campaign_id AND event.command_id=receipt.command_id AND event.event_id=receipt.event_id
          AND event.timeline_id=turn.timeline_id AND event.actor_id=turn.actor_id AND event.source_turn_id=turn.id
        JOIN tool_proposals proposal ON proposal.campaign_id=turn.campaign_id AND proposal.turn_id=turn.id AND proposal.proposal_id=NEW.proposal_id
        WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND NEW.source_turn_id=turn.id AND
          (proposal.tool_name=command.type OR (proposal.tool_name IN ('roll','roll-check','roll_actor_dice') AND command.type='roll_actor_dice')))
      BEGIN SELECT RAISE(ABORT,'invalid mechanics receipt provenance'); END;
CREATE TRIGGER generation_draft_apply_receipts_validate_v36 BEFORE INSERT ON generation_draft_apply_receipts_v36 WHEN
      EXISTS(SELECT 1 FROM generation_draft_apply_receipts_v36 old WHERE old.receipt_id=NEW.receipt_id OR (old.campaign_id=NEW.campaign_id AND old.draft_id=NEW.draft_id)) OR
      NEW.resulting_draft_revision<>NEW.expected_draft_revision+1 OR NOT EXISTS(SELECT 1 FROM review_decisions review
        JOIN generation_drafts draft ON draft.campaign_id=review.campaign_id AND draft.id=review.draft_id
        WHERE review.decision_id=NEW.review_decision_id AND review.campaign_id=NEW.campaign_id AND review.draft_id=NEW.draft_id
          AND review.decision='approved' AND draft.state IN ('approved','applied'))
      BEGIN SELECT RAISE(ABORT,'invalid draft apply receipt provenance'); END;
CREATE TRIGGER provider_call_metadata_bound_v36 BEFORE INSERT ON provider_call_metadata WHEN
      (SELECT count(*) FROM provider_call_metadata old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)>=64
      BEGIN SELECT RAISE(ABORT,'provider call metadata limit exceeded'); END;
CREATE TRIGGER final_receipt_links_provenance_v36 BEFORE INSERT ON final_receipt_links WHEN NEW.turn_id IS NOT NULL AND
      NOT EXISTS(SELECT 1 FROM turn_mechanics_links_v36 sidecar WHERE sidecar.link_id=NEW.link_id AND sidecar.campaign_id=NEW.campaign_id
        AND sidecar.turn_id=NEW.turn_id AND sidecar.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'final receipt link requires v36 provenance'); END;
CREATE TRIGGER adventure_turns_guard_update_v36 BEFORE UPDATE ON adventure_turns WHEN NEW.id<>OLD.id OR NEW.campaign_id<>OLD.campaign_id OR
      NEW.timeline_id<>OLD.timeline_id OR NEW.session_id<>OLD.session_id OR NEW.actor_id<>OLD.actor_id OR NEW.principal_id<>OLD.principal_id OR
      NEW.declaration<>OLD.declaration OR NEW.mode<>OLD.mode OR NEW.prior_turn_id IS NOT OLD.prior_turn_id OR NEW.idempotency_key<>OLD.idempotency_key OR
      NEW.created_at<>OLD.created_at OR NEW.campaign_revision<>OLD.campaign_revision OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR NOT (
        (OLD.state='declared' AND NEW.state IN ('declared','proposed','narrating','cancelled','failed')) OR
        (OLD.state='proposed' AND NEW.state IN ('proposed','awaiting-confirmation','mechanics-committed','cancelled','failed')) OR
        (OLD.state='awaiting-confirmation' AND NEW.state IN ('awaiting-confirmation','mechanics-committed','cancelled','failed')) OR
        (OLD.state='mechanics-committed' AND NEW.state IN ('mechanics-committed','narrating','completed','cancelled','failed')) OR
        (OLD.state='narrating' AND NEW.state IN ('narrating','completed','cancelled','failed')))
      BEGIN SELECT RAISE(ABORT,'invalid adventure turn transition'); END;
CREATE TRIGGER confirmation_decisions_guard_insert_v36 BEFORE INSERT ON confirmation_decisions WHEN EXISTS(SELECT 1 FROM confirmation_decisions old
      WHERE old.decision_id=NEW.decision_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND
        (old.proposal_id=NEW.proposal_id OR old.idempotency_key=NEW.idempotency_key))) OR
      NOT EXISTS(SELECT 1 FROM adventure_turns turn JOIN tool_proposals proposal ON proposal.campaign_id=turn.campaign_id AND proposal.turn_id=turn.id
        WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND proposal.proposal_id=NEW.proposal_id AND proposal.requires_confirmation=1
          AND proposal.confirmation_expires_at=NEW.expires_at AND turn.state='awaiting-confirmation' AND turn.revision=NEW.expected_turn_revision)
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate confirmation decision'); END;
CREATE TRIGGER generation_drafts_guard_update_v36 BEFORE UPDATE ON generation_drafts WHEN NEW.id<>OLD.id OR NEW.campaign_id<>OLD.campaign_id OR
      NEW.timeline_id<>OLD.timeline_id OR NEW.session_id IS NOT OLD.session_id OR NEW.principal_id<>OLD.principal_id OR NEW.kind<>OLD.kind OR
      NEW.idempotency_key<>OLD.idempotency_key OR NEW.created_at<>OLD.created_at OR NEW.campaign_revision<>OLD.campaign_revision OR
      NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR NOT ((OLD.state='staged' AND NEW.state IN ('staged','in-review','approved','rejected','cancelled')) OR
      (OLD.state='in-review' AND NEW.state IN ('in-review','approved','rejected','cancelled')) OR (OLD.state='approved' AND NEW.state IN ('approved','applied','cancelled')))
      BEGIN SELECT RAISE(ABORT,'invalid generation draft transition'); END;
CREATE TRIGGER review_decisions_guard_insert_v36 BEFORE INSERT ON review_decisions WHEN EXISTS(SELECT 1 FROM review_decisions old
      WHERE old.decision_id=NEW.decision_id OR (old.campaign_id=NEW.campaign_id AND old.draft_id=NEW.draft_id)) OR
      NOT EXISTS(SELECT 1 FROM generation_drafts draft WHERE draft.campaign_id=NEW.campaign_id AND draft.id=NEW.draft_id
        AND draft.state IN ('staged','in-review') AND draft.revision=NEW.expected_draft_revision) OR NOT EXISTS(SELECT 1 FROM campaign_memberships member
        WHERE member.campaign_id=NEW.campaign_id AND member.principal_id=NEW.principal_id AND member.role IN ('owner','gm'))
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate review decision'); END;
CREATE TRIGGER adventure_coordination_commands_v36_insert_v36 BEFORE INSERT ON adventure_coordination_commands_v36 WHEN EXISTS(SELECT 1 FROM adventure_coordination_commands_v36 old WHERE old.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'adventure_coordination_commands_v36 records are immutable'); END;
CREATE TRIGGER adventure_coordination_commands_v36_update_v36 BEFORE UPDATE ON adventure_coordination_commands_v36 BEGIN SELECT RAISE(ABORT,'adventure_coordination_commands_v36 records are immutable'); END;
CREATE TRIGGER adventure_coordination_commands_v36_delete_v36 BEFORE DELETE ON adventure_coordination_commands_v36 BEGIN SELECT RAISE(ABORT,'adventure_coordination_commands_v36 records are immutable'); END;
CREATE TRIGGER adventure_coordination_events_v36_insert_v36 BEFORE INSERT ON adventure_coordination_events_v36 WHEN EXISTS(SELECT 1 FROM adventure_coordination_events_v36 old WHERE old.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'adventure_coordination_events_v36 records are immutable'); END;
CREATE TRIGGER adventure_coordination_events_v36_update_v36 BEFORE UPDATE ON adventure_coordination_events_v36 BEGIN SELECT RAISE(ABORT,'adventure_coordination_events_v36 records are immutable'); END;
CREATE TRIGGER adventure_coordination_events_v36_delete_v36 BEFORE DELETE ON adventure_coordination_events_v36 BEGIN SELECT RAISE(ABORT,'adventure_coordination_events_v36 records are immutable'); END;
CREATE TRIGGER adventure_coordination_receipts_v36_insert_v36 BEFORE INSERT ON adventure_coordination_receipts_v36 WHEN EXISTS(SELECT 1 FROM adventure_coordination_receipts_v36 old WHERE old.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'adventure_coordination_receipts_v36 records are immutable'); END;
CREATE TRIGGER adventure_coordination_receipts_v36_update_v36 BEFORE UPDATE ON adventure_coordination_receipts_v36 BEGIN SELECT RAISE(ABORT,'adventure_coordination_receipts_v36 records are immutable'); END;
CREATE TRIGGER adventure_coordination_receipts_v36_delete_v36 BEFORE DELETE ON adventure_coordination_receipts_v36 BEGIN SELECT RAISE(ABORT,'adventure_coordination_receipts_v36 records are immutable'); END;
CREATE TRIGGER turn_mechanics_links_v36_insert_v36 BEFORE INSERT ON turn_mechanics_links_v36 WHEN EXISTS(SELECT 1 FROM turn_mechanics_links_v36 old WHERE old.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'turn_mechanics_links_v36 records are immutable'); END;
CREATE TRIGGER turn_mechanics_links_v36_update_v36 BEFORE UPDATE ON turn_mechanics_links_v36 BEGIN SELECT RAISE(ABORT,'turn_mechanics_links_v36 records are immutable'); END;
CREATE TRIGGER turn_mechanics_links_v36_delete_v36 BEFORE DELETE ON turn_mechanics_links_v36 BEGIN SELECT RAISE(ABORT,'turn_mechanics_links_v36 records are immutable'); END;
CREATE TRIGGER generation_draft_apply_receipts_v36_insert_v36 BEFORE INSERT ON generation_draft_apply_receipts_v36 WHEN EXISTS(SELECT 1 FROM generation_draft_apply_receipts_v36 old WHERE old.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'generation_draft_apply_receipts_v36 records are immutable'); END;
CREATE TRIGGER generation_draft_apply_receipts_v36_update_v36 BEFORE UPDATE ON generation_draft_apply_receipts_v36 BEGIN SELECT RAISE(ABORT,'generation_draft_apply_receipts_v36 records are immutable'); END;
CREATE TRIGGER generation_draft_apply_receipts_v36_delete_v36 BEFORE DELETE ON generation_draft_apply_receipts_v36 BEGIN SELECT RAISE(ABORT,'generation_draft_apply_receipts_v36 records are immutable'); END;
CREATE TABLE tool_proposal_execution_bindings_v37(
      proposal_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      execution_idempotency_key TEXT NOT NULL CHECK(length(execution_idempotency_key) BETWEEN 1 AND 128
        AND execution_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      command_type TEXT NOT NULL CHECK(command_type IN ('set_actor_attribute','initialize_actor_resource','roll_actor_dice')),
      source_turn_id TEXT NOT NULL, timeline_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      bound_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',bound_at) IS NOT NULL
        AND bound_at=strftime('%Y-%m-%dT%H:%M:%fZ',bound_at) AND substr(bound_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,execution_idempotency_key), UNIQUE(campaign_id,turn_id,proposal_id),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT);
CREATE INDEX idx_tool_proposal_execution_bindings_turn_v37
      ON tool_proposal_execution_bindings_v37(campaign_id,turn_id,proposal_id);
CREATE TRIGGER tool_proposal_execution_bindings_validate_v37 BEFORE INSERT ON tool_proposal_execution_bindings_v37 WHEN
      EXISTS(SELECT 1 FROM tool_proposal_execution_bindings_v37 old WHERE old.proposal_id=NEW.proposal_id OR
        (old.campaign_id=NEW.campaign_id AND old.execution_idempotency_key=NEW.execution_idempotency_key)) OR
      NEW.turn_id<>NEW.source_turn_id OR NOT EXISTS(SELECT 1 FROM tool_proposals proposal JOIN adventure_turns turn
        ON turn.campaign_id=proposal.campaign_id AND turn.id=proposal.turn_id WHERE proposal.proposal_id=NEW.proposal_id
          AND proposal.campaign_id=NEW.campaign_id AND proposal.turn_id=NEW.turn_id AND turn.timeline_id=NEW.timeline_id
          AND turn.actor_id=NEW.actor_id AND proposal.proposed_at=NEW.bound_at
          AND ((proposal.tool_name IN ('roll','roll-check','roll_actor_dice') AND NEW.command_type='roll_actor_dice')
            OR proposal.tool_name=NEW.command_type))
      BEGIN SELECT RAISE(ABORT,'invalid tool proposal execution binding'); END;
CREATE TRIGGER tool_proposal_execution_bindings_insert_v37 BEFORE INSERT ON tool_proposal_execution_bindings_v37
      WHEN EXISTS(SELECT 1 FROM tool_proposal_execution_bindings_v37 old WHERE old.rowid=NEW.rowid)
      BEGIN SELECT RAISE(ABORT,'tool proposal execution bindings are immutable'); END;
CREATE TRIGGER tool_proposal_execution_bindings_update_v37 BEFORE UPDATE ON tool_proposal_execution_bindings_v37
      BEGIN SELECT RAISE(ABORT,'tool proposal execution bindings are immutable'); END;
CREATE TRIGGER tool_proposal_execution_bindings_delete_v37 BEFORE DELETE ON tool_proposal_execution_bindings_v37
      BEGIN SELECT RAISE(ABORT,'tool proposal execution bindings are immutable'); END;
CREATE TRIGGER turn_mechanics_links_execution_binding_v37 BEFORE INSERT ON turn_mechanics_links_v36 WHEN NOT EXISTS(
      SELECT 1 FROM tool_proposal_execution_bindings_v37 binding JOIN campaign_commands command
        ON command.campaign_id=binding.campaign_id AND command.idempotency_key=binding.execution_idempotency_key
        AND command.type=binding.command_type AND command.timeline_id=binding.timeline_id AND command.actor_id=binding.actor_id
        AND command.source_turn_id=binding.source_turn_id
      WHERE binding.campaign_id=NEW.campaign_id AND binding.turn_id=NEW.turn_id AND binding.proposal_id=NEW.proposal_id
        AND binding.source_turn_id=NEW.source_turn_id AND command.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'mechanics receipt requires exact proposal execution binding'); END;
CREATE TABLE adventure_agent_executions_v38(
       campaign_id TEXT NOT NULL, turn_id TEXT PRIMARY KEY, tool_registry_version TEXT NOT NULL CHECK(tool_registry_version='v1'),
      max_decision_rounds INTEGER NOT NULL CHECK(typeof(max_decision_rounds)='integer' AND max_decision_rounds BETWEEN 1 AND 5),
      max_tool_calls INTEGER NOT NULL CHECK(typeof(max_tool_calls)='integer' AND max_tool_calls BETWEEN 0 AND 12),
      max_mutation_calls INTEGER NOT NULL CHECK(typeof(max_mutation_calls)='integer' AND max_mutation_calls BETWEEN 0 AND 4),
       max_provider_calls INTEGER NOT NULL CHECK(typeof(max_provider_calls)='integer' AND max_provider_calls BETWEEN 1 AND 1000000),
      max_duration_ms INTEGER NOT NULL CHECK(typeof(max_duration_ms)='integer' AND max_duration_ms BETWEEN 1 AND 90000),
       started_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',started_at)=started_at AND substr(started_at,12,2) BETWEEN '00' AND '23'),
       deadline_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',deadline_at)=deadline_at AND substr(deadline_at,12,2) BETWEEN '00' AND '23' AND deadline_at>started_at),
      UNIQUE(campaign_id,turn_id), FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT);
CREATE TABLE agent_execution_operations_v38(
      operation_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, principal_id TEXT NOT NULL,
       operation_type TEXT NOT NULL CHECK(operation_type IN ('provider-start','decision-round','read-outcome')),
      idempotency_key TEXT NOT NULL, expected_campaign_revision INTEGER NOT NULL,
      expected_turn_revision INTEGER NOT NULL, expected_execution_revision INTEGER NOT NULL,
      resulting_execution_revision INTEGER NOT NULL CHECK(resulting_execution_revision=expected_execution_revision+1),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
       request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
       occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,turn_id,idempotency_key), UNIQUE(campaign_id,turn_id,resulting_execution_revision),
      UNIQUE(operation_id,campaign_id,turn_id,resulting_execution_revision),
      UNIQUE(operation_id,campaign_id,turn_id,operation_type,resulting_execution_revision),
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_agent_executions_v38(campaign_id,turn_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT);
CREATE INDEX idx_agent_execution_operations_turn_v38 ON agent_execution_operations_v38(campaign_id,turn_id,resulting_execution_revision);
CREATE TABLE agent_provider_starts_v38(
      operation_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, provider_call_id TEXT NOT NULL,
       provider_phase TEXT NOT NULL CHECK(provider_phase='started'), resulting_execution_revision INTEGER NOT NULL,
       recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at AND substr(recorded_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,turn_id,provider_call_id),
      FOREIGN KEY(operation_id,campaign_id,turn_id,resulting_execution_revision)
        REFERENCES agent_execution_operations_v38(operation_id,campaign_id,turn_id,resulting_execution_revision) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,turn_id,provider_call_id,provider_phase)
        REFERENCES provider_call_metadata(campaign_id,turn_id,call_id,phase) ON DELETE RESTRICT);
CREATE INDEX idx_agent_provider_starts_turn_v38 ON agent_provider_starts_v38(campaign_id,turn_id,recorded_at,provider_call_id);
CREATE TABLE agent_decision_rounds_v38(
      round_id TEXT PRIMARY KEY, seal_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, round_number INTEGER NOT NULL,
      provider_call_id TEXT NOT NULL, tool_registry_version TEXT NOT NULL CHECK(tool_registry_version='v1'),
      provider_request_json TEXT NOT NULL CHECK(json_valid(provider_request_json) AND json_type(provider_request_json)='object'),
      provider_request_digest TEXT NOT NULL CHECK(length(provider_request_digest)=64 AND provider_request_digest NOT GLOB '*[^0-9a-f]*'),
      response_json TEXT NOT NULL CHECK(json_valid(response_json) AND json_type(response_json)='object'),
      response_digest TEXT NOT NULL CHECK(length(response_digest)=64 AND response_digest NOT GLOB '*[^0-9a-f]*'),
       result TEXT NOT NULL CHECK(result IN ('tool-calls','complete','refused')), resulting_execution_revision INTEGER NOT NULL,
       recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at AND substr(recorded_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,turn_id,round_number), UNIQUE(campaign_id,turn_id,provider_call_id),
      UNIQUE(round_id,campaign_id,turn_id), UNIQUE(round_id,campaign_id,turn_id,round_number), UNIQUE(seal_id,round_id),
      FOREIGN KEY(operation_id,campaign_id,turn_id,resulting_execution_revision)
        REFERENCES agent_execution_operations_v38(operation_id,campaign_id,turn_id,resulting_execution_revision) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_starts_v38(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT,
      FOREIGN KEY(seal_id,round_id) REFERENCES agent_decision_batch_seals_v38(seal_id,round_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
CREATE INDEX idx_agent_decision_rounds_turn_v38 ON agent_decision_rounds_v38(campaign_id,turn_id,round_number);
CREATE TABLE agent_tool_calls_v38(
      call_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, round_id TEXT NOT NULL, round_number INTEGER NOT NULL,
      position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 11), provider_tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL CHECK(tool_name IN ('campaign_context.read','actor_resources.read','actor_inventory.read','actor_powers.read',
        'combat_state.read','world_state.read','quest_state.read','actor_attribute.set','actor_resource.initialize','actor_dice.roll')),
      call_kind TEXT NOT NULL CHECK(call_kind IN ('read','mutation')),
      arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json)='object' AND length(arguments_json)<=32768),
       argument_digest TEXT NOT NULL CHECK(length(argument_digest)=64 AND argument_digest NOT GLOB '*[^0-9a-f]*'),
       recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at AND substr(recorded_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,turn_id,provider_tool_call_id), UNIQUE(campaign_id,turn_id,round_number,position),
      UNIQUE(call_id,campaign_id,turn_id), FOREIGN KEY(round_id,campaign_id,turn_id,round_number)
        REFERENCES agent_decision_rounds_v38(round_id,campaign_id,turn_id,round_number) ON DELETE RESTRICT);
CREATE INDEX idx_agent_tool_calls_turn_v38 ON agent_tool_calls_v38(campaign_id,turn_id,round_number,position);
CREATE TABLE agent_decision_batch_seals_v38(
      seal_id TEXT PRIMARY KEY, round_id TEXT NOT NULL UNIQUE, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL,
       call_count INTEGER NOT NULL CHECK(typeof(call_count)='integer' AND call_count BETWEEN 0 AND 12),
       sealed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',sealed_at)=sealed_at AND substr(sealed_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(seal_id,round_id), FOREIGN KEY(round_id,campaign_id,turn_id) REFERENCES agent_decision_rounds_v38(round_id,campaign_id,turn_id) ON DELETE RESTRICT);
CREATE TABLE agent_read_outcomes_v38(
      outcome_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, call_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
      result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json)='object' AND length(result_json)<=262144)),
      result_digest TEXT CHECK(result_digest IS NULL OR (length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*')),
       error_code TEXT, resulting_execution_revision INTEGER NOT NULL,
       recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at AND substr(recorded_at,12,2) BETWEEN '00' AND '23'),
      CHECK((status='succeeded' AND result_json IS NOT NULL AND result_digest IS NOT NULL AND error_code IS NULL) OR
        (status='failed' AND result_json IS NULL AND result_digest IS NULL AND error_code IS NOT NULL)),
      FOREIGN KEY(operation_id,campaign_id,turn_id,resulting_execution_revision)
        REFERENCES agent_execution_operations_v38(operation_id,campaign_id,turn_id,resulting_execution_revision) ON DELETE RESTRICT,
      FOREIGN KEY(call_id,campaign_id,turn_id) REFERENCES agent_tool_calls_v38(call_id,campaign_id,turn_id) ON DELETE RESTRICT);
CREATE TRIGGER adventure_agent_executions_validate_v38 BEFORE INSERT ON adventure_agent_executions_v38 WHEN
      NOT EXISTS(SELECT 1 FROM adventure_turns turn WHERE turn.id=NEW.turn_id AND turn.campaign_id=NEW.campaign_id) OR
      NEW.deadline_at<=NEW.started_at BEGIN SELECT RAISE(ABORT,'invalid durable agent execution'); END;
CREATE TRIGGER provider_call_metadata_agent_limit_v38 BEFORE INSERT ON provider_call_metadata WHEN NEW.phase='started' AND
      (NOT EXISTS(SELECT 1 FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id) OR
       (SELECT count(*) FROM provider_call_metadata old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id
         AND old.phase='started') >= (SELECT max_provider_calls FROM adventure_agent_executions_v38 run
           WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id))
      BEGIN SELECT RAISE(ABORT,'provider call limit exceeded'); END;
CREATE TRIGGER agent_execution_operations_validate_v38 BEFORE INSERT ON agent_execution_operations_v38 WHEN
      NEW.expected_execution_revision<>COALESCE((SELECT max(old.resulting_execution_revision) FROM agent_execution_operations_v38 old
        WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id),0) OR
      NEW.resulting_execution_revision<>NEW.expected_execution_revision+1 OR
      NEW.occurred_at>=(SELECT deadline_at FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id) OR
      NEW.expected_campaign_revision<>(SELECT administration_revision FROM campaigns WHERE id=NEW.campaign_id) OR
      NEW.expected_turn_revision<>(SELECT max(event.resulting_revision) FROM adventure_coordination_events_v36 event
        WHERE event.aggregate_kind='turn' AND event.campaign_id=NEW.campaign_id AND event.aggregate_id=NEW.turn_id) OR
      NOT EXISTS(SELECT 1 FROM adventure_turns turn JOIN campaigns campaign ON campaign.id=turn.campaign_id
        JOIN campaign_memberships membership ON membership.campaign_id=turn.campaign_id AND membership.principal_id=NEW.principal_id
        JOIN campaign_sessions attached ON attached.campaign_id=turn.campaign_id AND attached.session_id=turn.session_id
        JOIN sessions session ON session.id=attached.session_id
        JOIN campaign_actors actor ON actor.campaign_id=turn.campaign_id AND actor.id=turn.actor_id
        JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
        JOIN session_characters participant ON participant.session_id=turn.session_id AND participant.character_id=character.character_id
        WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND campaign.active_timeline_id=turn.timeline_id
          AND campaign.lifecycle_status IN ('draft','published') AND membership.role<>'observer'
          AND session.state='active' AND session.stopped_at IS NULL AND (membership.role IN ('owner','gm') OR EXISTS(
            SELECT 1 FROM campaign_actor_private_state control WHERE control.campaign_id=turn.campaign_id
              AND control.actor_id=turn.actor_id AND control.controller_principal_id=NEW.principal_id))) OR
      EXISTS(SELECT 1 FROM adventure_coordination_events_v36 terminal_turn WHERE terminal_turn.aggregate_kind='turn'
        AND terminal_turn.campaign_id=NEW.campaign_id AND terminal_turn.aggregate_id=NEW.turn_id
        AND terminal_turn.resulting_state IN ('completed','cancelled','failed')) OR
      EXISTS(SELECT 1 FROM agent_decision_rounds_v38 terminal WHERE terminal.campaign_id=NEW.campaign_id AND terminal.turn_id=NEW.turn_id
        AND terminal.result IN ('complete','refused'))
      BEGIN SELECT RAISE(ABORT,'invalid durable agent execution operation'); END;
CREATE TRIGGER agent_tool_calls_validate_v38 BEFORE INSERT ON agent_tool_calls_v38 WHEN
      (SELECT count(*) FROM agent_tool_calls_v38 old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)>=(
        SELECT max_tool_calls FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id) OR
      (NEW.call_kind='mutation' AND (SELECT count(*) FROM agent_tool_calls_v38 old WHERE old.campaign_id=NEW.campaign_id
        AND old.turn_id=NEW.turn_id AND old.call_kind='mutation')>=(SELECT max_mutation_calls FROM adventure_agent_executions_v38 run
          WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id)) OR
      ((NEW.call_kind='mutation')<>(NEW.tool_name IN ('actor_attribute.set','actor_resource.initialize','actor_dice.roll'))) OR
      NOT EXISTS(SELECT 1 FROM agent_decision_rounds_v38 round WHERE round.round_id=NEW.round_id AND round.campaign_id=NEW.campaign_id
        AND round.turn_id=NEW.turn_id AND round.round_number=NEW.round_number AND round.result='tool-calls') OR
      NEW.recorded_at<>(SELECT recorded_at FROM agent_decision_rounds_v38 round WHERE round.round_id=NEW.round_id)
      BEGIN SELECT RAISE(ABORT,'invalid durable agent tool call'); END;
CREATE TRIGGER agent_decision_batch_seals_validate_v38 BEFORE INSERT ON agent_decision_batch_seals_v38 WHEN
      NOT EXISTS(SELECT 1 FROM agent_decision_rounds_v38 round WHERE round.round_id=NEW.round_id AND round.seal_id=NEW.seal_id
        AND round.campaign_id=NEW.campaign_id AND round.turn_id=NEW.turn_id AND round.recorded_at=NEW.sealed_at) OR
      NEW.call_count<>(SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.round_id=NEW.round_id) OR
      (NEW.call_count>0 AND ((SELECT min(position) FROM agent_tool_calls_v38 call WHERE call.round_id=NEW.round_id)<>0 OR
        (SELECT max(position) FROM agent_tool_calls_v38 call WHERE call.round_id=NEW.round_id)<>NEW.call_count-1)) OR
      NOT EXISTS(SELECT 1 FROM agent_decision_rounds_v38 round WHERE round.round_id=NEW.round_id AND
        ((round.result='tool-calls' AND NEW.call_count>0) OR (round.result IN ('complete','refused') AND NEW.call_count=0)) AND
        json_type(round.response_json,'$.calls')='array' AND json_array_length(round.response_json,'$.calls')=NEW.call_count AND
        json_extract(round.response_json,'$.result')=round.result AND
        NOT EXISTS(SELECT 1 FROM json_each(round.response_json) field WHERE field.key NOT IN ('result','calls')) AND
        NOT EXISTS(SELECT 1 FROM agent_tool_calls_v38 call WHERE call.round_id=round.round_id AND NOT EXISTS(
          SELECT 1 FROM json_each(round.response_json,'$.calls') response_call WHERE CAST(response_call.key AS INTEGER)=call.position
            AND json_extract(response_call.value,'$.providerToolCallId')=call.provider_tool_call_id
            AND json_extract(response_call.value,'$.toolName')=call.tool_name AND json_extract(response_call.value,'$.kind')=call.call_kind
            AND json(json_extract(response_call.value,'$.arguments'))=json(call.arguments_json)
            AND NOT EXISTS(SELECT 1 FROM json_each(response_call.value) field WHERE field.key NOT IN ('providerToolCallId','toolName','kind','arguments')))))
      BEGIN SELECT RAISE(ABORT,'invalid durable agent decision batch seal'); END;
CREATE TRIGGER agent_read_outcomes_validate_v38 BEFORE INSERT ON agent_read_outcomes_v38 WHEN
      NOT EXISTS(SELECT 1 FROM agent_execution_operations_v38 operation WHERE operation.operation_id=NEW.operation_id
        AND operation.campaign_id=NEW.campaign_id AND operation.turn_id=NEW.turn_id AND operation.operation_type='read-outcome'
        AND operation.resulting_execution_revision=NEW.resulting_execution_revision AND operation.occurred_at=NEW.recorded_at) OR
      NOT EXISTS(SELECT 1 FROM agent_tool_calls_v38 call WHERE call.call_id=NEW.call_id AND call.campaign_id=NEW.campaign_id
        AND call.turn_id=NEW.turn_id AND call.call_kind='read')
      BEGIN SELECT RAISE(ABORT,'invalid durable agent read outcome'); END;
CREATE TRIGGER adventure_agent_executions_v38_replace_v38 BEFORE INSERT ON adventure_agent_executions_v38 WHEN EXISTS(SELECT 1 FROM adventure_agent_executions_v38 old WHERE old.turn_id=NEW.turn_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id))
        BEGIN SELECT RAISE(ABORT,'adventure_agent_executions_v38 records cannot be replaced'); END;
CREATE TRIGGER adventure_agent_executions_v38_update_v38 BEFORE UPDATE ON adventure_agent_executions_v38 BEGIN SELECT RAISE(ABORT,'adventure_agent_executions_v38 records are immutable'); END;
CREATE TRIGGER adventure_agent_executions_v38_delete_v38 BEFORE DELETE ON adventure_agent_executions_v38 BEGIN SELECT RAISE(ABORT,'adventure_agent_executions_v38 records are immutable'); END;
CREATE TRIGGER agent_execution_operations_v38_replace_v38 BEFORE INSERT ON agent_execution_operations_v38 WHEN EXISTS(SELECT 1 FROM agent_execution_operations_v38 old WHERE old.operation_id=NEW.operation_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.idempotency_key=NEW.idempotency_key OR old.resulting_execution_revision=NEW.resulting_execution_revision)))
        BEGIN SELECT RAISE(ABORT,'agent_execution_operations_v38 records cannot be replaced'); END;
CREATE TRIGGER agent_execution_operations_v38_update_v38 BEFORE UPDATE ON agent_execution_operations_v38 BEGIN SELECT RAISE(ABORT,'agent_execution_operations_v38 records are immutable'); END;
CREATE TRIGGER agent_execution_operations_v38_delete_v38 BEFORE DELETE ON agent_execution_operations_v38 BEGIN SELECT RAISE(ABORT,'agent_execution_operations_v38 records are immutable'); END;
CREATE TRIGGER agent_provider_starts_v38_replace_v38 BEFORE INSERT ON agent_provider_starts_v38 WHEN EXISTS(SELECT 1 FROM agent_provider_starts_v38 old WHERE old.operation_id=NEW.operation_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND old.provider_call_id=NEW.provider_call_id))
        BEGIN SELECT RAISE(ABORT,'agent_provider_starts_v38 records cannot be replaced'); END;
CREATE TRIGGER agent_provider_starts_v38_update_v38 BEFORE UPDATE ON agent_provider_starts_v38 BEGIN SELECT RAISE(ABORT,'agent_provider_starts_v38 records are immutable'); END;
CREATE TRIGGER agent_provider_starts_v38_delete_v38 BEFORE DELETE ON agent_provider_starts_v38 BEGIN SELECT RAISE(ABORT,'agent_provider_starts_v38 records are immutable'); END;
CREATE TRIGGER agent_decision_rounds_v38_replace_v38 BEFORE INSERT ON agent_decision_rounds_v38 WHEN EXISTS(SELECT 1 FROM agent_decision_rounds_v38 old WHERE old.round_id=NEW.round_id OR old.seal_id=NEW.seal_id OR old.operation_id=NEW.operation_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.round_number=NEW.round_number OR old.provider_call_id=NEW.provider_call_id)))
        BEGIN SELECT RAISE(ABORT,'agent_decision_rounds_v38 records cannot be replaced'); END;
CREATE TRIGGER agent_decision_rounds_v38_update_v38 BEFORE UPDATE ON agent_decision_rounds_v38 BEGIN SELECT RAISE(ABORT,'agent_decision_rounds_v38 records are immutable'); END;
CREATE TRIGGER agent_decision_rounds_v38_delete_v38 BEFORE DELETE ON agent_decision_rounds_v38 BEGIN SELECT RAISE(ABORT,'agent_decision_rounds_v38 records are immutable'); END;
CREATE TRIGGER agent_tool_calls_v38_replace_v38 BEFORE INSERT ON agent_tool_calls_v38 WHEN EXISTS(SELECT 1 FROM agent_tool_calls_v38 old WHERE old.call_id=NEW.call_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.provider_tool_call_id=NEW.provider_tool_call_id OR (old.round_number=NEW.round_number AND old.position=NEW.position))))
        BEGIN SELECT RAISE(ABORT,'agent_tool_calls_v38 records cannot be replaced'); END;
CREATE TRIGGER agent_tool_calls_v38_update_v38 BEFORE UPDATE ON agent_tool_calls_v38 BEGIN SELECT RAISE(ABORT,'agent_tool_calls_v38 records are immutable'); END;
CREATE TRIGGER agent_tool_calls_v38_delete_v38 BEFORE DELETE ON agent_tool_calls_v38 BEGIN SELECT RAISE(ABORT,'agent_tool_calls_v38 records are immutable'); END;
CREATE TRIGGER agent_decision_batch_seals_v38_replace_v38 BEFORE INSERT ON agent_decision_batch_seals_v38 WHEN EXISTS(SELECT 1 FROM agent_decision_batch_seals_v38 old WHERE old.seal_id=NEW.seal_id OR old.round_id=NEW.round_id)
        BEGIN SELECT RAISE(ABORT,'agent_decision_batch_seals_v38 records cannot be replaced'); END;
CREATE TRIGGER agent_decision_batch_seals_v38_update_v38 BEFORE UPDATE ON agent_decision_batch_seals_v38 BEGIN SELECT RAISE(ABORT,'agent_decision_batch_seals_v38 records are immutable'); END;
CREATE TRIGGER agent_decision_batch_seals_v38_delete_v38 BEFORE DELETE ON agent_decision_batch_seals_v38 BEGIN SELECT RAISE(ABORT,'agent_decision_batch_seals_v38 records are immutable'); END;
CREATE TRIGGER agent_read_outcomes_v38_replace_v38 BEFORE INSERT ON agent_read_outcomes_v38 WHEN EXISTS(SELECT 1 FROM agent_read_outcomes_v38 old WHERE old.outcome_id=NEW.outcome_id OR old.operation_id=NEW.operation_id OR old.call_id=NEW.call_id)
        BEGIN SELECT RAISE(ABORT,'agent_read_outcomes_v38 records cannot be replaced'); END;
CREATE TRIGGER agent_read_outcomes_v38_update_v38 BEFORE UPDATE ON agent_read_outcomes_v38 BEGIN SELECT RAISE(ABORT,'agent_read_outcomes_v38 records are immutable'); END;
CREATE TRIGGER agent_read_outcomes_v38_delete_v38 BEFORE DELETE ON agent_read_outcomes_v38 BEGIN SELECT RAISE(ABORT,'agent_read_outcomes_v38 records are immutable'); END;
CREATE TABLE agent_provider_contexts_v39(
      context_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,provider_call_id TEXT NOT NULL,
      round_number INTEGER NOT NULL CHECK(round_number BETWEEN 1 AND 5),timeline_id TEXT NOT NULL,timeline_revision INTEGER NOT NULL,
      campaign_revision INTEGER NOT NULL,turn_revision INTEGER NOT NULL,context_json TEXT NOT NULL CHECK(json_valid(context_json)),
      context_digest TEXT NOT NULL CHECK(length(context_digest)=64),request_json TEXT NOT NULL CHECK(json_valid(request_json)),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64),bound_at TEXT NOT NULL,
       UNIQUE(campaign_id,turn_id,round_number),UNIQUE(campaign_id,turn_id,provider_call_id),UNIQUE(context_id,campaign_id,turn_id,provider_call_id),FOREIGN KEY(campaign_id,turn_id,provider_call_id)
        REFERENCES agent_provider_starts_v38(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT);
CREATE TABLE agent_provider_responses_v39(
      response_id TEXT PRIMARY KEY,context_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,
        provider_call_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('succeeded','failed','cancelled')),
      response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),response_digest TEXT,
      prompt_tokens INTEGER,completion_tokens INTEGER,outcome_code TEXT NOT NULL,recorded_at TEXT NOT NULL,
       UNIQUE(campaign_id,turn_id,provider_call_id),CHECK((status='succeeded' AND response_json IS NOT NULL AND length(response_digest)=64) OR
        (status<>'succeeded' AND response_json IS NULL AND response_digest IS NULL)),
       FOREIGN KEY(context_id,campaign_id,turn_id,provider_call_id)
         REFERENCES agent_provider_contexts_v39(context_id,campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_starts_v38(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT);
CREATE TABLE agent_provider_dispatch_claims_v39(
      claim_id TEXT PRIMARY KEY,context_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,
       provider_call_id TEXT NOT NULL,claimed_at TEXT NOT NULL,lease_expires_at TEXT NOT NULL CHECK(lease_expires_at>claimed_at),
        UNIQUE(campaign_id,turn_id,provider_call_id),FOREIGN KEY(context_id,campaign_id,turn_id,provider_call_id)
         REFERENCES agent_provider_contexts_v39(context_id,campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_starts_v38(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT);
CREATE TABLE agent_generalized_receipts_v39(
      link_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,receipt_family TEXT NOT NULL CHECK(receipt_family='combat'),
       proposal_id TEXT,command_id TEXT NOT NULL,encounter_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,revision_before INTEGER NOT NULL,
      revision_after INTEGER NOT NULL CHECK(revision_after=revision_before+1),linked_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,receipt_family,command_id),
       FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT,
       FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT,
      FOREIGN KEY(encounter_id,command_id,revision_after) REFERENCES combat_receipts_v27(encounter_id,command_id,resulting_revision) ON DELETE RESTRICT);
CREATE TABLE agent_combat_proposal_bindings_v39(
      proposal_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,provider_call_id TEXT NOT NULL,
       provider_tool_call_id TEXT NOT NULL,encounter_id TEXT NOT NULL,legal_action_id TEXT NOT NULL,command_legal_action_id TEXT NOT NULL,legal_action_digest TEXT NOT NULL,
      expected_combat_revision INTEGER NOT NULL,execution_idempotency_key TEXT NOT NULL UNIQUE,bound_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,provider_tool_call_id),UNIQUE(campaign_id,turn_id,proposal_id,provider_call_id,provider_tool_call_id),
       FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT,
       FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_responses_v39(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT);
CREATE TRIGGER agent_provider_starts_require_terminal_v39 BEFORE INSERT ON agent_provider_starts_v38 WHEN EXISTS(
      SELECT 1 FROM agent_provider_starts_v38 prior WHERE prior.campaign_id=NEW.campaign_id AND prior.turn_id=NEW.turn_id
         AND EXISTS(SELECT 1 FROM agent_provider_contexts_v39 context WHERE context.campaign_id=prior.campaign_id AND context.turn_id=prior.turn_id AND context.provider_call_id=prior.provider_call_id) AND NOT EXISTS(
        SELECT 1 FROM provider_call_metadata outcome WHERE outcome.campaign_id=prior.campaign_id AND outcome.turn_id=prior.turn_id
          AND outcome.call_id=prior.provider_call_id AND outcome.phase<>'started'))
      BEGIN SELECT RAISE(ABORT,'prior provider start is not terminal'); END;
CREATE TRIGGER agent_decisions_require_inbox_v39 BEFORE INSERT ON agent_decision_rounds_v38 WHEN EXISTS(
      SELECT 1 FROM agent_provider_contexts_v39 context WHERE context.campaign_id=NEW.campaign_id AND context.turn_id=NEW.turn_id
        AND context.provider_call_id=NEW.provider_call_id) AND NOT EXISTS(
      SELECT 1 FROM agent_provider_responses_v39 response JOIN agent_provider_contexts_v39 context
        ON context.context_id=response.context_id AND context.campaign_id=response.campaign_id
          AND context.turn_id=response.turn_id AND context.provider_call_id=response.provider_call_id
      WHERE response.campaign_id=NEW.campaign_id AND response.turn_id=NEW.turn_id AND response.provider_call_id=NEW.provider_call_id
        AND response.status='succeeded' AND response.response_digest=NEW.response_digest
        AND context.request_digest=NEW.provider_request_digest AND NOT EXISTS(
          SELECT 1 FROM json_each(response.response_json,'$.calls') call WHERE json_extract(call.value,'$.toolName')='actor_resource.initialize'
            OR NOT EXISTS(SELECT 1 FROM json_each(context.request_json,'$.advertisedTools') tool
              WHERE tool.value=json_extract(call.value,'$.toolName'))))
      BEGIN SELECT RAISE(ABORT,'decision batch does not match immutable provider inbox'); END;
CREATE TRIGGER agent_provider_response_tools_v39 BEFORE INSERT ON agent_provider_responses_v39 WHEN NEW.status='succeeded' AND EXISTS(
      SELECT 1 FROM json_each(NEW.response_json,'$.calls') call JOIN agent_provider_contexts_v39 context ON context.context_id=NEW.context_id
        AND context.campaign_id=NEW.campaign_id AND context.turn_id=NEW.turn_id AND context.provider_call_id=NEW.provider_call_id
      WHERE json_extract(call.value,'$.toolName')='actor_resource.initialize' OR NOT EXISTS(
        SELECT 1 FROM json_each(context.request_json,'$.advertisedTools') tool WHERE tool.value=json_extract(call.value,'$.toolName')))
      BEGIN SELECT RAISE(ABORT,'provider response contains an unadvertised tool'); END;
CREATE TRIGGER agent_generalized_receipts_validate_v39 BEFORE INSERT ON agent_generalized_receipts_v39 WHEN NOT EXISTS(
      SELECT 1 FROM adventure_turns turn JOIN encounter ON encounter.campaign_id=turn.campaign_id AND encounter.session_id=turn.session_id
      JOIN combat_commands_v27 command ON command.encounter_id=encounter.encounter_id
      JOIN combat_receipts_v27 receipt ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        AND receipt.resulting_revision=command.resulting_revision
      WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND encounter.encounter_id=NEW.encounter_id
        AND command.command_id=NEW.command_id AND command.idempotency_key=NEW.idempotency_key AND command.command_type='resolve_action'
        AND command.expected_revision=NEW.revision_before AND command.resulting_revision=NEW.revision_after
        AND receipt.occurred_at=NEW.linked_at AND (NEW.proposal_id IS NULL OR EXISTS(
          SELECT 1 FROM agent_combat_proposal_bindings_v39 binding WHERE binding.proposal_id=NEW.proposal_id
             AND binding.campaign_id=NEW.campaign_id AND binding.turn_id=NEW.turn_id AND binding.encounter_id=NEW.encounter_id
            AND binding.execution_idempotency_key=NEW.idempotency_key)))
      BEGIN SELECT RAISE(ABORT,'generalized receipt lacks authoritative command-service provenance'); END;
CREATE TRIGGER agent_provider_contexts_v39_replace_v39 BEFORE INSERT ON agent_provider_contexts_v39 WHEN EXISTS(SELECT 1 FROM agent_provider_contexts_v39 OLD WHERE OLD.context_id=NEW.context_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.provider_call_id=NEW.provider_call_id)) BEGIN SELECT RAISE(ABORT,'v39 record cannot be replaced'); END;
CREATE TRIGGER agent_provider_contexts_v39_update_v39 BEFORE UPDATE ON agent_provider_contexts_v39 BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
CREATE TRIGGER agent_provider_contexts_v39_delete_v39 BEFORE DELETE ON agent_provider_contexts_v39 BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
CREATE TRIGGER agent_provider_dispatch_claims_v39_replace_v39 BEFORE INSERT ON agent_provider_dispatch_claims_v39 WHEN EXISTS(SELECT 1 FROM agent_provider_dispatch_claims_v39 OLD WHERE OLD.claim_id=NEW.claim_id OR OLD.context_id=NEW.context_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.provider_call_id=NEW.provider_call_id)) BEGIN SELECT RAISE(ABORT,'v39 record cannot be replaced'); END;
CREATE TRIGGER agent_provider_dispatch_claims_v39_update_v39 BEFORE UPDATE ON agent_provider_dispatch_claims_v39 BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
CREATE TRIGGER agent_provider_dispatch_claims_v39_delete_v39 BEFORE DELETE ON agent_provider_dispatch_claims_v39 BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
CREATE TRIGGER agent_provider_responses_v39_replace_v39 BEFORE INSERT ON agent_provider_responses_v39 WHEN EXISTS(SELECT 1 FROM agent_provider_responses_v39 OLD WHERE OLD.response_id=NEW.response_id OR OLD.context_id=NEW.context_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.provider_call_id=NEW.provider_call_id)) BEGIN SELECT RAISE(ABORT,'v39 record cannot be replaced'); END;
CREATE TRIGGER agent_provider_responses_v39_update_v39 BEFORE UPDATE ON agent_provider_responses_v39 BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
CREATE TRIGGER agent_provider_responses_v39_delete_v39 BEFORE DELETE ON agent_provider_responses_v39 BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
CREATE TRIGGER agent_combat_proposal_bindings_v39_replace_v39 BEFORE INSERT ON agent_combat_proposal_bindings_v39 WHEN EXISTS(SELECT 1 FROM agent_combat_proposal_bindings_v39 OLD WHERE OLD.proposal_id=NEW.proposal_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.provider_tool_call_id=NEW.provider_tool_call_id)) BEGIN SELECT RAISE(ABORT,'v39 record cannot be replaced'); END;
CREATE TRIGGER agent_combat_proposal_bindings_v39_update_v39 BEFORE UPDATE ON agent_combat_proposal_bindings_v39 BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
CREATE TRIGGER agent_combat_proposal_bindings_v39_delete_v39 BEFORE DELETE ON agent_combat_proposal_bindings_v39 BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
CREATE TRIGGER agent_generalized_receipts_v39_replace_v39 BEFORE INSERT ON agent_generalized_receipts_v39 WHEN EXISTS(SELECT 1 FROM agent_generalized_receipts_v39 OLD WHERE OLD.link_id=NEW.link_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.command_id=NEW.command_id)) BEGIN SELECT RAISE(ABORT,'v39 record cannot be replaced'); END;
CREATE TRIGGER agent_generalized_receipts_v39_update_v39 BEFORE UPDATE ON agent_generalized_receipts_v39 BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
CREATE TRIGGER agent_generalized_receipts_v39_delete_v39 BEFORE DELETE ON agent_generalized_receipts_v39 BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
CREATE TRIGGER agent_provider_starts_validate_v38 BEFORE INSERT ON agent_provider_starts_v38 WHEN
      NOT EXISTS(SELECT 1 FROM agent_execution_operations_v38 operation WHERE operation.operation_id=NEW.operation_id
        AND operation.campaign_id=NEW.campaign_id AND operation.turn_id=NEW.turn_id AND operation.operation_type='provider-start'
        AND operation.resulting_execution_revision=NEW.resulting_execution_revision AND operation.occurred_at=NEW.recorded_at
        AND json_extract(operation.request_json,'$.providerCallId')=NEW.provider_call_id) OR
      NOT EXISTS(SELECT 1 FROM provider_call_metadata provider WHERE provider.campaign_id=NEW.campaign_id AND provider.turn_id=NEW.turn_id
        AND provider.call_id=NEW.provider_call_id AND provider.phase='started' AND provider.recorded_at=NEW.recorded_at) OR
      (SELECT count(*) FROM agent_provider_starts_v38 old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)<>
        (SELECT count(*) FROM agent_decision_rounds_v38 round WHERE round.campaign_id=NEW.campaign_id AND round.turn_id=NEW.turn_id) OR
      (SELECT count(*) FROM agent_decision_rounds_v38 round WHERE round.campaign_id=NEW.campaign_id AND round.turn_id=NEW.turn_id)>=(
        SELECT max_decision_rounds FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id) OR
      EXISTS(SELECT 1 FROM agent_tool_calls_v38 call WHERE call.campaign_id=NEW.campaign_id AND call.turn_id=NEW.turn_id AND
        ((call.call_kind='mutation' AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan
          WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id)) OR
         (call.call_kind='read' AND NOT EXISTS(SELECT 1 FROM agent_read_outcomes_v38 outcome WHERE outcome.call_id=call.call_id))))
      BEGIN SELECT RAISE(ABORT,'invalid durable agent provider start'); END;
CREATE TRIGGER agent_decision_rounds_validate_v38 BEFORE INSERT ON agent_decision_rounds_v38 WHEN
      NOT EXISTS(SELECT 1 FROM agent_execution_operations_v38 operation WHERE operation.operation_id=NEW.operation_id
        AND operation.campaign_id=NEW.campaign_id AND operation.turn_id=NEW.turn_id AND operation.operation_type='decision-round'
        AND operation.resulting_execution_revision=NEW.resulting_execution_revision AND operation.occurred_at=NEW.recorded_at
        AND EXISTS(SELECT 1 FROM agent_provider_starts_v38 start WHERE start.campaign_id=NEW.campaign_id
          AND start.turn_id=NEW.turn_id AND start.provider_call_id=NEW.provider_call_id
          AND start.resulting_execution_revision=operation.expected_execution_revision)) OR
      NEW.round_number<>(SELECT count(*)+1 FROM agent_decision_rounds_v38 old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id) OR
      NEW.round_number>(SELECT max_decision_rounds FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id) OR
      EXISTS(SELECT 1 FROM agent_decision_rounds_v38 prior WHERE prior.campaign_id=NEW.campaign_id AND prior.turn_id=NEW.turn_id
        AND (prior.result IN ('complete','refused') OR EXISTS(SELECT 1 FROM agent_tool_calls_v38 call WHERE call.round_id=prior.round_id AND
           ((call.call_kind='read' AND NOT EXISTS(SELECT 1 FROM agent_read_outcomes_v38 outcome WHERE outcome.call_id=call.call_id)) OR
            (call.call_kind='mutation' AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan
              WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id))))))
      BEGIN SELECT RAISE(ABORT,'invalid durable agent decision round'); END;
CREATE TRIGGER tool_proposals_guard_insert_v35 BEFORE INSERT ON tool_proposals WHEN EXISTS(SELECT 1 FROM tool_proposals old WHERE old.proposal_id=NEW.proposal_id OR
      (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.position=NEW.position OR old.idempotency_key=NEW.idempotency_key))) OR
      NOT EXISTS(SELECT 1 FROM adventure_turns turn WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND
        (turn.state IN ('declared','proposed') OR (turn.state='mechanics-committed' AND EXISTS(
          SELECT 1 FROM adventure_coordination_events_v36 event WHERE event.campaign_id=turn.campaign_id AND event.aggregate_kind='turn'
            AND event.aggregate_id=turn.id AND event.resulting_revision=turn.revision AND event.resulting_state='declared') AND EXISTS(
          SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.campaign_id=turn.campaign_id AND replan.turn_id=turn.id)))) OR
      (NEW.requires_confirmation=1 AND NEW.confirmation_expires_at<=NEW.proposed_at) OR
      (SELECT count(*) FROM tool_proposals old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)>=32
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate tool proposal'); END;
CREATE TABLE confirmation_policy_attestations_v40(
      proposal_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,
       policy_version TEXT NOT NULL CHECK(policy_version IN('v1','legacy-v40-backfill-v1')),category TEXT NOT NULL CHECK(category IN(
        'currency-transfer','purchase','important-item-loss','important-item-consume','important-item-gift',
        'ambiguous-limited-resource-use','rest-timing','companion-change','combat-start','combat-action-consequential',
        'generated-world-change','generated-quest-change','generated-story-change','gm-override','deterministic-roll','ambiguous-consequential-change')),
      requires_confirmation INTEGER NOT NULL CHECK(requires_confirmation IN(0,1)),
      required_authorizer TEXT NOT NULL CHECK(required_authorizer IN('controller','gm')),
      safe_summary_json TEXT NOT NULL CHECK(json_valid(safe_summary_json) AND json_type(safe_summary_json)='object'),
      proposed_command_digest TEXT NOT NULL CHECK(length(proposed_command_digest)=64 AND proposed_command_digest NOT GLOB '*[^0-9a-f]*'),
      observed_domain_revisions_json TEXT NOT NULL CHECK(json_valid(observed_domain_revisions_json) AND json_type(observed_domain_revisions_json)='array'),
      attested_at TEXT NOT NULL,UNIQUE(campaign_id,turn_id,proposal_id),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT);
CREATE TABLE agent_mutation_accounting_v40(
      accounting_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,proposal_id TEXT NOT NULL UNIQUE,
      provider_call_id TEXT NOT NULL,provider_tool_call_id TEXT NOT NULL,round_number INTEGER NOT NULL CHECK(round_number BETWEEN 1 AND 5),
      tool_name TEXT NOT NULL CHECK(tool_name='combat_action.execute'),argument_digest TEXT NOT NULL CHECK(length(argument_digest)=64),recorded_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,provider_tool_call_id),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT,
        FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_responses_v39(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT,
        FOREIGN KEY(campaign_id,turn_id,proposal_id,provider_call_id,provider_tool_call_id)
          REFERENCES agent_combat_proposal_bindings_v39(campaign_id,turn_id,proposal_id,provider_call_id,provider_tool_call_id) ON DELETE RESTRICT);
CREATE TABLE agent_replan_requirements_v40(
      requirement_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,proposal_id TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL CHECK(reason IN('policy-stale','command-stale','campaign-stale','timeline-stale','combat-stale','authority-stale')),
      validation_json TEXT NOT NULL CHECK(json_valid(validation_json) AND json_type(validation_json)='object'),required_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,proposal_id),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT);
CREATE TABLE confirmation_expiration_operations_v40(
      operation_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,expected_turn_revision INTEGER NOT NULL,resulting_turn_revision INTEGER NOT NULL,
      proposal_ids_json TEXT NOT NULL CHECK(json_valid(proposal_ids_json) AND json_type(proposal_ids_json)='array'),expired_at TEXT NOT NULL,
       UNIQUE(campaign_id,turn_id,idempotency_key),UNIQUE(campaign_id,turn_id,resulting_turn_revision),
       FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT);
CREATE TABLE confirmation_authority_evidence_v40(
      evidence_id TEXT PRIMARY KEY,decision_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,proposal_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN('approved','rejected','expired')),
      evidence_version TEXT NOT NULL CHECK(evidence_version IN('v1','legacy-v40-backfill-v1')),
      authority_role TEXT CHECK(authority_role IS NULL OR authority_role IN('owner','gm','player','observer')),
      authority_control TEXT CHECK(authority_control IS NULL OR authority_control IN('all','controlled','none')),
      actor_id TEXT,required_authorizer TEXT NOT NULL CHECK(required_authorizer IN('controller','gm')),
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object'),
      evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),attested_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,proposal_id),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT);
CREATE TRIGGER confirmation_policy_required_v40 BEFORE INSERT ON confirmation_decisions WHEN NOT EXISTS(
      SELECT 1 FROM confirmation_policy_attestations_v40 policy WHERE policy.proposal_id=NEW.proposal_id
        AND policy.campaign_id=NEW.campaign_id AND policy.turn_id=NEW.turn_id AND policy.requires_confirmation=1)
      BEGIN SELECT RAISE(ABORT,'confirmation decision lacks server policy'); END;
CREATE TRIGGER confirmation_authorizer_required_v40 BEFORE INSERT ON confirmation_decisions WHEN NOT EXISTS(
        SELECT 1 FROM confirmation_authority_evidence_v40 evidence
        JOIN confirmation_policy_attestations_v40 policy ON policy.campaign_id=evidence.campaign_id
          AND policy.turn_id=evidence.turn_id AND policy.proposal_id=evidence.proposal_id
        WHERE evidence.decision_id=NEW.decision_id AND evidence.campaign_id=NEW.campaign_id AND evidence.turn_id=NEW.turn_id
          AND evidence.proposal_id=NEW.proposal_id AND evidence.principal_id=NEW.principal_id AND evidence.decision=NEW.decision
          AND evidence.attested_at=NEW.decided_at AND evidence.required_authorizer=policy.required_authorizer)
      BEGIN SELECT RAISE(ABORT,'confirmation decision lacks required authorizer'); END;
CREATE TRIGGER agent_mutation_limit_v40 BEFORE INSERT ON agent_mutation_accounting_v40 WHEN
      (SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.campaign_id=NEW.campaign_id AND call.turn_id=NEW.turn_id AND call.call_kind='mutation'
        AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id))+
      (SELECT count(*) FROM agent_mutation_accounting_v40 old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id
        AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.proposal_id=old.proposal_id))>=
      (SELECT max_mutation_calls FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id)
      BEGIN SELECT RAISE(ABORT,'agent mutation limit exceeded'); END;
CREATE TRIGGER agent_total_tool_limit_v40 BEFORE INSERT ON agent_mutation_accounting_v40 WHEN
      (SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.campaign_id=NEW.campaign_id AND call.turn_id=NEW.turn_id
        AND NOT(call.call_kind='mutation' AND EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id)))+
      (SELECT count(*) FROM agent_mutation_accounting_v40 old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id
        AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.proposal_id=old.proposal_id))>=
      (SELECT max_tool_calls FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id)
      BEGIN SELECT RAISE(ABORT,'agent tool limit exceeded'); END;
CREATE TRIGGER agent_mutation_response_crossbind_v40 BEFORE INSERT ON agent_mutation_accounting_v40 WHEN NOT EXISTS(
       SELECT 1 FROM agent_provider_responses_v39 response JOIN agent_provider_contexts_v39 context
         ON context.context_id=response.context_id AND context.campaign_id=response.campaign_id
           AND context.turn_id=response.turn_id AND context.provider_call_id=response.provider_call_id
       JOIN agent_combat_proposal_bindings_v39 binding ON binding.campaign_id=NEW.campaign_id AND binding.turn_id=NEW.turn_id
         AND binding.proposal_id=NEW.proposal_id AND binding.provider_call_id=NEW.provider_call_id
         AND binding.provider_tool_call_id=NEW.provider_tool_call_id
      JOIN tool_proposals proposal ON proposal.campaign_id=NEW.campaign_id AND proposal.turn_id=NEW.turn_id AND proposal.proposal_id=NEW.proposal_id
      WHERE response.campaign_id=NEW.campaign_id AND response.turn_id=NEW.turn_id AND response.provider_call_id=NEW.provider_call_id
        AND response.status='succeeded' AND context.round_number=NEW.round_number
        AND json_extract(response.response_json,'$.result')='tool-calls'
        AND EXISTS(SELECT 1 FROM json_each(response.response_json,'$.calls') call
          WHERE json_extract(call.value,'$.providerToolCallId')=NEW.provider_tool_call_id
            AND json_extract(call.value,'$.toolName')=NEW.tool_name))
      BEGIN SELECT RAISE(ABORT,'agent mutation is not bound to its provider response'); END;
CREATE TRIGGER combat_binding_response_crossbind_v40 BEFORE INSERT ON agent_combat_proposal_bindings_v39 WHEN NOT EXISTS(
      SELECT 1 FROM agent_provider_responses_v39 response WHERE response.campaign_id=NEW.campaign_id AND response.turn_id=NEW.turn_id
        AND response.provider_call_id=NEW.provider_call_id AND response.status='succeeded'
        AND EXISTS(SELECT 1 FROM json_each(response.response_json,'$.calls') call
          WHERE json_extract(call.value,'$.providerToolCallId')=NEW.provider_tool_call_id
            AND json_extract(call.value,'$.toolName')='combat_action.execute'
            AND json_extract(call.value,'$.arguments.legalActionId')=NEW.legal_action_id
            AND json_extract(call.value,'$.arguments.legalActionDigest')=NEW.legal_action_digest))
      BEGIN SELECT RAISE(ABORT,'combat proposal is not bound to its provider response'); END;
CREATE TRIGGER provider_response_context_crossbind_v40 BEFORE INSERT ON agent_provider_responses_v39 WHEN NOT EXISTS(
      SELECT 1 FROM agent_provider_contexts_v39 context WHERE context.context_id=NEW.context_id AND context.campaign_id=NEW.campaign_id
        AND context.turn_id=NEW.turn_id AND context.provider_call_id=NEW.provider_call_id)
      BEGIN SELECT RAISE(ABORT,'provider response context is cross-wired'); END;
CREATE TRIGGER provider_claim_context_crossbind_v40 BEFORE INSERT ON agent_provider_dispatch_claims_v39 WHEN NOT EXISTS(
      SELECT 1 FROM agent_provider_contexts_v39 context WHERE context.context_id=NEW.context_id AND context.campaign_id=NEW.campaign_id
        AND context.turn_id=NEW.turn_id AND context.provider_call_id=NEW.provider_call_id)
      BEGIN SELECT RAISE(ABORT,'provider claim context is cross-wired'); END;
CREATE TRIGGER confirmation_policy_attestations_v40_replace_v40 BEFORE INSERT ON confirmation_policy_attestations_v40 WHEN EXISTS(SELECT 1 FROM confirmation_policy_attestations_v40 OLD WHERE OLD.proposal_id=NEW.proposal_id) BEGIN SELECT RAISE(ABORT,'v40 record cannot be replaced'); END;
CREATE TRIGGER confirmation_policy_attestations_v40_update_v40 BEFORE UPDATE ON confirmation_policy_attestations_v40 BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
CREATE TRIGGER confirmation_policy_attestations_v40_delete_v40 BEFORE DELETE ON confirmation_policy_attestations_v40 BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
CREATE TRIGGER agent_mutation_accounting_v40_replace_v40 BEFORE INSERT ON agent_mutation_accounting_v40 WHEN EXISTS(SELECT 1 FROM agent_mutation_accounting_v40 OLD WHERE OLD.accounting_id=NEW.accounting_id OR OLD.proposal_id=NEW.proposal_id OR OLD.provider_tool_call_id=NEW.provider_tool_call_id) BEGIN SELECT RAISE(ABORT,'v40 record cannot be replaced'); END;
CREATE TRIGGER agent_mutation_accounting_v40_update_v40 BEFORE UPDATE ON agent_mutation_accounting_v40 BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
CREATE TRIGGER agent_mutation_accounting_v40_delete_v40 BEFORE DELETE ON agent_mutation_accounting_v40 BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
CREATE TRIGGER agent_replan_requirements_v40_replace_v40 BEFORE INSERT ON agent_replan_requirements_v40 WHEN EXISTS(SELECT 1 FROM agent_replan_requirements_v40 OLD WHERE OLD.requirement_id=NEW.requirement_id OR OLD.proposal_id=NEW.proposal_id) BEGIN SELECT RAISE(ABORT,'v40 record cannot be replaced'); END;
CREATE TRIGGER agent_replan_requirements_v40_update_v40 BEFORE UPDATE ON agent_replan_requirements_v40 BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
CREATE TRIGGER agent_replan_requirements_v40_delete_v40 BEFORE DELETE ON agent_replan_requirements_v40 BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
CREATE TRIGGER confirmation_authority_evidence_v40_replace_v40 BEFORE INSERT ON confirmation_authority_evidence_v40 WHEN EXISTS(SELECT 1 FROM confirmation_authority_evidence_v40 OLD WHERE OLD.evidence_id=NEW.evidence_id OR OLD.decision_id=NEW.decision_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.proposal_id=NEW.proposal_id)) BEGIN SELECT RAISE(ABORT,'v40 record cannot be replaced'); END;
CREATE TRIGGER confirmation_authority_evidence_v40_update_v40 BEFORE UPDATE ON confirmation_authority_evidence_v40 BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
CREATE TRIGGER confirmation_authority_evidence_v40_delete_v40 BEFORE DELETE ON confirmation_authority_evidence_v40 BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
CREATE TRIGGER confirmation_expiration_operations_v40_replace_v40 BEFORE INSERT ON confirmation_expiration_operations_v40 WHEN EXISTS(SELECT 1 FROM confirmation_expiration_operations_v40 OLD WHERE OLD.operation_id=NEW.operation_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND (OLD.idempotency_key=NEW.idempotency_key OR OLD.resulting_turn_revision=NEW.resulting_turn_revision))) BEGIN SELECT RAISE(ABORT,'v40 record cannot be replaced'); END;
CREATE TRIGGER confirmation_expiration_operations_v40_update_v40 BEFORE UPDATE ON confirmation_expiration_operations_v40 BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
CREATE TRIGGER confirmation_expiration_operations_v40_delete_v40 BEFORE DELETE ON confirmation_expiration_operations_v40 BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
CREATE TABLE campaign_opening_narratives_v41 (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
      opening_text TEXT NOT NULL CHECK(length(opening_text) BETWEEN 1 AND 4000),
      campaign_premise TEXT NOT NULL CHECK(length(campaign_premise) BETWEEN 1 AND 4000),
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    );
CREATE TABLE campaign_npc_baseline_stats_v41 (
      campaign_id TEXT NOT NULL, npc_id TEXT NOT NULL, body INTEGER NOT NULL CHECK(body BETWEEN 1 AND 20),
      mind INTEGER NOT NULL CHECK(mind BETWEEN 1 AND 20), presence INTEGER NOT NULL CHECK(presence BETWEEN 1 AND 20),
      source TEXT NOT NULL CHECK(source='generated-deterministic-baseline'),
      PRIMARY KEY(campaign_id,npc_id), FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT
    );
CREATE TABLE generated_campaign_quests_v41 (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT, quest_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 4000),
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      PRIMARY KEY(campaign_id,quest_id)
    );
CREATE TABLE campaign_content_commands_v42 (
      command_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT, principal_digest TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, expected_campaign_revision INTEGER NOT NULL, applied_at TEXT NOT NULL,
      UNIQUE(campaign_id, draft_id), UNIQUE(campaign_id, idempotency_key)
    );
CREATE TABLE campaign_content_receipts_v42 (
      receipt_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE REFERENCES campaign_content_commands_v42(command_id) ON DELETE RESTRICT,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT, draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      applied_at TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object')
    );
CREATE TABLE campaign_content_revisions_v42 (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT, revision INTEGER NOT NULL,
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT, applied_at TEXT NOT NULL
    );
CREATE TRIGGER campaign_content_commands_v42_immutable_update_v42 BEFORE UPDATE ON campaign_content_commands_v42 BEGIN SELECT RAISE(ABORT,'v42 records are immutable'); END;
CREATE TRIGGER campaign_content_commands_v42_immutable_delete_v42 BEFORE DELETE ON campaign_content_commands_v42 BEGIN SELECT RAISE(ABORT,'v42 records are immutable'); END;
CREATE TRIGGER campaign_content_receipts_v42_immutable_update_v42 BEFORE UPDATE ON campaign_content_receipts_v42 BEGIN SELECT RAISE(ABORT,'v42 records are immutable'); END;
CREATE TRIGGER campaign_content_receipts_v42_immutable_delete_v42 BEFORE DELETE ON campaign_content_receipts_v42 BEGIN SELECT RAISE(ABORT,'v42 records are immutable'); END;
CREATE TRIGGER campaign_content_revisions_v42_immutable_update_v42 BEFORE UPDATE ON campaign_content_revisions_v42 BEGIN SELECT RAISE(ABORT,'v42 records are immutable'); END;
CREATE TRIGGER campaign_content_revisions_v42_immutable_delete_v42 BEFORE DELETE ON campaign_content_revisions_v42 BEGIN SELECT RAISE(ABORT,'v42 records are immutable'); END;
CREATE TABLE npc_presence_session_revisions_v43 (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL
        AND updated_at=strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,session_id)
    );
CREATE TABLE npc_presence_commands_v43 (
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      npc_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('present','left')),
      location_id TEXT,
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
        AND created_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at) AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,session_id,command_id),
      UNIQUE(campaign_id,session_id,idempotency_key),
      UNIQUE(campaign_id,session_id,resulting_revision),
      UNIQUE(campaign_id,session_id,command_id,resulting_revision,npc_id,state,location_id),
      FOREIGN KEY(campaign_id,session_id) REFERENCES npc_presence_session_revisions_v43(campaign_id,session_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT
    );
CREATE TABLE npc_presence_events_v43 (
      event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL,
      npc_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('present','left')),
      location_id TEXT,
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL
        AND occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,session_id,command_id),
      UNIQUE(campaign_id,session_id,resulting_revision),
      UNIQUE(campaign_id,session_id,command_id,resulting_revision,event_id,npc_id,state,location_id),
      FOREIGN KEY(campaign_id,session_id,command_id,resulting_revision,npc_id,state,location_id)
        REFERENCES npc_presence_commands_v43(campaign_id,session_id,command_id,resulting_revision,npc_id,state,location_id) ON DELETE RESTRICT
    );
CREATE TABLE npc_presence_receipts_v43 (
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('present','left')),
      location_id TEXT,
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL
        AND occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,session_id,command_id),
      UNIQUE(campaign_id,session_id,resulting_revision),
      FOREIGN KEY(campaign_id,session_id,command_id,resulting_revision,event_id,npc_id,state,location_id)
        REFERENCES npc_presence_events_v43(campaign_id,session_id,command_id,resulting_revision,event_id,npc_id,state,location_id) ON DELETE RESTRICT
    );
CREATE TABLE campaign_npc_presence_v43 (
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('present','left')),
      location_id TEXT,
      state_revision INTEGER NOT NULL CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 1 AND 9007199254740991),
      state_entered_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',state_entered_at) IS NOT NULL
        AND state_entered_at=strftime('%Y-%m-%dT%H:%M:%fZ',state_entered_at) AND substr(state_entered_at,12,2) BETWEEN '00' AND '23'),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL
        AND updated_at=strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      last_command_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,session_id,npc_id),
      FOREIGN KEY(campaign_id,session_id,last_command_id,state_revision,npc_id,state,location_id)
        REFERENCES npc_presence_commands_v43(campaign_id,session_id,command_id,resulting_revision,npc_id,state,location_id) ON DELETE RESTRICT
    );
CREATE TRIGGER npc_presence_session_revisions_v43_attached_insert_v43
      BEFORE INSERT ON npc_presence_session_revisions_v43
      WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions attached
        WHERE attached.campaign_id=NEW.campaign_id AND attached.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT,'NPC presence session root requires campaign attachment'); END;
CREATE TRIGGER npc_presence_session_revisions_v43_revision_update_v43
      BEFORE UPDATE ON npc_presence_session_revisions_v43
      WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.session_id<>OLD.session_id
        OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
      BEGIN SELECT RAISE(ABORT,'NPC presence session revision must advance exactly once'); END;
CREATE TRIGGER npc_presence_events_v43_exact_command_insert_v43
      BEFORE INSERT ON npc_presence_events_v43
      WHEN NOT EXISTS(SELECT 1 FROM npc_presence_commands_v43 command
        WHERE command.campaign_id=NEW.campaign_id AND command.session_id=NEW.session_id
          AND command.command_id=NEW.command_id AND command.resulting_revision=NEW.resulting_revision
          AND command.npc_id=NEW.npc_id AND command.state=NEW.state AND command.location_id IS NEW.location_id)
      BEGIN SELECT RAISE(ABORT,'NPC presence event must exactly match its command'); END;
CREATE TRIGGER npc_presence_receipts_v43_exact_event_insert_v43
      BEFORE INSERT ON npc_presence_receipts_v43
      WHEN NOT EXISTS(SELECT 1 FROM npc_presence_events_v43 event
        WHERE event.campaign_id=NEW.campaign_id AND event.session_id=NEW.session_id
           AND event.command_id=NEW.command_id AND event.resulting_revision=NEW.resulting_revision
           AND event.event_id=NEW.event_id AND event.npc_id=NEW.npc_id
           AND event.state=NEW.state AND event.location_id IS NEW.location_id
           AND event.occurred_at=NEW.occurred_at)
      BEGIN SELECT RAISE(ABORT,'NPC presence receipt must exactly match its event'); END;
CREATE TRIGGER campaign_npc_presence_v43_exact_command_insert_v43
      BEFORE INSERT ON campaign_npc_presence_v43
      WHEN NOT EXISTS(SELECT 1 FROM npc_presence_commands_v43 command
        WHERE command.campaign_id=NEW.campaign_id AND command.session_id=NEW.session_id
          AND command.command_id=NEW.last_command_id AND command.resulting_revision=NEW.state_revision
          AND command.npc_id=NEW.npc_id AND command.state=NEW.state AND command.location_id IS NEW.location_id)
      BEGIN SELECT RAISE(ABORT,'current NPC presence must exactly match its last command'); END;
CREATE TRIGGER campaign_npc_presence_v43_exact_command_update_v43
      BEFORE UPDATE ON campaign_npc_presence_v43
      WHEN NOT EXISTS(SELECT 1 FROM npc_presence_commands_v43 command
        WHERE command.campaign_id=NEW.campaign_id AND command.session_id=NEW.session_id
          AND command.command_id=NEW.last_command_id AND command.resulting_revision=NEW.state_revision
          AND command.npc_id=NEW.npc_id AND command.state=NEW.state AND command.location_id IS NEW.location_id)
      BEGIN SELECT RAISE(ABORT,'current NPC presence must exactly match its last command'); END;
CREATE TRIGGER npc_presence_commands_v43_immutable_update_v43 BEFORE UPDATE ON npc_presence_commands_v43
      BEGIN SELECT RAISE(ABORT,'v43 NPC-presence records are immutable'); END;
CREATE TRIGGER npc_presence_commands_v43_immutable_delete_v43 BEFORE DELETE ON npc_presence_commands_v43
      BEGIN SELECT RAISE(ABORT,'v43 NPC-presence records are immutable'); END;
CREATE TRIGGER npc_presence_events_v43_immutable_update_v43 BEFORE UPDATE ON npc_presence_events_v43
      BEGIN SELECT RAISE(ABORT,'v43 NPC-presence records are immutable'); END;
CREATE TRIGGER npc_presence_events_v43_immutable_delete_v43 BEFORE DELETE ON npc_presence_events_v43
      BEGIN SELECT RAISE(ABORT,'v43 NPC-presence records are immutable'); END;
CREATE TRIGGER npc_presence_receipts_v43_immutable_update_v43 BEFORE UPDATE ON npc_presence_receipts_v43
      BEGIN SELECT RAISE(ABORT,'v43 NPC-presence records are immutable'); END;
CREATE TRIGGER npc_presence_receipts_v43_immutable_delete_v43 BEFORE DELETE ON npc_presence_receipts_v43
      BEGIN SELECT RAISE(ABORT,'v43 NPC-presence records are immutable'); END;
CREATE TABLE companion_commands_v45 (
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      principal_id TEXT NOT NULL,
      command_kind TEXT NOT NULL CHECK(command_kind IN ('companion-create','grant-create','grant-revoke')),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision=expected_revision+1),
      payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 32768 AND json_valid(payload_json) AND json_type(payload_json)='object'),
      payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
        AND created_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at) AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,npc_id,command_id),
      UNIQUE(campaign_id,npc_id,idempotency_key),
      UNIQUE(campaign_id,npc_id,resulting_revision),
      UNIQUE(campaign_id,npc_id,command_id,resulting_revision,command_kind,payload_digest),
      UNIQUE(campaign_id,npc_id,command_id,resulting_revision,command_kind,principal_id,payload_digest),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(principal_id) REFERENCES principals(id) ON DELETE RESTRICT
    );
CREATE TABLE companion_receipts_v45 (
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) BETWEEN 1 AND 128 AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL,
      command_payload_digest TEXT NOT NULL,
      outcome_json TEXT NOT NULL CHECK(length(outcome_json) BETWEEN 2 AND 262144 AND json_valid(outcome_json) AND json_type(outcome_json)='object'),
      outcome_digest TEXT NOT NULL CHECK(length(outcome_digest)=64 AND outcome_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL
        AND occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,npc_id,command_id),
      UNIQUE(campaign_id,npc_id,resulting_revision),
      UNIQUE(receipt_id,campaign_id,npc_id,command_id,resulting_revision),
      UNIQUE(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest),
      FOREIGN KEY(campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest)
        REFERENCES companion_commands_v45(campaign_id,npc_id,command_id,resulting_revision,command_kind,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,idempotency_key) REFERENCES companion_commands_v45(campaign_id,npc_id,idempotency_key) ON DELETE RESTRICT
    );
CREATE TABLE campaign_companions_v45 (
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      initial_session_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','dismissed')),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
        AND created_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at) AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL
        AND updated_at=strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) AND substr(updated_at,12,2) BETWEEN '00' AND '23' AND updated_at>=created_at),
      create_command_id TEXT NOT NULL,
      create_receipt_id TEXT NOT NULL,
      create_revision INTEGER NOT NULL CHECK(create_revision=1),
      create_command_kind TEXT NOT NULL CHECK(create_command_kind='companion-create'),
      create_payload_digest TEXT NOT NULL,
      last_command_id TEXT NOT NULL,
      last_receipt_id TEXT NOT NULL,
      last_command_kind TEXT NOT NULL,
      last_payload_digest TEXT NOT NULL,
      PRIMARY KEY(campaign_id,npc_id),
      UNIQUE(campaign_id,initial_session_id,npc_id),
      FOREIGN KEY(campaign_id,initial_session_id,npc_id) REFERENCES campaign_npc_presence_v43(campaign_id,session_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,create_command_id,create_revision,create_command_kind,create_payload_digest)
        REFERENCES companion_commands_v45(campaign_id,npc_id,command_id,resulting_revision,command_kind,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(create_receipt_id,campaign_id,npc_id,create_command_id,create_revision,create_command_kind,create_payload_digest)
        REFERENCES companion_receipts_v45(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,last_command_id,revision,last_command_kind,last_payload_digest)
        REFERENCES companion_commands_v45(campaign_id,npc_id,command_id,resulting_revision,command_kind,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(last_receipt_id,campaign_id,npc_id,last_command_id,revision,last_command_kind,last_payload_digest)
        REFERENCES companion_receipts_v45(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT
    );
CREATE TABLE companion_presence_links_v45 (
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      create_command_id TEXT NOT NULL,
      create_receipt_id TEXT NOT NULL,
      create_revision INTEGER NOT NULL CHECK(create_revision=1),
      create_command_kind TEXT NOT NULL CHECK(create_command_kind='companion-create'),
      create_payload_digest TEXT NOT NULL,
      linked_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',linked_at) IS NOT NULL
        AND linked_at=strftime('%Y-%m-%dT%H:%M:%fZ',linked_at) AND substr(linked_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,session_id,npc_id),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_companions_v45(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,session_id,npc_id) REFERENCES campaign_npc_presence_v43(campaign_id,session_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,create_command_id,create_revision,create_command_kind,create_payload_digest)
        REFERENCES companion_commands_v45(campaign_id,npc_id,command_id,resulting_revision,command_kind,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(create_receipt_id,campaign_id,npc_id,create_command_id,create_revision,create_command_kind,create_payload_digest)
        REFERENCES companion_receipts_v45(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT
    );
CREATE TABLE companion_proposals_v45 (
      proposal_id TEXT PRIMARY KEY CHECK(length(proposal_id) BETWEEN 1 AND 128 AND proposal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      proposer_kind TEXT NOT NULL CHECK(proposer_kind IN ('campaign-principal','companion','provider','system')),
      proposer_principal_id TEXT,
      proposer_npc_id TEXT,
      provider_call_id TEXT,
      system_source TEXT,
      command_family TEXT NOT NULL CHECK(command_family IN ('travel','rest','power-use','inventory-consume','inventory-transfer','purchase','currency-transfer','combat-action','world-change','quest-change','story-change')),
      actor_scope_kind TEXT NOT NULL CHECK(actor_scope_kind IN ('none','campaign-actor')),
      actor_id TEXT,
      resource_scope_kind TEXT NOT NULL CHECK(resource_scope_kind IN ('none','actor-resources','wallet','inventory','powers')),
      exact_command_json TEXT NOT NULL CHECK(length(exact_command_json) BETWEEN 2 AND 32768 AND json_valid(exact_command_json) AND json_type(exact_command_json)='object'),
      command_digest TEXT NOT NULL CHECK(length(command_digest)=64 AND command_digest NOT GLOB '*[^0-9a-f]*'),
      policy_json TEXT NOT NULL CHECK(length(policy_json) BETWEEN 2 AND 32768 AND json_valid(policy_json) AND json_type(policy_json)='object'),
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
      confirmation_state TEXT NOT NULL CHECK(confirmation_state IN ('not-required','pending','approved','rejected','expired','cancelled')),
      proposed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',proposed_at) IS NOT NULL
        AND proposed_at=strftime('%Y-%m-%dT%H:%M:%fZ',proposed_at) AND substr(proposed_at,12,2) BETWEEN '00' AND '23'),
      CHECK((actor_scope_kind='none' AND actor_id IS NULL) OR (actor_scope_kind='campaign-actor' AND actor_id IS NOT NULL)),
      CHECK((proposer_kind='campaign-principal' AND proposer_principal_id IS NOT NULL AND proposer_npc_id IS NULL AND provider_call_id IS NULL AND system_source IS NULL)
        OR (proposer_kind='companion' AND proposer_principal_id IS NULL AND proposer_npc_id IS NOT NULL AND provider_call_id IS NULL AND system_source IS NULL)
        OR (proposer_kind='provider' AND proposer_principal_id IS NULL AND proposer_npc_id IS NULL AND provider_call_id IS NOT NULL AND system_source IS NULL)
        OR (proposer_kind='system' AND proposer_principal_id IS NULL AND proposer_npc_id IS NULL AND provider_call_id IS NULL AND system_source IS NOT NULL)),
      UNIQUE(proposal_id,campaign_id,npc_id),
      UNIQUE(proposal_id,campaign_id,npc_id,command_family,command_digest,policy_digest),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_companions_v45(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,session_id,npc_id) REFERENCES companion_presence_links_v45(campaign_id,session_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(proposer_principal_id) REFERENCES principals(id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,proposer_npc_id) REFERENCES campaign_companions_v45(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT
    );
CREATE TABLE companion_decisions_v45 (
      decision_id TEXT PRIMARY KEY CHECK(length(decision_id) BETWEEN 1 AND 128 AND decision_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      proposal_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      decided_by_principal_id TEXT NOT NULL,
      confirmation_state TEXT NOT NULL CHECK(confirmation_state IN ('approved','rejected','expired','cancelled')),
      reviewed_command_family TEXT NOT NULL,
      reviewed_command_digest TEXT NOT NULL,
      reviewed_policy_digest TEXT NOT NULL,
      decided_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',decided_at) IS NOT NULL
        AND decided_at=strftime('%Y-%m-%dT%H:%M:%fZ',decided_at) AND substr(decided_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(decision_id,campaign_id,npc_id,proposal_id,reviewed_command_family,confirmation_state),
      FOREIGN KEY(proposal_id,campaign_id,npc_id,reviewed_command_family,reviewed_command_digest,reviewed_policy_digest)
        REFERENCES companion_proposals_v45(proposal_id,campaign_id,npc_id,command_family,command_digest,policy_digest) ON DELETE RESTRICT,
      FOREIGN KEY(decided_by_principal_id) REFERENCES principals(id) ON DELETE RESTRICT
    );
CREATE TABLE companion_decision_receipts_v45 (
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) BETWEEN 1 AND 128 AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      decision_id TEXT NOT NULL UNIQUE,
      proposal_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      command_family TEXT NOT NULL,
      confirmation_state TEXT NOT NULL CHECK(confirmation_state='approved'),
      authoritative_command_id TEXT NOT NULL CHECK(length(authoritative_command_id) BETWEEN 1 AND 128 AND authoritative_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 262144 AND json_valid(payload_json) AND json_type(payload_json)='object'),
      payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL
        AND occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY(decision_id,campaign_id,npc_id,proposal_id,command_family,confirmation_state)
        REFERENCES companion_decisions_v45(decision_id,campaign_id,npc_id,proposal_id,reviewed_command_family,confirmation_state) ON DELETE RESTRICT
    );
CREATE TABLE companion_grants_v45 (
      grant_id TEXT PRIMARY KEY CHECK(length(grant_id) BETWEEN 1 AND 128 AND grant_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      granted_by_principal_id TEXT NOT NULL,
      grantee_principal_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      resource_scope_kind TEXT NOT NULL CHECK(resource_scope_kind IN ('none','actor-resources','wallet','inventory','powers')),
      confirmation_policy TEXT NOT NULL CHECK(confirmation_policy IN ('always','domain-policy')),
      primary_command_family TEXT NOT NULL CHECK(primary_command_family IN ('travel','rest','power-use','inventory-consume','inventory-transfer','purchase','currency-transfer','combat-action','world-change','quest-change','story-change')),
      max_spend INTEGER CHECK(max_spend IS NULL OR (typeof(max_spend)='integer' AND max_spend BETWEEN 0 AND 9007199254740991)),
      max_uses INTEGER CHECK(max_uses IS NULL OR (typeof(max_uses)='integer' AND max_uses BETWEEN 1 AND 9007199254740991)),
      starts_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',starts_at) IS NOT NULL
        AND starts_at=strftime('%Y-%m-%dT%H:%M:%fZ',starts_at) AND substr(starts_at,12,2) BETWEEN '00' AND '23'),
      expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL
        AND expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) AND substr(expires_at,12,2) BETWEEN '00' AND '23' AND expires_at>starts_at),
      created_command_id TEXT NOT NULL,
      created_receipt_id TEXT NOT NULL,
      created_revision INTEGER NOT NULL,
      created_command_kind TEXT NOT NULL CHECK(created_command_kind='grant-create'),
      created_payload_digest TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
        AND created_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at) AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      CHECK(granted_by_principal_id<>grantee_principal_id),
      UNIQUE(grant_id,campaign_id,npc_id),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_companions_v45(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(granted_by_principal_id) REFERENCES principals(id) ON DELETE RESTRICT,
      FOREIGN KEY(grantee_principal_id) REFERENCES principals(id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,created_command_id,created_revision,created_command_kind,granted_by_principal_id,created_payload_digest)
        REFERENCES companion_commands_v45(campaign_id,npc_id,command_id,resulting_revision,command_kind,principal_id,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(created_receipt_id,campaign_id,npc_id,created_command_id,created_revision,created_command_kind,created_payload_digest)
        REFERENCES companion_receipts_v45(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(grant_id,campaign_id,npc_id,primary_command_family)
        REFERENCES companion_grant_command_families_v45(grant_id,campaign_id,npc_id,command_family) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE companion_grant_command_families_v45 (
      grant_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      command_family TEXT NOT NULL CHECK(command_family IN ('travel','rest','power-use','inventory-consume','inventory-transfer','purchase','currency-transfer','combat-action','world-change','quest-change','story-change')),
      PRIMARY KEY(grant_id,command_family),
      UNIQUE(grant_id,campaign_id,npc_id,command_family),
      FOREIGN KEY(grant_id,campaign_id,npc_id) REFERENCES companion_grants_v45(grant_id,campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TABLE companion_grant_revocations_v45 (
      grant_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      revoked_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS NOT NULL
        AND revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) AND substr(revoked_at,12,2) BETWEEN '00' AND '23'),
      revocation_reason TEXT NOT NULL CHECK(length(trim(revocation_reason)) BETWEEN 1 AND 500),
      revoked_by_principal_id TEXT NOT NULL,
      revoked_command_id TEXT NOT NULL,
      revoked_receipt_id TEXT NOT NULL,
      revoked_revision INTEGER NOT NULL,
      revoked_command_kind TEXT NOT NULL CHECK(revoked_command_kind='grant-revoke'),
      revoked_payload_digest TEXT NOT NULL,
      FOREIGN KEY(grant_id,campaign_id,npc_id) REFERENCES companion_grants_v45(grant_id,campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(revoked_by_principal_id) REFERENCES principals(id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,npc_id,revoked_command_id,revoked_revision,revoked_command_kind,revoked_by_principal_id,revoked_payload_digest)
        REFERENCES companion_commands_v45(campaign_id,npc_id,command_id,resulting_revision,command_kind,principal_id,payload_digest) ON DELETE RESTRICT,
      FOREIGN KEY(revoked_receipt_id,campaign_id,npc_id,revoked_command_id,revoked_revision,revoked_command_kind,revoked_payload_digest)
        REFERENCES companion_receipts_v45(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT
    );
CREATE TABLE companion_audit_events_v45 (
      audit_id TEXT PRIMARY KEY CHECK(length(audit_id) BETWEEN 1 AND 128 AND audit_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL,
      npc_id TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK(event_kind IN ('companion-created','grant-created','grant-revoked')),
      command_id TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL,
      receipt_id TEXT NOT NULL,
      command_kind TEXT NOT NULL CHECK(command_kind IN ('companion-create','grant-create','grant-revoke')),
      command_payload_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 262144 AND json_valid(payload_json) AND json_type(payload_json)='object'),
      payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL
        AND occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,npc_id,resulting_revision),
      CHECK((event_kind='companion-created' AND command_kind='companion-create')
        OR (event_kind='grant-created' AND command_kind='grant-create')
        OR (event_kind='grant-revoked' AND command_kind='grant-revoke')),
      FOREIGN KEY(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest)
        REFERENCES companion_receipts_v45(receipt_id,campaign_id,npc_id,command_id,resulting_revision,command_kind,command_payload_digest) ON DELETE RESTRICT
    );
CREATE INDEX idx_companion_commands_principal_v45 ON companion_commands_v45(campaign_id,principal_id,created_at);
CREATE INDEX idx_companion_receipts_revision_v45 ON companion_receipts_v45(campaign_id,npc_id,resulting_revision);
CREATE INDEX idx_companion_presence_session_v45 ON companion_presence_links_v45(campaign_id,session_id);
CREATE INDEX idx_companion_proposals_companion_v45 ON companion_proposals_v45(campaign_id,npc_id,proposed_at);
CREATE INDEX idx_companion_decisions_companion_v45 ON companion_decisions_v45(campaign_id,npc_id,decided_at);
CREATE INDEX idx_companion_grants_grantee_v45 ON companion_grants_v45(campaign_id,grantee_principal_id,expires_at);
CREATE INDEX idx_companion_grants_actor_v45 ON companion_grants_v45(campaign_id,actor_id,expires_at);
CREATE INDEX idx_companion_audit_companion_v45 ON companion_audit_events_v45(campaign_id,npc_id,occurred_at);
CREATE TRIGGER campaign_companions_v45_structural_update_v45
    BEFORE UPDATE ON campaign_companions_v45
    WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.npc_id<>OLD.npc_id
      OR NEW.initial_session_id<>OLD.initial_session_id OR NEW.created_at<>OLD.created_at
      OR NEW.create_command_id<>OLD.create_command_id OR NEW.create_receipt_id<>OLD.create_receipt_id
      OR NEW.create_revision<>OLD.create_revision OR NEW.create_command_kind<>OLD.create_command_kind
      OR NEW.create_payload_digest<>OLD.create_payload_digest
      OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
    BEGIN SELECT RAISE(ABORT,'v45 companion projection must preserve creation anchors and advance exactly once'); END;
CREATE TRIGGER companion_commands_v45_immutable_update_v45 BEFORE UPDATE ON companion_commands_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_commands_v45_immutable_delete_v45 BEFORE DELETE ON companion_commands_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_receipts_v45_immutable_update_v45 BEFORE UPDATE ON companion_receipts_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_receipts_v45_immutable_delete_v45 BEFORE DELETE ON companion_receipts_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_presence_links_v45_immutable_update_v45 BEFORE UPDATE ON companion_presence_links_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_presence_links_v45_immutable_delete_v45 BEFORE DELETE ON companion_presence_links_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_proposals_v45_immutable_update_v45 BEFORE UPDATE ON companion_proposals_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_proposals_v45_immutable_delete_v45 BEFORE DELETE ON companion_proposals_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_decisions_v45_immutable_update_v45 BEFORE UPDATE ON companion_decisions_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_decisions_v45_immutable_delete_v45 BEFORE DELETE ON companion_decisions_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_decision_receipts_v45_immutable_update_v45 BEFORE UPDATE ON companion_decision_receipts_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_decision_receipts_v45_immutable_delete_v45 BEFORE DELETE ON companion_decision_receipts_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_grants_v45_immutable_update_v45 BEFORE UPDATE ON companion_grants_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_grants_v45_immutable_delete_v45 BEFORE DELETE ON companion_grants_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_grant_command_families_v45_immutable_update_v45 BEFORE UPDATE ON companion_grant_command_families_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_grant_command_families_v45_immutable_delete_v45 BEFORE DELETE ON companion_grant_command_families_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_grant_revocations_v45_immutable_update_v45 BEFORE UPDATE ON companion_grant_revocations_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_grant_revocations_v45_immutable_delete_v45 BEFORE DELETE ON companion_grant_revocations_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_audit_events_v45_immutable_update_v45 BEFORE UPDATE ON companion_audit_events_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TRIGGER companion_audit_events_v45_immutable_delete_v45 BEFORE DELETE ON companion_audit_events_v45
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
CREATE TABLE exact_candidate_batches_v46(
 batch_id TEXT PRIMARY KEY CHECK(length(batch_id) BETWEEN 1 AND 128 AND batch_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT NOT NULL,actor_id TEXT NOT NULL,principal_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
 connection_id TEXT NOT NULL,candidate_count INTEGER NOT NULL CHECK(typeof(candidate_count)='integer' AND candidate_count BETWEEN 0 AND 32),
 world_revision INTEGER NOT NULL CHECK(typeof(world_revision)='integer' AND world_revision BETWEEN 0 AND 9007199254740990),
 issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(turn_id,principal_id,idempotency_key),
 UNIQUE(batch_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,world_revision,issued_at,expires_at),
 FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(principal_id) REFERENCES principals(id) ON DELETE RESTRICT,
 CHECK(connection_id='adventure-turn:'||turn_id),
 CHECK(issued_at=strftime('%Y-%m-%dT%H:%M:%fZ',issued_at) AND expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)
  AND substr(issued_at,12,2) BETWEEN '00' AND '23' AND substr(expires_at,12,2) BETWEEN '00' AND '23'
  AND expires_at>issued_at AND (julianday(expires_at)-julianday(issued_at))*86400000<=300001)
);
CREATE TABLE exact_candidates_v46(
 candidate_id TEXT PRIMARY KEY CHECK(length(candidate_id) BETWEEN 1 AND 128 AND candidate_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 batch_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 1 AND 32),
 campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT NOT NULL,actor_id TEXT NOT NULL,principal_id TEXT NOT NULL,connection_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind='actor.travel'),version TEXT NOT NULL CHECK(version='v1'),world_revision INTEGER NOT NULL,
 issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,
 policy_result TEXT NOT NULL CHECK(policy_result='allowed'),policy_reason TEXT NOT NULL CHECK(policy_reason='legal-visible-connection'),
 confirmation_requirement TEXT NOT NULL CHECK(confirmation_requirement='not-required'),quote_kind TEXT NOT NULL CHECK(quote_kind='not-applicable'),
 supersession_state TEXT NOT NULL CHECK(supersession_state='current'),execution_state TEXT NOT NULL CHECK(execution_state='unexecuted'),
 action_frame TEXT NOT NULL,action_digest TEXT NOT NULL CHECK(length(action_digest)=64 AND action_digest NOT GLOB '*[^0-9a-f]*'),
 envelope_frame TEXT NOT NULL,envelope_digest TEXT NOT NULL CHECK(length(envelope_digest)=64 AND envelope_digest NOT GLOB '*[^0-9a-f]*'),
 envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json) AND json_type(envelope_json)='object'),
 UNIQUE(batch_id,position),
 UNIQUE(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version),
 UNIQUE(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version,expires_at),
 UNIQUE(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version,issued_at,expires_at),
 FOREIGN KEY(batch_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,world_revision,issued_at,expires_at)
  REFERENCES exact_candidate_batches_v46(batch_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,world_revision,issued_at,expires_at) ON DELETE RESTRICT
);
CREATE TABLE exact_candidate_supersessions_v46(
 source_candidate_id TEXT PRIMARY KEY,replacement_candidate_id TEXT NOT NULL UNIQUE,
 campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT NOT NULL,actor_id TEXT NOT NULL,principal_id TEXT NOT NULL,connection_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind='actor.travel'),version TEXT NOT NULL CHECK(version='v1'),superseded_at TEXT NOT NULL,
 FOREIGN KEY(source_candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version)
  REFERENCES exact_candidates_v46(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version) ON DELETE RESTRICT,
 FOREIGN KEY(replacement_candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version)
  REFERENCES exact_candidates_v46(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version) ON DELETE RESTRICT,
 CHECK(source_candidate_id<>replacement_candidate_id),
 CHECK(superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ',superseded_at) AND substr(superseded_at,12,2) BETWEEN '00' AND '23')
);
CREATE TABLE exact_candidate_expirations_v46(
 expiration_id TEXT PRIMARY KEY CHECK(length(expiration_id) BETWEEN 1 AND 128 AND expiration_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 candidate_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT NOT NULL,actor_id TEXT NOT NULL,
 principal_id TEXT NOT NULL,connection_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='actor.travel'),version TEXT NOT NULL CHECK(version='v1'),
 expires_at TEXT NOT NULL,observed_at TEXT NOT NULL,
 FOREIGN KEY(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version,expires_at)
  REFERENCES exact_candidates_v46(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version,expires_at) ON DELETE RESTRICT,
 CHECK(observed_at=strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) AND substr(observed_at,12,2) BETWEEN '00' AND '23' AND observed_at>=expires_at)
);
CREATE INDEX idx_exact_candidates_scope_v46 ON exact_candidates_v46(campaign_id,turn_id,actor_id,principal_id,connection_id,kind,version);
CREATE INDEX idx_exact_candidates_batch_v46 ON exact_candidates_v46(batch_id,position);
CREATE TRIGGER exact_candidate_batches_v46_immutable_update_v46 BEFORE UPDATE ON exact_candidate_batches_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_batches_v46_immutable_delete_v46 BEFORE DELETE ON exact_candidate_batches_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidates_v46_immutable_update_v46 BEFORE UPDATE ON exact_candidates_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidates_v46_immutable_delete_v46 BEFORE DELETE ON exact_candidates_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_supersessions_v46_immutable_update_v46 BEFORE UPDATE ON exact_candidate_supersessions_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_supersessions_v46_immutable_delete_v46 BEFORE DELETE ON exact_candidate_supersessions_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_expirations_v46_immutable_update_v46 BEFORE UPDATE ON exact_candidate_expirations_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TRIGGER exact_candidate_expirations_v46_immutable_delete_v46 BEFORE DELETE ON exact_candidate_expirations_v46 BEGIN SELECT RAISE(ABORT,'v46 exact candidate history is immutable');END;
CREATE TABLE exact_candidate_executions_v47(
 execution_id TEXT PRIMARY KEY CHECK(length(execution_id) BETWEEN 1 AND 128 AND execution_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 candidate_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT NOT NULL,actor_id TEXT NOT NULL,
 principal_id TEXT NOT NULL,connection_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='actor.travel'),version TEXT NOT NULL CHECK(version='v1'),
 action_frame TEXT NOT NULL,action_digest TEXT NOT NULL CHECK(length(action_digest)=64 AND action_digest NOT GLOB '*[^0-9a-f]*'),
 scope_frame TEXT NOT NULL,scope_digest TEXT NOT NULL CHECK(length(scope_digest)=64 AND scope_digest NOT GLOB '*[^0-9a-f]*'),
 selection_candidate_id TEXT NOT NULL,selection_kind TEXT NOT NULL CHECK(selection_kind='actor.travel'),selection_version TEXT NOT NULL CHECK(selection_version='v1'),
 selection_frame TEXT NOT NULL,selection_digest TEXT NOT NULL CHECK(length(selection_digest)=64 AND selection_digest NOT GLOB '*[^0-9a-f]*'),
 world_idempotency_key TEXT NOT NULL UNIQUE CHECK(world_idempotency_key='exact-candidate:'||action_digest),
 world_command_id TEXT NOT NULL,world_actor_id TEXT NOT NULL,world_command_type TEXT NOT NULL CHECK(world_command_type='travel'),
 world_expected_revision INTEGER NOT NULL CHECK(typeof(world_expected_revision)='integer' AND world_expected_revision BETWEEN 0 AND 9007199254740990),
 world_revision INTEGER NOT NULL CHECK(world_revision=world_expected_revision+1),world_created_at TEXT NOT NULL,
 world_request_json TEXT NOT NULL CHECK(json_valid(world_request_json) AND json_type(world_request_json)='object'),
 world_request_digest TEXT NOT NULL CHECK(length(world_request_digest)=64 AND world_request_digest NOT GLOB '*[^0-9a-f]*'),
 world_result_json TEXT NOT NULL CHECK(json_valid(world_result_json) AND json_type(world_result_json)='object'),
 world_result_digest TEXT NOT NULL CHECK(length(world_result_digest)=64 AND world_result_digest NOT GLOB '*[^0-9a-f]*'),
 travel_id TEXT NOT NULL,destination_location_id TEXT NOT NULL,
 party_actor_ids_json TEXT NOT NULL CHECK(json_valid(party_actor_ids_json) AND json_type(party_actor_ids_json)='array' AND json_array_length(party_actor_ids_json)=1),
 linked_envelope_frame TEXT NOT NULL,linked_envelope_digest TEXT NOT NULL CHECK(length(linked_envelope_digest)=64 AND linked_envelope_digest NOT GLOB '*[^0-9a-f]*'),
 linked_envelope_json TEXT NOT NULL CHECK(json_valid(linked_envelope_json) AND json_type(linked_envelope_json)='object'),
 result_frame TEXT NOT NULL,result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),linked_at TEXT NOT NULL,
 UNIQUE(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version),
 FOREIGN KEY(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version)
  REFERENCES exact_candidates_v46(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version) ON DELETE RESTRICT,
 FOREIGN KEY(campaign_id,session_id,world_command_id,world_revision)
  REFERENCES world_commands_v28(campaign_id,session_id,command_id,resulting_revision) ON DELETE RESTRICT,
 FOREIGN KEY(campaign_id,session_id,world_command_id,world_revision)
  REFERENCES world_receipts_v28(campaign_id,session_id,command_id,resulting_revision) ON DELETE RESTRICT,
 CHECK(linked_at=strftime('%Y-%m-%dT%H:%M:%fZ',linked_at) AND substr(linked_at,12,2) BETWEEN '00' AND '23')
);
CREATE INDEX idx_exact_candidate_executions_world_v47 ON exact_candidate_executions_v47(campaign_id,session_id,world_command_id,world_revision);
CREATE TRIGGER exact_candidate_executions_structure_v47 BEFORE INSERT ON exact_candidate_executions_v47 WHEN
 NEW.execution_id IS NOT json_extract(NEW.result_json,'$.executionId')
 OR NEW.selection_candidate_id IS NOT json_extract(NEW.result_json,'$.selection.candidateId')
 OR NEW.selection_kind IS NOT json_extract(NEW.result_json,'$.selection.kind') OR NEW.selection_version IS NOT json_extract(NEW.result_json,'$.selection.version')
 OR NEW.selection_digest IS NOT json_extract(NEW.result_json,'$.canonicalSelectionDigest') OR NEW.result_digest IS NOT json_extract(NEW.result_json,'$.canonicalResultDigest')
 OR NEW.candidate_id IS NOT NEW.selection_candidate_id OR NEW.kind IS NOT NEW.selection_kind OR NEW.version IS NOT NEW.selection_version
 OR NEW.candidate_id IS NOT json_extract(NEW.linked_envelope_json,'$.candidateId') OR NEW.kind IS NOT json_extract(NEW.linked_envelope_json,'$.kind')
 OR NEW.version IS NOT json_extract(NEW.linked_envelope_json,'$.version') OR NEW.campaign_id IS NOT json_extract(NEW.linked_envelope_json,'$.scope.campaignId')
 OR NEW.session_id IS NOT json_extract(NEW.linked_envelope_json,'$.scope.sessionId') OR NEW.actor_id IS NOT json_extract(NEW.linked_envelope_json,'$.scope.actorId')
 OR NEW.principal_id IS NOT json_extract(NEW.linked_envelope_json,'$.scope.principalId') OR NEW.connection_id IS NOT json_extract(NEW.linked_envelope_json,'$.scope.connectionId')
 OR json_extract(NEW.linked_envelope_json,'$.execution.state') IS NOT 'receipt-linked'
 OR NEW.execution_id IS NOT json_extract(NEW.linked_envelope_json,'$.execution.receiptId')
 OR NEW.world_command_id IS NOT json_extract(NEW.linked_envelope_json,'$.execution.binding.commandId')
 OR NEW.action_digest IS NOT json_extract(NEW.linked_envelope_json,'$.canonicalActionDigest')
 OR NEW.linked_envelope_digest IS NOT json_extract(NEW.linked_envelope_json,'$.canonicalEnvelopeDigest')
 OR NEW.linked_at IS NOT json_extract(NEW.linked_envelope_json,'$.execution.linkedAt')
 OR NEW.campaign_id IS NOT json_extract(NEW.result_json,'$.actorTravelResult.campaignId') OR NEW.session_id IS NOT json_extract(NEW.result_json,'$.actorTravelResult.sessionId')
 OR NEW.world_command_id IS NOT json_extract(NEW.result_json,'$.actorTravelResult.receipt.commandId')
 OR NEW.world_idempotency_key IS NOT json_extract(NEW.result_json,'$.actorTravelResult.receipt.idempotencyKey')
 OR NEW.world_expected_revision IS NOT json_extract(NEW.result_json,'$.actorTravelResult.receipt.revisionBefore')
 OR NEW.world_revision IS NOT json_extract(NEW.result_json,'$.actorTravelResult.receipt.revisionAfter')
 OR NEW.linked_at IS NOT json_extract(NEW.result_json,'$.actorTravelResult.receipt.occurredAt')
 OR NEW.world_actor_id IS NOT NEW.actor_id OR NEW.world_created_at IS NOT NEW.linked_at
 OR NEW.travel_id IS NOT json_extract(NEW.world_request_json,'$.travelId')
 OR NEW.destination_location_id IS NOT json_extract(NEW.world_result_json,'$.locations[0].locationId')
 OR json_extract(NEW.party_actor_ids_json,'$[0]') IS NOT NEW.actor_id
 OR json_extract(NEW.world_request_json,'$.selectedPartyActorIds[0]') IS NOT NEW.actor_id
 OR json_array_length(json_extract(NEW.world_request_json,'$.selectedPartyActorIds')) IS NOT 1
 OR json_extract(NEW.world_request_json,'$.campaignId') IS NOT NEW.campaign_id
 OR json_extract(NEW.world_request_json,'$.locationConnectionId') IS NOT json_extract(NEW.linked_envelope_json,'$.privateParameters.connectionId')
 OR json_extract(NEW.world_request_json,'$.expectedRevision') IS NOT NEW.world_expected_revision
 OR json_extract(NEW.world_request_json,'$.idempotencyKey') IS NOT NEW.world_idempotency_key
 OR NOT EXISTS(SELECT 1 FROM exact_candidates_v46 candidate WHERE candidate.candidate_id=NEW.candidate_id
   AND candidate.campaign_id=NEW.campaign_id AND candidate.turn_id=NEW.turn_id AND candidate.session_id=NEW.session_id
   AND candidate.actor_id=NEW.actor_id AND candidate.principal_id=NEW.principal_id AND candidate.connection_id=NEW.connection_id
   AND candidate.kind=NEW.kind AND candidate.version=NEW.version AND candidate.action_frame=NEW.action_frame AND candidate.action_digest=NEW.action_digest)
 OR NOT EXISTS(SELECT 1 FROM world_commands_v28 command WHERE command.campaign_id=NEW.campaign_id AND command.session_id=NEW.session_id
   AND command.command_id=NEW.world_command_id AND command.actor_id=NEW.world_actor_id AND command.command_type=NEW.world_command_type
   AND command.idempotency_key=NEW.world_idempotency_key AND command.expected_revision=NEW.world_expected_revision
   AND command.resulting_revision=NEW.world_revision AND command.created_at=NEW.world_created_at
   AND command.canonical_request_json=NEW.world_request_json AND command.request_digest=NEW.world_request_digest)
 OR NOT EXISTS(SELECT 1 FROM world_receipts_v28 receipt WHERE receipt.campaign_id=NEW.campaign_id AND receipt.session_id=NEW.session_id
   AND receipt.command_id=NEW.world_command_id AND receipt.resulting_revision=NEW.world_revision AND receipt.occurred_at=NEW.linked_at
   AND receipt.canonical_result_json=NEW.world_result_json AND receipt.result_digest=NEW.world_result_digest)
 OR NOT EXISTS(SELECT 1 FROM world_events_v28 event WHERE event.campaign_id=NEW.campaign_id AND event.session_id=NEW.session_id
   AND event.command_id=NEW.world_command_id AND event.resulting_revision=NEW.world_revision AND event.event_type='travelled'
   AND event.occurred_at=NEW.linked_at AND json_extract(event.event_json,'$.travelId')=NEW.travel_id
   AND json_extract(event.event_json,'$.destinationLocationId')=NEW.destination_location_id AND json_type(event.event_json)='object')
 OR NOT EXISTS(SELECT 1 FROM world_travel_destinations_v28 destination WHERE destination.campaign_id=NEW.campaign_id
   AND destination.session_id=NEW.session_id AND destination.command_id=NEW.world_command_id
   AND destination.connection_id=json_extract(NEW.linked_envelope_json,'$.privateParameters.connectionId')
   AND destination.destination_location_id=NEW.destination_location_id)
 OR (SELECT count(*) FROM world_travel_party_members_v28 party WHERE party.campaign_id=NEW.campaign_id
   AND party.session_id=NEW.session_id AND party.command_id=NEW.world_command_id)<>1
 OR NOT EXISTS(SELECT 1 FROM world_travel_party_members_v28 party WHERE party.campaign_id=NEW.campaign_id
   AND party.session_id=NEW.session_id AND party.command_id=NEW.world_command_id AND party.actor_id=json_extract(NEW.party_actor_ids_json,'$[0]'))
 BEGIN SELECT RAISE(ABORT,'v47 exact candidate execution binding is invalid');END;
CREATE TRIGGER exact_candidate_executions_v47_immutable_update_v47 BEFORE UPDATE ON exact_candidate_executions_v47 BEGIN SELECT RAISE(ABORT,'v47 exact candidate execution history is immutable');END;
CREATE TRIGGER exact_candidate_executions_v47_immutable_delete_v47 BEFORE DELETE ON exact_candidate_executions_v47 BEGIN SELECT RAISE(ABORT,'v47 exact candidate execution history is immutable');END;
CREATE TABLE exact_candidate_provider_bindings_v48(
 binding_id TEXT PRIMARY KEY CHECK(length(binding_id) BETWEEN 1 AND 128 AND binding_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,batch_id TEXT NOT NULL,candidate_id TEXT NOT NULL UNIQUE,execution_id TEXT NOT NULL UNIQUE,
 provider_call_id TEXT NOT NULL,provider_tool_call_id TEXT NOT NULL,round_number INTEGER NOT NULL CHECK(round_number BETWEEN 1 AND 5),
 tool_name TEXT NOT NULL CHECK(tool_name='exact_actor_travel.select'),tool_position INTEGER NOT NULL CHECK(tool_position=0),
 provider_projection_json TEXT NOT NULL CHECK(json_valid(provider_projection_json) AND json_type(provider_projection_json)='object'),
 provider_projection_digest TEXT NOT NULL CHECK(length(provider_projection_digest)=64 AND provider_projection_digest NOT GLOB '*[^0-9a-f]*'),
 selection_json TEXT NOT NULL CHECK(json_valid(selection_json) AND json_type(selection_json)='object'),
 selection_digest TEXT NOT NULL CHECK(length(selection_digest)=64 AND selection_digest NOT GLOB '*[^0-9a-f]*'),
  world_command_id TEXT NOT NULL,expected_execution_revision INTEGER NOT NULL CHECK(expected_execution_revision BETWEEN 0 AND 9007199254740990),
  resulting_execution_revision INTEGER NOT NULL CHECK(resulting_execution_revision=expected_execution_revision+1),linked_at TEXT NOT NULL,
 UNIQUE(campaign_id,turn_id,provider_call_id),UNIQUE(campaign_id,turn_id,provider_tool_call_id),
 FOREIGN KEY(batch_id) REFERENCES exact_candidate_batches_v46(batch_id) ON DELETE RESTRICT,
 FOREIGN KEY(candidate_id) REFERENCES exact_candidates_v46(candidate_id) ON DELETE RESTRICT,
 FOREIGN KEY(execution_id) REFERENCES exact_candidate_executions_v47(execution_id) ON DELETE RESTRICT,
 FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_responses_v39(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT,
 CHECK(linked_at=strftime('%Y-%m-%dT%H:%M:%fZ',linked_at) AND substr(linked_at,12,2) BETWEEN '00' AND '23')
);
CREATE INDEX idx_exact_candidate_provider_turn_v48 ON exact_candidate_provider_bindings_v48(campaign_id,turn_id,linked_at);
CREATE TRIGGER exact_candidate_provider_binding_validate_v48 BEFORE INSERT ON exact_candidate_provider_bindings_v48 WHEN
 NOT EXISTS(SELECT 1 FROM agent_provider_responses_v39 response JOIN agent_provider_contexts_v39 context ON context.context_id=response.context_id
   WHERE response.campaign_id=NEW.campaign_id AND response.turn_id=NEW.turn_id AND response.provider_call_id=NEW.provider_call_id
    AND response.status='succeeded' AND context.round_number=NEW.round_number
    AND json_array_length(json_extract(response.response_json,'$.calls'))=1
    AND json_extract(response.response_json,'$.result')='tool-calls'
    AND json_extract(response.response_json,'$.calls[0].providerToolCallId')=NEW.provider_tool_call_id
    AND json_extract(response.response_json,'$.calls[0].toolName')=NEW.tool_name
     AND json_extract(response.response_json,'$.calls[0].kind')='mutation'
     AND json_extract(response.response_json,'$.calls[0].arguments')=json(NEW.selection_json)
    AND json_extract(context.request_json,'$.exactCandidateProjection')=json(NEW.provider_projection_json)
    AND json_array_length(json_extract(context.request_json,'$.advertisedToolSchemas'))>0
    AND EXISTS(SELECT 1 FROM json_each(context.request_json,'$.advertisedTools') tool WHERE tool.value=NEW.tool_name)
     AND EXISTS(SELECT 1 FROM json_each(context.request_json,'$.advertisedToolSchemas') tool WHERE json_extract(tool.value,'$.name')=NEW.tool_name
      AND json_extract(tool.value,'$.parameters.additionalProperties')=0
      AND json_array_length(json_extract(tool.value,'$.parameters.required'))=4
      AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(tool.value,'$.parameters.required')) required
        WHERE required.value NOT IN('candidateId','kind','version','choices'))
      AND json_array_length(json_extract(tool.value,'$.parameters.properties.candidateId.enum'))=
        json_array_length(json_extract(context.request_json,'$.exactCandidateProjection.candidates'))
      AND json_extract(tool.value,'$.parameters.properties.kind.enum[0]')='actor.travel'
      AND json_array_length(json_extract(tool.value,'$.parameters.properties.kind.enum'))=1
      AND json_extract(tool.value,'$.parameters.properties.version.enum[0]')='v1'
      AND json_array_length(json_extract(tool.value,'$.parameters.properties.version.enum'))=1
      AND json_extract(tool.value,'$.parameters.properties.choices.type')='array'
      AND json_extract(tool.value,'$.parameters.properties.choices.maxItems')=0))
 OR NOT EXISTS(SELECT 1 FROM exact_candidate_executions_v47 execution JOIN exact_candidates_v46 candidate ON candidate.candidate_id=execution.candidate_id
   JOIN exact_candidate_batches_v46 batch ON batch.batch_id=candidate.batch_id
   WHERE execution.execution_id=NEW.execution_id AND execution.candidate_id=NEW.candidate_id AND execution.campaign_id=NEW.campaign_id
    AND execution.turn_id=NEW.turn_id AND execution.world_command_id=NEW.world_command_id AND execution.selection_digest=NEW.selection_digest
    AND execution.linked_at=NEW.linked_at AND batch.batch_id=NEW.batch_id
    AND json_extract(NEW.selection_json,'$.candidateId')=NEW.candidate_id
    AND json_extract(NEW.selection_json,'$.kind')='actor.travel' AND json_extract(NEW.selection_json,'$.version')='v1'
    AND json_array_length(json_extract(NEW.selection_json,'$.choices'))=0
    AND (SELECT count(*) FROM json_each(NEW.selection_json))=4
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.selection_json) field WHERE field.key NOT IN('candidateId','kind','version','choices')))
 OR NEW.expected_execution_revision<>(SELECT COALESCE(max(operation.resulting_execution_revision),0) FROM agent_execution_operations_v38 operation
      WHERE operation.campaign_id=NEW.campaign_id AND operation.turn_id=NEW.turn_id)
 OR NEW.expected_execution_revision<>(SELECT start.resulting_execution_revision FROM agent_provider_starts_v38 start
      WHERE start.campaign_id=NEW.campaign_id AND start.turn_id=NEW.turn_id AND start.provider_call_id=NEW.provider_call_id)
 OR EXISTS(SELECT 1 FROM exact_candidate_provider_bindings_v48 prior WHERE prior.campaign_id=NEW.campaign_id AND prior.turn_id=NEW.turn_id)
 BEGIN SELECT RAISE(ABORT,'v48 provider exact-candidate binding is invalid');END;
CREATE TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48 BEFORE UPDATE ON exact_candidate_provider_bindings_v48 BEGIN SELECT RAISE(ABORT,'v48 provider bindings are immutable');END;
CREATE TRIGGER exact_candidate_provider_bindings_v48_immutable_delete_v48 BEFORE DELETE ON exact_candidate_provider_bindings_v48 BEGIN SELECT RAISE(ABORT,'v48 provider bindings are immutable');END;
CREATE TABLE character_draft_rerolls_v49 (
      draft_id TEXT NOT NULL REFERENCES character_drafts_v19(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
      allocation_json TEXT NOT NULL CHECK(json_valid(allocation_json) AND json_type(allocation_json)='object'
        AND json_extract(allocation_json,'$.method')='server-roll'),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      PRIMARY KEY(draft_id,revision),
      FOREIGN KEY(draft_id,revision) REFERENCES character_draft_revisions_v19(draft_id,revision) DEFERRABLE INITIALLY DEFERRED
    );
CREATE TRIGGER character_draft_rerolls_v49_immutable_update BEFORE UPDATE ON character_draft_rerolls_v49
      BEGIN SELECT RAISE(ABORT,'character rerolls are immutable'); END;
CREATE TRIGGER character_draft_rerolls_v49_immutable_delete BEFORE DELETE ON character_draft_rerolls_v49
      BEGIN SELECT RAISE(ABORT,'character rerolls are immutable'); END;
CREATE TABLE campaign_generation_calls_v50 (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      state TEXT NOT NULL CHECK(state IN ('started','succeeded','failed')),
      provider TEXT NOT NULL, model TEXT NOT NULL, operation TEXT NOT NULL, stage TEXT NOT NULL,
      prompt_version TEXT NOT NULL, schema_version TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 32),
      prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0), completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),
      latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms>=0), estimated_cost_usd REAL CHECK(estimated_cost_usd IS NULL OR estimated_cost_usd>=0),
      started_at TEXT NOT NULL, terminal_at TEXT,
      draft_id TEXT REFERENCES generation_drafts(id) ON DELETE RESTRICT, job_id TEXT NOT NULL, outcome_code TEXT,
      PRIMARY KEY(campaign_id,idempotency_key),
      CHECK((state='started' AND terminal_at IS NULL AND draft_id IS NULL AND outcome_code IS NULL)
        OR (state='succeeded' AND terminal_at IS NOT NULL AND draft_id IS NOT NULL AND outcome_code='ok')
        OR (state='failed' AND terminal_at IS NOT NULL AND draft_id IS NULL AND outcome_code IS NOT NULL))
    );
CREATE TABLE campaign_generation_artifacts_v50 (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      artifact_key TEXT NOT NULL, artifact_kind TEXT NOT NULL CHECK(artifact_kind IN
        ('opening','location','connection','faction','npc','quest','storyline')),
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')),
      canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json) AND json_type(canonical_json)='object'),
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL, PRIMARY KEY(campaign_id,artifact_key)
    );
CREATE INDEX campaign_generation_artifacts_v50_draft ON campaign_generation_artifacts_v50(source_draft_id,artifact_kind);
CREATE TRIGGER campaign_generation_artifacts_v50_immutable_update BEFORE UPDATE ON campaign_generation_artifacts_v50 BEGIN SELECT RAISE(ABORT,'v50 generation artifacts are immutable'); END;
CREATE TRIGGER campaign_generation_artifacts_v50_immutable_delete BEFORE DELETE ON campaign_generation_artifacts_v50 BEGIN SELECT RAISE(ABORT,'v50 generation artifacts are immutable'); END;
CREATE TABLE character_starter_materializations_v51 (
      draft_id TEXT NOT NULL, grant_position INTEGER NOT NULL,
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      materialization_kind TEXT NOT NULL CHECK(materialization_kind IN ('inventory','wallet')),
      materialized_resource_id TEXT NOT NULL,
      materialized_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',materialized_at)=materialized_at),
      PRIMARY KEY(draft_id,grant_position), UNIQUE(materialization_kind,materialized_resource_id),
      FOREIGN KEY(draft_id,grant_position) REFERENCES character_starting_grants_v19(draft_id,position) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT
    );
CREATE TABLE combat_reward_settlements_v51 (
      reward_bundle_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, encounter_id TEXT NOT NULL,
      recipient_actor_id TEXT NOT NULL, reward_claim_id TEXT NOT NULL UNIQUE,
      settled_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',settled_at)=settled_at),
      FOREIGN KEY(campaign_id,reward_bundle_id) REFERENCES reward_bundle(campaign_id,reward_bundle_id) ON DELETE RESTRICT,
      FOREIGN KEY(reward_claim_id) REFERENCES reward_claim_v27(reward_claim_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,recipient_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT
    );
CREATE TABLE campaign_starting_locations_v51 (
      campaign_id TEXT PRIMARY KEY, location_id TEXT NOT NULL,
      designated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',designated_at)=designated_at),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT
    );
CREATE TRIGGER character_starter_materializations_v51_immutable_update BEFORE UPDATE ON character_starter_materializations_v51 BEGIN SELECT RAISE(ABORT,'starter materializations are immutable'); END;
CREATE TRIGGER character_starter_materializations_v51_immutable_delete BEFORE DELETE ON character_starter_materializations_v51 BEGIN SELECT RAISE(ABORT,'starter materializations are immutable'); END;
CREATE TRIGGER combat_reward_settlements_v51_immutable_update BEFORE UPDATE ON combat_reward_settlements_v51 BEGIN SELECT RAISE(ABORT,'combat reward settlements are immutable'); END;
CREATE TRIGGER combat_reward_settlements_v51_immutable_delete BEFORE DELETE ON combat_reward_settlements_v51 BEGIN SELECT RAISE(ABORT,'combat reward settlements are immutable'); END;
CREATE TRIGGER campaign_starting_locations_v51_immutable_update BEFORE UPDATE ON campaign_starting_locations_v51 BEGIN SELECT RAISE(ABORT,'campaign starting locations are immutable'); END;
CREATE TRIGGER campaign_starting_locations_v51_immutable_delete BEFORE DELETE ON campaign_starting_locations_v51 BEGIN SELECT RAISE(ABORT,'campaign starting locations are immutable'); END;
CREATE TABLE campaign_generation_jobs_v52 (
      job_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')),
      attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 1 AND 32),
      draft_id TEXT REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      last_outcome_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(campaign_id,idempotency_key),
      CHECK((state='running' AND draft_id IS NULL AND last_outcome_code IS NULL)
        OR (state='succeeded' AND draft_id IS NOT NULL AND last_outcome_code='ok')
        OR (state='failed' AND draft_id IS NULL AND last_outcome_code IS NOT NULL))
    );
CREATE TABLE campaign_generation_attempts_v52 (
      job_id TEXT NOT NULL REFERENCES campaign_generation_jobs_v52(job_id) ON DELETE RESTRICT,
      attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 32),
      retry_count INTEGER NOT NULL CHECK(retry_count=attempt-1),
      provider TEXT NOT NULL, requested_model TEXT NOT NULL, response_model TEXT,
      operation TEXT NOT NULL, stage TEXT NOT NULL, prompt_version TEXT NOT NULL, schema_version TEXT NOT NULL,
      prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0),
      completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),
      total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0),
      latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms>=0),
      estimated_cost_usd REAL CHECK(estimated_cost_usd IS NULL OR estimated_cost_usd>=0),
      started_at TEXT NOT NULL, terminal_at TEXT, outcome_code TEXT,
      PRIMARY KEY(job_id,attempt),
      CHECK((terminal_at IS NULL AND outcome_code IS NULL AND prompt_tokens IS NULL AND completion_tokens IS NULL
        AND total_tokens IS NULL AND latency_ms IS NULL AND estimated_cost_usd IS NULL)
        OR (terminal_at IS NOT NULL AND outcome_code IS NOT NULL))
    );
CREATE UNIQUE INDEX campaign_generation_attempts_v52_one_running
      ON campaign_generation_attempts_v52(job_id) WHERE terminal_at IS NULL;
CREATE TABLE campaign_generation_candidate_artifacts_v52 (
      draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      artifact_key TEXT NOT NULL, artifact_kind TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')),
      canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json) AND json_type(canonical_json)='object'),
      PRIMARY KEY(draft_id,artifact_key)
    );
CREATE TABLE campaign_generation_dependencies_v52 (
      draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      artifact_key TEXT NOT NULL, canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64),
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      server_resource_id TEXT,
      PRIMARY KEY(draft_id,artifact_key)
    );
CREATE TABLE campaign_generation_accepted_artifacts_v52 (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      artifact_key TEXT NOT NULL, artifact_kind TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')),
      canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json) AND json_type(canonical_json)='object'),
      canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64),
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      server_resource_id TEXT, accepted_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,artifact_key)
    );
CREATE INDEX campaign_generation_accepted_artifacts_v52_draft
      ON campaign_generation_accepted_artifacts_v52(source_draft_id,artifact_kind);
CREATE TABLE generated_npc_placement_intents_v52 (
      campaign_id TEXT NOT NULL, npc_id TEXT NOT NULL, location_id TEXT NOT NULL,
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK(state IN ('pending','placed')), session_id TEXT,
      created_at TEXT NOT NULL, reconciled_at TEXT,
      PRIMARY KEY(campaign_id,npc_id),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT,
      CHECK((state='pending' AND session_id IS NULL AND reconciled_at IS NULL)
        OR (state='placed' AND session_id IS NOT NULL AND reconciled_at IS NOT NULL))
    );
CREATE INDEX generated_npc_placement_intents_v52_pending
      ON generated_npc_placement_intents_v52(campaign_id,state);
CREATE TRIGGER campaign_generation_candidate_artifacts_v52_immutable_update BEFORE UPDATE ON campaign_generation_candidate_artifacts_v52
      BEGIN SELECT RAISE(ABORT,'v52 campaign generation records are immutable'); END;
CREATE TRIGGER campaign_generation_candidate_artifacts_v52_immutable_delete BEFORE DELETE ON campaign_generation_candidate_artifacts_v52
      BEGIN SELECT RAISE(ABORT,'v52 campaign generation records are immutable'); END;
CREATE TRIGGER campaign_generation_dependencies_v52_immutable_update BEFORE UPDATE ON campaign_generation_dependencies_v52
      BEGIN SELECT RAISE(ABORT,'v52 campaign generation records are immutable'); END;
CREATE TRIGGER campaign_generation_dependencies_v52_immutable_delete BEFORE DELETE ON campaign_generation_dependencies_v52
      BEGIN SELECT RAISE(ABORT,'v52 campaign generation records are immutable'); END;
CREATE TRIGGER campaign_generation_accepted_artifacts_v52_immutable_update BEFORE UPDATE ON campaign_generation_accepted_artifacts_v52
      BEGIN SELECT RAISE(ABORT,'v52 campaign generation records are immutable'); END;
CREATE TRIGGER campaign_generation_accepted_artifacts_v52_immutable_delete BEFORE DELETE ON campaign_generation_accepted_artifacts_v52
      BEGIN SELECT RAISE(ABORT,'v52 campaign generation records are immutable'); END;
CREATE TABLE campaign_material_delivery_revisions_v53 (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at)
    );
CREATE TABLE campaign_material_delivery_commands_v53 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      artifact_key TEXT NOT NULL CHECK(length(artifact_key) BETWEEN 1 AND 64 AND artifact_key NOT GLOB '*[^a-z0-9-]*'),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(principal_id) BETWEEN 1 AND 128 AND principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,command_id), UNIQUE(campaign_id,idempotency_key), UNIQUE(campaign_id,resulting_revision),
      FOREIGN KEY(campaign_id) REFERENCES campaign_material_delivery_revisions_v53(campaign_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,artifact_key) REFERENCES campaign_generation_accepted_artifacts_v52(campaign_id,artifact_key) ON DELETE RESTRICT
    );
CREATE TABLE campaign_material_delivery_receipts_v53 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      canonical_result_json TEXT NOT NULL CHECK(json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
      PRIMARY KEY(campaign_id,command_id), UNIQUE(campaign_id,resulting_revision),
      FOREIGN KEY(campaign_id,command_id) REFERENCES campaign_material_delivery_commands_v53(campaign_id,command_id) ON DELETE RESTRICT
    );
CREATE TABLE campaign_material_deliveries_v53 (
      campaign_id TEXT NOT NULL, artifact_key TEXT NOT NULL, resource_id TEXT NOT NULL,
      command_id TEXT NOT NULL, published_at TEXT NOT NULL CHECK(length(published_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',published_at)=published_at),
      PRIMARY KEY(campaign_id,artifact_key), UNIQUE(campaign_id,resource_id),
      FOREIGN KEY(campaign_id,artifact_key) REFERENCES campaign_generation_accepted_artifacts_v52(campaign_id,artifact_key) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,command_id) REFERENCES campaign_material_delivery_commands_v53(campaign_id,command_id) ON DELETE RESTRICT
    );
CREATE TRIGGER campaign_material_delivery_revision_advance_v53 BEFORE UPDATE ON campaign_material_delivery_revisions_v53
      WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'material delivery revision must advance once'); END;
CREATE TRIGGER campaign_material_delivery_command_guard_v53 BEFORE INSERT ON campaign_material_delivery_commands_v53
      WHEN NOT EXISTS(SELECT 1 FROM campaign_memberships member WHERE member.campaign_id=NEW.campaign_id AND member.principal_id=NEW.principal_id AND member.role IN ('owner','gm'))
        OR NOT EXISTS(SELECT 1 FROM campaign_material_delivery_revisions_v53 root WHERE root.campaign_id=NEW.campaign_id AND root.revision=NEW.expected_revision)
        OR NOT EXISTS(SELECT 1 FROM campaign_generation_accepted_artifacts_v52 artifact WHERE artifact.campaign_id=NEW.campaign_id AND artifact.artifact_key=NEW.artifact_key
          AND artifact.visibility='public' AND artifact.artifact_kind IN ('handout','scene-prompt') AND artifact.server_resource_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'material delivery command is invalid'); END;
CREATE TRIGGER campaign_material_delivery_projection_guard_v53 BEFORE INSERT ON campaign_material_deliveries_v53
      WHEN NOT EXISTS(SELECT 1 FROM campaign_material_delivery_commands_v53 command JOIN campaign_generation_accepted_artifacts_v52 artifact USING(campaign_id,artifact_key)
        WHERE command.campaign_id=NEW.campaign_id AND command.command_id=NEW.command_id AND command.artifact_key=NEW.artifact_key
          AND command.created_at=NEW.published_at AND artifact.server_resource_id=NEW.resource_id)
      BEGIN SELECT RAISE(ABORT,'material delivery projection is invalid'); END;
CREATE TRIGGER campaign_material_delivery_commands_v53_immutable_update BEFORE UPDATE ON campaign_material_delivery_commands_v53 BEGIN SELECT RAISE(ABORT,'v53 campaign material records are immutable'); END;
CREATE TRIGGER campaign_material_delivery_commands_v53_immutable_delete BEFORE DELETE ON campaign_material_delivery_commands_v53 BEGIN SELECT RAISE(ABORT,'v53 campaign material records are immutable'); END;
CREATE TRIGGER campaign_material_delivery_receipts_v53_immutable_update BEFORE UPDATE ON campaign_material_delivery_receipts_v53 BEGIN SELECT RAISE(ABORT,'v53 campaign material records are immutable'); END;
CREATE TRIGGER campaign_material_delivery_receipts_v53_immutable_delete BEFORE DELETE ON campaign_material_delivery_receipts_v53 BEGIN SELECT RAISE(ABORT,'v53 campaign material records are immutable'); END;
CREATE TRIGGER campaign_material_deliveries_v53_immutable_update BEFORE UPDATE ON campaign_material_deliveries_v53 BEGIN SELECT RAISE(ABORT,'v53 campaign material records are immutable'); END;
CREATE TRIGGER campaign_material_deliveries_v53_immutable_delete BEFORE DELETE ON campaign_material_deliveries_v53 BEGIN SELECT RAISE(ABORT,'v53 campaign material records are immutable'); END;
INSERT INTO "principals" ("id", "display_name", "is_local") VALUES ('local-owner', 'Local owner', 1);
INSERT INTO "application_owner" ("singleton", "principal_id") VALUES (1, 'local-owner');
INSERT INTO "rpg_effect_modifier_vocabulary_v26" ("modifier_kind") VALUES ('flat');
INSERT INTO "rpg_effect_modifier_vocabulary_v26" ("modifier_kind") VALUES ('proficiency');
INSERT INTO "rpg_effect_modifier_vocabulary_v26" ("modifier_kind") VALUES ('advantage');
INSERT INTO "rpg_effect_modifier_vocabulary_v26" ("modifier_kind") VALUES ('resistance');
INSERT INTO "rpg_effect_modifier_vocabulary_v26" ("modifier_kind") VALUES ('vulnerability');
INSERT INTO "rpg_effect_modifier_vocabulary_v26" ("modifier_kind") VALUES ('immunity');
