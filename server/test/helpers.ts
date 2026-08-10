import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach } from "vitest";
import { closeRepo } from "../src/repo/index.js";
import { ADVENTURE_GENERATION_V35_MANAGED_OBJECTS } from "../src/repo/db/migrations/v35_adventure_generation.js";
import { ADVENTURE_HARDENING_V36_MANAGED_OBJECTS, restoreAdventureGenerationV35Guards } from "../src/repo/db/migrations/v36_adventure_hardening.js";
import { TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS } from "../src/repo/db/migrations/v37_tool_execution_bindings.js";
import { DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS } from "../src/repo/db/migrations/v38_durable_agent_execution.js";
import { AGENT_RESPONSE_PROVENANCE_V39_MANAGED_OBJECTS } from "../src/repo/db/migrations/v39_agent_response_provenance.js";
import { CONFIRMATION_POLICY_V40_MANAGED_OBJECTS } from "../src/repo/db/migrations/v40_confirmation_policy.js";

const tmpDirs: string[] = [];

export function makeTmpDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "velvet-test-"));
  tmpDirs.push(dir);
  process.env.VELVET_DATA_DIR = dir;
  closeRepo();
  return dir;
}

export function cleanupTmpDataDirs(): void {
  closeRepo();
  delete process.env.VELVET_DATA_DIR;
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export function useTmpDataDir(): void {
  beforeEach(() => {
    makeTmpDataDir();
  });
  afterEach(() => {
    cleanupTmpDataDirs();
  });
}

/** Remove impossible future builder artifacts when constructing genuine historical fixtures. */
export function removeFutureCharacterBuilderSchema(db: import("better-sqlite3").Database): void {
  removeFutureCampaignContentGenerationSchema(db);
  removeFutureAdventureCoordinationSchema(db);
  removeFutureCharacterProgressionSchema(db);
  const v20Triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
    AND (name GLOB '*_v20' OR name GLOB '*_v20_*' OR name GLOB '*_v21' OR name GLOB '*_v21_*'
      OR name GLOB '*_v22' OR name GLOB '*_v22_*' OR name GLOB '*_v23' OR name GLOB '*_v23_*')`).all() as Array<{ name: string }>;
  for (const trigger of v20Triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec(`
    DROP INDEX IF EXISTS uq_character_draft_commands_v21_revision;
    DROP INDEX IF EXISTS uq_character_draft_events_v21_revision;
    DROP INDEX IF EXISTS uq_character_draft_receipts_v21_revision;
    DROP INDEX IF EXISTS uq_character_draft_proposals_v21_revision;
    DROP TABLE IF EXISTS character_builder_layout_attestation_v21;
    DROP TABLE IF EXISTS character_builder_layout_attestation_v22;
    DROP TABLE IF EXISTS character_draft_command_provenance_v20;
    DROP TABLE IF EXISTS character_draft_campaign_deletions_v20;
    DROP TABLE IF EXISTS character_builder_layout_attestation_v20;
    DROP TABLE IF EXISTS character_starting_grants_v19;
    DROP TABLE IF EXISTS character_derived_snapshots_v19;
    DROP TABLE IF EXISTS character_draft_revisions_v19;
    DROP TABLE IF EXISTS character_draft_receipts_v19;
    DROP TABLE IF EXISTS character_draft_events_v19;
    DROP TABLE IF EXISTS character_draft_commands_v19;
    DROP TABLE IF EXISTS character_draft_pins_v19;
    DROP TABLE IF EXISTS character_drafts_v19;
  `);
  const catalogGuards = [
    ["campaign_content_catalog_selections_immutable_delete", "campaign_content_catalog_selections", "campaign catalog selections are immutable"],
    ["campaign_content_catalog_pins_immutable_delete", "campaign_content_catalog_pins", "campaign catalog pins are immutable"],
    ["campaign_catalog_selection_bind_delete", "campaign_catalog_current_selections", "catalog selection delete requires one exact open command"],
    ["campaign_catalog_pin_bind_delete", "campaign_catalog_current_pins", "catalog pin delete requires one exact open command"],
    ["campaign_catalog_commands_immutable_delete", "campaign_catalog_commands", "campaign catalog commands are immutable"],
    ["campaign_catalog_events_immutable_delete", "campaign_catalog_events", "campaign catalog events are immutable"],
    ["campaign_catalog_receipts_immutable_delete", "campaign_catalog_receipts", "campaign catalog receipts are immutable"],
    ["campaign_catalog_command_provenance_v18_immutable_delete", "campaign_catalog_command_provenance_v18", "catalog proposed provenance is immutable"],
  ] as const;
  for (const [trigger, table, message] of catalogGuards) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}; CREATE TRIGGER ${trigger} BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'${message}'); END;`);
  }
}

/** Removes additive v41-v42 campaign-content artifacts for historical fixtures. */
export function removeFutureCampaignContentGenerationSchema(db: import("better-sqlite3").Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS campaign_content_commands_v42_immutable_update_v42;
    DROP TRIGGER IF EXISTS campaign_content_commands_v42_immutable_delete_v42;
    DROP TRIGGER IF EXISTS campaign_content_receipts_v42_immutable_update_v42;
    DROP TRIGGER IF EXISTS campaign_content_receipts_v42_immutable_delete_v42;
    DROP TRIGGER IF EXISTS campaign_content_revisions_v42_immutable_update_v42;
    DROP TRIGGER IF EXISTS campaign_content_revisions_v42_immutable_delete_v42;
    DROP TRIGGER IF EXISTS campaign_content_layout_attestation_v42_immutable_update_v42;
    DROP TRIGGER IF EXISTS campaign_content_layout_attestation_v42_immutable_delete_v42;
    DROP TABLE IF EXISTS campaign_content_layout_attestation_v42;
    DROP TABLE IF EXISTS campaign_content_revisions_v42;
    DROP TABLE IF EXISTS campaign_content_receipts_v42;
    DROP TABLE IF EXISTS campaign_content_commands_v42;
    DROP TABLE IF EXISTS generated_campaign_quests_v41;
    DROP TABLE IF EXISTS campaign_npc_baseline_stats_v41;
    DROP TABLE IF EXISTS campaign_opening_narratives_v41;
  `);
}

/** Removes exact additive agent sidecars before destructive fixture rewinds. */
export function removeFutureAgentSchema(db:import("better-sqlite3").Database):void {
  removeFutureCampaignContentGenerationSchema(db);
  const remove = (inventory: ReadonlyArray<readonly [string, string]>, tables: readonly string[]) => {
    const names = inventory.map(([, name]) => name);
    const objects = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL`)
      .all(...names) as Array<{ type: string; name: string }>;
    for (const object of objects) if (object.type === "trigger") db.exec(`DROP TRIGGER "${object.name}"`);
    for (const object of objects) if (object.type === "index") db.exec(`DROP INDEX IF EXISTS "${object.name}"`);
    for (const table of tables) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  };
  remove(CONFIRMATION_POLICY_V40_MANAGED_OBJECTS,["confirmation_policy_layout_attestation_v40","confirmation_authority_evidence_v40","confirmation_expiration_operations_v40",
    "agent_replan_requirements_v40","agent_mutation_accounting_v40","confirmation_policy_attestations_v40"]);
  remove(AGENT_RESPONSE_PROVENANCE_V39_MANAGED_OBJECTS,["agent_response_provenance_attestation_v39","agent_generalized_receipts_v39",
    "agent_combat_proposal_bindings_v39","agent_provider_responses_v39","agent_provider_dispatch_claims_v39","agent_provider_contexts_v39"]);
}

/** Removes exact v35-v40 adventure artifacts before destructive historical fixture rewinds. */
export function removeFutureAdventureCoordinationSchema(db: import("better-sqlite3").Database): void {
  removeFutureAgentSchema(db);
  const remove = (inventory: ReadonlyArray<readonly [string, string]>, tables: readonly string[]) => {
    const names = inventory.map(([, name]) => name);
    const objects = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL`)
      .all(...names) as Array<{ type: string; name: string }>;
    for (const object of objects) if (object.type === "trigger") db.exec(`DROP TRIGGER "${object.name}"`);
    for (const object of objects) if (object.type === "index") db.exec(`DROP INDEX IF EXISTS "${object.name}"`);
    for (const table of tables) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  };
  remove(DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS, ["durable_agent_execution_layout_attestation_v38",
    "agent_read_outcomes_v38", "agent_decision_batch_seals_v38", "agent_tool_calls_v38", "agent_decision_rounds_v38",
    "agent_provider_starts_v38", "agent_execution_operations_v38", "adventure_agent_executions_v38"]);
  remove(TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS, ["tool_execution_binding_layout_attestation_v37", "tool_proposal_execution_bindings_v37"]);
  remove(ADVENTURE_HARDENING_V36_MANAGED_OBJECTS, ["adventure_hardening_layout_attestation_v36", "generation_draft_apply_receipts_v36",
    "turn_mechanics_links_v36", "adventure_coordination_receipts_v36", "adventure_coordination_events_v36", "adventure_coordination_commands_v36"]);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adventure_turns'").get()) restoreAdventureGenerationV35Guards(db);
  remove(ADVENTURE_GENERATION_V35_MANAGED_OBJECTS, ["adventure_generation_layout_attestation_v35", "final_receipt_links", "review_decisions",
    "generation_drafts", "provider_call_metadata", "confirmation_decisions", "tool_proposals", "adventure_turns"]);
}

/** Remove only v23 artifacts when a test needs a genuine v19-v22 fixture. */
export function removeFutureCharacterProgressionSchema(db:import("better-sqlite3").Database):void{
  removeFutureCampaignContentGenerationSchema(db);
  removeFutureCharacterProgressionIntegrityV24(db);
  const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v23' OR name GLOB '*_v23_*')").all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec(`DROP TABLE IF EXISTS character_progression_receipts_v23;
    DROP TABLE IF EXISTS character_level_advancements_v23; DROP TABLE IF EXISTS character_progression_ledger_v23;
    DROP TABLE IF EXISTS character_known_powers_v23; DROP TABLE IF EXISTS character_progression_pending_choices_v23;
    DROP TABLE IF EXISTS character_progression_snapshots_v23; DROP TABLE IF EXISTS character_progression_commands_v23;
    DROP TABLE IF EXISTS character_progression_v23; DROP TABLE IF EXISTS rpg_progression_profiles_v23;
    DROP TABLE IF EXISTS character_progression_layout_attestation_v23;`);
}

/** Remove only additive v24 progression-integrity artifacts. */
export function removeFutureCharacterProgressionIntegrityV24(db:import("better-sqlite3").Database):void{
  removeFutureCampaignContentGenerationSchema(db);
  removeFutureResourcesInventoryEconomyRestV25(db);
  const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v24' OR name GLOB '*_v24_*')").all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec(`DROP TABLE IF EXISTS character_progression_events_v24;
    DROP TABLE IF EXISTS character_progression_command_proposals_v24;
    DROP TABLE IF EXISTS character_progression_pending_snapshots_v24;
    DROP TABLE IF EXISTS character_known_power_sources_v24;
    DROP TABLE IF EXISTS character_progression_bootstrap_v24;
    DROP TABLE IF EXISTS character_progression_layout_attestation_v24;`);
}

/** Remove additive v25 artifacts before exercising a genuine historical marker. */
export function removeFutureResourcesInventoryEconomyRestV25(db:import("better-sqlite3").Database):void{
  removeFutureCampaignContentGenerationSchema(db);
  removeFutureChecksPowersEffectsV26(db);
  const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v25' OR name GLOB '*_v25_*')").all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB '*_v25' OR name GLOB '*_v25_*')").all() as Array<{name:string}>;
  for(const table of tables)db.exec(`DROP TABLE ${table.name}`);
}

/** Remove additive v26 artifacts before exercising a genuine historical marker. */
export function removeFutureChecksPowersEffectsV26(db:import("better-sqlite3").Database):void{
  removeFutureCampaignContentGenerationSchema(db);
  removeFutureCombatFoundationV27(db);
  const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v26' OR name GLOB '*_v26_*')").all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB '*_v26' OR name GLOB '*_v26_*')").all() as Array<{name:string}>;
  for(const table of tables)db.exec(`DROP TABLE ${table.name}`);
}

/** Remove every v27 combat artifact before constructing a historical fixture. */
export function removeFutureCombatFoundationV27(db:import("better-sqlite3").Database):void{
  removeFutureCampaignContentGenerationSchema(db);
  removeFutureEncounterLifecycleV31(db);
  removeFutureWorldTravelNpcFactionV28(db);
  const combatTables = "('encounter','combatant','combat_log','reward_bundle','reward_entry_v27','reward_claim_v27')";
  const artifacts = `(name IN ${combatTables} OR name GLOB '*_v27' OR name GLOB '*_v27_*' OR tbl_name IN ${combatTables} OR tbl_name GLOB '*_v27' OR tbl_name GLOB '*_v27_*')`;
  const triggers=db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND ${artifacts}`).all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  // Constraint-backed SQLite autoindexes have no SQL and are removed with
  // their table; explicitly drop only standalone v27 indexes first.
  const indexes=db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND ${artifacts}`).all() as Array<{name:string}>;
  for(const index of indexes)db.exec(`DROP INDEX ${index.name}`);
  const tables=db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND ${artifacts}`).all() as Array<{name:string}>;
  for(const table of tables)db.exec(`DROP TABLE ${table.name}`);
}

/** Remove additive v31 lifecycle sidecars before dropping their v27 parents. */
export function removeFutureEncounterLifecycleV31(db:import("better-sqlite3").Database):void{
  removeFutureWorldNarrativeV32(db);
  db.exec(`DROP TRIGGER IF EXISTS encounter_enemy_provenance_v31_immutable_delete;
    DROP TRIGGER IF EXISTS encounter_enemy_provenance_v31_immutable_update;
    DROP TRIGGER IF EXISTS encounter_enemy_provenance_v31_exact_combatant;
    DROP TRIGGER IF EXISTS encounter_lifecycle_v31_immutable_delete;
    DROP TRIGGER IF EXISTS encounter_lifecycle_v31_immutable_update;
    DROP TRIGGER IF EXISTS encounter_lifecycle_v31_exact_ancestry;
    DROP INDEX IF EXISTS idx_encounter_enemy_provenance_v31_encounter;
    DROP INDEX IF EXISTS idx_encounter_lifecycle_v31_campaign;
    DROP TABLE IF EXISTS encounter_enemy_provenance_v31;
    DROP TABLE IF EXISTS encounter_lifecycle_v31;`);
}

/** Remove additive v32 narrative state before historical world parents. */
export function removeFutureWorldNarrativeV32(db:import("better-sqlite3").Database):void{
  removeFutureCampaignContentGenerationSchema(db);
  const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v32' OR name GLOB '*_v32_*')").all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  const tables=["campaign_faction_reputation_v32","campaign_faction_metadata_v32","campaign_npc_relationships_v32",
    "campaign_npc_metadata_v32","world_narrative_events_v32","world_narrative_receipts_v32",
    "world_narrative_commands_v32","world_narrative_revisions_v32"];
  for(const table of tables)db.exec(`DROP TABLE IF EXISTS ${table}`);
}

/** Remove every v28 world/travel artifact before constructing a historical fixture. */
export function removeFutureWorldTravelNpcFactionV28(db:import("better-sqlite3").Database):void{
  removeFutureCampaignContentGenerationSchema(db);
  removeFutureCharacterLayoutV29(db);
  const artifacts = "(name GLOB '*_v28' OR name GLOB '*_v28_*' OR tbl_name GLOB '*_v28' OR tbl_name GLOB '*_v28_*')";
  const triggers=db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND ${artifacts}`).all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  // Constraint-backed SQLite autoindexes have no SQL and are removed with
  // their table; explicitly drop only standalone v28 indexes first.
  const indexes=db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND ${artifacts}`).all() as Array<{name:string}>;
  for(const index of indexes)db.exec(`DROP INDEX ${index.name}`);
  const tables=db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND ${artifacts}`).all() as Array<{name:string}>;
  for(const table of tables)db.exec(`DROP TABLE ${table.name}`);
}

/** Remove v29 character-layout artifacts when constructing historical fixtures. */
export function removeFutureCharacterLayoutV29(db: import("better-sqlite3").Database): void {
  removeFutureCampaignContentGenerationSchema(db);
  db.exec(`DROP TRIGGER IF EXISTS character_layout_attestation_v29_immutable_update;
    DROP TRIGGER IF EXISTS character_layout_attestation_v29_immutable_delete;
    DROP TABLE IF EXISTS character_layout_attestation_v29;`);
}

/** Registers the hostile legacy name for non-campaign deletion corruption fixtures. */
export function authorizeCampaignDeletionForTest(db: import("better-sqlite3").Database, campaignId: string): void {
  db.function("velvet_campaign_delete_authorized", (candidate: unknown) => candidate === campaignId ? 1 : 0);
}

/** Removes a campaign only inside deliberate legacy/missing-parent fixtures, then restores exact v22 DDL. */
export function deleteCampaignForCorruptionTest(db:import("better-sqlite3").Database,campaignId:string):void{
  authorizeCampaignDeletionForTest(db,campaignId);
  const names=["campaigns_prevent_physical_delete_v22","character_draft_campaign_deletions_v22_inert_insert",
    "character_draft_campaign_deletions_v22_inert_update","character_draft_campaign_deletions_v22_inert_delete"];
  const rows=db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (${names.map(()=>"?").join(",")})`)
    .all(...names) as Array<{name:string;sql:string}>;
  if(rows.length!==0&&rows.length!==names.length)throw new Error("v22 archive guards are incomplete in the corruption fixture");
  try{
    for(const row of rows)db.exec(`DROP TRIGGER ${row.name}`);
    db.prepare("DELETE FROM campaigns WHERE id=?").run(campaignId);
  }finally{
    for(const row of rows)db.exec(row.sql);
  }
}

export interface FakeProvider {
  baseUrl: string;
  requests: Array<{ model: string; messageCount: number; lastUserContent: string | null; systemContent: string; authorization: string | null }>;
  sceneRequests: Array<{ model: string; messageCount: number; lastUserContent: string | null; systemContent: string; authorization: string | null }>;
  close: () => Promise<void>;
}

export interface FakeProviderOptions {
  replyText?: string;
  replyTexts?: string[];
  delayMs?: number;
  chunkSize?: number;
}

export async function startFakeProvider(
  replyTextOrOptions: string | FakeProviderOptions = "A warm, fictional reply between consenting adults.",
): Promise<FakeProvider> {
  const options: FakeProviderOptions =
    typeof replyTextOrOptions === "string" ? { replyText: replyTextOrOptions } : replyTextOrOptions;
  const replyText = options.replyText ?? "A warm, fictional reply between consenting adults.";
  let replyIndex = 0;
  const delayMs = options.delayMs ?? 0;
  const chunkSize = options.chunkSize ?? 7;
  const requests: FakeProvider["requests"] = [];
  const sceneRequests: FakeProvider["sceneRequests"] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        let stream = false;
        let sceneRequest = false;
        try {
          const parsed = JSON.parse(body) as {
            model?: string;
            stream?: boolean;
            messages?: Array<{ role: string; content: string }>;
          };
          const messages = parsed.messages ?? [];
          const lastUser = [...messages].reverse().find((m) => m.role === "user");
          stream = parsed.stream === true;
          const captured = {
              model: parsed.model ?? "",
              messageCount: messages.length,
              lastUserContent: lastUser?.content ?? null,
              systemContent: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"),
              authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
          };
          sceneRequest = captured.systemContent.includes("SCENE STATE SYNTHESIZER");
          if (sceneRequest) sceneRequests.push(captured);
          else requests.push(captured);
        } catch {
          // ignore malformed bodies in the fake
        }
        const respond = () => {
          const currentReply = sceneRequest
            ? "Location & time:\n- Observatory at night\nParticipants:\n- Everyone is alert\nObjects & environment:\n- A brass key is present\nRelationships & knowledge:\n- none established\nActive goals & tensions:\n- Determine what the key opens"
            : options.replyTexts?.[replyIndex++] ?? replyText;
          if (!stream) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: currentReply } }] }));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          for (let i = 0; i < currentReply.length; i += chunkSize) {
            const delta = currentReply.slice(i, i + chunkSize);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ model: "fake-model", choices: [], usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        };
        if (delayMs > 0) {
          setTimeout(respond, delayMs);
        } else {
          respond();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    sceneRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
