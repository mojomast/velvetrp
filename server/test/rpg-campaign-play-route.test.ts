import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignPlayBootstrap } from "@velvet/contracts";
import { buildApp } from "../src/app.js";

const at = "2030-01-01T00:00:00.000Z";
afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
});
const enable = () => {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
};
function repository(result: CampaignPlayBootstrap | null = null) {
  return {
    close: vi.fn(), listCampaigns: vi.fn(() => []), getCampaignDetail: vi.fn(() => null), createCampaign: vi.fn(),
    getCampaignCharacterCreationOptions: vi.fn(() => null), getCampaignCharacterRoster: vi.fn(() => null),
    getCampaignCharacterWorkspace: vi.fn(() => null), createOriginalStarterCampaignCharacter: vi.fn(),
    renameCampaignIfUnchanged: vi.fn(), getCampaignPlayBootstrap: vi.fn(() => result),
  };
}
const response = (sessionId: string): CampaignPlayBootstrap => ({
  campaignId: "campaign", sessionId, expectedRevision: 3,
  session: { attached: true, attachedAt: at, active: true, adventureEligible: false },
  principal: { role: "owner", control: "all" }, playableActors: [{ actorId: "actor", name: "Aria" }],
});

describe("campaign play bootstrap route", () => {
  it("uses fixed local authority and preserves a once-encoded opaque session ID", async () => {
    enable();
    const sessionId = " room/opaque%value ";
    const repo = repository(response(sessionId));
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const result = await app.inject({ method: "GET",
      url: `/api/rpg/v1/campaigns/campaign/rooms/${encodeURIComponent(sessionId)}/play-bootstrap` });
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json()).toEqual(response(sessionId));
    expect(repo.getCampaignPlayBootstrap).toHaveBeenCalledWith("local-owner", "campaign", sessionId);
    await app.close();
  });

  it("gates both features before repository access", async () => {
    let opens = 0;
    const app = buildApp({ campaignRepositoryFactory: () => { opens += 1; return repository(); } });
    for (const flags of [[], ["campaign"], ["mechanics"]] as string[][]) {
      delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS;
      if (flags.includes("campaign")) process.env.FEATURE_RPG_CAMPAIGN = "true";
      if (flags.includes("mechanics")) process.env.FEATURE_RPG_MECHANICS = "true";
      const result = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/room/play-bootstrap?private=1" });
      expect(result.statusCode).toBe(404); expect(result.body).not.toContain("private=1");
    }
    expect(opens).toBe(0); await app.close();
  });

  it("rejects query and unsupported methods, and null-masks unavailable play", async () => {
    enable(); const repo = repository(); const app = buildApp({ campaignRepositoryFactory: () => repo });
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/room/play-bootstrap?x=" })).statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/room/play-bootstrap" });
    expect(missing.statusCode).toBe(404); expect(missing.json()).toMatchObject({ code: "RPG_CAMPAIGN_PLAY_NOT_FOUND",
      instance: "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/play-bootstrap" });
    for (const method of ["HEAD", "POST", "OPTIONS"] as const) {
      const result = await app.inject({ method, url: "/api/rpg/v1/campaigns/campaign/rooms/room/play-bootstrap" });
      expect(result.statusCode).toBe(404); expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND" });
    }
    await app.close();
  });

  it("returns a redacted 500 for corruption and mismatched output", async () => {
    enable();
    for (const value of [response("foreign"), { ...response("room"), principalId: "secret" }]) {
      const repo = repository(value as CampaignPlayBootstrap); const app = buildApp({ campaignRepositoryFactory: () => repo });
      const result = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/room/play-bootstrap" });
      expect(result.statusCode).toBe(500); expect(result.body).not.toMatch(/foreign|secret|principalId/);
      await app.close();
    }
  });

  it("normalizes malformed campaign paths without reflecting opaque identifiers", async () => {
    enable(); const repo = repository(); const app = buildApp({ campaignRepositoryFactory: () => repo });
    const result = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/%zz/rooms/private-room/play-bootstrap" });
    expect(result.statusCode).toBe(404);
    expect(result.json()).toMatchObject({ instance: "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/play-bootstrap" });
    expect(result.body).not.toMatch(/%zz|private-room/);
    expect(repo.getCampaignPlayBootstrap).not.toHaveBeenCalled(); await app.close();
  });
});
