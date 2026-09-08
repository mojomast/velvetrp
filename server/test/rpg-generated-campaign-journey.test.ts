import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
  SRD_5_1_STARTER_IDENTITY,
  adventureTurnStreamEventSchema,
} from "@velvet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { createSession, transitionSession } from "../src/repo/sessionRepo.js";
import { useTmpDataDir } from "./helpers.js";
import { grantSrdEquipment } from "./fixtures/srdEquipment.js";

useTmpDataDir();

const JSON_HEADERS = { "content-type": "application/json" };
const NARRATION = "You follow the rain-bright road and arrive at Silver Harbor.";

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
      // Hit reliably but roll minimum damage so combat exercises explicit end-turn.
      rng: { integer: (minimum, maximum) => maximum === 21 ? 19 : minimum },
    });
    const campaign = repository.createCampaign("local-owner", { name: "The Rain Road" });
    repository.installSrdStarterCatalog("local-owner");
    repository.configureSrdStarterCatalog("local-owner", campaign.id, {
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
        visibility: "public" as const, locationKeys: ["silver-harbor"], objectives: [
          { key: "reach-harbor", description: "Reach Silver Harbor.", targetProgress: 1, dependencyObjectiveKeys: [], visibility: "public" as const },
          { key: "recover-lantern", description: "Recover the missing harbor lantern.", targetProgress: 1, dependencyObjectiveKeys: ["reach-harbor"], visibility: "public" as const },
        ], rewards: [{ key: "harbor-favor", label: "Harbor keeper favor", kind: "custom" as const, amount: null, visibility: "public" as const }] }],
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
        const narrationTool=input.tools?.find((tool)=>tool.name==="submit_adventure_narration");
        return narrationTool
          ? providerResult(null,[{id:"journey-narration",name:narrationTool.name,arguments:JSON.stringify({narration:NARRATION})}])
          : providerResult(NARRATION);
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
    expect(quests.json().objectives.map((objective: any) => objective.description)).toEqual(["Reach Silver Harbor.", "Recover the missing harbor lantern."]);
    expect(quests.json().objectives[1].dependencyObjectiveIds).toEqual([quests.json().objectives[0].objectiveId]);

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
      SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS
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
    expect(draft.json().draft).toMatchObject({
      rulesetId: "dnd-5e",
      rulesetVersion: "1.0.0",
      allocation: { method: "standard-array", scores: {
        strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8,
      } },
    });
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const human = definitions.find(({ reference }) => reference.definitionId === "srd-5.1:race:human")!;
    const acolyte = definitions.find(({ reference }) => reference.definitionId === "srd-5.1:background:acolyte")!;
    const fighter = definitions.find(({ reference }) => reference.definitionId === "srd-5.1:class:fighter")!;
    const selected = await app.inject({
      method: "PATCH",
      url: `/api/rpg/v1/campaigns/${campaign.id}/character-drafts/${draft.json().draft.id}`,
      headers: JSON_HEADERS,
      payload: {
        expectedRevision: 0,
        idempotencyKey: "journey-character-selections",
        selections: {
          race: human.reference,
          background: acolyte.reference,
          class: fighter.reference,
          starterGrant: "currency",
        },
      },
    });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json().draft).toMatchObject({
      rulesetId: "dnd-5e",
      rulesetVersion: "1.0.0",
      selections: { race: human.reference, background: acolyte.reference, class: fighter.reference, starterGrant: "currency" },
      derivedPreview: {
        rulesetId: "dnd-5e", rulesetVersion: "1.0.0", maxHp: 12, armorClass: 12,
        proficiencyBonus: 2, initiative: 2, speed: 30, carryingLimit: 240,
        abilityModifiers: { strength: 3, dexterity: 2, constitution: 2, intelligence: 1, wisdom: 0, charisma: -1 },
      },
      startingGrants: [{ kind: "currency", reference: expect.objectContaining({
        packId: SRD_5_1_STARTER_IDENTITY.packId,
        packVersion: SRD_5_1_STARTER_IDENTITY.packVersion,
        definitionId: "srd-5.1:currency:gp",
      }), amount: 15, source: "background-currency" }],
    });
    const finalized = await app.inject({
      method: "POST",
      url: `/api/rpg/v1/campaigns/${campaign.id}/character-drafts/${draft.json().draft.id}/finalize`,
      headers: JSON_HEADERS,
      payload: { expectedRevision: 1, idempotencyKey: "journey-finalize" },
    });
    expect(finalized.statusCode, finalized.body).toBe(201);
    expect(finalized.json()).toMatchObject({
      sheet: {
        race: human.reference,
        background: acolyte.reference,
        classes: [{ class: fighter.reference, level: 1 }],
        attributes: [
          { attributeId: "strength", value: 16 }, { attributeId: "dexterity", value: 15 },
          { attributeId: "constitution", value: 14 }, { attributeId: "intelligence", value: 13 },
          { attributeId: "wisdom", value: 11 }, { attributeId: "charisma", value: 9 },
        ],
      },
      resources: [{ name: "health", current: 12, max: 12 }],
      receipt: { derived: {
        rulesetId: "dnd-5e", rulesetVersion: "1.0.0", maxHp: 12, armorClass: 12,
        proficiencyBonus: 2, initiative: 2,
      } },
    });
    expect(finalized.json().receipt.startingGrants).toEqual([
      expect.objectContaining({ kind: "currency", reference: expect.objectContaining({
        packId: SRD_5_1_STARTER_IDENTITY.packId,
        packVersion: SRD_5_1_STARTER_IDENTITY.packVersion,
        definitionId: "srd-5.1:currency:gp",
      }), amount: 15 }),
    ]);
    const aggregate = repository.getCampaignCharacter("local-owner", campaign.id, finalized.json().character.id);
    if (!aggregate) throw new Error("finalized campaign character is unavailable");
    const actorId = aggregate.projection.actor.id;
    repository.mutateInventoryForActor("local-owner", campaign.id, actorId, { kind: "equip",
      entryId: grantSrdEquipment(campaign.id, actorId), slot: "hand", expectedRevision: 0, idempotencyKey: "journey-equip" });

    const sheet = await app.inject({
      method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/characters/${finalized.json().character.id}/sheet`,
    });
    expect(sheet.statusCode, sheet.body).toBe(200);
    expect(sheet.json()).toMatchObject({
      rulesetId: "dnd-5e",
      rulesetVersion: "1.0.0",
      derived: { rulesetId: "dnd-5e", rulesetVersion: "1.0.0", maxHp: 12, armorClass: 12, proficiencyBonus: 2 },
    });

    const walletBeforeReward = await app.inject({
      method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/actors/${actorId}/wallet`,
    });
    expect(walletBeforeReward.statusCode, walletBeforeReward.body).toBe(200);
    expect(walletBeforeReward.json().wallet.balances).toEqual([
      expect.objectContaining({ currency: expect.objectContaining({
        packId: SRD_5_1_STARTER_IDENTITY.packId,
        packVersion: SRD_5_1_STARTER_IDENTITY.packVersion,
        definitionId: "srd-5.1:currency:gp",
      }), minorUnits: 15 }),
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
      packId: SRD_5_1_STARTER_CATALOG.manifest.packId,
      packVersion: SRD_5_1_STARTER_CATALOG.manifest.packVersion,
      definitionId: "velvet:test-fixture:enemy-template:training-dummy",
    };
    const encounter = await app.inject({
      method: "POST",
      url: `/api/rpg/v1/campaigns/${campaign.id}/encounters`,
      headers: JSON_HEADERS,
      payload: { sessionId: session.id, name: "Training Dummy", combatants: [
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
    expect(started.json().receipt).toMatchObject({
      idempotencyKey: "journey-combat-start",
      revisionBefore: encounter.json().encounter.revision,
      revisionAfter: encounter.json().encounter.revision + 1,
    });
    let combat = started.json().combat;
    let playerAttackObserved = false;
    let playerEndTurnObserved = false;
    for (let turn = 0; turn < 20 && combat.currentCombatant !== null; turn += 1) {
      const acting = combat.combatants.find((combatant: any) => combatant.combatantId === combat.currentCombatant);
      const enemy = combat.combatants.find((combatant: any) => combatant.kind === "enemy");
      if (enemy.status === "defeated") break;
      const legalAction = acting.kind === "actor"
        ? combat.legalActions.find((action: any) => action.kind === "attack" && action.targetIds.includes(enemy.combatantId))
          ?? combat.legalActions.find((action: any) => action.kind === "end-turn")
        : { kind: "enemy-turn" };
      if (!legalAction) throw new Error("expected deterministic combat action is unavailable");
      const action = await app.inject({
        method: "POST",
        url: acting.kind === "enemy"
          ? `/api/rpg/v1/combats/${combatId}/enemy-turn-commands`
          : `/api/rpg/v1/combats/${combatId}/action-commands`,
        headers: JSON_HEADERS,
        payload: acting.kind === "enemy"
          ? { expectedRevision: combat.revision, idempotencyKey: `journey-action-${turn}` }
          : { legalActionId: legalAction.legalActionId, targetIds: legalAction.targetIds, choices: [],
            expectedRevision: combat.revision, idempotencyKey: `journey-action-${turn}` },
      });
      expect(action.statusCode, action.body).toBe(200);
      expect(action.json().receipt).toMatchObject({
        idempotencyKey: `journey-action-${turn}`,
        revisionBefore: combat.revision,
        revisionAfter: combat.revision + 1,
      });
      if (acting.kind === "actor" && legalAction.kind === "attack") {
        playerAttackObserved = true;
        expect(action.json().resolution).toMatchObject({
          kind: "attack",
          actingCombatantId: acting.combatantId,
          outcomes: [expect.objectContaining({
            rulesetId: "dnd-5e", rulesetVersion: "1.0.0", damageType: "slashing", armorClass: 10, hit: true,
          })],
        });
        if (action.json().combat.currentCombatant !== null) {
          expect(action.json().combat.currentCombatant).toBe(acting.combatantId);
          expect(action.json().combat.legalActions.some((entry: any) => entry.kind === "attack")).toBe(false);
        }
      } else if (acting.kind === "actor") {
        playerEndTurnObserved = true;
        expect(action.json().combat.currentCombatant).not.toBe(acting.combatantId);
      }
      combat = action.json().combat;
    }
    expect(playerAttackObserved).toBe(true);
    expect(playerEndTurnObserved).toBe(true);
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
      { recipientActorId: actorId, rewards: [{ kind: "currency", currency: {
        kind: "currency", packId: SRD_5_1_STARTER_IDENTITY.packId,
        packVersion: SRD_5_1_STARTER_IDENTITY.packVersion, definitionId: "srd-5.1:currency:gp",
      }, amount: 1 }], claim: { state: "unclaimed" } },
    ], receipt: { idempotencyKey: "journey-combat-end", revisionBefore: combat.revision, revisionAfter: combat.revision + 1 } });
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
    expect(claimed.json().receipt).toMatchObject({
      idempotencyKey: "journey-reward-claim",
      revisionBefore: ended.json().receipt.revisionAfter,
      revisionAfter: ended.json().receipt.revisionAfter + 1,
    });
    const walletAfterReward = await app.inject({
      method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/actors/${actorId}/wallet`,
    });
    expect(walletAfterReward.statusCode, walletAfterReward.body).toBe(200);
    expect(walletAfterReward.json().wallet.balances).toEqual([
      expect.objectContaining({ currency: expect.objectContaining({
        packId: SRD_5_1_STARTER_IDENTITY.packId,
        packVersion: SRD_5_1_STARTER_IDENTITY.packVersion,
        definitionId: "srd-5.1:currency:gp",
      }), minorUnits: 16 }),
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
    expect(reconciledWallet.json().wallet.balances).toEqual([expect.objectContaining({
      currency: expect.objectContaining({ packId: SRD_5_1_STARTER_IDENTITY.packId,
        packVersion: SRD_5_1_STARTER_IDENTITY.packVersion, definitionId: "srd-5.1:currency:gp" }),
      minorUnits: 16,
    })]);
    expect(reconciledEnd.statusCode, reconciledEnd.body).toBe(200);
    expect(reconciledEnd.json()).toMatchObject({ operation: "end", result: { encounter: { status: "completed" } } });
    expect(adventureCalls).toBe(2);
    await app.close();
  });
});
