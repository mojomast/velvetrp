// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
// Connection ownership lives here; schema and migration behavior is injected by db.ts.
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { systemRuntime } from "../../runtime.js";
import type { RuntimeDependencies } from "../../runtime.js";

const SQLITE_FILENAME = "velvet.sqlite";

type EnsureSchema = (db: DatabaseDriver.Database) => void;
type MigrateLegacyIfPresent = (db: DatabaseDriver.Database, dir: string, dependencies: RuntimeDependencies) => void;

let ensureSchema: EnsureSchema | null = null;
let migrateLegacyIfPresent: MigrateLegacyIfPresent | null = null;
let connection: { dir: string; db: DatabaseDriver.Database } | null = null;

export function configureDatabaseConnection(
  schemaEnsurer: EnsureSchema,
  legacyMigrator: MigrateLegacyIfPresent,
): void {
  ensureSchema = schemaEnsurer;
  migrateLegacyIfPresent = legacyMigrator;
}

export function resolveDataDir(): string {
  const override = process.env.VELVET_DATA_DIR;
  return path.resolve(override && override.trim() !== "" ? override : path.join(process.cwd(), "data"));
}

export function openRepositoryDatabase(dir: string, dependencies: RuntimeDependencies): DatabaseDriver.Database {
  if (!ensureSchema || !migrateLegacyIfPresent) throw new Error("repository database is not configured");
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort, matches previous behavior
  }
  const db = new DatabaseDriver(path.join(dir, SQLITE_FILENAME));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    ensureSchema(db);
    migrateLegacyIfPresent(db, dir, dependencies);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function getDb(): DatabaseDriver.Database {
  const dir = resolveDataDir();
  if (connection && connection.dir === dir) return connection.db;
  if (connection) {
    connection.db.close();
    connection = null;
  }
  const db = openRepositoryDatabase(dir, systemRuntime);
  connection = { dir, db };
  return db;
}

export function closeRepo(): void {
  if (connection) {
    connection.db.close();
    connection = null;
  }
}
