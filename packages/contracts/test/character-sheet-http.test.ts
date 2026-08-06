import { describe, expect, it } from "vitest";
import { characterSheetHttpResponseSchema } from "../src/index.js";

const at = "2030-01-01T00:00:00.000Z";
const derived = {
  maxHp: 10, defenses: { guard: 10, evasion: 10, will: 10 }, initiative: 0, speed: 30,
  carryingLimit: 100, spellAttack: 0, saveDc: 10,
  explanations: ["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"].map((statistic) => ({ statistic, formula: "base", inputs: {}, result: 0 })),
};
const response = {
  sheet: {
    name: "Aria",
    race: { name: "Human", description: "Adaptable" },
    background: { name: "Guide", description: "Knows the roads" },
    classes: [{ name: "Ranger", description: "A wilderness scout", level: 2 }],
    attributes: [], proficiencies: [], choices: [], resources: [],
  },
  derived,
  progression: { mode: "xp", level: 2, totalXp: 900, milestoneCount: 0, updatedAt: at },
};

describe("character sheet HTTP contract", () => {
  it("publishes only display-safe sheet and progression state", () => {
    expect(characterSheetHttpResponseSchema.parse(response)).toEqual(response);
    expect(characterSheetHttpResponseSchema.safeParse({ ...response, actorId: "private" }).success).toBe(false);
    expect(characterSheetHttpResponseSchema.safeParse({
      ...response,
      progression: { ...response.progression, campaignCharacterId: "private" },
    }).success).toBe(false);
    expect(characterSheetHttpResponseSchema.safeParse({
      ...response,
      progression: { ...response.progression, previewToken: "a".repeat(64) },
    }).success).toBe(false);
  });

  it("requires displayed class levels to match progression level", () => {
    expect(characterSheetHttpResponseSchema.safeParse({
      ...response,
      progression: { ...response.progression, level: 1 },
    }).success).toBe(false);
  });
});
