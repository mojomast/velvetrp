import { describe, expect, it } from "vitest";
import { actorGameplaySheetResponseSchema } from "../src/index.js";

const reference = (kind: "race" | "background" | "class" | "item" | "ability", definitionId: string) => ({
  kind, packId: "starter", packVersion: "1.0.0", definitionId,
});
const derived = {
  maxHp: 12, defenses: { guard: 11, evasion: 12, will: 10 }, initiative: 2, speed: 30,
  carryingLimit: 120, spellAttack: 3, saveDc: 11,
  explanations: ["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"]
    .map((statistic) => ({ statistic, formula: "base", inputs: {}, result: 0 })),
};
const sheet = {
  identity: { actorId: "actor", name: "Aria" },
  race: { reference: reference("race", "human"), label: "Human" },
  background: { reference: reference("background", "guide"), label: "Guide" },
  classes: [{ reference: reference("class", "ranger"), label: "Ranger", level: 2 }],
  attributes: [{ attributeId: "agility", label: "Agility", value: 14 }],
  proficiencies: [{ proficiencyId: "tracking", label: "Tracking", category: "skill" }],
  choices: [{ choiceId: "training", label: "Training", selection: { reference: reference("ability", "flare"), label: "Flare" } }],
  derived,
  progression: { mode: "xp", level: 2, totalXp: 900, milestoneCount: 0, pendingChoiceCount: 0, updatedAt: "2030-01-01T00:00:00.000Z" },
  resources: [{ resourceId: "health", label: "Health", current: 8, capacity: 12 }],
  inventory: { capacity: 10, items: [{ entryId: "sword-entry", item: reference("item", "sword"), label: "Sword", quantity: 1, equippedSlot: "hand" }] },
  knownPowers: [{ power: reference("ability", "flare"), label: "Flare", available: true, unavailableReasons: [] }],
  activeEffects: [],
};

describe("actor gameplay sheet HTTP contract", () => {
  it("accepts the complete strict public projection", () => {
    expect(actorGameplaySheetResponseSchema.parse(sheet)).toEqual(sheet);
  });

  it("rejects private fields and inconsistent computed state", () => {
    expect(actorGameplaySheetResponseSchema.safeParse({ ...sheet, privateNotes: "secret" }).success).toBe(false);
    expect(actorGameplaySheetResponseSchema.safeParse({ ...sheet, progression: { ...sheet.progression, campaignCharacterId: "private" } }).success).toBe(false);
    expect(actorGameplaySheetResponseSchema.safeParse({ ...sheet, knownPowers: [{ ...sheet.knownPowers[0], available: false }] }).success).toBe(false);
    expect(actorGameplaySheetResponseSchema.safeParse({ ...sheet, progression: { ...sheet.progression, level: 1 } }).success).toBe(false);
  });
});
