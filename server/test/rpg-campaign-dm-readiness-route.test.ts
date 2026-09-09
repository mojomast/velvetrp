import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { CampaignDmReadinessUnavailableError } from "../src/repo/campaignDmReadinessRepo.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

describe("campaign DM readiness route", () => {
  afterEach(() => {
    delete process.env.FEATURE_RPG_CAMPAIGN;
    delete process.env.FEATURE_RPG_MECHANICS;
    vi.restoreAllMocks();
  });

  it("serves a private strict GET and rejects non-GET inputs without providers", async () => {
    const fixture = await dmFixture();
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const provider = vi.fn(() => { throw new Error("provider must not run"); });
    vi.stubGlobal("fetch", provider);
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo });
    const path = `/api/rpg/v1/campaigns/${fixture.campaign.id}/rooms/${fixture.session.id}/dm/preparation-readiness`;
    try {
      const result = await app.inject({ method: "GET", url: path });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(result.json().identity).toMatchObject({ campaignId: fixture.campaign.id, sessionId: fixture.session.id });
      expect((await app.inject({ method: "GET", url: `${path}?source=client` })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: path, headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
      const overlong = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${"a".repeat(129)}/rooms/${fixture.session.id}/dm/preparation-readiness` });
      expect(overlong.statusCode).toBe(404);
      expect(overlong.headers["cache-control"]).toContain("no-store");
      expect((await app.inject({ method: "HEAD", url: path })).statusCode).toBe(404);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      await app.close();
      fixture.repo.close();
    }
  });

  it("uses one generic not-found response for disabled, unknown, and unauthorized resources", async () => {
    const fixture = await dmFixture();
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo });
    const path = `/api/rpg/v1/campaigns/${fixture.campaign.id}/rooms/${fixture.session.id}/dm/preparation-readiness`;
    try {
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(404);
      process.env.FEATURE_RPG_CAMPAIGN = "true";
      process.env.FEATURE_RPG_MECHANICS = "true";
      const responses = await Promise.all([
        app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/missing/rooms/${fixture.session.id}/dm/preparation-readiness` }),
        app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${fixture.campaign.id}/rooms/missing/dm/preparation-readiness` }),
      ]);
      for (const result of responses) {
        expect(result.statusCode).toBe(404);
        expect(result.json()).toMatchObject({ code: "RPG_DM_NOT_FOUND", detail: "DM resource unavailable" });
      }
      vi.spyOn(fixture.repo, "getCampaignDmPreparationReadiness").mockImplementation(() => { throw new CampaignDmReadinessUnavailableError(); });
      const unauthorized = await app.inject({ method: "GET", url: path });
      expect(unauthorized.statusCode).toBe(404);
      expect(unauthorized.json()).toMatchObject({ code: "RPG_DM_NOT_FOUND", detail: "DM resource unavailable" });
    } finally {
      await app.close();
      fixture.repo.close();
    }
  });

  it("rejects malformed parameters and invalid internal projections", async () => {
    const fixture = await dmFixture();
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo });
    const path = `/api/rpg/v1/campaigns/${fixture.campaign.id}/rooms/${fixture.session.id}/dm/preparation-readiness`;
    try {
      expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/%2F/rooms/room/dm/preparation-readiness" })).statusCode).toBe(404);
      vi.spyOn(fixture.repo, "getCampaignDmPreparationReadiness").mockReturnValue({} as never);
      const result = await app.inject({ method: "GET", url: path });
      expect(result.statusCode).toBe(500);
    } finally {
      await app.close();
      fixture.repo.close();
    }
  });

  it("rejects a strict projection whose identity does not match the request path", async () => {
    const fixture = await dmFixture();
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo });
    const path = `/api/rpg/v1/campaigns/${fixture.campaign.id}/rooms/${fixture.session.id}/dm/preparation-readiness`;
    try {
      const valid = fixture.repo.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
      vi.spyOn(fixture.repo, "getCampaignDmPreparationReadiness").mockReturnValue({
        ...valid, identity: { ...valid.identity, sessionId: "other-room" },
      });
      const result = await app.inject({ method: "GET", url: path });
      expect(result.statusCode).toBe(404);
      expect(result.json()).toMatchObject({ code: "RPG_DM_NOT_FOUND" });
    } finally {
      await app.close();
      fixture.repo.close();
    }
  });
});
