import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import {describe,expect,it} from "vitest";
import {assertCompanionCoreLayoutV45} from "../src/repo/db/migrations/v45_companion_principals.js";
import {buildCanonicalPopulatedV45CompanionFixture} from "./fixtures/migrations/support-window.js";
import {useTmpDataDir} from "./helpers.js";

useTmpDataDir();
const file=()=>path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite");

/** Historical v45 archive assertions retained while v46 owns active startup support. */
describe("archived schema v45 companion principals",()=>{
  it("retains the canonical populated durable-principal layout before v46 startup",()=>{
    const fixture=buildCanonicalPopulatedV45CompanionFixture();const db=new DatabaseDriver(file());assertCompanionCoreLayoutV45(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"45"});
    expect(db.prepare("SELECT granted_by_principal_id,grantee_principal_id FROM companion_grants_v45").get()).toEqual({
      granted_by_principal_id:fixture.grantorPrincipalId,grantee_principal_id:fixture.granteePrincipalId,
    });expect(db.pragma("foreign_key_check")).toEqual([]);db.close();
  });
});
