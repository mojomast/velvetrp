import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../../server/src/app.js";
import { closeRepo, createRepository, createSession, SRD_5_1_STARTER_CATALOG } from "../../server/src/repo/index.js";

const OWNER = "local-owner";

async function json<T>(request: APIRequestContext, method: string, url: string, data?: unknown, status = 200): Promise<T> {
  const response = await request.fetch(url, { method, data });
  expect(response.status(), `${method} ${url}: ${await response.text()}`).toBe(status);
  return response.json() as Promise<T>;
}

interface SrdFlow {
  request: APIRequestContext;
  campaignId: string;
  roomId: string;
  fighterActorId: string;
  wizardActorId: string;
}

interface SrdFlowFixture {
  srdFlow: SrdFlow;
}

async function finalizeActor(
  repository: ReturnType<typeof createRepository>,
  campaignId: string,
  label: string,
  classId: string,
  preparedSpellIds: readonly string[] = [],
): Promise<string> {
  const persona = repository.createCharacter({ name: `SRD ${label}`, age: 30, archetype: "SRD flow", boundaries: "Fictional deterministic test", fictionalConfirmed: true });
  const scores = { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 };
  const { draft } = repository.createCharacterDraft(OWNER, campaignId, {
    personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
    allocation: { method: "standard-array", scores }, idempotencyKey: `srd-flow-${label}-draft`,
  });
  const reference = (id: string) => SRD_5_1_STARTER_CATALOG.definitions.find((definition) => definition.reference.definitionId === id)!.reference;
  const selected = repository.updateCharacterDraft(OWNER, draft.id, {
    expectedRevision: 0, idempotencyKey: `srd-flow-${label}-select`,
    selections: {
      race: { ...reference("srd-5.1:race:human"), kind: "race" as const },
      background: { ...reference("srd-5.1:background:acolyte"), kind: "background" as const },
      class: { ...reference(classId), kind: "class" as const },
      starterGrant: "kit",
      preparedSpells: preparedSpellIds.map((id) => ({ ...reference(id), kind: "spell" as const })),
    },
  });
  return repository.finalizeCharacterDraft(OWNER, draft.id, {
    expectedRevision: selected.draft.revision, idempotencyKey: `srd-flow-${label}-finalize`,
  }).receipt.actorId;
}

// A per-test disposable server. The fixture seeds the SRD 5.1 starter catalog
// and two durable actors (a Fighter and a Shield-carrying Wizard), while every
// new-feature assertion is driven over real HTTP with a deterministic RNG.
const srdFlowTest = test.extend<SrdFlowFixture>({
  srdFlow: async ({ playwright }, use) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-e2e-srd-flow-"));
    const previous = {
      VELVET_DATA_DIR: process.env.VELVET_DATA_DIR,
      NODE_ENV: process.env.NODE_ENV,
      FEATURE_RPG_CAMPAIGN: process.env.FEATURE_RPG_CAMPAIGN,
      FEATURE_RPG_MECHANICS: process.env.FEATURE_RPG_MECHANICS,
      FEATURE_RPG_COMBAT: process.env.FEATURE_RPG_COMBAT,
    };
    Object.assign(process.env, { VELVET_DATA_DIR: dataDir, NODE_ENV: "test", FEATURE_RPG_CAMPAIGN: "true", FEATURE_RPG_MECHANICS: "true", FEATURE_RPG_COMBAT: "true" });
    closeRepo();
    const repository = createRepository({ dataDir, rng: { integer: (minimum, maximum) => maximum === 21 ? 20 : minimum } });
    let request: APIRequestContext | undefined;
    let app: ReturnType<typeof buildApp> | undefined;
    try {
      const campaign = repository.createCampaign(OWNER, { name: "SRD Feature Flows" });
      repository.installSrdStarterCatalog(OWNER);
      repository.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "srd-flow-content" });
      const persona = repository.createCharacter({ name: "SRD flow room", age: 30, archetype: "Room", boundaries: "Fictional deterministic test", fictionalConfirmed: true });
      const room = await createSession({ characterId: persona.id, title: "SRD feature room" });
      repository.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: room.id });
      const fighterActorId = await finalizeActor(repository, campaign.id, "Fighter", "srd-5.1:class:fighter");
      const wizardActorId = await finalizeActor(repository, campaign.id, "Wizard", "srd-5.1:class:wizard",
        ["srd-5.1:spell:shield", "srd-5.1:spell:magic-missile"]);
      repository.updateCampaignAdministration(OWNER, campaign.id, {
        expectedRevision: repository.getCampaignAdministration(OWNER, campaign.id)!.revision,
        status: "published", idempotencyKey: "srd-flow-publish",
      });
      app = buildApp({ campaignRepositoryFactory: () => repository });
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      request = await playwright.request.newContext({ baseURL: origin });
      await use({ request, campaignId: campaign.id, roomId: room.id, fighterActorId, wizardActorId });
    } finally {
      await request?.dispose();
      await app?.close();
      repository.close();
      closeRepo();
      rmSync(dataDir, { recursive: true, force: true });
      if (previous.VELVET_DATA_DIR === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = previous.VELVET_DATA_DIR;
      if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.NODE_ENV;
      if (previous.FEATURE_RPG_CAMPAIGN === undefined) delete process.env.FEATURE_RPG_CAMPAIGN; else process.env.FEATURE_RPG_CAMPAIGN = previous.FEATURE_RPG_CAMPAIGN;
      if (previous.FEATURE_RPG_MECHANICS === undefined) delete process.env.FEATURE_RPG_MECHANICS; else process.env.FEATURE_RPG_MECHANICS = previous.FEATURE_RPG_MECHANICS;
      if (previous.FEATURE_RPG_COMBAT === undefined) delete process.env.FEATURE_RPG_COMBAT; else process.env.FEATURE_RPG_COMBAT = previous.FEATURE_RPG_COMBAT;
    }
  },
});

/** Advances a combat by ending actor turns and resolving enemy turns until the requested combatant is current. */
async function advanceTo(request: APIRequestContext, combat: any, combatantId: string): Promise<any> {
  let current = combat;
  for (let step = 0; step < 10 && current.currentCombatant !== combatantId; step += 1) {
    const acting = current.combatants.find((combatant: any) => combatant.combatantId === current.currentCombatant)!;
    current = acting.kind === "enemy"
      ? (await json<any>(request, "POST", `/api/rpg/v1/combats/${current.combatId}/enemy-turn-commands`,
          { expectedRevision: current.revision, idempotencyKey: `advance-enemy-${step}` })).combat
      : (await json<any>(request, "POST", `/api/rpg/v1/combats/${current.combatId}/action-commands`,
          { legalActionId: "end-turn", targetIds: [], choices: [], expectedRevision: current.revision, idempotencyKey: `advance-end-${step}` })).combat;
  }
  expect(current.currentCombatant, "requested combatant became current").toBe(combatantId);
  return current;
}

async function startEncounter(request: APIRequestContext, flow: SrdFlow, actorId: string, name: string, key: string) {
  const goblin = SRD_5_1_STARTER_CATALOG.definitions.find((definition) => definition.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference;
  const created = await json<any>(request, "POST", `/api/rpg/v1/campaigns/${flow.campaignId}/encounters`, {
    sessionId: flow.roomId, name, combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }],
    idempotencyKey: `${key}-encounter`,
  }, 201);
  const started = await json<any>(request, "POST", `/api/rpg/v1/encounters/${created.encounter.encounterId}/start-commands`, {
    expectedRevision: created.encounter.revision, idempotencyKey: `${key}-start`,
  });
  const combat = started.combat;
  const actorCombatant = combat.combatants.find((combatant: any) => combatant.kind === "actor" && combatant.actorId === actorId)!.combatantId;
  const enemyCombatant = combat.combatants.find((combatant: any) => combatant.kind === "enemy")!.combatantId;
  return { combat, combatId: combat.combatId as string, actorCombatant, enemyCombatant };
}

srdFlowTest("plans an encounter, previews rewards, and selects NPCs over HTTP", async ({ srdFlow }) => {
  const { request, campaignId } = srdFlow;
  const base = `/api/rpg/v1/campaigns/${campaignId}`;

  const plan = await json<any>(request, "POST", `${base}/encounter-plans`, { partyLevels: [3, 3], targetDifficulty: "medium" });
  const goblin = plan.candidates.find((candidate: any) => candidate.id === "srd-5.1:enemy-template:goblin");
  expect(goblin, "the SRD Goblin is a pinned encounter candidate").toBeTruthy();
  expect(goblin.challengeRating).toBeCloseTo(0.25, 5);
  expect(plan.candidates.length).toBeGreaterThan(0);
  expect(plan.plan.monsterCount).toBeGreaterThanOrEqual(0);

  const rewards = await json<any>(request, "POST", `${base}/encounter-reward-previews`, {
    defeatedEnemyIds: [goblin.id], currentXp: 0, currentLevel: 1,
  });
  // SRD Goblin (CR 1/4) awards 50 raw XP and is below the 300 XP level-2 threshold.
  expect(rewards.xpAwarded).toBe(50);
  expect(rewards.totalXp).toBe(50);
  expect(rewards.levelUpEligible).toBe(false);

  const selection = await json<any>(request, "POST", `${base}/npc-selections`, { count: 2, maxChallengeRating: 1 });
  expect(selection.legal).toBe(true);
  expect(selection.selected).toHaveLength(2);
  expect(selection.selected.every((entry: any) => typeof entry.challengeRating === "number")).toBe(true);
});

srdFlowTest("attunes, lists, and drops magic items over HTTP", async ({ srdFlow }) => {
  const { request, campaignId, fighterActorId } = srdFlow;
  const url = `/api/rpg/v1/campaigns/${campaignId}/actors/${fighterActorId}/attunements`;
  const attune = (definitionId: string, satisfiedRest: "short-rest" | "long-rest" | null, key = definitionId) =>
    json<any>(request, "POST", url, { command: "attune", key, definitionId, satisfiedRest });

  const empty = await json<any>(request, "GET", url);
  expect(empty).toMatchObject({ campaignId, actorId: fighterActorId, limit: 3, attunements: [] });

  expect((await attune("srd-5.1:item:ring-of-protection", null)).code).toBe("prerequisite-missing");
  expect((await attune("srd-5.1:item:ring-of-protection", "short-rest")).ok).toBe(true);
  expect((await attune("srd-5.1:item:cloak-of-elvenkind", "long-rest")).ok).toBe(true);
  expect((await attune("srd-5.1:item:bracers-of-defense", "short-rest")).ok).toBe(true);
  expect((await attune("srd-5.1:item:ring-of-evasion", "short-rest")).code).toBe("capacity-exceeded");
  expect((await attune("srd-5.1:item:wand-of-magic-missiles", "short-rest")).code).toBe("not-attunable");
  expect((await attune("srd-5.1:item:not-a-real-item", "short-rest")).code).toBe("definition-unavailable");

  const listed = await json<any>(request, "GET", url);
  expect(listed.attunements.map((entry: any) => entry.definition.definitionId).sort()).toEqual([
    "srd-5.1:item:bracers-of-defense", "srd-5.1:item:cloak-of-elvenkind", "srd-5.1:item:ring-of-protection",
  ]);

  const dropped = await json<any>(request, "POST", url, { command: "drop", key: "srd-5.1:item:ring-of-protection" });
  expect(dropped.ok).toBe(true);
  expect(dropped.snapshot.attunements).toHaveLength(2);
});

srdFlowTest("resolves the Goblin's two-attack multiattack in a durable enemy turn", async ({ srdFlow }) => {
  const { request, roomId, fighterActorId } = srdFlow;
  void roomId;
  const { combat, combatId, actorCombatant, enemyCombatant } = await startEncounter(request, srdFlow, fighterActorId, "Multiattack drill", "srd-flow-multi");
  const atEnemy = await advanceTo(request, combat, enemyCombatant);
  const result = await json<any>(request, "POST", `/api/rpg/v1/combats/${combatId}/enemy-turn-commands`, {
    expectedRevision: atEnemy.revision, idempotencyKey: "srd-flow-multi-enemy",
  });
  expect(result.resolution.kind).toBe("attack");
  expect(result.resolution.targetIds).toEqual([actorCombatant]);
  expect(result.resolution.outcomes).toHaveLength(2);
  expect(result.resolution.outcomes.every((outcome: any) => outcome.kind === "damage" && outcome.hit)).toBe(true);
  // The second Scimitar continues from the first outcome's hit points.
  expect(result.resolution.outcomes[1].hitPointsBefore).toBe(result.resolution.outcomes[0].hitPointsAfter);
});

srdFlowTest("declares, projects, and fires a readied action over HTTP", async ({ srdFlow }) => {
  const { request, campaignId, wizardActorId } = srdFlow;
  const { combat, combatId, actorCombatant, enemyCombatant } = await startEncounter(request, srdFlow, wizardActorId, "Ready drill", "srd-flow-ready");
  const atWizard = await advanceTo(request, combat, actorCombatant);

  const declared = await json<any>(request, "POST", `/api/rpg/v1/combats/${combatId}/action-commands`, {
    legalActionId: "ready", targetIds: [], choices: [], expectedRevision: atWizard.revision, idempotencyKey: "srd-flow-ready-declare",
  });
  expect(declared.resolution.kind).toBe("ready");
  expect(declared.combat.readyActions).toHaveLength(1);
  expect(declared.combat.readyActions[0]).toMatchObject({
    combatantId: actorCombatant, responseKind: "spell", responseId: "srd-5.1:spell:shield",
    trigger: { event: "hit", subject: "self", requiresHit: true },
  });
  expect(declared.combat.turnEconomy).toMatchObject({ combatantId: actorCombatant, action: { used: true } });

  // End the Wizard's turn; the Goblin attacks and the readied Shield fires at hit time.
  const ended = await json<any>(request, "POST", `/api/rpg/v1/combats/${combatId}/action-commands`, {
    legalActionId: "end-turn", targetIds: [], choices: [], expectedRevision: declared.combat.revision, idempotencyKey: "srd-flow-ready-end",
  });
  expect(ended.combat.currentCombatant).toBe(enemyCombatant);
  await json<any>(request, "POST", `/api/rpg/v1/combats/${combatId}/enemy-turn-commands`, {
    expectedRevision: ended.combat.revision, idempotencyKey: "srd-flow-ready-enemy",
  });

  const after = await json<any>(request, "GET", `/api/rpg/v1/combats/${combatId}`);
  expect(after.readyActions ?? []).toHaveLength(0);
  const resources = await json<any>(request, "GET", `/api/rpg/v1/campaigns/${campaignId}/actors/${wizardActorId}/resources`);
  const slot = resources.resources.find((resource: any) => resource.name === "slot-1");
  expect(slot, "the Wizard's first-level spell slot exists").toBeTruthy();
  expect(slot.current).toBe(slot.max - 1);
});
