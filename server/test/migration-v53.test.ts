import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { assertCampaignMaterialDeliveryLayoutV53, migrate52to53 } from "../src/repo/db/migrations/v53_campaign_material_delivery.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
describe("schema v53 campaign material delivery",()=>{
  it("creates the fresh current layout",()=>{createRepository().close();const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"53"});expect(()=>assertCampaignMaterialDeliveryLayoutV53(db)).not.toThrow();db.close();});
  it("upgrades a populated v52 marker additively",()=>{const db=new DatabaseDriver(":memory:");db.exec("PRAGMA foreign_keys=ON; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schemaVersion','52'); CREATE TABLE preserved(id TEXT PRIMARY KEY); INSERT INTO preserved VALUES('kept');");migrate52to53(db);expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"53"});expect(db.prepare("SELECT * FROM preserved").all()).toEqual([{id:"kept"}]);expect(()=>assertCampaignMaterialDeliveryLayoutV53(db)).not.toThrow();db.close();});
});
