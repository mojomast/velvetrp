import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
});
const enable = () => {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  process.env.FEATURE_RPG_COMBAT = "true";
};

const location = (key: string, name: string) => ({ key, name, description: `${name} description.`, visibility: "public" as const, discoveries: [], hazards: [], hooks: [], factionKeys: [] });
const connection = (key: string, from: string, to: string) => ({ key, fromLocationKey: from, toLocationKey: to, description: `${key} route.`, visibility: "public" as const });

const regionContent = {
  outlines: [{ key: "river-opening", opening: "Rain falls over the river gate.", premise: "The bell-warden is missing.", startLocationKey: "river-gate", visibility: "public" as const }],
  locations: [location("river-gate", "River Gate"), location("old-bridge", "Old Bridge"), location("flood-mill", "Flood Mill"), location("bell-tower", "Bell Tower")],
  connections: [
    connection("gate-to-bridge", "river-gate", "old-bridge"),
    connection("bridge-to-mill", "old-bridge", "flood-mill"),
    connection("mill-to-tower", "flood-mill", "bell-tower"),
  ],
  factions: [{ key: "river-watch", name: "River Watch", description: "Gate wardens.", visibility: "public" as const }],
  npcs: [{ key: "mara", name: "Mara", archetype: "Guide", description: "A wary guide.", visibility: "public" as const, locationKey: "river-gate", factionKeys: ["river-watch"] }],
  quests: [{ key: "find-warden", title: "Find the Warden", description: "Search the flooded quarter.", visibility: "public" as const, locationKeys: ["old-bridge", "flood-mill"], objectives: [], rewards: [] }],
  clues: [{ key: "cracked-seal", title: "Cracked Seal", description: "A broken gate seal.", visibility: "public" as const, locationKey: "flood-mill", revealsStoryNodeKey: "warden-gone" }],
  storyNodes: [{ key: "warden-gone", title: "The Warden is Gone", description: "The gate is unguarded.", visibility: "public" as const }],
};

const anchoredContent = {
  outlines: [{ key: "north-opening", opening: "The north road leaves the gate.", premise: "Something moves beyond the wall.", visibility: "public" as const }],
  locations: [location("north-road", "North Road"), location("north-inn", "North Inn"), location("north-forge", "North Forge"), location("north-chapel", "North Chapel")],
  connections: [
    connection("anchor-road", "river-gate", "north-road"),
    connection("road-inn", "north-road", "north-inn"),
    connection("inn-forge", "north-inn", "north-forge"),
    connection("forge-chapel", "north-forge", "north-chapel"),
  ],
};

const request = (idempotencyKey = "region-pack-1", extra: Record<string, unknown> = {}) => ({
  idempotencyKey,
  brief: "The flooded river quarter around a silent bell tower.",
  locationCount: 4,
  ...extra,
});

const post = (app: ReturnType<typeof buildApp>, campaignId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaignId}/region-packs`, headers: { "content-type": "application/json" }, payload });

describe("campaign region pack route", () => {
  it("applies one draft, the linked location graph, and a designated start from a single provider call", async () => {
    enable();
    const repo = createRepository(), campaign = repo.createCampaign("local-owner", { name: "Region" });
    const generate = vi.fn().mockResolvedValue(regionContent);
    const app = buildApp({ campaignRepositoryFactory: () => repo, campaignContentGeneration: generate });

    const response = await post(app, campaign.id, request());
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json();
    expect(body.draft.state).toBe("applied");
    expect(body.appliedArtifactKeys).toEqual(expect.arrayContaining(["river-opening", "river-gate", "gate-to-bridge", "mara", "find-warden", "cracked-seal", "warden-gone"]));
    expect(body.startLocation.artifactKey).toBe("river-gate");
    expect(body.startLocation.name).toBe("River Gate");
    expect(typeof body.receipt.receiptId).toBe("string");

    const starting = repo.getCampaignStartingLocation("local-owner", campaign.id)!;
    expect(starting.startingLocation?.locationId).toBe(body.startLocation.locationId);
    expect(repo.listCampaignNpcs("local-owner", campaign.id)?.npcs.map((npc) => npc.publicState.name)).toContain("Mara");
    expect(repo.listCampaignQuests("local-owner", campaign.id)?.quests.map((quest) => quest.title)).toContain("Find the Warden");
    const story = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/story` });
    expect(story.statusCode, story.body).toBe(200);
    expect(story.json().nodes.map((node: any) => node.title)).toContain("The Warden is Gone");
    expect(story.json().clues).toHaveLength(1);

    const replay = await post(app, campaign.id, request());
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().draft.draftId).toBe(body.draft.draftId);
    expect(replay.json().startLocation).toEqual(body.startLocation);
    expect(generate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("requires and links an accepted anchor once a starting location is designated", async () => {
    enable();
    const repo = createRepository(), campaign = repo.createCampaign("local-owner", { name: "Anchored region" });
    const generate = vi.fn().mockResolvedValueOnce(regionContent).mockResolvedValueOnce(anchoredContent);
    const app = buildApp({ campaignRepositoryFactory: () => repo, campaignContentGeneration: generate });

    const first = await post(app, campaign.id, request("region-first"));
    expect(first.statusCode, first.body).toBe(201);
    const designated = repo.getCampaignStartingLocation("local-owner", campaign.id)!.startingLocation!;

    const missingAnchor = await post(app, campaign.id, request("region-second-no-anchor"));
    expect(missingAnchor.statusCode).toBe(400);
    expect(generate).toHaveBeenCalledTimes(1);

    const second = await post(app, campaign.id, request("region-second", { anchorLocationKey: "river-gate" }));
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().appliedArtifactKeys).toEqual(expect.arrayContaining(["north-road", "anchor-road"]));
    expect(second.json().startLocation.locationId).toBe(designated.locationId);
    expect(repo.getCampaignStartingLocation("local-owner", campaign.id)!.startingLocation?.locationId).toBe(designated.locationId);
    expect(generate).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("writes nothing when the candidate fails the region validator", async () => {
    enable();
    const repo = createRepository(), campaign = repo.createCampaign("local-owner", { name: "Invalid region" });
    const disconnected = {
      ...regionContent,
      connections: [connection("gate-to-bridge", "river-gate", "old-bridge"), connection("bridge-to-mill", "old-bridge", "flood-mill")],
    };
    const generate = vi.fn().mockResolvedValue(disconnected);
    const app = buildApp({ campaignRepositoryFactory: () => repo, campaignContentGeneration: generate });

    const response = await post(app, campaign.id, request("region-invalid"));
    expect(response.statusCode, response.body).toBe(503);
    expect(repo.getGenerationDraftByIdempotencyKey("local-owner", campaign.id, "region-invalid")).toBeNull();
    expect(repo.getCampaignStartingLocation("local-owner", campaign.id)?.startingLocation).toBeNull();
    await app.close();
  });

  it("writes nothing and does not retry when the provider fails", async () => {
    enable();
    const repo = createRepository(), campaign = repo.createCampaign("local-owner", { name: "Provider failure" });
    const generate = vi.fn().mockRejectedValue(new Error("provider down"));
    const app = buildApp({ campaignRepositoryFactory: () => repo, campaignContentGeneration: generate });

    const response = await post(app, campaign.id, request("region-provider-fail"));
    expect(response.statusCode, response.body).toBe(503);
    expect(repo.getGenerationDraftByIdempotencyKey("local-owner", campaign.id, "region-provider-fail")).toBeNull();
    const replay = await post(app, campaign.id, request("region-provider-fail"));
    expect(replay.statusCode).toBe(409);
    expect(generate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("gates on features, query strings, media type, and strict body parsing", async () => {
    const repo = createRepository(), campaign = repo.createCampaign("local-owner", { name: "Gates" });
    const app = buildApp({ campaignRepositoryFactory: () => repo, campaignContentGeneration: async () => regionContent });

    const disabled = await post(app, campaign.id, request("gated"));
    expect(disabled.statusCode).toBe(404);
    enable();
    const query = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/region-packs?draft=1`, headers: { "content-type": "application/json" }, payload: request("gated") });
    expect(query.statusCode).toBe(400);
    const media = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/region-packs`, headers: { "content-type": "text/plain" }, payload: "{}" });
    expect(media.statusCode).toBe(415);
    const badBody = await post(app, campaign.id, { ...request("gated"), locationCount: 3 });
    expect(badBody.statusCode).toBe(400);
    const unknown = await post(app, campaign.id, { ...request("gated"), campaignId: campaign.id });
    expect(unknown.statusCode).toBe(400);
    await app.close();
  });

  it("does not leak provider error text", async () => {
    enable();
    const messages: string[] = [];
    const stream = { write: (message: string) => { messages.push(message); } };
    const repo = createRepository(), campaign = repo.createCampaign("local-owner", { name: "Redaction" });
    const app = buildApp({ campaignRepositoryFactory: () => repo, loggerStream: stream as never, campaignContentGeneration: async () => { throw new Error("PRIVATE_PROVIDER_ECHO"); } });
    const response = await post(app, campaign.id, request("region-redact"));
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("PRIVATE_PROVIDER_ECHO");
    expect(messages.join("\n")).not.toContain("PRIVATE_PROVIDER_ECHO");
    await app.close();
  });
});
