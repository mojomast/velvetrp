import type DatabaseDriver from "better-sqlite3";

let databaseProvider: (() => DatabaseDriver.Database) | null = null;

/** Connects legacy domain functions to db.ts without exposing database access. */
export function configureRepositoryDatabase(provider: () => DatabaseDriver.Database): void {
  databaseProvider = provider;
}

export function getRepositoryDatabase(): DatabaseDriver.Database {
  if (!databaseProvider) throw new Error("repository database is not configured");
  return databaseProvider();
}
