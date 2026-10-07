import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignHistoryHttpRoutes } from "../src/routes/rpg/v1/campaignHistory.js";

const at = "2030-01-01T00:00:00.000Z";

function setup() {
  const repo = {
    getAdventureInventoryPublicReceipt: vi.fn(() => null as any),
    getAdventureCommercePublicReceipt: vi.fn(() => null as any),
    getAdventureCheckPublicReceipt: vi.fn(() => null as any),
    getAdventurePowerPublicReceipt: vi.fn(() => null as any),
    getAdventureRestPublicReceipt: vi.fn(() => null as any),
    getAdventureCombatConsumablePublicReceipt: vi.fn(() => null as any),
    getCommandReceipt: vi.fn(() => null as any),
    getAgentCombatReceipt: vi.fn(() => null as any),
    getExactCandidateTravelPublicReceipt: vi.fn(() => null as any),
    getActorJourneyPublicReceipt: vi.fn(() => null as any),
    getCampaignAdministrationReceipt: vi.fn(() => null as any),
    listCampaignTimelineHistory: vi.fn(() => []), listPublicCampaignEvents: vi.fn(),
    createCampaignCheckpoint: vi.fn(), listCampaignCheckpoints: vi.fn(), forkCampaignTimeline: vi.fn(),
    createCampaignRecap: vi.fn(), listCampaignRecaps: vi.fn(),
  };
  const app = Fastify();
  app.register(campaignHistoryHttpRoutes, { prefix: "/api/rpg/v1", campaignHistoryRepositoryAccessor: () => repo as never });
  return { app, repo };
}
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; });

describe("campaign history journey receipt route", () => {
  it("projects an interrupted journey to public names, counts, and the reviewed summary only", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const { app, repo } = setup();
    repo.getActorJourneyPublicReceipt.mockReturnValue({
      commandId: "journey-command", journeyId: "private-journey", status: "interrupted",
      originLocationId: "A", requestedDestinationLocationId: "C", currentLocationId: "B",
      origin: "Old Gate", destination: "Silver Harbor", currentLocation: "Waystation",
      path: [{ connectionId: "A-B", fromLocationId: "A", toLocationId: "B", commandId: "leg-command-1" }],
      elapsedMinutes: 60,
      interruption: { event: { id: "weather-squall", kind: "weather", summary: "A cold squall crosses the route.", weight: 30, environments: ["road"] }, triggerRoll: 1, eventRoll: null },
      eventChecks: [{ connectionId: "A-B", route: { environment: "road", risk: "dangerous", chancePercent: 100 },
        elapsedMinutes: 0, partyInjured: false, triggerRoll: 1, eventRoll: null, eventId: "weather-squall" }],
      revisionBefore: 0, revisionAfter: 1, occurredAt: at,
    });
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/commands/journey-command/receipt" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ receipt: { kind: "journey", status: "interrupted", origin: "Old Gate",
      destination: "Silver Harbor", currentLocation: "Waystation", legs: 1, elapsedMinutes: 60,
      interruption: { kind: "weather", summary: "A cold squall crosses the route." },
      revisionBefore: 0, revisionAfter: 1, occurredAt: at } });
    for (const hidden of ["journey-command", "private-journey", "connectionId", "locationId", "triggerRoll",
      "eventRoll", "weight", "eventChecks", "principalId", "digest"]) {
      expect(response.body).not.toContain(hidden);
    }
    expect(repo.getActorJourneyPublicReceipt).toHaveBeenCalledWith("local-owner", "campaign", "journey-command");
    await app.close();
  });

  it("returns a completed journey with a null interruption", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const { app, repo } = setup();
    repo.getActorJourneyPublicReceipt.mockReturnValue({
      status: "completed", origin: "Old Gate", destination: "Silver Harbor", currentLocation: "Silver Harbor",
      path: [{ connectionId: "A-B", fromLocationId: "A", toLocationId: "B", commandId: "leg-command-1" }],
      elapsedMinutes: 60, interruption: null, revisionBefore: 0, revisionAfter: 1, occurredAt: at,
    });
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/commands/journey-command/receipt" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ receipt: { kind: "journey", status: "completed", origin: "Old Gate",
      destination: "Silver Harbor", currentLocation: "Silver Harbor", legs: 1, elapsedMinutes: 60,
      interruption: null, revisionBefore: 0, revisionAfter: 1, occurredAt: at } });
    await app.close();
  });
});
