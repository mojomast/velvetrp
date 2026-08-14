import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";

const currentSchemaSql = readFileSync(new URL("./currentSchema.sql", import.meta.url), "utf8");

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

let expectedSchemaObjects: SchemaObject[] | undefined;

class CurrentSchemaError extends Error {}

function schemaObjects(db: DatabaseDriver.Database): SchemaObject[] {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name`).all() as SchemaObject[];
}

function expectedObjects(): SchemaObject[] {
  if (expectedSchemaObjects) return expectedSchemaObjects;
  const canonical = new DatabaseDriver(":memory:");
  try {
    canonical.pragma("foreign_keys = ON");
    canonical.exec(currentSchemaSql);
    expectedSchemaObjects = schemaObjects(canonical);
    return expectedSchemaObjects;
  } finally {
    canonical.close();
  }
}

function mismatchReason(actual: SchemaObject[], expected: SchemaObject[]): string | null {
  const key = ({ type, name }: SchemaObject) => `${type}:${name}`;
  const actualByKey = new Map(actual.map((object) => [key(object), object]));
  const expectedByKey = new Map(expected.map((object) => [key(object), object]));
  const unexpected = actual.find((object) => !expectedByKey.has(key(object)));
  if (unexpected) return `unexpected ${unexpected.type} ${unexpected.name}`;
  const missing = expected.find((object) => !actualByKey.has(key(object)));
  if (missing) return `missing ${missing.type} ${missing.name}`;
  const modified = expected.find((object) => {
    const persisted = actualByKey.get(key(object));
    return persisted?.tbl_name !== object.tbl_name || persisted.sql !== object.sql;
  });
  return modified ? `modified ${modified.type} ${modified.name}` : null;
}

function schemaError(databasePath: string, reason: string): Error {
  return new CurrentSchemaError(
    `Database ${databasePath} does not match the current development schema (${reason}). ` +
    "Delete the local database and restart Velvet to recreate it.",
  );
}

function assertCurrentDatabase(db: DatabaseDriver.Database, databasePath: string): void {
  const reason = mismatchReason(schemaObjects(db), expectedObjects());
  if (reason) throw schemaError(databasePath, reason);

  const quickCheck = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (quickCheck.length !== 1 || Object.values(quickCheck[0] ?? {})[0] !== "ok") {
    throw schemaError(databasePath, "SQLite quick_check failed");
  }
  const foreignKeyIssue = db.prepare("PRAGMA foreign_key_check").get() as { table: string } | undefined;
  if (foreignKeyIssue) throw schemaError(databasePath, `foreign-key violation in ${foreignKeyIssue.table}`);

  const applicationOwnerCount = (db.prepare("SELECT count(*) count FROM application_owner WHERE singleton=1").get() as { count: number }).count;
  const localOwner = db.prepare("SELECT 1 FROM principals WHERE id='local-owner'").get();
  if (applicationOwnerCount !== 1 || !localOwner) throw schemaError(databasePath, "required local ownership data is missing");
  const modifierKinds = (db.prepare("SELECT modifier_kind FROM rpg_effect_modifier_vocabulary_v26 ORDER BY modifier_kind").all() as Array<{ modifier_kind: string }>)
    .map(({ modifier_kind }) => modifier_kind);
  const expectedModifierKinds = ["advantage", "flat", "immunity", "proficiency", "resistance", "vulnerability"];
  if (JSON.stringify(modifierKinds) !== JSON.stringify(expectedModifierKinds)) {
    throw schemaError(databasePath, "required effect modifier vocabulary is invalid");
  }
}

export function ensureCurrentSchema(db: DatabaseDriver.Database, databasePath: string): void {
  try {
    if (schemaObjects(db).length === 0) {
      db.transaction(() => {
        db.exec(currentSchemaSql);
        assertCurrentDatabase(db, databasePath);
      })();
      return;
    }
    assertCurrentDatabase(db, databasePath);
  } catch (error) {
    if (error instanceof CurrentSchemaError) throw error;
    const reason = error instanceof Error ? error.message : "SQLite validation failed";
    throw schemaError(databasePath, reason);
  }
}
