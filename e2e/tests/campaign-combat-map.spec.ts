import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { campaignRoomActivationReadinessSchema, campaignRoomActivationResponseSchema, combatReadResponseSchema,
  encounterCreateResponseSchema, encounterStartCommandResponseSchema, generatedCampaignContentProviderSchema,
  tacticalMapMoveResponseSchema, tacticalMapPreviewResponseSchema, tacticalMapSnapshotSchema } from "../../packages/contracts/src/index.js";
import { buildApp } from "../../server/src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../../server/src/defaults.js";
import { closeRepo, createRepository, createSession, SRD_5_1_STARTER_CATALOG } from "../../server/src/repo/index.js";

async function http(request: APIRequestContext, url: string, data?: unknown, status = 200) {
  const response = await request.fetch(url, { method: data === undefined ? "GET" : "POST", data });
  expect(response.status(), `${url}: ${await response.text()}`).toBe(status);
  return response.json();
}

// Same disposable canon/room pattern as campaign-control-plane.spec.ts, kept
// local so this test does not change or depend on another spec's fixtures.
const combatTest = test.extend<{ combatTable: { request: APIRequestContext; campaignId: string; roomId: string; actorId: string; encounterId: string; combatantId: string } }>({
  combatTable: async ({ page, playwright }, use) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-e2e-combat-map-"));
    const overrides = { VELVET_DATA_DIR: dataDir, NODE_ENV: "test", FEATURE_RPG_CAMPAIGN: "true", FEATURE_RPG_MECHANICS: "true", FEATURE_RPG_COMBAT: "true",
      OPENAI_BASE_URL: "http://127.0.0.1:18788/v1", OPENAI_MODEL: "velvet-e2e-model", OPENAI_API_KEY: "local-e2e-placeholder" };
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
    const noProvider = async (): Promise<never> => { providerCalls += 1; throw new Error("Combat map acceptance must not call a provider"); };
    const app = buildApp({ campaignRepositoryFactory: () => repository, campaignContentGeneration: noProvider, encounterGeneration: noProvider,
      adventureAgentDependencies: { complete: noProvider, getProvider: async () => defaultProviderSettings(), getHarness: async () => defaultHarnessSettings(), now: () => new Date() } });
    let request: APIRequestContext | undefined;
    try {
      const campaign = repository.createCampaign("local-owner", { name: "Provider-free Combat Gate" });
      repository.installSrdStarterCatalog("local-owner");
      repository.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "combat-map-content" });
      const content = generatedCampaignContentProviderSchema.parse({
        outlines: [{ key: "opening", opening: "Hold the gate.", premise: "Protect the harbor.", startLocationKey: "gate", visibility: "public" }],
        locations: [{ key: "gate", name: "Combat Gate", description: "A coastal training ground.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
      });
      const context = repository.getCampaignGenerationContext("local-owner", campaign.id, [])!;
      const canon = repository.createGenerationDraft("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId, kind: "content-pack",
        stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
        validation: { valid: true, issues: [], validatedAt: new Date().toISOString() },
        expectedCampaignRevision: repository.getCampaignAdministration("local-owner", campaign.id)!.revision, idempotencyKey: "combat-map-canon" });
      repository.recordCampaignGenerationCandidate(canon.draftId, content, []);
      repository.applyCampaignContentGenerationDraftAtomically("local-owner", { draftId: canon.draftId, expectedDraftRevision: 0,
        expectedCampaignRevision: canon.campaignRevision, idempotencyKey: "combat-map-apply", selectedArtifactKeys: ["opening", "gate"] });
      const persona = repository.createCharacter({ name: "Aster", age: 30, archetype: "Gate Warden", boundaries: "Fictional deterministic test", fictionalConfirmed: true });
      const room = await createSession({ characterId: persona.id, title: "Combat map tabletop" });
      repository.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: room.id });
      const { draft } = repository.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
        allocation: { method: "standard-array", scores: { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 } }, idempotencyKey: "combat-map-character" });
      const reference = (id: string) => SRD_5_1_STARTER_CATALOG.definitions.find((definition) => definition.reference.definitionId === id)!.reference;
      const selected = repository.updateCharacterDraft("local-owner", draft.id, { expectedRevision: 0, idempotencyKey: "combat-map-choices", selections: {
        race: { ...reference("srd-5.1:race:human"), kind: "race" }, background: { ...reference("srd-5.1:background:acolyte"), kind: "background" },
        class: { ...reference("srd-5.1:class:fighter"), kind: "class" }, starterGrant: "kit" } });
      const actorId = repository.finalizeCharacterDraft("local-owner", draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "combat-map-finalize" }).receipt.actorId;
      repository.updateCampaignAdministration("local-owner", campaign.id, { expectedRevision: repository.getCampaignAdministration("local-owner", campaign.id)!.revision,
        status: "published", idempotencyKey: "combat-map-publish" });
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      request = await playwright.request.newContext({ baseURL: origin });
      const roomPath = `/api/rpg/v1/campaigns/${campaign.id}/rooms/${room.id}`;
      const readiness = campaignRoomActivationReadinessSchema.parse(await http(request, `${roomPath}/activation-readiness`));
      expect(readiness).toMatchObject({ ready: true, active: false, actorIds: [actorId] });
      campaignRoomActivationResponseSchema.parse(await http(request, `${roomPath}/activation-commands`, { expectedRevision: readiness.expectedRevision, idempotencyKey: "combat-map-activate" }));
      const template = SRD_5_1_STARTER_CATALOG.definitions.find((definition) => definition.reference.kind === "enemy-template")!.reference;
      const { encounter } = encounterCreateResponseSchema.parse(await http(request, `/api/rpg/v1/campaigns/${campaign.id}/encounters`, {
        sessionId: room.id, name: "Gate drill", combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template, team: "enemies" }], idempotencyKey: "combat-map-encounter" }, 201));
      const { combat } = encounterStartCommandResponseSchema.parse(await http(request, `/api/rpg/v1/encounters/${encounter.encounterId}/start-commands`, {
        expectedRevision: encounter.revision, idempotencyKey: "combat-map-start" }));
      const combatantId = combat.combatants.find((entry) => entry.kind === "actor" && entry.actorId === actorId)!.combatantId;
      if (combat.currentCombatant === combatantId) await http(request, `/api/rpg/v1/combats/${combat.combatId}/action-commands`, {
        legalActionId: "end-turn", targetIds: [], choices: [], expectedRevision: combat.revision, idempotencyKey: "combat-map-initial-end" });
      // Proxy unchanged requests to real handlers, not synthetic map responses.
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) });
      });
      await use({ request, campaignId: campaign.id, roomId: room.id, actorId, encounterId: encounter.encounterId, combatantId });
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

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  combatTest.describe(`${viewport.width}px combat tabletop`, () => {
    combatTest.use({ viewport, isMobile: viewport.width === 390, hasTouch: viewport.width === 390 });
    combatTest("binds off-turn actor, generates a real map, and spends only current-turn movement", async ({ page, combatTable }, testInfo) => {
      const { request, campaignId, roomId, actorId, encounterId, combatantId } = combatTable;
      const mapPath = `/api/rpg/v1/campaigns/${campaignId}/rooms/${roomId}/tactical-maps`;
      const combatPath = `/api/rpg/v1/combats/${encounterId}`;
      const snapshotPath = `${mapPath}/combat/actors/${actorId}`;
      const writes: string[] = [];
      let activationPosts = 0;
      page.on("request", (event) => {
        if (event.method() === "POST" && event.url().includes(mapPath)) writes.push(new URL(event.url()).pathname);
        if (event.method() === "POST" && event.url().endsWith(`/campaigns/${campaignId}/rooms/${roomId}/activation-commands`)) activationPosts += 1;
      });
      const offTurn = combatReadResponseSchema.parse(await http(request, combatPath));
      expect(offTurn.currentCombatant).not.toBe(combatantId);
      expect(offTurn.combatants.find((entry) => entry.combatantId === offTurn.currentCombatant)?.kind).toBe("enemy");
      expect(offTurn.combatants).toHaveLength(2);
      const actorCombatant = offTurn.combatants.find((entry) => entry.kind === "actor" && entry.actorId === actorId)!;
      const enemyCombatant = offTurn.combatants.find((entry) => entry.kind === "enemy")!;
      expect(actorCombatant.combatantId).toBe(combatantId);
      const actorToken = { tokenId: actorCombatant.combatantId, actorId, combatantId: actorCombatant.combatantId, label: actorId, position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false };
      const enemyToken = { tokenId: enemyCombatant.combatantId, actorId: null, combatantId: enemyCombatant.combatantId, label: enemyCombatant.combatantId, position: { x: 5, y: 1 }, footprint: { width: 2, height: 2 }, disposition: "hostile", hidden: true };
      const reviewedTokens = offTurn.combatants.map((entry) => entry.combatantId === combatantId ? actorToken : enemyToken);
      await page.goto("/");
      await page.getByRole("button", { name: "Open campaign Provider-free Combat Gate", exact: true }).click();
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
      await expect(page.getByText("CAMPAIGN COMMAND CENTER", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Map actor")).toHaveValue(actorId);
      await page.getByRole("button", { name: "Combat grid", exact: true }).click();
      await page.getByText("Combat readiness", { exact: true }).click();
      await expect(page.getByRole("button", { name: "Refresh combat binding", exact: true })).toBeVisible();
      await expect(page.getByText(`Verified selected combatant: ${combatantId}.`, { exact: false })).toContainText("Another combatant has the turn");
      await expect(page.getByRole("navigation", { name: "In-room tools", exact: true }).locator('[data-atlas-tool="combat"]')).toBeEnabled();
      await expect(page.getByRole("group", { name: "Combat roster placement", exact: true })).toBeVisible();
      const generate = page.getByRole("button", { name: "Generate tactical map", exact: true });
      const replaceApproval = page.getByLabel("I authorize creating or replacing this room's map with the reviewed layout and tokens.", { exact: true });
      await expect(generate).toBeDisabled();
      for (const [entry, fields] of [
        [actorCombatant, { x: "2", y: "2", width: "1", height: "1", visibility: "visible", disposition: "friendly" }],
        [enemyCombatant, { x: "6", y: "2", width: "2", height: "2", visibility: "hidden", disposition: "hostile" }],
      ] as const) {
        await page.getByLabel(`${entry.combatantId} x`, { exact: true }).fill(fields.x);
        await page.getByLabel(`${entry.combatantId} y`, { exact: true }).fill(fields.y);
        await page.getByLabel(`${entry.combatantId} width`, { exact: true }).fill(fields.width);
        await page.getByLabel(`${entry.combatantId} height`, { exact: true }).fill(fields.height);
        await page.getByLabel(`${entry.combatantId} visibility`, { exact: true }).selectOption(fields.visibility);
        await page.getByLabel(`${entry.combatantId} disposition`, { exact: true }).selectOption(fields.disposition);
      }
      await expect(replaceApproval).not.toBeChecked();
      await expect(generate).toBeDisabled();
      await replaceApproval.check();
      await expect(replaceApproval).toBeChecked();
      await expect(generate).toBeEnabled();
      const generatedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === mapPath && response.request().method() === "POST");
      await generate.click();
      const generatedHttp = await generatedResponse;
      expect(generatedHttp.status(), await generatedHttp.text()).toBe(200);
      const generationRequest = generatedHttp.request().postDataJSON();
      expect(generationRequest).toMatchObject({ mode: "combat", encounterId, width: 12, height: 10, tokens: reviewedTokens });
      const tokenIds = generationRequest.tokens.map((token: { tokenId: string }) => token.tokenId);
      expect(tokenIds).toEqual(offTurn.combatants.map((entry) => entry.combatantId));
      expect(new Set(tokenIds).size).toBe(offTurn.combatants.length);
      const occupied = new Set<string>();
      for (const token of generationRequest.tokens as typeof reviewedTokens) for (let x = token.position.x; x < token.position.x + token.footprint.width; x++) for (let y = token.position.y; y < token.position.y + token.footprint.height; y++) {
        const cell = `${x},${y}`;
        expect(occupied.has(cell), `overlapping reviewed token footprint at ${cell}`).toBe(false);
        occupied.add(cell);
      }
      const generated = tacticalMapSnapshotSchema.parse(await generatedHttp.json());
      expect(generated.encounterId).toBe(encounterId);
      expect(generated.projection.tokens.map((token) => token.tokenId).sort()).toEqual([...tokenIds].sort());
      const offTurnMap = tacticalMapSnapshotSchema.parse(await http(request, snapshotPath));
      expect(offTurnMap).toMatchObject({ encounterId, controlledTokenId: combatantId, movement: { policy: "combat-current-turn-speed", budgetFeet: 0 } });
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await page.getByText("Camera controls and movement help", { exact: true }).click();
      await page.getByRole("button", { name: "Pan right", exact: true }).click();
      const camera = page.getByLabel("Map camera", { exact: true });
      const cameraBefore = await camera.innerText();
      expect(cameraBefore).toContain("Zoom: 125%.");
      await page.getByText("Movement allowance and map revisions", { exact: true }).click();
      await expect(page.getByText(/0 feet available by combat-current-turn-speed/)).toBeVisible();
      await page.getByText("Accessible cells and tokens", { exact: true }).click();
      const cells = page.getByRole("table", { name: "Tactical map text equivalent", exact: true });
      await cells.getByRole("button", { name: "3, 2", exact: true }).click();
      await expect(page.getByRole("status", { name: "Map selection" })).toContainText("Destination: 3, 2");
      await expect(page.getByRole("button", { name: "Confirm move", exact: true })).toHaveCount(0);
      expect(writes).toEqual([mapPath]);

      await http(request, `${combatPath}/enemy-turn-commands`, { expectedRevision: offTurn.revision, idempotencyKey: "combat-map-enemy-end" });
      const turn = combatReadResponseSchema.parse(await http(request, combatPath));
      expect(turn.currentCombatant).toBe(combatantId);
      expect(turn.turnEconomy?.movement.remainingFeet).toBe(30);
      await page.getByRole("button", { name: "Refresh combat binding", exact: true }).click();
      await expect(page.getByText(`Verified selected combatant: ${combatantId}.`, { exact: false })).toContainText("Your character has the current turn");
      await expect(page.getByText(/30 feet available by combat-current-turn-speed/)).toBeVisible();
      const before = tacticalMapSnapshotSchema.parse(await http(request, snapshotPath));
      await expect(cells).toBeVisible();
      const previewResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `${mapPath}/combat/previews`);
      await cells.getByRole("button", { name: "3, 2", exact: true }).click();
      const previewHttp = await previewResponse;
      expect(previewHttp.status(), await previewHttp.text()).toBe(200);
      const preview = tacticalMapPreviewResponseSchema.parse(await previewHttp.json());
      expect(preview).toMatchObject({ encounterId, pathCostFeet: 5, mapRevision: before.mapRevision, tokenRevision: before.tokenRevision });
      expect(preview.projection.authoritativePath?.at(-1)).toEqual({ x: 2, y: 1 });
      const notMoved = tacticalMapSnapshotSchema.parse(await http(request, snapshotPath));
      expect(notMoved.tokenRevision).toBe(before.tokenRevision);
      expect(notMoved.projection.tokens.find((token) => token.tokenId === combatantId)?.position).toEqual({ x: 1, y: 1 });
      const movedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `${mapPath}/combat/move-commands`);
      await page.getByRole("button", { name: "Confirm move", exact: true }).click();
      const movedHttp = await movedResponse;
      expect(movedHttp.status(), await movedHttp.text()).toBe(200);
      expect(movedHttp.request().postDataJSON()).toMatchObject({ actorId, previewId: preview.previewId, expectedMapRevision: before.mapRevision, expectedTokenRevision: before.tokenRevision });
      const moved = tacticalMapMoveResponseSchema.parse(await movedHttp.json());
      expect(moved.receipt.previewId).toBe(preview.previewId);
      expect(moved.snapshot).toMatchObject({ encounterId, tokenRevision: before.tokenRevision + 1, movement: { budgetFeet: 25 } });
      const afterCombat = combatReadResponseSchema.parse(await http(request, combatPath));
      expect(afterCombat.revision).toBe(turn.revision + 1);
      expect(afterCombat.turnEconomy).toMatchObject({ turnId: turn.turnEconomy!.turnId, action: { available: true }, movement: { usedFeet: 5, remainingFeet: 25 } });
      await expect(page.getByText(/25 feet available by combat-current-turn-speed/)).toBeVisible();
      await page.getByRole("button", { name: "Refresh tactical map", exact: true }).click();
      await expect(page.getByText("Authoritative tactical map refreshed.", { exact: true })).toBeVisible();
      await expect(camera).toHaveText(cameraBefore);
      const persisted = tacticalMapSnapshotSchema.parse(await http(request, snapshotPath));
      expect(persisted.projection.tokens.find((token) => token.tokenId === combatantId)?.position).toEqual({ x: 2, y: 1 });
      expect(persisted.projection.tokens.map((token) => token.tokenId).sort()).toEqual([...tokenIds].sort());
      expect(persisted.movement?.budgetFeet).toBe(25);
      expect(writes).toEqual([mapPath, `${mapPath}/combat/previews`, `${mapPath}/combat/move-commands`]);
      expect(activationPosts).toBe(0);
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      expect(dimensions.viewport).toBe(viewport.width);
      expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(viewport.width);
      expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(viewport.width);
      const panel = page.getByRole("region", { name: "Living map", exact: true }).locator(".tactical-map-panel");
      const bounds = (await panel.boundingBox())!;
      for (const control of [panel.locator("canvas"), panel.getByRole("button", { name: "Refresh tactical map", exact: true })]) {
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      }
      await testInfo.attach("combat-map", { body: await page.screenshot(), contentType: "image/png" });
    });
  });
}
