#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { completeWithProvider, ProviderHttpError } from "../server/src/provider/index.js";
import { buildApp } from "../server/src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../server/src/defaults.js";
import type { ProviderSettings } from "../server/src/types.js";
import { closeRepo } from "../server/src/repo/index.js";
import { orchestrateCampaignDmBeat } from "../server/src/agent/campaignDmOrchestrator.js";
import type { AdventureAgentDependencies } from "../server/src/agent/adventureOrchestrator.js";
import { DM_SCENE_DESCRIPTION_PREFIX } from "../server/src/agent/dmNarration.js";
import { dmFixture } from "../server/test/fixtures/dmCampaign.js";
import { PLAYTEST_PACING_ACTIONS, enableHumanPlayerTravel, gradeDmRun, resetHumanPlayerToMarket, seedLivingWorld } from "../server/test/fixtures/livingWorld.js";
import { HUMAN_LEAK_MARKERS, fuzzDeclarations, scorePlayerTurn, type HumanDeclaration } from "../server/test/fixtures/humanPlayer.js";
import { readProxyKey } from "./evaluate-live-director-grounding.js";

const OWNER = "local-owner";
const PROXY_BASE_URL = "http://100.72.41.9:8787/v1";
const PROXY_MODEL = "deepseek-v4-flash";

export interface PlaytestOptions {
  seed: number;
  beats: number;
  mode: "ai" | "human";
  maxCalls: number;
  maxTokens: number;
  maxUsd: number;
  /** Inject one fuzzed human-player declaration through the real adventure-turn route before each Director beat. */
  players?: boolean;
}

export interface PlayerTurnRecord {
  id: string; category: string; declaration: string; status: number; state: string; outcome: string;
  receipts: number; narrationSource: string; narrationTail: string; calls: number; leak: string | null;
  advertised: string[]; called: string[]; actioned: boolean; score: string[]; failures: string[];
}

export interface PlaytestArtifact {
  version: number;
  mode: string;
  seed: number;
  engineMode: "ai" | "human";
  model: string;
  beats: Array<{ index: number; intent: string; state: string; receipts: string[]; narration: boolean; assisted: boolean; transition: boolean; blockers: string[]; narrationTail: string; scene: string | null; selection: string | null; failures: string[] }>;
  failures: string[];
  providerCalls: Array<{ phase: string; ok: boolean; finishReason: string; detail: string; tools: string[]; completionTokens: number; totalTokens: number; costUsd: number }>;
  readToolsUsed: string[];
  totals: { calls: number; tokens: number; cost: number };
  narration: { assisted: number; fallback: number };
  playerTurns: PlayerTurnRecord[];
  caps: { calls: number; tokens: number; costUsd: number };
  capHit: string | null;
}

/** Reads the terminal SSE frame from an in-process adventure-turn response. */
function terminalEvent(body: string): { payload?: { outcome?: string; turn?: { state?: string; declaration?: string };
  narrationStatus?: { text?: string; source?: string }; receipts?: unknown[] } } | null {
  for (const frame of body.split("\n\n")) {
    if (!frame.startsWith("event: terminal")) continue;
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (data) return JSON.parse(data.slice(6));
  }
  return null;
}

function liveProvider(apiKey: string, maxUsdPerBeat: number): ProviderSettings {
  const provider = defaultProviderSettings();
  return { ...provider, providerType: "openai-compatible", baseUrl: PROXY_BASE_URL, model: PROXY_MODEL, apiKey,
    pricing: { promptPerMillion: 0.10, completionPerMillion: 0.30 },
    adventureTurnBudget: { maxTotalTokens: 65_536, maxEstimatedCostUsd: maxUsdPerBeat } };
}

export async function runLiveDirectorPlaytest(options: PlaytestOptions) {
  const directory = await mkdtemp(path.join(tmpdir(), "velvet-playtest-"));
  const priorDataDir = process.env.VELVET_DATA_DIR;
  const priorFlags = { campaign: process.env.FEATURE_RPG_CAMPAIGN, mechanics: process.env.FEATURE_RPG_MECHANICS, combat: process.env.FEATURE_RPG_COMBAT };
  let app: ReturnType<typeof buildApp> | null = null;
  try {
    process.env.VELVET_DATA_DIR = directory; closeRepo();
    const provider = liveProvider(await readProxyKey(), options.maxUsd / options.beats);
    const f = await dmFixture(false, { dataDir: directory });
    seedLivingWorld(f, options.seed);
    const providerCalls: PlaytestArtifact["providerCalls"] = [];
    let providerQuotaHit = false;
    let pendingScene: string | null = null;
    let pendingSelection: string | null = null;
    let pendingAdvertised = new Set<string>();
    const deps: AdventureAgentDependencies = {
      complete: async (input) => {
        try {
          const result = await completeWithProvider(input);
          const usage = result.usage;
          const price = provider.pricing;
          if (input.promptVersion === "adventure-planning-v1") for (const tool of input.tools ?? []) pendingAdvertised.add(tool.name);
          if (input.promptVersion === "campaign-dm-narration-v1") {
            pendingScene = result.message.toolCalls?.find(call => call.name === "submit_dm_scene")?.arguments ?? null;
          }
          if (input.promptVersion === "campaign-dm-v1") {
            pendingSelection = result.message.toolCalls?.find(call => call.name === "select_dm_beat")?.arguments ?? pendingSelection;
          }
          providerCalls.push({ phase: input.promptVersion ?? "unknown", ok: true, finishReason: result.provenance?.finishReason ?? "unknown", detail: "",
            tools: result.message.toolCalls?.map(call => call.name) ?? [], completionTokens: usage?.completionTokens ?? 0, totalTokens: usage?.totalTokens ?? 0,
            costUsd: usage && price.promptPerMillion !== null && price.completionPerMillion !== null
              ? (usage.promptTokens * price.promptPerMillion + usage.completionTokens * price.completionPerMillion) / 1_000_000 : 0 });
          return result;
        } catch (error) {
          if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 402 || error.status === 403)) providerQuotaHit = true;
          providerCalls.push({ phase: input.promptVersion ?? "unknown", ok: false, finishReason: (error as Error).name, detail: (error as Error).message.slice(0, 140),
            tools: [], completionTokens: 0, totalTokens: 0, costUsd: 0 });
          throw error;
        }
      },
      // The adventure planning deadline is computed against the fixture clock; a real-time clock here
      // makes AbortSignal.timeout overflow and silently aborts every plan.
      getProvider: async () => provider, getHarness: async () => defaultHarnessSettings(), now: () => f.options.clock.now(),
    };
    const beats: PlaytestArtifact["beats"] = [];
    const failures: string[] = [];
    let capHit: string | null = null;
    let lastRunId = "";
    const players = Boolean(options.players);
    const declarations: HumanDeclaration[] = players ? fuzzDeclarations(options.seed, options.beats) : [];
    const playerTurns: PlayerTurnRecord[] = [];
    if (players) {
      enableHumanPlayerTravel(f, options.seed);
      process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true";
      app = buildApp({ campaignRepositoryFactory: () => f.repo, adventureAgentDependencies: deps });
    }
    const submitPlayerTurn = async (entry: HumanDeclaration, index: number) => {
      if (!app || !entry) return;
      const before = providerCalls.length;
      pendingAdvertised = new Set<string>();
      // Give every declaration a reachable destination so the metric measures intent, not route exhaustion.
      resetHumanPlayerToMarket(f, options.seed, `human-reset-${options.seed}-${index}`);
      const revision = f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision;
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream",
        headers: { "content-type": "application/json" }, payload: { campaignId: f.campaign.id, sessionId: f.session.id,
          actorId: f.actorId, declaration: entry.declaration, expectedRevision: revision, idempotencyKey: `human-${options.seed}-${index}` } });
      const terminal = terminalEvent(response.body);
      // The player's own echoed declaration is never a leak; only produced narration and receipts count.
      const produced = `${terminal?.payload?.narrationStatus?.text ?? ""} ${JSON.stringify(terminal?.payload?.receipts ?? [])}`;
      const leak = HUMAN_LEAK_MARKERS.find(marker => produced.toLowerCase().includes(marker.toLowerCase())) ?? null;
      const called = [...new Set(providerCalls.slice(before).flatMap(call => call.tools))];
      // Reads and narration are always safe; only an exact *.select/execute/set tool is a mutation attempt.
      const mutatedTool = called.find(name => !name.endsWith(".read") && name !== "submit_adventure_narration") ?? null;
      const actioned = called.some(name => name.endsWith(".read")) || mutatedTool !== null;
      const record: PlayerTurnRecord = { id: entry.id, category: entry.category, declaration: entry.declaration.slice(0, 120),
        status: response.statusCode, state: terminal?.payload?.turn?.state ?? "none", outcome: terminal?.payload?.outcome ?? "none",
        receipts: terminal?.payload?.receipts?.length ?? 0, narrationSource: terminal?.payload?.narrationStatus?.source ?? "none",
        narrationTail: (terminal?.payload?.narrationStatus?.text ?? "").slice(-80),
        calls: providerCalls.length - before, leak, advertised: [...pendingAdvertised].sort(), called, actioned,
        score: scorePlayerTurn(entry, actioned, mutatedTool), failures: [] };
      if (record.status !== 200) record.failures.push(`status:${record.status}`);
      if (leak) record.failures.push(`leak:${leak}`);
      if (terminal && terminal.payload?.turn?.declaration !== entry.declaration.trim()) record.failures.push("declaration-mismatch");
      if (providerQuotaHit) record.failures.push("provider-quota");
      playerTurns.push(record);
      failures.push(...record.failures.map(failure => `player${index}(${entry.id}):${failure}`));
    };
    const initialControl = f.repo.getDmControl(OWNER, f.campaign.id);
    if (options.mode === "ai" && initialControl.mode !== "ai") {
      f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: initialControl.revision, idempotencyKey: `play-${options.seed}-ai` });
    }
    for (let index = 0; index < options.beats; index += 1) {
      pendingScene = null; pendingSelection = null;
      if (players) { await submitPlayerTurn(declarations[index]!, index); if (providerQuotaHit) { capHit = "provider-quota"; failures.push("provider-quota"); break; } }
      const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, { intent: index === 0 ? "open" : "continue",
        expectedModeRevision: f.repo.getDmControl(OWNER, f.campaign.id).revision, idempotencyKey: `play-${options.seed}-${index}` });
      lastRunId = run.runId;
      await orchestrateCampaignDmBeat(f.repo, OWNER, run.runId, deps);
      if (options.mode === "human") {
        const proposal = f.repo.getDmProposal(OWNER, f.campaign.id, f.session.id, run.runId);
        if (proposal.run.state === "awaiting-approval") {
          f.repo.decideDmBeat(OWNER, f.campaign.id, f.session.id, run.runId,
            { decision: "approved", expectedRevision: proposal.run.revision, idempotencyKey: `play-approve-${options.seed}-${index}` });
          await orchestrateCampaignDmBeat(f.repo, OWNER, run.runId, deps);
        }
      }
      const executed = f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, run.runId);
      const beatFailures = gradeDmRun(executed);
      const transition = executed.receipts.length > 0 && executed.receipts.every(receipt => PLAYTEST_PACING_ACTIONS.has(receipt.action));
      const assisted = (executed.narration ?? "").includes(DM_SCENE_DESCRIPTION_PREFIX);
      beats.push({ index, intent: run.intent, state: executed.state, receipts: executed.receipts.map(receipt => receipt.action),
        narration: executed.narration !== null, assisted, transition, blockers: executed.blockers,
        narrationTail: (executed.narration ?? "").slice(-70), scene: pendingScene, selection: pendingSelection, failures: beatFailures });
      failures.push(...beatFailures.map(failure => `beat${index}:${failure}`));
      const spent = providerCalls.reduce((sum, call) => sum + call.totalTokens, 0);
      const cost = providerCalls.reduce((sum, call) => sum + call.costUsd, 0);
      if (providerQuotaHit) { capHit = "provider-quota"; failures.push("provider-quota"); break; }
      if (providerCalls.length >= options.maxCalls) { capHit = "max-calls"; break; }
      if (spent >= options.maxTokens) { capHit = "max-tokens"; break; }
      if (cost >= options.maxUsd) { capHit = "max-usd"; break; }
    }
    // Recovery and reads must never spend a provider call: re-orchestrating a completed run is a no-op.
    if (lastRunId) {
      const beforeReplay = providerCalls.length;
      await orchestrateCampaignDmBeat(f.repo, OWNER, lastRunId, deps);
      f.repo.getDmHistory(OWNER, f.campaign.id, f.session.id);
      if (providerCalls.length !== beforeReplay) failures.push("replay-called-provider");
    }
    const totals = { calls: providerCalls.length, tokens: providerCalls.reduce((sum, call) => sum + call.totalTokens, 0),
      cost: providerCalls.reduce((sum, call) => sum + call.costUsd, 0) };
    const readToolsUsed = [...new Set(providerCalls.flatMap(call => call.tools).filter(name => name.startsWith("read_")))].sort();
    const assisted = beats.filter(beat => beat.assisted).length;
    const artifact: PlaytestArtifact = {
      version: 1, mode: "live", seed: options.seed, engineMode: options.mode, model: provider.model,
      beats, failures, providerCalls, readToolsUsed, totals, narration: { assisted, fallback: beats.length - assisted },
      playerTurns, caps: { calls: options.maxCalls, tokens: options.maxTokens, costUsd: options.maxUsd }, capHit,
    };
    f.repo.close();
    return { artifact, directory };
  } finally {
    if (app) await app.close();
    closeRepo();
    for (const [key, value] of Object.entries(priorFlags)) {
      const name = { campaign: "FEATURE_RPG_CAMPAIGN", mechanics: "FEATURE_RPG_MECHANICS", combat: "FEATURE_RPG_COMBAT" }[key]!;
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (priorDataDir === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = priorDataDir;
    if (!process.env.PLAYTEST_DEBUG) await rm(directory, { recursive: true, force: true });
    else process.stderr.write(`PLAYTEST_KEEP ${directory}\n`);
  }
}

async function main() {
  const seed = Number(process.argv.find(value => value.startsWith("--seed="))?.slice(7) ?? 1);
  const beats = Number(process.argv.find(value => value.startsWith("--beats="))?.slice(8) ?? 12);
  const mode = (process.argv.find(value => value.startsWith("--engine="))?.slice(9) ?? "ai") as "ai" | "human";
  const players = process.argv.includes("--players");
  const output = process.argv.find(value => value.startsWith("--output="))?.slice(9) ?? `/tmp/opencode/playtest-${seed}-${Date.now()}.json`;
  const { artifact } = await runLiveDirectorPlaytest({ seed, beats, mode, players, maxCalls: 120, maxTokens: 800_000, maxUsd: 2 });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  const completed = artifact.beats.filter(beat => beat.state === "completed").length;
  process.stdout.write(`${JSON.stringify({ output, seed: artifact.seed, engine: artifact.engineMode, players,
    beats: artifact.beats.length, completed, transitions: artifact.beats.filter(beat => beat.transition).length,
    assisted: artifact.narration.assisted, fallback: artifact.narration.fallback,
    playerTurns: artifact.playerTurns.length, playerFailures: artifact.playerTurns.flatMap(turn => turn.failures).length,
    calls: artifact.totals.calls, tokens: artifact.totals.tokens, costUsd: Number(artifact.totals.cost.toFixed(6)),
    failures: artifact.failures, readToolsUsed: artifact.readToolsUsed, capHit: artifact.capHit })}\n`);
  if (artifact.failures.length > 0) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

function fileURLToPath(url: string): string { return url.startsWith("file:") ? new URL(url).pathname : url; }
