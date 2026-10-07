import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MECHANICS_STARTER_CATALOG } from "../../server/src/repo/index.js";

const runId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function json<T>(request: APIRequestContext, method: string, path: string, data?: unknown, status?: number): Promise<T> {
  const response = await request.fetch(`/api${path}`, { method, data });
  expect(response.status(), `${method} ${path}`).toBe(status ?? (method === "POST" ? 201 : 200));
  return response.json() as Promise<T>;
}

async function actorForCampaignCharacter(request: APIRequestContext, campaignId: string, characterId: string): Promise<string> {
  const actor = await json<{ actorId: string }>(
    request, "GET", `/__e2e/campaigns/${campaignId}/characters/${characterId}/actor`,
  );
  return actor.actorId;
}

type PublicReceipt = {
  kind: "journey";
  status: "completed" | "interrupted";
  origin: string;
  destination: string;
  currentLocation: string;
  legs: number;
  elapsedMinutes: number;
  interruption: { kind: string; summary: string } | null;
  revisionBefore: number;
  revisionAfter: number;
  occurredAt: string;
};

type CampaignWorld = {
  currentLocations: Array<{ actorId: string; locationId: string }>;
  visibleConnections: Array<{ fromLocationId: string; toLocationId: string }>;
};

type JourneySetup = {
  campaignId: string;
  actorId: string;
  roomId: string;
  originLocationId: string;
  intermediateLocationId: string;
  actualFinalLocationId: string;
  finalConnectionId: string;
  originName: string;
  intermediateName: string;
  finalName: string;
};

/** Mirrors the M5.4 API setup: starter catalog, published campaign, durable actor, attached active room. */
async function setupJourney(request: APIRequestContext, label: string): Promise<JourneySetup> {
  const fixture = MECHANICS_STARTER_CATALOG;
  const pin = { packId: fixture.manifest.packId, packVersion: fixture.manifest.packVersion };
  const persona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-${label}-Traveler`, age: 30, archetype: "Wayfinder",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  await json(request, "POST", "/rpg/v1/content-packs", fixture);
  const campaign = await json<{ campaign: { id: string } }>(
    request, "POST", "/rpg/v1/campaigns", { name: `${runId}-${label}-Travel` },
  );
  const campaignId = campaign.campaign.id;
  const administration = await json<{ campaign: { revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`,
  );
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/content`, {
    rulesProfileId: fixture.manifest.compatibility.rulesProfileId, contentPacks: [pin],
    expectedRevision: administration.campaign.revision, idempotencyKey: `${runId}-${label}-configure`,
  });
  const configured = await json<{ campaign: { revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`,
  );
  await json(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/administration`, {
    expectedRevision: configured.campaign.revision, idempotencyKey: `${runId}-${label}-publish`, status: "published",
  });
  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const draft = await json<{ draft: { id: string; revision: number } }>(
    request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts`, {
      personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores },
      idempotencyKey: `${runId}-${label}-draft`,
    },
  );
  const reference = (kind: "race" | "background" | "class") =>
    fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
  const selected = await json<{ draft: { revision: number } }>(
    request, "PATCH", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}`, {
      expectedRevision: draft.draft.revision, idempotencyKey: `${runId}-${label}-select`,
      selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
    },
  );
  const finalized = await json<{ character: { id: string } }>(
    request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}/finalize`, {
      expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-${label}-finalize`,
    }, 201,
  );
  const actorId = await actorForCampaignCharacter(request, campaignId, finalized.character.id);
  const room = await json<{ id: string }>(request, "POST", "/sessions", {
    characterId: persona.id, title: `${runId}-${label}-Room`,
  });
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/rooms`, { sessionId: room.id });
  return {
    campaignId, actorId, roomId: room.id,
    originLocationId: `${runId}-${label}-origin`,
    intermediateLocationId: `${runId}-${label}-waystation`,
    actualFinalLocationId: `${runId}-${label}-harbor`,
    finalConnectionId: `${runId}-${label}-trail`,
    originName: `${runId}-${label}-Old-Gate`,
    intermediateName: `${runId}-${label}-Waystation`,
    finalName: `${runId}-${label}-Silver-Harbor`,
  };
}

function journeyFixtureBody(setup: JourneySetup, riskyFinalLeg: boolean) {
  return {
    campaignId: setup.campaignId, sessionId: setup.roomId, actorId: setup.actorId,
    originLocationId: setup.originLocationId, destinationLocationId: setup.intermediateLocationId,
    connectionId: `${setup.originLocationId}-road`, originName: setup.originName, destinationName: setup.intermediateName,
    finalLocationId: setup.actualFinalLocationId, finalName: setup.finalName,
    finalConnectionId: setup.finalConnectionId, riskyFinalLeg,
  };
}

async function openJourneyRoom(page: Page, campaignName: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Campaigns & worlds", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Open campaign ${campaignName}` }).click();
  await page.getByRole("button", { name: "Open advanced setup" }).click();
  await page.getByRole("button", { name: "Open attached room 1 of 1" }).click();
  await expect(page.getByLabel("What do you do?")).toBeVisible();
}

async function assertIndirectOffer(page: Page, finalName: string) {
  await page.getByRole("tab", { name: "Map", exact: true }).click();
  await page.getByText("World routes and travel", { exact: true }).click();
  await expect(page.getByRole("img", { name: /Known routes/ })).toBeVisible();
  const destinations = page.getByRole("region", { name: "Reachable destinations" });
  await expect(destinations.getByRole("button", { name: `Prefill travel to ${finalName}` })).toBeVisible();
  await expect(destinations.getByText("2 legs")).toBeVisible();
  await page.getByRole("tab", { name: "Story", exact: true }).click();
}

async function submitDeclaration(page: Page, declaration: string) {
  const request = page.waitForRequest((candidate) =>
    candidate.method() === "POST" && new URL(candidate.url()).pathname === "/api/rpg/v1/adventure-turns/stream");
  await page.getByLabel("What do you do?").fill(declaration);
  await page.getByRole("button", { name: "Send action" }).click();
  const body = (await request).postDataJSON() as { actorId: string; idempotencyKey: string };
  await expect(page.getByLabel("What do you do?")).toBeEnabled({ timeout: 15_000 });
  return body;
}

async function journeyReceipt(request: APIRequestContext, setup: JourneySetup, idempotencyKey: string) {
  const reconciled = await json<{ result: { receipts: Array<{ commandId: string }> } | null }>(
    request, "GET", `/rpg/v1/adventure-turns/reconcile-initial?campaignId=${setup.campaignId}` +
      `&sessionId=${encodeURIComponent(setup.roomId)}&actorId=${setup.actorId}&idempotencyKey=${idempotencyKey}`,
  );
  expect(reconciled.result).not.toBeNull();
  const commandId = reconciled.result!.receipts[0]!.commandId;
  const receipt = await json<{ receipt: PublicReceipt }>(
    request, "GET", `/rpg/v1/campaigns/${setup.campaignId}/commands/${encodeURIComponent(commandId)}/receipt`,
  );
  return receipt.receipt;
}

async function providerExactTravelSelections(request: APIRequestContext): Promise<number> {
  const stats = await (await request.get("http://127.0.0.1:18788/stats")).json() as { exactTravelSelections: number };
  return stats.exactTravelSelections;
}

function assertNoPrivateLeak(page: Page, privateSentinels: readonly string[]) {
  return Promise.all(privateSentinels.map(async (secret) => {
    const visible = await page.locator("body").innerText();
    expect(visible, `visible state leaked ${secret}`).not.toContain(secret);
    const storage = await page.evaluate(() => ({
      local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage),
    }));
    expect(storage.local).not.toContain(secret);
    expect(storage.session).not.toContain(secret);
  }));
}

test("JourneyTravel completes an indirect two-leg journey through the composer and survives reload", async ({ page, request }) => {
  const label = "safe";
  const setup = await setupJourney(request, label);
  const body = journeyFixtureBody(setup, false);
  expect((await request.post("/api/__e2e/materialize-journey-prerequisite", { data: body })).status()).toBe(204);
  // Exact-compatible replay: a second identical request is a no-op, not an overwrite.
  expect((await request.post("/api/__e2e/materialize-journey-prerequisite", { data: body })).status()).toBe(204);

  await page.setViewportSize({ width: 1366, height: 768 });
  await openJourneyRoom(page, `${runId}-${label}-Travel`);
  await assertIndirectOffer(page, setup.finalName);

  const selectionsBefore = await providerExactTravelSelections(request);
  const submitted = await submitDeclaration(page, `Travel to ${setup.finalName}.`);
  const region = page.getByRole("region", { name: "Committed mechanics" });
  await expect(region.getByText(`Travel → ${setup.finalName}`, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(region.getByText(`Travel → ${setup.finalName}`, { exact: true })).toHaveCount(1);

  const receipt = await journeyReceipt(request, setup, submitted.idempotencyKey);
  expect(receipt).toMatchObject({
    kind: "journey", status: "completed", origin: setup.originName, destination: setup.finalName,
    currentLocation: setup.finalName, legs: 2, elapsedMinutes: 120, interruption: null,
  });
  // The composer declaration was resolved by the parent orchestrator, not the
  // provider exact-travel lane.
  expect(await providerExactTravelSelections(request)).toBe(selectionsBefore);

  const world = await json<CampaignWorld>(request, "GET", `/rpg/v1/campaigns/${setup.campaignId}/world`);
  expect(world.currentLocations).toEqual([expect.objectContaining({ actorId: setup.actorId, locationId: setup.actualFinalLocationId })]);
  // Only the two authored legs exist; there is no direct origin -> final shortcut.
  expect(world.visibleConnections).not.toContainEqual(expect.objectContaining({
    fromLocationId: setup.originLocationId, toLocationId: setup.actualFinalLocationId,
  }));
  await assertNoPrivateLeak(page, [
    setup.originLocationId, setup.intermediateLocationId, setup.actualFinalLocationId,
    `${setup.originLocationId}-road`, setup.finalConnectionId,
  ]);

  await page.reload();
  await expect(page.getByRole("region", { name: "Committed mechanics" })
    .getByText(`Travel → ${setup.finalName}`, { exact: true })).toBeVisible({ timeout: 15_000 });
  await assertNoPrivateLeak(page, [setup.actualFinalLocationId, setup.finalConnectionId]);
});

test("JourneyTravel interrupts a 100% risky final leg, resumes on continue, and survives reload", async ({ page, request }) => {
  const label = "risky";
  const setup = await setupJourney(request, label);
  const body = journeyFixtureBody(setup, true);
  expect((await request.post("/api/__e2e/materialize-journey-prerequisite", { data: body })).status()).toBe(204);

  await page.setViewportSize({ width: 1366, height: 768 });
  await openJourneyRoom(page, `${runId}-${label}-Travel`);
  await assertIndirectOffer(page, setup.finalName);

  const selectionsBefore = await providerExactTravelSelections(request);
  const first = await submitDeclaration(page, `Travel to ${setup.finalName}.`);
  const interruptedLine = `Travel interrupted at ${setup.intermediateName}`;
  await expect(page.getByRole("region", { name: "Committed mechanics" })
    .getByText(interruptedLine, { exact: true })).toBeVisible({ timeout: 15_000 });
  const interrupted = await journeyReceipt(request, setup, first.idempotencyKey);
  expect(interrupted).toMatchObject({
    kind: "journey", status: "interrupted", origin: setup.originName, destination: setup.finalName,
    currentLocation: setup.intermediateName, legs: 1, elapsedMinutes: 60,
    interruption: { kind: "weather", summary: expect.stringContaining("squall") },
  });
  const stoppedWorld = await json<CampaignWorld>(request, "GET", `/rpg/v1/campaigns/${setup.campaignId}/world`);
  expect(stoppedWorld.currentLocations).toEqual([expect.objectContaining({ actorId: setup.actorId, locationId: setup.intermediateLocationId })]);

  await page.reload();
  await expect(page.getByRole("region", { name: "Committed mechanics" })
    .getByText(interruptedLine, { exact: true })).toBeVisible({ timeout: 15_000 });

  const second = await submitDeclaration(page, "Continue journey");
  await expect(page.getByRole("region", { name: "Committed mechanics" })
    .getByText(`Travel → ${setup.finalName}`, { exact: true })).toBeVisible({ timeout: 15_000 });
  const resumed = await journeyReceipt(request, setup, second.idempotencyKey);
  expect(resumed).toMatchObject({
    kind: "journey", status: "completed", origin: setup.intermediateName, destination: setup.finalName,
    currentLocation: setup.finalName, legs: 1, elapsedMinutes: 60, interruption: null,
  });
  // Both the interruption and the continuation were parent-resolved journeys.
  expect(await providerExactTravelSelections(request)).toBe(selectionsBefore);

  const finalWorld = await json<CampaignWorld>(request, "GET", `/rpg/v1/campaigns/${setup.campaignId}/world`);
  expect(finalWorld.currentLocations).toEqual([expect.objectContaining({ actorId: setup.actorId, locationId: setup.actualFinalLocationId })]);

  await page.reload();
  await expect(page.getByRole("region", { name: "Committed mechanics" })
    .getByText(`Travel → ${setup.finalName}`, { exact: true })).toBeVisible({ timeout: 15_000 });
  await assertNoPrivateLeak(page, [setup.actualFinalLocationId, setup.finalConnectionId]);
});
