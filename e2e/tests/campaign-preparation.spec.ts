import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { characterDraftHttpMutationResultSchema, characterDraftHttpViewSchema, SRD_5_1_STARTER_IDENTITY } from "../../packages/contracts/src/index.js";

async function openInlineBuilder(page: Page, request: APIRequestContext, name: string) {
  const response = await request.post("/api/rpg/v1/campaigns", { data: { name } });
  expect(response.status()).toBe(201);
  const { campaign } = await response.json();
  const setup = await request.put(`/api/rpg/v1/campaigns/${campaign.id}/mechanics-starter-setup`, {
    data: { starterId: SRD_5_1_STARTER_IDENTITY.starterId },
  });
  expect(setup.status(), await setup.text()).toBe(200);
  await page.goto("/");
  await page.getByRole("button", { name: `Open campaign ${name}`, exact: true }).click();
  await page.getByRole("button", { name: "Build a character", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Character builder", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create new persona", exact: true }).click();
  return campaign.id as string;
}

async function fillPersona(page: Page, name: string) {
  await page.getByRole("textbox", { name: "Persona name", exact: true }).fill(name);
  await page.getByRole("spinbutton", { name: "Age (18+)", exact: true }).fill("30");
  await page.getByRole("textbox", { name: "Adventurer concept", exact: true }).fill("A coastal scout searching for a missing expedition");
  await page.getByRole("textbox", { name: "Adventuring goal", exact: true }).fill("Bring the lost expedition home");
  await page.getByRole("textbox", { name: "Boundaries and hard limits", exact: true }).fill("No torture or body horror");
  await page.getByRole("checkbox", { name: "This character is fictional, 18 or older, and not based on a real person.", exact: true }).check();
}

async function verifyDraftPersona(page: Page, request: APIRequestContext, campaignId: string, personaId: string, width: number) {
  await expect(page.getByRole("combobox", { name: "Persona", exact: true })).toHaveValue(personaId);
  await page.getByRole("button", { name: "Next: Rules choices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Allocate attributes", exact: true })).toBeVisible();
  const path = `/api/rpg/v1/campaigns/${campaignId}/character-drafts`;
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create draft with this allocation", exact: true }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(201);
  const { draft } = characterDraftHttpMutationResultSchema.parse(await response.json());
  expect(draft.personaId).toBe(personaId);
  const authoritative = await request.get(`${path}/${draft.id}`);
  expect(authoritative.status()).toBe(200);
  expect(characterDraftHttpViewSchema.parse(await authoritative.json())).toMatchObject({ id: draft.id, campaignId, personaId });
  await expect(page.getByRole("heading", { name: "Required choices", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

for (const width of [1440, 390]) {
  test(`normal table setup and exact safety recovery at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const name = `Overview preparation ${width}`;
    const created = await request.post("/api/rpg/v1/campaigns", { data: { name } });
    expect(created.status()).toBe(201);
    const { campaign } = await created.json();
    const path = `/api/rpg/v1/campaigns/${campaign.id}`;
    await page.goto("/");
    await page.getByRole("button", { name: `Open campaign ${name}`, exact: true }).click();
    await page.getByRole("button", { name: "Continue preparation", exact: true }).click();
    const preparation = page.getByTestId("campaign-preparation");
    await preparation.getByRole("combobox", { name: "Rules package", exact: true }).selectOption("original");
    await preparation.getByRole("checkbox", { name: /I confirm this starter installation/ }).check();
    await preparation.getByRole("button", { name: "Install selected starter once", exact: true }).click();
    await expect(preparation.getByText(/Server response confirmed/)).toBeVisible();
    expect((await (await request.get(`${path}/administration`)).json()).campaign.status).toBe("draft");
    await preparation.getByRole("button", { name: "Read current preparation", exact: true }).click();
    await preparation.getByRole("button", { name: "Next: review table safety", exact: true }).click();
    await preparation.getByLabel("Hard limits, one per line", { exact: true }).fill("No torture");
    await preparation.getByRole("checkbox", { name: /I reviewed the complete agreement/ }).check();
    const commands: string[] = [];
    await page.route(`**${path}/session-zero-safety-commands`, async route => {
      commands.push(route.request().postData()!);
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      // The actual server commits; only the browser's first receipt is lost.
      if (commands.length === 1) await route.fulfill({ status: 502, body: "Receipt lost" });
      else await route.fulfill({ response });
    });
    await preparation.getByRole("button", { name: "Save reviewed safety agreement", exact: true }).click();
    await expect(preparation.getByText(/Write outcome uncertain/)).toBeVisible();
    await preparation.getByRole("button", { name: "Read current preparation", exact: true }).click();
    await preparation.getByRole("button", { name: "Retry exact safety command", exact: true }).click();
    await expect(preparation.getByText(/Server response confirmed/)).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    expect((await (await request.get(`${path}/administration-integrations`)).json()).safety.hardLimits).toContain("No torture");
    await preparation.getByRole("button", { name: "Read current preparation", exact: true }).click();
    await preparation.getByRole("button", { name: "Next: review publication", exact: true }).click();
    await expect(preparation.getByRole("button", { name: "Publish campaign", exact: true })).toBeDisabled();
    await preparation.getByRole("checkbox", { name: /I reviewed the rules and safety/ }).check();
    await preparation.getByRole("button", { name: "Publish campaign", exact: true }).click();
    await expect(preparation.getByText(/Server response confirmed/)).toBeVisible();
    expect((await (await request.get(`${path}/administration`)).json()).campaign.status).toBe("published");

    const personaResponse = await request.post("/api/characters", { data: { name: `Warden ${width}`, age: 30, archetype: "Coastal warden", boundaries: "Fictional test", fictionalConfirmed: true } });
    expect(personaResponse.status()).toBe(201);
    const persona = await personaResponse.json();
    expect((await request.post(`${path}/characters`, { data: { characterId: persona.id } })).status()).toBe(201);
    await preparation.getByRole("button", { name: "Read current preparation", exact: true }).click();
    await preparation.getByRole("button", { name: "Next: connect a room", exact: true }).click();
    await preparation.getByText("Create a new room", { exact: true }).click();
    await preparation.getByLabel("Room title", { exact: true }).fill(`Crossing ${width}`);
    await preparation.getByRole("checkbox", { name: `Warden ${width}`, exact: true }).check();
    const create = preparation.locator("details");
    await create.getByRole("checkbox", { name: "I confirm the selected room operation.", exact: true }).check();
    let roomCreations = 0;
    await page.route("**/api/sessions", async route => {
      if (route.request().method() !== "POST") return route.continue();
      roomCreations += 1;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.fulfill({ status: 502, body: "Creation receipt lost" });
    });
    await create.getByRole("button", { name: "Create room once", exact: true }).click();
    await expect(preparation.getByText(/Write outcome uncertain/)).toBeVisible();
    expect((await (await request.get(`${path}/rooms`)).json()).attached).toHaveLength(0);
    await preparation.getByRole("button", { name: "Read current preparation", exact: true }).click();
    await expect(preparation.getByRole("button", { name: `Attach Crossing ${width}`, exact: true })).toBeDisabled();
    await preparation.getByRole("button", { name: "I reviewed current state; allow a new decision", exact: true }).click();
    const attachment = preparation.getByRole("group", { name: "Attach an existing room", exact: true });
    await attachment.getByRole("checkbox", { name: "I confirm the selected room operation.", exact: true }).check();
    await attachment.getByRole("button", { name: `Attach Crossing ${width}`, exact: true }).click();
    await expect(preparation.getByText(/Server response confirmed/)).toBeVisible();
    const rooms = (await (await request.get(`${path}/rooms`)).json()).attached;
    expect(rooms).toHaveLength(1);
    const session = (await (await request.get(`/api/sessions/${rooms[0].sessionId}`)).json()).session;
    expect(session.state).toBe("setup");
    expect(roomCreations).toBe(1);
    await preparation.getByRole("button", { name: "Read current preparation", exact: true }).click();
    await expect(preparation.getByText(/Current preparation read/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByTestId("campaign-overview")).toBeVisible();
  });

  test(`inline persona creation selects the returned identity and progresses at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const campaignId = await openInlineBuilder(page, request, `Inline persona success ${width}`);
    const name = `Inline scout ${width}`;
    const posts: string[] = [];
    page.on("request", event => {
      if (new URL(event.url()).pathname === "/api/characters" && event.method() === "POST") posts.push(event.postData()!);
    });
    await fillPersona(page, name);
    const age = page.getByRole("spinbutton", { name: "Age (18+)", exact: true });
    await age.fill("17");
    await page.getByRole("button", { name: "Create persona once", exact: true }).click();
    expect(await age.evaluate(element => (element as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
    expect(posts).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Next: Rules choices", exact: true })).toBeDisabled();
    await age.fill("30");
    const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/characters" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Create persona once", exact: true }).click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    const persona = await response.json();
    expect(persona).toMatchObject({ name, age: 30, fictionalConfirmed: true, boundaries: "No torture or body horror", profile: { goal: "Bring the lost expedition home" } });
    const listed = await request.get("/api/characters");
    expect(listed.status()).toBe(200);
    expect((await listed.json()).characters.filter((entry: { id: string }) => entry.id === persona.id)).toHaveLength(1);
    await verifyDraftPersona(page, request, campaignId, persona.id, width);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!)).toMatchObject({ name, age: 30, fictionalConfirmed: true });
  });

  test(`lost inline persona receipt stays locked across remount and recovers by identity at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const campaignId = await openInlineBuilder(page, request, `Inline persona recovery ${width}`);
    const name = `Recovered scout ${width}`;
    let posts = 0;
    let personaId = "";
    await page.route("**/api/characters", async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts += 1;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      personaId = (await response.json()).id;
      await route.fulfill({ status: 502, body: "Persona receipt lost" });
    });
    await fillPersona(page, name);
    await page.getByRole("button", { name: "Create persona once", exact: true }).click();
    await expect(page.getByText(/Persona creation outcome is uncertain/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create persona once", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Next: Rules choices", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: /Back to campaign/ }).click();
    await page.getByRole("button", { name: "Build a character", exact: true }).click();
    await page.getByRole("button", { name: "Create new persona", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Persona name", exact: true })).toHaveValue(name);
    await expect(page.getByRole("button", { name: "Create persona once", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Refresh authoritative persona list", exact: true }).click();
    await expect(page.getByText(/Authoritative list refreshed/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Use explicitly selected persona", exact: true })).toBeDisabled();
    await page.getByRole("combobox", { name: "Authoritative persona", exact: true }).selectOption(personaId);
    await page.getByRole("button", { name: "Use explicitly selected persona", exact: true }).click();
    await verifyDraftPersona(page, request, campaignId, personaId, width);
    expect(posts).toBe(1);
  });
}
