// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";

type SchemaDependency = (db: DatabaseDriver.Database) => void;
type SchemaDependencies = Record<
  | "assertCampaignContentPacksHaveExactSealedPacks" | "assertCampaignImportStagingV30"
  | "assertEncounterLifecycleV31"
  | "assertWorldNarrativeV32"
  | "assertCharacterBuilderLayoutV22" | "assertCharacterLayoutV29" | "assertCharacterProgressionLayoutV23"
  | "assertCharacterProgressionLayoutV24" | "assertChecksPowersEffectsLayoutV26" | "assertCombatFoundationLayoutV27"
  | "assertResourcesInventoryEconomyRestLayoutV25" | "assertWorldTravelNpcFactionLayoutV28"
  | "createCampaignAdministrationV15" | "createCampaignContentPackSealedPinTriggers" | "createCampaignEventMatchingTriggerV14"
  | "createCampaignImportStagingV30" | "createEncounterLifecycleV31" | "createWorldNarrativeV32"
  | "createCharacterBuilderIntegrityV21" | "createCharacterBuilderIntegrityV22" | "createCharacterBuilderProvenanceV20"
  | "createCharacterBuilderV19" | "createCharacterLayoutV29" | "createCharacterProgressionIntegrityV24"
  | "createCharacterProgressionV23" | "createChecksPowersEffectsV26" | "createCombatFoundationV27"
  | "createContentCatalogV16" | "createContentCatalogV17" | "createContentCatalogV18" | "createQuestsV29r2"
  | "createResourcesInventoryEconomyRestV25" | "createRpgCommandAuditV14" | "createSchemaV11"
  | "createTimelineRevisionV12" | "createWorldTravelNpcFactionV28"
  | "migrate2to3" | "migrate3to4" | "migrate4to5" | "migrate5to6" | "migrate6to7" | "migrate7to8"
  | "migrate8to9" | "migrate9to10" | "migrate10to11" | "migrate11to12" | "migrate12to13" | "migrate13to14"
  | "migrate14to15" | "migrate15to16" | "migrate16to17" | "migrate17to18" | "migrate18to19" | "migrate19to20"
  | "migrate20to21" | "migrate21to22" | "migrate22to23" | "migrate23to24" | "migrate24to25" | "migrate25to26"
  | "migrate26to27" | "migrate27to28" | "migrate28to29" | "migrate29to30" | "migrate30to31" | "migrate31to32"
  | "validateCharacterProgressionV23" | "validateCharacterProgressionV24" | "validateCombatFoundationV27"
  | "validateM15PersistenceV25" | "validateM16PersistenceV26" | "validateV20DraftAudit"
  | "validateWorldTravelNpcFactionV28",
  SchemaDependency
>;

let schemaDependencies: SchemaDependencies | null = null;

export function configureSchema(dependencies: SchemaDependencies): void {
  schemaDependencies = dependencies;
}

function getSchemaDependencies(): SchemaDependencies {
  if (!schemaDependencies) throw new Error("schema is not configured");
  return schemaDependencies;
}

export const SCHEMA_VERSION = "32";
export const SCHEMA_REVISION = "1";

export function ensureSchema(db: DatabaseDriver.Database): void {
  const {
    assertCampaignImportStagingV30, assertEncounterLifecycleV31, assertWorldNarrativeV32, assertCharacterBuilderLayoutV22, assertCharacterLayoutV29, assertCharacterProgressionLayoutV23,
    assertCharacterProgressionLayoutV24, assertChecksPowersEffectsLayoutV26, assertCombatFoundationLayoutV27,
    assertResourcesInventoryEconomyRestLayoutV25, assertWorldTravelNpcFactionLayoutV28,
    createCampaignAdministrationV15, createCampaignEventMatchingTriggerV14, createCampaignImportStagingV30, createCharacterBuilderIntegrityV21,
    createCharacterBuilderIntegrityV22, createCharacterBuilderProvenanceV20, createCharacterBuilderV19,
    createCharacterLayoutV29, createCharacterProgressionIntegrityV24, createCharacterProgressionV23,
    createChecksPowersEffectsV26, createCombatFoundationV27, createContentCatalogV16, createContentCatalogV17,
    createContentCatalogV18, createEncounterLifecycleV31, createWorldNarrativeV32, createQuestsV29r2, createResourcesInventoryEconomyRestV25, createRpgCommandAuditV14,
    createSchemaV11, createTimelineRevisionV12, createWorldTravelNpcFactionV28, migrate2to3, migrate3to4,
    migrate4to5, migrate5to6, migrate6to7, migrate7to8, migrate8to9, migrate9to10, migrate10to11,
    migrate11to12, migrate12to13, migrate13to14, migrate14to15, migrate15to16, migrate16to17, migrate17to18,
    migrate18to19, migrate19to20, migrate20to21, migrate21to22, migrate22to23, migrate23to24, migrate24to25,
    migrate25to26, migrate26to27, migrate27to28, migrate28to29, migrate29to30, migrate30to31, migrate31to32, validateCharacterProgressionV23,
    validateCharacterProgressionV24, validateCombatFoundationV27, validateM15PersistenceV25,
    validateM16PersistenceV26, validateV20DraftAudit, validateWorldTravelNpcFactionV28,
  } = getSchemaDependencies();
  const hasMeta = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  ).get();
  if (!hasMeta) {
    db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string } | undefined;
  if (!row) {
    db.transaction(() => {
      createSchemaV11(db);
      createTimelineRevisionV12(db);
      createRpgCommandAuditV14(db);
      createCampaignEventMatchingTriggerV14(db);
      createCampaignAdministrationV15(db);
      createContentCatalogV16(db);
      createContentCatalogV17(db);
      createContentCatalogV18(db);
      createCharacterBuilderV19(db);
      createCharacterBuilderProvenanceV20(db);
      createCharacterBuilderIntegrityV21(db);
      createCharacterBuilderIntegrityV22(db);
      createCharacterProgressionV23(db);
      createCharacterProgressionIntegrityV24(db);
       createResourcesInventoryEconomyRestV25(db);
       createChecksPowersEffectsV26(db);
         createCombatFoundationV27(db);
          createWorldTravelNpcFactionV28(db);
           createCharacterLayoutV29(db);
           createQuestsV29r2(db);
           createCampaignImportStagingV30(db);
           createEncounterLifecycleV31(db);
           createWorldNarrativeV32(db);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)").run(SCHEMA_VERSION);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schemaRevision', ?)").run(SCHEMA_REVISION);
    })();
    assertCharacterBuilderLayoutV22(db);
    assertCharacterProgressionLayoutV23(db);
    assertCharacterProgressionLayoutV24(db);
    assertResourcesInventoryEconomyRestLayoutV25(db);
    assertChecksPowersEffectsLayoutV26(db);
    assertCombatFoundationLayoutV27(db);
    assertWorldTravelNpcFactionLayoutV28(db);
    assertCharacterLayoutV29(db);
    assertCampaignImportStagingV30(db);
    assertEncounterLifecycleV31(db);
    assertWorldNarrativeV32(db);
    validateV20DraftAudit(db);
    validateCharacterProgressionV24(db);
    validateM15PersistenceV25(db);
    validateM16PersistenceV26(db);
    validateCombatFoundationV27(db);
    validateWorldTravelNpcFactionV28(db);
    return;
  }
  let version = row.value;
  const futureBuilderArtifact = Number(version) < 19 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*character*_v19*' LIMIT 1`).get() as
      { type: string; name: string } | undefined;
  if (futureBuilderArtifact) {
    throw new Error(`schema marker ${version} cannot contain future v19 artifact ${futureBuilderArtifact.name}`);
  }
  const futureProvenanceArtifact = Number(version) < 20 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v20' OR name GLOB '*_v20_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureProvenanceArtifact) {
    throw new Error(`schema marker ${version} cannot contain future v20 artifact ${futureProvenanceArtifact.name}`);
  }
  const futureIntegrityArtifact = Number(version) < 21 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v21' OR name GLOB '*_v21_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureIntegrityArtifact) throw new Error(`schema marker ${version} cannot contain future v21 artifact ${futureIntegrityArtifact.name}`);
  const futureArchiveArtifact = Number(version) < 22 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v22' OR name GLOB '*_v22_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureArchiveArtifact) throw new Error(`schema marker ${version} cannot contain future v22 artifact ${futureArchiveArtifact.name}`);
  const futureProgressionArtifact = Number(version) < 23 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v23' OR name GLOB '*_v23_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureProgressionArtifact) throw new Error(`schema marker ${version} cannot contain future v23 artifact ${futureProgressionArtifact.name}`);
  const futureProgressionIntegrityArtifact = Number(version) < 24 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v24' OR name GLOB '*_v24_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureProgressionIntegrityArtifact) throw new Error(`schema marker ${version} cannot contain future v24 artifact ${futureProgressionIntegrityArtifact.name}`);
  const futureResourcesArtifact = Number(version) < 25 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v25' OR name GLOB '*_v25_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureResourcesArtifact) throw new Error(`schema marker ${version} cannot contain future v25 artifact ${futureResourcesArtifact.name}`);
  const futureChecksPowersEffectsArtifact = Number(version) < 26 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v26' OR name GLOB '*_v26_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureChecksPowersEffectsArtifact) throw new Error(`schema marker ${version} cannot contain future v26 artifact ${futureChecksPowersEffectsArtifact.name}`);
  const futureCombatArtifact = Number(version) < 27 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name IN ('encounter','combatant','combat_log','reward_bundle') OR name GLOB '*_v27' OR name GLOB '*_v27_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureCombatArtifact) throw new Error(`schema marker ${version} cannot contain future v27 artifact ${futureCombatArtifact.name}`);
  const futureWorldArtifact = Number(version) < 28 && db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name GLOB '*_v28' OR name GLOB '*_v28_*' LIMIT 1`).get() as { type: string; name: string } | undefined;
  if (futureWorldArtifact) throw new Error(`schema marker ${version} cannot contain future v28 artifact ${futureWorldArtifact.name}`);
  const futureCharacterLayoutArtifact = Number(version) < 29 && db.prepare("SELECT type,name FROM sqlite_master WHERE name='character_layout_attestation_v29'").get() as { type: string; name: string } | undefined;
  if (futureCharacterLayoutArtifact) throw new Error(`schema marker ${version} cannot contain future v29 artifact ${futureCharacterLayoutArtifact.name}`);
  const futureImportStagingArtifact = Number(version) < 30 && db.prepare("SELECT type,name FROM sqlite_master WHERE name='campaign_import_dry_runs_v30'").get() as { type: string; name: string } | undefined;
  if (futureImportStagingArtifact) {
    // Historical migration fixtures rewind the marker of an otherwise-current,
    // empty database. An empty additive sidecar is safe to remove; never discard
    // an actual staged import from a mis-marked database.
    const count = (db.prepare("SELECT COUNT(*) count FROM campaign_import_dry_runs_v30").get() as { count: number }).count;
    if (count > 0) throw new Error(`schema marker ${version} cannot contain future v30 artifact ${futureImportStagingArtifact.name}`);
    db.exec(`DROP TRIGGER IF EXISTS campaign_import_dry_runs_v30_immutable_update;
      DROP TRIGGER IF EXISTS campaign_import_dry_runs_v30_immutable_delete;
      DROP TRIGGER IF EXISTS campaign_import_dry_runs_v30_prevent_replace;
      DROP TABLE campaign_import_dry_runs_v30;`);
  }
  const futureEncounterLifecycleArtifact = Number(version) < 31 && db.prepare(
    "SELECT type,name FROM sqlite_master WHERE name='encounter_lifecycle_v31'",
  ).get() as { type: string; name: string } | undefined;
  if (futureEncounterLifecycleArtifact) {
    const lifecycleCount = (db.prepare("SELECT COUNT(*) count FROM encounter_lifecycle_v31").get() as { count: number }).count;
    const provenanceCount = (db.prepare("SELECT COUNT(*) count FROM encounter_enemy_provenance_v31").get() as { count: number }).count;
    if (lifecycleCount > 0 || provenanceCount > 0) {
      throw new Error(`schema marker ${version} cannot contain populated future v31 encounter lifecycle artifacts`);
    }
    db.exec(`DROP TRIGGER IF EXISTS encounter_enemy_provenance_v31_immutable_delete;
      DROP TRIGGER IF EXISTS encounter_enemy_provenance_v31_immutable_update;
      DROP TRIGGER IF EXISTS encounter_enemy_provenance_v31_exact_combatant;
      DROP TRIGGER IF EXISTS encounter_lifecycle_v31_immutable_delete;
      DROP TRIGGER IF EXISTS encounter_lifecycle_v31_immutable_update;
      DROP TRIGGER IF EXISTS encounter_lifecycle_v31_exact_ancestry;
      DROP INDEX IF EXISTS idx_encounter_enemy_provenance_v31_encounter;
      DROP INDEX IF EXISTS idx_encounter_lifecycle_v31_campaign;
      DROP TABLE encounter_enemy_provenance_v31;
      DROP TABLE encounter_lifecycle_v31;`);
  }
  const futureWorldNarrativeArtifact=Number(version)<32&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='world_narrative_revisions_v32'").get();
  if(futureWorldNarrativeArtifact){
    const count=(db.prepare("SELECT count(*) count FROM world_narrative_commands_v32").get() as {count:number}).count;
    if(count>0)throw new Error(`schema marker ${version} cannot contain populated future v32 world narrative artifacts`);
    db.exec(`DROP TRIGGER IF EXISTS campaign_faction_reputation_v32_immutable_delete;
      DROP TRIGGER IF EXISTS campaign_faction_reputation_v32_immutable_update;
      DROP TRIGGER IF EXISTS campaign_faction_metadata_v32_immutable_delete;
      DROP TRIGGER IF EXISTS campaign_faction_metadata_v32_immutable_update;
      DROP TRIGGER IF EXISTS campaign_npc_metadata_v32_immutable_delete;
      DROP TRIGGER IF EXISTS campaign_npc_metadata_v32_immutable_update;
      DROP TRIGGER IF EXISTS world_narrative_events_v32_immutable_delete;
      DROP TRIGGER IF EXISTS world_narrative_events_v32_immutable_update;
      DROP TRIGGER IF EXISTS world_narrative_receipts_v32_immutable_delete;
      DROP TRIGGER IF EXISTS world_narrative_receipts_v32_immutable_update;
      DROP TRIGGER IF EXISTS world_narrative_commands_v32_immutable_delete;
      DROP TRIGGER IF EXISTS world_narrative_commands_v32_immutable_update;
      DROP TABLE campaign_faction_reputation_v32;DROP TABLE campaign_faction_metadata_v32;
      DROP TABLE campaign_npc_relationships_v32;DROP TABLE campaign_npc_metadata_v32;
      DROP TABLE world_narrative_events_v32;DROP TABLE world_narrative_receipts_v32;
      DROP TABLE world_narrative_commands_v32;DROP TABLE world_narrative_revisions_v32;`);
  }
  if(Number(version)<18&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaign_catalog_command_provenance_v18'").get()){
    // Historical fixtures can rewind only their target marker. A genuine
    // pre-v18 database can never contain this future-derived sidecar.
    db.exec(`DROP TRIGGER IF EXISTS campaign_catalog_commands_validate_requested_v18;
      DROP TRIGGER IF EXISTS campaign_catalog_events_require_proposal_v18;
      DROP TRIGGER IF EXISTS campaign_catalog_receipts_require_proposal_v18;
      DROP TABLE campaign_catalog_command_provenance_v18;`);
  }
  if (Number(version) < 15 && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rpg_content_pack_publications'").get()) {
    // Historical migration fixtures intentionally rewind only their target
    // marker from a current database. Remove impossible future-derived
    // catalog sidecars before replaying the genuine old migration chain.
    db.exec(`
      DROP TABLE IF EXISTS campaign_catalog_command_provenance_v18;
      DROP TABLE IF EXISTS campaign_catalog_current_pins;
      DROP TABLE IF EXISTS campaign_catalog_current_selections;
      DROP TABLE IF EXISTS campaign_catalog_receipts;
      DROP TABLE IF EXISTS campaign_catalog_events;
      DROP TABLE IF EXISTS campaign_catalog_commands;
      DROP TABLE IF EXISTS rpg_catalog_publication_submissions;
      DROP TABLE IF EXISTS rpg_catalog_definition_visibility;
      DROP TABLE IF EXISTS rpg_catalog_publication_attestations;
      DROP TABLE IF EXISTS campaign_content_catalog_pins;
      DROP TABLE IF EXISTS campaign_content_catalog_selections;
      DROP TABLE IF EXISTS rpg_catalog_definitions;
      DROP TABLE IF EXISTS rpg_content_pack_publications;
      DROP TRIGGER IF EXISTS rpg_content_packs_prevent_replace_v16;
      DROP TRIGGER IF EXISTS rpg_definitions_prevent_replace_v16;
      DROP TRIGGER IF EXISTS campaign_administration_commands_reject_catalog_identity;
      DROP TRIGGER IF EXISTS campaign_administration_events_reject_catalog_revision;
      DROP TRIGGER IF EXISTS campaign_catalog_commands_validate_requested_v18;
      DROP TRIGGER IF EXISTS campaign_catalog_events_require_proposal_v18;
      DROP TRIGGER IF EXISTS campaign_catalog_receipts_require_proposal_v18;
    `);
  }
  const campaignTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaigns'").get();
  const hasAdministrationRevision = campaignTable && (db.prepare("PRAGMA table_info(campaigns)").all() as Array<{ name: string }>)
    .some((column) => column.name === "administration_revision");
  if (!hasAdministrationRevision) {
    // Migration fixtures and interrupted pre-v15 databases must not retain a
    // v15 trigger that references a column their genuine old campaign table
    // does not have. Final v15 creation reinstalls the exact triggers.
    db.exec(`DROP TRIGGER IF EXISTS campaign_administration_revision_advance;
      DROP TRIGGER IF EXISTS campaigns_prevent_updated_at_rewind;
      DROP TRIGGER IF EXISTS campaign_administration_commands_require_current_revision;
      DROP TRIGGER IF EXISTS campaign_administration_events_require_current_revision;
      DROP TRIGGER IF EXISTS campaign_administration_receipts_require_current_revision;`);
  }
  if (version === "2") {
    migrate2to3(db);
    version = "3";
  }
  if (version === "3") {
    migrate3to4(db);
    version = "4";
  }
  if (version === "4") {
    migrate4to5(db);
    version = "5";
  }
  if (version === "5") {
    migrate5to6(db);
    version = "6";
  }
  if (version === "6") {
    migrate6to7(db);
    version = "7";
  }
  if (version === "7") {
    migrate7to8(db);
    version = "8";
  }
  if (version === "8") {
    migrate8to9(db);
    version = "9";
  }
  if (version === "9") {
    migrate9to10(db);
    version = "10";
  }
  if (version === "10") {
    migrate10to11(db);
    version = "11";
  }
  if (version === "11") {
    // Revision-1 repairs are part of the v11 contract and must complete before
    // v12 builds foreign keys on top of that schema.
    ensureSchemaRevisionV11(db);
    migrate11to12(db);
    version = "12";
  }
  if (version === "12") {
    migrate12to13(db);
    version = "13";
  }
  if (version === "13") {
    // V13 revision compatibility must be established before its destructive
    // table rebuild begins. Keep the current-schema assertion below as a
    // post-migration guard as well.
    assertCurrentSchemaRevision(db);
    migrate13to14(db);
    version = "14";
  }
  if (version === "14") {
    migrate14to15(db);
    version = "15";
  }
  if (version === "15") {
    migrate15to16(db);
    version = "16";
  }
  if (version === "16") {
    migrate16to17(db);
    version = "17";
  }
  if (version === "17") {
    migrate17to18(db);
    version = "18";
  }
  if (version === "18") {
    migrate18to19(db);
    version = "19";
  }
  if (version === "19") {
    migrate19to20(db);
    version = "20";
  }
  if (version === "20") {
    migrate20to21(db);
    version = "21";
  }
  if (version === "21") {
    migrate21to22(db);
    version = "22";
  }
  if (version === "22") {
    migrate22to23(db);
    version = "23";
  }
  if (version === "23") {
    migrate23to24(db);
    version = "24";
  }
  if (version === "24") {
    migrate24to25(db);
    version = "25";
  }
  if (version === "25") {
    migrate25to26(db);
    version = "26";
  }
  if (version === "26") {
    migrate26to27(db);
    version = "27";
  }
  if (version === "27") {
    migrate27to28(db);
    version = "28";
  }
  if (version === "28") {
    migrate28to29(db);
    version = "29";
  }
  if (version === "29") {
    migrate29to30(db);
    version = "30";
  }
  if (version === "30") {
    migrate30to31(db);
    version = "31";
  }
  if(version==="31"){migrate31to32(db);version="32";}
  if (version !== SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion ${version}; expected ${SCHEMA_VERSION}`);
  }
  ensureSchemaRevisionV29(db);
  assertCurrentSchemaRevision(db);
  assertCharacterBuilderLayoutV22(db);
  assertCharacterProgressionLayoutV23(db);
  assertCharacterProgressionLayoutV24(db);
  assertResourcesInventoryEconomyRestLayoutV25(db);
  assertChecksPowersEffectsLayoutV26(db);
  assertCombatFoundationLayoutV27(db);
  assertWorldTravelNpcFactionLayoutV28(db);
  assertCharacterLayoutV29(db);
  assertCampaignImportStagingV30(db);
  assertEncounterLifecycleV31(db);
  assertWorldNarrativeV32(db);
  validateV20DraftAudit(db);
  validateCharacterProgressionV23(db);
  validateCharacterProgressionV24(db);
  validateM15PersistenceV25(db);
  validateM16PersistenceV26(db);
  validateCombatFoundationV27(db);
  validateWorldTravelNpcFactionV28(db);
}

function assertCurrentSchemaRevision(db: DatabaseDriver.Database): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get() as { value: string } | undefined;
  if (row?.value !== SCHEMA_REVISION) {
    throw new Error(`unsupported schemaRevision ${row?.value ?? "missing"}; expected ${SCHEMA_REVISION}`);
  }
}

function ensureSchemaRevisionV11(db: DatabaseDriver.Database): void {
  const { assertCampaignContentPacksHaveExactSealedPacks, createCampaignContentPackSealedPinTriggers } = getSchemaDependencies();
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaRevision'").get() as { value: string } | undefined;
  if (row?.value === "1") return;
  if (row) {
    throw new Error(`unsupported schemaRevision ${row.value}; expected 1`);
  }
  db.transaction(() => {
    assertCampaignContentPacksHaveExactSealedPacks(db);
    createCampaignContentPackSealedPinTriggers(db);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schemaRevision', '1')").run();
  })();
}

function ensureSchemaRevisionV29(db: DatabaseDriver.Database): void {
  const { createQuestsV29r2 } = getSchemaDependencies();
  const hasQuestTables = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quest_storylines'").get());
  if (!hasQuestTables) db.transaction(() => createQuestsV29r2(db))();
}
