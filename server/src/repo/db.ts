import DatabaseDriver from "better-sqlite3";
import { configureRepositoryDatabase } from "./repoContext.js";
import { configureDatabaseConnection, getDb } from "./db/connection.js";
import { migrateLegacyIfPresent } from "./db/legacyImport.js";
import { configureSchema, ensureSchema, SCHEMA_REVISION } from "./db/schema.js";
import { migrate11to12, migrate12to13 } from "./db/migrations/v12_v13_audit.js";
import { createCampaignAdministrationV15, migrate14to15 } from "./db/migrations/v14_v15_administration.js";
import { assertCatalogLayoutV18, createContentCatalogV16, createContentCatalogV17, createContentCatalogV18, migrate15to16, migrate16to17, migrate17to18 } from "./db/migrations/v16_v18_catalog.js";
import { assertCharacterBuilderLayoutV22, createCharacterBuilderIntegrityV21, createCharacterBuilderIntegrityV22, createCharacterBuilderProvenanceV20, createCharacterBuilderV19, migrate18to19, migrate19to20, migrate20to21, migrate21to22, validateV20DraftAudit } from "./db/migrations/v19_v22_character_builder.js";
import { assertCharacterProgressionLayoutV23, assertCharacterProgressionLayoutV24, createCharacterProgressionIntegrityV24, createCharacterProgressionV23, migrate22to23, migrate23to24, validateCharacterProgressionV23, validateCharacterProgressionV24, V24_PROGRESSION_LAYOUT_DIGEST } from "./db/migrations/v23_v24_progression.js";
import { assertChecksPowersEffectsLayoutV26, assertResourcesInventoryEconomyRestLayoutV25, createChecksPowersEffectsV26, createResourcesInventoryEconomyRestV25, migrate24to25, migrate25to26, validateM15PersistenceV25, validateM16PersistenceV26, V26_CHECKS_POWERS_EFFECTS_LAYOUT_DIGEST } from "./db/migrations/v25_v26_resources.js";
import {
  assertCombatFoundationLayoutV27,
  assertWorldTravelNpcFactionLayoutV28,
  createCombatFoundationV27,
  createWorldTravelNpcFactionV28,
  migrate26to27,
  migrate27to28,
  validateCombatFoundationV27,
  validateWorldTravelNpcFactionV28,
} from "./db/migrations/v27_v28_combat_world.js";
import { assertCharacterLayoutV29, createCharacterLayoutV29, createQuestsV29r2, migrate28to29 } from "./db/migrations/v29_quests_layout.js";
import { assertCampaignImportStagingV30, createCampaignImportStagingV30, migrate29to30 } from "./db/migrations/v30_campaign_import_staging.js";
import { assertEncounterLifecycleV31, createEncounterLifecycleV31, migrate30to31 } from "./db/migrations/v31_encounter_lifecycle.js";
import { assertWorldNarrativeV32, createWorldNarrativeV32, migrate31to32 } from "./db/migrations/v32_world_narrative.js";
import { assertQuestDomainV33, createQuestDomainV33, migrate32to33 } from "./db/migrations/v33_quest_domain.js";
import { assertStoryDomainV34, createStoryDomainV34, migrate33to34 } from "./db/migrations/v34_story_domain.js";
import { assertAdventureGenerationV35, createAdventureGenerationV35, migrate34to35 } from "./db/migrations/v35_adventure_generation.js";
import { assertAdventureHardeningV36, createAdventureHardeningV36, migrate35to36 } from "./db/migrations/v36_adventure_hardening.js";
import { assertToolExecutionBindingsV37, createToolExecutionBindingsV37, migrate36to37 } from "./db/migrations/v37_tool_execution_bindings.js";
import { assertDurableAgentExecutionV38, createDurableAgentExecutionV38, migrate37to38 } from "./db/migrations/v38_durable_agent_execution.js";
import { assertAgentResponseProvenanceV39, createAgentResponseProvenanceV39, migrate38to39 } from "./db/migrations/v39_agent_response_provenance.js";
import { assertConfirmationPolicyV40, createConfirmationPolicyV40, migrate39to40 } from "./db/migrations/v40_confirmation_policy.js";
import { createCampaignContentGenerationV41, migrate40to41 } from "./db/migrations/v41_campaign_content_generation.js";
import { assertCampaignContentIntegrityV42, createCampaignContentIntegrityV42, migrate41to42 } from "./db/migrations/v42_campaign_content_integrity.js";
import { assertNpcPresenceLayoutV43, createNpcPresenceV43, migrate42to43 } from "./db/migrations/v43_npc_presence.js";
import { assertCompanionCoreLayoutV44, createCompanionCoreV44, migrate43to44 } from "./db/migrations/v44_companion_core.js";
import { assertCompanionCoreLayoutV45, migrate44to45 } from "./db/migrations/v45_companion_principals.js";
import { assertExactCandidatesLayoutV46, createExactCandidatesV46, migrate45to46 } from "./db/migrations/v46_exact_candidates.js";
import { assertExactCandidateExecutionsLayoutV47, createExactCandidateExecutionsV47, migrate46to47 } from "./db/migrations/v47_exact_candidate_executions.js";
import { assertExactCandidateProviderBridgeLayoutV48, createExactCandidateProviderBridgeV48, migrate47to48 } from "./db/migrations/v48_exact_candidate_provider_bridge.js";
import {
  assertCampaignContentPacksHaveExactSealedPacks,
  createCampaignContentPackSealedPinTriggers,
  createRpgCharactersV11,
  createRpgContentV10,
  createRpgFoundationV9,
  createSchemaV11,
} from "./db/migrations/v11_foundation.js";


configureSchema({
  assertCampaignContentPacksHaveExactSealedPacks, assertCampaignImportStagingV30, assertEncounterLifecycleV31, assertWorldNarrativeV32, assertQuestDomainV33, assertStoryDomainV34, assertAdventureGenerationV35, assertAdventureHardeningV36, assertToolExecutionBindingsV37, assertDurableAgentExecutionV38, assertAgentResponseProvenanceV39, assertConfirmationPolicyV40, assertCampaignContentIntegrityV42, assertNpcPresenceLayoutV43, assertCompanionCoreLayoutV44, assertCompanionCoreLayoutV45, assertExactCandidatesLayoutV46, assertExactCandidateExecutionsLayoutV47, assertExactCandidateProviderBridgeLayoutV48, assertCharacterBuilderLayoutV22, assertCharacterLayoutV29,
  assertCharacterProgressionLayoutV23, assertCharacterProgressionLayoutV24, assertChecksPowersEffectsLayoutV26,
  assertCombatFoundationLayoutV27, assertResourcesInventoryEconomyRestLayoutV25, assertWorldTravelNpcFactionLayoutV28,
  createCampaignAdministrationV15, createCampaignContentPackSealedPinTriggers, createCampaignEventMatchingTriggerV14,
  createCampaignImportStagingV30, createEncounterLifecycleV31, createWorldNarrativeV32, createQuestDomainV33, createStoryDomainV34, createAdventureGenerationV35, createAdventureHardeningV36, createToolExecutionBindingsV37, createDurableAgentExecutionV38, createAgentResponseProvenanceV39, createConfirmationPolicyV40,
  createCharacterBuilderIntegrityV21, createCharacterBuilderIntegrityV22, createCharacterBuilderProvenanceV20,
  createCharacterBuilderV19, createCharacterLayoutV29, createCharacterProgressionIntegrityV24,
  createCharacterProgressionV23, createChecksPowersEffectsV26, createCombatFoundationV27, createContentCatalogV16,
  createContentCatalogV17, createContentCatalogV18, createQuestsV29r2, createResourcesInventoryEconomyRestV25,
  createRpgCommandAuditV14, createSchemaV11, createTimelineRevisionV12, createWorldTravelNpcFactionV28,
  migrate2to3, migrate3to4, migrate4to5, migrate5to6, migrate6to7, migrate7to8, migrate8to9, migrate9to10,
  migrate10to11, migrate11to12, migrate12to13, migrate13to14, migrate14to15, migrate15to16, migrate16to17,
  migrate17to18, migrate18to19, migrate19to20, migrate20to21, migrate21to22, migrate22to23, migrate23to24,
  migrate24to25, migrate25to26, migrate26to27, migrate27to28, migrate28to29, migrate29to30, migrate30to31, migrate31to32, migrate32to33, migrate33to34, migrate34to35, migrate35to36, migrate36to37, migrate37to38, migrate38to39, migrate39to40, validateCharacterProgressionV23,
  validateCharacterProgressionV24, validateCombatFoundationV27, validateM15PersistenceV25, validateM16PersistenceV26,
  validateV20DraftAudit, validateWorldTravelNpcFactionV28, createCampaignContentGenerationV41, migrate40to41, createCampaignContentIntegrityV42, migrate41to42, createNpcPresenceV43, migrate42to43, createCompanionCoreV44, migrate43to44, migrate44to45, createExactCandidatesV46, migrate45to46, createExactCandidateExecutionsV47, migrate46to47, createExactCandidateProviderBridgeV48, migrate47to48,
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
