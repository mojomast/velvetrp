import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { campaignGenerationSectionFields, SRD_5_1_STARTER_IDENTITY, type CampaignContentGenerationRequest } from "../../packages/contracts/src/index.js";

async function createCampaign(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post("/api/rpg/v1/campaigns", { data: { name } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { campaign: { id: string } }).campaign.id;
}

async function installMechanics(request: APIRequestContext, campaignId: string): Promise<void> {
  const setup = await request.put(`/api/rpg/v1/campaigns/${campaignId}/mechanics-starter-setup`, {
    data: { starterId: SRD_5_1_STARTER_IDENTITY.starterId },
  });
  expect(setup.status(), await setup.text()).toBe(200);
}

async function prepareCampaign(request: APIRequestContext, campaignId: string, suffix: string): Promise<void> {
  await installMechanics(request, campaignId);
  const persona = await request.post("/api/characters", { data: {
    name: `Wizard scout ${suffix}`, age: 30, archetype: "Coastal scout",
    boundaries: "Deterministic fictional test", fictionalConfirmed: true,
  } });
  expect(persona.status(), await persona.text()).toBe(201);
  const personaId = (await persona.json() as { id: string }).id;
  const room = await request.post("/api/sessions", { data: { characterId: personaId, title: `Wizard room ${suffix}` } });
  expect(room.status(), await room.text()).toBe(201);
  const sessionId = (await room.json() as { id: string }).id;
  const attached = await request.put(`/api/rpg/v1/campaigns/${campaignId}/rooms`, { data: { sessionId } });
  expect(attached.status(), await attached.text()).toBe(200);
}

async function stageReviewedLocation(request: APIRequestContext, campaignId: string, suffix: string): Promise<string> {
  const response = await request.post("/api/rpg/v1/campaign-content-drafts", { data: {
    campaignId,
    brief: "A reviewed provider-free coastal opening",
    tone: "adventurous and grounded",
    exclusions: [],
    idempotencyKey: `wizard-reviewed-${suffix}`,
    sections: ["locations"],
    expandArtifactKeys: [],
    revisionFeedback: null,
    retryFailedAttempt: null,
    reviewedContent: {
      locations: [{
        key: "old-harbor", name: "Old Harbor", description: "Lanterns shine through the rain.",
        visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [],
      }],
    },
  } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { draft: { draftId: string } }).draft.draftId;
}

async function openCampaign(page: Page, name: string): Promise<void> {
  await page.goto("/");
  const target = page.getByRole("button", { name: `Open campaign ${name}`, exact: true });
  const alreadyInLibrary = await target.waitFor({ state: "visible", timeout: 1_000 }).then(() => true).catch(() => false);
  if (!alreadyInLibrary) await page.locator(".control-brand").click();
  await target.click();
}

for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`worldbuilding wizard persists its authoritative opening on ${viewport.name}`, async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.stack ?? error.message));

    const emptyName = `Wizard empty ${viewport.name}`;
    const emptyCampaignId = await createCampaign(request, emptyName);
    await installMechanics(request, emptyCampaignId);
    await openCampaign(page, emptyName);
    await page.getByRole("navigation", { name: "Campaign destinations", exact: true })
      .getByRole("button", { name: "World workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No campaign world yet", exact: true })).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(0, 0, 0)");
    expect(pageErrors).toEqual([]);

    const name = `Wizard designation ${viewport.name}`;
    const campaignId = await createCampaign(request, name);
    await prepareCampaign(request, campaignId, viewport.name);
    const draftId = await stageReviewedLocation(request, campaignId, viewport.name);
    await openCampaign(page, name);
    await page.evaluate(({ campaignId, draftId }) => {
      sessionStorage.setItem(`velvet-campaign-authoring-v1:${campaignId}`, JSON.stringify({ draftId }));
    }, { campaignId, draftId });

    let generatedOnMount = 0;
    page.on("request", browserRequest => {
      if (browserRequest.method() === "POST" && new URL(browserRequest.url()).pathname === "/api/rpg/v1/campaign-content-drafts") generatedOnMount += 1;
    });
    await page.getByRole("navigation", { name: "Campaign destinations", exact: true })
      .getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review generated material", exact: true })).toBeVisible();
    expect(generatedOnMount).toBe(0);
    await page.getByLabel(/I reviewed the 1 selected candidate artifact/).check();
    await page.getByRole("button", { name: "Accept selected material as canon", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose the opening, then prepare play", exact: true })).toBeVisible();
    await page.locator(".campaign-starting-location-choice select").selectOption({ label: "Old Harbor" });
    await page.getByRole("button", { name: "Designate starting location once", exact: true }).click();
    await expect(page.getByText("Old Harbor is the authoritative campaign starting location.", { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose the opening, then prepare play", exact: true })).toBeVisible();
    await expect(page.getByText("This create-once designation is locked. It does not move any actor or start a room.", { exact: true })).toBeVisible();
    const authoritative = await request.get(`/api/rpg/v1/campaigns/${campaignId}/starting-location`);
    expect(authoritative.status(), await authoritative.text()).toBe(200);
    expect(await authoritative.json()).toMatchObject({ campaignId, startingLocation: { name: "Old Harbor" } });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(pageErrors).toEqual([]);
  });
}

/** Reviewed fixtures exercise real validation, receipts and persistence without a paid provider. */
function reviewedWorldSections(input: CampaignContentGenerationRequest): Record<string, unknown> {
  const location = (index: number) => `coast-place-${index}`;
  const content: Record<string, unknown[]> = {
    factions: Array.from({ length: 4 }, (_, index) => ({ key: `coast-faction-${index}`, name: `Coastal guild ${index}`, description: "A guild with work and interests along the coast.", visibility: "public" })),
    locations: Array.from({ length: 6 }, (_, index) => ({ key: location(index), name: `Coastal place ${index}`, description: "Lanterns illuminate an inviting path.", visibility: "public" })),
    connections: Array.from({ length: 5 }, (_, index) => [
      { key: `coast-road-out-${index}`, fromLocationKey: location(0), toLocationKey: location(index + 1), description: "A marked outward road.", visibility: "public" },
      { key: `coast-road-home-${index}`, fromLocationKey: location(index + 1), toLocationKey: location(0), description: "A marked return road.", visibility: "public" },
    ]).flat(),
    outlines: [{ key: "coast-opening", opening: "The evening market is open to travelers.", premise: "Explore the coastal guilds and their independent concerns.", startLocationKey: location(0), visibility: "public" }],
    arcs: Array.from({ length: 3 }, (_, index) => ({ key: `coast-arc-${index}`, title: `Guild concerns ${index}`, summary: "The guilds pursue competing aims and respond to player choices.", visibility: "gm" })),
    npcs: Array.from({ length: 6 }, (_, index) => ({ key: `coast-person-${index}`, name: `Coastal guide ${index}`, archetype: "Guide", description: "An approachable guide with local work to offer.", locationKey: location(index), visibility: "public" })),
    storyNodes: Array.from({ length: 8 }, (_, index) => ({ key: `coast-situation-${index}`, title: `Coastal situation ${index}`, description: "A guild needs help and several approaches are possible.", visibility: index === 0 ? "public" : "gm" })),
    storyRelationships: Array.from({ length: 6 }, (_, index) => ({ key: `coast-story-link-${index}`, fromStoryNodeKey: "coast-situation-0", toStoryNodeKey: `coast-situation-${index + 1}`, description: "An optional lead, available independently.", visibility: "gm" })),
    clues: Array.from({ length: 5 }, (_, index) => ({ key: `coast-clue-${index}`, title: `Local clue ${index}`, description: "A rumor can be discovered through several conversations.", locationKey: location(index), visibility: "gm" })),
    quests: Array.from({ length: 5 }, (_, index) => ({ key: `coast-quest-${index}`, title: `Coastal work ${index}`, description: "A local guild asks for help finding a lost delivery.", locationKeys: [location(index)], objectives: [{ key: `coast-objective-${index}`, description: "Speak to the guide about the delivery.", visibility: "public" }], visibility: "public" })),
    monsterConcepts: Array.from({ length: 4 }, (_, index) => ({ key: `coast-creature-${index}`, name: `Marsh creature ${index}`, description: "A territorial marsh inhabitant that can be avoided.", role: "Local wildlife", mechanics: { state: "inert", reason: "Narrative preparation" }, visibility: "gm" })),
    questItems: Array.from({ length: 4 }, (_, index) => ({ key: `coast-item-${index}`, name: `Guild relic ${index}`, description: "A relic whose history interests the guild.", questKeys: [`coast-quest-${index}`], locationKeys: [location(index)], mechanics: { state: "inert", reason: "Narrative preparation" }, visibility: "gm" })),
    encounters: Array.from({ length: 5 }, (_, index) => ({ key: `coast-encounter-${index}`, title: `Roadside meeting ${index}`, description: "Travelers ask for directions and offer work.", locationKey: location(index), visibility: "gm" })),
    lore: Array.from({ length: 6 }, (_, index) => ({ key: `coast-lore-${index}`, title: `Coastal custom ${index}`, summary: "Local history informs how the guild approaches visitors.", locationKeys: [location(index)], visibility: "gm" })),
    handouts: Array.from({ length: 3 }, (_, index) => ({ key: `coast-handout-${index}`, title: `Guild notice ${index}`, content: "Work is available for willing travelers.", visibility: "public" })),
    scenePrompts: Array.from({ length: 4 }, (_, index) => ({ key: `coast-scene-${index}`, title: `Guild scene ${index}`, prompt: "The guide offers work. Listen to the players and react to their chosen approach.", locationKey: location(index), npcKeys: [`coast-person-${index}`], visibility: "gm" })),
  };
  return Object.fromEntries(input.sections.flatMap((section) => campaignGenerationSectionFields[section]).map((field) => [field, content[field]]));
}

test("one-prompt world resumes a lost response and hands off to world editing and play setup", async ({ page, request }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let paidDispatches = 0, dropLocationResponse = true;
  const generationInputs: CampaignContentGenerationRequest[] = [];
  // Only provider generation is replaced. The server owns every draft, validation and apply receipt.
  await page.route(/\/api\/rpg\/v1\/campaign-content-drafts(?:\/reconcile)?$/, async route => {
    const input = route.request().postDataJSON() as CampaignContentGenerationRequest;
    const reconciling = route.request().url().endsWith("/reconcile");
    if (!reconciling) { paidDispatches += 1; generationInputs.push(input); }
    const response = await request.post(route.request().url(), { data: { ...input, reviewedContent: reviewedWorldSections(input) } });
    expect(response.status(), await response.text()).toBe(reconciling ? 200 : 201);
    if (!reconciling && input.sections.includes("locations") && dropLocationResponse) {
      dropLocationResponse = false;
      await route.abort("failed");
      return;
    }
    await route.fulfill({ response });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Campaigns & worlds", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Generate world", exact: true }).click();
  const builder = page.getByRole("region", { name: "Worldbuilding agent", exact: true });
  await builder.getByLabel("Campaign name", { exact: true }).fill("Recovered Lantern Coast");
  await builder.getByLabel("Premise or description").fill("A tidebound coast of guilds, quiet mysteries, and independent opportunities for travelers.");
  await builder.getByRole("button", { name: "Build world", exact: true }).click();
  await expect(builder.getByRole("button", { name: "Reconcile generation", exact: true })).toBeVisible();
  await expect(builder.getByRole("heading", { name: "Progress: 1 of 11 stages applied" })).toBeVisible();
  const campaignId = generationInputs[0]!.campaignId;
  expect(paidDispatches).toBe(2);
  await page.reload();
  await page.getByRole("button", { name: "Generate world", exact: true }).click();
  await expect(builder.getByRole("button", { name: "Reconcile draft", exact: true })).toBeVisible();
  expect(paidDispatches).toBe(2);
  await builder.getByRole("button", { name: "Reconcile draft", exact: true }).click();
  await expect(builder.getByRole("heading", { name: "Progress: 2 of 11 stages applied" })).toBeVisible();
  await builder.getByRole("button", { name: "Resume world build", exact: true }).click();
  await expect(builder.getByRole("heading", { name: "Progress: 11 of 11 stages applied" })).toBeVisible();
  expect(paidDispatches).toBe(11);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.screenshot({ path: test.info().outputPath("worldbuilding-complete.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("worldbuilding-complete-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: test.info().outputPath("worldbuilding-complete-dark.png"), fullPage: true });
  const opening = await request.get(`/api/rpg/v1/campaigns/${campaignId}/starting-location`);
  expect(await opening.json()).toMatchObject({ startingLocation: { name: "Coastal place 0" } });
  await builder.getByRole("button", { name: "Manage world", exact: true }).click();
  await expect(page.getByRole("heading", { name: "World explorer", exact: true })).toBeVisible();
  await page.locator(".control-brand").click();
  await page.getByRole("button", { name: "Generate world", exact: true }).click();
  await builder.getByRole("button", { name: "Prepare to play", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rooms", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect or create a room", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
