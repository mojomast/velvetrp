import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import {describe,expect,it} from "vitest";
import {createRepository} from "../src/repo/index.js";
import {EXACT_CANDIDATE_PROVIDER_V48_LAYOUT_DIGEST,EXACT_CANDIDATE_PROVIDER_V48_MANAGED_OBJECTS,
  assertExactCandidateProviderBridgeLayoutV48} from "../src/repo/db/migrations/v48_exact_candidate_provider_bridge.js";
import {useTmpDataDir} from "./helpers.js";

useTmpDataDir();
const file=()=>path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite");
function rewind47(){createRepository().close();const db=new DatabaseDriver(file());db.pragma("foreign_keys=OFF");
  for(const [type,name] of [...EXACT_CANDIDATE_PROVIDER_V48_MANAGED_OBJECTS].reverse()){if(type==="trigger")db.exec(`DROP TRIGGER "${name}"`);if(type==="index")db.exec(`DROP INDEX "${name}"`);}
  for(const [,name] of [...EXACT_CANDIDATE_PROVIDER_V48_MANAGED_OBJECTS].filter(([type])=>type==="table").reverse())db.exec(`DROP TABLE "${name}"`);
  db.prepare("UPDATE meta SET value='47' WHERE key='schemaVersion'").run();db.close();}

describe("schema v48 provider exact-travel bridge migration",()=>{
  it("upgrades v47 additively with attested empty binding history",()=>{rewind47();createRepository().close();const db=new DatabaseDriver(file());
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"53"});assertExactCandidateProviderBridgeLayoutV48(db);
    expect(db.prepare("SELECT layout_digest FROM exact_candidate_provider_layout_attestation_v48").get()).toEqual({layout_digest:EXACT_CANDIDATE_PROVIDER_V48_LAYOUT_DIGEST});
    expect(db.prepare("SELECT count(*) count FROM exact_candidate_provider_bindings_v48").get()).toEqual({count:0});expect(db.pragma("foreign_key_check")).toEqual([]);db.close();});
  it("rejects v45 before mutation",()=>{createRepository().close();let db=new DatabaseDriver(file());db.prepare("UPDATE meta SET value='45' WHERE key='schemaVersion'").run();
    const before=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();db.close();
    expect(()=>createRepository()).toThrow("unsupported schemaVersion 45; expected 53");db=new DatabaseDriver(file(),{readonly:true});
    expect(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all()).toEqual(before);db.close();});
  it("rejects provider-layout DDL tampering",()=>{createRepository().close();const db=new DatabaseDriver(file());
    db.exec("DROP TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48");
    db.exec("CREATE TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48 BEFORE UPDATE ON exact_candidate_provider_bindings_v48 BEGIN SELECT RAISE(ABORT,'wrong guard');END");
    expect(()=>assertExactCandidateProviderBridgeLayoutV48(db)).toThrow("schema v48 provider bridge attestation is incompatible");db.close();});
});
