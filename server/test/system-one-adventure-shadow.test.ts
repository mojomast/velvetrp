import { afterEach, describe, expect, it } from "vitest";
import {
  ADVENTURE_SHADOW_CANDIDATE_CAP,
  adventureShadowCandidateUnion,
  orchestrateAdventureTurn,
  recordAdventureShadowDecision,
  resolveSystemOneAdventure,
  type AdventureAgentDependencies,
  type AdventureAgentResult,
  type SystemOneAdventureDependency,
} from "../src/agent/adventureOrchestrator.js";
import {
  defaultHarnessSettings,
  defaultProviderSettings,
  defaultSystemOneLaneModes,
  defaultSystemOneSettings,
} from "../src/defaults.js";
import { createFakeSystemOneCaller } from "../src/provider/systemOneFake.js";
import type { SystemOneCaller } from "../src/provider/systemOneCompletion.js";
import { createRepository, listSystemOneDecisionsByLane, updateSystemOneSettings } from "../src/repo/index.js";
import type { SystemOneSettings } from "../src/types.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { makeTmpDataDir, useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";

afterEach(() => {
  delete process.env.FEATURE_SYSTEM_ONE;
});

function lane(caller: SystemOneCaller, overrides: Partial<SystemOneSettings> = {}): SystemOneAdventureDependency {
  return { settings: { ...defaultSystemOneSettings(), enabled: true, laneModes: defaultSystemOneLaneModes(), apiKey: "test-key", ...overrides }, caller };
}

/** A settled campaign with one accepted public quest, one declared adventure turn, and its exact objective candidate. */
async function adventureTurn() {
  const f = await dmFixture();
  f.graph();
  f.repo.createCampaignQuest(OWNER, f.campaign.id, {
    quest: { questId: "gate-quest", storylineId: "story", title: "gate-quest", description: null, visibility: "public", journalText: "Offered",
      objectives: [{ objectiveId: "gate-quest-objective", description: "Complete gate-quest", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }], rewards: [] },
    expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "create-gate-quest",
  });
  f.repo.executeQuestCommand(OWNER, "gate-quest", { kind: "accept",
    expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "accept-gate-quest" });
  const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration: "I complete the gate quest.",
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: "shadow-turn" });
  const candidate = f.repo.listAdventureQuestObjectiveCandidates(OWNER, created.turnId).find((value) => value.objectiveId === "gate-quest-objective");
  if (!candidate) throw new Error("gate quest objective candidate is unavailable");
  return { f, created, candidate };
}

/**
 * Runs one fresh-planning turn that commits the exact quest objective candidate. The optional
 * lane factory is the only difference between the shadow and baseline runs.
 */
async function runTurn(laneFactory?: () => SystemOneAdventureDependency) {
  const { f, created, candidate } = await adventureTurn();
  let providerCalls = 0;
  let laneResolutions = 0;
  let advertisedTools: string[] = [];
  let messageCount = 0;
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
    ...(laneFactory ? { getSystemOneAdventure: async () => { laneResolutions += 1; return laneFactory(); } } : {}),
  };
  const result = await orchestrateAdventureTurn(f.repo, created.turnId, dependencies);
  const decisions = listSystemOneDecisionsByLane("adventure-selection", 10);
  f.repo.close();
  return { result, decisions, providerCalls, laneResolutions, advertisedTools, messageCount, candidate };
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

describe("System One adventure-selection shadow lane", () => {
  it("records one advisory decision while the committed turn and provider calls stay identical", async () => {
    const caller = createFakeSystemOneCaller();
    const shadow = await runTurn(() => lane(caller));

    expect(shadow.result.outcome).toBe("mechanics-committed");
    expect(shadow.result.turn.receiptLinks).toHaveLength(1);
    expect(shadow.providerCalls).toBe(1);
    expect(shadow.laneResolutions).toBe(1);
    expect(caller.calls).toHaveLength(1);
    const questions = caller.calls[0]!.questions as Record<string, unknown>;
    expect(Object.keys(questions)).toContain("best_candidate");
    expect(Object.keys(questions)).toContain(`relevance:${shadow.candidate.candidateId}`);

    expect(shadow.decisions).toHaveLength(1);
    const decision = shadow.decisions[0]!;
    expect(decision).toMatchObject({ lane: "adventure-selection", shadow: true, fallbackUsed: true, provider: "typesafe",
      confidencePolicyVersion: "system-one-confidence-v1", confidenceBand: "act", turnId: shadow.result.turn.turnId,
      campaignId: shadow.result.turn.campaignId, sessionId: shadow.result.turn.sessionId });
    // The model reasoned over exactly the persisted state, and the union is the advertised bounded set.
    expect(caller.calls[0]!.state).toEqual(decision.state);
    const state = JSON.parse(decision.state as string) as { declaration: string; candidates: Array<Record<string, unknown>> };
    expect(state.declaration).toBe("I complete the gate quest.");
    expect(state.candidates.length).toBeGreaterThan(0);
    expect(state.candidates.length).toBeLessThanOrEqual(32);
    expect(state.candidates).toContainEqual(expect.objectContaining({ candidateId: shadow.candidate.candidateId,
      kind: "exact_quest_objective.select" }));
    expect(decision.selection).toMatchObject({ method: "choice",
      selection: { candidateId: shadow.candidate.candidateId, digest: shadow.candidate.digest } });
    expect((decision.selection as { topSignal: number }).topSignal).toBeCloseTo(0.9);

    makeTmpDataDir();
    const baseline = await runTurn();
    expect(baseline.decisions).toHaveLength(0);
    expect(baseline.providerCalls).toBe(1);
    expect(turnProjection(baseline.result)).toEqual(turnProjection(shadow.result));
    // The shadow lane adds no advertised tool, no provider call, and no prompt frame.
    expect(shadow.advertisedTools).toEqual(baseline.advertisedTools);
    expect(shadow.messageCount).toBe(baseline.messageCount);
  });

  it("swallows a throwing caller and still commits the identical turn", async () => {
    const baseline = await runTurn();
    expect(baseline.decisions).toHaveLength(0);

    makeTmpDataDir();
    const shadow = await runTurn(() => lane(createFakeSystemOneCaller({ failWith: new Error("adventure shadow endpoint down") })));
    expect(shadow.result.outcome).toBe("mechanics-committed");
    expect(shadow.result.turn.receiptLinks).toHaveLength(1);
    expect(shadow.providerCalls).toBe(1);
    expect(shadow.decisions).toHaveLength(0);
    expect(turnProjection(shadow.result)).toEqual(turnProjection(baseline.result));
    expect(shadow.advertisedTools).toEqual(baseline.advertisedTools);
    expect(shadow.messageCount).toBe(baseline.messageCount);
  });

  it("records nothing and never calls the model when the lane mode is off", async () => {
    const caller = createFakeSystemOneCaller();
    const run = await runTurn(() => lane(caller, { laneModes: { ...defaultSystemOneLaneModes(), "adventure-selection": "off" } }));

    expect(run.result.outcome).toBe("mechanics-committed");
    expect(run.laneResolutions).toBe(1);
    expect(caller.calls).toHaveLength(0);
    expect(run.decisions).toHaveLength(0);
  });

  it("makes no model call when the candidate union is empty", async () => {
    const { f, created } = await adventureTurn();
    const caller = createFakeSystemOneCaller();

    await recordAdventureShadowDecision(created, [], lane(caller));

    expect(caller.calls).toHaveLength(0);
    expect(listSystemOneDecisionsByLane("adventure-selection", 10)).toHaveLength(0);
    f.repo.close();
  });
});

describe("adventure-selection candidate union projection", () => {
  const families = {
    travel: [], questObjective: [], srdCheck: [], inventory: [], commerce: [], power: [], rest: [],
    combatConsumable: [], combatPower: [], questLifecycle: [], progression: [],
  };

  it("projects a travel row with an explicit advisory binding instead of a digest", () => {
    const union = adventureShadowCandidateUnion({ ...families, travel: [{ candidateId: "travel-candidate:x", kind: "actor.travel", version: "v1",
      label: { format: "message-key-v1", key: "candidate.actor.travel.label", routeOption: 1 },
      semanticLabel: { action: "Travel", source: "Old Gate", target: "Silver Harbor", cost: null, consequence: "Move." },
      summary: { format: "message-key-v1", key: "candidate.actor.travel.summary" },
      confirmation: { required: false }, quote: { kind: "not-applicable" }, expiresAt: "2036-01-01T01:00:00.000Z", choices: [] }] });

    expect(union).toEqual([{ candidateId: "travel-candidate:x", kind: "exact_actor_travel.select",
      digest: "advisory-not-a-digest:travel-candidate:x:actor.travel:v1", label: "Travel: Old Gate → Silver Harbor" }]);
  });

  it("caps the union at the shadow candidate bound", () => {
    const candidates = Array.from({ length: ADVENTURE_SHADOW_CANDIDATE_CAP + 8 }, (_value, index) => ({
      candidateId: `quest-candidate:${index}`, digest: String(index).padEnd(64, "0"),
      semanticLabel: { action: "Advance quest objective", source: `Quest ${index}`, target: null, cost: null, consequence: "Advance." },
    }));

    const union = adventureShadowCandidateUnion({ ...families, questObjective: candidates });

    expect(union).toHaveLength(ADVENTURE_SHADOW_CANDIDATE_CAP);
    expect(union[0]).toMatchObject({ candidateId: "quest-candidate:0", kind: "exact_quest_objective.select" });
  });
});

describe("System One adventure-selection resolver", () => {
  it("gates on the feature flag, enabled settings, a usable key, and a non-off lane", async () => {
    createRepository();
    process.env.FEATURE_SYSTEM_ONE = "true";

    await updateSystemOneSettings({ enabled: false, apiKey: "test-key" });
    expect(await resolveSystemOneAdventure()).toBeUndefined();

    await updateSystemOneSettings({ enabled: true, apiKey: "" });
    expect(await resolveSystemOneAdventure()).toBeUndefined();

    await updateSystemOneSettings({ enabled: true, apiKey: "test-key", laneModes: { "adventure-selection": "off" } });
    expect(await resolveSystemOneAdventure()).toBeUndefined();

    await updateSystemOneSettings({ laneModes: { "adventure-selection": "shadow" } });
    delete process.env.FEATURE_SYSTEM_ONE;
    expect(await resolveSystemOneAdventure()).toBeUndefined();

    process.env.FEATURE_SYSTEM_ONE = "true";
    const resolved = await resolveSystemOneAdventure();
    expect(resolved?.settings.enabled).toBe(true);
    expect(resolved?.settings.apiKey).toBe("test-key");
    expect(typeof resolved?.caller).toBe("function");
  });
});
