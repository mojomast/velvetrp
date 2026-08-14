import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { assertCampaignGenerationExpansionLayoutV52, migrate51to52 } from "../src/repo/db/migrations/v52_campaign_generation_expansion.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
describe("schema v52 campaign generation expansion",()=>{
  it("preserves the v52 layout in the fresh current schema",()=>{createRepository().close();const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"53"});expect(()=>assertCampaignGenerationExpansionLayoutV52(db)).not.toThrow();db.close();});
  it("upgrades a populated v51 marker additively",()=>{const db=new DatabaseDriver(":memory:");db.exec("PRAGMA foreign_keys=ON; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schemaVersion','51'); CREATE TABLE preserved(id TEXT PRIMARY KEY); INSERT INTO preserved VALUES('kept');");migrate51to52(db);expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"52"});expect(db.prepare("SELECT * FROM preserved").all()).toEqual([{id:"kept"}]);expect(()=>assertCampaignGenerationExpansionLayoutV52(db)).not.toThrow();db.close();});
});
