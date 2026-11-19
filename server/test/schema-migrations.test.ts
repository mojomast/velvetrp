import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openRepositoryDatabase } from "../src/repo/db/connection.js";
import {
  BASELINE_SCHEMA_VERSION, MIGRATIONS, SCHEMA_VERSION, applyMigrations, validateMigrations, type Migration,
} from "../src/repo/db/migrations/index.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "velvet-migrations-"));
  dirs.push(dir);
  return dir;
}
const userVersion = (db: DatabaseDriver.Database) => db.pragma("user_version", { simple: true }) as number;

function toyDatabase(dir: string, version: number): { db: DatabaseDriver.Database; databasePath: string } {
  const databasePath = path.join(dir, "toy.sqlite");
  const db = new DatabaseDriver(databasePath);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE t(a TEXT); INSERT INTO parent VALUES('p'); INSERT INTO t VALUES('kept');");
  db.pragma(`user_version = ${version}`);
  return { db, databasePath };
}

describe("schema version registry", () => {
  it("starts at the v1 baseline with a contiguous forward-only list", () => {
    expect(BASELINE_SCHEMA_VERSION).toBe(1);
    expect(SCHEMA_VERSION).toBe(BASELINE_SCHEMA_VERSION + MIGRATIONS.length);
    expect(() => validateMigrations(MIGRATIONS)).not.toThrow();
    MIGRATIONS.forEach((migration, index) => expect(migration.version).toBe(BASELINE_SCHEMA_VERSION + index + 1));
  });

  it("rejects gaps, duplicates, out-of-order and baseline-or-lower versions", () => {
    const up = () => undefined;
    expect(() => validateMigrations([{ version: 3, name: "gap", up }])).toThrow();
    expect(() => validateMigrations([{ version: 2, name: "a", up }, { version: 2, name: "b", up }])).toThrow();
    expect(() => validateMigrations([{ version: 3, name: "a", up }, { version: 2, name: "b", up }])).toThrow();
    expect(() => validateMigrations([{ version: 1, name: "baseline", up }])).toThrow();
    expect(() => validateMigrations([{ version: 2, name: "", up }])).toThrow();
  });
});

describe("applyMigrations", () => {
  const addB: Migration = { version: 2, name: "add-b", up: (db) => db.exec("ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'b'") };
  const addC: Migration = { version: 3, name: "add-c", up: (db) => db.exec("ALTER TABLE t ADD COLUMN c TEXT") };

  it("runs pending migrations in order, stamps each version and keeps a backup before each one", () => {
    const dir = tempDir();
    const { db, databasePath } = toyDatabase(dir, 1);
    try {
      const result = applyMigrations(db, [addB, addC], { databasePath });
      expect(result).toMatchObject({ from: 1, to: 3 });
      expect(result.backups).toHaveLength(2);
      expect(userVersion(db)).toBe(3);
      expect(db.prepare("SELECT a,b,c FROM t").all()).toEqual([{ a: "kept", b: "b", c: null }]);
      for (const backup of result.backups) {
        expect(existsSync(backup)).toBe(true);
        expect(path.dirname(backup)).toBe(dir);
      }
      const first = new DatabaseDriver(result.backups[0]!, { readonly: true });
      try {
        expect(userVersion(first)).toBe(1);
        expect(first.prepare("SELECT * FROM t").all()).toEqual([{ a: "kept" }]);
      } finally {
        first.close();
      }
    } finally {
      db.close();
    }
  });

  it("skips migrations at or below the current version and does nothing when up to date", () => {
    const dir = tempDir();
    const { db, databasePath } = toyDatabase(dir, 3);
    try {
      expect(applyMigrations(db, [addB, addC], { databasePath })).toEqual({ from: 3, to: 3, backups: [] });
      expect(readdirSync(dir)).toEqual(["toy.sqlite"]);
    } finally {
      db.close();
    }
  });

  it("rolls back a failing migration, keeps earlier ones and names the failure", () => {
    const dir = tempDir();
    const { db, databasePath } = toyDatabase(dir, 1);
    const broken: Migration = { version: 3, name: "broken-step", up: (database) => { database.exec("ALTER TABLE t ADD COLUMN c TEXT"); throw new Error("boom"); } };
    try {
      expect(() => applyMigrations(db, [addB, broken], { databasePath })).toThrow(/broken-step/);
      expect(userVersion(db)).toBe(2);
      const columns = (db.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toEqual(["a", "b"]);
    } finally {
      db.close();
    }
  });

  it("rejects a migration that leaves a foreign-key violation", () => {
    const dir = tempDir();
    const { db, databasePath } = toyDatabase(dir, 1);
    const orphan: Migration = { version: 2, name: "orphan-child", up: (database) => {
      database.exec("CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))");
      database.pragma("defer_foreign_keys = ON");
      database.exec("INSERT INTO child VALUES('c','missing')");
    } };
    try {
      expect(() => applyMigrations(db, [orphan], { databasePath })).toThrow(/orphan-child/);
      expect(userVersion(db)).toBe(1);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='child'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("repository database versioning", () => {
  it("stamps a fresh database with the current schema version", () => {
    const dir = tempDir();
    const db = openRepositoryDatabase(dir);
    try {
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("stamps an unstamped current-schema database once and keeps its data", () => {
    const dir = tempDir();
    let db = openRepositoryDatabase(dir);
    db.pragma("user_version = 0");
    db.exec("CREATE TEMP TABLE marker(x)");
    const owners = db.prepare("SELECT count(*) count FROM principals").get();
    db.close();
    db = openRepositoryDatabase(dir);
    try {
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
      expect(db.prepare("SELECT count(*) count FROM principals").get()).toEqual(owners);
    } finally {
      db.close();
    }
  });

  it("refuses a database stamped by a newer Velvet and leaves it unchanged", () => {
    const dir = tempDir();
    let db = openRepositoryDatabase(dir);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openRepositoryDatabase(dir)).toThrow(/newer/);
    db = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    try {
      expect(userVersion(db)).toBe(SCHEMA_VERSION + 1);
    } finally {
      db.close();
    }
  });
});
