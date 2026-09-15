import type { CampaignCatalogResolutionReport } from "@velvet/contracts";
import { describe, expect, it } from "vitest";
import { createEncounterPlanningService, type EncounterCatalogDefinition, type EncounterPlanningDependencies } from "../src/repo/dm/encounterPlanning.js";

const PACK = { packId: "srd-5.1", packVersion: "1.6.0+test", digest: "0".repeat(64) };

function enemy(id: string, name: string, challengeRating?: number, tags: readonly string[] = []): EncounterCatalogDefinition {
  return {
    reference: { kind: "enemy-template", definitionId: id },
    name,
    tags,
    mechanics: challengeRating === undefined ? {} : { challengeRating },
  };
}

const spell: EncounterCatalogDefinition = { reference: { kind: "spell", definitionId: "srd-5.1:spell:light" }, name: "Light", mechanics: {} };

const catalog = (overrides: Partial<CampaignCatalogResolutionReport> = {}): CampaignCatalogResolutionReport => ({
  campaignId: "campaign-one", compatible: true, rulesProfileId: "srd-5.1:rules:starter-v1",
  contentPacks: [PACK], issues: [], ...overrides,
} as CampaignCatalogResolutionReport);

function service(options: { catalog?: CampaignCatalogResolutionReport | null; definitions?: EncounterCatalogDefinition[] } = {}) {
  const dependencies: EncounterPlanningDependencies = {
    resolveCampaignCatalog: () => options.catalog === undefined ? catalog() : options.catalog,
    getCampaignContentCatalog: () => ({ definitions: options.definitions ?? [
      enemy("srd-5.1:enemy-template:goblin", "Goblin", 0.25, ["humanoid"]),
      enemy("srd-5.1:enemy-template:orc", "Orc", 0.5, ["humanoid", "brute"]),
      enemy("srd-5.1:enemy-template:bugbear", "Bugbear", 1, ["humanoid", "brute"]),
      enemy("srd-5.1:enemy-template:unknown-cr", "Unknown CR"),
      spell,
    ] }),
  };
  return createEncounterPlanningService(dependencies);
}

describe("campaign encounter planning service", () => {
  it("resolves pinned enemy templates into sorted exact-CR candidates, skipping non-monsters and CR-less profiles", () => {
    expect(service().listEncounterCandidates("local-owner", "campaign-one")).toEqual([
      { id: "srd-5.1:enemy-template:goblin", name: "Goblin", challengeRating: 0.25, tags: ["humanoid"] },
      { id: "srd-5.1:enemy-template:orc", name: "Orc", challengeRating: 0.5, tags: ["humanoid", "brute"] },
      { id: "srd-5.1:enemy-template:bugbear", name: "Bugbear", challengeRating: 1, tags: ["humanoid", "brute"] },
    ]);
  });

  it("reports catalog presence and no candidates when the campaign has no configured catalog", () => {
    const absent = service({ catalog: null });
    expect(absent.hasCampaignCatalog("local-owner", "campaign-one")).toBe(false);
    expect(absent.listEncounterCandidates("local-owner", "campaign-one")).toEqual([]);
    expect(service().hasCampaignCatalog("local-owner", "campaign-one")).toBe(true);
  });

  it("plans an encounter from the configured candidates and honors candidateIds", () => {
    const plan = service().planEncounter("local-owner", "campaign-one", {
      partyLevels: [3, 3], targetDifficulty: "medium",
      candidateIds: ["srd-5.1:enemy-template:goblin", "srd-5.1:enemy-template:orc"],
    });
    expect(plan.plan.targetDifficulty).toBe("medium");
    expect(plan.candidates).toHaveLength(3);
    const rosterIds = plan.plan.roster.map((entry) => entry.id);
    expect(rosterIds.every((id) => id !== "srd-5.1:enemy-template:bugbear")).toBe(true);
  });

  it("is deterministic", () => {
    const first = service().planEncounter("local-owner", "campaign-one", { partyLevels: [5, 5, 5, 5], targetDifficulty: "hard" });
    const second = service().planEncounter("local-owner", "campaign-one", { partyLevels: [5, 5, 5, 5], targetDifficulty: "hard" });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("previews raw SRD XP and level-up eligibility for pinned defeated enemies", () => {
    const preview = service().previewEncounterRewards("local-owner", "campaign-one", {
      defeatedEnemyIds: ["srd-5.1:enemy-template:goblin", "srd-5.1:enemy-template:orc"],
      currentXp: 300, currentLevel: 1,
    });
    expect(preview.defeated).toEqual([
      { id: "srd-5.1:enemy-template:goblin", challengeRating: 0.25 },
      { id: "srd-5.1:enemy-template:orc", challengeRating: 0.5 },
    ]);
    expect(preview.plan).toMatchObject({ xpAwarded: 150, totalXp: 450, levelUpEligible: true, levelsGained: 1, legal: true });
    expect(() => service().previewEncounterRewards("local-owner", "campaign-one", { defeatedEnemyIds: ["srd-5.1:enemy-template:unknown"], currentXp: 0, currentLevel: 1 })).toThrow();
  });

  it("selects NPC stat blocks by role, CR band, and exclusions", () => {
    const selected = service().selectNpcs("local-owner", "campaign-one", { role: "brute", count: 2 });
    expect(selected.legal).toBe(true);
    expect(selected.selected.map((entry) => entry.id)).toEqual(["srd-5.1:enemy-template:orc", "srd-5.1:enemy-template:bugbear"]);
    const excluded = service().selectNpcs("local-owner", "campaign-one", { count: 3, excludeIds: ["srd-5.1:enemy-template:goblin"] });
    expect(excluded.selected.map((entry) => entry.id)).toEqual(["srd-5.1:enemy-template:orc", "srd-5.1:enemy-template:bugbear"]);
    const short = service().selectNpcs("local-owner", "campaign-one", { count: 4 });
    expect(short.legal).toBe(false);
    expect(short.selected).toHaveLength(3);
    expect(short.reasons[0]).toContain("only 3 of 4");
  });
});
