import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { characterProgressionRoutes } from "../src/routes/rpg/v1/characterProgression.js";
import {
  CharacterProgressionAuthorizationError,
  CharacterProgressionConflictError,
  CharacterProgressionStaleError,
  CharacterProgressionUnavailableError,
} from "../src/repo/characterProgressionRepo.js";

process.env.NODE_ENV = "test";
const state = { campaignCharacterId: "character", campaignId: "campaign", sheetId: "sheet", actorId: "actor", profile: { profileId: "velvet:progression:p", rulesProfileId: "velvet:rules:starter-v1", mode: "xp" as const, maxLevel: 1, thresholds: [{ level: 1, xp: 0 }] }, classRef: { kind: "class" as const, packId: "pack", packVersion: "1", definitionId: "class" }, level: 1, totalXp: 0, milestoneCount: 0, revision: 0, pendingChoices: [], knownAbilities: [], knownSpells: [], derived: { maxHp: 8, defenses: { guard: 10, evasion: 10, will: 10 }, initiative: 0, speed: 30, carryingLimit: 120, spellAttack: 2, saveDc: 10, explanations: Array.from({ length: 9 }, (_, index) => ({ statistic: ["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"][index], formula: "0", inputs: {}, result: 0 })) }, updatedAt: "2030-01-01T00:00:00.000Z" } as any;
const preview = { campaignCharacterId: "character", revision: 0, token: "a".repeat(64), mode: "xp" as const, currentLevel: 1, eligibleLevel: 1, totalXp: 0, milestoneCount: 0, pendingChoices: [], levels: [] };
function app(repository = { getCharacterProgression: vi.fn(() => state), previewCharacterProgression: vi.fn(() => preview) }) { const instance = Fastify({ logger: false }); instance.register(characterProgressionRoutes, { prefix: "/api/rpg/v1", characterProgressionRepositoryAccessor: () => repository as any }); return { instance, repository }; }
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

describe("isolated progression HTTP lane", () => {
  it("gates before the repository and fixes the local principal", async () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; const { instance, repository } = app(); const unsupported = await instance.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/characters/character/progression" }); expect(unsupported.statusCode).toBe(404); expect(repository.getCharacterProgression).not.toHaveBeenCalled(); process.env.FEATURE_RPG_MECHANICS = "true"; const response = await instance.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/characters/character/progression", headers: { authorization: "Bearer attacker" } }); expect(response.statusCode).toBe(200); expect(() => response.json()).not.toThrow(); expect(response.json()).toHaveProperty("progression"); expect(repository.getCharacterProgression).toHaveBeenCalledWith("local-owner", "character"); expect(response.headers["cache-control"]).toBe("no-store"); await instance.close(); });
  it("binds progression state to the campaign path exactly", async () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; const { instance } = app({ getCharacterProgression: vi.fn(() => ({ ...state, campaignId: "other" })), previewCharacterProgression: vi.fn(() => preview) }); const response = await instance.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/characters/character/progression" }); expect(response.statusCode).toBe(404); expect(response.json()).toMatchObject({ code: "RPG_CHARACTER_PROGRESSION_NOT_FOUND" }); await instance.close(); });
  it("previews without mutation and enforces path, body, media, and method rules", async () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; const { instance, repository } = app(); const response = await instance.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/characters/character/progression/preview", payload: { selections: [] } }); expect(response.statusCode).toBe(200); expect(response.json().preview).not.toHaveProperty("token"); expect(repository.previewCharacterProgression).toHaveBeenCalledWith("local-owner", "character", []); expect((await instance.inject({ method: "POST", url: "/api/rpg/v1/campaigns/other/characters/character/progression/preview", payload: { selections: [] } })).statusCode).toBe(404); expect((await instance.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/characters/character/progression/preview", headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415); expect((await instance.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/characters/character/progression?x=1" })).statusCode).toBe(400); expect((await instance.inject({ method: "HEAD", url: "/api/rpg/v1/campaigns/campaign/characters/character/progression" })).statusCode).toBe(404); await instance.close(); });
  it("masks unavailable and repository corruption", async () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; const { instance } = app({ getCharacterProgression: vi.fn(() => { throw new Error("private database corruption"); }), previewCharacterProgression: vi.fn() }); const response = await instance.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/characters/character/progression" }); expect(response.statusCode).toBe(500); expect(response.body).not.toContain("private database corruption"); await instance.close(); });
  it.each([
    [new CharacterProgressionAuthorizationError(), "RPG_CHARACTER_PROGRESSION_NOT_FOUND"],
    [new CharacterProgressionUnavailableError(), "RPG_CHARACTER_PROGRESSION_NOT_FOUND"],
  ])("maps non-disclosing typed absence (%s)", async (error, code) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true";
    const { instance } = app({ getCharacterProgression: vi.fn(() => { throw error; }), previewCharacterProgression: vi.fn() });
    const response = await instance.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/characters/character/progression" });
    expect(response.statusCode).toBe(404); expect(response.json()).toMatchObject({ code });
    await instance.close();
  });
  it.each([
    [new CharacterProgressionStaleError(), "RPG_CHARACTER_PROGRESSION_STALE"],
    [new CharacterProgressionConflictError(), "RPG_CHARACTER_PROGRESSION_CONFLICT"],
  ])("maps reviewed typed progression conflicts (%s)", async (error, code) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true";
    const { instance } = app({ getCharacterProgression: vi.fn(() => { throw error; }), previewCharacterProgression: vi.fn() });
    const response = await instance.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/characters/character/progression" });
    expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ code });
    await instance.close();
  });
});
