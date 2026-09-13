import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { upgradeTacticalMapSchema } from "../../map/schemaUpgrade.js";
import { upgradeCampaignDmSchema } from "./campaignDmUpgrade.js";

const currentSchemaSql = readFileSync(new URL("./currentSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./campaignDmSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./recallSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./contextInspectionProvenanceSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./npcKnowledgeSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./combatMarkerSchema.sql", import.meta.url), "utf8");

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

/** Upgrades only the complete schema whose grants source CHECK predates class starter kits. */
export function upgradeStartingGrantsSchema(
  db: DatabaseDriver.Database,
  actual: SchemaObject[],
  expected: SchemaObject[],
  validate: () => void,
): boolean {
  const grantsTable = "character_starting_grants_v19";
  const materializationsTable = "character_starter_materializations_v51";
  const predecessor = expected.map((object) => object.name === grantsTable && object.type === "table"
    ? { ...object, sql: object.sql.replace(
      "source IN ('background-kit','background-currency','class-starter-kit')",
      "source IN ('background-kit','background-currency')",
    ) }
    : object);
  if (JSON.stringify(actual) !== JSON.stringify(predecessor)) return false;
  if (db.inTransaction) throw new Error("starting grants upgrade requires an independent transaction");

  const affectedTables = new Set([grantsTable, materializationsTable]);
  const affected = expected.filter((object) => object.type !== "table" && (
    affectedTables.has(object.tbl_name) || object.sql.includes(grantsTable)
  ));
  const definition = (name: string) => expected.find((object) => object.type === "table" && object.name === name)!;
  db.transaction(() => {
    db.exec(`CREATE TEMP TABLE ${grantsTable}_upgrade AS SELECT * FROM ${grantsTable}`);
    db.exec(`CREATE TEMP TABLE ${materializationsTable}_upgrade AS SELECT * FROM ${materializationsTable}`);
    for (const object of affected) db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`);
    db.exec(`DROP TABLE ${materializationsTable}`);
    db.exec(`DROP TABLE ${grantsTable}`);
    db.exec(definition(grantsTable).sql);
    db.exec(definition(materializationsTable).sql);
    db.exec(`INSERT INTO ${grantsTable} SELECT * FROM ${grantsTable}_upgrade`);
    db.exec(`INSERT INTO ${materializationsTable} SELECT * FROM ${materializationsTable}_upgrade`);
    db.exec(`DROP TABLE ${grantsTable}_upgrade`);
    db.exec(`DROP TABLE ${materializationsTable}_upgrade`);
    for (const object of affected) db.exec(object.sql);
    validate();
  }).immediate();
  return true;
}

/** Upgrades only the complete schema that predates the combat marker table. */
export function upgradeCombatMarkerSchema(
  db: DatabaseDriver.Database,
  actual: SchemaObject[],
  expected: SchemaObject[],
  validate: () => void,
): boolean {
  const markerNames = new Set(["combat_markers_v64"]);
  const previous = expected.filter((object) => !markerNames.has(object.name));
  if (JSON.stringify(actual) !== JSON.stringify(previous)) return false;
  if (db.inTransaction) throw new Error("combat marker upgrade requires an independent transaction");
  db.transaction(() => {
    for (const object of expected.filter((object) => markerNames.has(object.name))) db.exec(object.sql);
    validate();
  }).immediate();
  return true;
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
    const recallSql = readFileSync(new URL("./recallSchema.sql", import.meta.url), "utf8");
    const inspectionSql = readFileSync(new URL("./contextInspectionProvenanceSchema.sql", import.meta.url), "utf8");
    const knowledgeSql = readFileSync(new URL("./npcKnowledgeSchema.sql", import.meta.url), "utf8");
    const markerSql = readFileSync(new URL("./combatMarkerSchema.sql", import.meta.url), "utf8");
    const prior = expectedObjects().filter(object => !object.name.startsWith("adventure_narration_contexts")
      && !object.name.startsWith("campaign_context_inspection_") && !object.name.startsWith("agent_observations")
      && !object.name.startsWith("combat_markers_"));
    const finishRecallUpgrade = () => {
      db.exec(recallSql);
      db.exec(inspectionSql);
      db.exec(knowledgeSql);
      db.exec(markerSql);
      assertCurrentDatabase(db, databasePath);
    };
    if (mismatchReason(schemaObjects(db), prior) === null) {
      db.transaction(finishRecallUpgrade).immediate();
      return;
    }
    const missingRecall = !schemaObjects(db).some(object => object.name === "adventure_narration_contexts");
    const missingInspection = !schemaObjects(db).some(object => object.name === "campaign_context_inspection_headers_v61");
    const missingKnowledge = !schemaObjects(db).some(object => object.name.startsWith("agent_observations"));
    const missingMarkers = !schemaObjects(db).some(object => object.name.startsWith("combat_markers_"));
    const expected = missingRecall ? prior : expectedObjects().filter(object =>
      (missingInspection ? !object.name.startsWith("campaign_context_inspection_") : true)
      && (missingKnowledge ? !object.name.startsWith("agent_observations") : true)
      && (missingMarkers ? !object.name.startsWith("combat_markers_") : true));
    const validate = missingRecall ? finishRecallUpgrade : () => assertCurrentDatabase(db, databasePath);
    if (!missingRecall && missingInspection && mismatchReason(schemaObjects(db), expected) === null) {
      db.transaction(() => {
        db.exec(inspectionSql);
        if (missingKnowledge) db.exec(knowledgeSql);
        if (missingMarkers) db.exec(markerSql);
        assertCurrentDatabase(db, databasePath);
      }).immediate();
      return;
    }
    if (!missingRecall && !missingInspection && missingKnowledge && mismatchReason(schemaObjects(db), expected) === null) {
      db.transaction(() => {
        db.exec(knowledgeSql);
        if (missingMarkers) db.exec(markerSql);
        assertCurrentDatabase(db, databasePath);
      }).immediate();
      return;
    }
    if (!missingRecall && !missingInspection && !missingKnowledge && missingMarkers && mismatchReason(schemaObjects(db), expected) === null) {
      db.transaction(() => { db.exec(markerSql); assertCurrentDatabase(db, databasePath); }).immediate();
      return;
    }
    if (!upgradeStartingGrantsSchema(db, schemaObjects(db), expected, validate)
      && !upgradeCampaignDmSchema(db, schemaObjects(db), expected, validate)
      && !upgradeTacticalMapSchema(db, schemaObjects(db), expected, validate)
      && !upgradeCombatMarkerSchema(db, schemaObjects(db), expected, validate)) {
      assertCurrentDatabase(db, databasePath);
    }
  } catch (error) {
    if (error instanceof CurrentSchemaError) throw error;
    const reason = error instanceof Error ? error.message : "SQLite validation failed";
    throw schemaError(databasePath, reason);
  }
}
