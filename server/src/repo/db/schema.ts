// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { STORY_V34_MANAGED_OBJECTS } from "./migrations/v34_story_domain.js";
import { ADVENTURE_GENERATION_V35_MANAGED_OBJECTS } from "./migrations/v35_adventure_generation.js";
import { ADVENTURE_HARDENING_V36_MANAGED_OBJECTS, assertAdventureGenerationLayoutV35Canonical,
  assertAdventureHardeningLayoutV36, restoreAdventureGenerationV35Guards } from "./migrations/v36_adventure_hardening.js";
import { TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS, assertToolExecutionBindingLayoutV37 } from "./migrations/v37_tool_execution_bindings.js";
import { DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS, assertDurableAgentExecutionLayoutV38 } from "./migrations/v38_durable_agent_execution.js";
import { assertAgentResponseProvenanceLayoutV39 } from "./migrations/v39_agent_response_provenance.js";
import { assertConfirmationPolicyLayoutV40, restorePreV40CoordinationGuards } from "./migrations/v40_confirmation_policy.js";

type SchemaDependency = (db: DatabaseDriver.Database) => void;
type SchemaDependencies = Record<
  | "assertCampaignContentPacksHaveExactSealedPacks" | "assertCampaignImportStagingV30"
  | "assertEncounterLifecycleV31"
  | "assertWorldNarrativeV32" | "assertQuestDomainV33" | "assertStoryDomainV34" | "assertAdventureGenerationV35" | "assertAdventureHardeningV36" | "assertToolExecutionBindingsV37" | "assertDurableAgentExecutionV38" | "assertAgentResponseProvenanceV39" | "assertConfirmationPolicyV40"
  | "assertCharacterBuilderLayoutV22" | "assertCharacterLayoutV29" | "assertCharacterProgressionLayoutV23"
  | "assertCharacterProgressionLayoutV24" | "assertChecksPowersEffectsLayoutV26" | "assertCombatFoundationLayoutV27"
  | "assertResourcesInventoryEconomyRestLayoutV25" | "assertWorldTravelNpcFactionLayoutV28"
  | "createCampaignAdministrationV15" | "createCampaignContentPackSealedPinTriggers" | "createCampaignEventMatchingTriggerV14"
  | "createCampaignImportStagingV30" | "createEncounterLifecycleV31" | "createWorldNarrativeV32" | "createQuestDomainV33" | "createStoryDomainV34" | "createAdventureGenerationV35"
  | "createCharacterBuilderIntegrityV21" | "createCharacterBuilderIntegrityV22" | "createCharacterBuilderProvenanceV20"
  | "createCharacterBuilderV19" | "createCharacterLayoutV29" | "createCharacterProgressionIntegrityV24"
  | "createCharacterProgressionV23" | "createChecksPowersEffectsV26" | "createCombatFoundationV27"
  | "createContentCatalogV16" | "createContentCatalogV17" | "createContentCatalogV18" | "createQuestsV29r2"
  | "createResourcesInventoryEconomyRestV25" | "createRpgCommandAuditV14" | "createSchemaV11"
  | "createTimelineRevisionV12" | "createWorldTravelNpcFactionV28" | "createAdventureHardeningV36" | "createToolExecutionBindingsV37" | "createDurableAgentExecutionV38" | "createAgentResponseProvenanceV39" | "createConfirmationPolicyV40"
  | "migrate2to3" | "migrate3to4" | "migrate4to5" | "migrate5to6" | "migrate6to7" | "migrate7to8"
  | "migrate8to9" | "migrate9to10" | "migrate10to11" | "migrate11to12" | "migrate12to13" | "migrate13to14"
  | "migrate14to15" | "migrate15to16" | "migrate16to17" | "migrate17to18" | "migrate18to19" | "migrate19to20"
  | "migrate20to21" | "migrate21to22" | "migrate22to23" | "migrate23to24" | "migrate24to25" | "migrate25to26"
  | "migrate26to27" | "migrate27to28" | "migrate28to29" | "migrate29to30" | "migrate30to31" | "migrate31to32" | "migrate32to33" | "migrate33to34" | "migrate34to35" | "migrate35to36" | "migrate36to37" | "migrate37to38" | "migrate38to39" | "migrate39to40"
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

export const SCHEMA_VERSION = "40";
export const SCHEMA_REVISION = "1";

const V34_TABLE_DROP_ORDER = ["story_layout_attestation_v34", "story_discoveries_v34", "story_clue_sources_v34", "story_clues_v34",
  "story_plot_point_answers_v34", "story_plot_points_v34", "story_edges_v34", "story_node_state_v34", "story_nodes_v34",
  "story_metadata_v34", "story_events_v34", "story_receipts_v34", "story_commands_v34", "story_campaign_revisions_v34"] as const;
const V35_TABLE_DROP_ORDER = ["adventure_generation_layout_attestation_v35", "final_receipt_links", "review_decisions",
  "generation_drafts", "provider_call_metadata", "confirmation_decisions", "tool_proposals", "adventure_turns"] as const;
const V36_TABLE_DROP_ORDER = ["adventure_hardening_layout_attestation_v36", "generation_draft_apply_receipts_v36",
  "turn_mechanics_links_v36", "adventure_coordination_receipts_v36", "adventure_coordination_events_v36",
  "adventure_coordination_commands_v36"] as const;
const V37_TABLE_DROP_ORDER = ["tool_execution_binding_layout_attestation_v37", "tool_proposal_execution_bindings_v37"] as const;
const V38_TABLE_DROP_ORDER = ["durable_agent_execution_layout_attestation_v38",
  "agent_read_outcomes_v38", "agent_decision_batch_seals_v38", "agent_tool_calls_v38", "agent_decision_rounds_v38",
  "agent_provider_starts_v38", "agent_execution_operations_v38", "adventure_agent_executions_v38"] as const;

function cleanupFutureAgentResponseV39(db:DatabaseDriver.Database,marker:string):void{
  const artifacts=db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v39*' AND sql IS NOT NULL").all() as Array<{type:string;name:string}>;
  if(!artifacts.length)return;try{assertAgentResponseProvenanceLayoutV39(db);}catch(error){throw new Error(`schema marker ${marker} contains malformed future v39 artifacts`,{cause:error});}
  for(const table of ["agent_provider_contexts_v39","agent_provider_dispatch_claims_v39","agent_provider_responses_v39","agent_combat_proposal_bindings_v39","agent_generalized_receipts_v39"]){
    if(!artifacts.some((artifact)=>artifact.type==="table"&&artifact.name===table))continue;
    const count=(db.prepare(`SELECT count(*) count FROM ${table}`).get() as {count:number}).count;if(count)throw new Error(`schema marker ${marker} contains populated future v39 artifacts`);
  }
  db.transaction(()=>{for(const {name} of artifacts.filter(({type})=>type==="trigger"))db.exec(`DROP TRIGGER "${name}"`);
    for(const name of ["agent_response_provenance_attestation_v39","agent_generalized_receipts_v39","agent_combat_proposal_bindings_v39",
      "agent_provider_responses_v39","agent_provider_dispatch_claims_v39","agent_provider_contexts_v39"])
      if(artifacts.some((artifact)=>artifact.type==="table"&&artifact.name===name))db.exec(`DROP TABLE "${name}"`);
  })();
}

function cleanupFutureConfirmationPolicyV40(db:DatabaseDriver.Database,marker:string):void{
  const artifacts=db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v40*' AND sql IS NOT NULL").all() as Array<{type:string;name:string}>;
  if(!artifacts.length)return;try{assertConfirmationPolicyLayoutV40(db);}catch(error){throw new Error(`schema marker ${marker} contains malformed future v40 artifacts`,{cause:error});}
  for(const table of ["confirmation_policy_attestations_v40","agent_mutation_accounting_v40","agent_replan_requirements_v40","confirmation_authority_evidence_v40","confirmation_expiration_operations_v40"]){const row=db.prepare(`SELECT count(*) count FROM ${table}`).get() as {count:number};
    if(row.count)throw new Error(`schema marker ${marker} contains populated future v40 artifact ${table}`);}
  db.transaction(()=>{restorePreV40CoordinationGuards(db);for(const artifact of artifacts.filter(({type})=>type==="trigger"))db.exec(`DROP TRIGGER "${artifact.name}"`);
    for(const table of ["confirmation_policy_layout_attestation_v40","confirmation_authority_evidence_v40","confirmation_expiration_operations_v40","agent_replan_requirements_v40","agent_mutation_accounting_v40","confirmation_policy_attestations_v40"])
      if(artifacts.some((artifact)=>artifact.type==="table"&&artifact.name===table))db.exec(`DROP TABLE "${table}"`);})();
}

/** Removes only a canonical empty v38 shell from a rewound historical fixture. */
function cleanupFutureDurableAgentExecutionV38(db: DatabaseDriver.Database, marker: string): void {
  const names = DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS.map(([, name]) => name);
  const artifacts = db.prepare(`SELECT type,name FROM sqlite_master WHERE (name IN (${names.map(() => "?").join(",")}) OR name GLOB '*v38*') AND sql IS NOT NULL ORDER BY type,name`)
    .all(...names) as Array<{ type: string; name: string }>;
  if (artifacts.length === 0) return;
  try { assertDurableAgentExecutionLayoutV38(db); } catch (error) {
    throw new Error(`schema marker ${marker} contains malformed partial future v38 artifacts`, { cause: error });
  }
  for (const table of V38_TABLE_DROP_ORDER) {
    if (table === "durable_agent_execution_layout_attestation_v38" || table === "adventure_agent_executions_v38") continue;
    const count = (db.prepare(`SELECT count(*) count FROM "${table}"`).get() as { count: number }).count;
    if (count !== 0) throw new Error(`schema marker ${marker} cannot contain populated future v38 durable execution artifact ${table}`);
  }
  const hasTurns = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adventure_turns'").get());
  const runCount = (db.prepare("SELECT count(*) count FROM adventure_agent_executions_v38").get() as { count: number }).count;
  const nonDefaultRun = !hasTurns ? runCount > 0 : db.prepare(`SELECT run.turn_id FROM adventure_agent_executions_v38 run JOIN adventure_turns turn
    ON turn.campaign_id=run.campaign_id AND turn.id=run.turn_id WHERE run.tool_registry_version<>'v1'
      OR run.max_decision_rounds<>5 OR run.max_tool_calls<>12 OR run.max_mutation_calls<>4 OR run.max_provider_calls<>7
      OR run.max_duration_ms<>90000 OR run.started_at<>turn.created_at
      OR run.deadline_at<>strftime('%Y-%m-%dT%H:%M:%fZ',turn.created_at,'+90 seconds') LIMIT 1`).get();
  const missingRun = hasTurns && db.prepare(`SELECT turn.id FROM adventure_turns turn LEFT JOIN adventure_agent_executions_v38 run
    ON run.campaign_id=turn.campaign_id AND run.turn_id=turn.id WHERE run.turn_id IS NULL LIMIT 1`).get();
  if (nonDefaultRun || missingRun) throw new Error(`schema marker ${marker} cannot contain non-derived future v38 durable execution envelopes`);
  db.transaction(() => {
    for (const artifact of artifacts) if (artifact.type === "trigger") db.exec(`DROP TRIGGER "${artifact.name}"`);
    for (const artifact of artifacts) if (artifact.type === "index") db.exec(`DROP INDEX IF EXISTS "${artifact.name}"`);
    for (const table of V38_TABLE_DROP_ORDER) db.exec(`DROP TABLE "${table}"`);
  })();
}

/** Removes only a canonical empty v37 sidecar from rewound historical fixtures. */
function cleanupFutureToolExecutionBindingsV37(db: DatabaseDriver.Database, marker: string): void {
  const names = TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS.map(([, name]) => name);
  const artifacts = db.prepare(`SELECT type,name FROM sqlite_master WHERE (name IN (${names.map(() => "?").join(",")}) OR name GLOB '*v37*') AND sql IS NOT NULL ORDER BY type,name`)
    .all(...names) as Array<{ type: string; name: string }>;
  if (artifacts.length === 0) return;
  try { assertToolExecutionBindingLayoutV37(db); } catch (error) {
    throw new Error(`schema marker ${marker} contains malformed partial future v37 artifacts`, { cause: error });
  }
  const count = (db.prepare("SELECT count(*) count FROM tool_proposal_execution_bindings_v37").get() as { count: number }).count;
  if (count !== 0) throw new Error(`schema marker ${marker} cannot contain populated future v37 tool execution bindings`);
  db.transaction(() => {
    for (const artifact of artifacts) if (artifact.type === "trigger") db.exec(`DROP TRIGGER "${artifact.name}"`);
    for (const artifact of artifacts) if (artifact.type === "index") db.exec(`DROP INDEX IF EXISTS "${artifact.name}"`);
    for (const table of V37_TABLE_DROP_ORDER) db.exec(`DROP TABLE "${table}"`);
  })();
}

/** Historical fixtures may carry an empty current-schema shell. Inventory and remove it atomically. */
function cleanupFutureStoryV34(db: DatabaseDriver.Database, marker: string): void {
  const artifacts = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v34*' AND sql IS NOT NULL ORDER BY type,name").all() as Array<{ type: string; name: string }>;
  if (artifacts.length === 0) return;
  const expected = new Set(STORY_V34_MANAGED_OBJECTS.map(([type, name]) => `${type}:${name}`));
  const unknown = artifacts.find((artifact) => !expected.has(`${artifact.type}:${artifact.name}`));
  if (unknown) throw new Error(`schema marker ${marker} contains unknown partial future v34 artifact ${unknown.name}`);
  for (const artifact of artifacts) {
    if (artifact.type !== "table" || artifact.name === "story_layout_attestation_v34") continue;
    const count = (db.prepare(`SELECT count(*) count FROM "${artifact.name}"`).get() as { count: number }).count;
    if (count > 0) throw new Error(`schema marker ${marker} cannot contain populated future v34 story artifact ${artifact.name}`);
  }
  db.transaction(() => {
    for (const artifact of artifacts) if (artifact.type === "trigger") db.exec(`DROP TRIGGER "${artifact.name}"`);
    for (const table of V34_TABLE_DROP_ORDER) db.exec(`DROP TABLE IF EXISTS "${table}"`);
    for (const artifact of artifacts) if (artifact.type === "index") db.exec(`DROP INDEX IF EXISTS "${artifact.name}"`);
  })();
}

/** Removes only an exact, empty v35 shell left by a rewound historical fixture. */
function cleanupFutureAdventureGenerationV35(db: DatabaseDriver.Database, marker: string): void {
  const managedNames = ADVENTURE_GENERATION_V35_MANAGED_OBJECTS.map(([, name]) => name);
  const artifacts = db.prepare(`SELECT type,name FROM sqlite_master WHERE
    name IN (${managedNames.map(() => "?").join(",")}) OR name GLOB '*v35*' ORDER BY type,name`).all(...managedNames) as Array<{ type: string; name: string }>;
  if (artifacts.length === 0) return;
  const expected = new Set(ADVENTURE_GENERATION_V35_MANAGED_OBJECTS.map(([type, name]) => `${type}:${name}`));
  const unknown = artifacts.find(({ type, name }) => !expected.has(`${type}:${name}`));
  if (unknown) throw new Error(`schema marker ${marker} contains unknown partial future v35 artifact ${unknown.name}`);
  try { assertAdventureGenerationLayoutV35Canonical(db); } catch (error) {
    throw new Error(`schema marker ${marker} contains malformed partial future v35 artifacts`, { cause: error });
  }
  for (const table of V35_TABLE_DROP_ORDER) {
    if (table === "adventure_generation_layout_attestation_v35" || !artifacts.some((artifact) => artifact.type === "table" && artifact.name === table)) continue;
    const count = (db.prepare(`SELECT count(*) count FROM "${table}"`).get() as { count: number }).count;
    if (count > 0) throw new Error(`schema marker ${marker} cannot contain populated future v35 adventure/generation artifact ${table}`);
  }
  db.transaction(() => {
    for (const artifact of artifacts) if (artifact.type === "trigger") db.exec(`DROP TRIGGER "${artifact.name}"`);
    for (const table of V35_TABLE_DROP_ORDER) db.exec(`DROP TABLE IF EXISTS "${table}"`);
    for (const artifact of artifacts) if (artifact.type === "index") db.exec(`DROP INDEX IF EXISTS "${artifact.name}"`);
  })();
}

/** Removes only the complete canonical empty v36 layout; partial or modified artifacts are evidence of corruption. */
function cleanupFutureAdventureHardeningV36(db: DatabaseDriver.Database, marker: string): void {
  const names = ADVENTURE_HARDENING_V36_MANAGED_OBJECTS.map(([, name]) => name);
  const artifacts = db.prepare(`SELECT type,name FROM sqlite_master WHERE (name IN (${names.map(() => "?").join(",")}) OR name GLOB '*v36*') AND sql IS NOT NULL ORDER BY type,name`).all(...names) as Array<{ type: string; name: string }>;
  if (artifacts.length === 0) return;
  try { assertAdventureHardeningLayoutV36(db); } catch (error) {
    throw new Error(`schema marker ${marker} contains malformed partial future v36 artifacts`, { cause: error });
  }
  for (const table of V36_TABLE_DROP_ORDER) {
    if (table === "adventure_hardening_layout_attestation_v36") continue;
    const count = (db.prepare(`SELECT count(*) count FROM "${table}"`).get() as { count: number }).count;
    if (count !== 0) throw new Error(`schema marker ${marker} cannot contain populated future v36 adventure hardening artifact ${table}`);
  }
  db.transaction(() => {
    for (const artifact of artifacts) if (artifact.type === "trigger") db.exec(`DROP TRIGGER "${artifact.name}"`);
    for (const artifact of artifacts) if (artifact.type === "index") db.exec(`DROP INDEX IF EXISTS "${artifact.name}"`);
    for (const table of V36_TABLE_DROP_ORDER) db.exec(`DROP TABLE "${table}"`);
    restoreAdventureGenerationV35Guards(db);
  })();
}

export function ensureSchema(db: DatabaseDriver.Database): void {
  const {
    assertCampaignImportStagingV30, assertEncounterLifecycleV31, assertWorldNarrativeV32, assertQuestDomainV33, assertStoryDomainV34, assertAdventureHardeningV36, assertToolExecutionBindingsV37, assertDurableAgentExecutionV38, assertAgentResponseProvenanceV39, assertConfirmationPolicyV40, assertCharacterBuilderLayoutV22, assertCharacterLayoutV29, assertCharacterProgressionLayoutV23,
    assertCharacterProgressionLayoutV24, assertChecksPowersEffectsLayoutV26, assertCombatFoundationLayoutV27,
    assertResourcesInventoryEconomyRestLayoutV25, assertWorldTravelNpcFactionLayoutV28,
    createCampaignAdministrationV15, createCampaignEventMatchingTriggerV14, createCampaignImportStagingV30, createCharacterBuilderIntegrityV21,
    createCharacterBuilderIntegrityV22, createCharacterBuilderProvenanceV20, createCharacterBuilderV19,
    createCharacterLayoutV29, createCharacterProgressionIntegrityV24, createCharacterProgressionV23,
    createChecksPowersEffectsV26, createCombatFoundationV27, createContentCatalogV16, createContentCatalogV17,
    createContentCatalogV18, createEncounterLifecycleV31, createWorldNarrativeV32, createQuestDomainV33, createStoryDomainV34, createAdventureGenerationV35, createAdventureHardeningV36, createToolExecutionBindingsV37, createDurableAgentExecutionV38, createAgentResponseProvenanceV39, createConfirmationPolicyV40, createQuestsV29r2, createResourcesInventoryEconomyRestV25, createRpgCommandAuditV14,
    createSchemaV11, createTimelineRevisionV12, createWorldTravelNpcFactionV28, migrate2to3, migrate3to4,
    migrate4to5, migrate5to6, migrate6to7, migrate7to8, migrate8to9, migrate9to10, migrate10to11,
    migrate11to12, migrate12to13, migrate13to14, migrate14to15, migrate15to16, migrate16to17, migrate17to18,
    migrate18to19, migrate19to20, migrate20to21, migrate21to22, migrate22to23, migrate23to24, migrate24to25,
    migrate25to26, migrate26to27, migrate27to28, migrate28to29, migrate29to30, migrate30to31, migrate31to32, migrate32to33, migrate33to34, migrate34to35, migrate35to36, migrate36to37, migrate37to38, migrate38to39, migrate39to40, validateCharacterProgressionV23,
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
              createQuestDomainV33(db);
               createStoryDomainV34(db);
               createAdventureGenerationV35(db);
                createAdventureHardeningV36(db);
                 createToolExecutionBindingsV37(db);
                  createDurableAgentExecutionV38(db);
                   createAgentResponseProvenanceV39(db);
                   createConfirmationPolicyV40(db);
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
    assertQuestDomainV33(db);
    assertStoryDomainV34(db);
    assertToolExecutionBindingsV37(db);
    assertDurableAgentExecutionV38(db);
    assertAgentResponseProvenanceV39(db);
    assertConfirmationPolicyV40(db);
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
  const futureQuestArtifact=Number(version)<33&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='quest_domain_revisions_v33'").get();
  if(futureQuestArtifact){
    const count=(db.prepare("SELECT count(*) count FROM quest_domain_commands_v33").get() as {count:number}).count;
    if(count>0)throw new Error(`schema marker ${version} cannot contain populated future v33 quest artifacts`);
    db.exec(`DROP TRIGGER IF EXISTS quest_domain_layout_attestation_v33_immutable_delete;DROP TRIGGER IF EXISTS quest_domain_layout_attestation_v33_immutable_update;
      DROP TRIGGER IF EXISTS quest_journal_v33_immutable_delete;DROP TRIGGER IF EXISTS quest_journal_v33_immutable_update;
      DROP TRIGGER IF EXISTS quest_reward_claims_v33_immutable_delete;DROP TRIGGER IF EXISTS quest_reward_claims_v33_immutable_update;
      DROP TRIGGER IF EXISTS quest_reward_definitions_v33_immutable_delete;DROP TRIGGER IF EXISTS quest_reward_definitions_v33_immutable_update;
      DROP TRIGGER IF EXISTS quest_objective_dependencies_v33_immutable_delete;DROP TRIGGER IF EXISTS quest_objective_dependencies_v33_immutable_update;
      DROP TRIGGER IF EXISTS quest_objectives_v33_immutable_delete;DROP TRIGGER IF EXISTS quest_objectives_v33_immutable_update;
      DROP TRIGGER IF EXISTS quest_definitions_v33_immutable_delete;DROP TRIGGER IF EXISTS quest_definitions_v33_immutable_update;
      DROP TRIGGER IF EXISTS quest_domain_events_v33_immutable_delete;DROP TRIGGER IF EXISTS quest_domain_events_v33_immutable_update;
      DROP TRIGGER IF EXISTS quest_domain_receipts_v33_immutable_delete;DROP TRIGGER IF EXISTS quest_domain_receipts_v33_immutable_update;
      DROP TRIGGER IF EXISTS quest_domain_commands_v33_immutable_delete;DROP TRIGGER IF EXISTS quest_domain_commands_v33_immutable_update;
      DROP TABLE quest_domain_layout_attestation_v33;DROP TABLE quest_journal_v33;DROP TABLE quest_reward_claims_v33;
      DROP TABLE quest_reward_definitions_v33;DROP TABLE quest_objective_progress_v33;DROP TABLE quest_objective_dependencies_v33;
      DROP TABLE quest_objectives_v33;DROP TABLE quest_definitions_v33;DROP TABLE quest_domain_events_v33;
      DROP TABLE quest_domain_receipts_v33;DROP TABLE quest_domain_commands_v33;DROP TABLE quest_domain_revisions_v33;
      DROP INDEX IF EXISTS uq_quest_reward_ancestry_v33;DROP INDEX IF EXISTS uq_quest_campaign_id_v33;`);
  }
  if(Number(version)<40)cleanupFutureConfirmationPolicyV40(db,version);
  if(Number(version)<39)cleanupFutureAgentResponseV39(db,version);
  if(Number(version)<34)cleanupFutureStoryV34(db,version);
  if(Number(version)<38)cleanupFutureDurableAgentExecutionV38(db,version);
  if(Number(version)<37)cleanupFutureToolExecutionBindingsV37(db,version);
  if(Number(version)<36)cleanupFutureAdventureHardeningV36(db,version);
  if(Number(version)<35)cleanupFutureAdventureGenerationV35(db,version);
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
  if(version==="32"){
    // Very old historical fixtures acquire the additive v29r2 quest tables
    // through revision repair rather than migrate28to29 itself. V33 builds
    // ancestry constraints on those tables, so establish them first.
    ensureSchemaRevisionV29(db);
    migrate32to33(db);version="33";
  }
  if(version==="33"){migrate33to34(db);version="34";}
  if(version==="34"){migrate34to35(db);version="35";}
  if(version==="35"){migrate35to36(db);version="36";}
  if(version==="36"){migrate36to37(db);version="37";}
  if(version==="37"){migrate37to38(db);version="38";}
  if(version==="38"){migrate38to39(db);version="39";}
  if(version==="39"){migrate39to40(db);version="40";}
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
  assertQuestDomainV33(db);
  assertStoryDomainV34(db);
  assertToolExecutionBindingsV37(db);
  assertDurableAgentExecutionV38(db);
  assertAgentResponseProvenanceV39(db);
  assertConfirmationPolicyV40(db);
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
