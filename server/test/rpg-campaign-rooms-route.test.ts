import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  CampaignSessionAttachmentConflictError,
  CampaignSessionAttachmentSessionMissingError,
  CampaignSessionAttachmentUnavailableError,
} from "../src/repo/index.js";

const at = "2030-01-01T00:00:00.000Z";
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; });

function repository() {
  return {
    listCampaigns: vi.fn(() => []), getCampaignDetail: vi.fn(() => null), createCampaign: vi.fn(),
    getCampaignCharacterCreationOptions: vi.fn(() => null), getCampaignCharacterRoster: vi.fn(() => null),
    getCampaignCharacterWorkspace: vi.fn(() => null), createOriginalStarterCampaignCharacter: vi.fn(),
    renameCampaignIfUnchanged: vi.fn(), close: vi.fn(),
    getCampaignRoomLinkingSnapshot: vi.fn(() => ({
      campaignId: "campaign", attached: [],
      eligible: [{ sessionId: " room ", title: null, participantNames: ["Aria"], createdAt: at }],
    })),
    attachCampaignSession: vi.fn(() => ({ campaignId: "campaign", sessionId: " room ", attachedAt: at })),
  };
}

describe("campaign room routes", () => {
  it("reads and attaches with fixed local authority and exact opaque binding", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const read = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms" });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.json()).toEqual({ attached: [], eligible: [{
      sessionId: " room ", title: null, participantNames: ["Aria"], createdAt: at,
    }] });
    const write = await app.inject({
      method: "PUT", url: "/api/rpg/v1/campaigns/campaign/rooms",
      headers: { "content-type": "application/json" }, payload: { sessionId: " room " },
    });
    expect(write.statusCode).toBe(200);
    expect(write.headers.location).toBeUndefined();
    expect(write.json()).toEqual({ attachment: { sessionId: " room ", attachedAt: at } });
    expect(repo.getCampaignRoomLinkingSnapshot).toHaveBeenCalledWith("local-owner", "campaign");
    expect(repo.attachCampaignSession).toHaveBeenCalledWith("local-owner", { campaignId: "campaign", sessionId: " room " });
    await app.close();
  });

  it.each([
    [new CampaignSessionAttachmentUnavailableError(), 404, "RPG_CAMPAIGN_NOT_FOUND"],
    [new CampaignSessionAttachmentSessionMissingError(), 404, "RPG_CAMPAIGN_ROOM_NOT_FOUND"],
    [new CampaignSessionAttachmentConflictError("stopped sessions cannot be attached to campaigns"), 409, "RPG_CAMPAIGN_ROOM_CONFLICT"],
  ])("maps narrow write failures", async (error, status, code) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.attachCampaignSession.mockImplementation(() => { throw error; });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/campaign/rooms",
      headers: { "content-type": "application/json" }, payload: { sessionId: "room" } });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    expect(response.body).not.toContain("session");
    await app.close();
  });

  it("does not expose HEAD or accept query, media, or private body fields", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    for (const method of ["HEAD", "DELETE", "OPTIONS"] as const) {
      const unsupported = await app.inject({ method, url: "/api/rpg/v1/campaigns/campaign/rooms" });
      expect(unsupported.statusCode).toBe(404);
      expect(unsupported.headers["cache-control"]).toBe("no-store");
      expect(unsupported.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND" });
    }
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms?x=" })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/campaign/rooms", payload: "room" })).statusCode).toBe(415);
    expect((await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/campaign/rooms",
      headers: { "content-type": "application/json" }, payload: { sessionId: "room", private: true } })).statusCode).toBe(400);
    expect(repo.attachCampaignSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("strictly normalizes malformed room paths without reflecting identifiers", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    for (const method of ["GET", "PUT"] as const) {
      const response = await app.inject({ method, url: "/api/rpg/v1/campaigns/%zz/rooms" });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({
        code: "RPG_CAMPAIGN_NOT_FOUND", instance: "/api/rpg/v1/campaigns/:campaignId/rooms",
      });
      expect(response.body).not.toContain("%zz");
    }
    expect(repo.getCampaignRoomLinkingSnapshot).not.toHaveBeenCalled();
    expect(repo.attachCampaignSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps no-store on unsupported methods for existing scoped RPG routes", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const app = buildApp({ campaignRepositoryFactory: repository });
    for (const [method, url] of [
      ["HEAD", "/api/rpg/v1/campaigns"],
      ["DELETE", "/api/rpg/v1/campaigns/campaign"],
      ["OPTIONS", "/api/rpg/v1/campaigns/campaign/dice-rolls"],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND" });
    }
    await app.close();
  });
});
