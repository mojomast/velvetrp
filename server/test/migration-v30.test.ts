import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { removeFutureCampaignContentGenerationSchema } from "./helpers.js";

const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "velvet-v30-"));
const file = (dir: string) => path.join(dir, "velvet.sqlite");
const layout = (dir: string) => {
  const db = new DatabaseDriver(file(dir), { readonly: true });
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close(); return rows;
};
function rewind(dir: string): void {
  const db = new DatabaseDriver(file(dir));
  removeFutureCampaignContentGenerationSchema(db);
  db.exec(`DROP TRIGGER campaign_import_dry_runs_v30_immutable_update;
    DROP TRIGGER campaign_import_dry_runs_v30_immutable_delete;
    DROP TRIGGER campaign_import_dry_runs_v30_prevent_replace;
    DROP TABLE campaign_import_dry_runs_v30;`);
  db.prepare("UPDATE meta SET value='29' WHERE key='schemaVersion'").run();
  db.close();
}

describe("schema v30 campaign import staging", () => {
  it("has fresh/migrated parity and immutable staging records", () => {
    const migrated = makeDir(); createRepository({ dataDir: migrated }).close(); rewind(migrated);
    createRepository({ dataDir: migrated }).close();
    const fresh = makeDir(); createRepository({ dataDir: fresh }).close();
    expect(layout(migrated)).toEqual(layout(fresh));
    const db = new DatabaseDriver(file(migrated));
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    db.close();
  });

  it("rolls back staging creation when the schema marker cannot advance", () => {
    const dir = makeDir(); createRepository({ dataDir: dir }).close(); rewind(dir);
    const db = new DatabaseDriver(file(dir));
    db.exec("CREATE TRIGGER reject_v30 BEFORE UPDATE OF value ON meta WHEN NEW.value='30' BEGIN SELECT RAISE(ABORT,'reject v30'); END;");
    db.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("reject v30");
    const verify = new DatabaseDriver(file(dir));
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='campaign_import_dry_runs_v30'").get()).toBeUndefined();
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "29" });
    verify.close();
  });
});
