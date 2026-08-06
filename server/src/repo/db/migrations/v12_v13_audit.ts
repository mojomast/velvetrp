// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";

/** Used only by migrate Xto Y; not called for fresh databases. */
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

/** Used only by migrate Xto Y; not called for fresh databases. */
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

export function migrate11to12(db: DatabaseDriver.Database): void {
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

export function migrate12to13(db: DatabaseDriver.Database): void {
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
