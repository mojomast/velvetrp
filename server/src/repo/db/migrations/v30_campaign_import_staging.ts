// Durable, immutable transfer dry-runs used by the HTTP apply-by-id lane.
import DatabaseDriver from "better-sqlite3";

export function createCampaignImportStagingV30(db: DatabaseDriver.Database): void {
  db.exec(`
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
  `);
}

export function assertCampaignImportStagingV30(db: DatabaseDriver.Database): void {
  const rows = db.prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE name IN
    ('campaign_import_dry_runs_v30','campaign_import_dry_runs_v30_immutable_update',
      'campaign_import_dry_runs_v30_immutable_delete','campaign_import_dry_runs_v30_prevent_replace')`).all();
  const names = new Set(rows.map((row) => row.name));
  if (names.size !== 4) throw new Error("schema v30 campaign import staging is incompatible");
}

export function migrate29to30(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createCampaignImportStagingV30(db);
    db.prepare("UPDATE meta SET value='30' WHERE key='schemaVersion'").run();
  })();
}
