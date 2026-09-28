import type DatabaseDriver from "better-sqlite3";

interface SchemaObject { type: string; name: string; tbl_name: string; sql: string }

/**
 * The exact narrative command/event CHECKs published before faction relations and
 * faction memberships became first-class narrative commands, plus the relation
 * table those commands write. A database carrying the predecessor (and no
 * `campaign_faction_relations_v32`) is upgraded in place; every other unknown or
 * partially modified schema is refused.
 */
export const FACTION_COMMAND_KINDS_PREDECESSOR_CHECK =
  "CHECK(command_type IN ('create_npc','change_npc_relationship','create_faction','change_faction_reputation'))";
export const FACTION_COMMAND_KINDS_CHECK =
  "CHECK(command_type IN ('create_npc','change_npc_relationship','create_faction','change_faction_reputation','set_faction_relation','set_actor_faction_membership','set_npc_faction_membership'))";
export const FACTION_EVENT_KINDS_PREDECESSOR_CHECK =
  "CHECK(event_type IN ('npc_created','npc_relationship_changed','faction_created','faction_reputation_changed'))";
export const FACTION_EVENT_KINDS_CHECK =
  "CHECK(event_type IN ('npc_created','npc_relationship_changed','faction_created','faction_reputation_changed','faction_relation_changed','actor_faction_membership_changed','npc_faction_membership_changed'))";

/**
 * Upgrades only the complete schema whose narrative command/event CHECKs predate
 * faction relations and memberships. Both narrative tables are rebuilt in place to
 * widen their closed CHECKs, their immutability triggers are recreated, and the new
 * relation table is created; existing commands, receipts, events, and faction
 * reputation rows are preserved. The rebuild runs without foreign keys and verifies
 * `foreign_key_check` before commit.
 */
export function upgradeFactionRelationsSchema(
  db: DatabaseDriver.Database,
  actual: SchemaObject[],
  expected: SchemaObject[],
  validate: () => void,
): boolean {
  const commandsTable = "world_narrative_commands_v32";
  const eventsTable = "world_narrative_events_v32";
  const relationsTable = "campaign_faction_relations_v32";
  const predecessor = expected.filter((object) => object.name !== relationsTable).map((object) => {
    if (object.type !== "table" || object.name === commandsTable) {
      return object.name === commandsTable ? { ...object, sql: object.sql.replace(FACTION_COMMAND_KINDS_CHECK, FACTION_COMMAND_KINDS_PREDECESSOR_CHECK) } : object;
    }
    if (object.name === eventsTable) return { ...object, sql: object.sql.replace(FACTION_EVENT_KINDS_CHECK, FACTION_EVENT_KINDS_PREDECESSOR_CHECK) };
    return object;
  });
  if (JSON.stringify(actual) !== JSON.stringify(predecessor)) return false;
  if (db.inTransaction) throw new Error("faction membership and relation upgrade requires an independent transaction");
  const commandsDefinition = expected.find((object) => object.type === "table" && object.name === commandsTable)!;
  const eventsDefinition = expected.find((object) => object.type === "table" && object.name === eventsTable)!;
  const relationsDefinition = expected.find((object) => object.type === "table" && object.name === relationsTable)!;
  const commandObjects = expected.filter((object) => object.type !== "table" && object.tbl_name === commandsTable);
  const eventObjects = expected.filter((object) => object.type !== "table" && object.tbl_name === eventsTable);
  const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const [table, definition, objects] of [
        [commandsTable, commandsDefinition, commandObjects],
        [eventsTable, eventsDefinition, eventObjects],
      ] as const) {
        db.exec(`CREATE TEMP TABLE ${table}_upgrade AS SELECT * FROM ${table}`);
        db.exec(`DROP TABLE ${table}`);
        db.exec(definition.sql);
        db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_upgrade`);
        db.exec(`DROP TABLE ${table}_upgrade`);
        for (const object of objects) db.exec(object.sql);
      }
      db.exec(relationsDefinition.sql);
      if (db.prepare("PRAGMA foreign_key_check").get()) throw new Error("faction membership and relation upgrade violates foreign keys");
      validate();
    }).immediate();
    return true;
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}
