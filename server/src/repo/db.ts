import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { loadLegacyDatabase, markLegacyMigrated } from "../legacy.js";
import type { RuntimeDependencies } from "../runtime.js";
import type { Database } from "../types.js";
import { configureRepositoryDatabase } from "./repoContext.js";
import { configureDatabaseConnection, getDb } from "./db/connection.js";
import { configureSchema, ensureSchema, SCHEMA_REVISION } from "./db/schema.js";
import { migrate11to12, migrate12to13 } from "./db/migrations/v12_v13_audit.js";
import { createCampaignAdministrationV15, migrate14to15 } from "./db/migrations/v14_v15_administration.js";
import { assertCatalogLayoutV18, canonicalV17, createContentCatalogV16, createContentCatalogV17, createContentCatalogV18, migrate15to16, migrate16to17, migrate17to18 } from "./db/migrations/v16_v18_catalog.js";
import { V22_BUILDER_LAYOUT_DIGEST, assertCharacterBuilderLayoutV22, createCharacterBuilderIntegrityV21, createCharacterBuilderIntegrityV22, createCharacterBuilderProvenanceV20, createCharacterBuilderV19, migrate18to19, migrate19to20, migrate20to21, migrate21to22, validateV20DraftAudit } from "./db/migrations/v19_v22_character_builder.js";
import {
  assertCampaignContentPacksHaveExactSealedPacks,
  createCampaignContentPackSealedPinTriggers,
  createRpgCharactersV11,
  createRpgContentV10,
  createRpgFoundationV9,
  createSchemaV11,
} from "./db/migrations/v11_foundation.js";
import { progressionCatalogDigest, progressionReferenceKey, resolveInitialKnownPowers, resolveSelectedClassProgression } from "../characterProgressionCatalog.js";
import { assertCanonicalProgressionProfile, canonicalProgressionJson, canonicalStarterProgressionProfile,
  progressionProfileDigest, starterProgressionProfileId } from "../characterProgressionProfile.js";
import { assertPowerDefinitionExists, calculateAuthoritativeProgressionPreview, expectedKnownPowerSources, loadExactProgressionCatalog,
  type ProgressionRootRow } from "./characterProgressionPersistence.js";


configureSchema({
  assertCampaignContentPacksHaveExactSealedPacks, assertCharacterBuilderLayoutV22, assertCharacterLayoutV29,
  assertCharacterProgressionLayoutV23, assertCharacterProgressionLayoutV24, assertChecksPowersEffectsLayoutV26,
  assertCombatFoundationLayoutV27, assertResourcesInventoryEconomyRestLayoutV25, assertWorldTravelNpcFactionLayoutV28,
  createCampaignAdministrationV15, createCampaignContentPackSealedPinTriggers, createCampaignEventMatchingTriggerV14,
  createCharacterBuilderIntegrityV21, createCharacterBuilderIntegrityV22, createCharacterBuilderProvenanceV20,
  createCharacterBuilderV19, createCharacterLayoutV29, createCharacterProgressionIntegrityV24,
  createCharacterProgressionV23, createChecksPowersEffectsV26, createCombatFoundationV27, createContentCatalogV16,
  createContentCatalogV17, createContentCatalogV18, createQuestsV29r2, createResourcesInventoryEconomyRestV25,
  createRpgCommandAuditV14, createSchemaV11, createTimelineRevisionV12, createWorldTravelNpcFactionV28,
  migrate2to3, migrate3to4, migrate4to5, migrate5to6, migrate6to7, migrate7to8, migrate8to9, migrate9to10,
  migrate10to11, migrate11to12, migrate12to13, migrate13to14, migrate14to15, migrate15to16, migrate16to17,
  migrate17to18, migrate18to19, migrate19to20, migrate20to21, migrate21to22, migrate22to23, migrate23to24,
  migrate24to25, migrate25to26, migrate26to27, migrate27to28, migrate28to29, validateCharacterProgressionV23,
  validateCharacterProgressionV24, validateCombatFoundationV27, validateM15PersistenceV25, validateM16PersistenceV26,
  validateV20DraftAudit, validateWorldTravelNpcFactionV28,
});
configureDatabaseConnection(ensureSchema, migrateLegacyIfPresent);
configureRepositoryDatabase(getDb);

export { closeRepo, openRepositoryDatabase, resolveDataDir } from "./db/connection.js";

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

/** Additive v27r1 foundation for session-scoped, deterministic turn combat. */
function createCombatFoundationV27(db: DatabaseDriver.Database): void {
  db.exec(`
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
    -- Rewards are server projections of an immutable lifecycle event, rather
    -- than a client-supplied JSON payload.  v27 has no atomic item or XP store,
    -- and its wallet command stream cannot safely be advanced from this stream;
    -- consequently the only offerable entry is an un-settled currency claim.
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
    CREATE TABLE combat_foundation_layout_attestation_v27 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), prior_layout_digest TEXT NOT NULL CHECK(length(prior_layout_digest)=64), current_layout_digest TEXT NOT NULL CHECK(length(current_layout_digest)=64));
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
    CREATE TRIGGER combat_foundation_layout_attestation_v27_immutable_update BEFORE UPDATE ON combat_foundation_layout_attestation_v27 BEGIN SELECT RAISE(ABORT,'v27 layout attestation is immutable'); END;
    CREATE TRIGGER combat_foundation_layout_attestation_v27_immutable_delete BEFORE DELETE ON combat_foundation_layout_attestation_v27 BEGIN SELECT RAISE(ABORT,'v27 layout attestation is immutable'); END;
  `);
  const current=combatFoundationLayoutDigestV27(db);
  db.prepare("INSERT INTO combat_foundation_layout_attestation_v27(singleton,prior_layout_digest,current_layout_digest) VALUES(1,?,?)").run(V26_CHECKS_POWERS_EFFECTS_LAYOUT_DIGEST,current);
}
const V27_COMBAT_FOUNDATION_LAYOUT_DIGEST = "5ff782cab830d8c7e934edbae69fde1398b7482531d6b77c7ced8696798737be";
function combatFoundationLayoutRowsV27(db:DatabaseDriver.Database):unknown[]{return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name IN ('encounter','combatant','combat_log','reward_bundle','reward_entry_v27','reward_claim_v27') OR name GLOB '*_v27' OR name GLOB '*_v27_*' OR tbl_name IN ('encounter','combatant','combat_log','reward_bundle','reward_entry_v27','reward_claim_v27') OR tbl_name GLOB '*_v27' OR tbl_name GLOB '*_v27_*') ORDER BY type,name`).all();}
function combatFoundationLayoutDigestV27(db:DatabaseDriver.Database):string{const rows=(combatFoundationLayoutRowsV27(db) as Array<any>).map((row)=>({...row,sql:row.sql?.replace(/\s+/g," ").trim()}));return createHash("sha256").update(canonicalV17(rows)).digest("hex");}
function assertCombatFoundationLayoutV27(db:DatabaseDriver.Database):void{const row=db.prepare("SELECT prior_layout_digest,current_layout_digest FROM combat_foundation_layout_attestation_v27 WHERE singleton=1").get() as any;const actual=combatFoundationLayoutDigestV27(db);if(!row||row.prior_layout_digest!==V26_CHECKS_POWERS_EFFECTS_LAYOUT_DIGEST||row.current_layout_digest!==actual||actual!==V27_COMBAT_FOUNDATION_LAYOUT_DIGEST)throw new Error(`schema v27 combat foundation canonical SQL is incompatible (${actual})`);}
function validateCombatFoundationV27(db:DatabaseDriver.Database):void{const commands=db.prepare(`SELECT c.*,r.resulting_revision receipt_revision,r.occurred_at FROM combat_commands_v27 c LEFT JOIN combat_receipts_v27 r ON r.encounter_id=c.encounter_id AND r.command_id=c.command_id`).all() as Array<any>;if(commands.length!==(db.prepare("SELECT count(*) count FROM combat_receipts_v27").get() as {count:number}).count)throw new Error("M1.7 command receipt graph is incomplete");for(const c of commands){let request:any;try{request=JSON.parse(c.canonical_request_json);}catch{throw new Error("M1.7 command provenance is malformed");}if(c.canonical_request_json!==canonicalV17(request)||c.request_digest!==createHash("sha256").update(canonicalV17(request)).digest("hex")||c.receipt_revision!==c.resulting_revision||c.occurred_at!==c.created_at)throw new Error("M1.7 command receipt provenance is inconsistent");}for(const root of db.prepare("SELECT * FROM combat_mutation_revisions_v27").all() as Array<any>){const history=db.prepare("SELECT expected_revision,resulting_revision,created_at FROM combat_commands_v27 WHERE encounter_id=? ORDER BY resulting_revision").all(root.encounter_id) as Array<any>;if(history.length!==root.revision||history.some((r,i)=>r.expected_revision!==i||r.resulting_revision!==i+1)||(history.length>0&&root.updated_at!==history.at(-1)!.created_at))throw new Error("M1.7 revision root history is inconsistent");}const invalidReward=db.prepare(`SELECT 1 FROM reward_bundle bundle LEFT JOIN encounter encounter ON encounter.encounter_id=bundle.encounter_id AND encounter.campaign_id=bundle.campaign_id LEFT JOIN combat_events_v27 event ON event.encounter_id=bundle.encounter_id AND event.event_id=bundle.source_event_id LEFT JOIN combat_commands_v27 command ON command.encounter_id=event.encounter_id AND command.command_id=event.command_id WHERE encounter.encounter_id IS NULL OR event.event_type<>'rewards_granted' OR command.command_type<>'grant_rewards' OR event.occurred_at<>bundle.created_at UNION ALL SELECT 1 FROM reward_claim_v27 claim JOIN reward_bundle bundle ON bundle.campaign_id=claim.campaign_id AND bundle.reward_bundle_id=claim.reward_bundle_id LEFT JOIN combat_commands_v27 command ON command.encounter_id=claim.encounter_id AND command.command_id=claim.command_id WHERE bundle.encounter_id<>claim.encounter_id OR command.command_type<>'grant_rewards' OR command.created_at<>claim.claimed_at OR json_extract(command.canonical_request_json,'$.type')<>'claim_reward_bundle' OR json_extract(command.canonical_request_json,'$.rewardClaimId')<>claim.reward_claim_id OR json_extract(command.canonical_request_json,'$.rewardBundleId')<>claim.reward_bundle_id OR json_extract(command.canonical_request_json,'$.recipientActorId')<>bundle.recipient_actor_id LIMIT 1`).get();if(invalidReward)throw new Error("M1.7 reward provenance graph is inconsistent");}
function migrate26to27(db:DatabaseDriver.Database):void{db.transaction(()=>{assertChecksPowersEffectsLayoutV26(db);validateM16PersistenceV26(db);createCombatFoundationV27(db);db.prepare("UPDATE meta SET value='27' WHERE key='schemaVersion'").run();})();}

/** Additive v28r1 persistence for the campaign world graph and its state. */
function createWorldTravelNpcFactionV28(db: DatabaseDriver.Database): void {
  db.exec(`
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
    -- GM-only text is intentionally separate from the player-safe location row.
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
    CREATE TABLE world_travel_layout_attestation_v28 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), prior_layout_digest TEXT NOT NULL CHECK(length(prior_layout_digest)=64), current_layout_digest TEXT NOT NULL CHECK(length(current_layout_digest)=64));
    CREATE TRIGGER world_mutation_revisions_v28_campaign_session_ancestry BEFORE INSERT ON world_mutation_revisions_v28 WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'world session must belong to campaign'); END;
    CREATE TRIGGER world_commands_v28_campaign_session_ancestry BEFORE INSERT ON world_commands_v28 WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'world command session must belong to campaign'); END;
    CREATE TRIGGER world_mutation_revisions_v28_guard BEFORE UPDATE ON world_mutation_revisions_v28 WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.session_id<>OLD.session_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at BEGIN SELECT RAISE(ABORT,'world mutation revision must advance exactly once'); END;
    CREATE TRIGGER world_commands_v28_immutable_update BEFORE UPDATE ON world_commands_v28 BEGIN SELECT RAISE(ABORT,'world commands are immutable'); END; CREATE TRIGGER world_commands_v28_immutable_delete BEFORE DELETE ON world_commands_v28 BEGIN SELECT RAISE(ABORT,'world commands are immutable'); END;
    CREATE TRIGGER world_receipts_v28_immutable_update BEFORE UPDATE ON world_receipts_v28 BEGIN SELECT RAISE(ABORT,'world receipts are immutable'); END; CREATE TRIGGER world_receipts_v28_immutable_delete BEFORE DELETE ON world_receipts_v28 BEGIN SELECT RAISE(ABORT,'world receipts are immutable'); END;
    CREATE TRIGGER world_events_v28_immutable_update BEFORE UPDATE ON world_events_v28 BEGIN SELECT RAISE(ABORT,'world events are immutable'); END; CREATE TRIGGER world_events_v28_immutable_delete BEFORE DELETE ON world_events_v28 BEGIN SELECT RAISE(ABORT,'world events are immutable'); END;
    CREATE TRIGGER campaign_reputation_ledger_v28_immutable_update BEFORE UPDATE ON campaign_reputation_ledger_v28 BEGIN SELECT RAISE(ABORT,'reputation ledger is immutable'); END; CREATE TRIGGER campaign_reputation_ledger_v28_immutable_delete BEFORE DELETE ON campaign_reputation_ledger_v28 BEGIN SELECT RAISE(ABORT,'reputation ledger is immutable'); END;
    CREATE TRIGGER campaign_actor_locations_v28_ancestry BEFORE INSERT ON campaign_actor_locations_v28 WHEN NOT EXISTS(SELECT 1 FROM campaign_sessions WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT,'actor location session must belong to campaign'); END;
    -- A persona is exclusively either a manually controlled campaign actor or an NPC.
    CREATE TRIGGER campaign_npcs_v28_persona_not_campaign_character BEFORE INSERT ON campaign_npcs_v28 WHEN EXISTS(SELECT 1 FROM campaign_actors a JOIN campaign_characters cc ON cc.id=a.campaign_character_id AND cc.campaign_id=a.campaign_id WHERE a.campaign_id=NEW.campaign_id AND cc.character_id=NEW.persona_id) BEGIN SELECT RAISE(ABORT,'campaign character persona cannot become NPC'); END;
    CREATE TRIGGER campaign_actors_v28_persona_not_npc BEFORE INSERT ON campaign_actors WHEN EXISTS(SELECT 1 FROM campaign_characters cc JOIN campaign_npcs_v28 n ON n.campaign_id=NEW.campaign_id AND n.persona_id=cc.character_id WHERE cc.id=NEW.campaign_character_id AND cc.campaign_id=NEW.campaign_id) BEGIN SELECT RAISE(ABORT,'NPC persona cannot become campaign character'); END;
    CREATE TRIGGER campaign_actor_locations_v28_guard BEFORE UPDATE ON campaign_actor_locations_v28 WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.actor_id<>OLD.actor_id OR NEW.session_id<>OLD.session_id OR NEW.state_revision<>OLD.state_revision+1 OR NEW.updated_at<OLD.updated_at OR NOT EXISTS(SELECT 1 FROM world_events_v28 WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id AND event_type IN ('travelled','actor_location_set') AND occurred_at=NEW.updated_at) BEGIN SELECT RAISE(ABORT,'actor location requires immutable world event'); END;
    CREATE TRIGGER world_travel_party_members_v28_command_type BEFORE INSERT ON world_travel_party_members_v28 WHEN NOT EXISTS(SELECT 1 FROM world_commands_v28 WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id AND command_id=NEW.command_id AND command_type='travel') BEGIN SELECT RAISE(ABORT,'travel party member requires travel command'); END;
    CREATE TRIGGER world_travel_destinations_v28_command_type BEFORE INSERT ON world_travel_destinations_v28 WHEN NOT EXISTS(SELECT 1 FROM world_commands_v28 WHERE campaign_id=NEW.campaign_id AND session_id=NEW.session_id AND command_id=NEW.command_id AND command_type='travel') BEGIN SELECT RAISE(ABORT,'travel destination requires travel command'); END;
    CREATE TRIGGER world_travel_layout_attestation_v28_immutable_update BEFORE UPDATE ON world_travel_layout_attestation_v28 BEGIN SELECT RAISE(ABORT,'v28 layout attestation is immutable'); END; CREATE TRIGGER world_travel_layout_attestation_v28_immutable_delete BEFORE DELETE ON world_travel_layout_attestation_v28 BEGIN SELECT RAISE(ABORT,'v28 layout attestation is immutable'); END;
  `);
  const current=worldTravelNpcFactionLayoutDigestV28(db);
  db.prepare("INSERT INTO world_travel_layout_attestation_v28(singleton,prior_layout_digest,current_layout_digest) VALUES(1,?,?)").run(V27_COMBAT_FOUNDATION_LAYOUT_DIGEST,current);
}
const V28_WORLD_TRAVEL_NPC_FACTION_LAYOUT_DIGEST = "2f6001699f45ecc90c426e05065d0ef004196c4419a5fbe2a94cd7e3770688c7";
function worldTravelNpcFactionLayoutRowsV28(db:DatabaseDriver.Database):unknown[]{return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name GLOB '*_v28' OR name GLOB '*_v28_*' OR tbl_name GLOB '*_v28' OR tbl_name GLOB '*_v28_*') ORDER BY type,name`).all();}
function worldTravelNpcFactionLayoutDigestV28(db:DatabaseDriver.Database):string{const rows=(worldTravelNpcFactionLayoutRowsV28(db) as Array<any>).map((row)=>({...row,sql:row.sql?.replace(/\s+/g," ").trim()}));return createHash("sha256").update(canonicalV17(rows)).digest("hex");}
function assertWorldTravelNpcFactionLayoutV28(db:DatabaseDriver.Database):void{const row=db.prepare("SELECT prior_layout_digest,current_layout_digest FROM world_travel_layout_attestation_v28 WHERE singleton=1").get() as any;const actual=worldTravelNpcFactionLayoutDigestV28(db);if(!row||row.prior_layout_digest!==V27_COMBAT_FOUNDATION_LAYOUT_DIGEST||row.current_layout_digest!==actual||actual!==V28_WORLD_TRAVEL_NPC_FACTION_LAYOUT_DIGEST)throw new Error(`schema v28 world/travel canonical SQL is incompatible (${actual})`);}
function validateWorldTravelNpcFactionV28(db:DatabaseDriver.Database):void{const commands=db.prepare(`SELECT c.*,r.resulting_revision receipt_revision,r.occurred_at FROM world_commands_v28 c LEFT JOIN world_receipts_v28 r ON r.campaign_id=c.campaign_id AND r.session_id=c.session_id AND r.command_id=c.command_id`).all() as Array<any>;if(commands.length!==(db.prepare("SELECT count(*) count FROM world_receipts_v28").get() as {count:number}).count)throw new Error("M1.8 command receipt graph is incomplete");for(const c of commands){let request:any;try{request=JSON.parse(c.canonical_request_json);}catch{throw new Error("M1.8 command provenance is malformed");}if(c.canonical_request_json!==canonicalV17(request)||c.request_digest!==createHash("sha256").update(canonicalV17(request)).digest("hex")||c.receipt_revision!==c.resulting_revision||c.occurred_at!==c.created_at)throw new Error("M1.8 command receipt provenance is inconsistent");}for(const root of db.prepare("SELECT * FROM world_mutation_revisions_v28").all() as Array<any>){const history=db.prepare("SELECT expected_revision,resulting_revision,created_at FROM world_commands_v28 WHERE campaign_id=? AND session_id=? ORDER BY resulting_revision").all(root.campaign_id,root.session_id) as Array<any>;if(history.length!==root.revision||history.some((r,i)=>r.expected_revision!==i||r.resulting_revision!==i+1)||(history.length>0&&root.updated_at!==history.at(-1)!.created_at))throw new Error("M1.8 revision root history is inconsistent");}}
function migrate27to28(db:DatabaseDriver.Database):void{db.transaction(()=>{assertCombatFoundationLayoutV27(db);validateCombatFoundationV27(db);createWorldTravelNpcFactionV28(db);db.prepare("UPDATE meta SET value='28' WHERE key='schemaVersion'").run();})();}

const V29_CHARACTER_COLUMNS = ["id", "name", "age", "archetype", "boundaries", "fictional_confirmed", "is_real_person", "created_at"];
const V29_CHARACTER_LAYOUT_DIGEST = "bcca64e4206ed0db503cbea137334ae9f92fa6050537e3a950630b00b37bc25d";

function characterLayoutDigestV29(db: DatabaseDriver.Database): string {
  const columns = (db.prepare("PRAGMA table_info(characters)").all() as Array<{ name: string }>).map((column) => column.name);
  return createHash("sha256").update(JSON.stringify(columns)).digest("hex");
}

function createCharacterLayoutV29(db: DatabaseDriver.Database): void {
  db.exec(`CREATE TABLE character_layout_attestation_v29 (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64)
  );
  CREATE TRIGGER character_layout_attestation_v29_immutable_update BEFORE UPDATE ON character_layout_attestation_v29 BEGIN SELECT RAISE(ABORT,'v29 character layout attestation is immutable'); END;
  CREATE TRIGGER character_layout_attestation_v29_immutable_delete BEFORE DELETE ON character_layout_attestation_v29 BEGIN SELECT RAISE(ABORT,'v29 character layout attestation is immutable'); END;`);
  db.prepare("INSERT INTO character_layout_attestation_v29(singleton,layout_digest) VALUES(1,?)").run(characterLayoutDigestV29(db));
}

function assertCharacterLayoutV29(db: DatabaseDriver.Database): void {
  const columns = (db.prepare("PRAGMA table_info(characters)").all() as Array<{ name: string }>).map((column) => column.name);
  const row = db.prepare("SELECT layout_digest FROM character_layout_attestation_v29 WHERE singleton=1").get() as { layout_digest: string } | undefined;
  const actual = characterLayoutDigestV29(db);
  if (JSON.stringify(columns) !== JSON.stringify(V29_CHARACTER_COLUMNS) || !row || row.layout_digest !== actual || actual !== V29_CHARACTER_LAYOUT_DIGEST) {
    throw new Error(`schema v29 character layout is incompatible (${actual})`);
  }
}

function migrate28to29(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    assertWorldTravelNpcFactionLayoutV28(db);
    const columns = (db.prepare("PRAGMA table_info(characters)").all() as Array<{ name: string }>).map((column) => column.name);
    if (columns.includes("safe_word")) db.exec("ALTER TABLE characters DROP COLUMN safe_word");
    createCharacterLayoutV29(db);
    db.prepare("UPDATE meta SET value='29' WHERE key='schemaVersion'").run();
  })();
}

function createQuestsV29r2(db: DatabaseDriver.Database): void {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_quests_campaign ON quests(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_quest_clues_quest ON quest_clues(quest_id);
    CREATE INDEX IF NOT EXISTS idx_quest_rewards_quest ON quest_rewards(quest_id);
    CREATE INDEX IF NOT EXISTS idx_storylines_campaign ON quest_storylines(campaign_id);
  `);
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
      `INSERT INTO characters (id, name, age, archetype, boundaries, fictional_confirmed, is_real_person, created_at)
       VALUES (@id, @name, @age, @archetype, @boundaries, @fictionalConfirmed, @isRealPerson, @createdAt)`,
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
