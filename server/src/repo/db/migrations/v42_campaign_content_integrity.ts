import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";

const TABLES = ["campaign_content_commands_v42", "campaign_content_receipts_v42", "campaign_content_revisions_v42", "campaign_content_layout_attestation_v42"] as const;
const TRIGGERS = TABLES.flatMap((table) => [`${table}_immutable_update_v42`, `${table}_immutable_delete_v42`]);
const names = [...TABLES, ...TRIGGERS];
const digest = (db: DatabaseDriver.Database) => createHash("sha256").update(JSON.stringify(db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY type,name`).all(...names))).digest("hex");

/** Additive v42 seal for the historic v41 content projections. */
export function assertCampaignContentIntegrityV42(db: DatabaseDriver.Database): void {
  const present = db.prepare(`SELECT name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")})`).all(...names) as Array<{ name: string }>;
  if (present.length !== names.length) throw new Error("schema v42 campaign-content inventory is incompatible");
  const row = db.prepare("SELECT layout_digest FROM campaign_content_layout_attestation_v42 WHERE singleton=1").get() as { layout_digest: string } | undefined;
  if (!row || row.layout_digest !== digest(db)) throw new Error("schema v42 campaign-content layout attestation is incompatible");
}

export function createCampaignContentIntegrityV42(db: DatabaseDriver.Database): void {
  db.exec(`
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
    CREATE TABLE campaign_content_layout_attestation_v42 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64));
  `);
  for (const table of TABLES) db.exec(`CREATE TRIGGER ${table}_immutable_update_v42 BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'v42 records are immutable'); END; CREATE TRIGGER ${table}_immutable_delete_v42 BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'v42 records are immutable'); END;`);
  db.prepare("INSERT INTO campaign_content_layout_attestation_v42 VALUES(1,?)").run(digest(db));
}

export function migrate41to42(db: DatabaseDriver.Database): void {
  db.transaction(() => { createCampaignContentIntegrityV42(db); db.prepare("UPDATE meta SET value='42' WHERE key='schemaVersion'").run(); })();
}
