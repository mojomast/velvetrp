import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { upgradeTacticalMapSchema } from "../../map/schemaUpgrade.js";
import { upgradeCampaignDmSchema } from "./campaignDmUpgrade.js";

/**
 * The exact turn-economy update guard published before Dash could extend the
 * persisted movement allowance. A database carrying this trigger is upgraded
 * in place to the guard that permits allowance increases.
 */
export const TURN_ECONOMY_GUARD_PREDECESSOR_SQL = `CREATE TRIGGER combat_turn_economy_v60_guard BEFORE UPDATE ON combat_turn_economy_v60
      WHEN NEW.turn_id<>OLD.turn_id OR NEW.encounter_id<>OLD.encounter_id OR NEW.combatant_id<>OLD.combatant_id
        OR NEW.round_number<>OLD.round_number OR NEW.started_at<>OLD.started_at
        OR NEW.action_used<OLD.action_used OR NEW.bonus_action_used<OLD.bonus_action_used
        OR NEW.reaction_used<OLD.reaction_used OR NEW.movement_allowance_feet<>OLD.movement_allowance_feet
        OR NEW.movement_used_feet<OLD.movement_used_feet OR OLD.ended_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'combat turn economy may only consume resources or end'); END`;

/**
 * The current combat-condition CHECK widened to the full fifteen-name SRD 5.1
 * vocabulary, and the exact predecessor that predates the four added names.
 */
export const COMBAT_CONDITIONS_CHECK =
  "CHECK(condition IN ('blinded','charmed','deafened','frightened','grappled','incapacitated','invisible','paralyzed','petrified','poisoned','prone','restrained','stunned','unconscious'))";
export const COMBAT_CONDITIONS_PREDECESSOR_CHECK =
  "CHECK(condition IN ('blinded','charmed','frightened','grappled','incapacitated','poisoned','prone','restrained','stunned','unconscious'))";

/**
 * The catalog definition kind CHECK widened with the optional advancement
 * definition kinds, and its exact predecessor that predates them.
 */
export const CATALOG_DEFINITION_KINDS_CHECK =
  "CHECK (kind IN ('race','background','class','class-level','skill','ability','spell','item','currency','enemy-template','feat','subclass'))";
export const CATALOG_DEFINITION_KINDS_PREDECESSOR_CHECK =
  "CHECK (kind IN ('race','background','class','class-level','skill','ability','spell','item','currency','enemy-template'))";

/**
 * The catalog publication-attestation definition-count CHECK widened for full
 * SRD 5.1 parity, and its exact predecessor that capped at 1024.
 */
export const CATALOG_ATTESTATION_LIMIT_CHECK =
  "CHECK (typeof(definition_count)='integer' AND definition_count BETWEEN 1 AND 4096)";
export const CATALOG_ATTESTATION_LIMIT_PREDECESSOR_CHECK =
  "CHECK (typeof(definition_count)='integer' AND definition_count BETWEEN 1 AND 1024)";

/** Objects added by the durable character known-option table. */
export const CHARACTER_KNOWN_OPTIONS_OBJECT_NAMES: ReadonlySet<string> = new Set([
  "character_known_options_v25",
  "character_known_options_v25_immutable_update",
  "character_known_options_v25_immutable_delete",
]);

/**
 * The exact campaign-deletion cleanup trigger published before it also released
 * the pinned catalog definitions that restrict deletion. A database carrying
 * this trigger is upgraded in place.
 */
export const CAMPAIGN_DELETE_TRIGGER_PREDECESSOR_SQL = `CREATE TRIGGER campaigns_delete_character_drafts_v20 BEFORE DELETE ON campaigns
      BEGIN
        INSERT INTO character_draft_campaign_deletions_v20(campaign_id) VALUES (OLD.id);
        DELETE FROM character_starting_grants_v19 WHERE draft_id IN (SELECT id FROM character_drafts_v19 WHERE campaign_id=OLD.id);
        DELETE FROM character_derived_snapshots_v19 WHERE campaign_id=OLD.id;
        DELETE FROM character_draft_revisions_v19 WHERE draft_id IN (SELECT id FROM character_drafts_v19 WHERE campaign_id=OLD.id);
        DELETE FROM character_draft_receipts_v19 WHERE draft_id IN (SELECT id FROM character_drafts_v19 WHERE campaign_id=OLD.id);
        DELETE FROM character_draft_events_v19 WHERE draft_id IN (SELECT id FROM character_drafts_v19 WHERE campaign_id=OLD.id);
        DELETE FROM character_draft_command_provenance_v20 WHERE campaign_id=OLD.id;
        DELETE FROM character_draft_commands_v19 WHERE campaign_id=OLD.id;
        DELETE FROM character_draft_pins_v19 WHERE draft_id IN (SELECT id FROM character_drafts_v19 WHERE campaign_id=OLD.id);
        DELETE FROM character_drafts_v19 WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_receipts WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_events WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_command_provenance_v18 WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_commands WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_current_pins WHERE campaign_id=OLD.id;
        DELETE FROM campaign_catalog_current_selections WHERE campaign_id=OLD.id;
        DELETE FROM campaign_content_catalog_pins WHERE campaign_id=OLD.id;
        DELETE FROM campaign_content_catalog_selections WHERE campaign_id=OLD.id;
      END`;

const currentSchemaSql = readFileSync(new URL("./currentSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./campaignDmSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./recallSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./contextInspectionProvenanceSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./npcKnowledgeSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./combatMarkerSchema.sql", import.meta.url), "utf8")
  + "\n" + readFileSync(new URL("./attunementSchema.sql", import.meta.url), "utf8");

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

/** Upgrades only the complete schema whose combat condition CHECK predates the four added SRD conditions. */
export function upgradeCombatConditionsSchema(
  db: DatabaseDriver.Database,
  actual: SchemaObject[],
  expected: SchemaObject[],
  validate: () => void,
): boolean {
  const conditionsTable = "combat_conditions_v62";
  const predecessor = expected.map((object) => object.name === conditionsTable && object.type === "table"
    ? { ...object, sql: object.sql.replace(COMBAT_CONDITIONS_CHECK, COMBAT_CONDITIONS_PREDECESSOR_CHECK) }
    : object);
  if (JSON.stringify(actual) !== JSON.stringify(predecessor)) return false;
  if (db.inTransaction) throw new Error("combat conditions upgrade requires an independent transaction");

  const definition = expected.find((object) => object.type === "table" && object.name === conditionsTable)!;
  db.transaction(() => {
    db.exec(`CREATE TEMP TABLE ${conditionsTable}_upgrade AS SELECT * FROM ${conditionsTable}`);
    db.exec(`DROP TABLE ${conditionsTable}`);
    db.exec(definition.sql);
    db.exec(`INSERT INTO ${conditionsTable} SELECT * FROM ${conditionsTable}_upgrade`);
    db.exec(`DROP TABLE ${conditionsTable}_upgrade`);
    validate();
  }).immediate();
  return true;
}

/**
 * Upgrades only the complete schema that predates feat/subclass catalog
 * definitions and the durable character option table. The catalog definition
 * kind CHECK is widened in place and the additive option table is created, so
 * pre-existing publications and characters upgrade without data loss.
 */
export function upgradeAdvancementCatalogSchema(
  db: DatabaseDriver.Database,
  actual: SchemaObject[],
  expected: SchemaObject[],
  validate: () => void,
): boolean {
  const definitionsTable = "rpg_catalog_definitions";
  const predecessor = expected
    .filter((object) => !CHARACTER_KNOWN_OPTIONS_OBJECT_NAMES.has(object.name))
    .map((object) => object.name === definitionsTable && object.type === "table"
      ? { ...object, sql: object.sql.replace(CATALOG_DEFINITION_KINDS_CHECK, CATALOG_DEFINITION_KINDS_PREDECESSOR_CHECK) }
      : object);
  if (JSON.stringify(actual) !== JSON.stringify(predecessor)) return false;
  if (db.inTransaction) throw new Error("advancement catalog upgrade requires an independent transaction");
  const definition = expected.find((object) => object.type === "table" && object.name === definitionsTable)!;
  const definitionObjects = expected.filter((object) => object.type !== "table" && object.tbl_name === definitionsTable);
  const optionObjects = expected.filter((object) => CHARACTER_KNOWN_OPTIONS_OBJECT_NAMES.has(object.name));
  const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`CREATE TEMP TABLE ${definitionsTable}_upgrade AS SELECT * FROM ${definitionsTable}`);
      db.exec(`DROP TABLE ${definitionsTable}`);
      db.exec(definition.sql);
      db.exec(`INSERT INTO ${definitionsTable} SELECT * FROM ${definitionsTable}_upgrade`);
      db.exec(`DROP TABLE ${definitionsTable}_upgrade`);
      for (const object of definitionObjects) db.exec(object.sql);
      for (const object of optionObjects) db.exec(object.sql);
      if (db.prepare("PRAGMA foreign_key_check").get()) throw new Error("advancement catalog upgrade violates foreign keys");
      validate();
    }).immediate();
    return true;
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

/**
 * Upgrades only the complete schema whose catalog publication-attestation
 * definition-count CHECK predates the widened parity limit. The table is
 * rebuilt with the new CHECK and its immutability/validation triggers are
 * recreated, so pre-existing publications upgrade without data loss.
 */
export function upgradeCatalogAttestationLimitSchema(
  db: DatabaseDriver.Database,
  actual: SchemaObject[],
  expected: SchemaObject[],
  validate: () => void,
): boolean {
  const table = "rpg_catalog_publication_attestations";
  const predecessor = expected.map((object) => object.name === table && object.type === "table"
    ? { ...object, sql: object.sql.replace(CATALOG_ATTESTATION_LIMIT_CHECK, CATALOG_ATTESTATION_LIMIT_PREDECESSOR_CHECK) }
    : object);
  if (JSON.stringify(actual) !== JSON.stringify(predecessor)) return false;
  if (db.inTransaction) throw new Error("catalog attestation limit upgrade requires an independent transaction");
  const definition = expected.find((object) => object.type === "table" && object.name === table)!;
  const tableObjects = expected.filter((object) => object.type !== "table" && object.tbl_name === table);
  db.transaction(() => {
    db.exec(`CREATE TEMP TABLE ${table}_upgrade AS SELECT * FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(definition.sql);
    db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_upgrade`);
    db.exec(`DROP TABLE ${table}_upgrade`);
    for (const object of tableObjects) db.exec(object.sql);
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
    // Exact-predecessor trigger upgrade: only the known pre-Dash guard is replaced.
    const guardSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='combat_turn_economy_v60_guard'").get() as { sql: string } | undefined)?.sql;
    if (guardSql === TURN_ECONOMY_GUARD_PREDECESSOR_SQL) {
      const upgraded = expectedObjects().find((object) => object.name === "combat_turn_economy_v60_guard");
      if (upgraded) db.transaction(() => {
        db.exec("DROP TRIGGER combat_turn_economy_v60_guard");
        db.exec(upgraded.sql);
      }).immediate();
    }
    // Exact-predecessor trigger upgrade: only the known campaign-deletion cleanup trigger is replaced.
    const deleteTriggerSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='campaigns_delete_character_drafts_v20'").get() as { sql: string } | undefined)?.sql;
    if (deleteTriggerSql === CAMPAIGN_DELETE_TRIGGER_PREDECESSOR_SQL) {
      const upgraded = expectedObjects().find((object) => object.name === "campaigns_delete_character_drafts_v20");
      if (upgraded) db.transaction(() => {
        db.exec("DROP TRIGGER campaigns_delete_character_drafts_v20");
        db.exec(upgraded.sql);
      }).immediate();
    }
    const recallSql = readFileSync(new URL("./recallSchema.sql", import.meta.url), "utf8");
    const inspectionSql = readFileSync(new URL("./contextInspectionProvenanceSchema.sql", import.meta.url), "utf8");
    const knowledgeSql = readFileSync(new URL("./npcKnowledgeSchema.sql", import.meta.url), "utf8");
    const markerSql = readFileSync(new URL("./combatMarkerSchema.sql", import.meta.url), "utf8");
    const attunementSql = readFileSync(new URL("./attunementSchema.sql", import.meta.url), "utf8");
    const actual = schemaObjects(db);
    const missingRecall = !actual.some(object => object.name === "adventure_narration_contexts");
    const missingInspection = !actual.some(object => object.name === "campaign_context_inspection_headers_v61");
    const missingKnowledge = !actual.some(object => object.name.startsWith("agent_observations"));
    const missingMarkers = !actual.some(object => object.name.startsWith("combat_markers_"));
    const missingAttunements = !actual.some(object => object.name.startsWith("actor_item_attunements_"));
    const missingLateSchema = missingRecall || missingInspection || missingKnowledge || missingMarkers || missingAttunements;
    const expected = expectedObjects().filter(object =>
      !(missingRecall && object.name.startsWith("adventure_narration_contexts"))
      && !(missingInspection && object.name.startsWith("campaign_context_inspection_"))
      && !(missingKnowledge && object.name.startsWith("agent_observations"))
      && !(missingMarkers && object.name.startsWith("combat_markers_"))
      && !(missingAttunements && object.name.startsWith("actor_item_attunements_")));
    if (mismatchReason(actual, expected) === null) {
      if (!missingLateSchema) {
        assertCurrentDatabase(db, databasePath);
        return;
      }
      db.transaction(() => {
        if (missingRecall) db.exec(recallSql);
        if (missingInspection) db.exec(inspectionSql);
        if (missingKnowledge) db.exec(knowledgeSql);
        if (missingMarkers) db.exec(markerSql);
        if (missingAttunements) db.exec(attunementSql);
        assertCurrentDatabase(db, databasePath);
      }).immediate();
      return;
    }
    const validate = () => assertCurrentDatabase(db, databasePath);
    if (!upgradeStartingGrantsSchema(db, schemaObjects(db), expected, validate)
      && !upgradeCampaignDmSchema(db, schemaObjects(db), expected, validate)
      && !upgradeTacticalMapSchema(db, schemaObjects(db), expected, validate)
      && !upgradeCombatMarkerSchema(db, schemaObjects(db), expected, validate)
      && !upgradeCombatConditionsSchema(db, schemaObjects(db), expected, validate)
      && !upgradeAdvancementCatalogSchema(db, schemaObjects(db), expected, validate)
      && !upgradeCatalogAttestationLimitSchema(db, schemaObjects(db), expected, validate)) {
      assertCurrentDatabase(db, databasePath);
    }
  } catch (error) {
    if (error instanceof CurrentSchemaError) throw error;
    const reason = error instanceof Error ? error.message : "SQLite validation failed";
    throw schemaError(databasePath, reason);
  }
}
