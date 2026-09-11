import type DatabaseDriver from "better-sqlite3";

interface SchemaObject { type: string; name: string; tbl_name: string; sql: string }

/** Recognize only the exact predecessor, including the previously supported map predecessor. */
export function upgradeCampaignDmSchema(db: DatabaseDriver.Database, actual: SchemaObject[], expected: SchemaObject[], validate: () => void): boolean {
  const reviewPredecessor = expected.filter(object => !object.name.startsWith("dm_review_")).map(object => ({ ...object,
    sql: ["dm_control","dm_mode_commands","dm_runs"].includes(object.name) ? object.sql
      .replace("FOREIGN KEY(delegator) REFERENCES principals(id)", "FOREIGN KEY(campaign_id,delegator) REFERENCES campaign_memberships(campaign_id,principal_id)")
      .replace("FOREIGN KEY(principal_id) REFERENCES principals(id)", "FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id)")
      .replace("FOREIGN KEY(gm_principal_id) REFERENCES principals(id)", "FOREIGN KEY(campaign_id,gm_principal_id) REFERENCES campaign_memberships(campaign_id,principal_id)") : object.sql,
  }));
  const upgradeReview = JSON.stringify(actual) === JSON.stringify(reviewPredecessor)
    || JSON.stringify(actual) === JSON.stringify(reviewPredecessor.filter(object => !object.name.startsWith("dm_narration_")));
  const upgradeNarration = JSON.stringify(actual) === JSON.stringify(expected.filter(object => !object.name.startsWith("dm_narration_")));
  const upgradeComposition = JSON.stringify(actual) === JSON.stringify(expected.filter(object => object.name !== "dm_composition_receipts"));
  const additions = expected.filter(object => object.name.startsWith("dm_") && !actual.some(old => old.name===object.name));
  const previous = expected.filter(object => !object.name.startsWith("dm_"));
  const mapNames = new Set(["tactical_map_contexts_v2", "tactical_map_contexts_v2_update", "tactical_map_contexts_v2_delete"]);
  const oldMap = previous.filter(object => !mapNames.has(object.name)).map(object => ({ ...object,
    sql: object.name === "tactical_maps_v58" ? object.sql.replace(",'dungeon-v2','cave-v2','arena-v2'", "")
      : object.name === "tactical_map_previews_v58" ? object.sql.replace("  actor_location_revision INTEGER,\n", "") : object.sql,
  }));
  const upgradeMap = JSON.stringify(actual) === JSON.stringify(oldMap);
  if (!upgradeReview && !upgradeNarration && !upgradeMap && !upgradeComposition && JSON.stringify(actual) !== JSON.stringify(previous)) return false;
  if (db.inTransaction) throw new Error("DM upgrade requires an independent transaction");
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      if (upgradeReview) {
        for (const table of ["dm_control", "dm_mode_commands", "dm_runs"]) {
          const definition=expected.find(object=>object.name===table && object.type==='table')!;
          db.exec(`CREATE TEMP TABLE dm_upgrade_backup AS SELECT * FROM ${table}`);
          db.exec(`DROP TABLE ${table}`);db.exec(definition.sql);
          // Restore historical rows before recreating present-authority insert triggers.
          db.exec(`INSERT INTO ${table} SELECT * FROM dm_upgrade_backup`);db.exec("DROP TABLE dm_upgrade_backup");
          for(const object of expected.filter(object=>object.tbl_name===table && object.type!=='table' && !object.name.startsWith('dm_review_')))db.exec(object.sql);
        }
        db.prepare("UPDATE dm_runs SET state='cancelled',revision=revision+1,blockers_json='[\"director-security-upgrade-requires-new-beat\"]' WHERE state IN ('planning','awaiting-approval')").run();
      }
      if (upgradeMap) {
        for (const table of ["tactical_maps_v58", "tactical_map_previews_v58"]) {
          const definition = expected.find(object => object.type === "table" && object.name === table)!;
          const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name).join(",");
          db.exec(`CREATE TEMP TABLE dm_upgrade_backup AS SELECT * FROM ${table}`);
          db.exec(`DROP TABLE ${table}`); db.exec(definition.sql);
          db.exec(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM dm_upgrade_backup`);
          db.exec("DROP TABLE dm_upgrade_backup");
          for (const object of expected.filter(object => object.tbl_name === table && object.type !== "table")) db.exec(object.sql);
        }
        for (const object of expected.filter(object => mapNames.has(object.name))) db.exec(object.sql);
      }
      for (const object of additions.filter(object => object.type === "table")) db.exec(object.sql);
      for (const object of additions.filter(object => object.type !== "table")) db.exec(object.sql);
      if (!upgradeReview && !upgradeNarration && !upgradeComposition) db.prepare("INSERT INTO dm_control(campaign_id,mode,revision,delegator) SELECT id,'human',0,NULL FROM campaigns").run();
      validate();
    }).immediate();
    return true;
  } finally { db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`); }
}
