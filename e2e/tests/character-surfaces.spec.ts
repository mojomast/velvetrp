import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MECHANICS_STARTER_CATALOG } from "../../server/src/repo/index.js";

const runId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function json<T>(request: APIRequestContext, method: string, path: string, data?: unknown, status?: number): Promise<T> {
  const response = await request.fetch(`/api${path}`, { method, data });
  expect(response.status(), `${method} ${path}`).toBe(status ?? (method === "POST" ? 201 : 200));
  return response.json() as Promise<T>;
}

interface CampaignFixture {
  campaignName: string;
  campaignId: string;
  actorId: string;
  sessionId: string;
  personaId: string;
  characterId: string;
}

/** Publishes the mechanics starter, finalizes one durable character, attaches a running room, and publishes the campaign. */
async function setupMechanicsCampaign(request: APIRequestContext, label: string): Promise<CampaignFixture> {
  const fixture = MECHANICS_STARTER_CATALOG;
  const pin = { packId: fixture.manifest.packId, packVersion: fixture.manifest.packVersion };
  await json(request, "POST", "/rpg/v1/content-packs", fixture);
  const persona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-${label}-Actor`, age: 30, archetype: "Deterministic explorer",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  const campaignName = `${runId}-${label}`;
  const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", { name: campaignName });
  const campaignId = campaign.campaign.id;
  const administration = await json<{ campaign: { revision: number } }>(request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`);
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/content`, {
    rulesProfileId: fixture.manifest.compatibility.rulesProfileId, contentPacks: [pin],
    expectedRevision: administration.campaign.revision, idempotencyKey: `${runId}-${label}-content`,
  });
  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const draft = await json<{ draft: { id: string; revision: number } }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts`, {
    personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${runId}-${label}-draft`,
  });
  const reference = (kind: "race" | "background" | "class") => fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
  const selected = await json<{ draft: { revision: number } }>(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}`, {
    expectedRevision: draft.draft.revision, idempotencyKey: `${runId}-${label}-select`,
    selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
  });
  const finalized = await json<{ character: { id: string } }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}/finalize`, {
    expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-${label}-finalize`,
  }, 201);
  const actor = await json<{ actorId: string }>(request, "GET", `/__e2e/campaigns/${campaignId}/characters/${finalized.character.id}/actor`);
  const session = await json<{ id: string }>(request, "POST", "/sessions", { characterId: persona.id, title: `${runId}-${label}-Room` });
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/rooms`, { sessionId: session.id });
  const ready = await json<{ campaign: { revision: number } }>(request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`);
  await json(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/administration`, {
    expectedRevision: ready.campaign.revision, idempotencyKey: `${runId}-${label}-publish`, status: "published",
  });
  // An attached room starts in setup; one ordinary message moves it to active so
  // the play bootstrap and companion/world lanes treat it as running.
  await json(request, "POST", `/sessions/${session.id}/messages`, { content: "Open the deterministic scene." }, 200);
  return { campaignName, campaignId, actorId: actor.actorId, sessionId: session.id, personaId: persona.id, characterId: finalized.character.id };
}

/** Finalizes one additional durable mechanics character into an already-configured campaign. */
async function addMechanicsCharacter(request: APIRequestContext, campaignId: string, label: string): Promise<{ actorId: string }> {
  const fixture = MECHANICS_STARTER_CATALOG;
  const persona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-${label}-Actor`, age: 29, archetype: "Deterministic trader",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const draft = await json<{ draft: { id: string; revision: number } }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts`, {
    personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${runId}-${label}-draft`,
  });
  const reference = (kind: "race" | "background" | "class") => fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
  const selected = await json<{ draft: { revision: number } }>(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}`, {
    expectedRevision: draft.draft.revision, idempotencyKey: `${runId}-${label}-select`,
    selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
  });
  const finalized = await json<{ character: { id: string } }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}/finalize`, {
    expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-${label}-finalize`,
  }, 201);
  const actor = await json<{ actorId: string }>(request, "GET", `/__e2e/campaigns/${campaignId}/characters/${finalized.character.id}/actor`);
  return { actorId: actor.actorId };
}

async function openRoom(page: Page, campaignName: string): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Campaigns", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Open campaign ${campaignName}` }).click();
  await page.getByRole("button", { name: "Open advanced setup" }).click();
  await page.getByRole("button", { name: "Open attached room 1 of 1" }).click();
  await expect(page.getByRole("heading", { name: "Adventure room" })).toBeVisible();
}

async function openCharacterTools(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Character", exact: true }).click();
  await page.getByRole("button", { name: "Inventory & equipment" }).click();
  await expect(page.getByRole("heading", { name: "Resources", exact: true })).toBeVisible();
}

test("character sheet resolves a check, applies/removes an effect, and adjusts a resource once", async ({ page, request }) => {
  const fixture = await setupMechanicsCampaign(request, "Sheet");
  const focus = await request.post("/api/__e2e/materialize-short-rest-resource", {
    data: { campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0 },
  });
  expect(focus.status()).toBe(204);

  await openRoom(page, fixture.campaignName);
  await openCharacterTools(page);

  // Resource adjustment (M15).
  const resourceSection = page.getByRole("region", { name: "Resources" });
  await expect(resourceSection.getByText("1 of 4")).toBeVisible();
  await resourceSection.getByLabel("Amount").fill("1");
  await resourceSection.getByRole("button", { name: "Adjust resource" }).click();
  await expect(page.getByText("Command confirmed and authoritative state refreshed.")).toBeVisible();
  await expect(page.getByText("2 of 4")).toBeVisible();

  // Server-resolved check (M16).
  const checkSection = page.getByRole("region", { name: "Checks" });
  await checkSection.getByLabel("Check kind").selectOption("ability");
  await checkSection.getByLabel("Skill or attribute ID").fill("might");
  await checkSection.getByRole("button", { name: "Resolve check" }).click();
  await expect(checkSection.getByText("Outcome", { exact: true })).toBeVisible();

  // Effect apply then remove (M16).
  const effectSection = page.getByRole("region", { name: "Conditions & effects" });
  await effectSection.getByText("Apply a new effect").click();
  await effectSection.getByLabel("Applies to ID").fill("defense");
  await effectSection.getByRole("button", { name: "Apply effect" }).click();
  await expect(effectSection.getByText("flat defense")).toBeVisible();
  await effectSection.getByRole("button", { name: /^Remove / }).click();
  await expect(effectSection.getByText("No active effects.")).toBeVisible();

  const resources = await json<{ resources: Array<{ name: string; current: number; max: number }>; revision: number }>(
    request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/actors/${fixture.actorId}/resources`,
  );
  expect(resources.resources).toContainEqual(expect.objectContaining({ name: "focus", current: 2, max: 4 }));
  const effects = await json<{ effects: unknown[]; revision: number }>(request, "GET", `/rpg/v1/actors/${fixture.actorId}/effects`);
  expect(effects.effects).toEqual([]);
});

test("character sheet sells an exact item to a present vendor once", async ({ page, request }) => {
  const fixture = await setupMechanicsCampaign(request, "Vendor");
  const economy = await request.post("/api/__e2e/materialize-economy-fixture", {
    data: { campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0 },
  });
  expect(economy.status()).toBe(204);
  const shopId = `${fixture.campaignId}-waylamp-shop`, stockId = `${fixture.campaignId}-waylamp-stock`;
  const locationId = `${runId}-market`;
  const location = await request.post("/api/__e2e/materialize-campaign-location", {
    data: { campaignId: fixture.campaignId, locationId, parentLocationId: null, name: "Waylamp Market", description: "Open stalls." },
  });
  expect(location.status()).toBe(204);
  const npcPersona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-Vendor-Persona`, age: 44, archetype: "Merchant",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  const npc = await json<{ npc: { npcId: string } }>(request, "POST", `/rpg/v1/campaigns/${fixture.campaignId}/npcs`, {
    personaId: npcPersona.id, publicState: { name: `${runId}-Vendor` },
    privateState: { goals: "Trade", gmNotes: "E2E only", merchantState: null },
    expectedRevision: 0, idempotencyKey: `${runId}-vendor-npc`,
  }, 201);
  await json(request, "POST", `/rpg/v1/campaigns/${fixture.campaignId}/rooms/${fixture.sessionId}/npcs/${npc.npc.npcId}/presence-commands`, {
    expectedRevision: 0, idempotencyKey: `${runId}-vendor-presence`, mutation: { kind: "place", locationId },
  }, 200);
  await json(request, "POST", `/rpg/v1/actors/${fixture.actorId}/placement-commands`, {
    campaignId: fixture.campaignId, locationId, expectedRevision: 0, idempotencyKey: `${runId}-vendor-place`,
  }, 200);
  let administration = await json<{ campaign: { revision: number } }>(request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/administration`);
  await json(request, "POST", `/rpg/v1/campaigns/${fixture.campaignId}/vendor-association-commands`, {
    expectedRevision: administration.campaign.revision, idempotencyKey: `${runId}-vendor-associate`,
    npcId: npc.npc.npcId, shopId,
  }, 200);
  administration = await json<{ campaign: { revision: number } }>(request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/administration`);
  await json(request, "POST", `/rpg/v1/campaigns/${fixture.campaignId}/buy-policy-commands`, {
    expectedRevision: administration.campaign.revision, idempotencyKey: `${runId}-vendor-policy`,
    shopId, stockId, payoutUnitMinor: 4,
  }, 200);
  const entryId = `${runId}-vendor-waylamp`;
  const waylamp = await request.post("/api/__e2e/materialize-waylamp", {
    data: { campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0, entryId },
  });
  expect(waylamp.status()).toBe(204);

  await openRoom(page, fixture.campaignName);
  await openCharacterTools(page);
  const sell = page.getByRole("region", { name: "Sell to a vendor" });
  await sell.getByLabel("Item").selectOption(entryId);
  await sell.getByLabel("Quantity").fill("1");
  await sell.getByRole("button", { name: "Request sale quote" }).click();
  await expect(sell.getByText("Payout")).toBeVisible();
  await sell.getByRole("button", { name: "Sell once" }).click();
  await expect(page.getByRole("heading", { name: "Economy receipt and server result" })).toBeVisible();
  await expect(page.getByText(/Exact received total/)).toBeVisible();

  const wallet = await json<{ wallet: { balances: Array<{ minorUnits: number }> } }>(
    request, "GET", `/__e2e/economy/campaigns/${fixture.campaignId}/actors/${fixture.actorId}/wallet`,
  );
  expect(wallet.wallet.balances[0]!.minorUnits).toBe(24);
  const inventory = await json<{ entries: Array<{ entryId: string }> }>(
    request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/actors/${fixture.actorId}/inventory`,
  );
  expect(inventory.entries.map((entry) => entry.entryId)).not.toContain(entryId);
});

test("character sheet accepts a bilateral trade for the exact instance", async ({ page, request }) => {
  const fixture = await setupMechanicsCampaign(request, "Trade");
  const other = await addMechanicsCharacter(request, fixture.campaignId, "Trade-Other");
  const economy = await request.post("/api/__e2e/materialize-economy-fixture", {
    data: { campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0 },
  });
  expect(economy.status()).toBe(204);
  const waylamp = { kind: "item" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId,
    packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:item:waylamp" };
  const offeredEntry = `${runId}-trade-offered`, requestedEntry = `${runId}-trade-requested`;
  for (const [actorId, entryId] of [[fixture.actorId, requestedEntry], [other.actorId, offeredEntry]] as const) {
    const seeded = await request.post("/api/__e2e/materialize-waylamp", {
      data: { campaignId: fixture.campaignId, actorId, expectedRevision: 0, entryId },
    });
    expect(seeded.status()).toBe(204);
  }
  const tradeId = `${runId}-trade`;
  await json(request, "POST", `/rpg/v1/campaigns/${fixture.campaignId}/actors/${other.actorId}/economy-commands`, {
    type: "propose_bilateral_trade", tradeId, recipientActorId: fixture.actorId,
    offered: { items: [{ kind: "instanced", entryId: offeredEntry, item: waylamp }], currency: [] },
    requested: { items: [{ kind: "instanced", entryId: requestedEntry, item: waylamp }], currency: [] },
    expectedRevision: 0, idempotencyKey: `${runId}-trade-propose`,
  }, 200);

  await openRoom(page, fixture.campaignName);
  await openCharacterTools(page);
  const trades = page.getByRole("region", { name: "Bilateral trades" });
  await trades.getByLabel("Trade ID").fill(tradeId);
  await trades.getByRole("button", { name: "Accept trade" }).click();
  await expect(page.getByRole("heading", { name: "Economy receipt and server result" })).toBeVisible();
  await expect(page.getByText(`${tradeId} · settled`)).toBeVisible();

  const inventory = await json<{ entries: Array<{ entryId: string }> }>(
    request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/actors/${fixture.actorId}/inventory`,
  );
  expect(inventory.entries.map((entry) => entry.entryId)).toEqual(expect.arrayContaining([offeredEntry]));
  expect(inventory.entries.map((entry) => entry.entryId)).not.toContain(requestedEntry);
});

test("character sheet cancels an open bilateral trade without settling", async ({ page, request }) => {
  const fixture = await setupMechanicsCampaign(request, "TradeCancel");
  const other = await addMechanicsCharacter(request, fixture.campaignId, "TradeCancel-Other");
  const economy = await request.post("/api/__e2e/materialize-economy-fixture", {
    data: { campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0 },
  });
  expect(economy.status()).toBe(204);
  const waylamp = { kind: "item" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId,
    packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:item:waylamp" };
  const aEntry = `${runId}-cancel-a`, bEntry = `${runId}-cancel-b`;
  for (const [actorId, entryId] of [[fixture.actorId, aEntry], [other.actorId, bEntry]] as const) {
    const seeded = await request.post("/api/__e2e/materialize-waylamp", {
      data: { campaignId: fixture.campaignId, actorId, expectedRevision: 0, entryId },
    });
    expect(seeded.status()).toBe(204);
  }
  const tradeId = `${runId}-cancel-trade`;
  await json(request, "POST", `/rpg/v1/campaigns/${fixture.campaignId}/actors/${other.actorId}/economy-commands`, {
    type: "propose_bilateral_trade", tradeId, recipientActorId: fixture.actorId,
    offered: { items: [{ kind: "instanced", entryId: bEntry, item: waylamp }], currency: [] },
    requested: { items: [{ kind: "instanced", entryId: aEntry, item: waylamp }], currency: [] },
    expectedRevision: 0, idempotencyKey: `${runId}-cancel-propose`,
  }, 200);

  await openRoom(page, fixture.campaignName);
  await openCharacterTools(page);
  const trades = page.getByRole("region", { name: "Bilateral trades" });
  await trades.getByLabel("Trade ID").fill(tradeId);
  await trades.getByRole("button", { name: "Cancel trade" }).click();
  await expect(page.getByRole("heading", { name: "Economy receipt and server result" })).toBeVisible();
  await expect(page.getByText(`${tradeId} · cancelled`)).toBeVisible();

  const inventory = await json<{ entries: Array<{ entryId: string }> }>(
    request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/actors/${fixture.actorId}/inventory`,
  );
  expect(inventory.entries.map((entry) => entry.entryId)).toContain(aEntry);
  expect(inventory.entries.map((entry) => entry.entryId)).not.toContain(bEntry);
});

test("world expedition places an unplaced actor and camps once from the browser", async ({ page, request }) => {
  const fixture = await setupMechanicsCampaign(request, "Expedition");
  const locationId = `${runId}-expedition-glade`;
  const location = await request.post("/api/__e2e/materialize-campaign-location", {
    data: { campaignId: fixture.campaignId, locationId, parentLocationId: null, name: "Expedition Glade", description: "A still clearing." },
  });
  expect(location.status()).toBe(204);

  await openRoom(page, fixture.campaignName);
  await page.getByRole("button", { name: "Travel" }).click();
  await expect(page.getByRole("heading", { name: "Expedition", exact: true })).toBeVisible();
  const expedition = page.locator(".world-expedition");
  await expedition.locator("select").nth(0).selectOption(fixture.actorId);
  await expedition.locator("select").nth(1).selectOption(locationId);
  const place = page.getByRole("button", { name: "Place actor" });
  const camp = page.getByRole("button", { name: "Make camp" });
  await expect(place).toBeEnabled();
  await expect(camp).toBeDisabled();

  const placePosts: string[] = [], campPosts: string[] = [];
  page.on("request", (browserRequest) => {
    const pathname = new URL(browserRequest.url()).pathname;
    if (/\/placement-commands$/.test(pathname)) placePosts.push(browserRequest.method());
    if (/\/camp-commands$/.test(pathname)) campPosts.push(browserRequest.method());
  });
  await place.click();
  await expect(page.getByRole("heading", { name: "Confirmed command receipt" })).toBeVisible();
  await expect(camp).toBeEnabled();
  await camp.click();
  await expect(page.getByRole("heading", { name: "Confirmed command receipt" }).last()).toBeVisible();
  expect(placePosts).toEqual(["POST"]);
  expect(campPosts).toEqual(["POST"]);

  const world = await json<{ currentLocations: Array<{ actorId: string; locationId: string }> }>(
    request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/world`,
  );
  expect(world.currentLocations).toEqual([expect.objectContaining({ actorId: fixture.actorId, locationId })]);
});

test("cast studio creates a companion, grants, and revokes from the browser", async ({ page, request }) => {
  const fixture = await setupMechanicsCampaign(request, "Companion");
  const npcPersona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-Companion-NPC-Persona`, age: 38, archetype: "Companion guide",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  const npc = await json<{ npc: { npcId: string } }>(request, "POST", `/rpg/v1/campaigns/${fixture.campaignId}/npcs`, {
    personaId: npcPersona.id, publicState: { name: `${runId}-Companion-Guide` },
    privateState: { goals: "Guide safely", gmNotes: "E2E only", merchantState: null },
    expectedRevision: 0, idempotencyKey: `${runId}-companion-npc`,
  }, 201);
  await json(request, "POST", `/rpg/v1/campaigns/${fixture.campaignId}/rooms/${fixture.sessionId}/npcs/${npc.npc.npcId}/presence-commands`, {
    expectedRevision: 0, idempotencyKey: `${runId}-companion-presence`, mutation: { kind: "place", locationId: null },
  }, 200);
  const administration = await json<{ campaign: { revision: number } }>(request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/administration`);
  await json(request, "POST", `/rpg/v1/campaigns/${fixture.campaignId}/memberships`, {
    principalId: "e2e-membership-principal", role: "player", expectedRevision: administration.campaign.revision,
    idempotencyKey: `${runId}-companion-member`,
  }, 200);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Campaigns", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Open campaign ${fixture.campaignName}` }).click();
  await page.getByRole("button", { name: "Cast & factions" }).click();
  await expect(page.getByRole("heading", { name: "Cast & factions" })).toBeVisible();
  await page.getByRole("button", { name: "Companion administration" }).click();
  await page.getByLabel("Companion NPC").selectOption(npc.npc.npcId);

  await expect(page.getByText("This NPC is not a companion yet.")).toBeVisible();
  await page.getByLabel("Attached room").selectOption(fixture.sessionId);
  await page.getByRole("button", { name: "Create companion" }).click();
  await expect(page.getByText(/Companion creation committed/)).toBeVisible();

  await page.getByLabel("Grantee").selectOption("e2e-membership-principal");
  await page.getByLabel("Actor scope").selectOption(fixture.actorId);
  await page.getByLabel("rest", { exact: true }).check();
  await page.getByLabel("Expires").fill("2036-01-01T00:00:00.000Z");
  await page.getByRole("button", { name: "Create exact grant" }).click();
  await expect(page.getByText(/Companion grant creation committed/)).toBeVisible();
  await expect(page.locator(".companion-grant-list").getByText("e2e-membership-principal")).toBeVisible();

  await page.getByRole("button", { name: "Revoke grant" }).click();
  await expect(page.getByText(/Companion grant revocation committed/)).toBeVisible();

  const management = await json<{ companion: { revision: number; grants: Array<{ revokedAt: string | null }> } }>(
    request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/npcs/${npc.npc.npcId}/companion-administration`,
  );
  expect(management.companion.revision).toBe(3);
  expect(management.companion.grants[0]!.revokedAt).not.toBeNull();
});

test("combat lifecycle generates and applies an encounter draft from the browser", async ({ page, request }) => {
  const fixture = await setupMechanicsCampaign(request, "Encounter");
  const enemy = await request.post("/api/__e2e/materialize-pinned-enemy", {
    data: { campaignId: fixture.campaignId, enemy: {
      kind: "enemy-template", packId: MECHANICS_STARTER_CATALOG.manifest.packId,
      packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
      definitionId: "velvet:mechanics:enemy-template:gloam-mite",
    } },
  });
  expect(enemy.status()).toBe(204);
  const candidates = await json<{ actors: Array<{ label: string }>; enemies: Array<{ label: string }> }>(
    request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/encounter-setup-candidates`,
  );
  expect(candidates.enemies.length).toBeGreaterThan(0);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Campaigns", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Open campaign ${fixture.campaignName}` }).click();
  await page.getByRole("button", { name: "Open advanced setup" }).click();
  await page.getByRole("button", { name: "Open combat tracker" }).click();
  await expect(page.getByRole("heading", { name: "Encounter lifecycle" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Generate an encounter draft" })).toBeVisible();

  const generation = page.locator(".encounter-generation");
  await page.locator(".encounter-setup").getByRole("checkbox", { name: candidates.actors[0]!.label }).check();
  await generation.getByRole("checkbox", { name: candidates.enemies[0]!.label }).check();
  await generation.getByLabel("Brief").fill("Guard the fogbound bridge");
  await generation.getByLabel("Visible location").fill("Bridge");
  await generation.getByLabel("Tone").fill("tense");
  await generation.getByRole("button", { name: "Generate reviewed draft" }).click();
  await expect(page.getByText(/Review draft /)).toBeVisible();
  await expect(page.getByText("Generated Bridge Ambush")).toBeVisible();
  await page.getByRole("button", { name: "Apply exact draft" }).click();
  await expect(page.getByText(/Encounter applied at /)).toBeVisible();

  const encounters = await json<{ encounters: Array<{ name: string }> }>(request, "GET", `/rpg/v1/campaigns/${fixture.campaignId}/encounters`);
  expect(encounters.encounters).toContainEqual(expect.objectContaining({ name: "Generated Bridge Ambush" }));
});
