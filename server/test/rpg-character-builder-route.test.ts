import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { characterBuilderHttpRoutes } from "../src/routes/rpg/v1/characterBuilder.js";

process.env.NODE_ENV = "test";
const draft = {
  id: "draft-1", campaignId: "campaign-1", personaId: "persona-1", controllerPrincipalId: "local-owner", role: "owner", status: "active", durability: "durable", expiresAt: null,
  effectivelyExpired: false, revision: 0, rulesProfileId: "rules-profile-1",
  pins: [{ packId: "pack-1", packVersion: "1.0.0", publicationDigest: "a".repeat(64) }],
  allocation: { method: "manual", scores: { might: 10, agility: 10, resolve: 10, insight: 10, presence: 10, craft: 10 } },
  selections: { race: null, background: null, class: null, starterGrant: null },
  choiceGroups: [
    { id: "race", required: true, options: [{ reference: { kind: "race", packId: "pack-1", packVersion: "1.0.0", definitionId: "race-1" }, name: "Human", description: "A human" }] },
    { id: "background", required: true, options: [{ reference: { kind: "background", packId: "pack-1", packVersion: "1.0.0", definitionId: "background-1" }, name: "Sage", description: "A sage" }] },
    { id: "class", required: true, options: [{ reference: { kind: "class", packId: "pack-1", packVersion: "1.0.0", definitionId: "class-1" }, name: "Fighter", description: "A fighter" }] },
    { id: "starter-grant", required: true, options: ["kit", "currency"] },
  ],
  completion: { complete: false, issues: [{ code: "missing-race", path: "selections.race", message: "Choose a race" }] },
  derivedPreview: null, startingGrants: [], createdAt: "2036-01-01T00:00:00.000Z", updatedAt: "2036-01-01T00:00:00.000Z",
};
const occurredAt = "2036-01-01T00:00:02.000Z";
const derived = { maxHp: 10, defenses: { guard: 10, evasion: 10, will: 10 }, initiative: 0, speed: 30, carryingLimit: 100, spellAttack: 2, saveDc: 10,
  explanations: ["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"].map((statistic) => ({ statistic, formula: "server", inputs: {}, result: 10 })) };
const race = { kind: "race", packId: "pack-1", packVersion: "1.0.0", definitionId: "race-1" };
const background = { kind: "background", packId: "pack-1", packVersion: "1.0.0", definitionId: "background-1" };
const characterClass = { kind: "class", packId: "pack-1", packVersion: "1.0.0", definitionId: "class-1" };
function repository() {
  return {
    createCharacterDraft: vi.fn(() => ({ draft, receipt: { draftId: "draft-1", commandId: "command-1", idempotencyKey: "idem-1", type: "create", revisionBefore: 0, revisionAfter: 0, occurredAt: draft.createdAt, draft } })),
    getCharacterDraft: vi.fn(() => draft),
    updateCharacterDraft: vi.fn(() => ({ draft: { ...draft, revision: 1, updatedAt: "2036-01-01T00:00:01.000Z" }, receipt: { draftId: "draft-1", commandId: "command-2", idempotencyKey: "idem-2", type: "update", revisionBefore: 0, revisionAfter: 1, occurredAt: "2036-01-01T00:00:01.000Z", draft: { ...draft, revision: 1, updatedAt: "2036-01-01T00:00:01.000Z" } } })),
    finalizeCharacterDraft: vi.fn(() => ({ draft: { ...draft, status: "finalized", revision: 1, updatedAt: occurredAt }, receipt: {
      draftId: "draft-1", commandId: "command-final", eventId: "event-final", idempotencyKey: "idem-final", revisionBefore: 0, revisionAfter: 1,
      occurredAt, campaignCharacterId: "character-final", sheetId: "sheet-final", actorId: "actor-final", derived, startingGrants: [],
    } })),
    getCampaignCharacter: vi.fn(() => ({ access: "privileged", projection: {
      campaignCharacter: { id: "character-final", campaignId: "campaign-1", characterId: "persona-1", createdAt: occurredAt, updatedAt: occurredAt },
      sheet: { id: "sheet-final", campaignId: "campaign-1", campaignCharacterId: "character-final", race, background,
        classes: [{ class: characterClass, level: 1 }], attributes: [], proficiencies: [], choices: [], createdAt: occurredAt, updatedAt: occurredAt },
      actor: { id: "actor-final", campaignId: "campaign-1", campaignCharacterId: "character-final", sheetId: "sheet-final", kind: "player-character", control: "principal", controllerPrincipalId: "local-owner", privateNotes: null, createdAt: occurredAt, updatedAt: occurredAt },
    } })),
    listActorResources: vi.fn(() => [{ campaignId: "campaign-1", actorId: "actor-final", name: "health", current: 10, max: 10 }]),
  };
}
async function appFor(repo = repository()) {
  const app = Fastify();
  await app.register(characterBuilderHttpRoutes, { prefix: "/api/rpg/v1", characterBuilderRepositoryAccessor: () => repo as any, featureFlags: () => ({ mechanics: true }) });
  return app;
}
afterEach(() => vi.restoreAllMocks());

describe("isolated character draft HTTP lane", () => {
  it("creates with fixed principal and omits private/audit fields", async () => {
    const repo = repository(); const app = await appFor(repo);
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign-1/character-drafts", payload: {
      personaId: "persona-1", durability: "durable", allocation: draft.allocation, idempotencyKey: "idem-1",
    }, headers: { "content-type": "application/json", authorization: "Bearer attacker" } });
    expect(response.statusCode, response.body).toBe(201); expect(response.body).not.toMatch(/controller|commandId/);
    expect(repo.createCharacterDraft).toHaveBeenCalledWith("local-owner", "campaign-1", expect.objectContaining({ controllerPrincipalId: "local-owner" }));
    await app.close();
  });
  it("orders feature/query/path/media/body validation and rejects bare queries", async () => {
    const repo = repository(); const app = Fastify();
    await app.register(characterBuilderHttpRoutes, { prefix: "/api/rpg/v1", characterBuilderRepositoryAccessor: () => repo as any, featureFlags: () => ({ mechanics: false }) });
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/bad%20id/character-drafts?secret=x", payload: "{", headers: { "content-type": "text/plain" } })).statusCode).toBe(404);
    await app.close();
    const enabled = await appFor(repo);
    expect((await enabled.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign-1/character-drafts/draft-1?x=1" })).statusCode).toBe(400);
    expect(repo.getCharacterDraft).not.toHaveBeenCalled(); await enabled.close();
  });
  it("binds campaign and draft paths exactly", async () => {
    const repo = repository(); const app = await appFor(repo);
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/other/character-drafts/draft-1" })).statusCode).toBe(404);
    expect(repo.getCharacterDraft).toHaveBeenCalledWith("local-owner", "draft-1"); await app.close();
  });
  it("checks campaign ownership before a patch and never mutates a cross-campaign draft", async () => {
    const repo = repository(); const app = await appFor(repo);
    const response = await app.inject({ method: "PATCH", url: "/api/rpg/v1/campaigns/other/character-drafts/draft-1", payload: {
      expectedRevision: 0, idempotencyKey: "idem-cross-campaign", selections: { race: { kind: "race", packId: "pack-1", packVersion: "1.0.0", definitionId: "race-1" } },
    }, headers: { "content-type": "application/json" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "CHARACTER_DRAFT_NOT_FOUND" });
    expect(repo.getCharacterDraft).toHaveBeenCalledWith("local-owner", "draft-1");
    expect(repo.updateCharacterDraft).not.toHaveBeenCalled();
    await app.close();
  });
  it("uses one repository call and exact revision/idempotency values", async () => {
    const repo = repository(); const app = await appFor(repo);
    const response = await app.inject({ method: "PATCH", url: "/api/rpg/v1/campaigns/campaign-1/character-drafts/draft-1", payload: {
      expectedRevision: 0, idempotencyKey: "idem-2", selections: { race: { kind: "race", packId: "pack-1", packVersion: "1.0.0", definitionId: "race-1" } },
    }, headers: { "content-type": "application/json" } });
    expect(response.statusCode, response.body).toBe(200); expect(repo.updateCharacterDraft).toHaveBeenCalledOnce();
    expect(repo.updateCharacterDraft).toHaveBeenCalledWith("local-owner", "draft-1", expect.objectContaining({ expectedRevision: 0, idempotencyKey: "idem-2" })); await app.close();
  });
  it("finalizes with only the strict public aggregate and a 201 receipt", async () => {
    const repo = repository(); const app = await appFor(repo);
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign-1/character-drafts/draft-1/finalize",
      payload: { expectedRevision: 0, idempotencyKey: "idem-final" }, headers: { "content-type": "application/json" } });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual({
      character: { id: "character-final", createdAt: occurredAt, updatedAt: occurredAt },
      sheet: { id: "sheet-final", race, background, classes: [{ class: characterClass, level: 1 }], attributes: [], proficiencies: [], choices: [], createdAt: occurredAt, updatedAt: occurredAt },
      resources: [{ name: "health", current: 10, max: 10 }],
      receipt: { idempotencyKey: "idem-final", revisionBefore: 0, revisionAfter: 1, occurredAt, derived, startingGrants: [] },
    });
    expect(response.body).not.toMatch(/local-owner|principal|role|command-final|event-final|actor-final|campaignId|characterId|sheetId|draftId/);
    expect(repo.finalizeCharacterDraft).toHaveBeenCalledOnce();
    await app.close();
  });
});
