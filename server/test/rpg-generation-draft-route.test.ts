import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createRepository, createSession, transitionSession } from "../src/repo/index.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; delete process.env.FEATURE_RPG_COMBAT; });
const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true"; };
const generated = { name: "Bridge Ambush", combatants: [{ pinnedEnemyIndex: 0, count: 2 }], terrain: "A narrow bridge above cold water.", motives: "Drive intruders away.", rewardNarrative: "The route is safe again." };

describe("M4.5 typed encounter generation routes", () => {
  it("creates a strict typed draft idempotently without exposing provider or pinned identities", async () => {
    enable(); const seed = createRepository(); const campaign = seed.createCampaign("local-owner", { name: "Encounter draft" }); const persona = seed.createCharacter({ name: "Player", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true }); const session = await createSession({ characterId: persona.id }); await transitionSession(session.id, "active", "test"); seed.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any); seed.close();
    const generate = vi.fn().mockResolvedValue(generated);
    let app = buildApp({ campaignRepositoryFactory: () => createRepository(), encounterGeneration: generate });
    const request = { campaignId: campaign.id, sessionId: session.id, brief: "An ambush", visibleLocation: "Old bridge", tone: "Tense", difficulty: "standard", partyActorIds: ["actor"], pinnedEnemyTemplates: [{ kind: "enemy-template", packId: "pack", packVersion: "1", definitionId: "wolf" }], exclusions: ["No fire"], idempotencyKey: "encounter-draft" };
    const created = await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "application/json" }, payload: request });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ draft: { kind: "encounter", state: "staged" }, encounter: { name: "Bridge Ambush", enemyCount: 2 }, validationIssues: [] });
    expect(created.body).not.toMatch(/provider|prompt|local-owner|partyActorIds|packId|definitionId/);
    const duplicate = await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "application/json" }, payload: request });
    expect(duplicate.json()).toEqual(created.json()); expect(generate).toHaveBeenCalledTimes(1);
    const draftId = created.json().draft.draftId; await app.close();
    app = buildApp({ campaignRepositoryFactory: () => createRepository(), encounterGeneration: generate });
    const read = await app.inject({ method: "GET", url: `/api/rpg/v1/generation-drafts/${draftId}` });
    expect(read.json()).toEqual(created.json()); await app.close();
  });

  it("fails closed on malformed provider output and never persists a draft", async () => {
    enable(); const repo = createRepository(); const campaign = repo.createCampaign("local-owner", { name: "Provider failure" });
    const app = buildApp({ campaignRepositoryFactory: () => repo, encounterGeneration: async () => ({ ...generated, hidden: "no" }) });
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "application/json" }, payload: { campaignId: campaign.id, sessionId: "session", brief: "An ambush", visibleLocation: "Bridge", tone: "Tense", difficulty: "easy", partyActorIds: ["actor"], pinnedEnemyTemplates: [{ kind: "enemy-template", packId: "pack", packVersion: "1", definitionId: "wolf" }], exclusions: [], idempotencyKey: "bad" } });
    expect(response.statusCode).toBe(503); expect(response.body).not.toMatch(/hidden|provider|prompt|pack|wolf/); await app.close();
  });

  it("rolls back review when authoritative encounter creation fails", async () => {
    enable(); const seed = createRepository(); const campaign = seed.createCampaign("local-owner", { name: "Atomic apply" }); const persona = seed.createCharacter({ name: "Player", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true }); const session = await createSession({ characterId: persona.id }); await transitionSession(session.id, "active", "test"); seed.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any); seed.close();
    const app = buildApp({ campaignRepositoryFactory: () => createRepository(), encounterGeneration: async () => generated });
    const request = { campaignId: campaign.id, sessionId: session.id, brief: "An ambush", visibleLocation: "Bridge", tone: "Tense", difficulty: "easy", partyActorIds: ["missing-actor"], pinnedEnemyTemplates: [{ kind: "enemy-template", packId: "pack", packVersion: "1", definitionId: "wolf" }], exclusions: [], idempotencyKey: "atomic-draft" };
    const created = await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "application/json" }, payload: request });
    expect(created.statusCode).toBe(201);
    const apply = await app.inject({ method: "POST", url: `/api/rpg/v1/generation-drafts/${created.json().draft.draftId}/apply`, headers: { "content-type": "application/json" }, payload: { expectedRevision: 0, idempotencyKey: "atomic-apply" } });
    expect(apply.statusCode).toBe(503);
    const after = await app.inject({ method: "GET", url: `/api/rpg/v1/generation-drafts/${created.json().draft.draftId}` });
    expect(after.json().draft).toMatchObject({ state: "staged", revision: 0 }); await app.close();
  });

  it("gates and strictly rejects malformed request shapes without opening a repository", async () => {
    let accesses = 0; const app = buildApp({ campaignRepositoryFactory: () => { accesses += 1; return { close() {}, listCampaigns: () => [] } as unknown as CampaignListRepository; } });
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(404); expect(accesses).toBe(0); enable();
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts?x=1", headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "application/json" }, payload: { campaignId: "campaign", sessionId: "session", brief: "x", visibleLocation: "place", tone: "tone", difficulty: "easy", partyActorIds: ["actor"], pinnedEnemyTemplates: [], exclusions: [], idempotencyKey: "key", extra: true } })).statusCode).toBe(400); await app.close();
  });
});
