// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";

export function createCampaignAdministrationV15(db: DatabaseDriver.Database): void {
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

export function migrate14to15(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    // The v14 gameplay audit graph is intentionally only read here. All v15
    // DDL is additive, preserving closed commands, events, receipts and rolls.
    createCampaignAdministrationV15(db);
    db.prepare("UPDATE meta SET value = '15' WHERE key = 'schemaVersion'").run();
  })();
}
