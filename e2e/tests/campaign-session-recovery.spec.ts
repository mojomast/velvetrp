import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import DatabaseDriver from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  campaignRoomActivationReadinessSchema,
  generatedCampaignContentProviderSchema,
} from "../../packages/contracts/src/index.js";
import { buildApp } from "../../server/src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../../server/src/defaults.js";
import { closeRepo, createSession, MECHANICS_STARTER_CATALOG } from "../../server/src/repo/index.js";
import { createDeterministicE2ERepository } from "../../server/src/repo/testing/deterministicE2EFixtureRepo.js";

const reviewedDice = {
  integer(minimum: number, maximum: number) {
    if (minimum === 1 && maximum === 3) return 2;
    if (minimum === 1 && maximum === 5) return 1;
    if (minimum === 1 && maximum === 21) return 10;
    if (minimum === 0 && maximum === 1_000_001) return 0;
    throw new Error(`Unexpected recovery fixture RNG range [${minimum}, ${maximum})`);
  },
};

type RecoveryFixture = {
  request: APIRequestContext;
  origin: string;
  campaignId: string;
  campaignName: string;
  roomId: string;
  actorId: string;
  encounterId: string;
  generationCampaignId: string;
  generationCampaignName: string;
  generationCalls: () => number;
  makeEncounterTerminal: () => void;
};

const recoveryTest = test.extend<{ recovery: RecoveryFixture }>({
  recovery: async ({ page, playwright }, use) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-e2e-session-recovery-"));
    const overrides = {
      VELVET_DATA_DIR: dataDir,
      NODE_ENV: "test",
      FEATURE_RPG_CAMPAIGN: "true",
      FEATURE_RPG_MECHANICS: "true",
      FEATURE_RPG_COMBAT: "true",
      OPENAI_BASE_URL: "http://127.0.0.1:18788/v1",
      OPENAI_MODEL: "velvet-e2e-model",
      OPENAI_API_KEY: "local-e2e-placeholder",
    };
    const previous = {
      VELVET_DATA_DIR: process.env.VELVET_DATA_DIR,
      NODE_ENV: process.env.NODE_ENV,
      FEATURE_RPG_CAMPAIGN: process.env.FEATURE_RPG_CAMPAIGN,
      FEATURE_RPG_MECHANICS: process.env.FEATURE_RPG_MECHANICS,
      FEATURE_RPG_COMBAT: process.env.FEATURE_RPG_COMBAT,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      OPENAI_MODEL: process.env.OPENAI_MODEL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    Object.assign(process.env, overrides);
    closeRepo();
    const { repository, fixtures } = createDeterministicE2ERepository({ dataDir, rng: reviewedDice });
    let generationCalls = 0;
    const generated = generatedCampaignContentProviderSchema.parse({
      handouts: [{ key: "recovery-letter", title: "Recovery Letter", content: "Meet at the rain gate.", visibility: "public" }],
    });
    const noProvider = async (): Promise<never> => { throw new Error("Session recovery acceptance must not call an adventure provider"); };
    const app = buildApp({
      campaignRepositoryFactory: () => repository,
      campaignContentGeneration: async () => { generationCalls += 1; return generated; },
      encounterGeneration: noProvider,
      adventureAgentDependencies: {
        complete: noProvider,
        getProvider: async () => defaultProviderSettings(),
        getHarness: async () => defaultHarnessSettings(),
        now: () => new Date(),
      },
    });
    let request: APIRequestContext | undefined;
    try {
      const campaign = repository.createCampaign("local-owner", { name: "Session Recovery Gate" });
      repository.installMechanicsStarterCatalog("local-owner");
      repository.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "session-recovery-content" });
      const content = generatedCampaignContentProviderSchema.parse({
        outlines: [{ key: "opening", opening: "Rain falls across the gate.", premise: "Hold the harbor road.", startLocationKey: "gate", visibility: "public" }],
        locations: [{ key: "gate", name: "Recovery Gate", description: "A rain-dark training yard.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
      });
      const context = repository.getCampaignGenerationContext("local-owner", campaign.id, [])!;
      const canon = repository.createGenerationDraft("local-owner", {
        campaignId: campaign.id,
        timelineId: campaign.activeTimelineId,
        kind: "content-pack",
        stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
        validation: { valid: true, issues: [], validatedAt: new Date().toISOString() },
        expectedCampaignRevision: repository.getCampaignAdministration("local-owner", campaign.id)!.revision,
        idempotencyKey: "session-recovery-canon",
      });
      repository.recordCampaignGenerationCandidate(canon.draftId, content, []);
      repository.applyCampaignContentGenerationDraftAtomically("local-owner", {
        draftId: canon.draftId,
        expectedDraftRevision: 0,
        expectedCampaignRevision: canon.campaignRevision,
        idempotencyKey: "session-recovery-apply",
        selectedArtifactKeys: ["opening", "gate"],
      });
      const persona = repository.createCharacter({ name: "Aster", age: 30, archetype: "Gate Warden", boundaries: "Fictional deterministic test", fictionalConfirmed: true });
      const room = await createSession({ characterId: persona.id, title: "Session recovery room" });
      repository.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: room.id });
      const { draft } = repository.createCharacterDraft("local-owner", campaign.id, {
        personaId: persona.id,
        controllerPrincipalId: "local-owner",
        durability: "durable",
        allocation: { method: "standard-array", scores: { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 } },
        idempotencyKey: "session-recovery-character",
      });
      const reference = (kind: "race" | "background" | "class") => MECHANICS_STARTER_CATALOG.definitions.find((definition) => definition.reference.kind === kind)!.reference;
      const selected = repository.updateCharacterDraft("local-owner", draft.id, {
        expectedRevision: 0,
        idempotencyKey: "session-recovery-choices",
        selections: {
          race: { ...reference("race"), kind: "race" },
          background: { ...reference("background"), kind: "background" },
          class: { ...reference("class"), kind: "class" },
          starterGrant: "kit",
        },
      });
      const actorId = repository.finalizeCharacterDraft("local-owner", draft.id, {
        expectedRevision: selected.draft.revision,
        idempotencyKey: "session-recovery-finalize",
      }).receipt.actorId;
      fixtures.materializeShortRestFocus({ principalId: "local-owner", campaignId: campaign.id, actorId, expectedRevision: 0 });
      repository.updateCampaignAdministration("local-owner", campaign.id, {
        expectedRevision: repository.getCampaignAdministration("local-owner", campaign.id)!.revision,
        status: "published",
        idempotencyKey: "session-recovery-publish",
      });
      const readiness = repository.getCampaignRoomActivationReadiness("local-owner", campaign.id, room.id)!;
      expect(readiness).toMatchObject({ active: false, ready: true, blockers: [] });
      repository.activateCampaignRoom("local-owner", campaign.id, room.id, {
        expectedRevision: readiness.expectedRevision,
        idempotencyKey: "session-recovery-activate",
      });
      expect(repository.getCampaignRoomActivationReadiness("local-owner", campaign.id, room.id)).toMatchObject({ active: true, ready: true, blockers: [] });
      const enemy = { ...MECHANICS_STARTER_CATALOG.definitions.find((definition) => definition.reference.kind === "enemy-template")!.reference, kind: "enemy-template" as const };
      const prepared = repository.createEncounter("local-owner", campaign.id, {
        sessionId: room.id,
        name: "Recovery Gate drill",
        combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: enemy, team: "enemies" }],
        idempotencyKey: "session-recovery-encounter",
      }).encounter;
      const generationCampaign = repository.createCampaign("local-owner", { name: "Generation Recovery Gate" });

      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      request = await playwright.request.newContext({ baseURL: origin });
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) });
      });
      await use({
        request,
        origin,
        campaignId: campaign.id,
        campaignName: campaign.name,
        roomId: room.id,
        actorId,
        encounterId: prepared.encounterId,
        generationCampaignId: generationCampaign.id,
        generationCampaignName: generationCampaign.name,
        generationCalls: () => generationCalls,
        makeEncounterTerminal: () => {
          // Completion requires a terminal active combat. Materialize only that
          // prerequisite; the browser still issues the production end command.
          const fixtureDb = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"));
          fixtureDb.transaction(() => {
            const triggerNames = ["combatant_state_guard_v27", "encounter_state_guard_v27"];
            const triggers = triggerNames.map((name) => fixtureDb.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string });
            for (const name of triggerNames) fixtureDb.exec(`DROP TRIGGER ${name}`);
            fixtureDb.prepare("UPDATE combatant SET hit_points=0,status='defeated' WHERE encounter_id=? AND combatant_kind='enemy'").run(prepared.encounterId);
            fixtureDb.prepare("UPDATE encounter SET current_turn_combatant_id=NULL WHERE encounter_id=? AND status='active'").run(prepared.encounterId);
            fixtureDb.prepare("UPDATE combat_turn_economy_v60 SET ended_at=? WHERE encounter_id=? AND ended_at IS NULL").run("2035-01-01T00:00:01.000Z", prepared.encounterId);
            for (const trigger of triggers) fixtureDb.exec(trigger.sql);
          }).immediate();
          fixtureDb.close();
          const combat = repository.getCombatState("local-owner", prepared.encounterId)!;
          expect(combat.currentCombatant).toBeNull();
          expect(combat.combatants.find((combatant) => combatant.kind === "enemy")).toMatchObject({ status: "defeated", hitPoints: 0 });
        },
      });
    } finally {
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "wait" });
      await request?.dispose();
      await app.close();
      repository.close();
      closeRepo();
      rmSync(dataDir, { recursive: true, force: true });
      if (previous.VELVET_DATA_DIR === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = previous.VELVET_DATA_DIR;
      if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.NODE_ENV;
      if (previous.FEATURE_RPG_CAMPAIGN === undefined) delete process.env.FEATURE_RPG_CAMPAIGN; else process.env.FEATURE_RPG_CAMPAIGN = previous.FEATURE_RPG_CAMPAIGN;
      if (previous.FEATURE_RPG_MECHANICS === undefined) delete process.env.FEATURE_RPG_MECHANICS; else process.env.FEATURE_RPG_MECHANICS = previous.FEATURE_RPG_MECHANICS;
      if (previous.FEATURE_RPG_COMBAT === undefined) delete process.env.FEATURE_RPG_COMBAT; else process.env.FEATURE_RPG_COMBAT = previous.FEATURE_RPG_COMBAT;
      if (previous.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.OPENAI_BASE_URL;
      if (previous.OPENAI_MODEL === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previous.OPENAI_MODEL;
      if (previous.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.OPENAI_API_KEY;
    }
  },
});

async function openCampaign(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: `Open campaign ${name}`, exact: true }).click();
  await expect(page.getByTestId("campaign-overview")).toBeVisible();
}

for (const device of [
  { name: "desktop", viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false },
  { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  recoveryTest.describe(device.name, () => {
    recoveryTest.use({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch });
    recoveryTest("Run this scene starts, completes, and rests without refresh replay", async ({ page, recovery }) => {
      test.setTimeout(60_000);
      const { request, campaignId, campaignName, roomId, actorId, encounterId } = recovery;
      const writes: string[] = [];
      let activationPosts = 0;
      page.on("request", (event) => {
        const pathname = new URL(event.url()).pathname;
        if (event.method() === "POST" && (pathname.includes("/start-commands") || pathname.includes("/end-commands") || pathname.includes("/rest-commands"))) writes.push(pathname);
        if (event.method() === "POST" && pathname.endsWith(`/campaigns/${campaignId}/rooms/${roomId}/activation-commands`)) activationPosts += 1;
      });
      await openCampaign(page, campaignName);
      await page.getByRole("navigation", { name: "Campaign destinations", exact: true }).getByRole("button", { name: "Play workspace", exact: true }).click();
      const readinessResponse = page.waitForResponse((response) => response.url().endsWith(`/campaigns/${campaignId}/rooms/${roomId}/activation-readiness`));
      await page.getByRole("button", { name: "Check room readiness", exact: true }).click();
      const browserReadiness = campaignRoomActivationReadinessSchema.parse(await (await readinessResponse).json());
      expect(browserReadiness).toMatchObject({ campaignId, sessionId: roomId, active: true, ready: true, blockers: [], actorIds: [actorId] });
      await expect(page.getByRole("button", { name: "Start room", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Enter adventure", exact: true })).toBeVisible();
      expect(activationPosts).toBe(0);
      await page.getByRole("button", { name: "Enter adventure", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Adventure room", exact: true })).toBeVisible();
      await expect(page.getByText("VELVET / LIVING ATLAS", { exact: true })).toBeVisible();
      await page.getByRole("navigation", { name: "In-room tools", exact: true }).locator('[data-atlas-tool="gm"]').click();
      const controls = page.getByRole("region", { name: "Run this scene", exact: true });
      await expect(controls).toBeVisible();

      await controls.getByRole("button", { name: "Review start of Recovery Gate drill", exact: true }).click();
      await expect(controls.getByRole("heading", { name: "Start Recovery Gate drill?", exact: true })).toBeVisible();
      expect(writes).toEqual([]);
      await controls.getByRole("button", { name: "Confirm encounter start", exact: true }).click();
      await expect(controls.getByText(/Encounter start confirmed/)).toBeVisible();
      expect(writes).toEqual([`/api/rpg/v1/encounters/${encounterId}/start-commands`]);

      recovery.makeEncounterTerminal();
      await controls.getByRole("button", { name: "Review completion of Recovery Gate drill", exact: true }).click();
      await expect(controls.getByRole("heading", { name: "Complete Recovery Gate drill?", exact: true })).toBeVisible();
      expect(writes).toHaveLength(1);
      const completionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/rpg/v1/combats/${encounterId}/end-commands`);
      await controls.getByRole("button", { name: "Confirm encounter completion", exact: true }).click();
      const completed = await completionResponse;
      expect(completed.status(), await completed.text()).toBe(200);
      await expect(controls.getByText(/Encounter completion confirmed/)).toBeVisible();
      expect(writes).toEqual([
        `/api/rpg/v1/encounters/${encounterId}/start-commands`,
        `/api/rpg/v1/combats/${encounterId}/end-commands`,
      ]);

      const beforeRestResponse = await request.get(`/api/rpg/v1/campaigns/${campaignId}/actors/${actorId}/resources`);
      expect(beforeRestResponse.status(), await beforeRestResponse.text()).toBe(200);
      const beforeRest = await beforeRestResponse.json() as { revision: number; resources: Array<{ name: string; current: number; max: number }> };
      expect(beforeRest.resources.find((resource) => resource.name === "focus")).toMatchObject({ current: 1, max: 4 });
      await controls.getByRole("button", { name: "Short rest for Aster", exact: true }).click();
      await expect(controls.getByRole("heading", { name: "Short rest for Aster?", exact: true })).toBeVisible();
      expect(writes).toHaveLength(2);
      const restResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/rpg/v1/campaigns/${campaignId}/actors/${actorId}/rest-commands`);
      await controls.getByRole("button", { name: "Confirm rest", exact: true }).click();
      const rested = await restResponse;
      expect(rested.status(), await rested.text()).toBe(200);
      await expect(controls.getByText(/Rest confirmed by the server/)).toBeVisible();
      expect(writes).toEqual([
        `/api/rpg/v1/encounters/${encounterId}/start-commands`,
        `/api/rpg/v1/combats/${encounterId}/end-commands`,
        `/api/rpg/v1/campaigns/${campaignId}/actors/${actorId}/rest-commands`,
      ]);
      const afterRestResponse = await request.get(`/api/rpg/v1/campaigns/${campaignId}/actors/${actorId}/resources`);
      expect(afterRestResponse.status(), await afterRestResponse.text()).toBe(200);
      const afterRest = await afterRestResponse.json() as typeof beforeRest;
      expect(afterRest.revision).toBe(beforeRest.revision + 1);
      expect(afterRest.resources.find((resource) => resource.name === "focus")).toMatchObject({ current: 4, max: 4 });

      await controls.getByRole("button", { name: "Refresh session readiness", exact: true }).click();
      await page.reload();
      await page.getByRole("navigation", { name: "In-room tools", exact: true }).locator('[data-atlas-tool="gm"]').click();
      await expect(page.getByRole("region", { name: "Run this scene", exact: true })).toBeVisible();
      await expect(page.getByText("Recovery Gate drill", { exact: true })).toBeVisible();
      expect(writes).toHaveLength(3);
      expect(activationPosts).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(device.viewport.width);
    });
  });
}

recoveryTest("reload reconciles a committed generation intent without another provider dispatch", async ({ page, recovery }) => {
  test.setTimeout(60_000);
  const { generationCampaignId: campaignId, generationCampaignName: name, origin } = recovery;
  await openCampaign(page, name);
  await page.getByRole("navigation", { name: "Campaign destinations", exact: true }).getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Understand the foundation", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue: shape the vision", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Describe the campaign you want to run", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: /^Campaign brief/ }).fill("A courier carries a letter through the rain.");
  await page.getByRole("button", { name: "Continue: review safety", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Carry safety into this request", exact: true })).toBeVisible();
  await page.getByLabel(/^Exclude or veil in generated material/).fill("body horror");
  await page.getByRole("button", { name: "Continue: plan the world", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose the candidate scope", exact: true })).toBeVisible();
  for (const section of ["Campaign outline", "Locations & routes", "Factions", "NPCs", "Quests"]) await page.getByLabel(section, { exact: true }).uncheck();
  await page.getByLabel("Handouts", { exact: true }).check();
  expect(recovery.generationCalls()).toBe(0);
  await page.getByRole("button", { name: "Review LLM request and cost", exact: true }).click();
  const review = page.getByRole("region", { name: "Final brief review", exact: true });
  await expect(review.getByRole("heading", { name: "Review the LLM generation request", exact: true })).toBeVisible();
  await expect(review).toContainText("body horror");
  expect(recovery.generationCalls()).toBe(0);
  const generationPath = "/api/rpg/v1/campaign-content-drafts";
  let generationPosts = 0;
  await page.route(`**${generationPath}`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    generationPosts += 1;
    const response = await route.fetch({ url: `${origin}${generationPath}` });
    expect(response.status(), await response.text()).toBe(201);
    await route.fulfill({ status: 502, contentType: "text/plain", body: "Committed generation receipt lost" });
  });
  await review.getByRole("button", { name: "Generate candidate with LLM (may incur cost)", exact: true }).click();
  await expect(page.getByText(/generation response is uncertain/i)).toBeVisible();
  expect(generationPosts).toBe(1);
  expect(recovery.generationCalls()).toBe(1);

  await page.reload();
  const retained = page.locator('[aria-label="Retained generation intent"]');
  await expect(retained).toBeVisible();
  expect(generationPosts).toBe(1);
  expect(recovery.generationCalls()).toBe(1);
  const reconciled = page.waitForResponse((response) => new URL(response.url()).pathname === `${generationPath}/reconcile`);
  await retained.getByRole("button", { name: "Reconcile without provider call", exact: true }).click();
  const response = await reconciled;
  expect(response.status(), await response.text()).toBe(200);
  expect(await response.json()).toMatchObject({ campaignId, state: "succeeded", attempt: 1, draftId: expect.any(String) });
  await expect(page.getByRole("heading", { name: "Review generated material", exact: true })).toBeVisible();
  await expect(page.getByText("Recovery Letter", { exact: true })).toBeVisible();
  expect(generationPosts).toBe(1);
  expect(recovery.generationCalls()).toBe(1);
});
