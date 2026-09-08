import { afterEach, describe, expect, it } from "vitest";
import type { ActorGameplaySheetResponse } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
});
const enable = () => {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
};
const at = "2030-01-01T00:00:00.000Z";
const ref = <K extends "race" | "background" | "class">(kind: K, definitionId: string) => ({
  kind, packId: "starter", packVersion: "1.0.0", definitionId,
});
const sheet: ActorGameplaySheetResponse = {
  identity: { actorId: "actor", name: "Aria" },
  race: { reference: ref("race", "human"), label: "Human" },
  background: { reference: ref("background", "guide"), label: "Guide" },
  classes: [{ reference: ref("class", "ranger"), label: "Ranger", level: 1 }],
  attributes: [{ attributeId: "agility", label: "Agility", value: 14 }],
  proficiencies: [{ proficiencyId: "tracking", label: "Tracking", category: "skill" }],
  choices: [],
  derived: {
    maxHp: 10, defenses: { guard: 10, evasion: 12, will: 10 }, initiative: 2, speed: 30,
    carryingLimit: 100, spellAttack: 2, saveDc: 10,
    explanations: (["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"] as const)
      .map((statistic) => ({ statistic, formula: "base", inputs: {}, result: 0 })),
  },
  progression: { mode: "xp", level: 1, totalXp: 0, milestoneCount: 0, pendingChoiceCount: 0, updatedAt: at },
  resources: [], inventory: { capacity: 10, items: [] }, knownPowers: [], activeEffects: [],
};

function repository(read: (principal: string, actorId: string) => unknown): CampaignListRepository {
  return { getActorGameplaySheet: read, close() {}, listCampaigns: () => [] } as unknown as CampaignListRepository;
}

describe("GET /api/rpg/v1/actors/:actorId/gameplay-sheet", () => {
  it("binds the path to fixed local authority and emits the strict no-store projection", async () => {
    enable();
    const calls: Array<[string, string]> = [];
    const app = buildApp({ campaignRepositoryFactory: () => repository((principal, actorId) => {
      calls.push([principal, actorId]);
      return sheet;
    }) });
    const response = await app.inject({
      method: "GET", url: "/api/rpg/v1/actors/actor/gameplay-sheet",
      headers: { authorization: "Bearer outsider", "x-principal-id": "outsider" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(sheet);
    expect(calls).toEqual([["local-owner", "actor"]]);
    expect(response.body).not.toContain("privateNotes");
    expect(response.body).not.toContain("provider");
    await app.close();
  });

  it("gates first and masks invalid, denied, and absent actors as not found", async () => {
    let accesses = 0;
    const gated = buildApp({ campaignRepositoryFactory: () => {
      accesses += 1;
      return repository(() => sheet);
    } });
    expect((await gated.inject({ method: "GET", url: "/api/rpg/v1/actors/actor/gameplay-sheet" })).statusCode).toBe(404);
    expect(accesses).toBe(0);
    enable();
    expect((await gated.inject({ method: "GET", url: "/api/rpg/v1/actors/actor/gameplay-sheet?x=1" })).statusCode).toBe(400);
    expect((await gated.inject({ method: "GET", url: "/api/rpg/v1/actors/bad%20actor/gameplay-sheet" })).statusCode).toBe(404);
    expect((await gated.inject({ method: "HEAD", url: "/api/rpg/v1/actors/actor/gameplay-sheet" })).statusCode).toBe(404);
    await gated.close();

    const hidden = buildApp({ campaignRepositoryFactory: () => repository(() => null) });
    const response = await hidden.inject({ method: "GET", url: "/api/rpg/v1/actors/actor/gameplay-sheet" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "RPG_ACTOR_GAMEPLAY_SHEET_NOT_FOUND" });
    await hidden.close();
  });

  it("rejects mismatched or non-contract output without leaking failures", async () => {
    enable();
    for (const value of [{ ...sheet, identity: { ...sheet.identity, actorId: "other" } }, { ...sheet, privateNotes: "secret" }]) {
      const app = buildApp({ campaignRepositoryFactory: () => repository(() => value) });
      const response = await app.inject({ method: "GET", url: "/api/rpg/v1/actors/actor/gameplay-sheet" });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("secret");
      await app.close();
    }
    const failed = buildApp({ campaignRepositoryFactory: () => repository(() => { throw new Error("private SQL"); }) });
    const response = await failed.inject({ method: "GET", url: "/api/rpg/v1/actors/actor/gameplay-sheet" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private SQL");
    await failed.close();
  });
});
