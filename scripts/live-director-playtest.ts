#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { completeWithProvider, ProviderHttpError } from "../server/src/provider/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../server/src/defaults.js";
import type { ProviderSettings } from "../server/src/types.js";
import { closeRepo } from "../server/src/repo/index.js";
import { orchestrateCampaignDmBeat } from "../server/src/agent/campaignDmOrchestrator.js";
import type { AdventureAgentDependencies } from "../server/src/agent/adventureOrchestrator.js";
import { createAgentObservationRepository } from "../server/src/repo/observations/agentObservationRepo.js";
import { dmFixture } from "../server/test/fixtures/dmCampaign.js";
import { readProxyKey } from "./evaluate-live-director-grounding.js";

const OWNER = "local-owner";
const PROXY_BASE_URL = "http://100.72.41.9:8787/v1";
const PROXY_MODEL = "deepseek-v4-flash";
const KNOWN_ACTIONS = new Set(["encounter-start", "encounter-materialize", "enemy-turn", "encounter-complete",
  "reveal-node", "resolve-node", "reveal-clue", "advance-time", "ambient-beat"]);
const PACING_ACTIONS = new Set(["advance-time", "ambient-beat"]);
const LEAK_MARKERS = ["SECRET_", "gmNotes", "privateGoals", "candidateId", "proposal", "provider", "dispatch", "tool_call"];

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

/** Deterministic, provider-free world: locations, present NPCs with ledger knowledge, a story chain, and a quest. */
function seedWorld(f: Awaited<ReturnType<typeof dmFixture>>, seed: number) {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  const tag = `s${seed}`;
  const createLocation = (locationId: string, name: string, description: string) =>
    (f.repo as unknown as { createLocation: (owner: string, input: Record<string, unknown>) => unknown })
      .createLocation(OWNER, { campaignId: f.campaign.id, locationId, name, description, visibility: "public" });
  createLocation(`${tag}-market`, `${tag} Market`, "A lantern-lit market square.");
  createLocation(`${tag}-docks`, `${tag} Docks`, "Weathered docks under salt mist.");
  createLocation(`${tag}-chapel`, `${tag} Chapel`, "A quiet chapel of grey stone.");
  const ledger = createAgentObservationRepository(db, { clock: f.options.clock, ids: { nextId: (() => { let n = 0; return () => `${tag}-obs-${++n}`; })() } });
  const freshRead = <T>(source: string, ...params: unknown[]): T | undefined => {
    const connection = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    try { return connection.prepare(source).get(...params) as T | undefined; } finally { connection.close(); }
  };
  const narrativeRevision = () => freshRead<{ revision: number }>("SELECT revision FROM world_narrative_revisions_v32 WHERE campaign_id=?", f.campaign.id)?.revision ?? 0;
  const presenceRevision = () => freshRead<{ revision: number }>("SELECT revision FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?", f.campaign.id, f.session.id)?.revision ?? 0;
  [`${tag} Maren`, `${tag} Joss`, `${tag} Quill`].forEach((name, index) => {
    const persona = f.repo.createCharacter({ name, age: 30 + index, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
    const npc = f.repo.createCampaignNpc(OWNER, f.campaign.id, {
      personaId: persona.id, publicState: { name, description: `The ${name.split(" ")[1]} of the ${tag} quarter.` },
      privateState: { goals: "SECRET_GOAL", gmNotes: "SECRET_GM_NOTE", merchantState: null },
      expectedRevision: narrativeRevision(), idempotencyKey: `${tag}-npc-${index}`,
    }).npc;
    f.repo.mutateNpcPresence(OWNER, { campaignId: f.campaign.id, sessionId: f.session.id, npcId: npc.npcId, expectedRevision: presenceRevision(),
      idempotencyKey: `${tag}-place-${index}`, mutation: { kind: "place", locationId: `${tag}-market` } });
    ledger.record({ campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, agentKind: "npc", agentId: npc.npcId,
      sourceCommandId: `${tag}-witness-${index}`, observedRevision: 1, channel: "witnessed", hopCount: 0,
      text: `${name} saw the party arrive at the ${tag} market.`, authority: "verified" });
  });
  const nodes = [0, 1, 2, 3].map(index => ({ nodeId: `${tag}-n${index}`, title: `Scene ${index}`, description: `Public scene ${index} of the ${tag} road.`,
    gmNotes: `SECRET_NODE_${index}`, revealThreshold: index === 0 ? 0 : 1 }));
  const edges = [1, 2, 3].map(index => ({ edgeId: `${tag}-e${index}`, kind: "requires" as const, fromNodeId: `${tag}-n${index - 1}`, toNodeId: `${tag}-n${index}` }));
  f.repo.createCampaignStorylineGraph(OWNER, f.campaign.id, { expectedRevision: f.repo.getCampaignStory(OWNER, f.campaign.id)!.revision,
    idempotencyKey: `${tag}-story`, storyline: { storylineId: "story", title: `${tag} Journey`, summary: "A public road", nodes, edges, plotPoints: [],
      clues: [{ clueId: `${tag}-clue`, title: `${tag} Key`, content: "A brass key lies on the stones.", truth: "SECRET_TRUTH", gmNotes: "SECRET_CLUE",
        revealThreshold: 1, sources: [{ sourceId: `${tag}-clue-src`, kind: "node", targetId: `${tag}-n0` }] }] } });
  f.repo.createCampaignQuest(OWNER, f.campaign.id, { quest: {
    questId: `${tag}-quest-a`, storylineId: "story", title: `Guard the ${tag} market`, description: "A public task.",
    visibility: "public", journalText: "Offered",
    objectives: [{ objectiveId: `${tag}-obj-a`, description: "Keep watch at the market", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }], rewards: [] },
    expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: `${tag}-quest-a-create` });
  db.close();
}

function gradeRun(run: { state: string; receipts: Array<{ action: string }>; narration: string | null }): string[] {
  const failures: string[] = [];
  if (run.state !== "completed") failures.push(`state:${run.state}`);
  if (run.narration === null || run.narration.length === 0) failures.push("missing-narration");
  for (const marker of LEAK_MARKERS) if ((run.narration ?? "").includes(marker)) failures.push(`leak:${marker}`);
  const actions = run.receipts.map(receipt => receipt.action);
  for (const action of actions) if (!KNOWN_ACTIONS.has(action)) failures.push(`unknown-action:${action}`);
  if (new Set(actions).size !== actions.length) failures.push("duplicate-receipt-action");
  return failures;
}

export async function runLiveDirectorPlaytest(options: PlaytestOptions) {
  const directory = await mkdtemp(path.join(tmpdir(), "velvet-playtest-"));
  const priorDataDir = process.env.VELVET_DATA_DIR;
  try {
    process.env.VELVET_DATA_DIR = directory; closeRepo();
    const provider = liveProvider(await readProxyKey(), options.maxUsd / options.beats);
    const f = await dmFixture(false, { dataDir: directory });
    seedWorld(f, options.seed);
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
      const beatFailures = gradeRun(executed);
      const transition = executed.receipts.length > 0 && executed.receipts.every(receipt => PACING_ACTIONS.has(receipt.action));
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
