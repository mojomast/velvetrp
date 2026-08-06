// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { progressionCatalogDigest, progressionReferenceKey, resolveInitialKnownPowers, resolveSelectedClassProgression } from "../../../characterProgressionCatalog.js";
import { assertCanonicalProgressionProfile, canonicalProgressionJson, canonicalStarterProgressionProfile, progressionProfileDigest, starterProgressionProfileId } from "../../../characterProgressionProfile.js";
import { assertPowerDefinitionExists, calculateAuthoritativeProgressionPreview, expectedKnownPowerSources, loadExactProgressionCatalog, type ProgressionRootRow } from "../../characterProgressionPersistence.js";
import { canonicalV17 } from "./v16_v18_catalog.js";
import { V22_BUILDER_LAYOUT_DIGEST, assertCharacterBuilderLayoutV22, validateV20DraftAudit } from "./v19_v22_character_builder.js";

/** Additive v23r1 single-class progression ledger and immutable audit graph. */
export function createCharacterProgressionV23(db:DatabaseDriver.Database):void{
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
export function createCharacterProgressionIntegrityV24(db:DatabaseDriver.Database):void{
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
export function assertCharacterProgressionLayoutV23(db:DatabaseDriver.Database):void{
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
export function validateCharacterProgressionV23(db:DatabaseDriver.Database):void{
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
export const V24_PROGRESSION_LAYOUT_DIGEST="e056d9df1ec9f9c00cc1aba740f2acc91b40cc7b03a5716cb75e79ec8df6bec8";
function characterProgressionLayoutRowsV24(db:DatabaseDriver.Database):unknown[]{return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
  AND (name GLOB '*_v24' OR name GLOB '*_v24_*' OR tbl_name GLOB '*_v24' OR tbl_name GLOB '*_v24_*') ORDER BY type,name`).all();}
function characterProgressionLayoutDigestV24(db:DatabaseDriver.Database):string{const rows=(characterProgressionLayoutRowsV24(db) as Array<any>).map((row)=>({...row,sql:row.sql?.replace(/\s+/g," ").trim()}));return createHash("sha256").update(canonicalV17(rows)).digest("hex");}
export function assertCharacterProgressionLayoutV24(db:DatabaseDriver.Database):void{const row=db.prepare("SELECT prior_layout_digest,current_layout_digest FROM character_progression_layout_attestation_v24 WHERE singleton=1").get() as any;
  const actual=characterProgressionLayoutDigestV24(db);if(!row||row.prior_layout_digest!==V23_PROGRESSION_LAYOUT_DIGEST||row.current_layout_digest!==actual||actual!==V24_PROGRESSION_LAYOUT_DIGEST)throw new Error(`schema v24 progression canonical SQL is incompatible (${actual})`);}
export function validateCharacterProgressionV24(db:DatabaseDriver.Database):void{
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
export function migrate22to23(db:DatabaseDriver.Database):void{
  db.transaction(()=>{
    assertCharacterBuilderLayoutV22(db);validateV20DraftAudit(db);
    createCharacterProgressionV23(db);
    db.prepare("UPDATE meta SET value='23' WHERE key='schemaVersion'").run();
  })();
}
export function migrate23to24(db:DatabaseDriver.Database):void{db.transaction(()=>{assertCharacterProgressionLayoutV23(db);validateCharacterProgressionV23(db);createCharacterProgressionIntegrityV24(db);db.prepare("UPDATE meta SET value='24' WHERE key='schemaVersion'").run();})();}
