import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

const at = "2035-01-01T00:00:00.000Z";
const storyline = { storylineId: "story", campaignId: "campaign", title: "Gate", summary: null, status: "active" as const, createdAt: at, updatedAt: at };
const gmStory = { storylines: [storyline], nodes: [], edges: [], plotPoints: [], clues: [] };
const revealedStory = { ...gmStory, nodes: [{ nodeId: "node", storylineId: "story", title: "Node", description: null,
  gmNotes: null, status: "revealed" as const, revealThreshold: 0, createdAt: at, updatedAt: at }] };
const receipt = { commandId: "internal", idempotencyKey: "create", revisionBefore: 0, revisionAfter: 1, occurredAt: at };
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });
const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; };
const repository = (overrides: Record<string, unknown> = {}) => ({ close() {}, listCampaigns: () => [],
  getCampaignStory: () => ({ campaignId: "campaign", revision: 1, story: gmStory }),
  createCampaignStorylineGraph: () => ({ campaignId: "campaign", storyline, story: gmStory, receipt }),
  executeStorylineCommand: () => ({ campaignId: "campaign", storylineId: "story", story: revealedStory,
    receipt: { ...receipt, idempotencyKey: "reveal", revisionBefore: 1, revisionAfter: 2 } }), ...overrides }) as unknown as CampaignListRepository;

describe("M2.10 story routes", () => {
  it("binds output and strips internal command identity", async () => {
    enable(); const calls: any[] = []; const app = buildApp({ campaignRepositoryFactory: () => repository({
      getCampaignStory: (...args: any[]) => { calls.push(["get", ...args]); return { campaignId: "campaign", revision: 1, story: gmStory }; },
      createCampaignStorylineGraph: (...args: any[]) => { calls.push(["create", ...args]); return { campaignId: "campaign", storyline, story: gmStory, receipt }; },
      executeStorylineCommand: (...args: any[]) => { calls.push(["command", ...args]); return { campaignId: "campaign", storylineId: "story", story: revealedStory, receipt: { ...receipt, idempotencyKey: "reveal", revisionBefore: 1, revisionAfter: 2 } }; },
    }) });
    const read = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/story" }); expect(read.statusCode).toBe(200); expect(read.json()).toEqual(gmStory); expect(read.headers["x-story-revision"]).toBe("1");
    const graph = { storylineId: "story", title: "Gate", summary: null, nodes: [], edges: [], plotPoints: [], clues: [] };
    const createBody = { storyline: graph, expectedRevision: 0, idempotencyKey: "create" };
    const created = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/storylines", headers: { "content-type": "application/json" }, payload: createBody });
    expect(created.statusCode).toBe(201); expect(created.body).not.toContain("commandId");
    const commandBody = { kind: "reveal-node", targetId: "node", data: {}, expectedRevision: 1, idempotencyKey: "reveal" };
    const command = await app.inject({ method: "POST", url: "/api/rpg/v1/storylines/story/commands", headers: { "content-type": "application/json" }, payload: commandBody });
    expect(command.statusCode).toBe(200); expect(command.body).not.toContain("commandId");
    expect(calls).toEqual([["get", "local-owner", "campaign"], ["create", "local-owner", "campaign", createBody], ["command", "local-owner", "story", commandBody]]); await app.close();
  });
  it("gates features and redacts query and route identifiers", async () => {
    let access = 0; const app = buildApp({ campaignRepositoryFactory: () => { access++; return repository(); } });
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/secret/story" })).statusCode).toBe(404); expect(access).toBe(0); enable();
    const query = await app.inject({ method: "POST", url: "/api/rpg/v1/storylines/private/commands?probe=secret", headers: { "content-type": "application/json" }, payload: {} });
    expect(query.statusCode).toBe(400); expect(query.json()).toMatchObject({ instance: "/api/rpg/v1/storylines/:storylineId/commands" }); expect(query.body).not.toContain("private"); expect(query.body).not.toContain("probe=secret");
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/storylines/story/commands", headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    expect(access).toBe(0); await app.close();
  });
  it("rejects player-shaped reads and graph or command outputs not bound to the request", async () => {
    enable();
    const playerApp = buildApp({ campaignRepositoryFactory: () => repository({ getCampaignStory: () => ({ campaignId: "campaign", revision: 0,
      story: { visibleNodes: [], discoveredClues: [] } }) }) });
    expect((await playerApp.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/story" })).statusCode).toBe(500); await playerApp.close();
    const graph = { storylineId: "story", title: "Gate", summary: "Expected", nodes: [], edges: [], plotPoints: [], clues: [] };
    const badCreate = buildApp({ campaignRepositoryFactory: () => repository({ createCampaignStorylineGraph: () => ({ campaignId: "campaign",
      storyline: { ...storyline, summary: "Wrong" }, story: gmStory, receipt }) }) });
    expect((await badCreate.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/storylines", headers: { "content-type": "application/json" },
      payload: { storyline: graph, expectedRevision: 0, idempotencyKey: "create" } })).statusCode).toBe(500); await badCreate.close();
    const badCommand = buildApp({ campaignRepositoryFactory: () => repository({ executeStorylineCommand: () => ({ campaignId: "campaign", storylineId: "story",
      story: gmStory, receipt: { ...receipt, idempotencyKey: "reveal", revisionBefore: 1, revisionAfter: 2 } }) }) });
    const response = await badCommand.inject({ method: "POST", url: "/api/rpg/v1/storylines/story/commands", headers: { "content-type": "application/json" },
      payload: { kind: "reveal-node", targetId: "private-node", data: {}, expectedRevision: 1, idempotencyKey: "reveal" } });
    expect(response.statusCode).toBe(500); expect(response.body).not.toContain("private-node"); await badCommand.close();
  });
});
