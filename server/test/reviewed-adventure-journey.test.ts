import { afterEach, describe, expect, it } from "vitest";
import { adventureTurnStreamEventSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { createRepository } from "../src/repo/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { cleanupTmpDataDirs, makeTmpDataDir } from "./helpers.js";
import { createReviewedAdventure, REVIEWED_ADVENTURE_PRIVATE_SENTINEL } from "./fixtures/reviewedAdventure.js";

const headers = { "content-type": "application/json" };

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
  cleanupTmpDataDirs();
});

function streamEvents(body: string) {
  return body.split("\n\n").filter((frame) => frame.startsWith("event: ")).map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new Error("SSE frame has no data");
    return adventureTurnStreamEventSchema.parse(JSON.parse(data.slice(6)));
  });
}

function result(toolName: string, argumentsValue: unknown): ProviderCompletionResult {
  return {
    message: { role: "assistant", content: null, toolCalls: [{ id: `fake:${toolName}`, name: toolName, arguments: JSON.stringify(argumentsValue) }] },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: { requestedModel: "reviewed-journey", responseModel: "reviewed-journey" },
  };
}

function candidateOptions(input: ProviderCompletionInput): any[] {
  const message = input.messages.find((entry) => typeof entry.content === "string" && entry.content.startsWith("UNTRUSTED CURRENT EXACT CANDIDATE TABLE"));
  if (!message || typeof message.content !== "string") throw new Error("candidate table is unavailable");
  return JSON.parse(message.content.slice(message.content.indexOf("{"))).candidateOptions;
}

function exact(options: any[], predicate: (option: any) => boolean): any {
  const matches = options.filter(predicate);
  if (matches.length !== 1) throw new Error(`expected exactly one candidate, found ${matches.length}`);
  return matches[0];
}

async function acceptHarborQuest(app: ReturnType<typeof buildApp>, campaignId: string, sessionId: string, actorId: string, key: string) {
  const base = `/api/rpg/v1/campaigns/${campaignId}`;
  const administration = await app.inject({ method: "GET", url: `${base}/administration` });
  const acceptance = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
    campaignId, sessionId, actorId, declaration: "I accept Restore the Harbor Light.", expectedRevision: administration.json().campaign.revision, idempotencyKey: key,
  } });
  expect(acceptance.statusCode, acceptance.body).toBe(200);
  const events = streamEvents(acceptance.body), terminal = events.at(-1), proposal = events.find((event) => event.type === "tool_proposed");
  if (!terminal || terminal.type !== "terminal" || !proposal || proposal.type !== "tool_proposed") throw new Error("exact harbor acceptance proposal is unavailable");
  expect(terminal.payload.turn).toMatchObject({ mode: "original", declaration: "I accept Restore the Harbor Light." });
  const confirmed = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${terminal.payload.turn.turnId}/confirm`, headers, payload: {
    proposalIds: [proposal.payload.proposal.proposalId], decision: "approve", expectedRevision: terminal.payload.turn.revision, idempotencyKey: `confirm-${key}`,
  } });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const resumed = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: { resumeToken: confirmed.json().resumeToken } });
  expect(resumed.statusCode, resumed.body).toBe(200);
  expect(streamEvents(resumed.body).at(-1)).toMatchObject({ type: "terminal", payload: { receipts: [expect.any(Object)] } });
  expect((await app.inject({ method: "GET", url: `${base}/quests` })).json().quests).toContainEqual(expect.objectContaining({ title: "Restore the Harbor Light", status: "active" }));
}

describe("reviewed adventure HTTP journey", () => {
  it("materializes the exact catalog encounter only after the original Breakwater Cave travel turn", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    const fixture = await createReviewedAdventure(makeTmpDataDir(), { prepareOptionalEncounter: false });
    let dispatches = 0;
    const dependencies: AdventureAgentDependencies = {
      complete: async (input) => {
        dispatches += 1;
        if (input.promptVersion === "campaign-dm-v1") {
          const candidates = JSON.parse(input.messages[1]!.content as string).candidates;
          const selected = exact(candidates, (candidate) => candidate.action === "encounter-materialize");
          return result("select_dm_beat", { selection: { candidateId: selected.candidateId, digest: selected.digest } });
        }
        if (input.promptVersion === "campaign-dm-narration-v1") {
          return result("submit_dm_scene", { atmosphere: "The tide shifts around the cave mouth.", dialogue: [], question: "What do you do?" });
        }
        if (input.promptVersion === "adventure-narration-v1") {
          return result("submit_adventure_narration", { narration: "You arrive at Breakwater Cave." });
        }
        const options = candidateOptions(input);
        const selected = options.some((candidate) => candidate.toolName === "exact_quest_lifecycle.select" && candidate.label.action === "accept")
          ? exact(options, (candidate) => candidate.toolName === "exact_quest_lifecycle.select" && candidate.label.action === "accept" && candidate.label.source === "Restore the Harbor Light")
          : exact(options, (candidate) => candidate.toolName === "exact_actor_travel.select" && candidate.label.target === "Breakwater Cave");
        return result(selected.toolName, selected.arguments);
      },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "reviewed-journey" }),
      getHarness: async () => defaultHarnessSettings(),
      now: () => new Date("2036-01-01T00:00:00.000Z"),
    };
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo, adventureAgentDependencies: dependencies });
    const base = `/api/rpg/v1/campaigns/${fixture.campaignId}`;
    const room = `${base}/rooms/${fixture.sessionId}/dm`;
    try {
       expect(fixture.optionalEncounterInstanceId).toBeNull();
       expect((await app.inject({ method: "GET", url: `${base}/encounters` })).json().encounters).toEqual([]);
       await acceptHarborQuest(app, fixture.campaignId, fixture.sessionId, fixture.actorId, "accept-risky-route");
      const administration = await app.inject({ method: "GET", url: `${base}/administration` });
      const travel = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
        campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId,
        declaration: "I choose the risky Breakwater Cave route.", expectedRevision: administration.json().campaign.revision,
        idempotencyKey: "risky-breakwater-travel",
      } });
      expect(travel.statusCode, travel.body).toBe(200);
      expect(travel.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      const travelTerminal = streamEvents(travel.body).at(-1);
      expect(travelTerminal).toMatchObject({ type: "terminal", payload: {
        turn: { mode: "original", declaration: "I choose the risky Breakwater Cave route." },
        receipts: [expect.objectContaining({ commandId: expect.any(String), proposalId: null })],
      } });
      if (!travelTerminal || travelTerminal.type !== "terminal") throw new Error("risky travel did not terminate");
      const travelReceipt = await app.inject({ method: "GET", url: `${base}/commands/${travelTerminal.payload.receipts[0]!.commandId}/receipt` });
      expect(travelReceipt.json()).toMatchObject({ receipt: { kind: "travel", destination: "Breakwater Cave" } });
      expect((await app.inject({ method: "GET", url: `${base}/encounters` })).json().encounters).toEqual([]);
      const mode = await app.inject({ method: "POST", url: `${base}/dm/mode-commands`, headers, payload: { mode: "ai", expectedRevision: 0, idempotencyKey: "delegate-risky-route" } });
      expect(mode.statusCode, mode.body).toBe(200);
      const beat = await app.inject({ method: "POST", url: `${room}/beat-commands`, headers, payload: { intent: "continue", expectedModeRevision: 1, idempotencyKey: "materialize-risky-encounter" } });
      expect(beat.statusCode, beat.body).toBe(200);
      expect(beat.json()).toMatchObject({ state: "completed", receipts: [expect.objectContaining({ action: "encounter-materialize" })] });
      expect(beat.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      expect((await app.inject({ method: "GET", url: `${base}/encounters` })).json().encounters).toEqual([
        expect.objectContaining({ name: "Campaign encounter", status: "active" }),
      ]);
      expect(fixture.providerDispatches).toBe(0);
       expect(dispatches).toBe(6);
    } finally {
      await app.close();
      fixture.repo.close();
    }
  });

  it.each(["human", "ai"] as const)("hands one bounded combat round from player to director in %s mode", async (mode) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    const fixture = await createReviewedAdventure(makeTmpDataDir(), { prepareOptionalEncounter: false, rng: { integer: () => 1 } });
    let dispatches = 0;
    const dependencies: AdventureAgentDependencies = {
      complete: async (input) => {
        dispatches += 1;
        if (input.promptVersion === "campaign-dm-v1") {
          const candidates = JSON.parse(input.messages[1]!.content as string).candidates;
          const selected = candidates.length === 0 ? null : exact(candidates, (candidate) => candidate.action === "encounter-materialize" || candidate.action === "enemy-turn");
          return selected ? result("select_dm_beat", { selection: { candidateId: selected.candidateId, digest: selected.digest } })
            : { message: { role: "assistant", content: "complete", toolCalls: [] }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: { requestedModel: "reviewed-journey", responseModel: "reviewed-journey" } };
        }
        if (input.promptVersion === "campaign-dm-narration-v1") return result("submit_dm_scene", { atmosphere: "Steel rings on wet stone.", dialogue: [], question: "Who acts next?" });
        if (input.promptVersion === "adventure-narration-v1") return result("submit_adventure_narration", { narration: "The authoritative result is clear." });
        const options = candidateOptions(input);
        const selected = options.some((candidate) => candidate.toolName === "exact_quest_lifecycle.select" && candidate.label.action === "accept")
          ? exact(options, (candidate) => candidate.toolName === "exact_quest_lifecycle.select" && candidate.label.action === "accept" && candidate.label.source === "Restore the Harbor Light")
          : exact(options, (candidate) => candidate.toolName === "exact_actor_travel.select"
            ? candidate.label.target === "Breakwater Cave"
            : candidate.toolName === "combat_action.execute" && candidate.label.action === "end-turn");
        return result(selected.toolName, selected.arguments);
      },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "reviewed-journey" }),
      getHarness: async () => defaultHarnessSettings(),
      now: () => new Date("2036-01-01T00:00:00.000Z"),
    };
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo, adventureAgentDependencies: dependencies });
    const base = `/api/rpg/v1/campaigns/${fixture.campaignId}`, room = `${base}/rooms/${fixture.sessionId}/dm`;
    const beat = async (key: string) => {
      const response = await app.inject({ method: "POST", url: `${room}/beat-commands`, headers, payload: { intent: "continue", expectedModeRevision: mode === "ai" ? 1 : 0, idempotencyKey: key } });
      expect(response.statusCode, response.body).toBe(200);
      if (mode === "human" && response.json().state === "awaiting-approval") {
        const approved = await app.inject({ method: "POST", url: `${room}/runs/${response.json().runId}/decision-commands`, headers, payload: { decision: "approved", expectedRevision: response.json().revision, idempotencyKey: `approve-${key}` } });
        expect(approved.statusCode, approved.body).toBe(200);
        return approved;
      }
      return response;
    };
    try {
       if (mode === "ai") expect((await app.inject({ method: "POST", url: `${base}/dm/mode-commands`, headers, payload: { mode, expectedRevision: 0, idempotencyKey: "delegate-combat" } })).statusCode).toBe(200);
       await acceptHarborQuest(app, fixture.campaignId, fixture.sessionId, fixture.actorId, `accept-combat-${mode}`);
       const administration = await app.inject({ method: "GET", url: `${base}/administration` });
      const travel = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: { campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "I choose the risky Breakwater Cave route.", expectedRevision: administration.json().campaign.revision, idempotencyKey: `combat-travel-${mode}` } });
      expect(streamEvents(travel.body).at(-1)).toMatchObject({ type: "terminal", payload: { turn: { mode: "original" } } });
      expect((await beat(`materialize-${mode}`)).json()).toMatchObject({ receipts: [expect.objectContaining({ action: "encounter-materialize" })] });
      const encounter = (await app.inject({ method: "GET", url: `${base}/encounters` })).json().encounters[0]!;
      let combat = await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${encounter.encounterId}` });
      if (combat.json().combatants.find((value: any) => value.combatantId === combat.json().currentCombatant)?.kind === "enemy") {
        expect((await beat(`enemy-first-${mode}`)).json()).toMatchObject({ receipts: [expect.objectContaining({ action: "enemy-turn" })] });
        combat = await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${encounter.encounterId}` });
      }
      expect(combat.json().combatants.find((value: any) => value.combatantId === combat.json().currentCombatant)).toMatchObject({ kind: "actor", actorId: fixture.actorId });
      expect((await beat(`hold-player-turn-${mode}`)).json()).toMatchObject({ state: "completed", receipts: [] });
      expect((await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${encounter.encounterId}/rewards` })).json().rewards).toEqual([]);
      expect((await app.inject({ method: "GET", url: `${base}/administration` })).json().campaign.status).not.toBe("completed");
      const player = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: { campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "I end my turn without retreating.", expectedRevision: (await app.inject({ method: "GET", url: `${base}/administration` })).json().campaign.revision, idempotencyKey: `player-combat-${mode}` } });
      const events = streamEvents(player.body), proposed = events.find((event) => event.type === "tool_proposed"), terminal = events.at(-1);
      if (!proposed || proposed.type !== "tool_proposed" || !terminal || terminal.type !== "terminal") throw new Error("player combat proposal is unavailable");
      expect(terminal.payload.turn).toMatchObject({ mode: "original", declaration: "I end my turn without retreating." });
      const confirmation = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${terminal.payload.turn.turnId}/confirm`, headers, payload: { proposalIds: [proposed.payload.proposal.proposalId], decision: "approve", expectedRevision: terminal.payload.turn.revision, idempotencyKey: `confirm-player-combat-${mode}` } });
      expect(confirmation.statusCode, confirmation.body).toBe(200);
      combat = await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${encounter.encounterId}` });
      expect(combat.json().combatants.find((value: any) => value.combatantId === combat.json().currentCombatant)?.kind).toBe("enemy");
      expect((await beat(`enemy-after-player-${mode}`)).json()).toMatchObject({ receipts: [expect.objectContaining({ action: "enemy-turn" })] });
      expect(fixture.providerDispatches).toBe(0);
    } finally { await app.close(); fixture.repo.close(); }
  });

  it.each(["human", "ai"] as const)("defeats the Goblin and claims its combat currency reward in %s mode", async (mode) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    const fixture = await createReviewedAdventure(makeTmpDataDir(), { prepareOptionalEncounter: false, rng: { integer: (minimum, maximum) => maximum - 1 } });
    let dispatches = 0;
    let attackOptions: any[] = [];
    const dependencies: AdventureAgentDependencies = {
      complete: async (input) => {
        dispatches += 1;
        if (input.promptVersion === "campaign-dm-v1") {
          const candidates = JSON.parse(input.messages[1]!.content as string).candidates;
          const selected = candidates.length === 0 ? null : exact(candidates, (candidate) => ["encounter-materialize", "enemy-turn", "encounter-complete"].includes(candidate.action));
          return selected ? result("select_dm_beat", { selection: { candidateId: selected.candidateId, digest: selected.digest } })
            : { message: { role: "assistant", content: "complete", toolCalls: [] }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: { requestedModel: "reviewed-journey", responseModel: "reviewed-journey" } };
        }
        if (input.promptVersion === "campaign-dm-narration-v1") return result("submit_dm_scene", { atmosphere: "The Goblin falters on the wet stones.", dialogue: [], question: "What follows?" });
        if (input.promptVersion === "adventure-narration-v1") return result("submit_adventure_narration", { narration: "The authoritative result is clear." });
        attackOptions = candidateOptions(input);
        const selected = attackOptions.some((candidate) => candidate.toolName === "exact_quest_lifecycle.select" && candidate.label.action === "accept")
          ? exact(attackOptions, (candidate) => candidate.toolName === "exact_quest_lifecycle.select" && candidate.label.action === "accept" && candidate.label.source === "Restore the Harbor Light")
          : attackOptions.some((candidate) => candidate.toolName === "exact_actor_travel.select")
            ? exact(attackOptions, (candidate) => candidate.toolName === "exact_actor_travel.select" && candidate.label.target === "Breakwater Cave")
          : exact(attackOptions, (candidate) => candidate.toolName === "combat_action.execute" && candidate.label.action === "attack"
            && /^Basic attack against Enemy combatant \d+$/.test(candidate.label.source) && candidate.label.target === candidate.label.source.slice("Basic attack against ".length));
        return result(selected.toolName, selected.arguments);
      },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "reviewed-journey" }), getHarness: async () => defaultHarnessSettings(),
      now: () => new Date("2036-01-01T00:00:00.000Z"),
    };
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo, adventureAgentDependencies: dependencies });
    const base = `/api/rpg/v1/campaigns/${fixture.campaignId}`, room = `${base}/rooms/${fixture.sessionId}/dm`;
    const beat = async (key: string) => {
      const response = await app.inject({ method: "POST", url: `${room}/beat-commands`, headers, payload: { intent: "continue", expectedModeRevision: mode === "ai" ? 1 : 0, idempotencyKey: key } });
      expect(response.statusCode, response.body).toBe(200);
      if (mode === "human" && response.json().state === "awaiting-approval") {
        const approved = await app.inject({ method: "POST", url: `${room}/runs/${response.json().runId}/decision-commands`, headers, payload: { decision: "approved", expectedRevision: response.json().revision, idempotencyKey: `approve-${key}` } });
        expect(approved.statusCode, approved.body).toBe(200); return approved;
      }
      return response;
    };
    try {
       if (mode === "ai") expect((await app.inject({ method: "POST", url: `${base}/dm/mode-commands`, headers, payload: { mode, expectedRevision: 0, idempotencyKey: "delegate-terminal-combat" } })).statusCode).toBe(200);
       await acceptHarborQuest(app, fixture.campaignId, fixture.sessionId, fixture.actorId, `accept-terminal-combat-${mode}`);
       const administration = await app.inject({ method: "GET", url: `${base}/administration` });
      const travel = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: { campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "I choose the risky Breakwater Cave route.", expectedRevision: administration.json().campaign.revision, idempotencyKey: `terminal-travel-${mode}` } });
      expect(travel.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      await beat(`terminal-materialize-${mode}`);
      const encounter = (await app.inject({ method: "GET", url: `${base}/encounters` })).json().encounters[0]!;
      let combat = await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${encounter.encounterId}` });
      for (let round = 0; round < 3 && combat.json().currentCombatant !== null; round += 1) {
        const current = combat.json().combatants.find((value: any) => value.combatantId === combat.json().currentCombatant);
        if (current?.kind === "enemy") {
          expect((await beat(`terminal-enemy-${mode}-${round}`)).json()).toMatchObject({ receipts: [expect.objectContaining({ action: "enemy-turn" })] });
        } else {
          expect(current).toMatchObject({ kind: "actor", actorId: fixture.actorId });
          const turn = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: { campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "I strike the Goblin without retreating.", expectedRevision: (await app.inject({ method: "GET", url: `${base}/administration` })).json().campaign.revision, idempotencyKey: `terminal-attack-${mode}-${round}` } });
          expect(turn.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
          const events = streamEvents(turn.body), proposed = events.find((event) => event.type === "tool_proposed"), terminal = events.at(-1);
          if (!terminal || terminal.type !== "terminal") throw new Error("terminal combat attack stream is unavailable");
          expect(attackOptions).toContainEqual(expect.objectContaining({ toolName: "combat_action.execute", label: expect.objectContaining({ action: "attack", target: expect.stringMatching(/^Enemy combatant \d+$/) }) }));
          if (!proposed || proposed.type !== "tool_proposed") throw new Error("exact attack proposal is unavailable");
          expect(terminal.payload.turn).toMatchObject({ mode: "original", declaration: "I strike the Goblin without retreating." });
          const confirmation = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${terminal.payload.turn.turnId}/confirm`, headers, payload: { proposalIds: [proposed.payload.proposal.proposalId], decision: "approve", expectedRevision: terminal.payload.turn.revision, idempotencyKey: `confirm-terminal-attack-${mode}-${round}` } });
          expect(confirmation.statusCode, confirmation.body).toBe(200);
        }
        combat = await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${encounter.encounterId}` });
      }
      expect(combat.json().currentCombatant).toBeNull();
      expect((await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${encounter.encounterId}/rewards` })).json().rewards).toEqual([]);
      expect((await app.inject({ method: "GET", url: `${base}/administration` })).json().campaign.status).not.toBe("completed");
      const questsBeforeSettlement = await app.inject({ method: "GET", url: `${base}/quests` });
       expect(questsBeforeSettlement.json().quests).toContainEqual(expect.objectContaining({ title: "Restore the Harbor Light", status: "active", rewards: [expect.objectContaining({ kind: "custom", claimedAt: null, claimedByActorId: null })] }));
      const storyBeforeSettlement = await app.inject({ method: "GET", url: `${base}/story` });
      expect(storyBeforeSettlement.json().nodes).toContainEqual(expect.objectContaining({ title: "Harbor Finale", status: "hidden" }));
      const completed = await beat(`terminal-complete-${mode}`);
      expect(completed.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      expect(completed.json()).toMatchObject({ receipts: [expect.objectContaining({ action: "encounter-complete" })] });
      const rewards = await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${encounter.encounterId}/rewards` });
      expect(rewards.json().rewards).toEqual([expect.objectContaining({ recipientActorId: fixture.actorId, claim: { state: "unclaimed" }, rewards: [expect.objectContaining({ kind: "currency" })] })]);
      const reward = rewards.json().rewards[0]!;
      const completedEncounter = (await app.inject({ method: "GET", url: `${base}/encounters` })).json().encounters.find((value: any) => value.encounterId === encounter.encounterId)!;
      const walletBefore = await app.inject({ method: "GET", url: `${base}/actors/${fixture.actorId}/wallet` });
      const claimed = await app.inject({ method: "POST", url: `/api/rpg/v1/combats/${encounter.encounterId}/rewards/${reward.rewardBundleId}/claim-commands`, headers, payload: { rewardClaimId: `claim-terminal-${mode}`, expectedRevision: completedEncounter.revision, idempotencyKey: `claim-terminal-${mode}` } });
      expect(claimed.statusCode, claimed.body).toBe(200);
      expect(claimed.json()).toMatchObject({ reward: { claim: { state: "claimed", rewardClaimId: `claim-terminal-${mode}` } } });
      const walletAfter = await app.inject({ method: "GET", url: `${base}/actors/${fixture.actorId}/wallet` });
      expect(walletAfter.json().wallet.balances.reduce((total: number, balance: any) => total + balance.minorUnits, 0)).toBeGreaterThan(
        walletBefore.json().wallet.balances.reduce((total: number, balance: any) => total + balance.minorUnits, 0),
      );
      expect((await app.inject({ method: "GET", url: `${base}/administration` })).json().campaign.status).not.toBe("completed");
      expect(fixture.providerDispatches).toBe(0);
    } finally { await app.close(); fixture.repo.close(); }
  });

  it.each([
    { mode: "human", outcome: "success", roll: 20 }, { mode: "ai", outcome: "success", roll: 20 },
    { mode: "human", outcome: "failure", roll: 1 }, { mode: "ai", outcome: "failure", roll: 1 },
  ] as const)("records exact Insight negotiation $outcome in $mode mode", async ({ mode, outcome, roll }) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    const fixture = await createReviewedAdventure(makeTmpDataDir(), { prepareOptionalEncounter: false, rng: { integer: (minimum, maximum) => {
      expect([minimum, maximum]).toEqual([1, 21]);
      return roll;
    } } });
    let dispatches = 0;
    let checkSelections = 0;
    const dependencies: AdventureAgentDependencies = {
      complete: async (input) => {
        dispatches += 1;
        if (input.promptVersion === "campaign-dm-v1") {
          const candidates = JSON.parse(input.messages[1]!.content as string).candidates;
          const selected = exact(candidates, (candidate) => candidate.action === "reveal-node" && candidate.label === "Reveal scene: Keeper's Request"
            || candidate.action === "reveal-clue" && candidate.label === "Reveal eligible clue: Saltglass Trail");
          return result("select_dm_beat", { selection: { candidateId: selected.candidateId, digest: selected.digest } });
        }
        if (input.promptVersion === "campaign-dm-narration-v1") return result("submit_dm_scene", { atmosphere: "The harbor wind stills.", dialogue: [], question: "What do you do?" });
        if (input.promptVersion === "adventure-narration-v1") return result("submit_adventure_narration", { narration: "The authoritative result is clear." });
        const declaration = input.messages.at(-1)?.content ?? "";
        if (declaration.includes("inspect the public Saltglass Trail")) return { message: { role: "assistant", content: "complete", toolCalls: [] }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: { requestedModel: "reviewed-journey", responseModel: "reviewed-journey" } };
        if (declaration.includes("claim Keeper's acknowledgment")) {
          expect(candidateOptions(input)).not.toContainEqual(expect.objectContaining({ toolName: "exact_quest_lifecycle.select", label: expect.objectContaining({ action: "claim-reward", source: "Restore the Harbor Light" }) }));
          return { message: { role: "assistant", content: "complete", toolCalls: [] }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: { requestedModel: "reviewed-journey", responseModel: "reviewed-journey" } };
        }
        const selected = exact(candidateOptions(input), (candidate) => declaration.includes("accept Restore")
          ? candidate.toolName === "exact_quest_lifecycle.select" && candidate.label.action === "accept"
            && candidate.label.source === "Restore the Harbor Light" && candidate.label.target === null
          : declaration.includes("safe route")
            ? candidate.toolName === "exact_actor_travel.select" && candidate.label.source === "Lantern Quay" && candidate.label.target === "Keeper House"
            : candidate.toolName === "exact_srd_check.select" && candidate.label.action === "Resolve SRD check"
              && candidate.label.source === "Insight (Wisdom), Easy difficulty, normal" && candidate.label.target === null);
        if (selected.toolName === "exact_srd_check.select") checkSelections += 1;
        return result(selected.toolName, selected.arguments);
      },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "reviewed-journey" }),
      getHarness: async () => defaultHarnessSettings(),
      now: () => new Date("2036-01-01T00:00:00.000Z"),
    };
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo, adventureAgentDependencies: dependencies });
    const base = `/api/rpg/v1/campaigns/${fixture.campaignId}`;
    const room = `${base}/rooms/${fixture.sessionId}/dm`;
    try {
      if (mode === "ai") {
        const delegated = await app.inject({ method: "POST", url: `${base}/dm/mode-commands`, headers, payload: { mode, expectedRevision: 0, idempotencyKey: "delegate-negotiation" } });
        expect(delegated.statusCode, delegated.body).toBe(200);
      }
      const opening = await app.inject({ method: "POST", url: `${room}/beat-commands`, headers, payload: { intent: "open", expectedModeRevision: mode === "ai" ? 1 : 0, idempotencyKey: `open-keeper-${mode}-${outcome}` } });
      expect(opening.statusCode, opening.body).toBe(200);
      if (mode === "human") {
        const approved = await app.inject({ method: "POST", url: `${room}/runs/${opening.json().runId}/decision-commands`, headers, payload: { decision: "approved", expectedRevision: opening.json().revision, idempotencyKey: `approve-keeper-${outcome}` } });
        expect(approved.statusCode, approved.body).toBe(200);
      }
      const administration = await app.inject({ method: "GET", url: `${base}/administration` });
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
        campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId,
        declaration: "I ask Keeper Maren for an insight check.", expectedRevision: administration.json().campaign.revision,
        idempotencyKey: `reviewed-negotiation-${mode}`,
      } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      const terminal = streamEvents(response.body).at(-1);
      expect(terminal).toMatchObject({ type: "terminal", payload: {
        turn: { mode: "original", declaration: "I ask Keeper Maren for an insight check." },
        receipts: [expect.objectContaining({ commandId: expect.stringMatching(/^check-command:/), proposalId: null })],
      } });
      if (!terminal || terminal.type !== "terminal") throw new Error("negotiation stream did not terminate");
      const commandId = terminal.payload.receipts[0]!.commandId;
      const receipt = await app.inject({ method: "GET", url: `${base}/commands/${commandId}/receipt` });
      expect(receipt.statusCode, receipt.body).toBe(200);
      expect(receipt.json()).toMatchObject({ receipt: { kind: "check", skill: "Insight", outcome, rolls: [{ value: roll, kept: true }] } });
      if (outcome === "failure") {
        expect(checkSelections).toBe(1);
        expect(receipt.body).not.toContain("success");
        expect(receipt.body).not.toMatch(/agreement|accepted|resolved/i);
        const alternateAdministration = await app.inject({ method: "GET", url: `${base}/administration` });
        const inspection = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
          campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "I inspect the public Saltglass Trail rather than retry the check.",
          expectedRevision: alternateAdministration.json().campaign.revision, idempotencyKey: `inspect-saltglass-${mode}`,
        } });
        expect(inspection.statusCode, inspection.body).toBe(200);
        expect(inspection.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
        expect(streamEvents(inspection.body).at(-1)).toMatchObject({ type: "terminal", payload: {
          turn: { mode: "original", declaration: "I inspect the public Saltglass Trail rather than retry the check." }, receipts: [],
        } });
        expect(checkSelections).toBe(1);
        const alternate = await app.inject({ method: "POST", url: `${room}/beat-commands`, headers, payload: { intent: "continue", expectedModeRevision: mode === "ai" ? 1 : 0, idempotencyKey: `saltglass-${mode}` } });
        expect(alternate.statusCode, alternate.body).toBe(200);
        if (mode === "human") {
          const approved = await app.inject({ method: "POST", url: `${room}/runs/${alternate.json().runId}/decision-commands`, headers, payload: { decision: "approved", expectedRevision: alternate.json().revision, idempotencyKey: "approve-saltglass" } });
          expect(approved.json()).toMatchObject({ receipts: [expect.objectContaining({ action: "reveal-clue" })] });
        } else expect(alternate.json()).toMatchObject({ receipts: [expect.objectContaining({ action: "reveal-clue" })] });
      } else {
        const acceptanceAdministration = await app.inject({ method: "GET", url: `${base}/administration` });
        const acceptance = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
          campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "I accept Restore the Harbor Light.",
          expectedRevision: acceptanceAdministration.json().campaign.revision, idempotencyKey: `accept-harbor-${mode}`,
        } });
        expect(acceptance.statusCode, acceptance.body).toBe(200);
        const acceptanceEvents = streamEvents(acceptance.body);
        const acceptanceTerminal = acceptanceEvents.at(-1);
        const proposed = acceptanceEvents.find((event) => event.type === "tool_proposed");
        if (!acceptanceTerminal || acceptanceTerminal.type !== "terminal" || !proposed || proposed.type !== "tool_proposed") throw new Error("quest acceptance proposal is unavailable");
        const confirmation = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${acceptanceTerminal.payload.turn.turnId}/confirm`, headers, payload: {
          proposalIds: [proposed.payload.proposal.proposalId], decision: "approve", expectedRevision: acceptanceTerminal.payload.turn.revision, idempotencyKey: `confirm-harbor-${mode}`,
        } });
        expect(confirmation.statusCode, confirmation.body).toBe(200);
        const travelAdministration = await app.inject({ method: "GET", url: `${base}/administration` });
        const safe = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
          campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "I take the safe route to Keeper House.",
          expectedRevision: travelAdministration.json().campaign.revision, idempotencyKey: `safe-keeper-house-${mode}`,
        } });
        expect(safe.statusCode, safe.body).toBe(200);
        expect(streamEvents(safe.body).at(-1)).toMatchObject({ type: "terminal", payload: {
          turn: { mode: "original", declaration: "I take the safe route to Keeper House." },
          receipts: [expect.objectContaining({ commandId: expect.any(String), proposalId: null })],
        } });
        expect((await app.inject({ method: "GET", url: `${base}/encounters` })).json().encounters).toEqual([]);
        const claimAdministration = await app.inject({ method: "GET", url: `${base}/administration` });
        const claim = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
          campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "I claim Keeper's acknowledgment reward.",
          expectedRevision: claimAdministration.json().campaign.revision, idempotencyKey: `claim-safe-route-${mode}`,
        } });
        expect(streamEvents(claim.body).at(-1)).toMatchObject({ type: "terminal", payload: { receipts: [] } });
      }
      expect(dispatches).toBe(outcome === "success" ? 9 : 8);
      expect(fixture.providerDispatches).toBe(0);
    } finally {
      await app.close();
      fixture.repo.close();
    }
  });

  it.each(["human", "ai"] as const)("uses fresh exact objective evidence for the bound harbor scenes in %s mode", async (mode) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    let instant = Date.parse("2036-01-01T00:00:00.000Z");
    const fixture = await createReviewedAdventure(makeTmpDataDir(), { prepareOptionalEncounter: false, clock: { now: () => new Date(instant += 1_000) } });
    let dispatches = 0;
    let objectiveTarget: string | null = null;
    let directorSelection: { action: "reveal-node" | "resolve-node"; title: string } | null = null;
    const dependencies: AdventureAgentDependencies = {
      complete: async (input) => {
        dispatches += 1;
        if (input.promptVersion === "campaign-dm-v1") {
          const candidates = JSON.parse(input.messages[1]!.content as string).candidates;
          if (!directorSelection) return result("select_dm_beat", { selection: null });
          const selected = exact(candidates, (candidate) => candidate.action === directorSelection!.action
            && candidate.label === `${directorSelection!.action === "resolve-node" ? "Resolve bound scene" : "Reveal scene"}: ${directorSelection!.title}`);
          return result("select_dm_beat", { selection: { candidateId: selected.candidateId, digest: selected.digest } });
        }
        if (input.promptVersion === "campaign-dm-narration-v1") return result("submit_dm_scene", { atmosphere: "The harbor's lantern light steadies.", dialogue: [], question: "What do you do?" });
        if (input.promptVersion === "adventure-narration-v1") return result("submit_adventure_narration", { narration: "The authoritative result is clear." });
        const selected = exact(candidateOptions(input), (candidate) => objectiveTarget
          ? candidate.toolName === "exact_quest_objective.select" && candidate.label.action === "Advance quest objective"
            && candidate.label.source === "Restore the Harbor Light" && candidate.label.target === objectiveTarget
          : candidate.toolName === "exact_quest_lifecycle.select" && candidate.label.action === "accept"
            && candidate.label.source === "Restore the Harbor Light" && candidate.label.target === null);
        return result(selected.toolName, selected.arguments);
      },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "reviewed-journey" }),
      getHarness: async () => defaultHarnessSettings(),
      now: () => new Date("2036-01-01T00:00:00.000Z"),
    };
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo, adventureAgentDependencies: dependencies });
    const base = `/api/rpg/v1/campaigns/${fixture.campaignId}`;
    const room = `${base}/rooms/${fixture.sessionId}/dm`;
    const objectiveDescription = async (objectiveId: string) => {
      const quests = await app.inject({ method: "GET", url: `${base}/quests` });
      const objective = quests.json().objectives.find((value: any) => value.objectiveId === objectiveId);
      if (!objective) throw new Error(`fixture objective ${objectiveId} is unavailable`);
      return objective.description as string;
    };
    const playerTurn = async (declaration: string, key: string) => {
      const administration = await app.inject({ method: "GET", url: `${base}/administration` });
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
        campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration,
        expectedRevision: administration.json().campaign.revision, idempotencyKey: key,
      } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      const events = streamEvents(response.body);
      const terminal = events.at(-1);
      if (!terminal || terminal.type !== "terminal") throw new Error(`${key} stream did not terminate`);
      expect(terminal.payload.turn).toMatchObject({ mode: "original", declaration });
      return { terminal, events };
    };
    const beat = async (key: string, evidenceTurnId?: string) => {
      const response = await app.inject({ method: "POST", url: `${room}/beat-commands`, headers, payload: {
        intent: "continue", expectedModeRevision: mode === "ai" ? 1 : 0, idempotencyKey: key, ...(evidenceTurnId ? { evidenceTurnId } : {}),
      } });
      expect(response.statusCode, response.body).toBe(200);
      if (mode === "human" && response.json().state === "awaiting-approval") {
        const approved = await app.inject({ method: "POST", url: `${room}/runs/${response.json().runId}/decision-commands`, headers, payload: {
          decision: "approved", expectedRevision: response.json().revision, idempotencyKey: `approve-${key}`,
        } });
        expect(approved.statusCode, approved.body).toBe(200);
        return approved;
      }
      return response;
    };
    try {
      if (mode === "ai") expect((await app.inject({ method: "POST", url: `${base}/dm/mode-commands`, headers, payload: { mode, expectedRevision: 0, idempotencyKey: "delegate-bound-scenes" } })).statusCode).toBe(200);
      objectiveTarget = null;
      const accepted = await playerTurn("I accept Restore the Harbor Light.", `accept-bound-scenes-${mode}`);
      const acceptanceProposal = accepted.events.find((event) => event.type === "tool_proposed");
      expect(accepted.terminal.payload.receipts).toEqual([]);
      // Acceptance is confirmation-gated; use its SSE proposal rather than inferring a lifecycle receipt.
      if (!acceptanceProposal || acceptanceProposal.type !== "tool_proposed") throw new Error("exact quest acceptance proposal is unavailable");
      const confirmedAcceptance = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${accepted.terminal.payload.turn.turnId}/confirm`, headers, payload: { proposalIds: [acceptanceProposal.payload.proposal.proposalId], decision: "approve", expectedRevision: accepted.terminal.payload.turn.revision, idempotencyKey: `confirm-bound-accept-${mode}` } });
      expect(confirmedAcceptance.statusCode, confirmedAcceptance.body).toBe(200);
      const acceptanceRetry = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
        resumeToken: confirmedAcceptance.json().resumeToken,
      } });
      expect(acceptanceRetry.statusCode, acceptanceRetry.body).toBe(200);
      expect(streamEvents(acceptanceRetry.body).at(-1)).toMatchObject({ type: "terminal", payload: { receipts: [expect.any(Object)] } });
      expect((await app.inject({ method: "GET", url: `${base}/quests` })).json().quests).toContainEqual(expect.objectContaining({ title: "Restore the Harbor Light", status: "active" }));
      directorSelection = { action: "reveal-node", title: "Lens Recovered" };
      expect((await beat(`reveal-lens-${mode}`)).json()).toMatchObject({ receipts: [expect.objectContaining({ action: "reveal-node" })] });
      for (const objectiveKey of ["hear-keeper", "secure-lens", "relight-beacon"] as const) {
        objectiveTarget = await objectiveDescription(fixture.resourceIds[objectiveKey]!);
        const completed = await playerTurn(`I complete ${objectiveTarget}`, `${objectiveKey}-${mode}`);
        expect(completed.terminal.payload.receipts, objectiveKey).toHaveLength(1);
        if (objectiveKey === "secure-lens") {
          directorSelection = { action: "resolve-node", title: "Lens Recovered" };
          const resolvedLens = await beat(`resolve-lens-${mode}`, completed.terminal.payload.turn.turnId);
          expect(resolvedLens.json().receipts).toEqual([expect.objectContaining({ action: "resolve-node" })]);
          directorSelection = null;
          expect((await beat(`reuse-lens-evidence-${mode}`, completed.terminal.payload.turn.turnId)).json().receipts).toEqual([]);
          directorSelection = { action: "reveal-node", title: "Harbor Finale" };
          expect((await beat(`reveal-finale-${mode}`)).json()).toMatchObject({ receipts: [expect.objectContaining({ action: "reveal-node" })] });
        }
        if (objectiveKey === "relight-beacon") {
          directorSelection = { action: "resolve-node", title: "Harbor Finale" };
          const resolvedFinale = await beat(`resolve-finale-${mode}`, completed.terminal.payload.turn.turnId);
          expect(resolvedFinale.json().receipts).toEqual([expect.objectContaining({ action: "resolve-node" })]);
        }
      }
      const story = await app.inject({ method: "GET", url: `${base}/story` });
      expect(story.json().nodes.filter((node: any) => ["Lens Recovered", "Harbor Finale"].includes(node.title) && node.status === "resolved")).toHaveLength(2);
      expect(story.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      expect(fixture.providerDispatches).toBe(0);
      expect(dispatches).toBe(15);
    } finally { await app.close(); fixture.repo.close(); }
  });

  it.each(["human", "ai"] as const)("claims the custom acknowledgment and owner-completes the resolved harbor campaign in %s mode", async (mode) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    let instant = Date.parse("2036-01-01T00:00:00.000Z"), dispatches = 0, objectiveTarget: string | null = null, claiming = false;
    let directorSelection: { action: "reveal-node" | "resolve-node"; title: string } | null = null;
    const dataDir = makeTmpDataDir();
    const fixture = await createReviewedAdventure(dataDir, { prepareOptionalEncounter: false, clock: { now: () => new Date(instant += 1_000) } });
    const dependencies: AdventureAgentDependencies = { complete: async (input) => {
      dispatches += 1;
      if (input.promptVersion === "campaign-dm-v1") {
        const candidates = JSON.parse(input.messages[1]!.content as string).candidates;
        if (!directorSelection) return result("select_dm_beat", { selection: null });
        const selected = exact(candidates, (candidate) => candidate.action === directorSelection!.action
          && candidate.label === `${directorSelection!.action === "resolve-node" ? "Resolve bound scene" : "Reveal scene"}: ${directorSelection!.title}`);
        return result("select_dm_beat", { selection: { candidateId: selected.candidateId, digest: selected.digest } });
      }
      if (input.promptVersion === "campaign-dm-narration-v1") return result("submit_dm_scene", { atmosphere: "The harbor light returns.", dialogue: [], question: "What do you do?" });
      if (input.promptVersion === "adventure-narration-v1") return result("submit_adventure_narration", { narration: "The authoritative result is clear." });
      const selected = exact(candidateOptions(input), (candidate) => objectiveTarget
        ? candidate.toolName === "exact_quest_objective.select" && candidate.label.action === "Advance quest objective"
          && candidate.label.source === "Restore the Harbor Light" && candidate.label.target === objectiveTarget
        : candidate.toolName === "exact_quest_lifecycle.select" && candidate.label.action === (claiming ? "claim-reward" : "accept")
          && candidate.label.source === "Restore the Harbor Light" && (claiming
            ? candidate.label.target === "Aster Vale" && candidate.label.consequence === "Claim the Keeper's acknowledgment for Aster Vale."
            : candidate.label.target === null));
      return result(selected.toolName, selected.arguments);
    }, getProvider: async () => ({ ...defaultProviderSettings(), model: "reviewed-journey" }), getHarness: async () => defaultHarnessSettings(), now: () => new Date("2036-01-01T00:00:00.000Z") };
    let app = buildApp({ campaignRepositoryFactory: () => fixture.repo, adventureAgentDependencies: dependencies });
    let reloadedApp: ReturnType<typeof buildApp> | null = null;
    let reloadedRepo: ReturnType<typeof createRepository> | null = null;
    let fixtureClosed = false;
    const base = `/api/rpg/v1/campaigns/${fixture.campaignId}`, room = `${base}/rooms/${fixture.sessionId}/dm`;
    const turn = async (declaration: string, key: string) => {
      const administration = await app.inject({ method: "GET", url: `${base}/administration` });
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: { campaignId: fixture.campaignId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration, expectedRevision: administration.json().campaign.revision, idempotencyKey: key } });
      expect(response.statusCode, response.body).toBe(200); expect(response.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      const events = streamEvents(response.body), terminal = events.at(-1);
      if (!terminal || terminal.type !== "terminal") throw new Error(`${key} stream did not terminate`);
      expect(terminal.payload.turn).toMatchObject({ mode: "original", declaration });
      return { events, terminal };
    };
    const beat = async (key: string, evidenceTurnId?: string) => {
      const response = await app.inject({ method: "POST", url: `${room}/beat-commands`, headers, payload: { intent: "continue", expectedModeRevision: mode === "ai" ? 1 : 0, idempotencyKey: key, ...(evidenceTurnId ? { evidenceTurnId } : {}) } });
      expect(response.statusCode, response.body).toBe(200);
      if (mode === "human" && response.json().state === "awaiting-approval") {
        const approved = await app.inject({ method: "POST", url: `${room}/runs/${response.json().runId}/decision-commands`, headers, payload: { decision: "approved", expectedRevision: response.json().revision, idempotencyKey: `approve-${key}` } });
        expect(approved.statusCode, approved.body).toBe(200); return approved;
      }
      return response;
    };
    try {
      if (mode === "ai") expect((await app.inject({ method: "POST", url: `${base}/dm/mode-commands`, headers, payload: { mode, expectedRevision: 0, idempotencyKey: "delegate-completion" } })).statusCode).toBe(200);
      const accepted = await turn("I accept Restore the Harbor Light.", `completion-accept-${mode}`);
      const acceptanceProposal = accepted.events.find((event) => event.type === "tool_proposed");
      if (!acceptanceProposal || acceptanceProposal.type !== "tool_proposed") throw new Error("exact quest acceptance proposal is unavailable");
      const confirmedAcceptance = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${accepted.terminal.payload.turn.turnId}/confirm`, headers, payload: { proposalIds: [acceptanceProposal.payload.proposal.proposalId], decision: "approve", expectedRevision: accepted.terminal.payload.turn.revision, idempotencyKey: `completion-confirm-accept-${mode}` } });
      expect(confirmedAcceptance.statusCode, confirmedAcceptance.body).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: { resumeToken: confirmedAcceptance.json().resumeToken } })).statusCode).toBe(200);
      directorSelection = { action: "reveal-node", title: "Lens Recovered" };
      expect((await beat(`completion-reveal-lens-${mode}`)).json()).toMatchObject({ receipts: [expect.objectContaining({ action: "reveal-node" })] });
      for (const objectiveKey of ["hear-keeper", "secure-lens", "relight-beacon"] as const) {
        const quests = await app.inject({ method: "GET", url: `${base}/quests` });
        objectiveTarget = quests.json().objectives.find((objective: any) => objective.objectiveId === fixture.resourceIds[objectiveKey])?.description ?? null;
        if (!objectiveTarget) throw new Error(`fixture objective ${objectiveKey} is unavailable`);
        const completed = await turn(`I complete ${objectiveTarget}`, `completion-${objectiveKey}-${mode}`);
        expect(completed.terminal.payload.receipts).toHaveLength(1);
        if (objectiveKey === "secure-lens") {
          directorSelection = { action: "resolve-node", title: "Lens Recovered" };
          expect((await beat(`completion-resolve-lens-${mode}`, completed.terminal.payload.turn.turnId)).json().receipts).toEqual([expect.objectContaining({ action: "resolve-node" })]);
          directorSelection = { action: "reveal-node", title: "Harbor Finale" };
          expect((await beat(`completion-reveal-finale-${mode}`)).json()).toMatchObject({ receipts: [expect.objectContaining({ action: "reveal-node" })] });
        }
        if (objectiveKey === "relight-beacon") {
          directorSelection = { action: "resolve-node", title: "Harbor Finale" };
          expect((await beat(`completion-resolve-finale-${mode}`, completed.terminal.payload.turn.turnId)).json().receipts).toEqual([expect.objectContaining({ action: "resolve-node" })]);
        }
      }
      const walletBefore = await app.inject({ method: "GET", url: `${base}/actors/${fixture.actorId}/wallet` });
      const inventoryBefore = await app.inject({ method: "GET", url: `${base}/actors/${fixture.actorId}/inventory` });
      const factionsBefore = await app.inject({ method: "GET", url: `${base}/factions` });
      objectiveTarget = null;
      claiming = true;
      const claim = await turn("I claim Keeper's acknowledgment.", `completion-claim-${mode}`);
      const claimProposal = claim.events.find((event) => event.type === "tool_proposed");
      if (!claimProposal || claimProposal.type !== "tool_proposed") throw new Error("exact custom reward claim proposal is unavailable");
      const confirmedClaim = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${claim.terminal.payload.turn.turnId}/confirm`, headers, payload: { proposalIds: [claimProposal.payload.proposal.proposalId], decision: "approve", expectedRevision: claim.terminal.payload.turn.revision, idempotencyKey: `completion-confirm-claim-${mode}` } });
      expect(confirmedClaim.statusCode, confirmedClaim.body).toBe(200);
      const claimed = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: { resumeToken: confirmedClaim.json().resumeToken } });
      expect(streamEvents(claimed.body).at(-1)).toMatchObject({ type: "terminal", payload: { receipts: [expect.any(Object)] } });
      const questsAfterClaim = await app.inject({ method: "GET", url: `${base}/quests` });
      expect(questsAfterClaim.json().quests).toContainEqual(expect.objectContaining({ title: "Restore the Harbor Light", status: "completed", rewards: [expect.objectContaining({ kind: "custom", label: "Keeper's acknowledgment", claimedAt: expect.any(String), claimedByActorId: fixture.actorId })] }));
      expect((await app.inject({ method: "GET", url: `${base}/actors/${fixture.actorId}/wallet` })).json()).toEqual(walletBefore.json());
      expect((await app.inject({ method: "GET", url: `${base}/actors/${fixture.actorId}/inventory` })).json()).toEqual(inventoryBefore.json());
      expect((await app.inject({ method: "GET", url: `${base}/factions` })).json()).toEqual(factionsBefore.json());
      const administration = await app.inject({ method: "GET", url: `${base}/administration` });
      const completedCampaign = await app.inject({ method: "PATCH", url: `${base}/administration`, headers, payload: { status: "completed", expectedRevision: administration.json().campaign.revision, idempotencyKey: `owner-complete-harbor-${mode}` } });
      expect(completedCampaign.statusCode, completedCampaign.body).toBe(200);
      expect(completedCampaign.json()).toMatchObject({ campaign: { status: "completed" }, receipt: expect.any(Object) });
      expect(completedCampaign.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      const dispatchesBeforeReload = dispatches;
      await app.close();
      fixture.repo.close();
      fixtureClosed = true;
      reloadedRepo = createRepository({ dataDir });
      reloadedApp = buildApp({ campaignRepositoryFactory: () => reloadedRepo!, adventureAgentDependencies: dependencies });
      for (const url of [`${base}/administration`, `${base}/quests`, `${base}/story`]) {
        const response = await reloadedApp.inject({ method: "GET", url });
        expect(response.statusCode, `${url}: ${response.body}`).toBe(200); expect(response.body).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      }
      expect(dispatches).toBe(dispatchesBeforeReload);
      expect(fixture.providerDispatches).toBe(0);
      expect(dispatches).toBe(15);
    } finally {
      await reloadedApp?.close();
      reloadedRepo?.close();
      if (!fixtureClosed) { await app.close(); fixture.repo.close(); }
    }
  });
});
