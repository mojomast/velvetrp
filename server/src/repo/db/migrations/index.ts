import type DatabaseDriver from "better-sqlite3";

/**
 * A single forward-only schema migration.
 *
 * Versions are strict and contiguous: the first migration after the baseline is
 * always `BASELINE_SCHEMA_VERSION + 1`, the next one is `+ 2`, and so on.
 * `PRAGMA user_version` records the database's current migration version.
 */
export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseDriver.Database): void;
}

/** Version of the schema created by the first release; `ensureCurrentSchema` writes it. */
export const BASELINE_SCHEMA_VERSION = 1;

/**
 * Append-only registry of migrations after the baseline.
 *
 * To add a migration:
 * 1. Append exactly one entry with `version` = the previous entry's version + 1
 *    (or `BASELINE_SCHEMA_VERSION + 1` for the first one) and a non-empty,
 *    descriptive `name`.
 * 2. Never edit, reorder, or remove a published entry: databases already
 *    stamped with that version will never run it again.
 * 3. Add a test that upgrades a fixture at every earlier version to the new one.
 *
 * The SQL in `up` must be safe to run inside a single immediate transaction and
 * must not change `PRAGMA user_version` itself; `applyMigrations` owns the stamp.
 */
export const MIGRATIONS: readonly Migration[] = [];

/** The schema version a fully migrated database reports. */
export const SCHEMA_VERSION = BASELINE_SCHEMA_VERSION + MIGRATIONS.length;

/** Throws unless `list` is exactly `BASELINE+1`, `BASELINE+2`, ... with non-empty names. */
export function validateMigrations(list: readonly Migration[]): void {
  list.forEach((migration, index) => {
    const expected = BASELINE_SCHEMA_VERSION + index + 1;
    if (migration.version !== expected) {
      throw new Error(`migration at position ${index + 1} must be version ${expected}, received ${migration.version}`);
    }
    if (typeof migration.name !== "string" || migration.name.trim() === "") {
      throw new Error(`migration v${migration.version} must have a non-empty name`);
    }
  });
}

export interface ApplyMigrationsOptions {
  databasePath: string;
}

export interface ApplyMigrationsResult {
  from: number;
  to: number;
  backups: string[];
}

function backupPath(databasePath: string, version: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${databasePath}.pre-v${version}-${stamp}.bak`;
}

function assertMigrationIntegrity(db: DatabaseDriver.Database): void {
  const quickCheck = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (quickCheck.length !== 1 || Object.values(quickCheck[0] ?? {})[0] !== "ok") {
    throw new Error("SQLite quick_check failed");
  }
  const foreignKeyIssue = db.prepare("PRAGMA foreign_key_check").get() as { table: string } | undefined;
  if (foreignKeyIssue) throw new Error(`foreign-key violation in ${foreignKeyIssue.table}`);
}

/**
 * Applies every migration newer than the database's stamped version, in order.
 *
 * Each migration runs in its own immediate transaction together with its
 * integrity checks and version stamp. Unless the database is in memory, a
 * `VACUUM INTO` backup is written beside it before the migration starts. On
 * failure the transaction rolls back, the error names the migration, and no
 * later migration is attempted.
 */
export function applyMigrations(
  db: DatabaseDriver.Database,
  list: readonly Migration[],
  { databasePath }: ApplyMigrationsOptions,
): ApplyMigrationsResult {
  validateMigrations(list);
  const from = db.pragma("user_version", { simple: true }) as number;
  const backups: string[] = [];
  let to = from;
  for (const migration of list) {
    if (migration.version <= from) continue;
    try {
      if (databasePath !== "" && databasePath !== ":memory:") {
        const backup = backupPath(databasePath, migration.version);
        const escaped = backup.replace(/'/g, "''");
        db.exec(`VACUUM INTO '${escaped}'`);
        backups.push(backup);
      }
      db.transaction(() => {
        migration.up(db);
        assertMigrationIntegrity(db);
        db.pragma(`user_version = ${migration.version}`);
      }).immediate();
      to = migration.version;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "migration failed";
      throw new Error(`Migration ${migration.name} (v${migration.version}) failed: ${reason}`, { cause: error });
    }
  }
  return { from, to, backups };
}
