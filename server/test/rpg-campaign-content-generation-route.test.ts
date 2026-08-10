import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";
useTmpDataDir();
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; delete process.env.FEATURE_RPG_COMBAT; });
const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true"; };
const content = { opening: "Rain falls on the old road.", premise: "A missing courier needs help.", locations: [{ name: "Old Road", description: "A wet road." }], factions: [{ name: "Road Wardens", description: "They keep travellers safe." }], quests: [{ title: "Find the courier", description: "Follow the tracks." }], npcs: [{ name: "Mara", archetype: "Guide", goals: "Find the courier." }] };

describe("M4.6 campaign-content generation", () => {
  it("stages safe previews, applies atomically, and replays exact apply", async () => {
    enable(); const repo = createRepository(); const campaign = repo.createCampaign("local-owner", { name: "Content" });
    const generate = vi.fn().mockResolvedValue(content); const app = buildApp({ campaignRepositoryFactory: () => repo, campaignContentGeneration: generate });
    const request = { campaignId: campaign.id, brief: "A rainy opening", tone: "Mysterious", exclusions: ["No horror"], idempotencyKey: "content-draft" };
    const created = await app.inject({ method: "POST", url: "/api/rpg/v1/campaign-content-drafts", headers: { "content-type": "application/json" }, payload: request });
    if (created.statusCode !== 201) throw new Error(`create ${created.body}`);
    expect(created.body).not.toMatch(/provider|local-owner|personaId|goals/); expect(created.json().preview.npcStats).toEqual({ body: 10, mind: 10, presence: 10, source: "generated-deterministic-baseline" });
    const applyPayload = { expectedRevision: 0, idempotencyKey: "content-apply" }, id = created.json().draft.draftId;
    const applied = await app.inject({ method: "POST", url: `/api/rpg/v1/campaign-content-drafts/${id}/apply`, headers: { "content-type": "application/json" }, payload: applyPayload });
    if (applied.statusCode !== 200) throw new Error(`apply ${applied.body}`); const replay = await app.inject({ method: "POST", url: `/api/rpg/v1/campaign-content-drafts/${id}/apply`, headers: { "content-type": "application/json" }, payload: applyPayload }); expect(replay.json()).toEqual(applied.json()); expect(generate).toHaveBeenCalledTimes(1); await app.close();
  });
  it("fails closed on unsupported provider fields without staging", async () => {
    enable(); const repo = createRepository(); const campaign = repo.createCampaign("local-owner", { name: "Closed" }); const app = buildApp({ campaignRepositoryFactory: () => repo, campaignContentGeneration: async () => ({ ...content, powers: ["no"] }) });
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaign-content-drafts", headers: { "content-type": "application/json" }, payload: { campaignId: campaign.id, brief: "Brief", tone: "Tone", exclusions: [], idempotencyKey: "bad-content" } });
    expect(response.statusCode).toBe(503); expect(response.body).not.toMatch(/powers|provider/); await app.close();
  });
});
