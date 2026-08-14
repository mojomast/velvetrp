import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { ensureCurrentSchema } from "./schema.js";

const SQLITE_FILENAME = "velvet.sqlite";

let connection: { dir: string; db: DatabaseDriver.Database } | null = null;

export function resolveDataDir(): string {
  const override = process.env.VELVET_DATA_DIR;
  return path.resolve(override && override.trim() !== "" ? override : path.join(process.cwd(), "data"));
}

function openOwnedRepositoryDatabase(dir: string, validateCurrentSchema: boolean): DatabaseDriver.Database {
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort, matches previous behavior
  }
  const databasePath = path.join(dir, SQLITE_FILENAME);
  const db = new DatabaseDriver(databasePath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    if (validateCurrentSchema) ensureCurrentSchema(db, databasePath);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function openRepositoryDatabase(dir: string): DatabaseDriver.Database {
  return openOwnedRepositoryDatabase(dir, true);
}

/** @internal Test fixture seam for exercising domain behavior against deliberate corruption. */
export function openRepositoryDatabaseForCorruptionTests(dir: string): DatabaseDriver.Database {
  return openOwnedRepositoryDatabase(dir, false);
}

export function getDb(): DatabaseDriver.Database {
  const dir = resolveDataDir();
  if (connection && connection.dir === dir) return connection.db;
  if (connection) {
    connection.db.close();
    connection = null;
  }
  const db = openRepositoryDatabase(dir);
  connection = { dir, db };
  return db;
}

export function closeRepo(): void {
  if (connection) {
    connection.db.close();
    connection = null;
  }
}
