import { expect, test, type APIRequestContext } from "@playwright/test";
import { MECHANICS_STARTER_CATALOG } from "../../server/src/repo/index.js";

const runId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function json<T>(request: APIRequestContext, method: string, path: string, data?: unknown, status?: number): Promise<T> {
  const response = await request.fetch(`/api${path}`, { method, data });
  expect(response.status(), `${method} ${path}`).toBe(status ?? (method === "POST" ? 201 : 200));
  return response.json() as Promise<T>;
}

async function stream(request: APIRequestContext, sessionId: string, content: string, speakerCharacterId?: string) {
  const response = await request.post(`/api/sessions/${sessionId}/stream`, { data: { content, speakerCharacterId, generationId: `${runId}-stream` } });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/event-stream");
  const events = (await response.body()).toString("utf8").split("\n\n").flatMap((block) => {
    const event = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });
  return events;
}

test("M2.5 content catalog API flow publishes, configures, and replays an exact pin", async ({ request }) => {
  const fixture = MECHANICS_STARTER_CATALOG;
  const pin = {
    packId: fixture.manifest.packId,
    packVersion: fixture.manifest.packVersion,
  };
  const published = await json<{ catalog: { publication: { packId: string; packVersion: string; digest: string } } }>(
    request, "POST", "/rpg/v1/content-packs", fixture,
  );
  expect(published.catalog.publication).toMatchObject({ ...pin, digest: fixture.manifest.digest });

  const listed = await json<{ publications: Array<{ packId: string; packVersion: string }>; nextCursor: string | null }>(
    request, "GET", "/rpg/v1/content-packs?limit=100",
  );
  expect(listed.publications).toContainEqual(expect.objectContaining(pin));
  expect(listed.nextCursor).toBeNull();

  const detail = await json<{ catalog: { publication: { packId: string; packVersion: string; digest: string } } }>(
    request,
    "GET",
    `/rpg/v1/content-packs/${encodeURIComponent(pin.packId)}/versions/${encodeURIComponent(pin.packVersion)}`,
  );
  expect(detail.catalog.publication).toMatchObject({ ...pin, digest: fixture.manifest.digest });

  const created = await json<{ campaign: { id: string } }>(
    request, "POST", "/rpg/v1/campaigns", { name: `${runId}-Catalog-API-Campaign` },
  );
  const administration = await json<{ campaign: { revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${created.campaign.id}/administration`,
  );
  const configuration = {
    rulesProfileId: fixture.manifest.compatibility.rulesProfileId,
    contentPacks: [pin],
    expectedRevision: administration.campaign.revision,
    idempotencyKey: `${runId}-catalog-pin`,
  };
  const configured = await json<{
    content: { rulesProfileId: string; contentPacks: Array<{ packId: string; packVersion: string }> };
    receipt: { revisionBefore: number; revisionAfter: number; idempotencyKey: string };
  }>(
    request,
    "PUT",
    `/rpg/v1/campaigns/${created.campaign.id}/content`,
    configuration,
  );
  expect(configured).toMatchObject({
    content: { rulesProfileId: fixture.manifest.compatibility.rulesProfileId, contentPacks: [pin] },
    receipt: {
      revisionBefore: administration.campaign.revision,
      revisionAfter: administration.campaign.revision + 1,
      idempotencyKey: configuration.idempotencyKey,
    },
  });

  const replayed = await json<typeof configured>(
    request,
    "PUT",
    `/rpg/v1/campaigns/${created.campaign.id}/content`,
    configuration,
  );
  expect(replayed).toEqual(configured);
});

test("M2.6 durable standard-array draft finalizes, previews progression, and replays exactly", async ({ request }) => {
  const fixture = MECHANICS_STARTER_CATALOG;
  const pin = { packId: fixture.manifest.packId, packVersion: fixture.manifest.packVersion };
  const persona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-M2.6-Legacy-Persona`, age: 30, archetype: "Disciplined scout",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  await json(request, "POST", "/rpg/v1/content-packs", fixture);
  const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", {
    name: `${runId}-M2.6-Draft-Campaign`,
  });
  const administration = await json<{ campaign: { revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaign.campaign.id}/administration`,
  );
  await json(request, "PUT", `/rpg/v1/campaigns/${campaign.campaign.id}/content`, {
    rulesProfileId: fixture.manifest.compatibility.rulesProfileId,
    contentPacks: [pin],
    expectedRevision: administration.campaign.revision,
    idempotencyKey: `${runId}-m2.6-configure`,
  });

  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const created = await json<{
    draft: { id: string; durability: string; revision: number; allocation: { method: string; scores: typeof scores } };
  }>(request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts`, {
    personaId: persona.id,
    durability: "durable",
    allocation: { method: "standard-array", scores },
    idempotencyKey: `${runId}-m2.6-create`,
  });
  expect(created.draft).toMatchObject({ durability: "durable", revision: 0, allocation: { method: "standard-array", scores } });

  const reference = (kind: "race" | "background" | "class") =>
    fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
  const selected = await json<{ draft: { revision: number; completion: { complete: boolean; issues: unknown[] }; derivedPreview: unknown } }>(
    request, "PATCH", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${created.draft.id}`, {
      expectedRevision: created.draft.revision,
      idempotencyKey: `${runId}-m2.6-select`,
      selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
    },
  );
  expect(selected.draft).toMatchObject({ revision: 1, completion: { complete: true, issues: [] } });
  expect(selected.draft.derivedPreview).not.toBeNull();

  const finalization = { expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-m2.6-finalize` };
  const finalized = await json<{
    draft: { id: string; status: string; revision: number; completion: { complete: boolean } };
    receipt: { draftId: string; idempotencyKey: string; revisionBefore: number; revisionAfter: number; campaignCharacterId: string; sheetId: string; actorId: string };
  }>(request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${created.draft.id}/finalize`, finalization, 200);
  expect(finalized).toMatchObject({
    draft: { id: created.draft.id, status: "finalized", revision: 2, completion: { complete: true } },
    receipt: { draftId: created.draft.id, idempotencyKey: finalization.idempotencyKey, revisionBefore: 1, revisionAfter: 2,
      campaignCharacterId: expect.any(String), sheetId: expect.any(String), actorId: expect.any(String) },
  });

  const retried = await json<typeof finalized>(
    request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${created.draft.id}/finalize`, finalization, 200,
  );
  expect(retried).toEqual(finalized);

  const progression = await json<{ progression: { campaignId: string; campaignCharacterId: string; level: number; revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaign.campaign.id}/characters/${finalized.receipt.campaignCharacterId}/progression`,
  );
  const preview = await json<{ preview: { campaignId: string; campaignCharacterId: string; currentLevel: number; eligibleLevel: number; levels: unknown[] } }>(
    request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/characters/${finalized.receipt.campaignCharacterId}/progression/preview`, { selections: [] }, 200,
  );
  expect(preview.preview).toMatchObject({
    campaignId: campaign.campaign.id,
    campaignCharacterId: finalized.receipt.campaignCharacterId,
    currentLevel: progression.progression.level,
    eligibleLevel: progression.progression.level,
    levels: [],
  });
  expect(preview.preview).toHaveProperty("previewRevision");
  expect(preview.preview).toHaveProperty("previewToken");
});

test("critical browser and public API workflows", async ({ page, request }) => {
  const characterIds: string[] = [];
  const sessionIds: string[] = [];
  const loreIds: string[] = [];
  try {
    // This persona becomes campaign-linked and therefore is intentionally not
    // included in legacy character cleanup; the isolated E2E database owns it.
    const starterPersonaName = `${runId}-Starter-Persona`;
    const starterPersona = await json<{ id: string }>(request, "POST", "/characters", {
      name: starterPersonaName, age: 30, archetype: "Quiet pathfinder", boundaries: "Fictional deterministic test only",
      fictionalConfirmed: true,
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Velvet" })).toBeVisible();
    expect(await json<{ ok: boolean }>(request, "GET", "/health")).toEqual({ ok: true });
    await page.getByRole("button", { name: "Campaigns" }).click();
    await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible();
    const campaignName = `${runId}-Campaign`;
    await page.getByLabel("Campaign name").fill(campaignName);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await expect(page.locator(".campaign-card").filter({ hasText: campaignName })).toBeFocused();
    await page.locator(".campaign-card").filter({ hasText: campaignName }).getByRole("button", { name: `Open campaign ${campaignName}` }).click();
    await expect(page.getByRole("heading", { name: campaignName })).toBeVisible();
    const createdCampaigns = await json<{ campaigns: Array<{ id: string; name: string }> }>(request, "GET", "/rpg/v1/campaigns");
    const campaignId = createdCampaigns.campaigns.find((campaign) => campaign.name === campaignName)!.id;
    // Real repository/route/client integration distinguishes authorized empty
    // from the compatibility 404 fallback without widening this E2E workflow.
    await expect(page.getByText("No characters yet.")).toBeVisible();
    await expect(page.getByText("No rooms attached.")).toBeVisible();
    const campaignRoomTitle = `${runId}-Campaign-Room`;
    const campaignRoom = await json<{ id: string }>(request, "POST", "/sessions", { characterId: starterPersona.id, title: campaignRoomTitle });
    sessionIds.push(campaignRoom.id);
    await page.getByRole("button", { name: "Refresh rooms" }).first().click();
    await expect(page.getByRole("button", { name: "Attach eligible room 1 of 1" })).toBeVisible();
    const roomRequests: string[] = [];
    page.on("request", (browserRequest) => {
      if (/\/api\/rpg\/v1\/campaigns\/[^/]+\/rooms$/.test(browserRequest.url())) roomRequests.push(browserRequest.method());
    });
    await page.getByRole("button", { name: "Attach eligible room 1 of 1" }).click();
    await expect(page.getByText("Room attached. Latest campaign rooms were refreshed.")).toBeVisible();
    expect(roomRequests).toEqual(["PUT", "GET"]);
    const roomHtml = await page.locator(".campaign-rooms").evaluate((element) => element.outerHTML);
    expect(roomHtml).not.toContain(campaignRoom.id);
    await page.getByRole("button", { name: "Open attached room 1 of 1" }).click();
    await expect(page.getByRole("button", { name: "← Back to campaign" })).toBeVisible();
    await page.getByRole("button", { name: "← Back to campaign" }).click();
    await expect(page.getByRole("heading", { name: "Rooms", exact: true })).toBeFocused();
    expect(roomRequests).toEqual(["PUT", "GET", "GET"]);
    await page.getByRole("button", { name: "Open attached room 1 of 1" }).click();
    await page.reload();
    await expect(page.getByRole("heading", { name: campaignRoomTitle })).toBeVisible();
    await expect(page.getByRole("button", { name: "← Back to campaign" })).toBeVisible();
    await page.getByRole("button", { name: "← Back to campaign" }).click();
    await expect(page.getByRole("heading", { name: "Rooms", exact: true })).toBeFocused();
    expect(roomRequests).toEqual(["PUT", "GET", "GET", "GET"]);
    await json(request, "POST", `/sessions/${campaignRoom.id}/stop`, undefined, 200);
    await page.getByRole("button", { name: "Refresh rooms" }).first().click();
    await expect(page.getByText(/Stopped · Read-only/)).toBeVisible();
    await page.getByRole("button", { name: "Open attached room 1 of 1" }).click();
    await expect(page.getByText(/no longer writable/)).toBeVisible();
    await page.getByRole("button", { name: "← Back to campaign" }).click();
    const stoppedCandidate = await json<{ id: string }>(request, "POST", "/sessions", { characterId: starterPersona.id, title: `${runId}-Stopped-Candidate` });
    sessionIds.push(stoppedCandidate.id);
    await json(request, "POST", `/sessions/${stoppedCandidate.id}/stop`, undefined, 200);
    const stoppedAttach = await request.put(`/api/rpg/v1/campaigns/${campaignId}/rooms`, { data: { sessionId: stoppedCandidate.id } });
    expect(stoppedAttach.status()).toBe(409);
    await json(request, "DELETE", `/sessions/${campaignRoom.id}`);
    sessionIds.splice(sessionIds.indexOf(campaignRoom.id), 1);
    await page.getByRole("button", { name: "Refresh rooms" }).first().click();
    await expect(page.getByText("No rooms attached.")).toBeVisible();
    // Keep an eligible row stale in the browser, attach it externally to a
    // second campaign, then prove the UI performs one PUT and one authoritative
    // reconciliation GET without retrying the conflicting write.
    const foreignCampaignName = `${runId}-Foreign-Campaign`;
    const foreignCampaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", { name: foreignCampaignName });
    const conflictRoom = await json<{ id: string }>(request, "POST", "/sessions", { characterId: starterPersona.id, title: `${runId}-Conflict-Room` });
    sessionIds.push(conflictRoom.id);
    await page.getByRole("button", { name: "Refresh rooms" }).first().click();
    await expect(page.getByRole("button", { name: "Attach eligible room 1 of 1" })).toBeVisible();
    await json(request, "PUT", `/rpg/v1/campaigns/${foreignCampaign.campaign.id}/rooms`, { sessionId: conflictRoom.id });
    const conflictRequests: string[] = [];
    page.on("request", (browserRequest) => {
      if (browserRequest.url().endsWith(`/api/rpg/v1/campaigns/${campaignId}/rooms`)) conflictRequests.push(browserRequest.method());
    });
    await page.getByRole("button", { name: "Attach eligible room 1 of 1" }).click();
    await expect(page.getByText("The room could not be attached because its status conflicts with this campaign. Latest rooms are shown; the PUT was not repeated.")).toBeVisible();
    expect(conflictRequests).toEqual(["PUT", "GET"]);
    await expect(page.getByRole("button", { name: "Attach eligible room 1 of 1" })).toHaveCount(0);
    // Browser-real commit ambiguity: let the actual Fastify/SQLite PUT commit,
    // then abort delivery of its response. The UI must not retry the write and
    // must reconcile the newly attached state with exactly one GET.
    const ambiguousRoom = await json<{ id: string }>(request, "POST", "/sessions", { characterId: starterPersona.id, title: `${runId}-Ambiguous-Room` });
    sessionIds.push(ambiguousRoom.id);
    await page.getByRole("button", { name: "Refresh rooms" }).first().click();
    await expect(page.getByRole("button", { name: "Attach eligible room 1 of 1" })).toBeVisible();
    const ambiguousRequests: string[] = [];
    page.on("request", (browserRequest) => {
      if (browserRequest.url().endsWith(`/api/rpg/v1/campaigns/${campaignId}/rooms`)) ambiguousRequests.push(browserRequest.method());
    });
    let committedIntercepts = 0;
    await page.route(`**/api/rpg/v1/campaigns/${campaignId}/rooms`, async (route) => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      committedIntercepts += 1;
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "Attach eligible room 1 of 1" }).click();
    await expect(page.getByText("Latest rooms are shown, but the attachment outcome is unknown. The PUT was not repeated.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open attached room 1 of 1" })).toBeVisible();
    expect(committedIntercepts).toBe(1);
    expect(ambiguousRequests).toEqual(["PUT", "GET"]);
    await expect(page.getByRole("button", { name: /Attach eligible room/ })).toHaveCount(0);
    await page.unroute(`**/api/rpg/v1/campaigns/${campaignId}/rooms`);
    const renamedCampaignName = `${campaignName}-renamed`;
    await page.getByLabel("Campaign name").fill(renamedCampaignName);
    await page.getByRole("button", { name: "Rename campaign" }).click();
    await expect(page.getByRole("heading", { name: renamedCampaignName })).toBeVisible();
    await expect(page.getByText(`Campaign renamed to “${renamedCampaignName}”.`)).toBeAttached();
    await expect(page.getByRole("button", { name: "Set up original starter" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /metadata-only setup is final/i }).check();
    await page.getByRole("button", { name: "Set up original starter" }).click();
    await expect(page.getByText(/Original starter setup is complete/i)).toBeAttached();
    await expect(page.getByText("velvet:rules:original-narrative").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up original starter" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Finalize a character record" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("checkbox", { name: "I confirm this record is finalized and currently has NO derived stats, rules validation, editing, deletion, rebuilding or reset, gameplay or mechanics, inventory, equipment, spells, powers, progression, or AI workflow." })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    const createPosts: string[] = [];
    page.on("request", (browserRequest) => {
      if (browserRequest.method() === "POST" && /\/api\/rpg\/v1\/campaigns\/[^/]+\/characters$/.test(browserRequest.url())) {
        createPosts.push(browserRequest.url());
      }
    });
    await page.getByLabel("Character creation").getByText(starterPersonaName, { exact: true }).click();
    await page.getByRole("checkbox", { name: /currently has NO derived stats/i }).check();
    await page.getByRole("button", { name: "Finalize character record" }).click();
    await expect(page.getByText(/created and confirmed by the latest character status/i)).toBeVisible();
    expect(createPosts).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole("heading", { name: renamedCampaignName })).toBeVisible();
    await expect(page.getByText("velvet:rules:original-narrative").first()).toBeVisible();
    await expect(page.getByText(/Content configuration is read-only/i)).toBeVisible();
    await expect(page.getByRole("list", { name: "Campaign characters" }).getByText(starterPersonaName, { exact: true })).toBeVisible();
    await expect(page.getByText("Already used — not selectable")).toBeVisible();
    expect(createPosts).toHaveLength(1);
    const diceRequests: Array<{ method: string; url: string }> = [];
    page.on("request", (browserRequest) => {
      if (/\/api\/rpg\/v1\/campaigns\/[^/]+\/dice-rolls$/.test(browserRequest.url())) {
        diceRequests.push({ method: browserRequest.method(), url: browserRequest.url() });
      }
    });
    await page.getByLabel("Character", { exact: true }).selectOption("1");
    await page.getByLabel("Expression").fill("1d2+3");
    await page.getByRole("button", { name: "Roll dice" }).click();
    await expect(page.getByText("The server confirmed the roll was committed. Latest roll history was refreshed.")).toBeVisible();
    const latestRoll = page.getByRole("list", { name: "Recent dice rolls" }).getByRole("listitem").first();
    await expect(latestRoll.getByText("1d2+3", { exact: true })).toBeVisible();
    await expect(latestRoll.getByText("2 (kept)", { exact: true })).toBeVisible();
    await expect(latestRoll.getByText("+3", { exact: true })).toBeVisible();
    await expect(latestRoll.getByText("5", { exact: true })).toBeVisible();
    const exactRenderedRoll = await latestRoll.innerText();
    expect(diceRequests.map((entry) => entry.method)).toEqual(["POST", "GET"]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect((await page.getByRole("button", { name: "Roll dice" }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload();
    await expect(page.getByRole("heading", { name: renamedCampaignName })).toBeVisible();
    const reloadedRoll = page.getByRole("list", { name: "Recent dice rolls" }).getByRole("listitem").first();
    await expect(reloadedRoll.getByText("1d2+3", { exact: true })).toBeVisible();
    expect(await reloadedRoll.innerText()).toBe(exactRenderedRoll);
    expect(diceRequests.map((entry) => entry.method)).toEqual(["POST", "GET", "GET"]);
    const documentUrl = page.url();
    await page.setViewportSize({ width: 390, height: 844 });
    const openWorkspace = page.getByRole("button", { name: `Open character ${starterPersonaName}, character 1 of 1` });
    expect((await openWorkspace.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await openWorkspace.click();
    const workspaceHeading = page.getByRole("heading", { name: starterPersonaName });
    await expect(workspaceHeading).toBeVisible();
    await expect(workspaceHeading).toBeFocused();
    await expect(page.getByRole("heading", { name: "Attributes" })).toBeVisible();
    await expect(page.getByText("No resources.")).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(1);
    const workspaceBack = page.getByRole("button", { name: "← Back to campaign" });
    expect((await workspaceBack.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const identityCards = page.locator(".workspace-identity > article");
    const firstIdentity = await identityCards.nth(0).boundingBox();
    const secondIdentity = await identityCards.nth(1).boundingBox();
    expect(firstIdentity).not.toBeNull();
    expect(secondIdentity).not.toBeNull();
    expect(Math.abs(secondIdentity!.x - firstIdentity!.x)).toBeLessThan(1);
    expect(secondIdentity!.y).toBeGreaterThanOrEqual(firstIdentity!.y + firstIdentity!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await page.locator(".workspace-page bdi").first().evaluate((element) => getComputedStyle(element).overflowWrap)).toBe("anywhere");
    expect(page.url()).toBe(documentUrl);
    const workspaceHtml = await page.locator("body").evaluate((body) => body.outerHTML);
    const storedWorkspace = await page.evaluate(() => JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}") as { campaignId: string; campaignCharacterId: string });
    expect(workspaceHtml).not.toContain(storedWorkspace.campaignId);
    expect(workspaceHtml).not.toContain(storedWorkspace.campaignCharacterId);
    await page.reload();
    await expect(page.getByRole("heading", { name: starterPersonaName })).toBeVisible();
    expect(page.url()).toBe(documentUrl);
    await page.getByRole("button", { name: "← Back to campaign" }).click();
    const returnedCampaignHeading = page.getByRole("heading", { name: renamedCampaignName });
    await expect(returnedCampaignHeading).toBeVisible();
    await expect(returnedCampaignHeading).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 720 });
    const campaigns = await json<{ campaigns: Array<{ name: string; actorRole: string }> }>(request, "GET", "/rpg/v1/campaigns");
    expect(campaigns.campaigns).toContainEqual(expect.objectContaining({ name: renamedCampaignName, actorRole: "owner" }));
    const mechanicsCampaignName = `${runId}-Mechanics-Campaign`;
    const mechanicsCampaign = await json<{ campaign: { id: string } }>(
      request, "POST", "/rpg/v1/campaigns", { name: mechanicsCampaignName },
    );
    await page.getByRole("button", { name: "← Campaigns" }).click();
    await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible();
    await expect(page.getByRole("button", { name: `Open campaign ${renamedCampaignName}` })).toBeVisible();
    await page.getByRole("button", { name: `Open campaign ${mechanicsCampaignName}` }).click();
    await expect(page.getByRole("heading", { name: mechanicsCampaignName })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Original metadata starter/i })).toBeChecked();
    await page.getByRole("radio", { name: /Mechanics starter/i }).check();
    await expect(page.getByText(/future builder and progression UI/i)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    const mechanicsSetupRequests: string[] = [];
    page.on("request", (browserRequest) => {
      if (browserRequest.url().endsWith(`/api/rpg/v1/campaigns/${mechanicsCampaign.campaign.id}/mechanics-starter-setup`)) {
        mechanicsSetupRequests.push(browserRequest.method());
      } else if (browserRequest.url().endsWith(`/api/rpg/v1/campaigns/${mechanicsCampaign.campaign.id}`)) {
        mechanicsSetupRequests.push(browserRequest.method());
      }
    });
    await page.getByRole("checkbox", { name: /explicitly confirm mechanics starter activation/i }).check();
    await page.getByRole("button", { name: "Activate mechanics starter" }).click();
    await expect(page.getByText(/Mechanics starter setup is complete/i)).toBeAttached();
    expect(mechanicsSetupRequests).toEqual(["PUT", "GET"]);
    await expect(page.getByText("velvet:rules:starter-v1")).toBeVisible();
    await expect(page.getByText(/Content configuration is read-only/i)).toBeVisible();
    const mechanicsDetail = await json<{ campaign: { content: unknown } }>(
      request, "GET", `/rpg/v1/campaigns/${mechanicsCampaign.campaign.id}`,
    );
    expect(mechanicsDetail.campaign.content).toEqual({
      status: "configured",
      rulesProfileId: "velvet:rules:starter-v1",
      contentPacks: [{ packId: "velvet:mechanics-starter", packVersion: "1.1.0+2f9199b5696d" }],
    });
    await page.getByRole("button", { name: "← Campaigns" }).click();
    await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible();
    await page.getByRole("button", { name: "← Character library" }).click();
    await expect(page.getByRole("heading", { name: "Characters" })).toBeVisible();

    const provider = await json<Record<string, unknown>>(request, "GET", "/provider");
    expect(provider.hasApiKey).toBe(true);
    expect(provider).not.toHaveProperty("apiKey");
    expect(JSON.stringify(provider)).not.toContain("local-e2e-placeholder");
    const promptTemplates = await json<{ templates: Array<{ id: string; overridden: boolean }> }>(request, "GET", "/prompt-templates");
    expect(promptTemplates.templates.length).toBeGreaterThan(10);
    const overriddenTemplates = await json<{ templates: Array<{ id: string; overridden: boolean }> }>(request, "PUT", "/prompt-templates/character.style", { template: "E2E STYLE {{style.guide}}" });
    expect(overriddenTemplates.templates.find((template) => template.id === "character.style")?.overridden).toBe(true);
    await json(request, "PUT", "/prompt-templates/character.style", { template: null });

    const firstName = `${runId}-Aria`;
    const editedName = `${firstName}-edited`;
    await page.getByRole("button", { name: "New character" }).click();
    await page.getByLabel("Character name").fill(firstName);
    await page.getByLabel("Age (18+)").fill("31");
    await page.getByLabel("Archetype / vibe").selectOption({ label: "Warm conversationalist" });
    await page.getByLabel("Boundaries & hard limits").fill("Keep the test concise and fictional.");
    await page.getByText("I confirm this character is entirely fictional").click();
    await page.getByRole("button", { name: "Save to library" }).click();
    await expect(page.getByText(firstName, { exact: true })).toBeVisible();

    const firstCard = page.locator(".character-card").filter({ hasText: firstName });
    await firstCard.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Character name").fill(editedName);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(editedName, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(editedName, { exact: true })).toBeVisible();

    const listed = await json<{ characters: Array<{ id: string; name: string }> }>(request, "GET", "/characters");
    const first = listed.characters.find((character) => character.name === editedName)!;
    characterIds.push(first.id);
    const second = await json<{ id: string }>(request, "POST", "/characters", {
      name: `${runId}-Noor`, age: 32, archetype: "Concise navigator", boundaries: "Fictional test only",
      fictionalConfirmed: true,
    });
    characterIds.push(second.id);

    const memory = await json<{ id: string }>(request, "POST", `/characters/${first.id}/memories`, {
      content: `${runId} pending brass key`, kind: "fact", userApproved: false,
    });
    const editedMemory = await json<{ content: string; kind: string; userApproved: boolean }>(request, "PATCH", `/memories/${memory.id}`, {
      content: `${runId} approved silver key`, kind: "event", userApproved: true,
    });
    expect(editedMemory).toMatchObject({ content: `${runId} approved silver key`, kind: "event", userApproved: true });
    const forgotten = await json<{ forgottenAt: string }>(request, "DELETE", `/memories/${memory.id}`);
    expect(forgotten.forgottenAt).toBeTruthy();
    const restored = await json<{ forgottenAt: null }>(request, "POST", `/memories/${memory.id}/restore`, undefined, 200);
    expect(restored.forgottenAt).toBeNull();

    const globalLore = await json<{ id: string }>(request, "POST", "/lore", { characterIds: [], keys: [], content: `${runId} global sky is violet.` });
    loreIds.push(globalLore.id);
    const updatedGlobalLore = await json<{ content: string }>(request, "PATCH", `/lore/${globalLore.id}`, { content: `${runId} global sky is indigo.` });
    expect(updatedGlobalLore.content).toContain("indigo");
    const scopedLore = await json<{ id: string; characterIds: string[] }>(request, "POST", "/lore", {
      characterIds: [first.id], keys: [`${runId}-gate`], content: `${runId} gate opens at dawn.`,
    });
    loreIds.push(scopedLore.id);
    const updatedLore = await json<{ content: string }>(request, "PATCH", `/lore/${scopedLore.id}`, { content: `${runId} gate opens at noon.` });
    expect(updatedLore.content).toContain("noon");

    const solo = await json<{ id: string; participants: unknown[] }>(request, "POST", "/sessions", { characterId: first.id, title: `${runId}-solo` });
    sessionIds.push(solo.id);
    expect(solo.participants).toHaveLength(1);
    await json(request, "POST", `/sessions/${solo.id}/messages`, { content: `remember that my test marker is ${runId}` }, 200);
    const explicitMemories = await json<{ memories: Array<{ content: string; userApproved: boolean }> }>(request, "GET", `/characters/${first.id}/memories`);
    expect(explicitMemories.memories).toContainEqual(expect.objectContaining({ content: `my test marker is ${runId}`, userApproved: true }));
    const buffered = await json<{ reply: { id: string; content: string; speakerCharacterId: string }; providerError: boolean; loreTriggered: number; messages: unknown[] }>(request, "POST", `/sessions/${solo.id}/messages`, { content: `Open ${runId}-gate briefly.` }, 200);
    expect(buffered.providerError).toBe(false);
    expect(buffered.reply.content.trim()).not.toBe("");
    expect(buffered.reply.speakerCharacterId).toBe(first.id);
    expect(buffered.loreTriggered).toBeGreaterThanOrEqual(2);

    const events = await stream(request, solo.id, "Reply in one short sentence.", first.id);
    expect(events.map((event) => event.event).slice(0, 2)).toEqual(["user_message", "state"]);
    expect(events.some((event) => event.event === "delta")).toBe(true);
    expect(events.at(-1)?.event).toBe("done");
    const streamReply = events.at(-1)?.data.reply as { content: string; speakerCharacterId: string };
    expect(streamReply.content.trim()).not.toBe("");
    expect(streamReply.speakerCharacterId).toBe(first.id);

    const resumed = await json<{ messages: Array<{ id: string; content: string }> }>(request, "GET", `/sessions/${solo.id}`);
    expect(resumed.messages.some((message) => message.id === buffered.reply.id)).toBe(true);
    expect(resumed.messages.some((message) => message.content === streamReply.content)).toBe(true);

    const group = await json<{ id: string; primaryCharacterId: string; participants: unknown[] }>(request, "POST", "/sessions", {
      characterIds: [first.id, second.id], primaryCharacterId: first.id, title: `${runId}-group`,
    });
    sessionIds.push(group.id);
    expect(group.participants).toHaveLength(2);
    const privateFirst = await json<{ session: { id: string }; messages: unknown[]; created: boolean }>(request, "POST", "/sessions/solo", { characterId: second.id }, 200);
    sessionIds.push(privateFirst.session.id);
    expect(privateFirst.created).toBe(true);
    const privateAgain = await json<{ session: { id: string }; created: boolean }>(request, "POST", "/sessions/solo", { characterId: second.id }, 200);
    expect(privateAgain).toMatchObject({ session: { id: privateFirst.session.id }, created: false });
    await page.reload();
    await page.locator(".session-open").filter({ hasText: `${runId}-group` }).click();
    await page.getByLabel("Target speaker").selectOption(second.id);
    await page.getByRole("button", { name: `Private chat with ${runId}-Noor` }).click();
    await expect(page.getByRole("heading", { name: `${runId}-Noor` })).toBeVisible();
    await page.getByRole("button", { name: "Prompt & settings" }).click();
    await expect(page.getByRole("separator", { name: "Resize settings pane" })).toBeVisible();
    await expect(page.getByLabel("Underlying prompt layer")).toBeVisible();
    const targeted = await json<{ reply: { speakerCharacterId: string } }>(request, "POST", `/sessions/${group.id}/messages`, {
      content: "Answer with one short sentence.", speakerCharacterId: second.id,
    }, 200);
    expect(targeted.reply.speakerCharacterId).toBe(second.id);
    const continued = await json<{ reply: { content: string; speakerCharacterId: string } }>(request, "POST", `/sessions/${group.id}/continue`, { speakerCharacterId: first.id }, 200);
    expect(continued.reply.content.trim()).not.toBe("");
    expect(continued.reply.speakerCharacterId).toBe(first.id);

    const roomTurn = await json<{ routing: string; selectedSpeakerIds: string[]; replies: Array<{ id: string; parentId: string; speakerCharacterId: string }> }>(request, "POST", `/sessions/${group.id}/room-turn`, {
      content: `${editedName} and ${runId}-Noor, compare your plans.`, maxSpeakers: 2,
    }, 200);
    expect(roomTurn.routing).toBe("fallback");
    expect(roomTurn.selectedSpeakerIds).toEqual([first.id, second.id]);
    expect(roomTurn.replies.map((reply) => reply.speakerCharacterId)).toEqual([first.id, second.id]);
    expect(roomTurn.replies[1]?.parentId).toBe(roomTurn.replies[0]?.id);

    const roomContinuationResponse = await request.post(`/api/sessions/${group.id}/room-continue`, {
      headers: { Accept: "text/event-stream" }, data: { maxSpeakers: 2 },
    });
    expect(roomContinuationResponse.status()).toBe(200);
    const continuationEvents = (await roomContinuationResponse.body()).toString("utf8").split("\n\n").flatMap((block) => {
      const event = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
    });
    expect(continuationEvents.map((entry) => entry.event)).toEqual(["state", "room_reply", "room_reply", "room_done"]);
    const roomContinuation = continuationEvents.at(-1)!.data as unknown as { selectedSpeakerIds: string[]; replies: Array<{ id: string; parentId: string; speakerCharacterId: string }>; messages: Array<{ role: string }> };
    expect(roomContinuation.selectedSpeakerIds[0]).not.toBe(second.id);
    expect(roomContinuation.replies[0]?.parentId).toBe(roomTurn.replies[1]?.id);
    expect(roomContinuation.replies[1]?.parentId).toBe(roomContinuation.replies[0]?.id);
    expect(roomContinuation.messages.slice(-2).every((message) => message.role === "character")).toBe(true);

    await json(request, "POST", `/sessions/${group.id}/room-turn`, { content: "Please remember your characters.", maxSpeakers: 2 }, 200);
    for (const characterId of [first.id, second.id]) {
      const contextual = await json<{ memories: Array<{ content: string; kind: string; userApproved: boolean }> }>(request, "GET", `/characters/${characterId}/memories`);
      expect(contextual.memories.some((entry) => entry.kind === "event" && entry.userApproved && !entry.content.toLowerCase().includes("remember your characters"))).toBe(true);
    }
    await json(request, "PUT", `/sessions/${group.id}/context`, { sourceOfTruth: `${runId}: everyone is gathered beneath the observatory dome.` });
    const sharedContext = await json<{ context: { sourceOfTruth: string; editableSource: string; participants: unknown[]; recentEvents: string[]; rememberedFacts: string[] } }>(request, "GET", `/sessions/${group.id}/context`);
    expect(sharedContext.context.sourceOfTruth).toContain("observatory dome");
    expect(sharedContext.context.editableSource).toContain("observatory dome");
    expect(sharedContext.context.sourceOfTruth).toContain("SYNTHESIZED CURRENT SCENE FACTS");
    expect(sharedContext.context.sourceOfTruth).not.toContain("Please remember your characters.");
    expect(sharedContext.context.participants).toHaveLength(2);
    expect(sharedContext.context.recentEvents.length).toBeGreaterThan(0);
    expect(sharedContext.context.rememberedFacts.length).toBeGreaterThan(0);

    for (const id of [...sessionIds]) {
      await json(request, "DELETE", `/sessions/${id}`);
      sessionIds.splice(sessionIds.indexOf(id), 1);
    }
    for (const id of [...loreIds]) {
      await json(request, "DELETE", `/lore/${id}`);
      loreIds.splice(loreIds.indexOf(id), 1);
    }
    for (const id of [...characterIds]) {
      await json(request, "DELETE", `/characters/${id}`);
      characterIds.splice(characterIds.indexOf(id), 1);
    }
    expect((await request.get(`/api/sessions/${solo.id}`)).status()).toBe(404);
    expect((await request.get(`/api/characters/${first.id}`)).status()).toBe(404);
    // Linked personas are protected from legacy deletion. The isolated E2E
    // database is discarded as a whole, so do not repeatedly attempt cleanup.
    expect((await request.delete(`/api/characters/${starterPersona.id}`)).status()).toBe(409);
  } finally {
    for (const id of sessionIds) await request.delete(`/api/sessions/${id}`).catch(() => undefined);
    for (const id of loreIds) await request.delete(`/api/lore/${id}`).catch(() => undefined);
    for (const id of characterIds) await request.delete(`/api/characters/${id}`).catch(() => undefined);
  }
});

test("campaign administration lifecycle and settings API smoke", async ({ request }) => {
  const campaignName = `${runId}-Administration-Campaign`;
  const created = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", {
    name: campaignName,
  });
  const campaignId = created.campaign.id;

  const administration = await json<{
    campaign: { id: string; status: string; revision: number; settings: { safetyMode: string } };
  }>(request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`);
  expect(administration).toEqual({ campaign: expect.objectContaining({ id: campaignId, status: "draft" }) });

  const patched = await json<{
    campaign: { id: string; status: string; revision: number; settings: { safetyMode: string } };
    receipt: { campaignId: string; revisionBefore: number; revisionAfter: number };
  }>(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/administration`, {
    expectedRevision: administration.campaign.revision,
    idempotencyKey: `${runId}-administration-patch`,
    status: "published",
    settings: { safetyMode: "strict" },
  });
  expect(patched).toEqual({
    campaign: expect.objectContaining({ id: campaignId, status: "published", settings: expect.objectContaining({ safetyMode: "strict" }) }),
    receipt: expect.objectContaining({
      campaignId,
      revisionBefore: administration.campaign.revision,
      revisionAfter: administration.campaign.revision + 1,
    }),
  });

  const archive = {
    expectedRevision: patched.campaign.revision,
    idempotencyKey: `${runId}-administration-archive`,
    confirmationName: campaignName,
  };
  const archived = await json<{
    campaign: { id: string; status: string; revision: number };
    receipt: { commandId: string; campaignId: string; revisionBefore: number; revisionAfter: number };
  }>(request, "DELETE", `/rpg/v1/campaigns/${campaignId}/administration`, archive);
  expect(archived).toEqual({
    campaign: expect.objectContaining({ id: campaignId, status: "archived" }),
    receipt: expect.objectContaining({
      campaignId,
      revisionBefore: patched.campaign.revision,
      revisionAfter: patched.campaign.revision + 1,
    }),
  });
  const archiveRetry = await json<typeof archived>(request, "DELETE", `/rpg/v1/campaigns/${campaignId}/administration`, archive);
  expect(archiveRetry.receipt).toEqual(archived.receipt);

  const confirmationCampaignName = `${runId}-Wrong-Confirmation-Campaign`;
  const confirmationCampaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", {
    name: confirmationCampaignName,
  });
  const confirmationAdministration = await json<{ campaign: { revision: number; status: string } }>(
    request, "GET", `/rpg/v1/campaigns/${confirmationCampaign.campaign.id}/administration`,
  );
  const wrongConfirmation = await request.delete(`/api/rpg/v1/campaigns/${confirmationCampaign.campaign.id}/administration`, {
    data: {
      expectedRevision: confirmationAdministration.campaign.revision,
      idempotencyKey: `${runId}-wrong-confirmation`,
      confirmationName: `${confirmationCampaignName}-wrong`,
    },
  });
  expect(wrongConfirmation.status()).toBe(409);
  const remainsUnarchived = await json<{ campaign: { status: string } }>(
    request, "GET", `/rpg/v1/campaigns/${confirmationCampaign.campaign.id}/administration`,
  );
  expect(remainsUnarchived.campaign.status).not.toBe("archived");
});

test("campaign import dry-run API smoke does not write", async ({ request }) => {
  const created = await json<{ campaign: { id: string; revision: number } }>(request, "POST", "/rpg/v1/campaigns", {
    name: `${runId}-Import-Dry-Run-Campaign`,
  });
  const campaignsBefore = await json<{ campaigns: Array<{ id: string; name: string }> }>(request, "GET", "/rpg/v1/campaigns");
  const administrationBefore = await json<{ campaign: { revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${created.campaign.id}/administration`,
  );
  const sourceTimelineId = `${runId}-import-source-timeline`;
  const packageToImport = {
    formatVersion: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    campaign: {
      name: `${runId}-Imported-Campaign`,
      status: "draft",
      settings: { maxPlayers: 4, allowPlayerDice: true, safetyMode: "standard", recapVisibility: "members", gmNotes: "" },
      administrationRevision: 0,
    },
    timelines: [{ sourceId: sourceTimelineId, parentSourceId: null, forkedFromRevision: null, revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z", events: [] }],
    activeTimelineSourceId: sourceTimelineId,
    content: { status: "unconfigured" },
    records: { actors: [], checkpoints: [], recaps: [], memberships: [], roomAttachments: [], administration: { events: [], receipts: [] } },
    excluded: ["credentials", "localPaths", "usageHistory", "privateActorState"],
  };

  const dryRun = await json<{
    importId: string;
    report: { valid: boolean; conflicts: string[]; missingReferences: string[]; warnings: string[]; counts: { timelines: number } };
  }>(request, "POST", "/rpg/v1/campaign-imports", { package: packageToImport, mode: "dry-run" }, 200);

  expect(dryRun).toMatchObject({
    importId: expect.any(String),
    report: expect.objectContaining({ valid: true, conflicts: [], missingReferences: [], counts: expect.objectContaining({ timelines: 1 }) }),
  });
  expect(await json(request, "GET", "/rpg/v1/campaigns")).toEqual(campaignsBefore);
  expect(await json(request, "GET", `/rpg/v1/campaigns/${created.campaign.id}/administration`)).toEqual(administrationBefore);
});

test("campaign membership and stopped-room administration API smoke", async ({ request }) => {
  const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", {
    name: `${runId}-Membership-Campaign`,
  });
  const campaignId = campaign.campaign.id;
  const principalId = "e2e-membership-principal";

  const initial = await json<{ memberships: Array<{ principalId: string; role: string }> }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/memberships`,
  );
  expect(initial.memberships).toContainEqual(expect.objectContaining({ principalId: "local-owner", role: "owner" }));

  const administration = await json<{ campaign: { revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`,
  );
  const added = await json<{
    membership: { principalId: string; role: string; createdAt: string };
    receipt: { campaignId: string; type: string; revisionBefore: number; revisionAfter: number };
  }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/memberships`, {
    principalId, role: "player", expectedRevision: administration.campaign.revision,
    idempotencyKey: `${runId}-membership-add`,
  }, 200);
  expect(added).toEqual({
    membership: expect.objectContaining({ principalId, role: "player", createdAt: expect.any(String) }),
    receipt: expect.objectContaining({ campaignId, type: "membership_added", revisionBefore: administration.campaign.revision,
      revisionAfter: administration.campaign.revision + 1 }),
  });

  const changed = await json<{
    membership: { principalId: string; role: string };
    receipt: { campaignId: string; type: string; revisionBefore: number; revisionAfter: number };
  }>(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/memberships/${principalId}`, {
    role: "gm", expectedRevision: added.receipt.revisionAfter, idempotencyKey: `${runId}-membership-change`,
  });
  expect(changed).toEqual({
    membership: expect.objectContaining({ principalId, role: "gm" }),
    receipt: expect.objectContaining({ campaignId, type: "membership_role_changed", revisionBefore: added.receipt.revisionAfter,
      revisionAfter: added.receipt.revisionAfter + 1 }),
  });

  const removed = await json<{
    membership: { principalId: string; role: string };
    receipt: { campaignId: string; type: string; revisionBefore: number; revisionAfter: number };
  }>(request, "DELETE", `/rpg/v1/campaigns/${campaignId}/memberships/${principalId}`, {
    expectedRevision: changed.receipt.revisionAfter, idempotencyKey: `${runId}-membership-remove`,
  });
  expect(removed).toEqual({
    membership: expect.objectContaining({ principalId, role: "gm" }),
    receipt: expect.objectContaining({ campaignId, type: "membership_removed", revisionBefore: changed.receipt.revisionAfter,
      revisionAfter: changed.receipt.revisionAfter + 1 }),
  });
  const listedAfterRemoval = await json<{ memberships: Array<{ principalId: string }> }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/memberships`,
  );
  expect(listedAfterRemoval.memberships.map((membership) => membership.principalId)).not.toContain(principalId);

  let characterId: string | undefined;
  let sessionId: string | undefined;
  try {
    const character = await json<{ id: string }>(request, "POST", "/characters", {
      name: `${runId}-Detach-Persona`, age: 30, archetype: "Deterministic room owner",
      boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
    });
    characterId = character.id;
    const session = await json<{ id: string }>(request, "POST", "/sessions", {
      characterId, title: `${runId}-Stopped-Detach-Room`,
    });
    sessionId = session.id;
    await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/rooms`, { sessionId });
    await json(request, "POST", `/sessions/${sessionId}/stop`, undefined, 200);

    const beforeDetach = await json<{ campaign: { revision: number } }>(
      request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`,
    );
    const detached = await json<{
      attachment: { sessionId: string; attachedAt: string };
      receipt: { campaignId: string; type: string; revisionBefore: number; revisionAfter: number };
    }>(request, "DELETE", `/rpg/v1/campaigns/${campaignId}/rooms/${sessionId}`, {
      expectedRevision: beforeDetach.campaign.revision, idempotencyKey: `${runId}-stopped-room-detach`,
    });
    expect(detached).toEqual({
      attachment: expect.objectContaining({ sessionId, attachedAt: expect.any(String) }),
      receipt: expect.objectContaining({ campaignId, type: "room_detached", revisionBefore: beforeDetach.campaign.revision,
        revisionAfter: beforeDetach.campaign.revision + 1 }),
    });
  } finally {
    if (sessionId) await request.delete(`/api/sessions/${sessionId}`).catch(() => undefined);
    if (characterId) await request.delete(`/api/characters/${characterId}`).catch(() => undefined);
  }
});

test("campaign timeline, checkpoint, and recap API smoke", async ({ request }) => {
  const campaignName = `${runId}-Timeline-Campaign`;
  const created = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", {
    name: campaignName,
  });
  const campaignId = created.campaign.id;

  const administration = await json<{ campaign: { activeTimelineId: string; revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`,
  );
  const rootTimelineId = administration.campaign.activeTimelineId;
  const initialTimelines = await json<{
    activeTimelineId: string;
    timelines: Array<{ id: string; parentTimelineId: string | null; forkedFromRevision: number | null; revision: number; active: boolean }>;
  }>(request, "GET", `/rpg/v1/campaigns/${campaignId}/timelines`);
  expect(initialTimelines).toEqual({
    activeTimelineId: rootTimelineId,
    timelines: [expect.objectContaining({
      id: rootTimelineId, parentTimelineId: null, forkedFromRevision: null, revision: 0, active: true,
    })],
  });

  const emptyEvents = await json<{ events: unknown[]; nextAfterRevision: null }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/events?timelineId=${rootTimelineId}&afterRevision=0&limit=100`,
  );
  expect(emptyEvents).toEqual({ events: [], nextAfterRevision: null });

  const checkpoint = await json<{
    checkpoint: { id: string; timelineId: string; timelineRevision: number; label: string };
    receipt: { type: string; revisionAfter: number };
  }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/checkpoints`, {
    timelineId: rootTimelineId,
    timelineRevision: 0,
    label: "Opening",
    expectedRevision: administration.campaign.revision,
    idempotencyKey: `${runId}-timeline-checkpoint`,
  });
  expect(checkpoint).toEqual({
    checkpoint: expect.objectContaining({ timelineId: rootTimelineId, timelineRevision: 0, label: "Opening" }),
    receipt: expect.objectContaining({ type: "checkpoint_created", revisionAfter: administration.campaign.revision + 1 }),
  });

  const checkpoints = await json<{ checkpoints: Array<{ id: string; timelineId: string; timelineRevision: number }> }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/checkpoints`,
  );
  expect(checkpoints.checkpoints).toContainEqual(expect.objectContaining({
    id: checkpoint.checkpoint.id, timelineId: rootTimelineId, timelineRevision: 0,
  }));

  const fork = await json<{
    timeline: { id: string; parentTimelineId: string; forkedFromRevision: number; revision: number; active: boolean };
    receipt: { type: string; revisionAfter: number };
  }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/timeline-forks`, {
    checkpointId: checkpoint.checkpoint.id,
    expectedRevision: checkpoint.receipt.revisionAfter,
    idempotencyKey: `${runId}-timeline-fork`,
  });
  expect(fork).toEqual({
    timeline: expect.objectContaining({ parentTimelineId: rootTimelineId, forkedFromRevision: 0, revision: 0, active: true }),
    receipt: expect.objectContaining({ type: "timeline_forked", revisionAfter: checkpoint.receipt.revisionAfter + 1 }),
  });

  const forkedTimelines = await json<{ activeTimelineId: string; timelines: Array<{ id: string; active: boolean }> }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/timelines`,
  );
  expect(forkedTimelines.activeTimelineId).toBe(fork.timeline.id);
  expect(forkedTimelines.timelines).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: rootTimelineId, active: false }),
    expect.objectContaining({ id: fork.timeline.id, active: true }),
  ]));

  const recap = await json<{
    recap: { id: string; timelineId: string; throughRevision: number; visibility: string; text: string };
    receipt: { type: string; revisionAfter: number };
  }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/recaps`, {
    timelineId: fork.timeline.id,
    throughRevision: fork.timeline.revision,
    selectedSessionIds: [],
    visibility: "members",
    text: "The campaign begins.",
    expectedRevision: fork.receipt.revisionAfter,
    idempotencyKey: `${runId}-members-recap`,
  });
  expect(recap).toEqual({
    recap: expect.objectContaining({ timelineId: fork.timeline.id, throughRevision: 0, visibility: "members", text: "The campaign begins." }),
    receipt: expect.objectContaining({ type: "recap_created", revisionAfter: fork.receipt.revisionAfter + 1 }),
  });

  const recaps = await json<{ recaps: Array<{ id: string; visibility: string; text: string }> }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/recaps`,
  );
  expect(recaps.recaps).toContainEqual(expect.objectContaining({
    id: recap.recap.id, visibility: "members", text: "The campaign begins.",
  }));

  const archived = await json<{
    campaign: { id: string; status: string };
    receipt: { type: string; revisionAfter: number };
  }>(request, "DELETE", `/rpg/v1/campaigns/${campaignId}/administration`, {
    expectedRevision: recap.receipt.revisionAfter,
    idempotencyKey: `${runId}-timeline-archive`,
    confirmationName: campaignName,
  });
  expect(archived).toEqual({
    campaign: expect.objectContaining({ id: campaignId, status: "archived" }),
    receipt: expect.objectContaining({ type: "administration_updated", revisionAfter: recap.receipt.revisionAfter + 1 }),
  });
});

test("quest workflow creates and resolves campaign state", async ({ request }) => {
  let characterId: string | undefined;
  try {
    const character = await json<{ id: string }>(request, "POST", "/characters", {
      name: `${runId}-Quest-Scout`, age: 29, archetype: "Observant scout", boundaries: "Fictional deterministic test only",
      fictionalConfirmed: true,
    });
    characterId = character.id;
    expect(characterId).toBeTruthy();

    const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", {
      name: `${runId}-Quest-Campaign`,
    });
    const campaignId = campaign.campaign.id;
    expect(campaignId).toBeTruthy();

    const storyline = await json<{
      storyline: { id: string; campaignId: string; title: string; description: string | null; status: string };
    }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/storylines`, {
      title: "The missing star", description: "Follow the observatory chart.",
    });
    expect(storyline.storyline).toMatchObject({
      campaignId, title: "The missing star", description: "Follow the observatory chart.", status: "active",
    });
    expect(storyline.storyline.id).toBeTruthy();

    const quest = await json<{
      quest: { id: string; campaignId: string; storylineId: string; title: string; description: string | null; status: string };
    }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/quests`, {
      storylineId: storyline.storyline.id, title: "Decode the chart", description: "Identify its moon seal.",
    });
    expect(quest.quest).toMatchObject({
      campaignId, storylineId: storyline.storyline.id, title: "Decode the chart", description: "Identify its moon seal.", status: "open",
    });
    expect(quest.quest.id).toBeTruthy();

    const clue = await json<{
      clue: { id: string; campaignId: string; questId: string; content: string; discoveredByCharacterId: string | null; discoveredAt: string | null };
    }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/quests/${quest.quest.id}/clues`, {
      content: "The chart bears a moon seal.",
    });
    expect(clue.clue).toMatchObject({
      campaignId, questId: quest.quest.id, content: "The chart bears a moon seal.", discoveredByCharacterId: null, discoveredAt: null,
    });
    expect(clue.clue.id).toBeTruthy();

    const discovered = await json<{
      clue: { id: string; discoveredByCharacterId: string | null; discoveredAt: string | null };
    }>(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/quests/${quest.quest.id}/clues/${clue.clue.id}/discover`, {
      characterId,
    }, 200);
    expect(discovered.clue).toMatchObject({ id: clue.clue.id, discoveredByCharacterId: characterId });
    expect(discovered.clue.discoveredAt).toBeTruthy();

    const reward = await json<{
      reward: { id: string; campaignId: string; questId: string; kind: string; amount: number | null; label: string; grantedToCharacterId: string | null; grantedAt: string | null };
    }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/quests/${quest.quest.id}/rewards`, {
      kind: "xp", amount: 100, label: "Observatory XP",
    });
    expect(reward.reward).toMatchObject({
      campaignId, questId: quest.quest.id, kind: "xp", amount: 100, label: "Observatory XP", grantedToCharacterId: null, grantedAt: null,
    });
    expect(reward.reward.id).toBeTruthy();

    const granted = await json<{
      reward: { id: string; grantedToCharacterId: string | null; grantedAt: string | null };
    }>(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/quests/${quest.quest.id}/rewards/${reward.reward.id}/grant`, {
      characterId,
    }, 200);
    expect(granted.reward).toMatchObject({ id: reward.reward.id, grantedToCharacterId: characterId });
    expect(granted.reward.grantedAt).toBeTruthy();
  } finally {
    if (characterId) await request.delete(`/api/characters/${characterId}`).catch(() => undefined);
  }
});
