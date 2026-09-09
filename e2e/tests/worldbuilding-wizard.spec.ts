import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { SRD_5_1_STARTER_IDENTITY } from "../../packages/contracts/src/index.js";

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
