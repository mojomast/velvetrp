import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";

const makeDir=()=>mkdtempSync(path.join(os.tmpdir(),"velvet-v31-"));
const file=(dir:string)=>path.join(dir,"velvet.sqlite");
const layout=(dir:string)=>{const db=new DatabaseDriver(file(dir),{readonly:true});
  const rows=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();return rows;};
function rewind(dir:string):void{
  const db=new DatabaseDriver(file(dir));
  db.exec(`DROP TRIGGER encounter_enemy_provenance_v31_immutable_delete;
    DROP TRIGGER encounter_enemy_provenance_v31_immutable_update;
    DROP TRIGGER encounter_enemy_provenance_v31_exact_combatant;
    DROP TRIGGER encounter_lifecycle_v31_immutable_delete;
    DROP TRIGGER encounter_lifecycle_v31_immutable_update;
    DROP TRIGGER encounter_lifecycle_v31_exact_ancestry;
    DROP TABLE encounter_enemy_provenance_v31;
    DROP TABLE encounter_lifecycle_v31;`);
  db.prepare("UPDATE meta SET value='30' WHERE key='schemaVersion'").run();db.close();
}

describe("schema v31 encounter lifecycle",()=>{
  it("has fresh/migrated parity and immutable metadata",()=>{
    const migrated=makeDir();createRepository({dataDir:migrated}).close();rewind(migrated);createRepository({dataDir:migrated}).close();
    const fresh=makeDir();createRepository({dataDir:fresh}).close();
    expect(layout(migrated)).toEqual(layout(fresh));
    const db=new DatabaseDriver(file(migrated));
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"38"});
    expect(()=>db.prepare(`INSERT INTO encounter_lifecycle_v31(encounter_id,campaign_id,session_id,name,
      create_idempotency_key,canonical_create_request_json,request_digest) VALUES('missing','missing','missing','Name',
      'key','{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`).run()).toThrow();
    db.close();
  });

  it("rolls back lifecycle creation when the schema marker cannot advance",()=>{
    const dir=makeDir();createRepository({dataDir:dir}).close();rewind(dir);
    const db=new DatabaseDriver(file(dir));
    db.exec("CREATE TRIGGER reject_v31 BEFORE UPDATE OF value ON meta WHEN NEW.value='31' BEGIN SELECT RAISE(ABORT,'reject v31'); END;");db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("reject v31");
    const verify=new DatabaseDriver(file(dir));
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='encounter_lifecycle_v31'").get()).toBeUndefined();
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"30"});verify.close();
  });
});
