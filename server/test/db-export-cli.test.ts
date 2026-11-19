import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseDriver from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(serverDir, "scripts", "export-db.mjs");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function seed(dataDir: string): string {
  const databasePath = path.join(dataDir, "velvet.sqlite");
  const raw = new DatabaseDriver(databasePath);
  raw.exec(`CREATE TABLE legacy_campaigns(id TEXT PRIMARY KEY, name TEXT, payload TEXT);
    INSERT INTO legacy_campaigns VALUES('c1','First','{"a":1}'),('c2','Second',NULL);
    CREATE TABLE notes(n INTEGER, body BLOB); INSERT INTO notes VALUES(7, x'00ff');`);
  raw.close();
  return databasePath;
}

describe("db:export command", () => {
  it("takes an online backup and a read-only JSON export without changing the source database", () => {
    const dataDir = tempDir("velvet-export-src-");
    const outDir = tempDir("velvet-export-out-");
    const databasePath = seed(dataDir);
    const before = sha256(databasePath);

    const result = spawnSync(process.execPath, [script, "--data-dir", dataDir, "--out", outDir], { encoding: "utf8", timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(sha256(databasePath)).toBe(before);

    const files = readdirSync(outDir).sort();
    const backups = files.filter((file) => /^velvet-backup-.+\.sqlite$/.test(file));
    const exports = files.filter((file) => /^velvet-export-.+\.json$/.test(file));
    expect(backups).toHaveLength(1);
    expect(exports).toHaveLength(1);

    const backup = new DatabaseDriver(path.join(outDir, backups[0]!), { readonly: true });
    try {
      expect(backup.prepare("SELECT id,name FROM legacy_campaigns ORDER BY id").all()).toEqual([{ id: "c1", name: "First" }, { id: "c2", name: "Second" }]);
      expect(backup.prepare("PRAGMA quick_check").pluck().get()).toBe("ok");
    } finally {
      backup.close();
    }

    const exported = JSON.parse(readFileSync(path.join(outDir, exports[0]!), "utf8"));
    expect(exported).toMatchObject({ format: "velvet-raw-export", version: 1 });
    expect(Object.keys(exported.tables).sort()).toEqual(["legacy_campaigns", "notes"]);
    expect(exported.tables.legacy_campaigns).toEqual([
      { id: "c1", name: "First", payload: '{"a":1}' },
      { id: "c2", name: "Second", payload: null },
    ]);
    expect(exported.tables.notes).toEqual([{ n: 7, body: { base64: "AP8=" } }]);
    expect(result.stdout).toContain(outDir);
  });

  it("fails clearly when there is no database and creates nothing", () => {
    const dataDir = tempDir("velvet-export-empty-");
    const outDir = path.join(tempDir("velvet-export-out-"), "nested");
    const result = spawnSync(process.execPath, [script, "--data-dir", dataDir, "--out", outDir], { encoding: "utf8", timeout: 60_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/velvet\.sqlite/);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("is exposed as the server db:export npm script", () => {
    const pkg = JSON.parse(readFileSync(path.join(serverDir, "package.json"), "utf8"));
    expect(pkg.scripts["db:export"]).toBe("node scripts/export-db.mjs");
  });
});
