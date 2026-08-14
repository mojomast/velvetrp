import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import {describe,expect,it} from "vitest";
import {createRepository} from "../src/repo/index.js";
import {SCHEMA_REVISION,SCHEMA_VERSION,SUPPORTED_MIGRATION_INPUTS} from "../src/repo/db/schema.js";
import {createCampaignMaterialDeliveryV53} from "../src/repo/db/migrations/v53_campaign_material_delivery.js";
import {createCampaignGenerationExpansionV52} from "../src/repo/db/migrations/v52_campaign_generation_expansion.js";
import {buildCanonicalPopulatedSupportedFixture,buildCanonicalPopulatedV44CompanionFixture,buildCanonicalPopulatedV45CompanionFixture,buildCanonicalSupportedFixture,SUPPORT_WINDOW} from "./fixtures/migrations/support-window.js";
import {makeTmpDir,useTmpDataDir} from "./helpers.js";

useTmpDataDir();
const file=()=>path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite");
const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
function snapshotDatabase(db:DatabaseDriver.Database){const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{name:string}>);return{schema,rows:Object.fromEntries(tables.map(({name})=>[name,db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all()])),meta:db.prepare("SELECT * FROM meta ORDER BY key").all()};}
function schemaSnapshot(db:DatabaseDriver.Database){return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();}
function rowSnapshot(db:DatabaseDriver.Database){const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'meta' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{name:string}>;return Object.fromEntries(tables.map(({name})=>[name,db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all()]));}
function snapshotWithoutMeta(db:DatabaseDriver.Database){const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{name:string}>;return{schema,rows:Object.fromEntries(tables.map(({name})=>[name,db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all()]))};}

describe("current schema support window",()=>{
  it.each(SUPPORTED_MIGRATION_INPUTS)("starts a populated v%s database through the complete supported chain",async(input)=>{
    const currentDir=makeTmpDir("velvet-current-schema-");
    createRepository({dataDir:currentDir}).close();
    const currentDb=new DatabaseDriver(path.join(currentDir,"velvet.sqlite"),{readonly:true});
    const expectedSchema=schemaSnapshot(currentDb);
    currentDb.close();

    const fixture=await buildCanonicalPopulatedSupportedFixture(Number(input));
    let db=new DatabaseDriver(file(),{readonly:true});
    const beforeRows=rowSnapshot(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:input});
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();

    createRepository().close();
    db=new DatabaseDriver(file(),{readonly:true});
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:SCHEMA_VERSION});
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaRevision'").get()).toEqual({value:SCHEMA_REVISION});
    expect(db.prepare("SELECT name FROM campaigns WHERE id=?").get(fixture.campaignId)).toEqual({name:SUPPORT_WINDOW.campaignName});
    expect(db.prepare("SELECT staged_content_json FROM generation_drafts WHERE id=?").get(fixture.draftId)).toBeDefined();
    expect(db.prepare("SELECT public_name FROM campaign_npcs_v28 WHERE campaign_id=? AND npc_id=?").get(fixture.campaignId,fixture.npcId)).toEqual({public_name:SUPPORT_WINDOW.npcName});
    expect(db.prepare("SELECT count(*) count FROM exact_candidate_batches_v46").get()).toEqual({count:1});
    if(Number(input)>=47)expect(db.prepare("SELECT count(*) count FROM exact_candidate_executions_v47").get()).toEqual({count:1});
    if(Number(input)>=48)expect(db.prepare("SELECT count(*) count FROM exact_candidate_provider_bindings_v48").get()).toEqual({count:1});
    if(Number(input)>=49)expect(db.prepare("SELECT count(*) count FROM character_draft_rerolls_v49").get()).toEqual({count:1});
    if(Number(input)>=50)expect(db.prepare("SELECT count(*) count FROM campaign_generation_calls_v50").get()).toEqual({count:1});
    if(Number(input)>=51){expect(db.prepare("SELECT count(*) count FROM character_starter_materializations_v51").get()).toEqual({count:1});expect(db.prepare("SELECT count(*) count FROM combat_reward_settlements_v51").get()).toEqual({count:1});expect(db.prepare("SELECT count(*) count FROM campaign_starting_locations_v51").get()).toEqual({count:1});}
    if(Number(input)>=52){for(const table of ["campaign_generation_jobs_v52","campaign_generation_attempts_v52","campaign_generation_candidate_artifacts_v52","campaign_generation_dependencies_v52","campaign_generation_accepted_artifacts_v52","generated_npc_placement_intents_v52"])expect(db.prepare(`SELECT count(*) count FROM ${quote(table)}`).get(),table).toEqual({count:1});}
    for(const [table,rows] of Object.entries(beforeRows))expect(db.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all(),table).toEqual(rows);
    expect(schemaSnapshot(db)).toEqual(expectedSchema);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
  it("rejects v44 before mutating any data or an exact empty future v47 shell",()=>{buildCanonicalPopulatedV44CompanionFixture();let db=new DatabaseDriver(file());db.pragma("foreign_keys=OFF");db.prepare("UPDATE meta SET value='44' WHERE key='schemaVersion'").run();const before=snapshotDatabase(db);db.close();expect(()=>createRepository()).toThrow("unsupported schemaVersion 44; expected 53");db=new DatabaseDriver(file(),{readonly:true});expect(snapshotDatabase(db)).toEqual(before);expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"44"});db.close();});
  it("rejects populated v45 durable-principal history before mutation",()=>{buildCanonicalPopulatedV45CompanionFixture();let db=new DatabaseDriver(file(),{readonly:true});const before=snapshotDatabase(db);db.close();expect(()=>createRepository()).toThrow("unsupported schemaVersion 45; expected 53");db=new DatabaseDriver(file(),{readonly:true});expect(snapshotDatabase(db)).toEqual(before);db.close();});
  it.each(["45.5","future","54"])("rejects unsupported marker %s before mutation",(marker)=>{createRepository().close();let db=new DatabaseDriver(file());db.prepare("UPDATE meta SET value=? WHERE key='schemaVersion'").run(marker);const before=snapshotDatabase(db);db.close();expect(()=>createRepository()).toThrow(`unsupported schemaVersion ${marker}; expected 53`);db=new DatabaseDriver(file(),{readonly:true});expect(snapshotDatabase(db)).toEqual(before);db.close();});
  it("rejects a nonempty markerless database before creating metadata",()=>{let db=new DatabaseDriver(file());db.exec("CREATE TABLE unrelated(id TEXT PRIMARY KEY); INSERT INTO unrelated VALUES('kept')");const before=snapshotWithoutMeta(db);db.close();expect(()=>createRepository()).toThrow("unsupported schemaVersion missing; expected 53");db=new DatabaseDriver(file(),{readonly:true});expect(snapshotWithoutMeta(db)).toEqual(before);expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get()).toBeUndefined();db.close();});
  it("rejects a markerless database with only a persistent view before mutation",()=>{let db=new DatabaseDriver(file());db.exec("CREATE VIEW retained_view AS SELECT 'kept' value");const before=snapshotWithoutMeta(db);db.close();expect(()=>createRepository()).toThrow("unsupported schemaVersion missing; expected 53");db=new DatabaseDriver(file(),{readonly:true});expect(snapshotWithoutMeta(db)).toEqual(before);expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get()).toBeUndefined();db.close();});
  it("rejects a supported marker with an unsupported revision before migration",()=>{buildCanonicalSupportedFixture(52);let db=new DatabaseDriver(file());db.prepare("UPDATE meta SET value='0' WHERE key='schemaRevision'").run();const before=snapshotDatabase(db);db.close();expect(()=>createRepository()).toThrow("unsupported schemaRevision 0; expected 1");db=new DatabaseDriver(file(),{readonly:true});expect(snapshotDatabase(db)).toEqual(before);db.close();});
  it("rejects a malformed marker-owned layout before migration",()=>{buildCanonicalSupportedFixture(46);let db=new DatabaseDriver(file());db.exec("DROP TRIGGER exact_candidate_batches_v46_immutable_delete_v46; CREATE TRIGGER exact_candidate_batches_v46_immutable_delete_v46 BEFORE DELETE ON exact_candidate_batches_v46 BEGIN SELECT RAISE(ABORT,'wrong guard');END");const before=snapshotDatabase(db);db.close();expect(()=>createRepository()).toThrow("schema v46 exact-candidate layout attestation is incompatible");db=new DatabaseDriver(file(),{readonly:true});expect(snapshotDatabase(db)).toEqual(before);expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"46"});db.close();});
  it("rejects same-name marker-owned DDL tampering before migration",()=>{buildCanonicalSupportedFixture(52);let db=new DatabaseDriver(file());db.exec("DROP TRIGGER campaign_generation_dependencies_v52_immutable_delete; CREATE TRIGGER campaign_generation_dependencies_v52_immutable_delete BEFORE DELETE ON campaign_generation_dependencies_v52 BEGIN SELECT RAISE(ABORT,'wrong guard');END");const before=snapshotDatabase(db);db.close();expect(()=>createRepository()).toThrow("schema v52 campaign layout is incompatible");db=new DatabaseDriver(file(),{readonly:true});expect(snapshotDatabase(db)).toEqual(before);expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"52"});db.close();});
  it("rolls back a late supported migration step without advancing its marker",()=>{buildCanonicalSupportedFixture(52);let db=new DatabaseDriver(file());db.exec("CREATE TRIGGER reject_schema_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='53' BEGIN SELECT RAISE(ABORT,'reject v53 marker');END");const before=snapshotDatabase(db);db.close();expect(()=>createRepository()).toThrow("reject v53 marker");db=new DatabaseDriver(file());expect(snapshotDatabase(db)).toEqual(before);db.exec("DROP TRIGGER reject_schema_marker");db.close();createRepository().close();});
  it("rejects a malformed empty future shell before removing any future artifact",()=>{buildCanonicalSupportedFixture(51);let db=new DatabaseDriver(file());createCampaignMaterialDeliveryV53(db);db.exec("DROP TRIGGER campaign_material_deliveries_v53_immutable_delete; CREATE TRIGGER campaign_material_deliveries_v53_immutable_delete BEFORE DELETE ON campaign_material_deliveries_v53 BEGIN SELECT RAISE(ABORT,'wrong guard');END");const before=snapshotDatabase(db);db.close();expect(()=>createRepository()).toThrow("schema marker 51 contains malformed future v53 artifacts");db=new DatabaseDriver(file(),{readonly:true});expect(snapshotDatabase(db)).toEqual(before);db.close();});
  it("validates every future shell before removing an earlier canonical shell",()=>{buildCanonicalSupportedFixture(51);let db=new DatabaseDriver(file());createCampaignMaterialDeliveryV53(db);createCampaignGenerationExpansionV52(db);db.exec("DROP TRIGGER campaign_generation_dependencies_v52_immutable_delete; CREATE TRIGGER campaign_generation_dependencies_v52_immutable_delete BEFORE DELETE ON campaign_generation_dependencies_v52 BEGIN SELECT RAISE(ABORT,'wrong v52 guard');END");const before=snapshotDatabase(db);db.close();expect(()=>createRepository()).toThrow("schema marker 51 contains malformed future v52 artifacts");db=new DatabaseDriver(file(),{readonly:true});expect(snapshotDatabase(db)).toEqual(before);expect(db.prepare("SELECT count(*) count FROM campaign_material_delivery_revisions_v53").get()).toEqual({count:0});db.close();});
});
