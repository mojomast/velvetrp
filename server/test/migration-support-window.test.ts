import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import {describe,expect,it} from "vitest";
import {createRepository} from "../src/repo/index.js";
import {buildCanonicalPopulatedV44CompanionFixture,buildCanonicalPopulatedV45CompanionFixture,buildCanonicalV43Fixture} from "./fixtures/migrations/support-window.js";
import {useTmpDataDir} from "./helpers.js";

useTmpDataDir();
const file=()=>path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite");

describe("v46 support window",()=>{
  it("rejects v43 before marker or future-shell mutation",()=>{buildCanonicalV43Fixture();let db=new DatabaseDriver(file(),{readonly:true});const before=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name GLOB '*v46*' ORDER BY type,name").all();db.close();expect(()=>createRepository()).toThrow("unsupported schemaVersion 43; expected 46");db=new DatabaseDriver(file(),{readonly:true});expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"43"});expect(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name GLOB '*v46*' ORDER BY type,name").all()).toEqual(before);db.close();});
  it("preserves populated v44 durable-principal history through v46",()=>{const fixture=buildCanonicalPopulatedV44CompanionFixture();createRepository().close();const db=new DatabaseDriver(file());expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"46"});expect(db.prepare("SELECT grant_id FROM companion_grants_v45").get()).toEqual({grant_id:fixture.grantId});expect(db.prepare("SELECT count(*) count FROM exact_candidates_v46").get()).toEqual({count:0});expect(db.pragma("foreign_key_check")).toEqual([]);db.close();});
  it("preserves populated v45 history row-for-row and permits historical membership removal",()=>{const fixture=buildCanonicalPopulatedV45CompanionFixture();let db=new DatabaseDriver(file(),{readonly:true});const before=db.prepare("SELECT * FROM companion_grants_v45 ORDER BY grant_id").all();db.close();createRepository().close();db=new DatabaseDriver(file());expect(db.prepare("SELECT * FROM companion_grants_v45 ORDER BY grant_id").all()).toEqual(before);db.prepare("DELETE FROM campaign_memberships WHERE campaign_id=? AND principal_id IN (?,?)").run(fixture.campaignId,fixture.grantorPrincipalId,fixture.granteePrincipalId);expect(db.pragma("foreign_key_check")).toEqual([]);db.close();});
});
