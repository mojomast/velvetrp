import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY } from "@velvet/contracts";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { removeFutureCharacterProgressionSchema } from "./helpers.js";

const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "velvet-v20-"));
const file = (dir: string) => path.join(dir, "velvet.sqlite");
const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"]
  .map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as any;
function schema(name:string):unknown[]{const db=new DatabaseDriver(name,{readonly:true});
  const rows=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();db.close();return rows;}
function restoreV19DeleteTriggers(db:DatabaseDriver.Database):void{
  const names=["character_drafts_v19_prevent_delete","character_draft_pins_v19_immutable_delete","character_draft_commands_v19_immutable_delete",
    "character_draft_events_v19_immutable_delete","character_draft_receipts_v19_immutable_delete","character_draft_revisions_v19_immutable_delete",
    "character_derived_snapshots_v19_immutable_delete","character_starting_grants_v19_immutable_delete"];
  for(const name of names)db.exec(`DROP TRIGGER ${name}`);
  db.exec(`
    CREATE TRIGGER character_drafts_v19_prevent_delete BEFORE DELETE ON character_drafts_v19 BEGIN SELECT RAISE(ABORT,'character drafts are retained'); END;
    CREATE TRIGGER character_draft_pins_v19_immutable_delete BEFORE DELETE ON character_draft_pins_v19 BEGIN SELECT RAISE(ABORT,'character draft pins are immutable'); END;
    CREATE TRIGGER character_draft_commands_v19_immutable_delete BEFORE DELETE ON character_draft_commands_v19 BEGIN SELECT RAISE(ABORT,'character draft commands are immutable'); END;
    CREATE TRIGGER character_draft_events_v19_immutable_delete BEFORE DELETE ON character_draft_events_v19 BEGIN SELECT RAISE(ABORT,'character draft events are immutable'); END;
    CREATE TRIGGER character_draft_receipts_v19_immutable_delete BEFORE DELETE ON character_draft_receipts_v19 BEGIN SELECT RAISE(ABORT,'character draft receipts are immutable'); END;
    CREATE TRIGGER character_draft_revisions_v19_immutable_delete BEFORE DELETE ON character_draft_revisions_v19 BEGIN SELECT RAISE(ABORT,'character draft revisions are immutable'); END;
    CREATE TRIGGER character_derived_snapshots_v19_immutable_delete BEFORE DELETE ON character_derived_snapshots_v19 BEGIN SELECT RAISE(ABORT,'derived character snapshots are immutable'); END;
    CREATE TRIGGER character_starting_grants_v19_immutable_delete BEFORE DELETE ON character_starting_grants_v19 BEGIN SELECT RAISE(ABORT,'starting grants are immutable'); END;`);
}
function populatedV19(dir:string):{draftId:string;campaignId:string}{
  const repo=createRepository({dataDir:dir,clock:{now:()=>new Date("2031-01-01T00:00:00.000Z")}});
  const persona=repo.createCharacter({name:"V19 persona",age:30,archetype:"Warden",boundaries:"",fictionalConfirmed:true});
  const campaign=repo.createCampaign("local-owner",{name:"V19 campaign"});repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"v19-pins"});
  const created=repo.createCharacterDraft("local-owner",campaign.id,{personaId:persona.id,controllerPrincipalId:"local-owner",durability:"durable",
    allocation:{method:"standard-array",scores},idempotencyKey:"v19-create"});
  const race={...MECHANICS_STARTER_CATALOG.definitions.find((value)=>value.reference.kind==="race")!.reference,kind:"race" as const};
  const background={...MECHANICS_STARTER_CATALOG.definitions.find((value)=>value.reference.kind==="background")!.reference,kind:"background" as const};
  const klass={...MECHANICS_STARTER_CATALOG.definitions.find((value)=>value.reference.kind==="class")!.reference,kind:"class" as const};
  repo.updateCharacterDraft("local-owner",created.draft.id,{expectedRevision:0,idempotencyKey:"v19-update",
    selections:{race,background,class:klass,starterGrant:"kit"}});repo.close();
  const db=new DatabaseDriver(file(dir));
  removeFutureCharacterProgressionSchema(db);
  const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v20' OR name GLOB '*_v20_*' OR name GLOB '*_v21' OR name GLOB '*_v21_*' OR name GLOB '*_v22' OR name GLOB '*_v22_*')").all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec(`DROP INDEX uq_character_draft_commands_v21_revision; DROP INDEX uq_character_draft_events_v21_revision;
    DROP INDEX uq_character_draft_receipts_v21_revision;
    DROP INDEX uq_character_draft_proposals_v21_revision; DROP TABLE character_builder_layout_attestation_v22;
    DROP TABLE character_builder_layout_attestation_v21;
    DROP TABLE character_draft_command_provenance_v20; DROP TABLE IF EXISTS character_draft_campaign_deletions_v20;
    DROP TABLE character_builder_layout_attestation_v20;`);
  restoreV19DeleteTriggers(db);db.prepare("UPDATE meta SET value='19' WHERE key='schemaVersion'").run();db.close();
  return{draftId:created.draft.id,campaignId:campaign.id};
}

describe("schema v19 to v20 draft provenance migration",()=>{
  it("validates and backfills populated audit rows with fresh/migrated parity",()=>{
    const dir=makeDir(),identity=populatedV19(dir);const before=new DatabaseDriver(file(dir),{readonly:true});
    const preserved={draft:before.prepare("SELECT * FROM character_drafts_v19 WHERE id=?").get(identity.draftId),
      commands:before.prepare("SELECT * FROM character_draft_commands_v19 ORDER BY command_id").all(),
      events:before.prepare("SELECT * FROM character_draft_events_v19 ORDER BY event_id").all(),
      receipts:before.prepare("SELECT * FROM character_draft_receipts_v19 ORDER BY command_id").all(),
      revisions:before.prepare("SELECT * FROM character_draft_revisions_v19 ORDER BY revision").all()};before.close();
    createRepository({dataDir:dir}).close();const migrated=new DatabaseDriver(file(dir),{readonly:true});
    expect(migrated.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"37"});
    expect({draft:migrated.prepare("SELECT * FROM character_drafts_v19 WHERE id=?").get(identity.draftId),
      commands:migrated.prepare("SELECT * FROM character_draft_commands_v19 ORDER BY command_id").all(),
      events:migrated.prepare("SELECT * FROM character_draft_events_v19 ORDER BY event_id").all(),
      receipts:migrated.prepare("SELECT * FROM character_draft_receipts_v19 ORDER BY command_id").all(),
      revisions:migrated.prepare("SELECT * FROM character_draft_revisions_v19 ORDER BY revision").all()}).toEqual(preserved);
    expect(migrated.prepare("SELECT COUNT(*) count FROM character_draft_command_provenance_v20").get()).toEqual({count:2});migrated.close();
    expect(JSON.stringify(preserved)).not.toMatch(/privateNotes|boundaries/);
    const fresh=makeDir();createRepository({dataDir:fresh}).close();expect(schema(file(dir))).toEqual(schema(file(fresh)));
  });

  it("rejects corrupt populated v19 audit transactionally before any v20 artifact",()=>{
    const dir=makeDir();populatedV19(dir);const db=new DatabaseDriver(file(dir));
    db.exec("DROP TRIGGER character_draft_receipts_v19_immutable_update");
    db.prepare("UPDATE character_draft_receipts_v19 SET result_json='{}' WHERE rowid=(SELECT min(rowid) FROM character_draft_receipts_v19)").run();
    db.exec("CREATE TRIGGER character_draft_receipts_v19_immutable_update BEFORE UPDATE ON character_draft_receipts_v19 BEGIN SELECT RAISE(ABORT,'character draft receipts are immutable'); END;");db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("schema v19 character draft audit is inconsistent");
    const verify=new DatabaseDriver(file(dir),{readonly:true});expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"19"});
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='character_draft_command_provenance_v20'").get()).toBeUndefined();verify.close();
  });

  it.each([
    ["missing trigger","DROP TRIGGER character_draft_events_v19_immutable_update"],
    ["extra index","CREATE INDEX forged_v19_builder_index ON character_drafts_v19(persona_id)"],
  ])("rejects v19 with a %s before migration",(_label,statement)=>{
    const dir=makeDir();populatedV19(dir);const db=new DatabaseDriver(file(dir));db.exec(statement);db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow(/schema v19 builder/);
    const verify=new DatabaseDriver(file(dir),{readonly:true});expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"19"});verify.close();
  });

  it("rejects a same-name no-op current trigger by canonical sqlite_master SQL",()=>{
    const dir=makeDir();createRepository({dataDir:dir}).close();const db=new DatabaseDriver(file(dir));
    db.exec(`DROP TRIGGER character_draft_receipts_require_proposal_v21;
      CREATE TRIGGER character_draft_receipts_require_proposal_v21 BEFORE INSERT ON character_draft_receipts_v19 BEGIN SELECT 1; END;`);db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("schema v22 builder canonical SQL is incompatible");
  });

  it("rejects current draft-root drift from the latest immutable revision result",()=>{
    const dir=makeDir(),identity=populatedV19(dir);createRepository({dataDir:dir}).close();const db=new DatabaseDriver(file(dir));
    const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE name='character_drafts_v19_revision_guard'").get() as {sql:string};
    db.exec("DROP TRIGGER character_drafts_v19_revision_guard");
    db.prepare("UPDATE character_drafts_v19 SET status='abandoned' WHERE id=?").run(identity.draftId);db.exec(trigger.sql);db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("root drifted from latest immutable revision");
  });

  it("rejects a same-name no-op v19 trigger by canonical sqlite_master SQL",()=>{
    const dir=makeDir();populatedV19(dir);const db=new DatabaseDriver(file(dir));
    db.exec(`DROP TRIGGER character_draft_events_v19_immutable_update;
      CREATE TRIGGER character_draft_events_v19_immutable_update BEFORE UPDATE ON character_draft_events_v19 BEGIN SELECT 1; END;`);db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("schema v19 builder canonical SQL is incompatible");
    const verify=new DatabaseDriver(file(dir),{readonly:true});expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"19"});verify.close();
  });

  it("rejects v19 draft-root drift from its latest immutable result snapshot",()=>{
    const dir=makeDir(),identity=populatedV19(dir);const db=new DatabaseDriver(file(dir));
    const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='character_drafts_v19_revision_guard'").get() as {sql:string};
    db.exec("DROP TRIGGER character_drafts_v19_revision_guard");
    db.prepare("UPDATE character_drafts_v19 SET selections_json='{" + '"race":null,"background":null,"class":null,"starterGrant":"currency"' + "}' WHERE id=?").run(identity.draftId);
    db.exec(trigger.sql);db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("root drifted from latest immutable revision");
    const verify=new DatabaseDriver(file(dir),{readonly:true});expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"19"});
    expect(verify.prepare("SELECT selections_json FROM character_drafts_v19 WHERE id=?").get(identity.draftId)).toEqual({selections_json:'{"race":null,"background":null,"class":null,"starterGrant":"currency"}'});verify.close();
  });

  it.each(["migration","current startup"] as const)("rejects a forged draft creator during %s attestation",phase=>{
    const dir=makeDir(),identity=populatedV19(dir);
    if(phase==="current startup")createRepository({dataDir:dir}).close();
    const db=new DatabaseDriver(file(dir));
    db.prepare("INSERT INTO principals (id,display_name,is_local) VALUES ('forged-creator','Forged creator',0)").run();
    db.prepare("INSERT INTO campaign_memberships (campaign_id,principal_id,role,created_at) VALUES (?,'forged-creator','observer','2031-01-01T00:00:00.000Z')").run(identity.campaignId);
    const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='character_drafts_v19_revision_guard'").get() as {sql:string};
    db.exec("DROP TRIGGER character_drafts_v19_revision_guard");
    db.prepare("UPDATE character_drafts_v19 SET created_by_principal_id='forged-creator' WHERE id=?").run(identity.draftId);
    db.exec(trigger.sql);db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("root drifted from latest immutable revision");
    const verify=new DatabaseDriver(file(dir),{readonly:true});
    expect(verify.prepare("SELECT created_by_principal_id FROM character_drafts_v19 WHERE id=?").get(identity.draftId))
      .toEqual({created_by_principal_id:"forged-creator"});
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:phase==="migration"?"19":"37"});
    verify.close();
  });

  it("upgrades an exact populated v20 after transactional v21 rollback and matches fresh DDL",()=>{
    const dir=makeDir();populatedV19(dir);const blocker=new DatabaseDriver(file(dir));
    blocker.exec(`CREATE TRIGGER reject_integrity_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='21'
      BEGIN SELECT RAISE(ABORT,'reject v21 marker'); END;`);blocker.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("reject v21 marker");
    const v20=new DatabaseDriver(file(dir));expect(v20.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"20"});
    expect(v20.prepare("SELECT COUNT(*) count FROM character_draft_command_provenance_v20").get()).toEqual({count:2});
    expect(v20.prepare("SELECT 1 FROM sqlite_master WHERE name='character_builder_layout_attestation_v21'").get()).toBeUndefined();
    v20.exec("DROP TRIGGER reject_integrity_marker");v20.close();createRepository({dataDir:dir}).close();
    const fresh=makeDir();createRepository({dataDir:fresh}).close();expect(schema(file(dir))).toEqual(schema(file(fresh)));
  });

  it("upgrades exact v21 to additive v22 transactionally with fresh DDL parity",()=>{
    const dir=makeDir();createRepository({dataDir:dir}).close();const db=new DatabaseDriver(file(dir));
    removeFutureCharacterProgressionSchema(db);
    const v22Triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v22' OR name GLOB '*_v22_*')").all() as Array<{name:string}>;
    for(const trigger of v22Triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
    db.exec("DROP TABLE character_builder_layout_attestation_v22");
    db.prepare("UPDATE meta SET value='21' WHERE key='schemaVersion'").run();
    db.exec(`CREATE TRIGGER reject_archive_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='22'
      BEGIN SELECT RAISE(ABORT,'reject v22 marker'); END;`);db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("reject v22 marker");
    const rolledBack=new DatabaseDriver(file(dir));
    expect(rolledBack.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"21"});
    expect(rolledBack.prepare("SELECT 1 FROM sqlite_master WHERE name='character_builder_layout_attestation_v22'").get()).toBeUndefined();
    rolledBack.exec("DROP TRIGGER reject_archive_marker");rolledBack.close();
    createRepository({dataDir:dir}).close();const fresh=makeDir();createRepository({dataDir:fresh}).close();
    expect(schema(file(dir))).toEqual(schema(file(fresh)));
  });

  it.each([
    ["missing trigger","DROP TRIGGER character_draft_receipts_require_proposal_v21"],
    ["missing v22 archive trigger","DROP TRIGGER character_draft_commands_v22_retain_delete"],
    ["extra artifact","CREATE TRIGGER forged_character_draft_v20 AFTER INSERT ON character_drafts_v19 BEGIN SELECT 1; END"],
  ])("rejects current v22 startup with a %s",(_label,statement)=>{
    const dir=makeDir();createRepository({dataDir:dir}).close();const db=new DatabaseDriver(file(dir));db.exec(statement);db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow(/schema v22 builder|canonical SQL/);
  });

  it("rejects a constraintless same-column current v22 table rebuild",()=>{
    const dir=makeDir();createRepository({dataDir:dir}).close();const db=new DatabaseDriver(file(dir));
    const triggerSql=(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='character_builder_layout_attestation_v22' ORDER BY name").all() as Array<{sql:string}>).map((row)=>row.sql);
    db.exec(`DROP TRIGGER character_builder_layout_attestation_v22_immutable_update;
      DROP TRIGGER character_builder_layout_attestation_v22_immutable_delete;
      ALTER TABLE character_builder_layout_attestation_v22 RENAME TO constraintless_source;
      CREATE TABLE character_builder_layout_attestation_v22(singleton INTEGER,layout_digest TEXT);
      INSERT INTO character_builder_layout_attestation_v22 SELECT * FROM constraintless_source;
      DROP TABLE constraintless_source;`);
    for(const sql of triggerSql)db.exec(sql);db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("schema v22 builder canonical SQL is incompatible");
  });

  it("fails a lower-marker durable-draft rewind without deleting one row or DDL object",()=>{
    const dir=makeDir(),identity=populatedV19(dir);createRepository({dataDir:dir}).close();const db=new DatabaseDriver(file(dir));
    db.prepare("UPDATE meta SET value='18' WHERE key='schemaVersion'").run();
    const before={draft:db.prepare("SELECT * FROM character_drafts_v19 WHERE id=?").get(identity.draftId),
      ddl:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'character_*_v19*' OR name GLOB 'character_*_v20*' OR name GLOB 'character_*_v21*' ORDER BY type,name").all()};db.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("cannot contain future v19 artifact");
    const verify=new DatabaseDriver(file(dir),{readonly:true});expect({draft:verify.prepare("SELECT * FROM character_drafts_v19 WHERE id=?").get(identity.draftId),
      ddl:verify.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'character_*_v19*' OR name GLOB 'character_*_v20*' OR name GLOB 'character_*_v21*' ORDER BY type,name").all()}).toEqual(before);
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"18"});verify.close();
  });
});
