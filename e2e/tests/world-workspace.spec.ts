import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function createCampaign(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post("/api/rpg/v1/campaigns", { data: { name } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { campaign: { id: string } }).campaign.id;
}

async function populateWorld(request: APIRequestContext, campaignId: string, suffix: string): Promise<void> {
  const persona = await request.post("/api/characters", { data: {
    name: `World scout ${suffix}`, age: 30, archetype: "Coastal scout",
    boundaries: "Deterministic fictional test", fictionalConfirmed: true,
  } });
  expect(persona.status(), await persona.text()).toBe(201);
  const personaId = (await persona.json() as { id: string }).id;
  const room = await request.post("/api/sessions", { data: { characterId: personaId, title: `World room ${suffix}` } });
  expect(room.status(), await room.text()).toBe(201);
  const sessionId = (await room.json() as { id: string }).id;
  const attached = await request.put(`/api/rpg/v1/campaigns/${campaignId}/rooms`, { data: { sessionId } });
  expect(attached.status(), await attached.text()).toBe(200);
  const location = await request.post("/api/__e2e/materialize-campaign-location", { data: {
    campaignId, locationId: `harbor-${suffix}`, parentLocationId: null,
    name: "Old Harbor", description: "Lanterns shine through the rain.",
  } });
  expect(location.status(), await location.text()).toBe(204);
}

function captureRuntimeFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(`pageerror: ${error.stack ?? error.message}`));
  page.on("console", message => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  return failures;
}

for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`empty owner campaign opens World without runtime failures on ${viewport.name}`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const failures = captureRuntimeFailures(page);
    const name = `World regression empty ${viewport.name}`;
    const campaignId = await createCampaign(request, name);
    await page.goto("/");
    await page.getByRole("button", { name: `Open campaign ${name}`, exact: true }).click();
    await page.getByRole("navigation", { name: "Campaign destinations", exact: true })
      .getByRole("button", { name: "World workspace", exact: true }).click();

    await expect(page.getByRole("heading", { name: "World explorer", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No campaign world yet", exact: true })).toBeVisible();
    await expect(page.getByText(/Attach exactly one room/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(failures.filter(failure => !failure.includes("server responded with a status of 404"))).toEqual([]);
    expect(failures).toHaveLength(2);
  });

  test(`populated owner campaign opens World without runtime failures on ${viewport.name}`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const failures = captureRuntimeFailures(page);
    const name = `World regression populated ${viewport.name}`;
    const campaignId = await createCampaign(request, name);
    await populateWorld(request, campaignId, viewport.name);

    await page.goto("/");
    await page.getByRole("button", { name: `Open campaign ${name}`, exact: true }).click();
    await page.getByRole("navigation", { name: "Campaign destinations", exact: true })
      .getByRole("button", { name: "World workspace", exact: true }).click();

    await expect(page.getByRole("heading", { name: "World explorer", exact: true })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /Old Harbor/ })).toBeVisible();
    await expect(page.getByText("No applied opening outline yet.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(failures).toEqual([]);
  });
}
