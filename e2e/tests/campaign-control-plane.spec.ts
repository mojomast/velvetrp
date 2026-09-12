import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { campaignRoomActivationReadinessSchema, campaignRoomActivationResponseSchema, generatedCampaignContentProviderSchema,
  tacticalMapMoveResponseSchema, tacticalMapPreviewResponseSchema, tacticalMapSnapshotSchema } from "../../packages/contracts/src/index.js";
import { buildApp } from "../../server/src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../../server/src/defaults.js";
import { closeRepo, createRepository, createSession, MECHANICS_STARTER_CATALOG, SRD_5_1_STARTER_CATALOG } from "../../server/src/repo/index.js";

const tabletopTest = test.extend<{ tabletop: { request: APIRequestContext; campaignId: string; campaignName: string; roomId: string; actorId: string } }>({
  tabletop: async ({ page, playwright }, use) => {
    // The shared travel fixture pre-activates sessions. Reuse the activation unit
    // test's minimal canon setup here so only the browser can start this room.
    const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-e2e-tabletop-"));
    const overrides = { VELVET_DATA_DIR: dataDir, NODE_ENV: "test", FEATURE_RPG_CAMPAIGN: "true",
      FEATURE_RPG_MECHANICS: "true", FEATURE_RPG_COMBAT: "true", OPENAI_BASE_URL: "http://127.0.0.1:18788/v1",
      OPENAI_MODEL: "velvet-e2e-model", OPENAI_API_KEY: "local-e2e-placeholder" };
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
    const repository = createRepository({ dataDir, rng: { integer: (minimum) => minimum } });
    let providerCalls = 0;
    const noProvider = async (): Promise<never> => { providerCalls += 1; throw new Error("Tabletop acceptance must not call a provider"); };
    const app = buildApp({ campaignRepositoryFactory: () => repository, campaignContentGeneration: noProvider,
      encounterGeneration: noProvider, adventureAgentDependencies: { complete: noProvider,
        getProvider: async () => defaultProviderSettings(), getHarness: async () => defaultHarnessSettings(), now: () => new Date() } });
    let request: APIRequestContext | undefined;
    try {
      const campaign = repository.createCampaign("local-owner", { name: "Provider-free Rain Gate" });
      repository.installSrdStarterCatalog("local-owner");
      repository.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "tabletop-content" });
      const content = generatedCampaignContentProviderSchema.parse({
        outlines: [{ key: "opening", opening: "Rain falls across the gate.", premise: "Recover the harbor lantern.", startLocationKey: "gate", visibility: "public" }],
        locations: [{ key: "gate", name: "Rain Gate", description: "An old coastal gate.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
      });
      const context = repository.getCampaignGenerationContext("local-owner", campaign.id, [])!;
      const canon = repository.createGenerationDraft("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
        kind: "content-pack", stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
        validation: { valid: true, issues: [], validatedAt: new Date().toISOString() },
        expectedCampaignRevision: repository.getCampaignAdministration("local-owner", campaign.id)!.revision, idempotencyKey: "tabletop-canon" });
      repository.recordCampaignGenerationCandidate(canon.draftId, content, []);
      repository.applyCampaignContentGenerationDraftAtomically("local-owner", { draftId: canon.draftId, expectedDraftRevision: 0,
        expectedCampaignRevision: canon.campaignRevision, idempotencyKey: "tabletop-apply", selectedArtifactKeys: ["opening", "gate"] });
      const persona = repository.createCharacter({ name: "Aster", age: 30, archetype: "Lantern Warden", boundaries: "Fictional deterministic test", fictionalConfirmed: true });
      const room = await createSession({ characterId: persona.id, title: "Rain Gate tabletop" });
      repository.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: room.id });
      const { draft } = repository.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
        allocation: { method: "standard-array", scores: { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 } }, idempotencyKey: "tabletop-character" });
      const reference = (id: string) => SRD_5_1_STARTER_CATALOG.definitions.find((definition) => definition.reference.definitionId === id)!.reference;
      const selected = repository.updateCharacterDraft("local-owner", draft.id, { expectedRevision: 0, idempotencyKey: "tabletop-choices",
        selections: { race: { ...reference("srd-5.1:race:human"), kind: "race" }, background: { ...reference("srd-5.1:background:acolyte"), kind: "background" },
          class: { ...reference("srd-5.1:class:fighter"), kind: "class" }, starterGrant: "kit" } });
      const finalized = repository.finalizeCharacterDraft("local-owner", draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "tabletop-finalize" });
      const actorId = finalized.receipt.actorId;
      repository.updateCampaignAdministration("local-owner", campaign.id, {
        expectedRevision: repository.getCampaignAdministration("local-owner", campaign.id)!.revision, status: "published", idempotencyKey: "tabletop-publish" });
      expect(repository.getCampaignRoomActivationReadiness("local-owner", campaign.id, room.id)).toMatchObject({ active: false, ready: true, blockers: [] });
      expect(repository.getCampaignWorld("local-owner", campaign.id)!.currentLocations).toEqual([]);

      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      request = await playwright.request.newContext({ baseURL: origin });
      // Forward unchanged browser API requests to real HTTP handlers backed by
      // this disposable repository, never fulfill synthetic activation/map data.
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}` });
        await route.fulfill({ response });
      });
      await use({ request, campaignId: campaign.id, campaignName: campaign.name, roomId: room.id, actorId });
      expect(providerCalls).toBe(0);
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

async function api<T>(request: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const response = await request.fetch(`/api${path}`, { method, data });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(method === "POST" ? 201 : 200);
  return response.json() as Promise<T>;
}

async function openCampaign(page: Page, name: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Campaigns", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Open campaign ${name}`, exact: true }).click();
  await expect(page.getByTestId("campaign-overview")).toBeVisible();
}

async function noOverflow(page: Page, soft = false) {
  const dimensions = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")].flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      if (bounds.left >= -0.5 && bounds.right <= viewport + 0.5) return [];
      const style = getComputedStyle(element);
      return [{
        element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className ? `.${element.className.trim().replace(/\s+/g, ".")}` : ""}`,
        text: element.childElementCount ? "" : (element.textContent ?? "").trim().slice(0, 100),
        left: Math.round(bounds.left), right: Math.round(bounds.right), width: Math.round(bounds.width),
        scrollWidth: element.scrollWidth, minWidth: style.minWidth, whiteSpace: style.whiteSpace,
        gridTemplateColumns: style.gridTemplateColumns,
      }];
    }).slice(0, 20);
    return { viewport, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, offenders };
  });
  const assert = soft ? expect.soft : expect;
  assert(dimensions.viewport).toBe(page.viewportSize()!.width);
  assert(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport);
  assert(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport);
}

for (const device of [
  { name: "desktop", viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false },
  { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  test.describe(device.name, () => {
    test.use({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch });

    tabletopTest("successful activation opens Campaign Command Center and confirms one tactical move", async ({ page, tabletop }, testInfo) => {
      const { request, campaignId, campaignName, roomId, actorId } = tabletop;
      const roomPath = `/api/rpg/v1/campaigns/${campaignId}/rooms/${roomId}`;
      const activationMethods: string[] = [];
      const mapWrites: string[] = [];
      page.on("request", (event) => {
        if (event.url().includes(`${roomPath}/activation-`)) activationMethods.push(event.method());
        if (event.url().includes(`${roomPath}/tactical-maps`) && event.method() === "POST") mapWrites.push(new URL(event.url()).pathname);
      });
      await openCampaign(page, campaignName);
      await page.getByRole("navigation", { name: "Campaign destinations", exact: true }).getByRole("button", { name: "Play workspace", exact: true }).click();
      await expect(page.getByTestId("campaign-rooms")).toBeVisible();
      const initialReadinessResponse = page.waitForResponse((response) => response.url().endsWith(`${roomPath}/activation-readiness`));
      await page.getByRole("button", { name: "Check room readiness", exact: true }).click();
      const initialReadiness = campaignRoomActivationReadinessSchema.parse(await (await initialReadinessResponse).json());
      expect(initialReadiness).toMatchObject({ campaignId, sessionId: roomId, active: false, ready: true, blockers: [] });
      await expect(page.getByRole("button", { name: "Start room", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Enter adventure", exact: true })).toHaveCount(0);
      const activated = page.waitForResponse((response) => response.url().endsWith(`${roomPath}/activation-commands`));
      await page.getByRole("button", { name: "Start room", exact: true }).click();
      const activationResponse = await activated;
      expect(activationResponse.status()).toBe(200);
      const activation = campaignRoomActivationResponseSchema.parse(await activationResponse.json());
      expect(activation).toMatchObject({ readiness: { campaignId, sessionId: roomId, active: true, ready: true, blockers: [] },
        receipt: { activated: true, placedActorIds: [actorId] } });
      const activationCommand = activationResponse.request().postDataJSON();
      expect(activation.receipt.idempotencyKey).toBe(activationCommand.idempotencyKey);
      await expect(page.getByRole("status")).toContainText("Activation receipt confirmed");
      await expect(page.getByRole("button", { name: "Enter adventure", exact: true })).toHaveCount(0);
      const currentReadinessResponse = page.waitForResponse((response) => response.url().endsWith(`${roomPath}/activation-readiness`));
      await page.getByRole("button", { name: "Check room readiness", exact: true }).click();
      const currentReadiness = campaignRoomActivationReadinessSchema.parse(await (await currentReadinessResponse).json());
      expect(currentReadiness).toMatchObject({ campaignId, sessionId: roomId, active: true, ready: true, blockers: [] });
      await expect(page.getByRole("button", { name: "Start room", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Enter adventure", exact: true })).toBeVisible();
      expect(activationMethods).toEqual(["GET", "POST", "GET"]);
      const replayResponse = await request.post(`${roomPath}/activation-commands`, { data: activationCommand });
      expect(replayResponse.status(), await replayResponse.text()).toBe(200);
      expect(campaignRoomActivationResponseSchema.parse(await replayResponse.json())).toEqual(activation);
      const world = await api<{ currentLocations: Array<{ actorId: string; locationId: string }>; visibleLocations: Array<{ locationId: string; name: string }> }>(request, "GET", `/rpg/v1/campaigns/${campaignId}/world`);
      expect(world.currentLocations).toEqual([{ actorId, locationId: world.visibleLocations.find((location) => location.name === "Rain Gate")!.locationId,
        revision: 0, updatedAt: activation.receipt.occurredAt }]);

      const map = await request.post(`${roomPath}/tactical-maps`, { data: { mode: "exploration", encounterId: null, kind: "arena", seed: "control-plane-arena", width: 12, height: 10,
        tokens: [{ tokenId: actorId, actorId, combatantId: null, label: "Aster", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false }],
        idempotencyKey: "tabletop-map" } });
      expect(map.status(), await map.text()).toBe(200);
      await page.getByRole("button", { name: "Enter adventure", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Adventure room", exact: true })).toBeVisible();
      await expect(page.getByText("CAMPAIGN COMMAND CENTER", { exact: true })).toBeVisible();
      const tools = page.getByRole("navigation", { name: "In-room tools", exact: true });
      await expect(tools).toBeVisible();
      const livingMap = page.getByRole("region", { name: "Living map", exact: true });
      await expect(livingMap).toBeVisible();
      await expect(livingMap.getByRole("region", { name: "Tactical map", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Exploration grid", exact: true })).toHaveAttribute("aria-pressed", "true");
      const conversation = page.getByRole("region", { name: "Campaign narration and actions", exact: true });
      await expect(conversation).toBeVisible();
      await testInfo.attach("scene-layout", { contentType: "application/json", body: JSON.stringify(await page.evaluate(() =>
        [...document.querySelectorAll(".control-workspace, .campaign-tabletop, .tabletop-stage, #play-maps, .tactical-map-panel, canvas, #play-conversation, .adventure-composer, .adventure-composer label, .adventure-composer select, .adventure-composer textarea, .adventure-composer button")].map((element) => ({
          element: element.id || element.className || element.tagName, width: element.getBoundingClientRect().width,
          right: element.getBoundingClientRect().right, minWidth: getComputedStyle(element).minWidth,
          columns: getComputedStyle(element).gridTemplateColumns,
        }))), null, 2) });
      await testInfo.attach("scene-default", { contentType: "image/png", body: await page.screenshot() });
      await noOverflow(page, true);

      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await page.getByText("Camera controls and movement help", { exact: true }).click();
      await page.getByRole("button", { name: "Pan right", exact: true }).click();
      const camera = page.getByLabel("Map camera", { exact: true });
      const cameraBefore = await camera.innerText();
      expect(cameraBefore).toContain("Zoom: 125%.");
      for (const tool of ["character", "context"]) {
        const button = tools.locator(`[data-atlas-tool="${tool}"]`);
        await button.focus();
        await page.keyboard.press("Enter");
        await expect(button).toHaveAttribute("aria-expanded", "true");
        const target = await button.getAttribute("aria-controls");
        const drawer = page.locator(`#${target}`).getByRole("dialog");
        await expect(drawer).toBeVisible();
        await expect(drawer).toHaveAttribute("aria-modal", "false");
        await expect(livingMap).toBeVisible();
        await expect(conversation).toBeVisible();
        await expect(camera).toHaveText(cameraBefore);
        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden();
        await expect(button).toBeFocused();
        await expect(camera).toHaveText(cameraBefore);
        await noOverflow(page, true);
      }
      const form = page.locator(".adventure-composer");
      await expect(form.getByRole("button", { name: "Declare action", exact: true })).toBeDisabled();
      await form.getByRole("textbox", { name: "What do you do?", exact: true }).fill("I inspect the rain gate.");
      const bounds = (await form.boundingBox())!;
      for (const control of [form.getByRole("combobox", { name: "Acting character", exact: true }),
        form.getByRole("textbox", { name: "What do you do?", exact: true }), form.getByRole("button", { name: "Declare action", exact: true })]) {
        await expect(control).toBeVisible();
        await expect(control).toBeEnabled();
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(box.y).toBeGreaterThanOrEqual(bounds.y);
        expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      }
      await page.getByText("Accessible cells and tokens", { exact: true }).click();
      const cells = page.getByRole("table", { name: "Tactical map text equivalent", exact: true });
      await expect(cells).toBeVisible();
      await expect(cells.getByRole("row").filter({ hasText: "Aster" })).toContainText("2, 2");
      const snapshotPath = `${roomPath}/tactical-maps/exploration/actors/${actorId}`;
      const beforeResponse = await request.get(snapshotPath);
      expect(beforeResponse.status()).toBe(200);
      const before = tacticalMapSnapshotSchema.parse(await beforeResponse.json());
      const previewResponse = page.waitForResponse((response) => response.url().endsWith(`${roomPath}/tactical-maps/exploration/previews`));
      await cells.getByRole("button", { name: "3, 2", exact: true }).click();
      const previewHttp = await previewResponse;
      expect(previewHttp.status()).toBe(200);
      const preview = tacticalMapPreviewResponseSchema.parse(await previewHttp.json());
      expect(preview.pathCostFeet).toBe(5);
      expect(preview.projection.authoritativePath?.at(-1)).toEqual({ x: 2, y: 1 });
      await expect(page.getByText("Preview: 5 feet. Confirm to issue one move command.", { exact: true })).toBeVisible();
      const notMovedResponse = await request.get(snapshotPath);
      expect(notMovedResponse.status()).toBe(200);
      const notMoved = tacticalMapSnapshotSchema.parse(await notMovedResponse.json());
      expect(notMoved.tokenRevision).toBe(before.tokenRevision);
      expect(notMoved.projection.tokens.find((token) => token.tokenId === actorId)?.position).toEqual({ x: 1, y: 1 });
      expect(mapWrites).toEqual([`${roomPath}/tactical-maps/exploration/previews`]);
      const movedResponse = page.waitForResponse((response) => response.url().endsWith(`${roomPath}/tactical-maps/exploration/move-commands`));
      await page.getByRole("button", { name: "Confirm move", exact: true }).click();
      const movedHttp = await movedResponse;
      expect(movedHttp.status()).toBe(200);
      const moved = tacticalMapMoveResponseSchema.parse(await movedHttp.json());
      expect(moved.receipt.previewId).toBe(preview.previewId);
      expect(moved.snapshot.tokenRevision).toBe(before.tokenRevision + 1);
      expect(moved.snapshot.projection.tokens.find((token) => token.tokenId === actorId)?.position).toEqual({ x: 2, y: 1 });
      await expect(page.getByText("Token moved and exploration refreshed from the server.", { exact: true })).toBeVisible();
      await expect(cells.getByRole("row").filter({ hasText: "Aster" })).toContainText("3, 2");
      await page.getByRole("button", { name: "Refresh tactical map", exact: true }).click();
      await expect(page.getByText("Authoritative tactical map refreshed.", { exact: true })).toBeVisible();
      await expect(camera).toHaveText(cameraBefore);
      await expect(cells.getByRole("row").filter({ hasText: "Aster" })).toContainText("3, 2");
      expect(mapWrites).toEqual([`${roomPath}/tactical-maps/exploration/previews`, `${roomPath}/tactical-maps/exploration/move-commands`]);
      expect(activationMethods).toEqual(["GET", "POST", "GET"]);
      await noOverflow(page, true);
    });

    test("library opens Overview; shell separates Rooms, Party and provider-free Create review", async ({ page, request }) => {
      const name = `Control plane ${device.name} review ${randomUUID().slice(0, 8)}`;
      await api(request, "POST", "/rpg/v1/campaigns", { name });
      const writes: string[] = [];
      page.on("request", (event) => {
        if (new URL(event.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(event.method())) {
          writes.push(`${event.method()} ${new URL(event.url()).pathname}`);
        }
      });
      const providerBefore = await request.get("http://127.0.0.1:18788/stats");
      expect(providerBefore.status()).toBe(200);
      const providerStats = await providerBefore.json();
      await openCampaign(page, name);
      await expect(page.getByRole("heading", { name: "Choose your campaign rules" })).toBeVisible();
      await noOverflow(page);

      const nav = page.getByRole("navigation", { name: "Campaign destinations", exact: true });
      await expect(nav).toBeVisible();
      await expect(nav.getByRole("button")).toHaveCount(7);
      await expect(nav.getByRole("button", { name: "Overview workspace", exact: true })).toHaveAttribute("aria-current", "page");
      for (const [workspace, destination, heading, absent] of [
        ["Play", "rooms", "Rooms", "Party roster"],
        ["Characters", "party", "Party", "Sessions"],
      ]) {
        const button = nav.getByRole("button", { name: `${workspace} workspace`, exact: true });
        await button.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByTestId(`campaign-${destination}`)).toBeVisible();
        await expect(button).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeFocused();
        await expect(page.getByRole("heading", { name: absent, exact: true })).toHaveCount(0);
        await expect(page.getByTestId("campaign-overview")).toHaveCount(0);
        await noOverflow(page);
      }

      await nav.getByRole("button", { name: "Create workspace", exact: true }).click();
      await expect(page.getByTestId("campaign-create-page")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Create your campaign", exact: true })).toBeFocused();
      const stages = page.getByRole("navigation", { name: "Worldbuilding stages", exact: true });
      await expect(stages.getByRole("button")).toHaveCount(7);
      await expect(stages.getByRole("button", { name: /Foundation/, exact: false })).toHaveAttribute("aria-current", "step");
      await expect(page.getByRole("heading", { name: "Understand the foundation", exact: true })).toBeVisible();
      await expect(page.getByText("Provider setup:", { exact: false })).toContainText("velvet-e2e-model / not verified");
      expect(writes).toEqual([]);
      await noOverflow(page);
      await page.getByRole("button", { name: "Continue: shape the vision", exact: true }).click();
      await expect(stages.getByRole("button", { name: /Vision/, exact: false })).toHaveAttribute("aria-current", "step");
      await expect(page.getByRole("button", { name: "Questionnaire", exact: true })).toHaveAttribute("aria-pressed", "true");
      const premise = "Restore the harbor beacon before the winter ferries disappear.";
      await page.getByRole("textbox", { name: /^Campaign brief/ }).fill(premise);
      await page.getByRole("textbox", { name: /^Player fantasy/ }).fill("Resourceful coastal explorers");
      await page.getByRole("button", { name: "Scripted guided interview", exact: true }).click();
      await expect(page.getByRole("button", { name: "Scripted guided interview", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("textbox", { name: /^Campaign brief/ })).toHaveValue(premise);
      await expect(page.getByRole("textbox", { name: /^Player fantasy/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Next question", exact: true }).click();
      await expect(page.getByRole("textbox", { name: /^Player fantasy/ })).toHaveValue("Resourceful coastal explorers");
      await page.getByRole("button", { name: "Next question", exact: true }).click();
      await page.getByRole("textbox", { name: /^Stakes and opposition/ }).fill("A rival guild wants the beacon dark.");
      await page.getByRole("button", { name: "Next question", exact: true }).click();
      await page.getByRole("textbox", { name: /^Opening and scope/ }).fill("Three sessions, beginning on the pier.");
      await page.getByRole("button", { name: "Questionnaire", exact: true }).click();
      await expect(page.getByRole("textbox", { name: /^Campaign brief/ })).toHaveValue(premise);
      await expect(page.getByRole("textbox", { name: /^Player fantasy/ })).toHaveValue("Resourceful coastal explorers");
      await page.getByRole("button", { name: "Continue: review safety", exact: true }).click();
      await expect(stages.getByRole("button", { name: /Safety/, exact: false })).toHaveAttribute("aria-current", "step");
      await page.getByRole("textbox", { name: /^Exclude or veil in generated material/ }).fill("body horror");
      await page.getByRole("button", { name: "Continue: plan the world", exact: true }).click();
      await expect(stages.getByRole("button", { name: /World plan/, exact: false })).toHaveAttribute("aria-current", "step");
      await page.getByRole("button", { name: "Review LLM request and cost", exact: true }).click();
      const review = page.getByRole("region", { name: "Final brief review", exact: true });
      await expect(review).toContainText(premise);
      await expect(review).toContainText("Resourceful coastal explorers");
      await expect(review).toContainText("A rival guild wants the beacon dark.");
      await expect(review).toContainText("Three sessions, beginning on the pier.");
      await expect(review).toContainText("Generation boundaries");
      await expect(review).toContainText("body horror");
      await expect(review.getByRole("button", { name: "Generate candidate with LLM (may incur cost)", exact: true })).toBeEnabled();
      await noOverflow(page);
      await review.getByRole("button", { name: "Back: edit plan", exact: true }).click();
      await stages.getByRole("button", { name: /Vision/, exact: false }).click();
      await expect(page.getByRole("textbox", { name: /^Campaign brief/ })).toHaveValue(premise);
      await expect(page.getByRole("textbox", { name: /^Player fantasy/ })).toHaveValue("Resourceful coastal explorers");
      await page.getByRole("button", { name: "Back to campaign", exact: true }).click();
      await expect(page.getByTestId("campaign-overview")).toBeVisible();
      await nav.getByRole("button", { name: "Create workspace", exact: true }).click();
      await expect(page.getByRole("textbox", { name: /^Campaign brief/ })).toHaveValue(premise);
      // No mutation means no generation, capability probe, apply, or publication was dispatched.
      expect(writes).toEqual([]);
      const providerAfter = await request.get("http://127.0.0.1:18788/stats");
      expect(providerAfter.status()).toBe(200);
      expect(await providerAfter.json()).toEqual(providerStats);
    });

    test("staged builder finalizes a real sheet; Rooms reads real activation blockers without starting", async ({ page, request }) => {
      const name = `Control plane ${device.name} builder ${randomUUID().slice(0, 8)}`;
      const persona = await api<{ id: string }>(request, "POST", "/characters", {
        name: `${device.name}-control-plane-builder-persona-with-technical-identity`, age: 30, archetype: "Coastal explorer",
        boundaries: "Deterministic fictional test", fictionalConfirmed: true,
      });
      const { campaign } = await api<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", { name });
      await api(request, "POST", "/rpg/v1/content-packs", MECHANICS_STARTER_CATALOG);
      const { campaign: administration } = await api<{ campaign: { revision: number } }>(request, "GET", `/rpg/v1/campaigns/${campaign.id}/administration`);
      await api(request, "PUT", `/rpg/v1/campaigns/${campaign.id}/content`, {
        rulesProfileId: MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,
        contentPacks: [{ packId: MECHANICS_STARTER_CATALOG.manifest.packId, packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion }],
        expectedRevision: administration.revision, idempotencyKey: `${device.name}-control-pin`,
      });
      const room = await api<{ id: string }>(request, "POST", "/sessions", { characterId: persona.id, title: `${device.name} Beacon session` });
      await api(request, "PUT", `/rpg/v1/campaigns/${campaign.id}/rooms`, { sessionId: room.id });
      await openCampaign(page, name);
      await page.getByRole("button", { name: "Build a character", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Character builder", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Allocate attributes", exact: true })).toBeHidden();
      await page.getByRole("combobox", { name: "Persona", exact: true }).selectOption(persona.id);
      await noOverflow(page);
      await page.getByRole("button", { name: "Next: Rules choices", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Allocate attributes", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Next: Review", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Create draft with this allocation", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Required choices", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Next: Review", exact: true })).toBeDisabled();
      for (const kind of ["race", "background", "class"] as const) {
        const definition = MECHANICS_STARTER_CATALOG.definitions.find((value) => value.reference.kind === kind)!;
        const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/character-drafts/"));
        const choice = page.getByRole("radio", { name: new RegExp(`^${definition.name}`) });
        await choice.click();
        expect((await saved).status()).toBe(200);
        await expect(choice).toBeChecked();
      }
      await page.getByRole("radio", { name: /^Background kit/ }).click();
      await expect(page.getByRole("radio", { name: /^Background kit/ })).toBeChecked();
      await expect(page.getByRole("button", { name: "Next: Review", exact: true })).toBeEnabled();
      await noOverflow(page);
      await page.getByRole("button", { name: "Next: Review", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Review saved character", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Finalize playable character once", exact: true })).toBeDisabled();
      await noOverflow(page);
      await page.getByRole("checkbox", { name: /^I reviewed the server preview/ }).check();
      await page.getByRole("button", { name: "Finalize playable character once", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Playable character finalized", exact: true })).toBeVisible();
      await expect(page.getByText(/^Authoritative sheet: level 1/)).toBeVisible();
      await page.getByRole("navigation", { name: "Campaign destinations", exact: true }).getByRole("button", { name: "Play workspace", exact: true }).click();
      await expect(page.getByTestId("campaign-rooms")).toBeVisible();
      const activationRequests: string[] = [];
      page.on("request", (event) => { if (event.url().includes("/activation-")) activationRequests.push(event.method()); });
      const readinessResponse = page.waitForResponse((response) => response.url().endsWith(`/rooms/${room.id}/activation-readiness`));
      await page.getByRole("button", { name: "Check room readiness", exact: true }).click();
      const response = await readinessResponse;
      expect(response.status()).toBe(200);
      const readiness = campaignRoomActivationReadinessSchema.parse(await response.json());
      expect(readiness).toMatchObject({ campaignId: campaign.id, sessionId: room.id, ready: false, active: false });
      expect(readiness.blockers.length).toBeGreaterThan(0);
      for (const blocker of readiness.blockers) await expect(page.getByRole("listitem").filter({ hasText: blocker.replaceAll("-", " ") })).toBeVisible();
      await expect(page.getByRole("button", { name: "Start room", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Enter adventure", exact: true })).toHaveCount(0);
      expect(activationRequests).toEqual(["GET"]);
      await noOverflow(page);
    });
  });
}
