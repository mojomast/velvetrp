import DatabaseDriver from "better-sqlite3";
import {mkdtempSync} from "node:fs";
import os from "node:os";import path from "node:path";
import {describe,expect,it} from "vitest";
import {createRepository} from "../src/repo/index.js";
import {removeFutureWorldNarrativeV32} from "./helpers.js";

const dir=()=>mkdtempSync(path.join(os.tmpdir(),"velvet-v32-"));
const file=(value:string)=>path.join(value,"velvet.sqlite");
const layout=(value:string)=>{const db=new DatabaseDriver(file(value),{readonly:true});const rows=db.prepare(
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();db.close();return rows;};
function rewind(value:string){const db=new DatabaseDriver(file(value));removeFutureWorldNarrativeV32(db);
  db.prepare("UPDATE meta SET value='31' WHERE key='schemaVersion'").run();db.close();}

describe("schema v32 world narrative",()=>{
  it("has fresh and migrated parity",()=>{const migrated=dir();createRepository({dataDir:migrated}).close();rewind(migrated);
    createRepository({dataDir:migrated}).close();const fresh=dir();createRepository({dataDir:fresh}).close();
    expect(layout(migrated)).toEqual(layout(fresh));const db=new DatabaseDriver(file(migrated));
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"34"});db.close();});
  it("rolls back when the marker cannot advance",()=>{const value=dir();createRepository({dataDir:value}).close();rewind(value);
    const db=new DatabaseDriver(file(value));db.exec("CREATE TRIGGER reject_v32 BEFORE UPDATE OF value ON meta WHEN NEW.value='32' BEGIN SELECT RAISE(ABORT,'reject v32'); END;");db.close();
    expect(()=>createRepository({dataDir:value})).toThrow("reject v32");const verify=new DatabaseDriver(file(value));
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='world_narrative_revisions_v32'").get()).toBeUndefined();
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"31"});verify.close();});
  it("rejects a forged replacement artifact even when the object count matches",()=>{const value=dir();createRepository({dataDir:value}).close();
    const db=new DatabaseDriver(file(value));db.exec(`DROP TRIGGER world_narrative_events_v32_immutable_delete;
      CREATE TABLE forged_v32(value TEXT);`);db.close();expect(()=>createRepository({dataDir:value})).toThrow("schema v32 world narrative is incompatible");});
});
