#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { completeWithProvider, ProviderHttpError } from "../server/src/provider/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../server/src/defaults.js";
import type { ProviderSettings } from "../server/src/types.js";
import { closeRepo } from "../server/src/repo/index.js";
import { orchestrateCampaignDmBeat } from "../server/src/agent/campaignDmOrchestrator.js";
import type { AdventureAgentDependencies } from "../server/src/agent/adventureOrchestrator.js";
import { dmFixture } from "../server/test/fixtures/dmCampaign.js";
import { PLAYTEST_PACING_ACTIONS, gradeDmRun, seedLivingWorld } from "../server/test/fixtures/livingWorld.js";
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
}

export interface PlaytestArtifact {
  version: number;
  mode: string;
  seed: number;
  engineMode: "ai" | "human";
  model: string;
  beats: Array<{ index: number; intent: string; state: string; receipts: string[]; narration: boolean; transition: boolean; blockers: string[]; narrationTail: string; failures: string[] }>;
  failures: string[];
  providerCalls: Array<{ phase: string; ok: boolean; finishReason: string; detail: string; tools: string[]; completionTokens: number; totalTokens: number; costUsd: number }>;
  readToolsUsed: string[];
  totals: { calls: number; tokens: number; cost: number };
  caps: { calls: number; tokens: number; costUsd: number };
  capHit: string | null;
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
  try {
    process.env.VELVET_DATA_DIR = directory; closeRepo();
    const provider = liveProvider(await readProxyKey(), options.maxUsd / options.beats);
    const f = await dmFixture(false, { dataDir: directory });
    seedLivingWorld(f, options.seed);
    const providerCalls: PlaytestArtifact["providerCalls"] = [];
    let providerQuotaHit = false;
    const deps: AdventureAgentDependencies = {
      complete: async (input) => {
        try {
          const result = await completeWithProvider(input);
          const usage = result.usage;
          const price = provider.pricing;
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
      getProvider: async () => provider, getHarness: async () => defaultHarnessSettings(), now: () => new Date(),
    };
    const beats: PlaytestArtifact["beats"] = [];
    const failures: string[] = [];
    let capHit: string | null = null;
    let lastRunId = "";
    const initialControl = f.repo.getDmControl(OWNER, f.campaign.id);
    if (options.mode === "ai" && initialControl.mode !== "ai") {
      f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: initialControl.revision, idempotencyKey: `play-${options.seed}-ai` });
    }
    for (let index = 0; index < options.beats; index += 1) {
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
      beats.push({ index, intent: run.intent, state: executed.state, receipts: executed.receipts.map(receipt => receipt.action),
        narration: executed.narration !== null, transition, blockers: executed.blockers,
        narrationTail: (executed.narration ?? "").slice(-70), failures: beatFailures });
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
    const artifact: PlaytestArtifact = {
      version: 1, mode: "live", seed: options.seed, engineMode: options.mode, model: provider.model,
      beats, failures, providerCalls, readToolsUsed, totals,
      caps: { calls: options.maxCalls, tokens: options.maxTokens, costUsd: options.maxUsd }, capHit,
    };
    f.repo.close();
    return { artifact, directory };
  } finally {
    closeRepo();
    if (priorDataDir === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = priorDataDir;
    if (!process.env.PLAYTEST_DEBUG) await rm(directory, { recursive: true, force: true });
    else process.stderr.write(`PLAYTEST_KEEP ${directory}\n`);
  }
}

async function main() {
  const seed = Number(process.argv.find(value => value.startsWith("--seed="))?.slice(7) ?? 1);
  const beats = Number(process.argv.find(value => value.startsWith("--beats="))?.slice(8) ?? 12);
  const mode = (process.argv.find(value => value.startsWith("--engine="))?.slice(9) ?? "ai") as "ai" | "human";
  const output = process.argv.find(value => value.startsWith("--output="))?.slice(9) ?? `/tmp/opencode/playtest-${seed}-${Date.now()}.json`;
  const { artifact } = await runLiveDirectorPlaytest({ seed, beats, mode, maxCalls: 80, maxTokens: 500_000, maxUsd: 1.5 });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  const completed = artifact.beats.filter(beat => beat.state === "completed").length;
  process.stdout.write(`${JSON.stringify({ output, seed: artifact.seed, engine: artifact.engineMode, beats: artifact.beats.length,
    completed, transitions: artifact.beats.filter(beat => beat.transition).length, calls: artifact.totals.calls,
    tokens: artifact.totals.tokens, costUsd: Number(artifact.totals.cost.toFixed(6)), failures: artifact.failures,
    readToolsUsed: artifact.readToolsUsed, capHit: artifact.capHit })}\n`);
  if (artifact.failures.length > 0) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

function fileURLToPath(url: string): string { return url.startsWith("file:") ? new URL(url).pathname : url; }
