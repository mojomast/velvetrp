import type DatabaseDriver from "better-sqlite3";

interface SchemaObject { type: string; name: string; tbl_name: string; sql: string }

/** Upgrade only the exact pre-grounding schema; never repair arbitrary or partially migrated stores. */
export function upgradeTacticalMapSchema(db: DatabaseDriver.Database, actual: SchemaObject[], expected: SchemaObject[], validate: () => void): boolean {
  const contextNames = new Set(["tactical_map_contexts_v2", "tactical_map_contexts_v2_update", "tactical_map_contexts_v2_delete"]);
  const previous = expected.filter((object) => !contextNames.has(object.name)).map((object) => ({ ...object,
    sql: object.name === "tactical_maps_v58" ? object.sql.replace(",'dungeon-v2','cave-v2','arena-v2','underwater-v1','underwater-v2'", "")
      : object.name === "tactical_map_previews_v58" ? object.sql.replace("  actor_location_revision INTEGER,\n", "") : object.sql,
  }));
  if (JSON.stringify(actual) !== JSON.stringify(previous)) return false;
  const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  if (db.inTransaction) throw new Error("map schema upgrade requires an independent transaction");
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const table of ["tactical_maps_v58", "tactical_map_previews_v58"]) {
        const definition = expected.find((object) => object.type === "table" && object.name === table)!;
        const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name).join(",");
        db.exec(`CREATE TEMP TABLE map_upgrade_backup AS SELECT * FROM ${table}`);
        db.exec(`DROP TABLE ${table}`);
        db.exec(definition.sql);
        db.exec(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM map_upgrade_backup`);
        db.exec("DROP TABLE map_upgrade_backup");
        for (const object of expected.filter((object) => object.tbl_name === table && object.type !== "table")) db.exec(object.sql);
      }
      for (const object of expected.filter((object) => contextNames.has(object.name))) db.exec(object.sql);
      if (db.prepare("PRAGMA foreign_key_check").get()) throw new Error("map schema upgrade violates foreign keys");
      // Startup validation must succeed before any schema or data changes become durable.
      validate();
    }).immediate();
    return true;
  } finally { db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`); }
}
