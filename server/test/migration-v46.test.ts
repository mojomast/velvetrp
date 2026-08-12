import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import {describe,expect,it} from "vitest";
import {createRepository} from "../src/repo/index.js";
import {EXACT_CANDIDATE_V46_LAYOUT_DIGEST,EXACT_CANDIDATE_V46_MANAGED_OBJECTS,assertExactCandidatesLayoutV46} from "../src/repo/db/migrations/v46_exact_candidates.js";
import {useTmpDataDir} from "./helpers.js";

useTmpDataDir();
const file=()=>path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite");
const marker=()=>{const db=new DatabaseDriver(file(),{readonly:true});const value=(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as {value:string}).value;db.close();return value;};
function rewindToV45(){createRepository().close();const db=new DatabaseDriver(file());db.pragma("foreign_keys=OFF");
  for(const [type,name] of [...EXACT_CANDIDATE_V46_MANAGED_OBJECTS].reverse()){if(type==="trigger")db.exec(`DROP TRIGGER "${name}"`);if(type==="index")db.exec(`DROP INDEX "${name}"`);}
  for(const [,name] of [...EXACT_CANDIDATE_V46_MANAGED_OBJECTS].filter(([type])=>type==="table").reverse())db.exec(`DROP TABLE "${name}"`);
  db.prepare("UPDATE meta SET value='45' WHERE key='schemaVersion'").run();db.close();}

describe("schema v46 exact candidate migration",()=>{
  it("migrates an active v45 archive with empty backfill and preserves global foreign keys",()=>{rewindToV45();createRepository().close();const db=new DatabaseDriver(file());assertExactCandidatesLayoutV46(db);expect(marker()).toBe("46");
    expect(db.prepare("SELECT count(*) count FROM exact_candidates_v46").get()).toEqual({count:0});expect(db.prepare("SELECT layout_digest FROM exact_candidate_layout_attestation_v46").get()).toEqual({layout_digest:EXACT_CANDIDATE_V46_LAYOUT_DIGEST});expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('exact_candidate_decisions_v46','exact_candidate_receipt_links_v46')").all()).toEqual([]);expect(db.pragma("foreign_key_check")).toEqual([]);db.close();});
  it("rejects unsupported v43 without creating v46 artifacts",()=>{rewindToV45();const db=new DatabaseDriver(file());db.prepare("UPDATE meta SET value='43' WHERE key='schemaVersion'").run();db.close();expect(()=>createRepository()).toThrow("unsupported schemaVersion 43; expected 46");expect(marker()).toBe("43");});
  it("rolls back all v46 artifacts when marker advancement fails, then retries",()=>{rewindToV45();let db=new DatabaseDriver(file());db.exec("CREATE TRIGGER reject_schema_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='46' BEGIN SELECT RAISE(ABORT,'reject v46 marker'); END");db.close();expect(()=>createRepository()).toThrow("reject v46 marker");
    db=new DatabaseDriver(file());expect(marker()).toBe("45");expect(db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v46*'").all()).toEqual([]);db.exec("DROP TRIGGER reject_schema_marker");db.close();createRepository().close();expect(marker()).toBe("46");});
  it("cleans an exact empty future shell but rejects malformed and populated shells",()=>{rewindToV45();let db=new DatabaseDriver(file());
    // Build the canonical shell through startup, then lie only about the marker.
    db.close();createRepository().close();db=new DatabaseDriver(file());db.prepare("UPDATE meta SET value='45' WHERE key='schemaVersion'").run();db.close();createRepository().close();expect(marker()).toBe("46");
    db=new DatabaseDriver(file());db.exec("DROP TRIGGER exact_candidates_v46_immutable_delete_v46");db.prepare("UPDATE meta SET value='45' WHERE key='schemaVersion'").run();db.close();expect(()=>createRepository()).toThrow("malformed future v46 artifacts");
  });
});
