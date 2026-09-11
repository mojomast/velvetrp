#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { completeWithProvider } from "../server/src/provider/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../server/src/defaults.js";
import type { ProviderSettings } from "../server/src/types.js";
import { closeRepo } from "../server/src/repo/index.js";
import { orchestrateCampaignDmBeat } from "../server/src/agent/campaignDmOrchestrator.js";
import type { AdventureAgentDependencies } from "../server/src/agent/adventureOrchestrator.js";
import { dmFixture } from "../server/test/fixtures/dmCampaign.js";

// Hard sub-cap for this live run only; never exceeded and never retried automatically.
const MAX_BEATS = 3;
const MAX_CALLS = 15;
const MAX_TOKENS = 60_000;
const MAX_USD = 0.05;
const OWNER = "local-owner";

// RouteTok proxy in `projects/agentrouterrouter`, serving AgentRouter `deepseek-v4-flash`.
const PROXY_ENV_PATH = "/home/mojo/projects/agentrouterrouter/.env";
const PROXY_BASE_URL = "http://100.72.41.9:8787/v1";
const PROXY_MODEL = "deepseek-v4-flash";

async function readProxyKey(): Promise<string> {
  const content = await readFile(PROXY_ENV_PATH, "utf8").catch(() => "");
  const line = content.split(/\r?\n/).find(value => value.startsWith("PROXY_API_KEY="));
  const key = (line?.slice("PROXY_API_KEY=".length) ?? "").replace(/^["']|["']$/g, "").trim();
  if (!key) throw new Error("RouteTok proxy key is unavailable");
  return key;
}

function liveProvider(apiKey: string): ProviderSettings {
  const provider = defaultProviderSettings();
  // Conservative per-million pricing so the USD sub-cap cannot be under-estimated.
  return { ...provider, providerType: "openai-compatible", baseUrl: PROXY_BASE_URL, model: PROXY_MODEL, apiKey,
    pricing: { promptPerMillion: 0.10, completionPerMillion: 0.30 },
    adventureTurnBudget: { maxTotalTokens: 65_536, maxEstimatedCostUsd: MAX_USD / MAX_BEATS } };
}

function usageTotals(db: DatabaseDriver.Database, campaignId: string) {
  const review = db.prepare(`SELECT COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(cost_usd),0) cost, COUNT(*) calls
    FROM dm_review_provider_usage usage JOIN dm_runs run USING(run_id) WHERE run.campaign_id=?`).get(campaignId) as { tokens: number; cost: number; calls: number };
  const rounds = db.prepare(`SELECT COALESCE(SUM(CASE WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL
      THEN prompt_tokens+completion_tokens ELSE reserved_prompt_tokens+reserved_completion_tokens END),0) tokens,
      COALESCE(SUM(cost_usd),0) cost, COUNT(*) calls
    FROM dm_planning_rounds round JOIN dm_runs run USING(run_id) WHERE run.campaign_id=?`).get(campaignId) as { tokens: number; cost: number; calls: number };
  return { calls: review.calls + rounds.calls, tokens: review.tokens + rounds.tokens, cost: review.cost + rounds.cost };
}

function readToolsUsed(db: DatabaseDriver.Database, campaignId: string): string[] {
  const rows = db.prepare(`SELECT response_json FROM dm_planning_rounds round JOIN dm_runs run USING(run_id)
    WHERE run.campaign_id=? AND response_json IS NOT NULL`).all(campaignId) as { response_json: string }[];
  const legacy = db.prepare(`SELECT response_json FROM dm_dispatches dispatch JOIN dm_runs run USING(run_id)
    WHERE run.campaign_id=? AND response_json IS NOT NULL`).all(campaignId) as { response_json: string }[];
  const names = new Set<string>();
  for (const { response_json } of [...rows, ...legacy]) {
    try {
      const parsed = JSON.parse(response_json) as { reads?: unknown };
      if (Array.isArray(parsed.reads)) for (const name of parsed.reads) if (typeof name === "string") names.add(name);
    } catch { /* not a read response */ }
  }
  return [...names].sort();
}

export async function evaluateLiveDirectorGrounding() {
  const directory = await mkdtemp(path.join(tmpdir(), "velvet-director-live-"));
  const priorDataDir = process.env.VELVET_DATA_DIR;
  const audit: string[] = [];
  try {
    process.env.VELVET_DATA_DIR = directory; closeRepo();
    const provider = liveProvider(await readProxyKey());
    const f = await dmFixture(false, { dataDir: directory });
    f.graph();
    // Public grounding sources: one public location, one present public NPC, one public quest.
    (f.repo as any).createLocation(OWNER, { campaignId: f.campaign.id, locationId: "harbor", name: "Harbor", description: "A foggy public harbor.", visibility: "public" });
    const npcPersona = f.repo.createCharacter({ name: "Maren", age: 40, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
    const npc = f.repo.createCampaignNpc(OWNER, f.campaign.id, { personaId: npcPersona.id, publicState: { name: "Maren", description: "The harbor keeper." },
      privateState: { goals: "Watch the tide", gmNotes: "GM only", merchantState: null }, expectedRevision: 0, idempotencyKey: "live-npc" }).npc;
    f.repo.mutateNpcPresence(OWNER, { campaignId: f.campaign.id, sessionId: f.session.id, npcId: npc.npcId, expectedRevision: 0,
      idempotencyKey: "live-npc-place", mutation: { kind: "place", locationId: "harbor" } });
    f.repo.createCampaignQuest(OWNER, f.campaign.id, { quest: { questId: "live-quest", storylineId: "story", title: "Guard the harbor", description: "Public objective.",
      visibility: "public", journalText: "Offered", objectives: [{ objectiveId: "live-objective", description: "Watch the tide", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }], rewards: [] },
      expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "live-quest-create" });
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "live-ai" });
    const db = new DatabaseDriver(path.join(directory, "velvet.sqlite"));
    db.pragma("foreign_keys=ON");
    audit.push("deterministic provider-free seed complete");

    const deps: AdventureAgentDependencies = {
      complete: completeWithProvider, getProvider: async () => provider, getHarness: async () => defaultHarnessSettings(), now: () => new Date(),
    };
    const beats: Array<{ intent: "open" | "continue"; state: string; receipts: number; narration: boolean }> = [];
    let capHit: string | null = null;
    for (let beat = 0; beat < MAX_BEATS; beat += 1) {
      const before = usageTotals(db, f.campaign.id);
      if (before.calls >= MAX_CALLS) { capHit = "max-calls"; break; }
      if (before.tokens >= MAX_TOKENS) { capHit = "max-tokens"; break; }
      if (before.cost >= MAX_USD) { capHit = "max-usd"; break; }
      const intent = beat === 0 ? "open" as const : "continue" as const;
      const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, { intent, expectedModeRevision: 1, idempotencyKey: `live-beat-${beat}` });
      await orchestrateCampaignDmBeat(f.repo, OWNER, run.runId, deps);
      const executed = f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, run.runId);
      beats.push({ intent, state: executed.state, receipts: executed.receipts.length, narration: executed.narration !== null });
      const after = usageTotals(db, f.campaign.id);
      audit.push(`beat ${beat} (${intent}) state=${executed.state} receipts=${executed.receipts.length} calls=${after.calls} tokens=${after.tokens}`);
      if (executed.state !== "completed") { audit.push(`beat ${beat} stopped at state ${executed.state}`); break; }
    }
    const total = usageTotals(db, f.campaign.id);
    const artifact = {
      version: 1, mode: "live", model: provider.model, baseUrlDigest: createHash("sha256").update(provider.baseUrl).digest("hex"),
      pricing: provider.pricing, caps: { beats: MAX_BEATS, calls: MAX_CALLS, tokens: MAX_TOKENS, costUsd: MAX_USD },
      totals: total, capHit, beats, readToolsUsed: readToolsUsed(db, f.campaign.id),
      audit: [...audit, "credentials, URLs, prompts, and provider responses omitted"],
    };
    db.close(); f.repo.close();
    return { artifact, directory };
  } finally {
    closeRepo();
    if (priorDataDir === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = priorDataDir;
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const output = process.argv.slice(2).find(value => value.startsWith("--output="))?.slice(9)
    ?? `/tmp/opencode/director-live-${Date.now()}.json`;
  const { artifact } = await evaluateLiveDirectorGrounding();
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, mode: artifact.mode, beats: artifact.beats.length, calls: artifact.totals.calls,
    tokens: artifact.totals.tokens, costUsd: Number(artifact.totals.cost.toFixed(6)), capHit: artifact.capHit, readToolsUsed: artifact.readToolsUsed })}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

function fileURLToPath(url: string): string { return url.startsWith("file:") ? new URL(url).pathname : url; }
