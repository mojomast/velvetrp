import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe,expect,it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { CONFIRMATION_POLICY_V40_LAYOUT_DIGEST, CONFIRMATION_POLICY_V40_MANAGED_OBJECTS } from "../src/repo/db/migrations/v40_confirmation_policy.js";
import { removeFutureCampaignContentGenerationSchema, useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file=()=>path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite");

describe("schema v40 confirmation policy",()=>{
  it("migrates canonical v39 additively and seals its exact layout",()=>{
    createRepository().close();const db=new DatabaseDriver(file());db.pragma("foreign_keys=OFF");removeFutureCampaignContentGenerationSchema(db);
    for(const [type,name] of [...CONFIRMATION_POLICY_V40_MANAGED_OBJECTS].reverse()){
      if(type==="trigger")db.exec(`DROP TRIGGER "${name}"`);else db.exec(`DROP TABLE "${name}"`);
    }
    db.prepare("UPDATE meta SET value='39' WHERE key='schemaVersion'").run();db.close();createRepository().close();
    const verify=new DatabaseDriver(file(),{readonly:true});
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"42"});
    expect(verify.prepare("SELECT layout_digest FROM confirmation_policy_layout_attestation_v40").get()).toEqual({layout_digest:CONFIRMATION_POLICY_V40_LAYOUT_DIGEST});
    verify.close();
  });
  it("rejects canonical attestation drift at startup",()=>{
    createRepository().close();const db=new DatabaseDriver(file());db.exec("DROP TRIGGER confirmation_policy_layout_attestation_v40_update_v40");
    db.prepare("UPDATE confirmation_policy_layout_attestation_v40 SET layout_digest=?").run("0".repeat(64));db.close();
    expect(()=>createRepository()).toThrow(/schema v40 (?:attestation mismatch|inventory incompatible)/);
  });
  it("rejects a tampered canonical shell behind a rewound marker",()=>{
    createRepository().close();const db=new DatabaseDriver(file());
    db.exec("DROP TRIGGER confirmation_policy_layout_attestation_v40_update_v40");
    db.prepare("UPDATE confirmation_policy_layout_attestation_v40 SET layout_digest=?").run("0".repeat(64));
    db.prepare("UPDATE meta SET value='39' WHERE key='schemaVersion'").run();db.close();
    expect(()=>createRepository()).toThrow(/malformed future v40 artifacts/);
  });
  it("never discards populated policy rows behind a rewound marker",()=>{
    createRepository().close();const db=new DatabaseDriver(file());db.pragma("foreign_keys=OFF");
    db.prepare(`INSERT INTO confirmation_policy_attestations_v40 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      "proposal","campaign","turn","v1","ambiguous-consequential-change",1,"controller",
      '{"consequences":[{"kind":"campaign-change","text":"Campaign state may change"}],"summary":"Apply a consequential change."}',
      "a".repeat(64),'[{"domain":"timeline","revision":0}]',"2035-01-01T00:00:00.000Z");
    db.prepare("UPDATE meta SET value='39' WHERE key='schemaVersion'").run();db.close();
    expect(()=>createRepository()).toThrow(/populated future v40 artifact confirmation_policy_attestations_v40/);
  });
});
