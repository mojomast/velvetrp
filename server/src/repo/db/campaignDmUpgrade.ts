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
  const upgradePlanningRounds = JSON.stringify(actual) === JSON.stringify(expected.filter(object => !object.name.startsWith("dm_planning_rounds")));
  // P5.3 transition beats: the receipt action CHECKs and two authority triggers changed, plus the world-time receipt table.
  const worldTimeNames = (name: string) => name.startsWith("dm_world_time_receipts");
  const transitionChanged = new Set(["dm_receipts","dm_composition_receipts","dm_receipts_authority","dm_composition_receipts_authority"]);
  const normalizeTransition = (objects: SchemaObject[]) => objects.map(object => transitionChanged.has(object.name)
    ? { ...object, sql: `<transition:${object.name}>` } : object);
  const upgradeTransition = JSON.stringify(normalizeTransition(actual))
    === JSON.stringify(normalizeTransition(expected.filter(object => !worldTimeNames(object.name))));
  // P5.7 completion headroom: reasoning models need more than 256/768 completion tokens, so three tables' CHECKs changed.
  const completionChanged = new Set(["dm_provider_requests", "dm_planning_rounds", "dm_narration_dispatches"]);
  const normalizeCompletion = (objects: SchemaObject[]) => objects.map(object => completionChanged.has(object.name)
    ? { ...object, sql: `<completion:${object.name}>` } : object);
  const upgradeCompletion = JSON.stringify(normalizeCompletion(actual)) === JSON.stringify(normalizeCompletion(expected));
  const additions = expected.filter(object => object.name.startsWith("dm_") && !actual.some(old => old.name===object.name));
  const previous = expected.filter(object => !object.name.startsWith("dm_"));
  const mapNames = new Set(["tactical_map_contexts_v2", "tactical_map_contexts_v2_update", "tactical_map_contexts_v2_delete"]);
  const oldMap = previous.filter(object => !mapNames.has(object.name)).map(object => ({ ...object,
    sql: object.name === "tactical_maps_v58" ? object.sql.replace(",'dungeon-v2','cave-v2','arena-v2','underwater-v1','underwater-v2'", "")
      : object.name === "tactical_map_previews_v58" ? object.sql.replace("  actor_location_revision INTEGER,\n", "") : object.sql,
  }));
  const upgradeMap = JSON.stringify(actual) === JSON.stringify(oldMap);
  if (!upgradeReview && !upgradeNarration && !upgradeMap && !upgradeComposition && !upgradePlanningRounds && !upgradeTransition && !upgradeCompletion
    && JSON.stringify(actual) !== JSON.stringify(previous)) return false;
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
      if (upgradeTransition) {
        for (const table of ["dm_receipts", "dm_composition_receipts"]) {
          const definition = expected.find(object => object.type === "table" && object.name === table)!;
          const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name).join(",");
          db.exec(`CREATE TEMP TABLE dm_upgrade_backup AS SELECT * FROM ${table}`);
          db.exec(`DROP TABLE ${table}`); db.exec(definition.sql);
          db.exec(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM dm_upgrade_backup`);
          db.exec("DROP TABLE dm_upgrade_backup");
          for (const object of expected.filter(object => object.tbl_name === table && object.type !== "table")) db.exec(object.sql);
        }
      }
      if (upgradeCompletion) {
        for (const table of ["dm_provider_requests", "dm_planning_rounds", "dm_narration_dispatches"]) {
          const definition = expected.find(object => object.type === "table" && object.name === table)!;
          const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name).join(",");
          db.exec(`CREATE TEMP TABLE dm_upgrade_backup AS SELECT * FROM ${table}`);
          db.exec(`DROP TABLE ${table}`); db.exec(definition.sql);
          db.exec(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM dm_upgrade_backup`);
          db.exec("DROP TABLE dm_upgrade_backup");
          for (const object of expected.filter(object => object.tbl_name === table && object.type !== "table")) db.exec(object.sql);
        }
      }
      for (const object of additions.filter(object => object.type === "table")) db.exec(object.sql);
      for (const object of additions.filter(object => object.type !== "table")) db.exec(object.sql);
      if (!upgradeReview && !upgradeNarration && !upgradeComposition && !upgradePlanningRounds && !upgradeTransition && !upgradeCompletion) db.prepare("INSERT INTO dm_control(campaign_id,mode,revision,delegator) SELECT id,'human',0,NULL FROM campaigns").run();
      validate();
    }).immediate();
    return true;
  } finally { db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`); }
}
