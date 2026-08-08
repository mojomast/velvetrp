import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

const at = "2035-01-01T00:00:00.000Z";
const reward = { rewardId: "coin", kind: "currency" as const, amount: 10, label: "Coin", claimedByActorId: null, claimedAt: null };
const quest = { questId: "quest", campaignId: "campaign", storylineId: "story", title: "Gate", description: null,
  status: "offered" as const, rewards: [reward], createdAt: at, updatedAt: at };
const receipt = { commandId: "internal", idempotencyKey: "create", revisionBefore: 0, revisionAfter: 1, occurredAt: at };
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });
const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; };
function repository(overrides: Record<string, unknown> = {}) { return { close() {}, listCampaigns: () => [],
  listCampaignStorylines: () => [], createCampaignStoryline: () => { throw new Error("unused"); }, getCampaignStoryline: () => null, updateCampaignStoryline: () => { throw new Error("unused"); },
  listCampaignQuests: () => ({ campaignId: "campaign", revision: 1, quests: [quest], objectives: [], journal: [] }),
  createCampaignQuest: () => ({ campaignId: "campaign", quest, receipt }),
  executeQuestCommand: () => ({ campaignId: "campaign", quest: { ...quest, status: "active" }, receipt: { ...receipt, idempotencyKey: "accept", revisionBefore: 1, revisionAfter: 2 } }),
  ...overrides } as unknown as CampaignListRepository; }

describe("M2.10 quest routes", () => {
  it("uses trusted local ownership, exact bodies, and strips command IDs", async () => {
    enable(); const calls: any[] = []; let createdState=false;
    const app = buildApp({ campaignRepositoryFactory: () => repository({
      listCampaignQuests: (...args: any[]) => { calls.push(["list", ...args]); return { campaignId: "campaign", revision: 1, quests: [quest], objectives: createdState?[{objectiveId:"door",questId:"quest",description:"Open",targetProgress:1,progress:0,dependencyObjectiveIds:[],completedAt:null}]:[], journal: createdState?[{entryId:"entry",questId:"quest",text:"A gate.",occurredAt:at}]:[] }; },
      createCampaignQuest: (...args: any[]) => { calls.push(["create", ...args]);createdState=true; return { campaignId: "campaign", quest, receipt }; },
      executeQuestCommand: (...args: any[]) => { calls.push(["command", ...args]); return { campaignId: "campaign", quest: { ...quest, status: "active" }, receipt: { ...receipt, idempotencyKey: "accept", revisionBefore: 1, revisionAfter: 2 } }; },
    }) });
    const listed = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/quests", headers: { authorization: "attacker" } });
    expect(listed.statusCode).toBe(200); expect(listed.json()).toEqual({ quests: [quest], objectives: [], journal: [] }); expect(listed.headers["cache-control"]).toBe("no-store");
    const createBody = { quest: { questId: "quest", storylineId: "story", title: "Gate", description: null, visibility: "public",
      objectives: [{ objectiveId: "door", description: "Open", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }],
      rewards: [{ rewardId: "coin", kind: "currency", amount: 10, label: "Coin", visibility: "public" }], journalText: "A gate." },
      expectedRevision: 0, idempotencyKey: "create" };
    const created = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/quests", headers: { "content-type": "application/json" }, payload: createBody });
    expect(created.statusCode).toBe(201); expect(created.body).not.toContain("commandId");
    const commandBody = { kind: "accept", expectedRevision: 1, idempotencyKey: "accept" };
    const commanded = await app.inject({ method: "POST", url: "/api/rpg/v1/quests/quest/commands", headers: { "content-type": "application/json" }, payload: commandBody });
    expect(commanded.statusCode).toBe(200); expect(commanded.body).not.toContain("commandId");
    expect(calls).toEqual([["list", "local-owner", "campaign"], ["create", "local-owner", "campaign", createBody], ["list", "local-owner", "campaign"], ["command", "local-owner", "quest", commandBody]]);
    await app.close();
  });

  it("gates both features and rejects query, media, and malformed discriminants before access", async () => {
    let access = 0; const app = buildApp({ campaignRepositoryFactory: () => { access++; return repository(); } });
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/quests" })).statusCode).toBe(404); expect(access).toBe(0); enable();
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/quests?storylineId=story" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/quests/quest/commands", headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/quests/quest/commands", headers: { "content-type": "application/json" },
      payload: { kind: "claim-reward", rewardId: "coin", expectedRevision: 0, idempotencyKey: "claim" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/storylines" })).statusCode).toBe(404);
    expect(access).toBe(0); await app.close();
  });

  it("normalizes command problem instances across handlers, router failures, and not-found methods", async () => {
    enable(); const app = buildApp({ campaignRepositoryFactory: () => repository() });
    const query = await app.inject({ method: "POST", url: "/api/rpg/v1/quests/private-quest/commands?probe=secret",
      headers: { "content-type": "application/json" }, payload: { kind: "accept", expectedRevision: 0, idempotencyKey: "probe" } });
    expect(query.statusCode).toBe(400); expect(query.json()).toMatchObject({ instance: "/api/rpg/v1/quests/:questId/commands" });
    const malformed = await app.inject({ method: "POST", url: "/api/rpg/v1/quests/%ZZ/commands",
      headers: { "content-type": "application/json" }, payload: {} });
    expect(malformed.statusCode).toBe(404); expect(malformed.json()).toMatchObject({ code: "RPG_QUEST_NOT_FOUND", instance: "/api/rpg/v1/quests/:questId/commands" });
    const unsupported = await app.inject({ method: "PUT", url: "/api/rpg/v1/quests/private-quest/commands" });
    expect(unsupported.statusCode).toBe(404); expect(unsupported.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", instance: "/api/rpg/v1/quests/:questId/commands" });
    for (const response of [query, malformed, unsupported]) {
      expect(response.headers["cache-control"]).toBe("no-store"); expect(response.body).not.toContain("private-quest"); expect(response.body).not.toContain("probe=secret");
    }
    await app.close();
  });
});
