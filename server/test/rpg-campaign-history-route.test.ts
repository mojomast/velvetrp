import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignHistoryHttpRoutes } from "../src/routes/rpg/v1/campaignHistory.js";

const at = "2030-01-01T00:00:00.000Z";
const mechanicReceipt = {
  commandId: "command", campaignId: "campaign", revisionBefore: 0, revisionAfter: 1,
  events: [{ eventId: "event", commandId: "command", campaignId: "campaign", timelineId: "timeline",
    actorId: "actor", sourceTurnId: "private-turn", type: "actor_attribute_set" as const,
    revision: 1, occurredAt: at, data: { attributeId: "strength", valueBefore: 10, valueAfter: 12 } }],
};
const administrationReceipt = {
  commandId: "admin-command", campaignId: "campaign", type: "recap_created" as const,
  revisionBefore: 1, revisionAfter: 2, occurredAt: at,
  events: [{ eventId: "admin-event", commandId: "admin-command", campaignId: "campaign",
    type: "recap_created" as const, revision: 2, occurredAt: at,
    data: { timelineId: "timeline", text: "must never cross" } }],
};
function setup() {
  const repo = {
    getCommandReceipt: vi.fn(() => mechanicReceipt),
    getAgentCombatReceipt:vi.fn(()=>null as any),
    getCampaignAdministrationReceipt: vi.fn(() => null as typeof administrationReceipt | null),
    listCampaignTimelineHistory: vi.fn(() => []), listPublicCampaignEvents: vi.fn(),
    createCampaignCheckpoint: vi.fn(), listCampaignCheckpoints: vi.fn(), forkCampaignTimeline: vi.fn(),
    createCampaignRecap: vi.fn(), listCampaignRecaps: vi.fn(),
  };
  const app = Fastify(); app.register(campaignHistoryHttpRoutes, { prefix: "/api/rpg/v1", campaignHistoryRepositoryAccessor: () => repo as never });
  return { app, repo };
}
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; });

describe("campaign history receipt route", () => {
  it("opens a listed actor mechanic receipt through the authorized command repository", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup();
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/commands/command/receipt" });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ receipt: { kind: "mechanic", revisionBefore: 0, revisionAfter: 1,
      occurredAt: at, event: { type: "actor_attribute_set", data: { valueBefore: 10, valueAfter: 12 } } } });
    expect(response.body).not.toContain("actorId"); expect(response.body).not.toContain("private-turn"); expect(response.body).not.toContain("strength");
    expect(repo.getCommandReceipt).toHaveBeenCalledWith("local-owner", "campaign", "command");
    expect(repo.getCampaignAdministrationReceipt).not.toHaveBeenCalled(); await app.close();
  });

  it("falls back to redacted administration metadata and never returns generic event data", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup();
    repo.getCommandReceipt.mockReturnValue(null as never); repo.getCampaignAdministrationReceipt.mockReturnValue(administrationReceipt);
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/commands/admin-command/receipt" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ receipt: { kind: "administration",
      type: "recap_created", revisionBefore: 1, revisionAfter: 2, occurredAt: at } });
    expect(response.body).not.toContain("must never cross"); await app.close();
  });
  it("returns an exact role-safe generalized combat receipt",async()=>{
    process.env.FEATURE_RPG_CAMPAIGN="true";const{app,repo}=setup();repo.getCommandReceipt.mockReturnValue(null as never);repo.getAgentCombatReceipt.mockReturnValue({revisionBefore:3,revisionAfter:4,occurredAt:at,
      resolution:{actionId:"action",legalActionId:"end-turn",kind:"end-turn",actingCombatantId:"enemy",targetIds:[],outcomes:[],roundBefore:1,roundAfter:2,currentCombatantBefore:"enemy",currentCombatantAfter:"hero"}});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/commands/combat-command/receipt"});expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({receipt:{kind:"combat",revisionBefore:3,revisionAfter:4,occurredAt:at,roundBefore:1,roundAfter:2}});expect(response.body).not.toContain("end-turn");expect(repo.getCampaignAdministrationReceipt).not.toHaveBeenCalled();await app.close();
  });

  it("returns not found when neither role-authorized repository exposes the command", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup();
    repo.getCommandReceipt.mockReturnValue(null as never);
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/commands/missing/receipt" });
    expect(response.statusCode).toBe(404); expect(response.body).not.toContain("missing"); await app.close();
  });
});
