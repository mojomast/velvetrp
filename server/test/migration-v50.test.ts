import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { assertCampaignGenerationLayoutV50 } from "../src/repo/db/migrations/v50_campaign_generation.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
describe("schema v50 campaign generation", () => {
  it("creates the fresh layout", () => { createRepository().close(); const db=new DatabaseDriver(file()); expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"53"}); expect(()=>assertCampaignGenerationLayoutV50(db)).not.toThrow(); db.close(); });
  it("upgrades v49 without changing existing rows", () => { createRepository().close(); let db=new DatabaseDriver(file()); db.exec("DROP TRIGGER campaign_starting_locations_v51_immutable_delete; DROP TRIGGER campaign_starting_locations_v51_immutable_update; DROP TRIGGER combat_reward_settlements_v51_immutable_delete; DROP TRIGGER combat_reward_settlements_v51_immutable_update; DROP TRIGGER character_starter_materializations_v51_immutable_delete; DROP TRIGGER character_starter_materializations_v51_immutable_update; DROP TABLE campaign_starting_locations_v51; DROP TABLE combat_reward_settlements_v51; DROP TABLE character_starter_materializations_v51; DROP TRIGGER campaign_generation_artifacts_v50_immutable_delete; DROP TRIGGER campaign_generation_artifacts_v50_immutable_update; DROP INDEX campaign_generation_artifacts_v50_draft; DROP TABLE campaign_generation_artifacts_v50; DROP TABLE campaign_generation_calls_v50"); db.prepare("UPDATE meta SET value='49' WHERE key='schemaVersion'").run(); const campaigns=(db.prepare("SELECT count(*) count FROM campaigns").get() as any).count; db.close(); createRepository().close(); db=new DatabaseDriver(file()); expect((db.prepare("SELECT count(*) count FROM campaigns").get() as any).count).toBe(campaigns); expect(()=>assertCampaignGenerationLayoutV50(db)).not.toThrow(); expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"53"}); db.close(); });
});
