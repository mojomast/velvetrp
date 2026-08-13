import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import {describe,expect,it} from "vitest";
import {createRepository} from "../src/repo/index.js";
import {buildCanonicalPopulatedV44CompanionFixture,buildCanonicalPopulatedV45CompanionFixture,buildCanonicalV43Fixture} from "./fixtures/migrations/support-window.js";
import {createExactCandidateExecutionsV47} from "../src/repo/db/migrations/v47_exact_candidate_executions.js";
import {useTmpDataDir} from "./helpers.js";

useTmpDataDir();
const file=()=>path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite");
const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
function snapshotDatabase(db:DatabaseDriver.Database){const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{name:string}>);return{schema,rows:Object.fromEntries(tables.map(({name})=>[name,db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all()])),meta:db.prepare("SELECT * FROM meta ORDER BY key").all()};}

describe("v47 support window",()=>{
  it("rejects v44 before mutating any data or an exact empty future v47 shell",()=>{buildCanonicalPopulatedV44CompanionFixture();let db=new DatabaseDriver(file());db.pragma("foreign_keys=OFF");createExactCandidateExecutionsV47(db);db.prepare("UPDATE meta SET value='44' WHERE key='schemaVersion'").run();const before=snapshotDatabase(db);db.close();expect(()=>createRepository()).toThrow("unsupported schemaVersion 44; expected 47");db=new DatabaseDriver(file(),{readonly:true});expect(snapshotDatabase(db)).toEqual(before);expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"44"});db.close();});
  it("preserves populated v45 durable-principal history through v47",()=>{const fixture=buildCanonicalPopulatedV45CompanionFixture();createRepository().close();const db=new DatabaseDriver(file());expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"47"});expect(db.prepare("SELECT grant_id FROM companion_grants_v45").get()).toEqual({grant_id:fixture.grantId});expect(db.prepare("SELECT count(*) count FROM exact_candidate_executions_v47").get()).toEqual({count:0});expect(db.pragma("foreign_key_check")).toEqual([]);db.close();});
  it("preserves populated v45 history row-for-row and permits historical membership removal",()=>{const fixture=buildCanonicalPopulatedV45CompanionFixture();let db=new DatabaseDriver(file(),{readonly:true});const before=db.prepare("SELECT * FROM companion_grants_v45 ORDER BY grant_id").all();db.close();createRepository().close();db=new DatabaseDriver(file());expect(db.prepare("SELECT * FROM companion_grants_v45 ORDER BY grant_id").all()).toEqual(before);db.prepare("DELETE FROM campaign_memberships WHERE campaign_id=? AND principal_id IN (?,?)").run(fixture.campaignId,fixture.grantorPrincipalId,fixture.granteePrincipalId);expect(db.pragma("foreign_key_check")).toEqual([]);db.close();});
});
