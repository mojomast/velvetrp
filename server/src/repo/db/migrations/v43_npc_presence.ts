import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";

const TABLES = [
  "npc_presence_session_revisions_v43",
  "campaign_npc_presence_v43",
  "npc_presence_commands_v43",
  "npc_presence_events_v43",
  "npc_presence_receipts_v43",
  "npc_presence_layout_attestation_v43",
] as const;
const IMMUTABLE_TABLES = [
  "npc_presence_commands_v43",
  "npc_presence_events_v43",
  "npc_presence_receipts_v43",
  "npc_presence_layout_attestation_v43",
] as const;
const TRIGGERS = [
  "npc_presence_session_revisions_v43_attached_insert_v43",
  "npc_presence_session_revisions_v43_revision_update_v43",
  "npc_presence_events_v43_exact_command_insert_v43",
  "npc_presence_receipts_v43_exact_event_insert_v43",
  "campaign_npc_presence_v43_exact_command_insert_v43",
  "campaign_npc_presence_v43_exact_command_update_v43",
  ...IMMUTABLE_TABLES.flatMap((table) => [
    `${table}_immutable_update_v43`,
    `${table}_immutable_delete_v43`,
  ]),
] as const;

const inventorySql = `SELECT type,name,tbl_name FROM sqlite_master
  WHERE type IN ('table','index','trigger') AND sql IS NOT NULL
    AND (name GLOB '*v43*' OR tbl_name IN (${TABLES.map(() => "?").join(",")}))
  ORDER BY type,name`;

export const NPC_PRESENCE_V43_MANAGED_OBJECTS = [
  ...TABLES.map((name) => ["table", name] as const),
  ...TRIGGERS.map((name) => ["trigger", name] as const),
] as const;

function layoutDigest(db: DatabaseDriver.Database): string {
  const names = NPC_PRESENCE_V43_MANAGED_OBJECTS.map(([, name]) => name);
  const rows = (db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY type,name`).all(...names) as Array<{
      type: string; name: string; tbl_name: string; sql: string | null;
    }>).map((row) => ({ ...row, sql: row.sql?.replace(/\s+/g, " ").trim() ?? null }));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export const NPC_PRESENCE_V43_LAYOUT_DIGEST = "78ff2c192e2c38afa91f1c7fbfc401c9445f6036f63f4279ece2b1e7a6e4c7da";

export function assertNpcPresenceLayoutV43(db: DatabaseDriver.Database): void {
  const expected = new Set(NPC_PRESENCE_V43_MANAGED_OBJECTS.map(([type, name]) => `${type}:${name}`));
  // SQLite's constraint autoindexes have null SQL and are intentionally outside managed inventory.
  const artifacts = db.prepare(inventorySql).all(...TABLES) as Array<{ type: string; name: string }>;
  const unknown = artifacts.find(({ type, name }) => !expected.has(`${type}:${name}`));
  if (unknown || artifacts.length !== expected.size) throw new Error("schema v43 NPC-presence inventory is incompatible");
  const attestation = db.prepare("SELECT layout_digest FROM npc_presence_layout_attestation_v43 WHERE singleton=1")
    .get() as { layout_digest: string } | undefined;
  const actual = layoutDigest(db);
  if (!attestation || attestation.layout_digest !== actual || actual !== NPC_PRESENCE_V43_LAYOUT_DIGEST) {
    throw new Error(`schema v43 NPC-presence layout attestation is incompatible (${actual})`);
  }
}

export function createNpcPresenceV43(db: DatabaseDriver.Database): void {
  db.exec(`
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

    CREATE TABLE npc_presence_layout_attestation_v43 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64 AND layout_digest NOT GLOB '*[^0-9a-f]*')
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
  `);
  for (const table of IMMUTABLE_TABLES) {
    db.exec(`CREATE TRIGGER ${table}_immutable_update_v43 BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'v43 NPC-presence records are immutable'); END;
      CREATE TRIGGER ${table}_immutable_delete_v43 BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'v43 NPC-presence records are immutable'); END;`);
  }
  db.prepare("INSERT INTO npc_presence_layout_attestation_v43 VALUES(1,?)").run(layoutDigest(db));
}

export function migrate42to43(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createNpcPresenceV43(db);
    db.prepare("UPDATE meta SET value='43' WHERE key='schemaVersion'").run();
  })();
}
