import { afterEach, describe, expect, it, vi } from "vitest";
import type { NpcCastHttp, NpcPresenceMutationHttpResponse } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import {
  WorldAuthorizationError,
  WorldConflictError,
  WorldStaleError,
  WorldUnavailableError,
} from "../src/repo/index.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

const at = "2035-01-01T00:00:00.000Z";
const later = "2035-01-01T00:01:00.000Z";
const publicState = { name: "Marrow" };
const privateState = { goals: "Trade", gmNotes: "Secret", merchantState: null };
const basePresence = { npcId: "npc", publicState, revision: 1, presentAt: at, updatedAt: at };
const gmRunning: NpcCastHttp = {
  audience: "gm", state: "running", sessionRevision: 3,
  presentCast: [{ ...basePresence, location: { locationId: "hall", label: "Great Hall" },
    personaId: "persona", principals: ["local-owner"], privateState }],
};
const playerRunning: NpcCastHttp = {
  audience: "player", state: "running", sessionRevision: 3,
  presentCast: [{ ...basePresence, location: { label: "Great Hall" } }],
};
const gmStopped: NpcCastHttp = {
  audience: "gm", state: "stopped", sessionRevision: 4,
  castHistory: [{ ...basePresence, updatedAt: later, leftAt: later,
    lastLocation: { locationId: "hall", label: "Great Hall" }, personaId: "persona",
    principals: ["local-owner"], privateState }],
};
const playerStopped: NpcCastHttp = {
  audience: "player", state: "stopped", sessionRevision: 4,
  castHistory: [{ ...basePresence, updatedAt: later, leftAt: later, lastLocation: null }],
};
const body = { expectedRevision: 3, idempotencyKey: "presence-command", mutation: { kind: "move", locationId: "hall" } } as const;
const receipt: NpcPresenceMutationHttpResponse = {
  receipt: { kind: "move", revisionBefore: 3, revisionAfter: 4, occurredAt: later },
};

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
});

function enable(campaign = true, mechanics = true): void {
  if (campaign) process.env.FEATURE_RPG_CAMPAIGN = "true";
  if (mechanics) process.env.FEATURE_RPG_MECHANICS = "true";
}

function repository(overrides: Record<string, unknown> = {}): CampaignListRepository {
  return {
    close: vi.fn(), listCampaigns: vi.fn(() => []),
    getNpcCast: vi.fn(() => gmRunning), mutateNpcPresence: vi.fn(() => receipt),
    ...overrides,
  } as unknown as CampaignListRepository;
}

describe("M5.1 NPC presence HTTP routes", () => {
  it("uses path identities, fixed local ownership, and a once-decoded opaque session", async () => {
    enable();
    const sessionId = " room/opaque%value ";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const hostile = { authorization: "Bearer attacker", "x-principal-id": "attacker", "x-user-id": "attacker" };
    const read = await app.inject({ method: "GET",
      url: `/api/rpg/v1/campaigns/campaign/rooms/${encodeURIComponent(sessionId)}/present-cast`, headers: hostile });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.headers["x-npc-presence-revision"]).toBe("3");
    expect(read.json()).toEqual(gmRunning);

    const command = await app.inject({ method: "POST",
      url: `/api/rpg/v1/campaigns/campaign/rooms/${encodeURIComponent(sessionId)}/npcs/npc/presence-commands`,
      headers: { ...hostile, "content-type": "application/json; charset=utf-8" }, payload: body });
    expect(command.statusCode).toBe(200);
    expect(command.headers["cache-control"]).toBe("no-store");
    expect(command.json()).toEqual(receipt);
    expect(repo.getNpcCast).toHaveBeenCalledWith("local-owner", "campaign", sessionId);
    expect(repo.mutateNpcPresence).toHaveBeenCalledWith("local-owner", {
      campaignId: "campaign", sessionId, npcId: "npc", ...body,
    });
    await app.close();
  });

  it("sends the exact role and lifecycle projection without privacy-shape drift", async () => {
    enable();
    for (const cast of [gmRunning, playerRunning, gmStopped, playerStopped]) {
      const app = buildApp({ campaignRepositoryFactory: () => repository({ getNpcCast: vi.fn(() => cast) }) });
      const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/room/present-cast" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-npc-presence-revision"]).toBe(String(cast.sessionRevision));
      expect(response.json()).toEqual(cast);
      if (cast.audience === "player") expect(response.body).not.toMatch(/privateState|personaId|principals|locationId/);
      await app.close();
    }
  });

  it("applies both gates before validation or accessor use", async () => {
    let opens = 0;
    const app = buildApp({ campaignRepositoryFactory: () => { opens += 1; return repository(); } });
    for (const flags of [[], ["campaign"], ["mechanics"]] as string[][]) {
      delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS;
      enable(flags.includes("campaign"), flags.includes("mechanics"));
      const read = await app.inject({ method: "GET",
        url: "/api/rpg/v1/campaigns/%20/rooms/room/present-cast?hostile=secret",
        headers: { "content-type": "application/json" }, payload: { hostile: "body-secret" } });
      const command = await app.inject({ method: "POST",
        url: "/api/rpg/v1/campaigns/%20/rooms/room/npcs/%20/presence-commands?hostile=secret",
        headers: { "content-type": "text/plain" }, payload: "invalid" });
      expect(read.statusCode).toBe(404); expect(command.statusCode).toBe(404);
      expect(read.body).not.toContain("secret"); expect(command.body).not.toContain("secret");
    }
    expect(opens).toBe(0);
    await app.close();
  });

  it("rejects every present-cast body after gate, query, and path validation without accessor use", async () => {
    enable();
    const getNpcCast = vi.fn(() => gmRunning);
    const app = buildApp({ campaignRepositoryFactory: () => repository({ getNpcCast }) });

    const queried = await app.inject({ method: "GET",
      url: "/api/rpg/v1/campaigns/campaign/rooms/room/present-cast?x=1",
      headers: { "content-type": "application/json" }, payload: { supplied: true } });
    expect(queried.statusCode).toBe(400);
    expect(queried.json()).toMatchObject({ code: "RPG_INVALID_REQUEST",
      detail: "NPC present cast does not accept query parameters" });

    const invalidPath = await app.inject({ method: "GET",
      url: "/api/rpg/v1/campaigns/%20/rooms/room/present-cast",
      headers: { "content-type": "text/plain" }, payload: "supplied" });
    expect(invalidPath.statusCode).toBe(404);
    expect(invalidPath.json()).toMatchObject({ code: "RPG_NPC_PRESENCE_NOT_FOUND" });

    for (const [contentType, payload] of [["application/json", { supplied: true }],
      ["text/plain", "supplied"]] as const) {
      const response = await app.inject({ method: "GET",
        url: "/api/rpg/v1/campaigns/campaign/rooms/room/present-cast",
        headers: { "content-type": contentType, "x-request-id": "presence-body" }, payload });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ code: "RPG_INVALID_REQUEST", requestId: "presence-body",
        detail: "NPC present cast does not accept a request body" });
    }
    expect(getNpcCast).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects queries, malformed path identities, media types, and strict bodies before repository calls", async () => {
    enable();
    const getNpcCast = vi.fn(() => gmRunning), mutateNpcPresence = vi.fn(() => receipt);
    const app = buildApp({ campaignRepositoryFactory: () => repository({ getNpcCast, mutateNpcPresence }) });
    expect((await app.inject({ method: "GET",
      url: "/api/rpg/v1/campaigns/campaign/rooms/room/present-cast?x=" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET",
      url: "/api/rpg/v1/campaigns/%20/rooms/room/present-cast" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST",
      url: "/api/rpg/v1/campaigns/campaign/rooms/room/npcs/npc/presence-commands?x=1",
      headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST",
      url: "/api/rpg/v1/campaigns/%20/rooms/room/npcs/npc/presence-commands",
      headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST",
      url: "/api/rpg/v1/campaigns/campaign/rooms/room/npcs/%20/presence-commands",
      headers: { "content-type": "application/json" }, payload: body })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST",
      url: "/api/rpg/v1/campaigns/campaign/rooms/room/npcs/npc/presence-commands",
      headers: { "content-type": "application/problem+json" }, payload: "{}" })).statusCode).toBe(415);
    for (const payload of [{ ...body, campaignId: "foreign" }, { ...body, npcId: "foreign" },
      { ...body, expectedNpcRevision: 3 }, { ...body, mutation: { kind: "remove", locationId: null } }]) {
      const response = await app.inject({ method: "POST",
        url: "/api/rpg/v1/campaigns/campaign/rooms/room/npcs/npc/presence-commands",
        headers: { "content-type": "application/json" }, payload });
      expect(response.statusCode).toBe(400);
    }
    const malformedJson = await app.inject({ method: "POST",
      url: "/api/rpg/v1/campaigns/campaign/rooms/room/npcs/npc/presence-commands",
      headers: { "content-type": "application/json" }, payload: "{" });
    expect(malformedJson.statusCode).toBe(400);
    expect(getNpcCast).not.toHaveBeenCalled(); expect(mutateNpcPresence).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes exact BAD_URL and MAX_PARAM failures after both feature gates", async () => {
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    const malformed = [
      ["GET", "/api/rpg/v1/campaigns/campaign/rooms/%zz/present-cast",
        "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/present-cast"],
      ["POST", "/api/rpg/v1/campaigns/campaign/rooms/room/npcs/%zz/presence-commands",
        "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/npcs/:npcId/presence-commands"],
    ] as const;
    const overRouterLimit = `/api/rpg/v1/campaigns/${"x".repeat(10_001)}/rooms/room/present-cast`;

    for (const flags of [[], ["campaign"]] as string[][]) {
      delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS;
      enable(flags.includes("campaign"), flags.includes("mechanics"));
      for (const [method, url, instance] of [...malformed,
        ["GET", overRouterLimit, "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/present-cast"]] as const) {
        const response = await app.inject({ method, url: `${url}?token=router-secret`,
          headers: { "x-request-id": "presence-router-gated", "content-type": "application/json" },
          ...(method === "POST" ? { payload: body } : {}) });
        expect(response.statusCode).toBe(404);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["x-request-id"]).toBe("presence-router-gated");
        expect(response.headers["content-type"]).toContain("application/problem+json");
        expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", instance });
        expect(response.body).not.toMatch(/router-secret|FST_ERR_BAD_URL|FST_ERR_MAX_PARAM_LENGTH/);
      }
    }

    enable();
    for (const [method, url, instance] of malformed) {
      const response = await app.inject({ method, url, headers: {
        "x-request-id": "presence-router-enabled", "content-type": "application/json",
      }, ...(method === "POST" ? { payload: body } : {}) });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({
        code: "RPG_NPC_PRESENCE_NOT_FOUND", requestId: "presence-router-enabled", instance,
      });
      expect(response.body).not.toMatch(/%zz|FST_ERR_BAD_URL/);
      const queried = await app.inject({ method, url: `${url}?token=enabled-router-secret`, headers: {
        "x-request-id": "presence-router-query", "content-type": "application/json",
      }, ...(method === "POST" ? { payload: body } : {}) });
      expect(queried.statusCode).toBe(400);
      expect(queried.json()).toMatchObject({ code: "RPG_INVALID_REQUEST", instance,
        detail: method === "GET" ? "NPC present cast does not accept query parameters"
          : "NPC presence commands do not accept query parameters" });
      expect(queried.body).not.toMatch(/enabled-router-secret|%zz|FST_ERR_BAD_URL/);
    }
    const overLimit = await app.inject({ method: "GET", url: overRouterLimit,
      headers: { "x-request-id": "presence-max-param" } });
    expect(overLimit.statusCode).toBe(404);
    expect(overLimit.json()).toMatchObject({ code: "RPG_NPC_PRESENCE_NOT_FOUND",
      requestId: "presence-max-param", instance: "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/present-cast" });
    expect(overLimit.body).not.toMatch(/FST_ERR_MAX_PARAM_LENGTH|x{129}/);
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts raw-overlength encoded opaque sessions and types invalid resource identities", async () => {
    enable();
    const sessionId = "a".repeat(129);
    const encodedSessionId = "%61".repeat(129);
    const getNpcCast = vi.fn(() => gmRunning), mutateNpcPresence = vi.fn(() => receipt);
    const app = buildApp({ campaignRepositoryFactory: () => repository({ getNpcCast, mutateNpcPresence }) });
    const read = await app.inject({ method: "GET",
      url: `/api/rpg/v1/campaigns/campaign/rooms/${encodedSessionId}/present-cast` });
    const command = await app.inject({ method: "POST",
      url: `/api/rpg/v1/campaigns/campaign/rooms/${encodedSessionId}/npcs/npc/presence-commands`,
      headers: { "content-type": "application/json" }, payload: body });
    expect(read.statusCode).toBe(200); expect(command.statusCode).toBe(200);
    expect(getNpcCast).toHaveBeenCalledWith("local-owner", "campaign", sessionId);
    expect(mutateNpcPresence).toHaveBeenCalledWith("local-owner", expect.objectContaining({ sessionId }));

    getNpcCast.mockClear(); mutateNpcPresence.mockClear();
    for (const campaignId of ["x".repeat(129), "%78".repeat(129)]) {
      const response = await app.inject({ method: "GET",
        url: `/api/rpg/v1/campaigns/${campaignId}/rooms/room/present-cast`,
        headers: { "x-request-id": "presence-overlength" } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ code: "RPG_NPC_PRESENCE_NOT_FOUND",
        requestId: "presence-overlength", instance: "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/present-cast" });
      expect(response.headers["content-type"]).toContain("application/problem+json");
    }
    for (const npcId of ["x".repeat(129), "%78".repeat(129)]) {
      const response = await app.inject({ method: "POST",
        url: `/api/rpg/v1/campaigns/campaign/rooms/room/npcs/${npcId}/presence-commands`,
        headers: { "content-type": "application/json" }, payload: body });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "RPG_NPC_PRESENCE_NOT_FOUND",
        instance: "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/npcs/:npcId/presence-commands" });
    }
    expect(getNpcCast).not.toHaveBeenCalled(); expect(mutateNpcPresence).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps HEAD absent with sanitized problems and does not broaden malformed lookalikes", async () => {
    enable();
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const [url, instance] of [
      ["/api/rpg/v1/campaigns/campaign-secret/rooms/room-secret/present-cast",
        "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/present-cast"],
      ["/api/rpg/v1/campaigns/campaign-secret/rooms/room-secret/npcs/npc-secret/presence-commands",
        "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/npcs/:npcId/presence-commands"],
      ["/api/rpg/v1/campaigns/campaign-secret/rooms/%zz-secret/present-cast",
        "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/present-cast"],
    ] as const) {
      const response = await app.inject({ method: "HEAD", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", instance });
      expect(response.body).not.toMatch(/FST_ERR_BAD_URL|campaign-secret|room-secret|npc-secret|%zz/);
    }
    for (const url of [
      "/api/rpg/v1/campaigns/%zz/rooms/room/present-casts",
      "/api/rpg/v1/campaigns/%zz/rooms/room/npc/npc/presence-commands",
      "/api/rpg/v1/campaigns/%zz/rooms/room/npcs/npc/Presence-commands",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Bad Request", code: "FST_ERR_BAD_URL",
        message: "Request URL is invalid", statusCode: 400 });
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires both repository capabilities for either presence lane operation", async () => {
    enable();
    for (const [method, url, missingCapability] of [
      ["GET", "/api/rpg/v1/campaigns/campaign/rooms/room/present-cast", "mutateNpcPresence"],
      ["POST", "/api/rpg/v1/campaigns/campaign/rooms/room/npcs/npc/presence-commands", "getNpcCast"],
    ] as const) {
      const repo = repository({ [missingCapability]: undefined });
      const app = buildApp({ campaignRepositoryFactory: () => repo });
      const response = await app.inject({ method, url,
        headers: { "content-type": "application/json" }, ...(method === "POST" ? { payload: body } : {}) });
      expect(response.statusCode).toBe(500);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR" });
      expect(response.body).not.toMatch(/repository|support|mutateNpcPresence|getNpcCast/);
      await app.close();
    }
  });

  it("masks absent, unauthorized, unavailable, and path-mismatched repository outcomes", async () => {
    enable();
    const outcomes: Array<unknown> = [null, new WorldAuthorizationError("private"),
      new WorldUnavailableError("private"), { ...gmRunning, sessionId: "foreign" }];
    for (const outcome of outcomes) {
      const getNpcCast = outcome instanceof Error ? () => { throw outcome; } : () => outcome;
      const app = buildApp({ campaignRepositoryFactory: () => repository({ getNpcCast }) });
      const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/room/present-cast" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "RPG_NPC_PRESENCE_NOT_FOUND" });
      expect(response.body).not.toMatch(/private|foreign/);
      await app.close();
    }
    for (const outcome of [new WorldAuthorizationError("private"), new WorldUnavailableError("private"),
      { ...receipt, campaignId: "foreign" }]) {
      const mutateNpcPresence = outcome instanceof Error ? () => { throw outcome; } : () => outcome;
      const app = buildApp({ campaignRepositoryFactory: () => repository({ mutateNpcPresence }) });
      const response = await app.inject({ method: "POST",
        url: "/api/rpg/v1/campaigns/campaign/rooms/room/npcs/npc/presence-commands",
        headers: { "content-type": "application/json" }, payload: body });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "RPG_NPC_PRESENCE_NOT_FOUND" });
      expect(response.body).not.toMatch(/private|foreign/);
      await app.close();
    }
  });

  it("maps stale and conflicting transitions to typed redacted conflicts", async () => {
    enable();
    for (const [error, code] of [[new WorldStaleError("private stale"), "RPG_NPC_PRESENCE_STALE"],
      [new WorldConflictError("private conflict"), "RPG_NPC_PRESENCE_CONFLICT"]] as const) {
      const app = buildApp({ campaignRepositoryFactory: () => repository({ mutateNpcPresence: () => { throw error; } }) });
      const response = await app.inject({ method: "POST",
        url: "/api/rpg/v1/campaigns/campaign/rooms/room/npcs/npc/presence-commands",
        headers: { "content-type": "application/json" }, payload: body });
      expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ code });
      expect(response.body).not.toContain("private");
      await app.close();
    }
  });

  it("rejects corrupt casts and receipts without exposing internal IDs or unsafe retry advice", async () => {
    enable();
    const corruptCasts = [{ ...gmRunning, internalId: "cast-secret" },
      { ...gmRunning, presentCast: [{ ...gmRunning.presentCast[0]!, commandId: "command-secret" }] }];
    for (const cast of corruptCasts) {
      const app = buildApp({ campaignRepositoryFactory: () => repository({ getNpcCast: () => cast }) });
      const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/room/present-cast" });
      expect(response.statusCode).toBe(500); expect(response.body).not.toMatch(/cast-secret|command-secret|internalId|commandId/);
      await app.close();
    }
    const corruptReceipts = [
      { receipt: { ...receipt.receipt, kind: "place" } },
      { receipt: { ...receipt.receipt, revisionBefore: 2, revisionAfter: 3 } },
      { receipt: { ...receipt.receipt, commandId: "command-secret" } },
      { ...receipt, internalId: "receipt-secret" },
    ];
    for (const result of corruptReceipts) {
      const app = buildApp({ campaignRepositoryFactory: () => repository({ mutateNpcPresence: () => result }) });
      const response = await app.inject({ method: "POST",
        url: "/api/rpg/v1/campaigns/campaign/rooms/room/npcs/npc/presence-commands",
        headers: { "content-type": "application/json" }, payload: body });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR" });
      expect(response.body).toContain("authoritative present-cast GET");
      expect(response.body).toContain("do not automatically retry");
      expect(response.body).not.toMatch(/command-secret|receipt-secret|commandId|internalId/);
      await app.close();
    }
  });
});
