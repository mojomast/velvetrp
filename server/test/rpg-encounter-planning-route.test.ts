import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encounterPlanningHttpRoutes } from "../src/routes/rpg/v1/encounterPlanning.js";

process.env.NODE_ENV = "test";

const candidate = { id: "srd-5.1:enemy-template:goblin", name: "Goblin", challengeRating: 0.25 };
const plan = {
  targetDifficulty: "medium" as const, targetXp: 300, upperBound: 450,
  roster: [{ id: candidate.id, challengeRating: 0.25, count: 2 }],
  rawXp: 50, adjustedXp: 150, difficulty: "easy" as const, monsterCount: 2, legal: false,
  reasons: ["the roster is below the medium target"],
};

function service(hasCatalog = true) {
  return {
    hasCampaignCatalog: vi.fn(() => hasCatalog),
    listEncounterCandidates: vi.fn(() => [candidate]),
    planEncounter: vi.fn(() => ({ candidates: [candidate], plan })),
  };
}

function app(planningService = service()) {
  const instance = Fastify({ logger: false });
  instance.register(encounterPlanningHttpRoutes, { prefix: "/api/rpg/v1", encounterPlanningAccessor: () => planningService as never });
  return { instance, planningService };
}

afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

describe("encounter planning HTTP lane", () => {
  it("gates before the accessor and requires both campaign and mechanics flags", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const { instance, planningService } = app();
    const denied = await instance.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/encounter-plans", payload: { partyLevels: [3], targetDifficulty: "medium" } });
    expect(denied.statusCode).toBe(404);
    expect(planningService.hasCampaignCatalog).not.toHaveBeenCalled();
    process.env.FEATURE_RPG_MECHANICS = "true";
    const allowed = await instance.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/encounter-plans", payload: { partyLevels: [3, 3], targetDifficulty: "medium" } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ candidates: [candidate], plan });
    expect(planningService.hasCampaignCatalog).toHaveBeenCalledWith("local-owner", "campaign");
    expect(planningService.planEncounter).toHaveBeenCalledWith("local-owner", "campaign", { partyLevels: [3, 3], targetDifficulty: "medium" });
    expect(allowed.headers["cache-control"]).toBe("no-store");
    await instance.close();
  });

  it("rejects query parameters, non-JSON media, and invalid bodies", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const { instance, planningService } = app();
    const base = "/api/rpg/v1/campaigns/campaign/encounter-plans";
    expect((await instance.inject({ method: "POST", url: `${base}?x=1`, payload: { partyLevels: [1], targetDifficulty: "easy" } })).statusCode).toBe(400);
    expect((await instance.inject({ method: "POST", url: base, headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    expect((await instance.inject({ method: "POST", url: base, payload: { partyLevels: [], targetDifficulty: "medium" } })).statusCode).toBe(400);
    expect((await instance.inject({ method: "POST", url: base, payload: { partyLevels: [0], targetDifficulty: "medium" } })).statusCode).toBe(400);
    expect(planningService.planEncounter).not.toHaveBeenCalled();
    await instance.close();
  });

  it("hides a campaign without a configured catalog behind a 404", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const { instance, planningService } = app(service(false));
    const response = await instance.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/encounter-plans", payload: { partyLevels: [3], targetDifficulty: "medium" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "RPG_CAMPAIGN_NOT_FOUND" });
    expect(planningService.planEncounter).not.toHaveBeenCalled();
    await instance.close();
  });

  it("masks planner corruption and rejects implicit HEAD", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const broken = service();
    broken.planEncounter = vi.fn(() => { throw new Error("private planner corruption"); });
    const { instance } = app(broken);
    const response = await instance.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/encounter-plans", payload: { partyLevels: [3], targetDifficulty: "medium" } });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private planner corruption");
    expect((await instance.inject({ method: "HEAD", url: "/api/rpg/v1/campaigns/campaign/encounter-plans" })).statusCode).toBe(404);
    await instance.close();
  });
});
