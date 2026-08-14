import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  adventureTurnStreamEventSchema,
} from "@velvet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { createSession, transitionSession } from "../src/repo/sessionRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const JSON_HEADERS = { "content-type": "application/json" };
const NARRATION = "You follow the rain-bright road until Silver Harbor opens ahead.";

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
});

function enableRpg(): void {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  process.env.FEATURE_RPG_COMBAT = "true";
}

function providerResult(
  content: string | null,
  toolCalls: Array<{ id: string; name: string; arguments: string }> = [],
): ProviderCompletionResult {
  return {
    message: { role: "assistant", content, toolCalls },
    usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
    model: { requestedModel: "journey-test", responseModel: "journey-test" },
  };
}

function streamEvents(body: string) {
  return body.split("\n\n").filter((frame) => frame.startsWith("event: ")).map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new Error("SSE frame has no data");
    return adventureTurnStreamEventSchema.parse(JSON.parse(data.slice(6)));
  });
}

describe("generated campaign deterministic journey", () => {
  it("carries selected generated canon through travel, combat rewards, and restart reconciliation", async () => {
    enableRpg();
    const now = new Date("2035-01-01T00:00:00.000Z");
    const repository = createRepository({
      clock: { now: () => now },
      // Maximal deterministic rolls let the player finish the tiny starter enemy quickly.
      rng: { integer: (_minimum, maximum) => maximum - 1 },
    });
    const campaign = repository.createCampaign("local-owner", { name: "The Rain Road" });
    repository.installMechanicsStarterCatalog("local-owner");
    repository.configureMechanicsStarterCatalog("local-owner", campaign.id, {
      expectedRevision: 0,
      idempotencyKey: "journey-catalog",
    });
    const persona = repository.createCharacter({
      name: "Aster",
      age: 30,
      archetype: "Lantern Warden",
      boundaries: "",
      fictionalConfirmed: true,
    });

    const generatedContent = {
      outlines: [{
        key: "storm-opening",
        opening: "Rain needles the old gate as a harbor lantern goes dark.",
        premise: "Recover the missing harbor lantern.",
        startLocationKey: "rain-gate",
        visibility: "public" as const,
      }],
      locations: [
        { key: "rain-gate", name: "Rain Gate", description: "The road begins beneath a dripping arch.",
          visibility: "public" as const, discoveries: [], hazards: [], hooks: ["A lantern trail"], factionKeys: [] },
        { key: "silver-harbor", name: "Silver Harbor", description: "Lanterns gleam across the wet quay.",
          visibility: "public" as const, discoveries: ["The missing lantern"], hazards: [], hooks: [], factionKeys: [] },
      ],
      connections: [{ key: "harbor-road", fromLocationKey: "rain-gate", toLocationKey: "silver-harbor",
        description: "A rain-bright road descends to the harbor.", visibility: "public" as const }],
      quests: [{ key: "find-lantern", title: "The Missing Lantern", description: "Follow the road and recover the harbor lantern.",
        visibility: "public" as const, locationKeys: ["silver-harbor"] }],
    };
    let generationCalls = 0;
    let adventureCalls = 0;
    const adventureDependencies: AdventureAgentDependencies = {
      complete: async (input) => {
        adventureCalls += 1;
        const travelTool = input.tools?.find((tool) => tool.name === "exact_actor_travel.select");
        if (travelTool) {
          const candidateId = (travelTool.parameters as any).properties.candidateId.enum[0] as string;
          return providerResult(null, [{ id: "journey-travel-choice", name: travelTool.name,
            arguments: JSON.stringify({ version: "v1", kind: "actor.travel", candidateId, choices: [] }) }]);
        }
        return providerResult(NARRATION);
      },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "journey-test" }),
      getHarness: async () => defaultHarnessSettings(),
      now: () => now,
    };
    let app = buildApp({
      campaignRepositoryFactory: () => repository,
      campaignContentGeneration: async () => { generationCalls += 1; return generatedContent; },
      adventureAgentDependencies: adventureDependencies,
    });

    const generated = await app.inject({
      method: "POST",
      url: "/api/rpg/v1/campaign-content-drafts",
      headers: JSON_HEADERS,
      payload: {
        campaignId: campaign.id,
        brief: "A rainy road to a harbor with a missing lantern.",
        tone: "Hopeful mystery",
        exclusions: [],
        sections: ["outline", "locations", "quests"],
        expandArtifactKeys: [],
        revisionFeedback: null,
        idempotencyKey: "journey-generation",
      },
    });
    expect(generated.statusCode, generated.body).toBe(201);
    expect(generated.json().preview).toMatchObject({
      outlines: [{ key: "storm-opening", startLocationKey: "rain-gate" }],
      locations: [{ key: "rain-gate" }, { key: "silver-harbor" }],
      connections: [{ key: "harbor-road" }],
      quests: [{ key: "find-lantern" }],
    });
    const draftId = generated.json().draft.draftId as string;
    const selectedArtifactKeys = ["storm-opening", "rain-gate", "silver-harbor", "harbor-road", "find-lantern"];
    const applied = await app.inject({
      method: "POST",
      url: `/api/rpg/v1/campaign-content-drafts/${draftId}/apply`,
      headers: JSON_HEADERS,
      payload: { expectedRevision: 0, idempotencyKey: "journey-apply", selectedArtifactKeys },
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(generationCalls).toBe(1);

    const foundation = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/generated-foundation` });
    expect(foundation.statusCode, foundation.body).toBe(200);
    expect(foundation.json().opening).toMatchObject({
      premise: "Recover the missing harbor lantern.",
      startLocationKey: "rain-gate",
      sourceDraftId: draftId,
    });
    const quests = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/quests` });
    expect(quests.statusCode, quests.body).toBe(200);
    expect(quests.json().quests).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "The Missing Lantern", description: "Follow the road and recover the harbor lantern." }),
    ]));

    const session = await createSession({ characterId: persona.id, title: "Rain Road session" });
    const activeSession = await transitionSession(session.id, "active", "journey-test");
    if (!activeSession) throw new Error("journey session could not be activated");
    expect(activeSession.state).toBe("active");
    repository.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
    const worldBeforeCharacter = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/world` });
    expect(worldBeforeCharacter.statusCode, worldBeforeCharacter.body).toBe(200);
    expect(worldBeforeCharacter.json()).toMatchObject({
      currentLocations: [],
      visibleLocations: expect.arrayContaining([
        expect.objectContaining({ name: "Rain Gate" }),
        expect.objectContaining({ name: "Silver Harbor" }),
      ]),
      visibleConnections: [expect.objectContaining({})],
    });

    const scores = Object.fromEntries(
      ["might", "agility", "resolve", "insight", "presence", "craft"]
        .map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
    );
    const draft = await app.inject({
      method: "POST",
      url: `/api/rpg/v1/campaigns/${campaign.id}/character-drafts`,
      headers: JSON_HEADERS,
      payload: { personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores },
        idempotencyKey: "journey-character" },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const definitions = MECHANICS_STARTER_CATALOG.definitions;
    const selected = await app.inject({
      method: "PATCH",
      url: `/api/rpg/v1/campaigns/${campaign.id}/character-drafts/${draft.json().draft.id}`,
      headers: JSON_HEADERS,
      payload: {
        expectedRevision: 0,
        idempotencyKey: "journey-character-selections",
        selections: {
          race: definitions.find((definition) => definition.reference.kind === "race")!.reference,
          background: definitions.find((definition) => definition.reference.kind === "background")!.reference,
          class: definitions.find((definition) => definition.reference.kind === "class")!.reference,
          starterGrant: "currency",
        },
      },
    });
    expect(selected.statusCode, selected.body).toBe(200);
    const finalized = await app.inject({
      method: "POST",
      url: `/api/rpg/v1/campaigns/${campaign.id}/character-drafts/${draft.json().draft.id}/finalize`,
      headers: JSON_HEADERS,
      payload: { expectedRevision: 1, idempotencyKey: "journey-finalize" },
    });
    expect(finalized.statusCode, finalized.body).toBe(201);
    expect(finalized.json().receipt.startingGrants).toEqual([
      expect.objectContaining({ kind: "currency", amount: 12 }),
    ]);
    const aggregate = repository.getCampaignCharacter("local-owner", campaign.id, finalized.json().character.id);
    if (!aggregate) throw new Error("finalized campaign character is unavailable");
    const actorId = aggregate.projection.actor.id;

    const walletBeforeReward = await app.inject({
      method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/actors/${actorId}/wallet`,
    });
    expect(walletBeforeReward.statusCode, walletBeforeReward.body).toBe(200);
    expect(walletBeforeReward.json().wallet.balances).toEqual([
      expect.objectContaining({ minorUnits: 12 }),
    ]);
    const placedWorld = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/world` });
    expect(placedWorld.statusCode, placedWorld.body).toBe(200);
    const startLocation = placedWorld.json().visibleLocations.find((location: any) => location.name === "Rain Gate");
    const destination = placedWorld.json().visibleLocations.find((location: any) => location.name === "Silver Harbor");
    expect(placedWorld.json().currentLocations).toContainEqual(expect.objectContaining({
      actorId,
      locationId: startLocation.locationId,
    }));
    const administration = await app.inject({
      method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/administration`,
    });
    expect(administration.statusCode, administration.body).toBe(200);

    const travel = await app.inject({
      method: "POST",
      url: "/api/rpg/v1/adventure-turns/stream",
      headers: JSON_HEADERS,
      payload: { campaignId: campaign.id, sessionId: session.id, actorId,
        declaration: "I follow the rain-bright road to Silver Harbor.",
        expectedRevision: administration.json().campaign.revision,
        idempotencyKey: "journey-travel" },
    });
    expect(travel.statusCode, travel.body).toBe(200);
    const travelEvents = streamEvents(travel.body);
    const terminal = travelEvents.at(-1);
    expect(terminal).toMatchObject({
      type: "terminal",
      payload: {
        outcome: "done",
        narrationStatus: { status: "completed", text: expect.stringContaining(NARRATION), source: "provider-assisted" },
        receipts: [expect.objectContaining({ commandId: expect.any(String) })],
      },
    });
    if (!terminal || terminal.type !== "terminal") throw new Error("travel terminal event is unavailable");
    const travelTurnId = terminal.payload.turn.turnId;
    expect(adventureCalls).toBe(2);
    const traveledWorld = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/world` });
    expect(traveledWorld.json().currentLocations).toContainEqual(expect.objectContaining({
      actorId,
      locationId: destination.locationId,
    }));

    const enemyTemplate = {
      kind: "enemy-template",
      packId: MECHANICS_STARTER_CATALOG.manifest.packId,
      packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
      definitionId: "velvet:mechanics:enemy-template:gloam-mite",
    };
    const encounter = await app.inject({
      method: "POST",
      url: `/api/rpg/v1/campaigns/${campaign.id}/encounters`,
      headers: JSON_HEADERS,
      payload: { sessionId: session.id, name: "Harbor Mite", combatants: [
        { kind: "actor", actorId, team: "allies" },
        { kind: "enemy", template: enemyTemplate, team: "enemies" },
      ], idempotencyKey: "journey-encounter" },
    });
    expect(encounter.statusCode, encounter.body).toBe(201);
    const combatId = encounter.json().encounter.encounterId as string;
    const started = await app.inject({
      method: "POST",
      url: `/api/rpg/v1/encounters/${combatId}/start-commands`,
      headers: JSON_HEADERS,
      payload: { expectedRevision: encounter.json().encounter.revision, idempotencyKey: "journey-combat-start" },
    });
    expect(started.statusCode, started.body).toBe(200);
    let combat = started.json().combat;
    let playerAttackObserved = false;
    for (let turn = 0; turn < 20 && combat.currentCombatant !== null; turn += 1) {
      const acting = combat.combatants.find((combatant: any) => combatant.combatantId === combat.currentCombatant);
      const enemy = combat.combatants.find((combatant: any) => combatant.kind === "enemy");
      if (enemy.status === "defeated") break;
      const legalAction = acting.kind === "actor"
        ? combat.legalActions.find((action: any) => action.kind === "attack" && action.targetIds.includes(enemy.combatantId))
        : combat.legalActions.find((action: any) => action.kind === "end-turn");
      if (!legalAction) throw new Error("expected deterministic combat action is unavailable");
      const action = await app.inject({
        method: "POST",
        url: `/api/rpg/v1/combats/${combatId}/action-commands`,
        headers: JSON_HEADERS,
        payload: { legalActionId: legalAction.legalActionId, targetIds: legalAction.targetIds, choices: [],
          expectedRevision: combat.revision, idempotencyKey: `journey-action-${turn}` },
      });
      expect(action.statusCode, action.body).toBe(200);
      if (acting.kind === "actor") {
        playerAttackObserved = true;
        expect(action.json().resolution).toMatchObject({ kind: "attack", actingCombatantId: acting.combatantId });
      }
      combat = action.json().combat;
    }
    expect(playerAttackObserved).toBe(true);
    expect(combat.combatants.find((combatant: any) => combatant.kind === "enemy").status).toBe("defeated");
    expect(combat.currentCombatant).toBeNull();

    const combatLog = await app.inject({ method: "GET", url: `/api/rpg/v1/combats/${combatId}/log?afterSequence=0&limit=100` });
    expect(combatLog.statusCode, combatLog.body).toBe(200);
    expect(combatLog.json().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ kind: "action_resolved" }),
        narration: expect.stringContaining("action resolves") }),
    ]));
    const ended = await app.inject({
      method: "POST",
      url: `/api/rpg/v1/combats/${combatId}/end-commands`,
      headers: JSON_HEADERS,
      payload: { expectedRevision: combat.revision, idempotencyKey: "journey-combat-end" },
    });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({ encounter: { status: "completed" }, rewards: [
      { recipientActorId: actorId, rewards: [{ kind: "currency", amount: 1 }], claim: { state: "unclaimed" } },
    ] });
    const reward = ended.json().rewards[0];
    const claimed = await app.inject({
      method: "POST",
      url: `/api/rpg/v1/combats/${combatId}/rewards/${reward.rewardBundleId}/claim-commands`,
      headers: JSON_HEADERS,
      payload: { rewardClaimId: "journey-reward-settlement", expectedRevision: ended.json().receipt.revisionAfter,
        idempotencyKey: "journey-reward-claim" },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json().reward.claim).toMatchObject({ state: "claimed" });
    const walletAfterReward = await app.inject({
      method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/actors/${actorId}/wallet`,
    });
    expect(walletAfterReward.statusCode, walletAfterReward.body).toBe(200);
    expect(walletAfterReward.json().wallet.balances).toEqual([
      expect.objectContaining({ minorUnits: 13 }),
    ]);

    await app.close();
    app = buildApp({ campaignRepositoryFactory: () => createRepository(), adventureAgentDependencies: adventureDependencies });
    const [reconciledTurn, reconciledWorld, reconciledRewards, reconciledWallet, reconciledEnd] = await Promise.all([
      app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${travelTurnId}` }),
      app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/world` }),
      app.inject({ method: "GET", url: `/api/rpg/v1/combats/${combatId}/rewards` }),
      app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/actors/${actorId}/wallet` }),
      app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/combats/${combatId}/command-results/journey-combat-end` }),
    ]);
    expect(reconciledTurn.statusCode, reconciledTurn.body).toBe(200);
    expect(reconciledTurn.json()).toMatchObject({ turn: { state: "completed" },
      narrationStatus: { status: "completed", text: expect.stringContaining(NARRATION), source: "provider-assisted" } });
    expect(reconciledWorld.json().currentLocations).toContainEqual(expect.objectContaining({ actorId, locationId: destination.locationId }));
    expect(reconciledRewards.json().rewards[0].claim).toMatchObject({ state: "claimed" });
    expect(reconciledWallet.json().wallet.balances).toEqual([expect.objectContaining({ minorUnits: 13 })]);
    expect(reconciledEnd.statusCode, reconciledEnd.body).toBe(200);
    expect(reconciledEnd.json()).toMatchObject({ operation: "end", result: { encounter: { status: "completed" } } });
    expect(adventureCalls).toBe(2);
    await app.close();
  });
});
