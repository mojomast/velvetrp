import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CampaignDmCandidate } from "@velvet/contracts";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { DM_WORLD_TIME_STEP_MINUTES } from "../src/repo/campaignDmRepo.js";
import { dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { gradeDmRun, seedLivingWorld } from "./fixtures/livingWorld.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

// resolve-node is intentionally absent: this director only advances public story, then paces the world.
const MECHANICAL_PRIORITY: Array<CampaignDmCandidate["action"]> = ["reveal-node", "reveal-clue",
  "encounter-start", "encounter-materialize", "enemy-turn", "encounter-complete"];

/** Deterministic replacement for the live director: advance the story first, then pace the world. */
function chooseComposition(candidates: CampaignDmCandidate[]): Array<{ candidateId: string; digest: string }> {
  for (const action of MECHANICAL_PRIORITY) {
    const candidate = candidates.find((value) => value.action === action);
    if (candidate) return [{ candidateId: candidate.candidateId, digest: candidate.digest }];
  }
  const ambient = candidates.find((value) => value.action === "ambient-beat");
  const advance = candidates.find((value) => value.action === "advance-time");
  return [ambient, advance].filter((value): value is CampaignDmCandidate => value !== undefined)
    .map(({ candidateId, digest }) => ({ candidateId, digest }));
}

function completion(input: ProviderCompletionInput): ProviderCompletionResult {
  if (input.promptVersion === "campaign-dm-narration-v1") {
    return { message: { role: "assistant", content: null, toolCalls: [{ id: "scene", name: "submit_dm_scene",
      arguments: JSON.stringify({ atmosphere: "The market holds a quiet, watchful rhythm.", dialogue: [], question: "What do you do?" }) }] },
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, model: { requestedModel: "fake-world", responseModel: "fake-world" } };
  }
  const data = JSON.parse(input.messages[1]!.content as string) as { candidates: CampaignDmCandidate[] };
  return { message: { role: "assistant", content: null, toolCalls: [{ id: "select", name: "select_dm_beat",
    arguments: JSON.stringify({ composition: chooseComposition(data.candidates) }) }] },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: { requestedModel: "fake-world", responseModel: "fake-world" } };
}

async function drive(seed: number, mode: "ai" | "human", beats: number) {
  const f = await dmFixture();
  seedLivingWorld(f, seed);
  let dispatches = 0;
  const base = dmDependencies(async (input) => { dispatches += 1; return completion(input); });
  const deps: AdventureAgentDependencies = base;
  const failures: string[] = [];
  let transitions = 0, advances = 0, lastRunId = "";
  if (mode === "ai") {
    const control = f.repo.getDmControl("local-owner", f.campaign.id);
    f.repo.setDmControl("local-owner", f.campaign.id, { mode: "ai", expectedRevision: control.revision, idempotencyKey: `world-${seed}-ai` });
  }
  for (let index = 0; index < beats; index += 1) {
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id, { intent: index === 0 ? "open" : "continue",
      expectedModeRevision: f.repo.getDmControl("local-owner", f.campaign.id).revision, idempotencyKey: `world-${seed}-${index}` });
    lastRunId = run.runId;
    await orchestrateCampaignDmBeat(f.repo, "local-owner", run.runId, deps);
    if (mode === "human") {
      const proposal = f.repo.getDmProposal("local-owner", f.campaign.id, f.session.id, run.runId);
      if (proposal.run.state === "awaiting-approval") {
        f.repo.decideDmBeat("local-owner", f.campaign.id, f.session.id, run.runId,
          { decision: "approved", expectedRevision: proposal.run.revision, idempotencyKey: `world-${seed}-approve-${index}` });
        await orchestrateCampaignDmBeat(f.repo, "local-owner", run.runId, deps);
      }
    }
    const executed = f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, run.runId);
    failures.push(...gradeDmRun(executed).map((failure) => `beat${index}:${failure}`));
    if (executed.receipts.length > 0 && executed.receipts.every((receipt) => ["advance-time", "ambient-beat"].includes(receipt.action))) transitions += 1;
    advances += executed.receipts.filter((receipt) => receipt.action === "advance-time").length;
  }
  // Recovery/re-inspection is a no-op and never spends a provider call.
  const beforeReplay = dispatches;
  await orchestrateCampaignDmBeat(f.repo, "local-owner", lastRunId, deps);
  f.repo.getDmHistory("local-owner", f.campaign.id, f.session.id);
  if (dispatches !== beforeReplay) failures.push("replay-called-provider");
  const db = database();
  const elapsed = (db.prepare("SELECT elapsed_minutes FROM world_expeditions_v60 WHERE campaign_id=? AND session_id=?")
    .get(f.campaign.id, f.session.id) as { elapsed_minutes: number } | undefined)?.elapsed_minutes ?? 0;
  db.close();
  f.repo.close();
  return { failures, transitions, advances, elapsed };
}

describe("deterministic living-world campaign across generated worlds", () => {
  it.each([
    { seed: 11, mode: "ai" as const }, { seed: 12, mode: "human" as const }, { seed: 13, mode: "ai" as const },
  ])("keeps a generated world $mode coherent for $seed", async ({ seed, mode }) => {
    const result = await drive(seed, mode, 8);
    expect(result.failures).toEqual([]);
    expect(result.transitions).toBeGreaterThan(0);
    // Every transition step is the server-fixed size and never an arbitrary model value.
    expect(result.elapsed).toBe(result.advances * DM_WORLD_TIME_STEP_MINUTES);
  });
});
