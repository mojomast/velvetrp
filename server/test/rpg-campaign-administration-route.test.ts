import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignAdministrationHttpRoutes } from "../src/routes/rpg/v1/campaignAdministration.js";
import { CampaignAdministrationConflictError, CampaignAdministrationStaleError } from "../src/repo/campaignAdministrationRepo.js";

const value = { id: "campaign", actorRole: "owner" as const, status: "draft" as const, activeTimelineId: "timeline", revision: 2,
  updatedAt: "2030-01-01T00:00:00.000Z", settings: { maxPlayers: 4, allowPlayerDice: true, safetyMode: "standard" as const, recapVisibility: "members" as const, gmNotes: "secret" } };
function setup() {
  const repo = { getCampaignAdministration: vi.fn(() => value), updateCampaignAdministration: vi.fn(() => ({ value, receipt: {} as never })) };
  const app = Fastify(); app.register(campaignAdministrationHttpRoutes, { prefix: "/api/rpg/v1", campaignAdministrationRepositoryAccessor: () => repo as never });
  return { app, repo };
}
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; });

describe("isolated campaign administration HTTP lane", () => {
  it("gates the lane before opening the injected repository", async () => {
    const { app, repo } = setup();
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/administration" });
    expect(response.statusCode).toBe(404); expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND" });
    expect(repo.getCampaignAdministration).not.toHaveBeenCalled(); await app.close();
  });
  it("reads and patches with fixed local ownership and no-store", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup();
    const read = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/administration", headers: { authorization: "attacker" } });
    expect(read.statusCode).toBe(200); expect(read.headers["cache-control"]).toBe("no-store");
    const patch = await app.inject({ method: "PATCH", url: "/api/rpg/v1/campaigns/campaign/administration", payload: { expectedRevision: 2, idempotencyKey: "key", status: "published" } });
    expect(patch.statusCode).toBe(200); expect(repo.updateCampaignAdministration).toHaveBeenCalledWith("local-owner", "campaign", expect.anything()); await app.close();
  });
  it("rejects query, malformed paths, media, invalid bodies and unsupported methods", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup();
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/administration?x=" })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/rpg/v1/campaigns/campaign/administration", headers: { "content-type": "text/plain" }, payload: "x" })).statusCode).toBe(415);
    expect((await app.inject({ method: "PATCH", url: "/api/rpg/v1/campaigns/campaign/administration", payload: {} })).statusCode).toBe(400);
    for (const method of ["HEAD", "OPTIONS", "DELETE"] as const) {
      expect((await app.inject({ method, url: "/api/rpg/v1/campaigns/campaign/administration" })).statusCode).toBe(404);
    }
    expect(repo.getCampaignAdministration).not.toHaveBeenCalled(); await app.close();
  });
  it.each([[new CampaignAdministrationStaleError(), "RPG_CAMPAIGN_ADMINISTRATION_STALE"], [new CampaignAdministrationConflictError("illegal lifecycle transition"), "RPG_CAMPAIGN_ADMINISTRATION_TRANSITION_CONFLICT"]])("maps typed failure", async (error, code) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup(); repo.updateCampaignAdministration.mockImplementation(() => { throw error; });
    const response = await app.inject({ method: "PATCH", url: "/api/rpg/v1/campaigns/campaign/administration", payload: { expectedRevision: 2, idempotencyKey: "key", status: "published" } });
    expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ code }); expect(response.body).not.toContain("illegal"); await app.close();
  });
  it("rejects a repository response bound to another campaign without leaking it", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup();
    repo.getCampaignAdministration.mockReturnValue({ ...value, id: "other-campaign" });
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/administration" });
    expect(response.statusCode).toBe(500); expect(response.body).not.toContain("other-campaign"); await app.close();
  });
});
