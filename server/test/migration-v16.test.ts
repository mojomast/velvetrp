import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalCatalogJson, createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { removeFutureCharacterBuilderSchema } from "./helpers.js";

const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "velvet-v16-"));
const file = (dir: string) => path.join(dir, "velvet.sqlite");
function schema(name: string): unknown[] {
  const db = new DatabaseDriver(name, { readonly: true });
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close(); return rows;
}

function rewindToV15(dir: string): void {
  const repo = createRepository({ dataDir: dir });
  const campaign = repo.createCampaign("local-owner", { name: "Preserved v15 campaign" });
  repo.installContentPack("local-owner", { packId: "legacy-pack", packVersion: "1", rulesProfileId: "legacy-profile",
    rulesProfile: { name: "Legacy", description: "Legacy profile", tags: [] }, name: "Legacy", description: "Legacy pack", tags: [],
    classes: [{ definitionId: "legacy-class", kind: "class", name: "Class", description: "Legacy class", tags: [] }],
    races: [{ definitionId: "legacy-race", kind: "race", name: "Race", description: "Legacy race", tags: [] }],
    backgrounds: [{ definitionId: "legacy-background", kind: "background", name: "Background", description: "Legacy background", tags: [] }],
    items: [{ definitionId: "legacy-item", kind: "item", name: "Item", description: "Legacy item", tags: [] }],
    spells: [{ definitionId: "legacy-spell", kind: "spell", name: "Spell", description: "Legacy spell", tags: [] }],
    abilities: [{ definitionId: "legacy-ability", kind: "ability", name: "Ability", description: "Legacy ability", tags: [] }],
    enemies: [{ definitionId: "legacy-enemy", kind: "enemy", name: "Enemy", description: "Legacy enemy", tags: [] }] });
  repo.configureCampaignContent("local-owner", campaign.id, { rulesProfileId: "legacy-profile",
    contentPacks: [{ packId: "legacy-pack", packVersion: "1" }] });
  const dbSeed = new DatabaseDriver(file(dir));
  dbSeed.prepare("INSERT INTO principals (id,display_name,is_local) VALUES ('v15-player','V15 player',0)").run();
  dbSeed.close();
  repo.addCampaignMembership("local-owner", campaign.id, { principalId: "v15-player", role: "player" });
  repo.close();
  const db = new DatabaseDriver(file(dir));
  removeFutureCharacterBuilderSchema(db);
  const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND
    (tbl_name IN ('rpg_content_pack_publications','rpg_catalog_definitions','campaign_content_catalog_selections',
      'campaign_content_catalog_pins','campaign_catalog_commands','campaign_catalog_events','campaign_catalog_receipts',
      'rpg_catalog_publication_attestations','rpg_catalog_definition_visibility','rpg_catalog_publication_submissions',
      'campaign_catalog_current_selections','campaign_catalog_current_pins','campaign_catalog_command_provenance_v18')
      OR name IN ('rpg_content_packs_prevent_replace_v16','rpg_definitions_prevent_replace_v16',
        'campaign_administration_commands_reject_catalog_identity','campaign_administration_events_reject_catalog_revision'))`).all() as Array<{ name: string }>;
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec(`DROP TABLE campaign_catalog_command_provenance_v18;
    DROP TABLE campaign_catalog_current_pins; DROP TABLE campaign_catalog_current_selections;
    DROP TABLE campaign_catalog_receipts; DROP TABLE campaign_catalog_events; DROP TABLE campaign_catalog_commands;
    DROP TABLE rpg_catalog_publication_submissions; DROP TABLE rpg_catalog_definition_visibility;
    DROP TABLE rpg_catalog_publication_attestations;
    DROP TABLE campaign_content_catalog_pins; DROP TABLE campaign_content_catalog_selections;
    DROP TABLE rpg_catalog_definitions; DROP TABLE rpg_content_pack_publications;
    UPDATE meta SET value='15' WHERE key='schemaVersion'`);
  db.close();
}

function populatedV16(dir: string): { campaignId: string } {
  const repo=createRepository({dataDir:dir});
  repo.installMechanicsStarterCatalog("local-owner");
  const campaign=repo.createCampaign("local-owner",{name:"Populated v16"});
  repo.configureCampaignContent("local-owner",campaign.id,{rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,
    contentPacks:[{packId:MECHANICS_STARTER_CATALOG.manifest.packId,packVersion:MECHANICS_STARTER_CATALOG.manifest.packVersion}]});
  repo.close();
  const db=new DatabaseDriver(file(dir));
  removeFutureCharacterBuilderSchema(db);
  const digest=createHash("sha256").update(canonicalCatalogJson({
    rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,
    contentPacks:[{packId:MECHANICS_STARTER_CATALOG.manifest.packId,packVersion:MECHANICS_STARTER_CATALOG.manifest.packVersion}],
  })).digest("hex"),at="2031-01-01T00:00:00.000Z";
  db.prepare(`INSERT INTO campaign_content_catalog_selections VALUES (?,?,?,?,?)`).run(campaign.id,
    MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,digest,"local-owner",at);
  db.prepare(`INSERT INTO campaign_content_catalog_pins VALUES (?,?,?,0)`).run(campaign.id,
    MECHANICS_STARTER_CATALOG.manifest.packId,MECHANICS_STARTER_CATALOG.manifest.packVersion);
  const v17Tables=["campaign_catalog_command_provenance_v18","campaign_catalog_current_pins","campaign_catalog_current_selections","campaign_catalog_receipts",
    "campaign_catalog_events","campaign_catalog_commands","rpg_catalog_publication_submissions",
    "rpg_catalog_definition_visibility","rpg_catalog_publication_attestations"];
  const triggers=db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND (tbl_name IN (${v17Tables.map(()=>"?").join(",")})
    OR name IN ('campaign_administration_commands_reject_catalog_identity','campaign_administration_events_reject_catalog_revision'))`)
    .all(...v17Tables) as Array<{name:string}>;
  for(const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  for(const table of v17Tables) db.exec(`DROP TABLE ${table}`);
  db.prepare("UPDATE meta SET value='16' WHERE key='schemaVersion'").run(); db.close();
  return {campaignId:campaign.id};
}

function populatedV17(dir:string):{campaignId:string}{
  const repo=createRepository({dataDir:dir});repo.installMechanicsStarterCatalog("local-owner");
  const campaign=repo.createCampaign("local-owner",{name:"Populated v17"});
  repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"v17-config"});repo.close();
  const db=new DatabaseDriver(file(dir));
  removeFutureCharacterBuilderSchema(db);
  const triggers=db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND
    (tbl_name='campaign_catalog_command_provenance_v18' OR name IN
      ('campaign_catalog_commands_validate_requested_v18','campaign_catalog_events_require_proposal_v18','campaign_catalog_receipts_require_proposal_v18'))`)
    .all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec("DROP INDEX idx_campaign_catalog_command_provenance_v18_event; DROP TABLE campaign_catalog_command_provenance_v18");
  db.prepare("UPDATE meta SET value='17' WHERE key='schemaVersion'").run();db.close();return{campaignId:campaign.id};
}

describe("additive schema v15 through v18 migration", () => {
  it("matches fresh DDL, preserves populated v15 rows, and labels sealed packs honestly", () => {
    const migratedDir = makeDir(); rewindToV15(migratedDir);
    const before = new DatabaseDriver(file(migratedDir), { readonly: true });
    const preserved = {
      pack: before.prepare("SELECT * FROM rpg_content_packs").get(),
      definitions: before.prepare("SELECT * FROM rpg_definitions ORDER BY kind,definition_id").all(),
      profile: before.prepare("SELECT * FROM campaign_rules_profiles").get(),
      pins: before.prepare("SELECT * FROM campaign_content_packs").all(),
      campaign: before.prepare("SELECT id,name,lifecycle_status,settings,administration_revision FROM campaigns").get(),
      memberships: before.prepare("SELECT campaign_id,principal_id,role,created_at FROM campaign_memberships ORDER BY principal_id").all(),
      timelineHistory: before.prepare("SELECT campaign_id,timeline_id,parent_timeline_id FROM campaign_timeline_history").all(),
      administrationEvents: before.prepare("SELECT type,revision FROM campaign_administration_events ORDER BY revision").all(),
    }; before.close();
    createRepository({ dataDir: migratedDir }).close();
    const migrated = new DatabaseDriver(file(migratedDir), { readonly: true });
    expect({
      pack: migrated.prepare("SELECT * FROM rpg_content_packs").get(),
      definitions: migrated.prepare("SELECT * FROM rpg_definitions ORDER BY kind,definition_id").all(),
      profile: migrated.prepare("SELECT * FROM campaign_rules_profiles").get(),
      pins: migrated.prepare("SELECT * FROM campaign_content_packs").all(),
      campaign: migrated.prepare("SELECT id,name,lifecycle_status,settings,administration_revision FROM campaigns").get(),
      memberships: migrated.prepare("SELECT campaign_id,principal_id,role,created_at FROM campaign_memberships ORDER BY principal_id").all(),
      timelineHistory: migrated.prepare("SELECT campaign_id,timeline_id,parent_timeline_id FROM campaign_timeline_history").all(),
      administrationEvents: migrated.prepare("SELECT type,revision FROM campaign_administration_events ORDER BY revision").all(),
    }).toEqual(preserved);
    expect(migrated.prepare("SELECT validation_level,manifest_digest,manifest_json,provenance_json FROM rpg_content_pack_publications").get())
      .toEqual({ validation_level: "legacy-v10", manifest_digest: null, manifest_json: null, provenance_json: null });
    expect(migrated.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "24" });
    migrated.close();
    const freshDir = makeDir(); createRepository({ dataDir: freshDir }).close();
    expect(schema(file(migratedDir))).toEqual(schema(file(freshDir)));
  });

  it("rolls back a late migration failure without changing the v15 marker or content", () => {
    const dir = makeDir(); rewindToV15(dir);
    const db = new DatabaseDriver(file(dir));
    db.exec("CREATE TABLE campaign_content_catalog_pins (poison TEXT)"); db.close();
    expect(() => createRepository({ dataDir: dir })).toThrow();
    const failed = new DatabaseDriver(file(dir), { readonly: true });
    expect(failed.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "15" });
    expect(failed.prepare("SELECT pack_id,sealed FROM rpg_content_packs").get()).toEqual({ pack_id: "legacy-pack", sealed: 1 });
    expect(failed.prepare("SELECT COUNT(*) count FROM rpg_definitions").get()).toEqual({ count: 7 });
    expect(failed.prepare("SELECT COUNT(*) count FROM campaign_content_packs").get()).toEqual({ count: 1 });
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rpg_content_pack_publications'").get()).toBeUndefined();
    failed.close();
  });

  it("upgrades a genuinely populated marker-v16 catalog and selection to v18 losslessly",()=>{
    const dir=makeDir(),{campaignId}=populatedV16(dir);
    createRepository({dataDir:dir}).close();
    const db=new DatabaseDriver(file(dir),{readonly:true});
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"24"});
    expect(db.prepare("SELECT COUNT(*) count FROM rpg_catalog_definition_visibility").get()).toEqual({count:17});
    expect(db.prepare("SELECT campaign_id FROM campaign_catalog_current_selections").get()).toEqual({campaign_id:campaignId});
    expect(db.prepare("SELECT revision,type FROM campaign_imported_administration_events WHERE campaign_id=?").all(campaignId)).toEqual([]);
    expect(db.prepare("SELECT revision FROM campaign_catalog_events WHERE campaign_id=?").get(campaignId)).toEqual({revision:1});
    expect(db.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(campaignId)).toEqual({administration_revision:1});
    db.close();
    const fresh=makeDir();createRepository({dataDir:fresh}).close();
    expect(schema(file(dir))).toEqual(schema(file(fresh)));
  });

  it("rejects a partial marker-v16 schema and rolls back every v17 artifact",()=>{
    const dir=makeDir();populatedV16(dir);
    const damage=new DatabaseDriver(file(dir));
    damage.exec("DROP TRIGGER rpg_catalog_definitions_immutable_delete; DROP TABLE rpg_catalog_definitions");damage.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("schema v16 artifact rpg_catalog_definitions is missing");
    const db=new DatabaseDriver(file(dir),{readonly:true});
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"16"});
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rpg_catalog_publication_attestations'").get()).toBeUndefined();
    db.close();
  });

  it.each([
    ["index","DROP INDEX idx_rpg_catalog_definitions_pack","idx_rpg_catalog_definitions_pack"],
    ["trigger","DROP TRIGGER campaign_content_catalog_pins_prevent_replace","campaign_content_catalog_pins_prevent_replace"],
  ])("rejects marker-v16 with a missing %s",(_kind,statement,name)=>{
    const dir=makeDir();populatedV16(dir);const damage=new DatabaseDriver(file(dir));damage.exec(statement);damage.close();
    expect(()=>createRepository({dataDir:dir})).toThrow(`schema v16 artifact ${name} is missing`);
    const db=new DatabaseDriver(file(dir),{readonly:true});
      expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"16"});db.close();
  });

  it("rejects marker-v16 with an incompatible column shape transactionally",()=>{
    const dir=makeDir();populatedV16(dir);const damage=new DatabaseDriver(file(dir));
    damage.exec("ALTER TABLE rpg_catalog_definitions RENAME COLUMN dependencies_json TO dependencies_broken_json");damage.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("schema v16 artifact rpg_catalog_definitions columns are incompatible");
    const db=new DatabaseDriver(file(dir),{readonly:true});
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"16"});
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rpg_catalog_publication_attestations'").get()).toBeUndefined();
    db.close();
  });

  it("derives v17 visibility only from strict full definitions and ignores forged v16 public sidecars",()=>{
    const dir=makeDir(),{campaignId}=populatedV16(dir);const damage=new DatabaseDriver(file(dir));
    damage.exec(`DROP TRIGGER rpg_catalog_definitions_immutable_update;
      UPDATE rpg_catalog_definitions SET public_definition_json='{"forged":"migration-leak"}' WHERE kind='ability';
      CREATE TRIGGER rpg_catalog_definitions_immutable_update BEFORE UPDATE ON rpg_catalog_definitions
        BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;`);damage.close();
    const repo=createRepository({dataDir:dir});
    expect(JSON.stringify(repo.listCampaignContentPackDefinitions("local-owner",campaignId,{
      packId:MECHANICS_STARTER_CATALOG.manifest.packId,packVersion:MECHANICS_STARTER_CATALOG.manifest.packVersion}))).not.toContain("migration-leak");
    repo.close();const db=new DatabaseDriver(file(dir),{readonly:true});
    expect(JSON.stringify(db.prepare("SELECT public_definition_json FROM rpg_catalog_definition_visibility").all())).not.toContain("migration-leak");
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"24"});db.close();
  });

  it("rolls back marker-v16 migration when the strict full definition graph is forged",()=>{
    const dir=makeDir();populatedV16(dir);const damage=new DatabaseDriver(file(dir));
    damage.exec(`DROP TRIGGER rpg_catalog_definitions_immutable_update;
      UPDATE rpg_catalog_definitions SET definition_json='{"forged":"invalid-full-graph"}' WHERE kind='ability';
      CREATE TRIGGER rpg_catalog_definitions_immutable_update BEFORE UPDATE ON rpg_catalog_definitions
        BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;`);damage.close();
    expect(()=>createRepository({dataDir:dir})).toThrow("schema v16 validated publication graph is invalid");
    const db=new DatabaseDriver(file(dir),{readonly:true});
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"16"});
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='rpg_catalog_definition_visibility'").get()).toBeUndefined();db.close();
  });

  it("upgrades a valid populated marker-v17 additively with fresh-v18 DDL parity",()=>{
    const dir=makeDir(),{campaignId}=populatedV17(dir);createRepository({dataDir:dir}).close();
    const db=new DatabaseDriver(file(dir),{readonly:true});
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"24"});
    expect(db.prepare("SELECT proposed_event_id FROM campaign_catalog_command_provenance_v18 WHERE campaign_id=?").get(campaignId))
      .toEqual({proposed_event_id:"v17-config"});db.close();
    const fresh=makeDir();createRepository({dataDir:fresh}).close();expect(schema(file(dir))).toEqual(schema(file(fresh)));
  });

  it.each([
    ["trigger","DROP TRIGGER campaign_catalog_events_validate_provenance","campaign_catalog_events_validate_provenance"],
    ["column","ALTER TABLE campaign_catalog_receipts ADD COLUMN forged_extra TEXT","campaign_catalog_receipts columns are incompatible"],
  ])("rejects marker-v17 with an incompatible %s transactionally",(_kind,statement,artifact)=>{
    const dir=makeDir();populatedV17(dir);const damage=new DatabaseDriver(file(dir));damage.exec(statement);damage.close();
    expect(()=>createRepository({dataDir:dir})).toThrow(`schema v17 artifact ${artifact}${artifact.includes("columns")?"":" is missing"}`);
    const db=new DatabaseDriver(file(dir),{readonly:true});
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"17"});
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='campaign_catalog_command_provenance_v18'").get()).toBeUndefined();db.close();
  });
});
