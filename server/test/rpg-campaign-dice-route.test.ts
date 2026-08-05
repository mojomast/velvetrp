import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import type { CampaignDiceEvent } from "../src/repo/index.js";

process.env.NODE_ENV = "test";
const AT = "2030-01-02T03:04:05.006Z";
const result = {
  expression: "1d20", normalized: { count: 1, sides: 20, selection: { type: "all" as const }, modifier: 0 },
  terms: [{ value: 11, kept: true }], modifier: 0, total: 11,
};

function repository() {
  const unit = {
    getCampaign: vi.fn(() => ({ id: "campaign", name: "Campaign", activeTimelineId: "timeline",
      ownerPrincipalId: "local-owner", createdAt: AT, updatedAt: AT, actorRole: "owner" })),
    getCampaignTimeline: vi.fn(() => ({ id: "timeline", campaignId: "campaign", revision: 0, createdAt: AT })),
    getCampaignCharacterRoster: vi.fn(() => ({ campaignId: "campaign", characters: [
      { id: "cc", characterId: "persona", name: "Aria" },
    ] })),
    listCampaignCharacters: vi.fn(() => [{ projection: {
      campaignCharacter: { id: "cc" }, actor: { id: "actor" },
    } }]),
    listRecentCampaignDiceEvents: vi.fn(() => [] as CampaignDiceEvent[]),
  };
  const executeRollActorDiceForVisibleCharacter = vi.fn((
    _: string, envelope: CommandEnvelope, _binding?: unknown,
  ) => ({
    commandId: envelope.commandId, campaignId: envelope.campaignId, revisionBefore: 0, revisionAfter: 1,
    events: [{ eventId: "event", commandId: envelope.commandId, campaignId: envelope.campaignId,
      timelineId: envelope.timelineId, actorId: envelope.actorId, sourceTurnId: null,
      type: "actor_dice_rolled" as const, revision: 1, occurredAt: AT, data: result }],
  }));
  return {
    listCampaigns: vi.fn(() => []), getCampaignDetail: vi.fn(() => null),
    createCampaign: vi.fn(), getCampaignCharacterCreationOptions: vi.fn(() => null),
    getCampaignCharacterRoster: unit.getCampaignCharacterRoster,
    getCampaignCharacterWorkspace: vi.fn(() => null), createOriginalStarterCampaignCharacter: vi.fn(),
    renameCampaignIfUnchanged: vi.fn(), close: vi.fn(),
    transaction: vi.fn((callback: (input: typeof unit) => unknown) => callback(unit)),
    executeRollActorDiceForVisibleCharacter,
    unit,
  };
}

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  vi.restoreAllMocks();
});

describe("GET/POST /api/rpg/v1/campaigns/:campaignId/dice-rolls", () => {
  it("requires both flags before repository or command ID access", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo as never);
    const ids = { nextId: vi.fn(() => "internal-command") };
    const app = buildApp({ campaignRepositoryFactory: factory, diceCommandIds: ids });
    for (const method of ["GET", "POST"] as const) {
      const response = await app.inject({ method, url: "/api/rpg/v1/campaigns/campaign/dice-rolls",
        ...(method === "POST" ? { payload: { character: { position: 1, name: "Aria" }, expression: "1d20" } } : {}) });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND" });
    }
    expect(factory).not.toHaveBeenCalled();
    expect(ids.nextId).not.toHaveBeenCalled();
    await app.close();
  });

  it("serves strict safe history and executes one fixed-owner command without caller IDs", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const repo = repository();
    const ids = { nextId: vi.fn(() => "internal-command") };
    const app = buildApp({ campaignRepositoryFactory: () => repo as never, diceCommandIds: ids });
    const read = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/dice-rolls",
      headers: { "x-principal-id": "attacker", authorization: "Bearer attacker" } });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.json()).toEqual({ characters: [{ position: 1, name: "Aria" }], rolls: [] });

    const write = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/dice-rolls",
      headers: { "x-command-id": "attacker", "idempotency-key": "attacker" },
      payload: { character: { position: 1, name: "Aria" }, expression: "1d20" } });
    expect(write.statusCode).toBe(201);
    expect(write.headers.location).toBeUndefined();
    expect(write.headers["cache-control"]).toBe("no-store");
    expect(write.json()).toEqual({ roll: { character: { position: 1, name: "Aria" }, occurredAt: AT, result } });
    expect(repo.executeRollActorDiceForVisibleCharacter).toHaveBeenCalledOnce();
    expect(repo.executeRollActorDiceForVisibleCharacter.mock.calls[0]![0]).toBe("local-owner");
    expect(repo.executeRollActorDiceForVisibleCharacter.mock.calls[0]![1]).toMatchObject({
      commandId: "internal-command", idempotencyKey: "internal-command", actorId: "actor", sourceTurnId: null,
    });
    expect(repo.executeRollActorDiceForVisibleCharacter.mock.calls[0]![2]).toEqual({
      position: 1, name: "Aria", campaignCharacterId: "cc",
    });
    await app.close();
  });

  it("returns revision-ordered history when canonical timestamps run backward", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const repo = repository();
    const laterTimestamp = "2030-01-02T03:04:06.000Z";
    repo.unit.listRecentCampaignDiceEvents.mockReturnValueOnce([
      { eventId: "event-2", commandId: "command-2", campaignId: "campaign", timelineId: "timeline",
        actorId: "actor", sourceTurnId: null, type: "actor_dice_rolled", revision: 2,
        occurredAt: AT, data: result },
      { eventId: "event-1", commandId: "command-1", campaignId: "campaign", timelineId: "timeline",
        actorId: "actor", sourceTurnId: null, type: "actor_dice_rolled", revision: 1,
        occurredAt: laterTimestamp, data: result },
    ]);
    const app = buildApp({ campaignRepositoryFactory: () => repo as never,
      diceCommandIds: { nextId: () => "unused" } });
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/dice-rolls" });
    expect(response.statusCode).toBe(200);
    expect(response.json().rolls.map((roll: { occurredAt: string }) => roll.occurredAt))
      .toEqual([AT, laterTimestamp]);
    await app.close();
  });

  it("rejects query, media, body extras, malformed paths, HEAD, and unrelated methods", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo as never, diceCommandIds: { nextId: () => "id" } });
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/dice-rolls?x=1" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/dice-rolls",
      headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/dice-rolls",
      payload: { character: { position: 1, name: "Aria" }, expression: "1d20", actorId: "actor" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/bad%20id/dice-rolls" })).statusCode).toBe(404);
    for (const method of ["HEAD", "PUT", "PATCH", "DELETE"] as const) {
      expect((await app.inject({ method, url: "/api/rpg/v1/campaigns/campaign/dice-rolls" })).statusCode).toBe(404);
    }
    expect(repo.executeRollActorDiceForVisibleCharacter).not.toHaveBeenCalled();
    await app.close();
  });
});
