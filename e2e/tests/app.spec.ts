import { expect, test, type APIRequestContext } from "@playwright/test";
import { characterSheetHttpResponseSchema, type CatalogDefinition, type PublishContentCatalogInput } from "../../packages/contracts/src/index.js";
import { calculateCatalogDigest, MECHANICS_STARTER_CATALOG } from "../../server/src/repo/index.js";

const runId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function consumableCatalog(): PublishContentCatalogInput {
  const catalog = structuredClone(MECHANICS_STARTER_CATALOG) as PublishContentCatalogInput;
  const packId = "velvet:e2e-consumables";
  const replaceIdentity = (value: unknown, version: string): void => {
    if (Array.isArray(value)) { value.forEach((child) => replaceIdentity(child, version)); return; }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if ("packId" in record) record.packId = packId;
    if ("packVersion" in record) record.packVersion = version;
    Object.values(record).forEach((child) => replaceIdentity(child, version));
  };
  replaceIdentity(catalog, "1.0.0+000000000000");
  catalog.idempotencyKey = `${runId}-m5.3-consumable-publication`;
  catalog.manifest.digest = "0".repeat(64);
  catalog.manifest.name = "Velvet E2E Consumables";
  const item = catalog.definitions.find((definition) => definition.reference.kind === "item");
  if (!item || item.reference.kind !== "item") throw new Error("starter item definition is unavailable");
  item.reference.definitionId = "velvet:e2e:item:restorative-tonic";
  item.name = "Restorative Tonic";
  item.description = "A deterministic immutable healing consumable for E2E coverage.";
  item.mechanics = { ...item.mechanics, category: "consumable", stackable: true, slot: null,
    effects: [{ type: "healing", dice: { count: 1, sides: 4, modifier: 0 } }] };
  const background = catalog.definitions.find((definition) => definition.reference.kind === "background");
  if (!background || background.reference.kind !== "background") throw new Error("starter background definition is unavailable");
  (background as Extract<CatalogDefinition, { reference: { kind: "background" } }>).mechanics.itemRefs = [item.reference];
  const digest = calculateCatalogDigest(catalog);
  replaceIdentity(catalog, `1.0.0+${digest.slice(0, 12)}`);
  catalog.manifest.digest = digest;
  return catalog;
}

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

async function actorForCampaignCharacter(request: APIRequestContext, campaignId: string, characterId: string): Promise<string> {
  const actor = await json<{ actorId: string }>(
    request, "GET", `/__e2e/campaigns/${campaignId}/characters/${characterId}/actor`,
  );
  return actor.actorId;
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
    character: { id: string };
    receipt: { idempotencyKey: string; revisionBefore: number; revisionAfter: number; derived: unknown };
  }>(request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${created.draft.id}/finalize`, finalization, 201);
  expect(finalized).toMatchObject({
    character: { id: expect.any(String) },
    receipt: { idempotencyKey: finalization.idempotencyKey, revisionBefore: 1, revisionAfter: 2 },
  });

  const retried = await json<typeof finalized>(
    request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${created.draft.id}/finalize`, finalization, 201,
  );
  expect(retried).toEqual(finalized);
  const actorId = await actorForCampaignCharacter(request, campaign.campaign.id, finalized.character.id);
  const lookupWithUnexpectedQuery = await request.get(
    `/api/__e2e/campaigns/${campaign.campaign.id}/characters/${finalized.character.id}/actor?unexpected=1`,
  );
  expect(lookupWithUnexpectedQuery.status()).toBe(400);

  const resources = await json<{ resources: Array<{ name: string; current: number; max: number }>; revision: number }>(
    request, "GET", `/rpg/v1/campaigns/${campaign.campaign.id}/actors/${actorId}/resources`,
  );
  const health = resources.resources.find((resource) => resource.name === "health")!;
  expect(health).toMatchObject({ current: health.max });
  const damage = { kind: "change" as const, resourceName: "health", amount: -1, expectedRevision: resources.revision, idempotencyKey: `${runId}-m2.7-damage` };
  const changedResources = await json<{ resources: Array<{ name: string; current: number; max: number }>; receipt: { revisionBefore: number; revisionAfter: number; idempotencyKey: string } }>(
    request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/actors/${actorId}/resource-commands`, damage, 200,
  );
  expect(changedResources.resources.find((resource) => resource.name === "health")).toMatchObject({ current: health.current - 1, max: health.max });
  expect(changedResources.receipt).toMatchObject({ revisionBefore: resources.revision, revisionAfter: resources.revision + 1, idempotencyKey: damage.idempotencyKey });
  expect(await json<typeof changedResources>(request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/actors/${actorId}/resource-commands`, damage, 200)).toEqual(changedResources);

  const progression = await json<{ progression: { campaignId: string; campaignCharacterId: string; level: number; totalXp: number; revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaign.campaign.id}/characters/${finalized.character.id}/progression`,
  );
  const xpCommand = {
    amount: 300,
    reason: "Completed the observatory expedition",
    expectedRevision: progression.progression.revision,
    idempotencyKey: `${runId}-m2.6-grant-xp`,
  };
  const granted = await json<{
    progression: { campaignId: string; campaignCharacterId: string; level: number; totalXp: number; milestoneCount: number; revision: number; derived: unknown; updatedAt: string };
    receipt: { campaignCharacterId: string; idempotencyKey: string; type: string; revisionBefore: number; revisionAfter: number; occurredAt: string; appliedLevels: unknown[] };
  }>(
    request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/characters/${finalized.character.id}/xp-commands`, xpCommand, 200,
  );
  expect(granted).toMatchObject({
    progression: {
      campaignId: campaign.campaign.id,
      campaignCharacterId: finalized.character.id,
      level: progression.progression.level,
      totalXp: progression.progression.totalXp + xpCommand.amount,
      revision: progression.progression.revision + 1,
    },
    receipt: {
      campaignCharacterId: finalized.character.id,
      idempotencyKey: xpCommand.idempotencyKey,
      type: "grant-xp",
      revisionBefore: progression.progression.revision,
      revisionAfter: progression.progression.revision + 1,
      occurredAt: expect.any(String),
      appliedLevels: [],
    },
  });
  expect(granted.progression).not.toHaveProperty("sheetId");
  expect(granted.progression).not.toHaveProperty("actorId");
  const grantRetried = await json<typeof granted>(
    request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/characters/${finalized.character.id}/xp-commands`, xpCommand, 200,
  );
  expect(grantRetried).toEqual(granted);

  const persisted = await json<typeof progression>(
    request, "GET", `/rpg/v1/campaigns/${campaign.campaign.id}/characters/${finalized.character.id}/progression`,
  );
  expect(persisted).toEqual({ progression: granted.progression });

  const publicSheet = characterSheetHttpResponseSchema.parse(await json<unknown>(
    request, "GET", `/rpg/v1/campaigns/${campaign.campaign.id}/characters/${finalized.character.id}/sheet`,
  ));
  expect(publicSheet.sheet.classes.reduce((total, characterClass) => total + characterClass.level, 0))
    .toBe(publicSheet.progression.level);
  expect(publicSheet.derived).toEqual(finalized.receipt.derived);
  expect(publicSheet.derived).toEqual(granted.progression.derived);
  expect(publicSheet.progression).toEqual({
    mode: "xp",
    level: granted.progression.level,
    totalXp: granted.progression.totalXp,
    milestoneCount: granted.progression.milestoneCount,
    updatedAt: granted.progression.updatedAt,
  });
  expect(publicSheet).not.toHaveProperty("campaignId");
  expect(publicSheet).not.toHaveProperty("campaignCharacterId");
  expect(publicSheet).not.toHaveProperty("sheetId");
  expect(publicSheet).not.toHaveProperty("actorId");
  expect(publicSheet.sheet).not.toHaveProperty("id");
  expect(publicSheet.sheet).not.toHaveProperty("controllerPrincipalId");
  expect(publicSheet.sheet).not.toHaveProperty("privateNotes");
  expect(publicSheet.progression).not.toHaveProperty("revision");
  expect(JSON.stringify(publicSheet)).not.toContain(actorId);
  expect(JSON.stringify(publicSheet)).not.toContain(finalized.character.id);
  expect(JSON.stringify(publicSheet)).not.toContain(created.draft.id);
  expect(JSON.stringify(publicSheet)).not.toContain(persona.id);

  const preview = await json<{ preview: { campaignId: string; campaignCharacterId: string; currentLevel: number; eligibleLevel: number; levels: unknown[] } }>(
    request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/characters/${finalized.character.id}/progression/preview`, { selections: [] }, 200,
  );
  expect(preview.preview).toMatchObject({
    campaignId: campaign.campaign.id,
    campaignCharacterId: finalized.character.id,
    currentLevel: granted.progression.level,
    eligibleLevel: granted.progression.level + 1,
  });
  expect(preview.preview.levels).toHaveLength(1);
  expect(preview.preview).toHaveProperty("previewRevision");
  expect(preview.preview).toHaveProperty("previewToken");
});

test("M2.7 deterministic fixture routes reject malformed semantic input", async ({ request }) => {
  const malformedFixture = await request.post("/api/__e2e/materialize-waylamp", {
    data: { campaignId: "invalid campaign", actorId: "actor", entryId: "waylamp", expectedRevision: 0 },
  });
  expect(malformedFixture.status()).toBe(400);

  const malformedEconomyCommand = await request.post("/api/__e2e/economy/commands", {
    data: {
      type: "request_purchase_quote", campaignId: "campaign", buyerActorId: "actor", shopId: "shop",
      item: { kind: "item", packId: "pack", packVersion: "1", definitionId: "item" }, quantity: 0,
      expectedRevision: 0, idempotencyKey: "malformed-economy-command",
    },
  });
  expect(malformedEconomyCommand.status()).toBe(400);

  const malformedEconomyLookups = await Promise.all([
    request.get("/api/__e2e/economy/campaigns/invalid%20campaign/actors/actor/wallet"),
    request.get("/api/__e2e/economy/campaigns/campaign/actors/invalid%20actor/wallet"),
    request.get("/api/__e2e/economy/campaigns/campaign/shops/invalid%20shop"),
  ]);
  expect(malformedEconomyLookups.map((response) => response.status())).toEqual([400, 400, 400]);
});

test("M2.7 finalized actor inventories a Waylamp, equips, replays, and unequips it", async ({ request }) => {
  const fixture = MECHANICS_STARTER_CATALOG;
  const pin = { packId: fixture.manifest.packId, packVersion: fixture.manifest.packVersion };
  const persona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-M2.7-Waylamp-Bearer`, age: 30, archetype: "Disciplined scout",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  await json(request, "POST", "/rpg/v1/content-packs", fixture);
  const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", {
    name: `${runId}-M2.7-Inventory-Campaign`,
  });
  const administration = await json<{ campaign: { revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaign.campaign.id}/administration`,
  );
  await json(request, "PUT", `/rpg/v1/campaigns/${campaign.campaign.id}/content`, {
    rulesProfileId: fixture.manifest.compatibility.rulesProfileId,
    contentPacks: [pin],
    expectedRevision: administration.campaign.revision,
    idempotencyKey: `${runId}-m2.7-configure`,
  });
  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const draft = await json<{ draft: { id: string; revision: number } }>(
    request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts`, {
      personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${runId}-m2.7-draft`,
    },
  );
  const reference = (kind: "race" | "background" | "class") => fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
  const selected = await json<{ draft: { revision: number } }>(
    request, "PATCH", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${draft.draft.id}`, {
      expectedRevision: draft.draft.revision, idempotencyKey: `${runId}-m2.7-select`,
      selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
    },
  );
  const finalized = await json<{ character: { id: string } }>(
    request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${draft.draft.id}/finalize`, {
      expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-m2.7-finalize`,
    }, 201,
  );
  const actorId = await actorForCampaignCharacter(request, campaign.campaign.id, finalized.character.id);
  const inventoryPath = `/rpg/v1/campaigns/${campaign.campaign.id}/actors/${actorId}/inventory`;
  const commandPath = `${inventoryPath}-commands`;
  const initial = await json<{ entries: unknown[]; equipment: unknown[]; capacity: number; revision: number }>(request, "GET", inventoryPath);
  expect(initial).toMatchObject({ entries: [], equipment: [], capacity: 1000, revision: 0 });

  const entryId = `${runId}-waylamp`;
  const materialized = await request.post("/api/__e2e/materialize-waylamp", {
    data: { campaignId: campaign.campaign.id, actorId, entryId, expectedRevision: initial.revision },
  });
  expect(materialized.status()).toBe(204);
  const stocked = await json<{ entries: Array<{ kind: string; entryId: string; item: typeof pin & { definitionId: string } }>; equipment: unknown[]; revision: number }>(request, "GET", inventoryPath);
  expect(stocked).toMatchObject({
    entries: [{ kind: "instanced", entryId, item: { ...pin, definitionId: "velvet:mechanics:item:waylamp" } }],
    equipment: [], revision: initial.revision,
  });

  const equip = { kind: "equip" as const, slot: "hand" as const, entryId, expectedRevision: stocked.revision, idempotencyKey: `${runId}-m2.7-equip` };
  const equipped = await json<{ inventory: { equipment: Array<{ slot: string; entryId: string }>; revision: number }; receipt: { kind: string; revisionBefore: number; revisionAfter: number; idempotencyKey: string } }>(request, "POST", commandPath, equip, 200);
  expect(equipped).toMatchObject({
    inventory: { equipment: [{ slot: "hand", entryId }], revision: stocked.revision + 1 },
    receipt: { kind: "equip", revisionBefore: stocked.revision, revisionAfter: stocked.revision + 1, idempotencyKey: equip.idempotencyKey },
  });
  expect(await json<typeof equipped>(request, "POST", commandPath, equip, 200)).toEqual(equipped);
  expect(await json<typeof stocked>(request, "GET", inventoryPath)).toEqual(equipped.inventory);

  const unequip = { kind: "unequip" as const, slot: "hand" as const, expectedRevision: equipped.inventory.revision, idempotencyKey: `${runId}-m2.7-unequip` };
  const unequipped = await json<{ inventory: { entries: unknown[]; equipment: unknown[]; revision: number }; receipt: { kind: string; revisionBefore: number; revisionAfter: number; idempotencyKey: string } }>(request, "POST", commandPath, unequip, 200);
  expect(unequipped).toMatchObject({
    inventory: { entries: [{ entryId }], equipment: [], revision: equipped.inventory.revision + 1 },
    receipt: { kind: "unequip", revisionBefore: equipped.inventory.revision, revisionAfter: equipped.inventory.revision + 1, idempotencyKey: unequip.idempotencyKey },
  });

});

test("M2.7 finalized actor short-rests and replays exactly", async ({ request }) => {
  const fixture = MECHANICS_STARTER_CATALOG;
  const pin = { packId: fixture.manifest.packId, packVersion: fixture.manifest.packVersion };
  const persona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-M2.7-Rest-Bearer`, age: 30, archetype: "Disciplined scout", boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  await json(request, "POST", "/rpg/v1/content-packs", fixture);
  const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", { name: `${runId}-M2.7-Rest-Campaign` });
  const administration = await json<{ campaign: { revision: number } }>(request, "GET", `/rpg/v1/campaigns/${campaign.campaign.id}/administration`);
  await json(request, "PUT", `/rpg/v1/campaigns/${campaign.campaign.id}/content`, {
    rulesProfileId: fixture.manifest.compatibility.rulesProfileId, contentPacks: [pin], expectedRevision: administration.campaign.revision, idempotencyKey: `${runId}-m2.7-rest-configure`,
  });
  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const draft = await json<{ draft: { id: string; revision: number } }>(request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts`, {
    personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${runId}-m2.7-rest-draft`,
  });
  const reference = (kind: "race" | "background" | "class") => fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
  const selected = await json<{ draft: { revision: number } }>(request, "PATCH", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${draft.draft.id}`, {
    expectedRevision: draft.draft.revision, idempotencyKey: `${runId}-m2.7-rest-select`,
    selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
  });
  const finalized = await json<{ character: { id: string } }>(request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${draft.draft.id}/finalize`, {
    expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-m2.7-rest-finalize`,
  }, 201);
  const actorId = await actorForCampaignCharacter(request, campaign.campaign.id, finalized.character.id);
  const resources = await json<{ revision: number }>(request, "GET", `/rpg/v1/campaigns/${campaign.campaign.id}/actors/${actorId}/resources`);
  const materialized = await request.post("/api/__e2e/materialize-short-rest-resource", {
    data: { campaignId: campaign.campaign.id, actorId, expectedRevision: resources.revision },
  });
  expect(materialized.status()).toBe(204);
  const command = { type: "take_short_rest" as const, campaignId: campaign.campaign.id, actorId, expectedRevision: resources.revision, idempotencyKey: `${runId}-m2.7-short-rest` };
  const rested = await json<{ rest: { kind: string; recovery: { resources: Array<{ resourceId: string; before: number; after: number }> }; revisionBefore: number; revisionAfter: number; idempotencyKey: string } }>(request, "POST", "/__e2e/take-short-rest", command, 200);
  expect(rested.rest).toMatchObject({
    kind: "short", recovery: { resources: [{ resourceId: "focus", before: 1, after: 4 }] }, revisionBefore: command.expectedRevision,
    revisionAfter: command.expectedRevision + 1, idempotencyKey: command.idempotencyKey,
  });
  expect(await json<typeof rested>(request, "POST", "/__e2e/take-short-rest", command, 200)).toEqual(rested);
});

test("M2.7 economy quotes, replays, purchases, and reconciles authoritative state", async ({ request }) => {
  const fixture = MECHANICS_STARTER_CATALOG;
  const pin = { packId: fixture.manifest.packId, packVersion: fixture.manifest.packVersion };
  const waylamp = { kind: "item" as const, ...pin, definitionId: "velvet:mechanics:item:waylamp" };
  const glimmer = { kind: "currency" as const, ...pin, definitionId: "velvet:mechanics:currency:glimmer" };
  const persona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-M2.7-Economy-Bearer`, age: 30, archetype: "Disciplined scout", boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  await json(request, "POST", "/rpg/v1/content-packs", fixture);
  const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", { name: `${runId}-M2.7-Economy-Campaign` });
  const administration = await json<{ campaign: { revision: number } }>(request, "GET", `/rpg/v1/campaigns/${campaign.campaign.id}/administration`);
  await json(request, "PUT", `/rpg/v1/campaigns/${campaign.campaign.id}/content`, {
    rulesProfileId: fixture.manifest.compatibility.rulesProfileId, contentPacks: [pin], expectedRevision: administration.campaign.revision, idempotencyKey: `${runId}-m2.7-economy-configure`,
  });
  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const draft = await json<{ draft: { id: string; revision: number } }>(request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts`, {
    personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${runId}-m2.7-economy-draft`,
  });
  const reference = (kind: "race" | "background" | "class") => fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
  const selected = await json<{ draft: { revision: number } }>(request, "PATCH", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${draft.draft.id}`, {
    expectedRevision: draft.draft.revision, idempotencyKey: `${runId}-m2.7-economy-select`, selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
  });
  const finalized = await json<{ character: { id: string } }>(request, "POST", `/rpg/v1/campaigns/${campaign.campaign.id}/character-drafts/${draft.draft.id}/finalize`, {
    expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-m2.7-economy-finalize`,
  }, 201);
  const actorId = await actorForCampaignCharacter(request, campaign.campaign.id, finalized.character.id);
  const base = `/__e2e/economy/campaigns/${campaign.campaign.id}`;
  const resourcesPath = `/rpg/v1/campaigns/${campaign.campaign.id}/actors/${actorId}/resources`;
  const initialResources = await json<{ revision: number }>(request, "GET", resourcesPath);
  const materialized = await request.post("/api/__e2e/materialize-economy-fixture", {
    data: { campaignId: campaign.campaign.id, actorId, expectedRevision: initialResources.revision },
  });
  expect(materialized.status()).toBe(204);
  const walletPath = `${base}/actors/${actorId}/wallet`;
  const shopPath = `${base}/shops/e2e-waylamp-shop`;
  expect(await json<{ wallet: { balances: Array<{ currency: typeof glimmer; minorUnits: number }> } }>(request, "GET", walletPath)).toEqual({ wallet: { balances: [{ currency: glimmer, minorUnits: 20 }] } });
  expect(await json<{ shop: { name: string; stock: Array<{ item: typeof waylamp; quantity: number; unitPrice: { currency: typeof glimmer; minorUnits: number } }> } }>(request, "GET", shopPath)).toEqual({ shop: { shopId: "e2e-waylamp-shop", campaignId: campaign.campaign.id, name: "E2E Waylamp Shop", stock: [{ item: waylamp, quantity: 2, unitPrice: { currency: glimmer, minorUnits: 8 } }] } });
  const quoteCommand = { type: "request_purchase_quote" as const, campaignId: campaign.campaign.id, buyerActorId: actorId, shopId: "e2e-waylamp-shop", item: waylamp, quantity: 1, expectedRevision: initialResources.revision, idempotencyKey: `${runId}-m2.7-economy-quote` };
  const quoted = await json<{ quote: { quoteId: string; total: { currency: typeof glimmer; minorUnits: number } }; receipt: { revisionBefore: number; revisionAfter: number } }>(request, "POST", "/__e2e/economy/commands", quoteCommand, 200);
  expect(quoted).toMatchObject({ quote: { campaignId: campaign.campaign.id, shopId: quoteCommand.shopId, buyerActorId: actorId, item: waylamp, quantity: 1, total: { currency: glimmer, minorUnits: 8 } }, receipt: { revisionBefore: initialResources.revision, revisionAfter: initialResources.revision + 1 } });
  expect(await json<typeof quoted>(request, "POST", "/__e2e/economy/commands", quoteCommand, 200)).toEqual(quoted);
  const purchaseCommand = { type: "purchase_from_shop" as const, campaignId: campaign.campaign.id, buyerActorId: actorId, quoteId: quoted.quote.quoteId, expectedRevision: quoted.receipt.revisionAfter, idempotencyKey: `${runId}-m2.7-economy-purchase` };
  const purchased = await json<{ purchase: { quoteId: string; total: { currency: typeof glimmer; minorUnits: number }; revisionBefore: number; revisionAfter: number }; receipt: { revisionBefore: number; revisionAfter: number } }>(request, "POST", "/__e2e/economy/commands", purchaseCommand, 200);
  expect(purchased).toMatchObject({ purchase: { quoteId: quoted.quote.quoteId, total: { currency: glimmer, minorUnits: 8 }, revisionBefore: quoted.receipt.revisionAfter, revisionAfter: quoted.receipt.revisionAfter + 1 }, receipt: { revisionBefore: quoted.receipt.revisionAfter, revisionAfter: quoted.receipt.revisionAfter + 1 } });
  expect(await json<typeof purchased>(request, "POST", "/__e2e/economy/commands", purchaseCommand, 200)).toEqual(purchased);
  expect(await json<{ wallet: { balances: Array<{ currency: typeof glimmer; minorUnits: number }> } }>(request, "GET", walletPath)).toEqual({ wallet: { balances: [{ currency: glimmer, minorUnits: 12 }] } });
  expect(await json<{ shop: { stock: Array<{ quantity: number }> } }>(request, "GET", shopPath)).toMatchObject({ shop: { stock: [{ quantity: 1 }] } });
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

    const fixture = MECHANICS_STARTER_CATALOG;
    const pin = { packId: fixture.manifest.packId, packVersion: fixture.manifest.packVersion };
    await json(request, "POST", "/rpg/v1/content-packs", fixture);
    const administration = await json<{ campaign: { revision: number } }>(
      request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`,
    );
    await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/content`, {
      rulesProfileId: fixture.manifest.compatibility.rulesProfileId,
      contentPacks: [pin],
      expectedRevision: administration.campaign.revision,
      idempotencyKey: `${runId}-quest-configure`,
    });
    const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
    const draft = await json<{ draft: { id: string; revision: number } }>(
      request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts`, {
        personaId: characterId,
        durability: "durable",
        allocation: { method: "standard-array", scores },
        idempotencyKey: `${runId}-quest-draft`,
      },
    );
    const reference = (kind: "race" | "background" | "class") =>
      fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
    const selected = await json<{ draft: { revision: number } }>(
      request, "PATCH", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}`, {
        expectedRevision: draft.draft.revision,
        idempotencyKey: `${runId}-quest-select`,
        selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
      },
    );
    const finalized = await json<{ character: { id: string } }>(
      request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}/finalize`, {
        expectedRevision: selected.draft.revision,
        idempotencyKey: `${runId}-quest-finalize`,
      }, 201,
    );
    const actorId = await actorForCampaignCharacter(request, campaignId, finalized.character.id);

    const storylineId = `${runId}-quest-storyline`;
    const storylineRequest = {
      storyline: { storylineId, title: "The missing star", summary: "Follow the observatory chart.", nodes: [], edges: [], plotPoints: [], clues: [] },
      expectedRevision: 0,
      idempotencyKey: `${runId}-storyline-create`,
    };
    const storyline = await json<{
      storyline: { storylineId: string; campaignId: string; title: string; summary: string | null; status: string };
      story: { nodes: unknown[]; edges: unknown[]; plotPoints: unknown[]; clues: unknown[] };
      receipt: { idempotencyKey: string; revisionBefore: number; revisionAfter: number };
    }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/storylines`, storylineRequest, 201);
    expect(storyline.storyline).toMatchObject({
      storylineId, campaignId, title: "The missing star", summary: "Follow the observatory chart.", status: "active",
    });
    expect(storyline.story).toMatchObject({ nodes: [], edges: [], plotPoints: [], clues: [] });
    expect(storyline.receipt).toMatchObject({
      idempotencyKey: storylineRequest.idempotencyKey, revisionBefore: 0, revisionAfter: 1,
    });
    expect(await json<typeof storyline>(
      request, "POST", `/rpg/v1/campaigns/${campaignId}/storylines`, storylineRequest, 201,
    )).toEqual(storyline);

    const questId = `${runId}-decode-chart`;
    const objectiveId = `${runId}-moon-seal`;
    const rewardId = `${runId}-observatory-xp`;
    const questRequest = {
      quest: {
        questId, storylineId, title: "Decode the chart", description: "Identify its moon seal.", visibility: "public" as const,
        objectives: [{ objectiveId, description: "Identify the moon seal.", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" as const }],
        rewards: [{ rewardId, kind: "xp" as const, amount: 100, label: "Observatory XP", visibility: "public" as const }],
        journalText: "The observatory chart awaits decoding.",
      },
      expectedRevision: 0,
      idempotencyKey: `${runId}-quest-create`,
    };
    const quest = await json<{
      quest: { questId: string; campaignId: string; storylineId: string; title: string; description: string | null; status: string };
      definition: typeof questRequest.quest;
      projection: { objectives: Array<{ objectiveId: string; questId: string; progress: number; targetProgress: number }> };
      revision: number;
      receipt: { idempotencyKey: string; revisionBefore: number; revisionAfter: number };
    }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/quests`, questRequest, 201);
    expect(quest.quest).toMatchObject({
      questId, campaignId, storylineId, title: "Decode the chart", description: "Identify its moon seal.", status: "offered",
    });
    expect(quest.definition).toEqual(questRequest.quest);
    expect(quest.projection.objectives).toContainEqual(expect.objectContaining({ objectiveId, questId, progress: 0, targetProgress: 1 }));
    expect(quest).toMatchObject({ revision: 1, receipt: { idempotencyKey: questRequest.idempotencyKey, revisionBefore: 0, revisionAfter: 1 } });
    expect(await json<typeof quest>(
      request, "POST", `/rpg/v1/campaigns/${campaignId}/quests`, questRequest, 201,
    )).toEqual(quest);

    const accepted = await json<{ quest: { status: string }; receipt: { revisionBefore: number; revisionAfter: number; idempotencyKey: string } }>(
      request, "POST", `/rpg/v1/quests/${questId}/commands`, { kind: "accept", expectedRevision: quest.receipt.revisionAfter, idempotencyKey: `${runId}-quest-accept` }, 200,
    );
    expect(accepted).toMatchObject({ quest: { status: "active" }, receipt: { revisionBefore: 1, revisionAfter: 2, idempotencyKey: `${runId}-quest-accept` } });
    expect(await json<typeof accepted>(
      request, "POST", `/rpg/v1/quests/${questId}/commands`, { kind: "accept", expectedRevision: quest.receipt.revisionAfter, idempotencyKey: `${runId}-quest-accept` }, 200,
    )).toEqual(accepted);

    const advanced = await json<{ quest: { status: string }; receipt: { revisionBefore: number; revisionAfter: number; idempotencyKey: string } }>(
      request, "POST", `/rpg/v1/quests/${questId}/commands`, { kind: "advance-objective", objectiveId, expectedRevision: accepted.receipt.revisionAfter, idempotencyKey: `${runId}-quest-advance` }, 200,
    );
    expect(advanced).toMatchObject({ quest: { status: "completed" }, receipt: { revisionBefore: 2, revisionAfter: 3, idempotencyKey: `${runId}-quest-advance` } });
    expect(await json<typeof advanced>(
      request, "POST", `/rpg/v1/quests/${questId}/commands`, { kind: "advance-objective", objectiveId, expectedRevision: accepted.receipt.revisionAfter, idempotencyKey: `${runId}-quest-advance` }, 200,
    )).toEqual(advanced);

    const claimed = await json<{
      quest: { status: string; rewards: Array<{ rewardId: string; claimedByActorId: string | null; claimedAt: string | null }> };
      receipt: { revisionBefore: number; revisionAfter: number; idempotencyKey: string };
    }>(request, "POST", `/rpg/v1/quests/${questId}/commands`, {
      kind: "claim-reward", actorId, rewardId, expectedRevision: advanced.receipt.revisionAfter, idempotencyKey: `${runId}-quest-claim`,
    }, 200);
    expect(claimed.quest).toMatchObject({ status: "completed" });
    expect(claimed.quest.rewards).toContainEqual(expect.objectContaining({ rewardId, claimedByActorId: actorId, claimedAt: expect.any(String) }));
    expect(claimed.receipt).toMatchObject({ revisionBefore: 3, revisionAfter: 4, idempotencyKey: `${runId}-quest-claim` });
    expect(await json<typeof claimed>(request, "POST", `/rpg/v1/quests/${questId}/commands`, {
      kind: "claim-reward", actorId, rewardId, expectedRevision: advanced.receipt.revisionAfter, idempotencyKey: `${runId}-quest-claim`,
    }, 200)).toEqual(claimed);
  } finally {
    if (characterId) await request.delete(`/api/characters/${characterId}`).catch(() => undefined);
  }
});

test("M5.1 CampaignPlay manages authoritative NPC presence and stopped history", async ({ page, request }) => {
  const fixture = MECHANICS_STARTER_CATALOG;
  const pin = { packId: fixture.manifest.packId, packVersion: fixture.manifest.packVersion };
  const campaignName = `${runId}-M5.1-Presence`;
  const playerName = `${runId}-M5.1-Player`;
  const npcName = `${runId}-M5.1-Warden`;
  const locationId = `${runId}-m5.1-glass-harbor`;
  const locationName = `${runId}-M5.1-Glass-Harbor`;
  const locationDescription = "A deterministic public harbor.";
  const privateSentinel = `${runId}-PRIVATE-GOALS-NOTES`;
  const principalSentinel = "local-owner";

  await json(request, "POST", "/rpg/v1/content-packs", fixture);
  const playerPersona = await json<{ id: string }>(request, "POST", "/characters", {
    name: playerName, age: 32, archetype: "Steady navigator",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", { name: campaignName });
  const campaignId = campaign.campaign.id;
  const administration = await json<{ campaign: { revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`,
  );
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/content`, {
    rulesProfileId: fixture.manifest.compatibility.rulesProfileId,
    contentPacks: [pin],
    expectedRevision: administration.campaign.revision,
    idempotencyKey: `${runId}-m5.1-configure`,
  });

  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const draft = await json<{ draft: { id: string; revision: number } }>(
    request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts`, {
      personaId: playerPersona.id, durability: "durable", allocation: { method: "standard-array", scores },
      idempotencyKey: `${runId}-m5.1-draft`,
    },
  );
  const reference = (kind: "race" | "background" | "class") =>
    fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
  const selected = await json<{ draft: { revision: number } }>(
    request, "PATCH", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}`, {
      expectedRevision: draft.draft.revision,
      idempotencyKey: `${runId}-m5.1-select`,
      selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
    },
  );
  const finalized = await json<{ character: { id: string } }>(
    request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}/finalize`, {
      expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-m5.1-finalize`,
    }, 201,
  );
  expect(finalized.character.id).toBeTruthy();

  const room = await json<{ id: string }>(request, "POST", "/sessions", {
    characterId: playerPersona.id, title: `${runId}-M5.1-Room`,
  });
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/rooms`, { sessionId: room.id });

  const locationFixture = { campaignId, locationId, parentLocationId: null, name: locationName, description: locationDescription };
  const materializeLocation = (data: unknown, suffix = "") =>
    request.post(`/api/__e2e/materialize-campaign-location${suffix}`, { data });
  expect((await materializeLocation(locationFixture)).status()).toBe(204);
  expect((await materializeLocation(locationFixture)).status()).toBe(204);
  expect((await materializeLocation(locationFixture, "?unexpected=1")).status()).toBe(400);
  expect((await materializeLocation({ ...locationFixture, unexpected: true })).status()).toBe(400);
  expect((await materializeLocation({ ...locationFixture, parentLocationId: locationId })).status()).toBe(400);
  expect((await materializeLocation({ ...locationFixture, description: "Different fixture state." })).status()).toBe(409);

  const world = await json<{
    currentLocations: Array<{ actorId: string; locationId: string }>;
    visibleLocations: Array<{ locationId: string; parentLocationId: string | null; name: string; description: string }>;
    visibleConnections: Array<{ connectionId: string; fromLocationId: string; toLocationId: string }>;
  }>(request, "GET", `/rpg/v1/campaigns/${campaignId}/world`);
  expect(world).toEqual({
    currentLocations: [],
    visibleLocations: [{ locationId, parentLocationId: null, name: locationName, description: locationDescription }],
    visibleConnections: [],
  });

  const npcPersona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-M5.1-Private-Persona`, age: 41, archetype: "Harbor warden",
    boundaries: privateSentinel, fictionalConfirmed: true,
  });
  const npcCreationKey = `${runId}-m5.1-create-npc`;
  const npc = await json<{ npc: { npcId: string; personaId: string; publicState: { name: string }; privateState: { goals: string; gmNotes: string; merchantState: null } }; receipt: { revisionAfter: number } }>(
    request, "POST", `/rpg/v1/campaigns/${campaignId}/npcs`, {
      personaId: npcPersona.id, publicState: { name: npcName },
      privateState: { goals: privateSentinel, gmNotes: privateSentinel, merchantState: null },
      expectedRevision: 0, idempotencyKey: npcCreationKey,
    }, 201,
  );
  expect(npc.npc).toEqual(expect.objectContaining({
    personaId: npcPersona.id, publicState: { name: npcName },
    privateState: { goals: privateSentinel, gmNotes: privateSentinel, merchantState: null },
  }));

  await page.goto("/");
  await page.getByRole("button", { name: "Campaigns" }).click();
  await page.getByRole("button", { name: `Open campaign ${campaignName}` }).click();
  await page.getByRole("button", { name: "Open attached room 1 of 1" }).click();
  await expect(page.getByRole("heading", { name: "Adventure room" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "NPCs present now" })).toBeVisible();
  await expect(page.getByText("No NPCs marked present.")).toBeVisible();

  const presencePath = `/api/rpg/v1/campaigns/${campaignId}/rooms/${encodeURIComponent(room.id)}/npcs/${encodeURIComponent(npc.npc.npcId)}/presence-commands`;
  const castPath = `/api/rpg/v1/campaigns/${campaignId}/rooms/${encodeURIComponent(room.id)}/present-cast`;
  const presenceRequests: string[] = [];
  const commandKeys: string[] = [];
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (url.pathname === presencePath) {
      presenceRequests.push(browserRequest.method());
      const body = browserRequest.postDataJSON() as { idempotencyKey?: string } | null;
      if (body?.idempotencyKey) commandKeys.push(body.idempotencyKey);
    } else if (url.pathname === castPath) presenceRequests.push(browserRequest.method());
  });

  await page.getByLabel("NPC").selectOption(npc.npc.npcId);
  await page.getByLabel("Place location").selectOption(locationId);
  await page.getByRole("button", { name: "Place NPC" }).click();
  await expect(page.getByText("NPC presence updated from the authoritative present cast.")).toBeVisible();
  await expect(page.getByText(`${npcName} - ${locationName}`, { exact: true })).toBeVisible();
  expect(presenceRequests).toEqual(["POST", "GET"]);

  const assertNoPrivateClientState = async () => {
    const clientState = `${await page.locator("body").innerText()}\n${await page.evaluate(() => JSON.stringify(localStorage))}`;
    for (const secret of [privateSentinel, npcPersona.id, principalSentinel, npcCreationKey, ...commandKeys]) {
      expect(clientState).not.toContain(secret);
    }
  };
  await assertNoPrivateClientState();
  await page.reload();
  await expect(page.getByText(`${npcName} - ${locationName}`, { exact: true })).toBeVisible();
  await assertNoPrivateClientState();

  const moveLocation = page.getByLabel(`Move ${npcName} location`);
  await moveLocation.selectOption("");
  await page.getByRole("button", { name: `Move ${npcName}`, exact: true }).click();
  await expect(page.getByText(npcName, { exact: true })).toBeVisible();
  await expect(page.getByText(`${npcName} - ${locationName}`, { exact: true })).toHaveCount(0);
  await moveLocation.selectOption(locationId);
  await page.getByRole("button", { name: `Move ${npcName}`, exact: true }).click();
  await expect(page.getByText(`${npcName} - ${locationName}`, { exact: true })).toBeVisible();

  const remove = page.getByRole("button", { name: `Remove ${npcName}` });
  await remove.click();
  const confirmRemove = page.getByRole("button", { name: "Confirm remove" });
  await expect(confirmRemove).toBeFocused();
  await confirmRemove.click();
  await expect(page.getByText("No NPCs marked present.")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "NPC presence updated" })).toBeFocused();
  expect(presenceRequests).toEqual([
    "POST", "GET", "GET", "GET",
    "POST", "GET", "POST", "GET", "POST", "GET",
  ]);

  await page.getByLabel("NPC").selectOption(npc.npc.npcId);
  await page.getByLabel("Place location").selectOption(locationId);
  const ambiguousStart = presenceRequests.length;
  let committedPosts = 0;
  await page.route(`**${presencePath}`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    committedPosts += 1;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Place NPC" }).click();
  await expect(page.getByText(/NPC presence outcome is uncertain/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh present cast" })).toBeVisible();
  expect(committedPosts).toBe(1);
  expect(presenceRequests.slice(ambiguousStart)).toEqual(["POST"]);
  await page.getByRole("button", { name: "Refresh present cast" }).click();
  await expect(page.getByText("Present cast refreshed from the server.")).toBeVisible();
  await expect(page.getByText(`${npcName} - ${locationName}`, { exact: true })).toBeVisible();
  expect(committedPosts).toBe(1);
  expect(presenceRequests.slice(ambiguousStart)).toEqual(["POST", "GET"]);
  await page.unroute(`**${presencePath}`);
  await assertNoPrivateClientState();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const control of [page.getByRole("button", { name: `Move ${npcName}`, exact: true }), page.getByRole("button", { name: `Remove ${npcName}`, exact: true })]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await json(request, "POST", `/sessions/${room.id}/stop`, undefined, 200);
  const stoppedBefore = await json<{
    audience: "gm"; state: "stopped"; sessionRevision: number; castHistory: unknown[];
  }>(request, "GET", `/rpg/v1/campaigns/${campaignId}/rooms/${encodeURIComponent(room.id)}/present-cast`);
  expect(stoppedBefore).toMatchObject({
    audience: "gm", state: "stopped",
    castHistory: [expect.objectContaining({ npcId: npc.npc.npcId })],
  });
  const stoppedCommand = await request.post(presencePath, { data: {
    expectedRevision: stoppedBefore.sessionRevision,
    idempotencyKey: `${runId}-m5.1-stopped-remove`,
    mutation: { kind: "remove" },
  } });
  expect(stoppedCommand.status()).toBe(404);
  expect(stoppedCommand.headers()["content-type"]).toContain("application/problem+json");
  expect(await stoppedCommand.json()).toEqual({
    type: "https://velvet.local/problems/rpg-npc-presence-not-found",
    title: "Not found",
    status: 404,
    detail: "NPC presence not found",
    instance: "/api/rpg/v1/campaigns/:campaignId/*",
    code: "RPG_NPC_PRESENCE_NOT_FOUND",
    requestId: expect.any(String),
    error: "NPC presence not found",
  });
  const stoppedAfter = await json<typeof stoppedBefore>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/rooms/${encodeURIComponent(room.id)}/present-cast`,
  );
  expect(stoppedAfter).toEqual(stoppedBefore);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Present at stop/history" })).toBeVisible();
  await expect(page.getByText(`${npcName} - ${locationName}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/no longer writable/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^(?:Place|Move|Remove|Confirm remove)/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await assertNoPrivateClientState();
});

test("M5.4 CampaignPlay shows one provider-committed travel receipt across reload",async({page,request})=>{
  const fixture=MECHANICS_STARTER_CATALOG,pin={packId:fixture.manifest.packId,packVersion:fixture.manifest.packVersion};
  const persona=await json<{id:string}>(request,"POST","/characters",{name:`${runId}-M5.4-Traveler`,age:30,archetype:"Wayfinder",boundaries:"Fictional deterministic test only",fictionalConfirmed:true});
  await json(request,"POST","/rpg/v1/content-packs",fixture);
  const campaign=await json<{campaign:{id:string}}>(request,"POST","/rpg/v1/campaigns",{name:`${runId}-M5.4-Travel`});const campaignId=campaign.campaign.id;
  const admin=await json<{campaign:{revision:number}}>(request,"GET",`/rpg/v1/campaigns/${campaignId}/administration`);
  await json(request,"PUT",`/rpg/v1/campaigns/${campaignId}/content`,{rulesProfileId:fixture.manifest.compatibility.rulesProfileId,contentPacks:[pin],expectedRevision:admin.campaign.revision,idempotencyKey:`${runId}-m5.4-configure`});
  const configuredAdmin=await json<{campaign:{revision:number}}>(request,"GET",`/rpg/v1/campaigns/${campaignId}/administration`);
  await json(request,"PATCH",`/rpg/v1/campaigns/${campaignId}/administration`,{expectedRevision:configuredAdmin.campaign.revision,idempotencyKey:`${runId}-m5.4-publish`,status:"published"});
  const scores={might:15,agility:14,resolve:13,insight:12,presence:10,craft:8};
  const draft=await json<{draft:{id:string;revision:number}}>(request,"POST",`/rpg/v1/campaigns/${campaignId}/character-drafts`,{personaId:persona.id,durability:"durable",allocation:{method:"standard-array",scores},idempotencyKey:`${runId}-m5.4-draft`});
  const reference=(kind:"race"|"background"|"class")=>fixture.definitions.find((definition)=>definition.reference.kind===kind)!.reference;
  const selected=await json<{draft:{revision:number}}>(request,"PATCH",`/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}`,{expectedRevision:draft.draft.revision,idempotencyKey:`${runId}-m5.4-select`,selections:{race:reference("race"),background:reference("background"),class:reference("class"),starterGrant:"kit"}});
  const finalized=await json<{character:{id:string}}>(request,"POST",`/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}/finalize`,{expectedRevision:selected.draft.revision,idempotencyKey:`${runId}-m5.4-finalize`},201);
  const actorId=await actorForCampaignCharacter(request,campaignId,finalized.character.id);
  const room=await json<{id:string}>(request,"POST","/sessions",{characterId:persona.id,title:`${runId}-M5.4-Room`});
  await json(request,"PUT",`/rpg/v1/campaigns/${campaignId}/rooms`,{sessionId:room.id});
  const destinationName=`${runId}-M5.4-Silver-Harbor`,privateSentinels=[`${runId}-m5.4-road`,`${runId}-m5.4-origin`,`${runId}-m5.4-destination`,`exact_actor_travel.select`,`providerCallId`,`candidateId`,`canonicalActionDigest`];
  const prerequisite={campaignId,sessionId:room.id,actorId,originLocationId:`${runId}-m5.4-origin`,destinationLocationId:`${runId}-m5.4-destination`,connectionId:`${runId}-m5.4-road`,originName:`${runId}-M5.4-Old-Gate`,destinationName};
  expect((await request.post("/api/__e2e/materialize-travel-prerequisite",{data:prerequisite})).status()).toBe(204);
  expect((await request.post("/api/__e2e/materialize-travel-prerequisite",{data:prerequisite})).status()).toBe(204);
  await json(request,"GET",`/rpg/v1/campaigns/${campaignId}/rooms/${encodeURIComponent(room.id)}/play-bootstrap`);
  const receiptMethods:string[]=[],productionTraffic:string[]=[];const relevant=(pathname:string)=>pathname==="/api/rpg/v1/adventure-turns/stream"||pathname.includes("/adventure-turns/")||/\/commands\/[^/]+\/receipt$/.test(pathname);
  page.on("request",browserRequest=>{const url=new URL(browserRequest.url());
    if(url.pathname.match(/\/commands\/[^/]+\/receipt$/))receiptMethods.push(browserRequest.method());
    if(relevant(url.pathname))productionTraffic.push(browserRequest.postData()??"");});
  page.on("response",async response=>{const url=new URL(response.url());if(relevant(url.pathname)&&response.request().resourceType()!=="eventsource")
    productionTraffic.push(await response.text().catch(()=>""));});
  await page.goto("/");await page.getByRole("button",{name:"Campaigns"}).click();await page.getByRole("button",{name:`Open campaign ${runId}-M5.4-Travel`}).click();
  await page.getByRole("button",{name:"Open attached room 1 of 1"}).click();
  const travelStream=page.waitForRequest(browserRequest=>new URL(browserRequest.url()).pathname==="/api/rpg/v1/adventure-turns/stream");
  await page.getByLabel("What do you do?").fill("Travel to the public harbor.");await page.getByRole("button",{name:"Declare action"}).click();
  const submitted=await travelStream,submittedBody=submitted.postDataJSON() as {actorId:string;expectedRevision:number;idempotencyKey:string};expect(submittedBody).toMatchObject({actorId,expectedRevision:3});
  const receiptRegion=page.getByRole("region",{name:"Committed mechanics"});await expect(receiptRegion.getByText("Travel completed")).toBeVisible({timeout:15_000});await expect(receiptRegion.getByText(destinationName)).toBeVisible();
  expect(receiptMethods).toEqual(["GET"]);expect(await receiptRegion.getByText(destinationName).count()).toBe(1);
  const assertSafe=async()=>{const state=`${await page.locator("body").innerText()}\n${await page.evaluate(()=>JSON.stringify(localStorage))}\n${await page.evaluate(()=>JSON.stringify(sessionStorage))}`;
    for(const secret of privateSentinels){expect(state).not.toContain(secret);expect(productionTraffic.join("\n")).not.toContain(secret);}};
  await assertSafe();await page.reload();const reloadedReceipt=page.getByRole("region",{name:"Committed mechanics"});await expect(reloadedReceipt.getByText("Travel completed")).toBeVisible();await expect(reloadedReceipt.getByText(destinationName)).toBeVisible();
  expect(receiptMethods).toEqual(["GET","GET"]);expect(await reloadedReceipt.getByText(destinationName).count()).toBe(1);await assertSafe();
  const world=await json<{currentLocations:Array<{actorId:string;locationId:string}>}>(request,"GET",`/rpg/v1/campaigns/${campaignId}/world`);
  expect(world.currentLocations).toEqual([expect.objectContaining({actorId,locationId:prerequisite.destinationLocationId})]);
  const turn=await json<{result:{turn:{turnId:string}}}>(request,"GET",`/rpg/v1/adventure-turns/reconcile-initial?campaignId=${campaignId}&sessionId=${encodeURIComponent(room.id)}&actorId=${actorId}&idempotencyKey=${submittedBody.idempotencyKey}`);
  const evidence=await json<{executions:number;bindings:number;commands:number;events:number;revisionBefore:number;revisionAfter:number;actorRevision:number;locationId:string}>(request,"GET",
    `/__e2e/campaigns/${campaignId}/turns/${turn.result.turn.turnId}/actors/${actorId}/travel-evidence`);
  expect(evidence).toEqual({executions:1,bindings:1,commands:1,events:1,revisionBefore:0,revisionAfter:1,actorRevision:1,locationId:prerequisite.destinationLocationId});
  expect(await (await request.get("http://127.0.0.1:18788/stats")).json()).toEqual({exactTravelSelections:1});
});

test("M5.2 companion administration creates, grants, revokes, and replays safely", async ({ request }) => {
  const fixture = MECHANICS_STARTER_CATALOG;
  const pin = { packId: fixture.manifest.packId, packVersion: fixture.manifest.packVersion };
  await json(request, "POST", "/rpg/v1/content-packs", fixture);
  const persona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-M5.2-Actor`, age: 30, archetype: "Companion keeper",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", {
    name: `${runId}-M5.2-Companion`,
  });
  const campaignId = campaign.campaign.id;
  const administration = await json<{ campaign: { revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`,
  );
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/content`, {
    rulesProfileId: fixture.manifest.compatibility.rulesProfileId, contentPacks: [pin],
    expectedRevision: administration.campaign.revision, idempotencyKey: `${runId}-m5.2-content`,
  });
  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const draft = await json<{ draft: { id: string; revision: number } }>(
    request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts`, {
      personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores },
      idempotencyKey: `${runId}-m5.2-draft`,
    },
  );
  const reference = (kind: "race" | "background" | "class") =>
    fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
  const selected = await json<{ draft: { revision: number } }>(
    request, "PATCH", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}`, {
      expectedRevision: draft.draft.revision, idempotencyKey: `${runId}-m5.2-select`,
      selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
    },
  );
  const finalized = await json<{ character: { id: string } }>(
    request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}/finalize`, {
      expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-m5.2-finalize`,
    }, 201,
  );
  const actorId = await actorForCampaignCharacter(request, campaignId, finalized.character.id);
  const room = await json<{ id: string }>(request, "POST", "/sessions", {
    characterId: persona.id, title: `${runId}-M5.2-Room`,
  });
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/rooms`, { sessionId: room.id });
  const npcPersona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-M5.2-NPC-Persona`, age: 38, archetype: "Companion guide",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  const npc = await json<{ npc: { npcId: string } }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/npcs`, {
    personaId: npcPersona.id, publicState: { name: `${runId}-M5.2-Guide` },
    privateState: { goals: "Guide safely", gmNotes: "E2E only", merchantState: null },
    expectedRevision: 0, idempotencyKey: `${runId}-m5.2-npc`,
  }, 201);
  await json(request, "POST", `/rpg/v1/campaigns/${campaignId}/rooms/${room.id}/npcs/${npc.npc.npcId}/presence-commands`, {
    expectedRevision: 0, idempotencyKey: `${runId}-m5.2-presence`, mutation: { kind: "place", locationId: null },
  }, 200);

  const lane = `/rpg/v1/campaigns/${campaignId}/npcs/${npc.npc.npcId}/companion-administration`;
  const createCommand = { kind: "companion-create" as const, sessionId: room.id, expectedRevision: 0,
    idempotencyKey: `${runId}-m5.2-create` };
  const created = await json<{ receipt: { kind: string; revisionBefore: number; revisionAfter: number; occurredAt: string } }>(
    request, "POST", `${lane}/commands`, createCommand, 200,
  );
  expect(Object.keys(created.receipt)).toEqual(["kind", "revisionBefore", "revisionAfter", "occurredAt"]);
  expect(JSON.stringify(created)).not.toMatch(/commandId|receiptId|grantId|digest|outcome|idempotencyKey/i);
  expect(await json<typeof created>(request, "POST", `${lane}/commands`, createCommand, 200)).toEqual(created);
  expect(await json<{ companion: { sessionId: string; revision: number; grants: unknown[] } }>(request, "GET", lane))
    .toEqual({ companion: expect.objectContaining({ sessionId: room.id, revision: 1, grants: [] }) });

  const currentAdministration = await json<{ campaign: { revision: number } }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`,
  );
  await json(request, "POST", `/rpg/v1/campaigns/${campaignId}/memberships`, {
    principalId: "e2e-membership-principal", role: "player", expectedRevision: currentAdministration.campaign.revision,
    idempotencyKey: `${runId}-m5.2-member`,
  }, 200);
  const grantCommand = {
    kind: "grant-create" as const, granteePrincipalId: "e2e-membership-principal",
    allowedCommandFamilies: ["rest"], actorScope: { kind: "campaign-actor", actorId },
    resourceScope: { kind: "actor-resources" }, maxSpend: 3, maxUses: 2,
    startsAt: "2035-01-01T00:00:00.000Z", expiresAt: "2036-01-01T00:00:00.000Z",
    confirmationPolicy: "always", expectedRevision: 1, idempotencyKey: `${runId}-m5.2-grant`,
  };
  const granted = await json<typeof created>(request, "POST", `${lane}/commands`, grantCommand, 200);
  expect(Object.keys(granted.receipt)).toEqual(["kind", "revisionBefore", "revisionAfter", "occurredAt"]);
  expect(JSON.stringify(granted)).not.toMatch(/commandId|receiptId|grantId|digest|outcome|idempotencyKey/i);
  expect(await json<typeof granted>(request, "POST", `${lane}/commands`, grantCommand, 200)).toEqual(granted);
  const management = await json<{ companion: { revision: number; grants: Array<{
    grantId: string; granteePrincipalId: string; maxSpend: number | null; maxUses: number | null;
    revokedAt: string | null; exercise: { available: false; reason: string };
  }> } }>(request, "GET", lane);
  expect(management.companion).toMatchObject({ revision: 2, grants: [{
    granteePrincipalId: "e2e-membership-principal", maxSpend: 3, maxUses: 2, revokedAt: null,
    exercise: { available: false, reason: "requires-authenticated-principal-boundary-l5" },
  }] });
  const grantId = management.companion.grants[0]!.grantId;
  const revokeCommand = { kind: "grant-revoke" as const, grantId, reason: "Deterministic E2E revocation",
    expectedRevision: 2, idempotencyKey: `${runId}-m5.2-revoke` };
  const revoked = await json<typeof created>(request, "POST", `${lane}/commands`, revokeCommand, 200);
  expect(Object.keys(revoked.receipt)).toEqual(["kind", "revisionBefore", "revisionAfter", "occurredAt"]);
  expect(JSON.stringify(revoked)).not.toMatch(/commandId|receiptId|grantId|digest|outcome|idempotencyKey/i);
  expect(await json<typeof revoked>(request, "POST", `${lane}/commands`, revokeCommand, 200)).toEqual(revoked);
  const revokedManagement = await json<typeof management>(request, "GET", lane);
  expect(revokedManagement.companion.revision).toBe(3);
  expect(revokedManagement.companion.grants[0]).toMatchObject({
    grantId, revokedAt: expect.any(String), exercise: { available: false },
  });
});

test("M5.3 browser reconciles one committed consumable POST without replay", async ({ page, request }) => {
  const fixture = MECHANICS_STARTER_CATALOG;
  const pin = { packId: fixture.manifest.packId, packVersion: fixture.manifest.packVersion };
  const consumables = consumableCatalog();
  const consumablePin = { packId: consumables.manifest.packId, packVersion: consumables.manifest.packVersion };
  const consumableItem = consumables.definitions.find((definition) => definition.reference.kind === "item")!.reference;
  await json(request, "POST", "/rpg/v1/content-packs", fixture);
  const publishedConsumables = await json<{ catalog: { publication: { packId: string; packVersion: string; digest: string } } }>(
    request, "POST", "/rpg/v1/content-packs", consumables,
  );
  expect(publishedConsumables.catalog.publication).toMatchObject({ ...consumablePin, digest: consumables.manifest.digest });
  const persona = await json<{ id: string }>(request, "POST", "/characters", {
    name: `${runId}-M5.3-Actor`, age: 30, archetype: "Tonic bearer",
    boundaries: "Fictional deterministic test only", fictionalConfirmed: true,
  });
  const campaignName = `${runId}-M5.3-Consumable`;
  const campaign = await json<{ campaign: { id: string } }>(request, "POST", "/rpg/v1/campaigns", { name: campaignName });
  const campaignId = campaign.campaign.id;
  const administration = await json<{ campaign: { revision: number } }>(request, "GET", `/rpg/v1/campaigns/${campaignId}/administration`);
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/content`, {
    rulesProfileId: fixture.manifest.compatibility.rulesProfileId, contentPacks: [pin, consumablePin],
    expectedRevision: administration.campaign.revision, idempotencyKey: `${runId}-m5.3-content`,
  });
  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const draft = await json<{ draft: { id: string; revision: number } }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts`, {
    personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${runId}-m5.3-draft`,
  });
  const reference = (kind: "race" | "background" | "class") => fixture.definitions.find((definition) => definition.reference.kind === kind)!.reference;
  const selected = await json<{ draft: { revision: number } }>(request, "PATCH", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}`, {
    expectedRevision: draft.draft.revision, idempotencyKey: `${runId}-m5.3-select`,
    selections: { race: reference("race"), background: reference("background"), class: reference("class"), starterGrant: "kit" },
  });
  const finalized = await json<{ character: { id: string } }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/character-drafts/${draft.draft.id}/finalize`, {
    expectedRevision: selected.draft.revision, idempotencyKey: `${runId}-m5.3-finalize`,
  }, 201);
  const actorId = await actorForCampaignCharacter(request, campaignId, finalized.character.id);
  const entryId = `${runId}-m5.3-tonic`;
  const execution = await request.post("/api/__e2e/materialize-pinned-item-execution", {
    data: { campaignId, item: consumableItem },
  });
  expect(execution.status()).toBe(204);
  const materialized = await request.post("/api/__e2e/materialize-consumable-entry", {
    data: { campaignId, actorId, entryId, item: consumableItem, expectedRevision: 0 },
  });
  expect(materialized.status()).toBe(204);
  const room = await json<{ id: string }>(request, "POST", "/sessions", { characterId: persona.id, title: `${runId}-M5.3-Room` });
  await json(request, "PUT", `/rpg/v1/campaigns/${campaignId}/rooms`, { sessionId: room.id });
  const encounter = await json<{ encounter: { encounterId: string; revision: number } }>(request, "POST", `/rpg/v1/campaigns/${campaignId}/encounters`, {
    sessionId: room.id, name: `${runId}-M5.3-Encounter`, combatants: [{ kind: "actor", actorId, team: "allies" }],
    idempotencyKey: `${runId}-m5.3-encounter`,
  }, 201);
  const started = await json<{ combat: { combatId: string; revision: number } }>(request, "POST", `/rpg/v1/encounters/${encounter.encounter.encounterId}/start-commands`, {
    expectedRevision: encounter.encounter.revision, idempotencyKey: `${runId}-m5.3-start`,
  }, 200);
  const actionsPath = `/api/rpg/v1/combats/${started.combat.combatId}/consumable-actions`;
  const actions = await json<Array<{ inventoryEntryId: string; item: typeof consumableItem; quantity: number; actionCost: string; target: { actorBacked: boolean } }>>(
    request, "GET", `/rpg/v1/combats/${started.combat.combatId}/consumable-actions`,
  );
  expect(actions).toEqual([expect.objectContaining({ inventoryEntryId: entryId, item: consumableItem, quantity: 1, actionCost: "action",
    target: expect.objectContaining({ actorBacked: true }) })]);

  await page.goto("/");
  await page.getByRole("button", { name: "Campaigns" }).click();
  await page.getByRole("button", { name: `Open campaign ${campaignName}` }).click();
  await page.getByRole("button", { name: "Open combat tracker" }).click();
  await page.getByLabel("Campaign encounter").selectOption(started.combat.combatId);
  await page.getByRole("button", { name: "Load combat" }).click();
  await expect(page.getByRole("heading", { name: "Consumables" })).toBeVisible();
  await expect(page.getByText("Quantity 1 · Cost: action.")).toBeVisible();
  const use = page.getByRole("button", { name: `Use ${consumableItem.definitionId} on ${actorId}` });
  await expect(use).toBeVisible();

  const commandPath = `${actionsPath}/commands`;
  const commandRequests: string[] = [];
  page.on("request", (browserRequest) => {
    if (new URL(browserRequest.url()).pathname === commandPath) commandRequests.push(browserRequest.method());
  });
  let committedPosts = 0;
  await page.route(`**${commandPath}`, async (route) => {
    committedPosts += 1;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort("failed");
  });
  await use.click();
  await expect(page.getByText(/Consumable outcome is ambiguous/)).toBeVisible();
  expect(committedPosts).toBe(1);
  expect(commandRequests).toEqual(["POST"]);
  await page.getByRole("button", { name: "Read exact result & refresh" }).click();
  await expect(page.getByRole("heading", { name: "Confirmed consumable receipt" })).toBeVisible();
  await expect(page.getByText("combat-hp-healing: 1")).toBeVisible();
  expect(committedPosts).toBe(1);
  expect(commandRequests).toEqual(["POST"]);
  await page.unroute(`**${commandPath}`);

  const inventory = await json<{ entries: Array<{ entryId: string }>; revision: number }>(
    request, "GET", `/rpg/v1/campaigns/${campaignId}/actors/${actorId}/inventory`,
  );
  expect(inventory.entries.map((entry) => entry.entryId)).not.toContain(entryId);
  expect(inventory.revision).toBe(1);
  const combat = await json<{ revision: number }>(request, "GET", `/rpg/v1/combats/${started.combat.combatId}`);
  expect(combat.revision).toBe(started.combat.revision + 1);
  expect(await json<unknown[]>(request, "GET", `/rpg/v1/combats/${started.combat.combatId}/consumable-actions`)).toEqual([]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Combat tracker" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Use .* on/ })).toHaveCount(0);
  expect(committedPosts).toBe(1);
  expect(commandRequests).toEqual(["POST"]);
});
