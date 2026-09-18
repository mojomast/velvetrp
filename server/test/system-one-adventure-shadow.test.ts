import { afterEach, describe, expect, it } from "vitest";
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
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
  ADVENTURE_BEST_KEY,
  ADVENTURE_NONE,
  ADVENTURE_SUPPORTED_KEY,
} from "../src/agent/systemOneAdventure.js";
import {
  defaultHarnessSettings,
  defaultProviderSettings,
  defaultSystemOneLaneModes,
  defaultSystemOneSettings,
} from "../src/defaults.js";
import { createFakeSystemOneCaller } from "../src/provider/systemOneFake.js";
import type { SystemOneAnswer, SystemOneCaller } from "../src/provider/systemOneCompletion.js";
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
 * A D&D fixture turn whose candidate union advertises an SRD strength check next to the public
 * quest objective, so one turn can exercise both the check commit and the provider fallback.
 */
async function checkAdventureTurn() {
  const f = await dmFixture(true);
  f.graph();
  f.repo.createCampaignQuest(OWNER, f.campaign.id, {
    quest: { questId: "gate-quest", storylineId: "story", title: "gate-quest", description: null, visibility: "public", journalText: "Offered",
      objectives: [{ objectiveId: "gate-quest-objective", description: "Complete gate-quest", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }], rewards: [] },
    expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "lane-check-quest",
  });
  f.repo.executeQuestCommand(OWNER, "gate-quest", { kind: "accept",
    expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "lane-check-accept" });
  const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration: "I force the gate open with raw strength.",
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: "lane-check-turn" });
  const check = f.repo.generateAdventureCheckCandidates(OWNER, created.turnId)
    .find((value) => value.label === "Strength (Strength), Easy difficulty, normal");
  if (!check) throw new Error("strength check candidate is unavailable");
  const objective = f.repo.listAdventureQuestObjectiveCandidates(OWNER, created.turnId).find((value) => value.objectiveId === "gate-quest-objective");
  if (!objective) throw new Error("gate quest objective candidate is unavailable");
  return { f, created, check, objective };
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

/**
 * Runs one fresh D&D planning turn through the lane. The lane caller is scripted to pick the
 * requested advertised row, and the provider completion always commits the quest objective, so a
 * reached provider path is observable. `staleCheckOnLaneCall` simulates a concurrent check commit
 * that advances the actor's check revision while the lane model call is in flight, which the
 * lane-origin repository path must reject as stale.
 */
async function runCheckLaneTurn(options: { mode: "shadow" | "active"; pick: "check" | "objective"; staleCheckOnLaneCall?: boolean }) {
  const { f, created, check, objective } = await checkAdventureTurn();
  const picked = options.pick === "check" ? check : objective;
  let providerCalls = 0;
  const base = createFakeSystemOneCaller({
    scripted: {
      [ADVENTURE_SUPPORTED_KEY]: { type: "noul", noul: 0.9 },
      [ADVENTURE_BEST_KEY]: { type: "choice", choice: picked.candidateId, confidence: 0.9,
        probabilities: { [picked.candidateId]: 0.95, [ADVENTURE_NONE]: 0.05 } },
    },
  });
  const caller: SystemOneCaller = async (input) => {
    const result = await base(input);
    if (options.staleCheckOnLaneCall) {
      const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
      db.prepare("INSERT INTO adventure_check_revisions_v54 VALUES(?,?,?,?)")
        .run(f.campaign.id, f.actorId, 1, "2036-01-01T00:00:00.000Z");
      db.close();
    }
    return result;
  };
  const dependencies: AdventureAgentDependencies = {
    complete: async () => {
      providerCalls += 1;
      return { message: { role: "assistant" as const, content: null,
        toolCalls: [{ id: "objective-call", name: "exact_quest_objective.select",
          arguments: JSON.stringify({ candidateId: objective.candidateId, digest: objective.digest }) }] },
        usage: null, model: { requestedModel: "fake", responseModel: "fake" } };
    },
    getProvider: async () => ({ ...defaultProviderSettings(), model: "fake-dm" }),
    getHarness: async () => defaultHarnessSettings(),
    now: f.options.clock.now,
    getSystemOneAdventure: async () => lane(caller, { laneModes: { ...defaultSystemOneLaneModes(), "adventure-selection": options.mode } }),
  };
  const result = await orchestrateAdventureTurn(f.repo, created.turnId, dependencies);
  const decisions = listSystemOneDecisionsByLane("adventure-selection", 10);
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  const execution = db.prepare("SELECT * FROM adventure_check_executions_v54 WHERE turn_id=?").get(created.turnId) as Record<string, unknown> | undefined;
  db.close();
  const receipt = execution
    ? f.repo.getAdventureCheckPublicReceipt(OWNER, f.campaign.id, String(execution.command_id)) : null;
  f.repo.close();
  return { result, decisions, providerCalls, calls: base.calls, execution, receipt, created, check, objective };
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
    const state = decision.state as { declaration: string; candidates: Array<Record<string, unknown>> };
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

describe("System One adventure-selection active check lane", () => {
  // These tests boot a full repository fixture; the 30s budgets are load headroom under parallel
  // forks, not relaxed assertions.
  it("commits a promoted active lane check and skips provider planning", { timeout: 30_000 }, async () => {
    const run = await runCheckLaneTurn({ mode: "active", pick: "check" });

    expect(run.result.outcome).toBe("mechanics-committed");
    expect(run.providerCalls).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.result.turn.receiptLinks).toHaveLength(1);
    // The lane-origin execution is the authoritative evidence of the commit.
    expect(run.execution).toMatchObject({ origin: "lane", provider_call_id: null, provider_tool_call_id: null,
      round_number: null, provider_request_digest: null, provider_response_digest: null });
    expect(run.receipt).toMatchObject({ checkKind: "ability", ability: "Strength", skill: null, mode: "normal",
      difficulty: "Easy", dc: 10 });
    expect(run.decisions).toHaveLength(1);
    const decision = run.decisions[0]!;
    expect(decision).toMatchObject({ lane: "adventure-selection", confidenceBand: "act", turnId: run.result.turn.turnId });
    expect(decision.selection).toMatchObject({ method: "choice",
      selection: { candidateId: run.check.candidateId, digest: run.check.digest } });
    // Ordering: the repository validates that the decision row exists before committing and the
    // decision table is insert-only, so the row is recorded advisory-first and stays shadow:true;
    // the lane-origin execution row, linked by system_one_decision_id, proves the commit.
    expect(decision.shadow).toBe(true);
    expect(run.execution!.system_one_decision_id).toBe(decision.decisionId);
  });

  it("keeps the provider path and records advisory for a promoted active lane non-check pick", { timeout: 30_000 }, async () => {
    const run = await runCheckLaneTurn({ mode: "active", pick: "objective" });

    expect(run.result.outcome).toBe("mechanics-committed");
    expect(run.providerCalls).toBe(1);
    expect(run.calls).toHaveLength(1);
    expect(run.execution).toBeUndefined();
    expect(run.decisions).toHaveLength(1);
    expect(run.decisions[0]).toMatchObject({ shadow: true, confidenceBand: "act" });
    expect(run.decisions[0]!.selection).toMatchObject({ method: "choice",
      selection: { candidateId: run.objective.candidateId, digest: run.objective.digest } });
  });

  it("falls through to the provider when the lane-origin commit rejects a stale check", { timeout: 30_000 }, async () => {
    const run = await runCheckLaneTurn({ mode: "active", pick: "check", staleCheckOnLaneCall: true });

    // The lane decide call happened, the lane-origin commit threw (stale), and the unchanged
    // provider path still finished the turn.
    expect(run.calls).toHaveLength(1);
    expect(run.providerCalls).toBe(1);
    expect(run.result.outcome).toBe("mechanics-committed");
    expect(run.result.turn.receiptLinks).toHaveLength(1);
    // No lane-origin execution and no authoritative-looking decision row for the failed commit.
    expect(run.execution).toBeUndefined();
    expect(run.receipt).toBeNull();
    expect(run.decisions).toHaveLength(1);
    expect(run.decisions[0]!.shadow).toBe(true);
    expect(run.decisions.some((decision) => !decision.shadow)).toBe(false);
  });

  it("records advisory and never executes when the lane mode is shadow", { timeout: 30_000 }, async () => {
    const run = await runCheckLaneTurn({ mode: "shadow", pick: "check" });

    expect(run.result.outcome).toBe("mechanics-committed");
    expect(run.providerCalls).toBe(1);
    expect(run.calls).toHaveLength(1);
    expect(run.execution).toBeUndefined();
    expect(run.receipt).toBeNull();
    expect(run.decisions).toHaveLength(1);
    // Shadow mode is about authority, not the composed band: the active test above pins the
    // band/selection for the same fixture. Here the invariants are a single advisory record and
    // no lane-origin execution.
    expect(run.decisions[0]).toMatchObject({ shadow: true });
  });
});

describe("adventure-selection candidate union projection", () => {
  const families = {
    travel: [], questObjective: [], srdCheck: [], inventory: [], commerce: [], power: [], rest: [],
    combatConsumable: [], combatPower: [], questLifecycle: [], progression: [],
  };

  /** One digest-bound advertised row for the union projection fixtures. */
  const shadowRow = (prefix: string, index: number, action: string) => ({
    candidateId: `${prefix}:${index}`, digest: `${prefix}:${index}`.padEnd(64, "0"),
    semanticLabel: { action, source: `${action} ${index}`, target: null, cost: null, consequence: "Select this server-issued candidate." },
  });

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

  it("selects round-robin so a large check family cannot crowd advertised lifecycle rows out of the cap", () => {
    const checks = Array.from({ length: ADVENTURE_SHADOW_CANDIDATE_CAP + 8 }, (_value, index) =>
      shadowRow("check-candidate", index, "Roll a check"));
    const build = () => adventureShadowCandidateUnion({ ...families,
      questObjective: [shadowRow("quest-candidate", 0, "Advance quest objective")],
      srdCheck: checks,
      inventory: [shadowRow("inventory-candidate", 0, "Use an item")],
      commerce: [shadowRow("commerce-candidate", 0, "Trade with a vendor")],
      power: [shadowRow("power-candidate", 0, "Use a power")],
      rest: [shadowRow("rest-candidate", 0, "Take a rest")],
      combatConsumable: [shadowRow("consumable-candidate", 0, "Use a combat consumable")],
      combatPower: [shadowRow("combat-power-candidate", 0, "Use a combat power")],
      questLifecycle: [shadowRow("lifecycle-candidate", 0, "Accept quest"), shadowRow("lifecycle-candidate", 1, "Abandon quest")],
      progression: [shadowRow("progression-candidate", 0, "Apply progression")],
    });

    const union = build();
    const repeat = build();

    expect(union).toHaveLength(ADVENTURE_SHADOW_CANDIDATE_CAP);
    // Every advertised family is represented before the check family takes its extra slots.
    expect(new Set(union.map((candidate) => candidate.kind))).toEqual(new Set([
      "exact_quest_objective.select", "exact_srd_check.select", "exact_inventory_action.select",
      "exact_vendor_commerce.select", "exact_power_use.select", "exact_rest.select",
      "exact_combat_consumable.select", "exact_combat_power.select", "exact_quest_lifecycle.select",
      "exact_progression_apply.select",
    ]));
    // The lifecycle rows the old checks-first fill would have pushed past the cap survive it.
    expect(union.filter((candidate) => candidate.kind === "exact_quest_lifecycle.select")
      .map((candidate) => candidate.candidateId)).toEqual(["lifecycle-candidate:0", "lifecycle-candidate:1"]);
    // Selection is deterministic and each family keeps its advertised row order.
    expect(repeat).toEqual(union);
    const selectedChecks = union.filter((candidate) => candidate.kind === "exact_srd_check.select");
    expect(selectedChecks.map((candidate) => candidate.candidateId))
      .toEqual(checks.slice(0, selectedChecks.length).map((candidate) => candidate.candidateId));
    expect(selectedChecks.length).toBeLessThan(checks.length);
  });

  it("keeps a union at or under the cap in the advertised family and row order", () => {
    const union = adventureShadowCandidateUnion({ ...families,
      questObjective: [shadowRow("quest-candidate", 0, "Advance quest objective")],
      srdCheck: [shadowRow("check-candidate", 0, "Roll a check")],
      questLifecycle: [shadowRow("lifecycle-candidate", 0, "Accept quest")],
    });

    expect(union.map((candidate) => candidate.candidateId)).toEqual([
      "quest-candidate:0", "check-candidate:0", "lifecycle-candidate:0",
    ]);
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
