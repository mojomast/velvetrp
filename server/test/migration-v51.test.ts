import DatabaseDriver from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { assertGrantsRewardsPlacementLayoutV51, migrate50to51 } from "../src/repo/db/migrations/v51_grants_rewards_placement.js";

describe("v51 grants, rewards, and placement migration", () => {
  it("creates its additive sidecars and advances the marker", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schemaVersion','50');");
    migrate50to51(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "51" });
    expect(() => assertGrantsRewardsPlacementLayoutV51(db)).not.toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '*_v51' ORDER BY name").all()).toEqual([
      { name: "campaign_starting_locations_v51" }, { name: "character_starter_materializations_v51" },
      { name: "combat_reward_settlements_v51" },
    ]);
    db.close();
  });
});
