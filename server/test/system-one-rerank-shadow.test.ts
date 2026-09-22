import { systemOneShadowQueue } from "../src/agent/systemOneShadow.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  RERANK_SHADOW_CANDIDATE_CAP,
  orchestrateAdventureTurn,
  recordRerankShadowDecision,
  rerankShadowCandidates,
  resolveSystemOneRerank,
  type AdventureAgentDependencies,
  type AdventureAgentResult,
  type SystemOneRerankDependency,
} from "../src/agent/adventureOrchestrator.js";
import {
  RERANK_ANSWERS_PREFIX,
  RERANK_RELEVANCE_PREFIX,
  composeRerankOrder,
  type RerankCandidate,
} from "../src/agent/systemOneRerank.js";
import {
  defaultHarnessSettings,
  defaultProviderSettings,
  defaultSystemOneLaneModes,
  defaultSystemOneSettings,
} from "../src/defaults.js";
import { createFakeSystemOneCaller } from "../src/provider/systemOneFake.js";
import type { SystemOneAnswer, SystemOneCaller } from "../src/provider/systemOneCompletion.js";
import type { CampaignRecallHit } from "../src/repo/campaign/campaignRecallReadRepo.js";
import { createRepository, listSystemOneDecisionsByLane, updateSystemOneSettings } from "../src/repo/index.js";
import type { SystemOneSettings } from "../src/types.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { makeTmpDataDir, useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
/** The production default policy for the lane, so the expected composition matches the hook. */
const RERANK_THRESHOLDS = defaultSystemOneSettings().confidencePolicy["memory-reranking"];

afterEach(() => {
  delete process.env.FEATURE_SYSTEM_ONE;
});

function lane(caller: SystemOneCaller, overrides: Partial<SystemOneSettings> = {}): SystemOneRerankDependency {
  return { settings: { ...defaultSystemOneSettings(), enabled: true, laneModes: defaultSystemOneLaneModes(), apiKey: "test-key", ...overrides }, caller };
}

/** Deterministic answers that lift the second-ranked candidate above the first, an advisory reorder. */
function scriptedRerankAnswers(candidates: readonly RerankCandidate[]): Record<string, SystemOneAnswer> {
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [index, candidate] of candidates.entries()) {
    answers[`${RERANK_RELEVANCE_PREFIX}${candidate.candidateId}`] = {
      type: "score", score: index === 0 ? 0 : 3, confidence: 1, legend: {}, probabilities: {},
    };
    answers[`${RERANK_ANSWERS_PREFIX}${candidate.candidateId}`] = { type: "noul", noul: 0.9 };
  }
  return answers;
}

const DECLARATION = "I complete the gate quest.";
/** Three prior declarations the current turn's recall query ("complete gate quest") retrieves. */
const PRIOR_DECLARATIONS = ["The gate quest remains open", "I inspect the gate stones", "The quest log mentions the gate"];

/**
 * A settled campaign with one accepted public quest, three prior recall-able declarations, and
 * one fresh declared turn with its exact objective candidate. The recall is projected with the
 * same exported helper the hook uses, so the test can script answers per candidate id.
 */
async function rerankTurn() {
  const f = await dmFixture();
  f.graph();
  f.repo.createCampaignQuest(OWNER, f.campaign.id, {
    quest: { questId: "gate-quest", storylineId: "story", title: "gate-quest", description: null, visibility: "public", journalText: "Offered",
      objectives: [{ objectiveId: "gate-quest-objective", description: "Complete gate-quest", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }], rewards: [] },
    expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "create-gate-quest",
  });
  f.repo.executeQuestCommand(OWNER, "gate-quest", { kind: "accept",
    expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "accept-gate-quest" });
  for (const [index, declaration] of PRIOR_DECLARATIONS.entries()) {
    f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
      sessionId: f.session.id, actorId: f.actorId, declaration,
      expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: `recall-${index}` });
  }
  const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration: DECLARATION,
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: "shadow-turn" });
  const candidate = f.repo.listAdventureQuestObjectiveCandidates(OWNER, created.turnId).find((value) => value.objectiveId === "gate-quest-objective");
  if (!candidate) throw new Error("gate quest objective candidate is unavailable");
  const recall = f.repo.getCampaignRecall(OWNER, { campaignId: f.campaign.id, sessionId: f.session.id,
    audience: { kind: "player", actorId: f.actorId }, query: DECLARATION, purpose: "adventure-planning", excludeRootTurnId: created.turnId });
  if (!recall) throw new Error("adventure planning recall is unavailable");
  const candidates = rerankShadowCandidates(recall.hits);
  if (candidates.length < PRIOR_DECLARATIONS.length) throw new Error("the rerank fixture lost a recall candidate");
  return { f, created, candidate, recall, candidates };
}

/**
 * Runs one fresh-planning turn that commits the exact quest objective candidate. The optional
 * lane factory is the only difference between the shadow and baseline runs.
 */
async function runTurn(options: { lane?: (caller: SystemOneCaller) => SystemOneRerankDependency; onTurnComplete?: () => void } = {}) {
  const { f, created, candidate, recall, candidates } = await rerankTurn();
  let providerCalls = 0;
  let laneResolutions = 0;
  let advertisedTools: string[] = [];
  let messageCount = 0;
  const caller = createFakeSystemOneCaller({ scripted: scriptedRerankAnswers(candidates) });
  const dependencies: AdventureAgentDependencies = {
    complete: async (input) => {
      providerCalls += 1;
      advertisedTools = (input.tools ?? []).map((tool) => tool.name);
      messageCount = input.messages.length;
      return { message: { role: "assistant" as const, content: null,
        toolCalls: [{ id: "objective-call", name: "exact_quest_objective.select",
          arguments: JSON.stringify({ candidateId: candidate.candidateId, digest: candidate.digest }) }] },
        usage: null, model: { requestedModel: "fake", responseModel: "fake" } };
    },
    getProvider: async () => ({ ...defaultProviderSettings(), model: "fake-dm" }),
    getHarness: async () => defaultHarnessSettings(),
    now: f.options.clock.now,
  };
  const resolved = options.lane?.(caller);
  if (resolved) {
    dependencies.getSystemOneRerank = async () => { laneResolutions += 1; return resolved; };
  }
  const result = await orchestrateAdventureTurn(f.repo, created.turnId, dependencies);
  options.onTurnComplete?.();
  await systemOneShadowQueue.drain();
  const decisions = listSystemOneDecisionsByLane("memory-reranking", 10);
  f.repo.close();
  return { result, decisions, providerCalls, laneResolutions, advertisedTools, messageCount, caller, query: recall.query, candidates, candidate };
}

/** The turn's own public decision surface with run-local identifiers removed. */
function turnProjection(result: AdventureAgentResult) {
  return {
    outcome: result.outcome,
    state: result.turn.state,
    declaration: result.turn.declaration,
    narrationStatus: result.turn.narrationStatus,
    mode: result.turn.mode,
    toolCalls: result.turn.toolCalls.map((call) => ({ toolName: call.proposal.toolName, status: call.status,
      confirmation: call.proposal.confirmation.state })),
    receiptCount: result.turn.receiptLinks.length,
    limitations: [...result.limitations],
  };
}

describe("System One memory-reranking shadow lane", () => {
  it("completes the turn while shadow inference is still blocked", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    let completedBeforeShadow = false;
    // Safety cleanup only; the assertion fails if completion needed this timer.
    const timer = setTimeout(release, 3000);
    try {
      const result = await runTurn({
        lane: (caller) => lane(async (input) => { await gate; const result = await caller(input); finished = true; return result; }),
        onTurnComplete: () => { completedBeforeShadow = !finished; release(); },
      });
      expect(completedBeforeShadow).toBe(true);
      expect(result.result.outcome).toBe("mechanics-committed");
      expect(result.decisions).toHaveLength(1);
    } finally { clearTimeout(timer); release(); }
  });
  it("records one advisory decision while the committed turn and provider calls stay identical", async () => {
    const shadow = await runTurn({ lane: (caller) => lane(caller) });

    expect(shadow.result.outcome).toBe("mechanics-committed");
    expect(shadow.result.turn.receiptLinks).toHaveLength(1);
    expect(shadow.providerCalls).toBe(1);
    expect(shadow.laneResolutions).toBe(1);
    expect(shadow.caller.calls).toHaveLength(1);
    const questions = shadow.caller.calls[0]!.questions as Record<string, unknown>;
    for (const candidate of shadow.candidates) {
      expect(Object.keys(questions)).toContain(`${RERANK_RELEVANCE_PREFIX}${candidate.candidateId}`);
      expect(Object.keys(questions)).toContain(`${RERANK_ANSWERS_PREFIX}${candidate.candidateId}`);
    }

    expect(shadow.decisions).toHaveLength(1);
    const decision = shadow.decisions[0]!;
    expect(decision).toMatchObject({ lane: "memory-reranking", shadow: true, fallbackUsed: true, provider: "typesafe",
      confidencePolicyVersion: "system-one-confidence-v1", confidenceBand: "act", turnId: shadow.result.turn.turnId,
      campaignId: shadow.result.turn.campaignId, sessionId: shadow.result.turn.sessionId });
    // The model reasoned over exactly the persisted structured state.
    expect(shadow.caller.calls[0]!.state).toEqual(decision.state);
    const state = decision.state as { query: string; purpose: string; candidates: RerankCandidate[] };
    expect(state.query).toBe(shadow.query);
    expect(state.purpose).toBe("adventure-planning");
    expect(state.candidates.map((candidate) => candidate.candidateId)).toEqual(shadow.candidates.map((candidate) => candidate.candidateId));
    // The selection carries the composed advisory order, not the deterministic recall order.
    const expected = composeRerankOrder({ query: shadow.query, candidates: shadow.candidates },
      scriptedRerankAnswers(shadow.candidates), RERANK_THRESHOLDS);
    const selection = decision.selection as { order: string[]; band: string; topSignal: number };
    expect(selection.order).toEqual(expected.order);
    expect(selection.order).not.toEqual(shadow.candidates.map((candidate) => candidate.candidateId));
    expect(selection.band).toBe(expected.band);
    expect(selection.topSignal).toBeCloseTo(0.9, 6);

    makeTmpDataDir();
    const baseline = await runTurn();
    expect(baseline.decisions).toHaveLength(0);
    expect(baseline.providerCalls).toBe(1);
    expect(baseline.laneResolutions).toBe(0);
    expect(JSON.stringify(turnProjection(shadow.result))).toBe(JSON.stringify(turnProjection(baseline.result)));
    // The shadow lane adds no advertised tool, no provider call, and no prompt frame.
    expect(shadow.advertisedTools).toEqual(baseline.advertisedTools);
    expect(shadow.messageCount).toBe(baseline.messageCount);
  });

  it("swallows a throwing caller and still commits the identical turn", async () => {
    const baseline = await runTurn();
    expect(baseline.decisions).toHaveLength(0);

    makeTmpDataDir();
    const shadow = await runTurn({ lane: () => lane(createFakeSystemOneCaller({ failWith: new Error("rerank shadow endpoint down") })) });
    expect(shadow.result.outcome).toBe("mechanics-committed");
    expect(shadow.result.turn.receiptLinks).toHaveLength(1);
    expect(shadow.providerCalls).toBe(1);
    expect(shadow.decisions).toHaveLength(0);
    expect(JSON.stringify(turnProjection(shadow.result))).toBe(JSON.stringify(turnProjection(baseline.result)));
    expect(shadow.advertisedTools).toEqual(baseline.advertisedTools);
    expect(shadow.messageCount).toBe(baseline.messageCount);
  });

  it("records nothing and never calls the model when the lane mode is off", async () => {
    const run = await runTurn({ lane: (caller) => lane(caller, {
      laneModes: { ...defaultSystemOneLaneModes(), "memory-reranking": "off" } }) });

    expect(run.result.outcome).toBe("mechanics-committed");
    expect(run.laneResolutions).toBe(1);
    expect(run.caller.calls).toHaveLength(0);
    expect(run.decisions).toHaveLength(0);
  });

  it("records the shortlist as structured state and the composed advisory order in the selection", async () => {
    const { f, created, candidates } = await rerankTurn();
    const turn = f.repo.getAdventureTurn(OWNER, created.turnId)!;
    if (!("declaration" in turn)) throw new Error("private turn is unavailable");
    const caller = createFakeSystemOneCaller({ scripted: scriptedRerankAnswers(candidates) });

    await recordRerankShadowDecision(turn, "gate quest", candidates, lane(caller));

    const decisions = listSystemOneDecisionsByLane("memory-reranking", 10);
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]!;
    expect(decision.state).not.toBeTypeOf("string");
    const state = decision.state as { query: string; candidates: RerankCandidate[] };
    expect(state.query).toBe("gate quest");
    expect(state.candidates).toEqual(candidates);
    const expected = composeRerankOrder({ query: "gate quest", candidates }, scriptedRerankAnswers(candidates), RERANK_THRESHOLDS);
    expect(decision.selection).toMatchObject({ order: expected.order, band: expected.band });
    expect(decision.confidenceBand).toBe(expected.band);
    f.repo.close();
  });

  it("makes no model call when the recall is empty or the shortlist is too small", async () => {
    const { f, created, candidates } = await rerankTurn();
    const turn = f.repo.getAdventureTurn(OWNER, created.turnId)!;
    if (!("declaration" in turn)) throw new Error("private turn is unavailable");
    const caller = createFakeSystemOneCaller();

    await recordRerankShadowDecision(turn, "gate quest", [], lane(caller));
    await recordRerankShadowDecision(turn, "gate quest", candidates.slice(0, 1), lane(caller));

    expect(caller.calls).toHaveLength(0);
    expect(listSystemOneDecisionsByLane("memory-reranking", 10)).toHaveLength(0);
    f.repo.close();
  });
});

describe("memory-reranking shortlist projection", () => {
  const hit = (sourceId: string, text: string, sourceKind: CampaignRecallHit["sourceKind"] = "declaration"): CampaignRecallHit => ({
    sourceKind, authority: "intent", sourceId, digest: sourceId.padEnd(64, "0"), sessionId: "session", timelineId: "timeline",
    rootTurnId: sourceId, actorId: "actor", text,
  });

  it("deduplicates by source id, keeps the recall order, and labels from the source kind", () => {
    const hits = [hit("alpha", "first"), hit("alpha", "duplicate", "presentation"),
      hit("bravo", "second", "presentation"), hit("charlie", "third", "recap")];

    expect(rerankShadowCandidates(hits)).toEqual([
      { candidateId: "alpha", label: "declaration", text: "first", rank: 0 },
      { candidateId: "bravo", label: "presentation", text: "second", rank: 1 },
      { candidateId: "charlie", label: "recap", text: "third", rank: 2 },
    ]);
  });

  it("bounds the shortlist at the shadow candidate cap", () => {
    const hits = Array.from({ length: RERANK_SHADOW_CANDIDATE_CAP + 4 }, (_value, index) => hit(`hit-${index}`, `text ${index}`));

    expect(rerankShadowCandidates(hits)).toHaveLength(RERANK_SHADOW_CANDIDATE_CAP);
    expect(rerankShadowCandidates([])).toEqual([]);
  });
});

describe("System One memory-reranking resolver", () => {
  it("gates on the feature flag, enabled settings, a usable key, and a non-off lane", async () => {
    createRepository();
    process.env.FEATURE_SYSTEM_ONE = "true";

    await updateSystemOneSettings({ enabled: false, apiKey: "test-key" });
    expect(await resolveSystemOneRerank()).toBeUndefined();

    await updateSystemOneSettings({ enabled: true, apiKey: "" });
    expect(await resolveSystemOneRerank()).toBeUndefined();

    await updateSystemOneSettings({ enabled: true, apiKey: "test-key", laneModes: { "memory-reranking": "off" } });
    expect(await resolveSystemOneRerank()).toBeUndefined();

    await updateSystemOneSettings({ laneModes: { "memory-reranking": "shadow" } });
    delete process.env.FEATURE_SYSTEM_ONE;
    expect(await resolveSystemOneRerank()).toBeUndefined();

    process.env.FEATURE_SYSTEM_ONE = "true";
    const resolved = await resolveSystemOneRerank();
    expect(resolved?.settings.enabled).toBe(true);
    expect(resolved?.settings.apiKey).toBe("test-key");
    expect(typeof resolved?.caller).toBe("function");
  });
});
