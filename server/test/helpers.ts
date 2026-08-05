import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach } from "vitest";
import { closeRepo } from "../src/repo/index.js";

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

/** Remove only v23 artifacts when a test needs a genuine v19-v22 fixture. */
export function removeFutureCharacterProgressionSchema(db:import("better-sqlite3").Database):void{
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
  removeFutureChecksPowersEffectsV26(db);
  const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v25' OR name GLOB '*_v25_*')").all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB '*_v25' OR name GLOB '*_v25_*')").all() as Array<{name:string}>;
  for(const table of tables)db.exec(`DROP TABLE ${table.name}`);
}

/** Remove additive v26 artifacts before exercising a genuine historical marker. */
export function removeFutureChecksPowersEffectsV26(db:import("better-sqlite3").Database):void{
  const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v26' OR name GLOB '*_v26_*')").all() as Array<{name:string}>;
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB '*_v26' OR name GLOB '*_v26_*')").all() as Array<{name:string}>;
  for(const table of tables)db.exec(`DROP TABLE ${table.name}`);
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
  requests: Array<{ model: string; messageCount: number; lastUserContent: string | null; systemContent: string }>;
  sceneRequests: Array<{ model: string; messageCount: number; lastUserContent: string | null; systemContent: string }>;
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
