// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalV17, assertCatalogLayoutV18 } from "./v16_v18_catalog.js";

/** Additive v19r1 character-draft, final snapshot, and grant provenance. */
export function createCharacterBuilderV19(db: DatabaseDriver.Database): void {
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
export function createCharacterBuilderProvenanceV20(db: DatabaseDriver.Database): void {
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
export function createCharacterBuilderIntegrityV21(db: DatabaseDriver.Database): void {
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
export function createCharacterBuilderIntegrityV22(db:DatabaseDriver.Database):void{
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
export const V22_BUILDER_LAYOUT_DIGEST="21f7c0c17a9ee210f1271bd1abaa6ac41d7d753acd2417f63c8ea4ce8c711599";
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
export function assertCharacterBuilderLayoutV22(db:DatabaseDriver.Database):void{
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

export function migrate18to19(db: DatabaseDriver.Database):void{
  db.transaction(()=>{
    assertCatalogLayoutV18(db);
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
export function validateV20DraftAudit(db:DatabaseDriver.Database):void{
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

export function migrate19to20(db:DatabaseDriver.Database):void{
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

export function migrate20to21(db:DatabaseDriver.Database):void{
  db.transaction(()=>{
    assertCharacterBuilderLayoutV20(db);
    validateV20DraftAudit(db);
    const markerCount=(db.prepare("SELECT COUNT(*) count FROM character_draft_campaign_deletions_v20").get() as {count:number}).count;
    if(markerCount!==0)throw new Error("schema v20 contains a persistent character draft deletion capability");
    createCharacterBuilderIntegrityV21(db);
    db.prepare("UPDATE meta SET value='21' WHERE key='schemaVersion'").run();
  })();
}

export function migrate21to22(db:DatabaseDriver.Database):void{
  db.transaction(()=>{
    assertCharacterBuilderLayoutV21(db);
    validateV20DraftAudit(db);
    createCharacterBuilderIntegrityV22(db);
    db.prepare("UPDATE meta SET value='22' WHERE key='schemaVersion'").run();
  })();
}
