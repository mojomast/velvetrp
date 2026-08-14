import type DatabaseDriver from "better-sqlite3";

/**
 * Additive settlement/placement provenance for starter grants, combat rewards,
 * and the optional campaign starting location. The business rows remain in
 * their existing authoritative stores; these tables make exact-once linkage
 * explicit without changing historical schemas.
 */
export function createGrantsRewardsPlacementV51(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE character_starter_materializations_v51 (
      draft_id TEXT NOT NULL, grant_position INTEGER NOT NULL,
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      materialization_kind TEXT NOT NULL CHECK(materialization_kind IN ('inventory','wallet')),
      materialized_resource_id TEXT NOT NULL,
      materialized_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',materialized_at)=materialized_at),
      PRIMARY KEY(draft_id,grant_position), UNIQUE(materialization_kind,materialized_resource_id),
      FOREIGN KEY(draft_id,grant_position) REFERENCES character_starting_grants_v19(draft_id,position) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT
    );
    CREATE TABLE combat_reward_settlements_v51 (
      reward_bundle_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, encounter_id TEXT NOT NULL,
      recipient_actor_id TEXT NOT NULL, reward_claim_id TEXT NOT NULL UNIQUE,
      settled_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',settled_at)=settled_at),
      FOREIGN KEY(campaign_id,reward_bundle_id) REFERENCES reward_bundle(campaign_id,reward_bundle_id) ON DELETE RESTRICT,
      FOREIGN KEY(reward_claim_id) REFERENCES reward_claim_v27(reward_claim_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,recipient_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT
    );
    CREATE TABLE campaign_starting_locations_v51 (
      campaign_id TEXT PRIMARY KEY, location_id TEXT NOT NULL,
      designated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',designated_at)=designated_at),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT
    );
    CREATE TRIGGER character_starter_materializations_v51_immutable_update BEFORE UPDATE ON character_starter_materializations_v51 BEGIN SELECT RAISE(ABORT,'starter materializations are immutable'); END;
    CREATE TRIGGER character_starter_materializations_v51_immutable_delete BEFORE DELETE ON character_starter_materializations_v51 BEGIN SELECT RAISE(ABORT,'starter materializations are immutable'); END;
    CREATE TRIGGER combat_reward_settlements_v51_immutable_update BEFORE UPDATE ON combat_reward_settlements_v51 BEGIN SELECT RAISE(ABORT,'combat reward settlements are immutable'); END;
    CREATE TRIGGER combat_reward_settlements_v51_immutable_delete BEFORE DELETE ON combat_reward_settlements_v51 BEGIN SELECT RAISE(ABORT,'combat reward settlements are immutable'); END;
    CREATE TRIGGER campaign_starting_locations_v51_immutable_update BEFORE UPDATE ON campaign_starting_locations_v51 BEGIN SELECT RAISE(ABORT,'campaign starting locations are immutable'); END;
    CREATE TRIGGER campaign_starting_locations_v51_immutable_delete BEFORE DELETE ON campaign_starting_locations_v51 BEGIN SELECT RAISE(ABORT,'campaign starting locations are immutable'); END;
  `);
}

export function migrate50to51(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createGrantsRewardsPlacementV51(db);
    db.prepare("UPDATE meta SET value='51' WHERE key='schemaVersion'").run();
  })();
}

export function assertGrantsRewardsPlacementLayoutV51(db: DatabaseDriver.Database): void {
  for (const table of ["character_starter_materializations_v51", "combat_reward_settlements_v51", "campaign_starting_locations_v51"]) {
    if (!(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) throw new Error(`schema v51 ${table} is missing`);
    const guards = (db.prepare("SELECT count(*) count FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(table) as { count: number }).count;
    if (guards !== 2) throw new Error(`schema v51 ${table} guards are incompatible`);
  }
}
