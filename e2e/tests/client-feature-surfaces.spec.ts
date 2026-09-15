import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { SRD_5_1_STARTER_ID } from "@velvet/contracts";
import { SRD_5_1_STARTER_CATALOG } from "../../server/src/repo/index.js";

const runId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function json<T>(request: APIRequestContext, method: string, path: string, data: unknown, status: number): Promise<T> {
  const response = await request.fetch(`/api${path}`, { method, data });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(status);
  return response.json() as Promise<T>;
}

function srdReference(definitionId: string) {
  const definition = SRD_5_1_STARTER_CATALOG.definitions.find((candidate) => candidate.reference.definitionId === definitionId);
  if (!definition) throw new Error(`missing SRD definition ${definitionId}`);
  return definition.reference;
}

interface SrdCampaignFixture {
  campaignName: string;
  campaignId: string;
  actorId: string;
  characterId: string;
  sessionId: string;
}

/**
 * Publishes the SRD 5.1 starter, finalizes one durable Fighter, attaches an
 * active room, and publishes the campaign through the real HTTP boundary.
 */
async function setupSrdCampaign(request: APIRequestContext, label: string): Promise<SrdCampaignFixture> {
  const persona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-${label}-Actor`, age: 30, archetype: "Deterministic explorer",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  }, 201);
  const campaignName = `${runId}-${label}`;
  const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", { name: campaignName }, 201);
  const campaignId = campaign.campaign.id;
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/mechanics-starter-setup`, { starterId: SRD_5_1_STARTER_ID }, 200);

  const scores = { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 };
  const draft = await json<{ draft: { id: string; revision: number } }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts`, {
    personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${runId}-${label}-draft`,
  }, 201);
  const selected = await json<{ draft: { revision: number } }>(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}`, {
    expectedRevision: draft.draft.revision, idempotencyKey: `${runId}-${label}-select`,
    selections: {
      race: { ...srdReference("srd-5.1:race:human"), kind: "race" as const },
      background: { ...srdReference("srd-5.1:background:acolyte"), kind: "background" as const },
      class: { ...srdReference("srd-5.1:class:fighter"), kind: "class" as const },
      starterGrant: "kit",
    },
  }, 200);
  const finalized = await json<{ character: { id: string } }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}/finalize`, {
    expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-${label}-finalize`,
  }, 201);
  const actor = await json<{ actorId: string }>(request, "GET", `/__e2e/campaigns/${campaignId}/characters/${finalized.character.id}/actor`, undefined, 200);
  const session = await json<{ id: string }>(request, "POST", "/sessions", { characterId: persona.id, title: `${runId}-${label}-Room` }, 201);
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/rooms`, { sessionId: session.id }, 200);
  const administration = await json<{ campaign: { revision: number } }>(request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`, undefined, 200);
  await json(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/administration`, {
    expectedRevision: administration.campaign.revision, idempotencyKey: `${runId}-${label}-publish`, status: "published",
  }, 200);
  // An attached room starts in setup; one ordinary message moves it to active.
  await json(request, "POST", `/sessions/${session.id}/messages`, { content: "Open the deterministic scene." }, 200);
  return { campaignName, campaignId, actorId: actor.actorId, characterId: finalized.character.id, sessionId: session.id };
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

test("character sheet attunes and drops a held SRD magic item from the browser", async ({ page, request }) => {
  const fixture = await setupSrdCampaign(request, "Attunement");
  const materialized = await request.post("/api/__e2e/materialize-inventory-entry", {
    data: { campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0,
      entryId: `${runId}-ring`, item: srdReference("srd-5.1:item:ring-of-protection") },
  });
  expect(materialized.status(), await materialized.text()).toBe(204);

  await openRoom(page, fixture.campaignName);
  await openCharacterTools(page);

  const panel = page.getByRole("region", { name: "Magic-item attunement" });
  await expect(panel.getByText("Ring of Protection")).toBeVisible();
  await expect(panel.getByText("0 / 3")).toBeVisible();

  // The Ring of Protection requires a completed short rest; without one the
  // engine rejects the command and the panel surfaces the exact code.
  await panel.getByRole("button", { name: "Attune" }).click();
  await expect(panel.getByRole("status")).toContainText("Attunement rejected: prerequisite-missing.");

  await panel.getByLabel("Completed rest").selectOption("short-rest");
  await panel.getByRole("button", { name: "Attune" }).click();
  await expect(panel.getByText("srd-5.1:item:ring-of-protection")).toBeVisible();
  await expect(panel.getByText("1 / 3")).toBeVisible();

  await panel.getByRole("button", { name: "Drop attunement" }).click();
  await expect(panel.getByText("No items are attuned.")).toBeVisible();
});

test("DM encounter builder panel plans an encounter from the browser", async ({ page, request }) => {
  const fixture = await setupSrdCampaign(request, "EncounterBuilder");
  const pinned = await request.post("/api/__e2e/materialize-pinned-enemy", {
    data: { campaignId: fixture.campaignId, enemy: srdReference("srd-5.1:enemy-template:goblin") },
  });
  expect(pinned.status(), await pinned.text()).toBe(204);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Campaigns", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Open campaign ${fixture.campaignName}` }).click();
  await page.getByRole("button", { name: "Manage workspace" }).click();

  const panel = page.getByRole("region", { name: "Encounter builder" });
  await expect(panel.getByRole("heading", { name: "Encounter builder" })).toBeVisible();
  await panel.getByLabel("Party levels (comma separated)").fill("3, 3");
  await panel.getByLabel("Target difficulty").selectOption("medium");
  await panel.getByRole("button", { name: "Plan encounter" }).click();

  await expect(panel.getByText(/Resulting difficulty/)).toBeVisible();
  await expect(panel.getByText(/Target \d+ XP/)).toBeVisible();
});

test("character sheet shows recorded advancement choices from the browser", async ({ page, request }) => {
  const fixture = await setupSrdCampaign(request, "Advancement");

  // The advancement panel is mounted on the full character sheet, which the
  // campaign roster opens directly for a mechanics-enabled campaign.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Campaigns", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Open campaign ${fixture.campaignName}` }).click();
  await page.getByRole("button", { name: `Open ${runId}-Advancement-Actor` }).click();

  const panel = page.getByRole("region", { name: "Feats, subclass & advancement" });
  await expect(panel.getByRole("heading", { name: "Feats, subclass & advancement" })).toBeVisible();
  await expect(panel.getByText("Human race")).toBeVisible();
  await expect(panel.getByText("Acolyte background")).toBeVisible();
  await expect(panel.getByText("Fighter class")).toBeVisible();
});
