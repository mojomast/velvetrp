import { describe, expect, it } from "vitest";
import { actorGameplaySheetResponseSchema, adventureTurnInitialStreamRequestSchema, gameplaySheetEntries, sheetReferenceKey, sheetReferencesSchema, MAX_SHEET_REFERENCES } from "../src/index.js";

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
  it("covers every sheet category with exact identity, values and unavailable power context", () => {
    const value = actorGameplaySheetResponseSchema.parse({ ...sheet, knownPowers: [{ ...sheet.knownPowers[0], available: false, unavailableReasons: ["spell-slot-unavailable"] }] });
    const entries = gameplaySheetEntries(value);
    expect(new Set(entries.map((entry) => entry.reference.section))).toEqual(new Set(["identity", "classes", "attributes", "derived", "progression", "proficiencies", "choices", "resources", "inventory", "powers", "calculations"]));
    expect(entries).toContainEqual({ reference: { section: "resources", key: "health" }, label: "Health", value: "8 / 12" });
    expect(entries.find((entry) => entry.label === "Sword")?.value).toContain("Equipped: hand");
    expect(entries.find((entry) => entry.reference.section === "powers")?.value).toContain("Unavailable");
    expect(new Set(entries.map((entry) => sheetReferenceKey(entry.reference))).size).toBe(entries.length);
  });
  it("accepts only bounded unique selectors, never client-authored facts or another actor", () => {
    const reference = { section: "inventory", key: "item:one" };
    const base = { campaignId: "campaign", sessionId: "session", actorId: "actor", declaration: "I use this", expectedRevision: 0, idempotencyKey: "context-test" };
    expect(adventureTurnInitialStreamRequestSchema.parse(base)).toEqual(base);
    expect(adventureTurnInitialStreamRequestSchema.safeParse({ ...base, sheetReferences: [reference] }).success).toBe(true);
    for (const invalid of [[reference, reference], [{ ...reference, value: "Quantity 999" }], [{ ...reference, actorId: "other" }], [{ section: "privateNotes", key: "secret" }],
      Array.from({ length: MAX_SHEET_REFERENCES + 1 }, (_, key) => ({ section: "inventory", key: String(key) }))]) {
      expect(sheetReferencesSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("preserves duplicate item identity and SRD-specific statistics without inventing starter defenses", () => {
    const item = sheet.inventory.items[0]!;
    const entries = gameplaySheetEntries(actorGameplaySheetResponseSchema.parse({ ...sheet, rulesetId: "dnd-5e", rulesetVersion: "5.1",
      derived: { ...sheet.derived, armorClass: 16 }, inventory: { ...sheet.inventory, items: [item, { ...item, entryId: "second-sword", quantity: 2, equippedSlot: null }] } }));
    expect(entries.filter((entry) => entry.label === "Sword").map((entry) => entry.reference.key)).toEqual(["item:sword-entry", "item:second-sword"]);
    expect(entries.find((entry) => entry.reference.key === "item:second-sword")).toMatchObject({ catalogReference: item.item, value: "Quantity 2 · Not equipped" });
    expect(entries.find((entry) => entry.label === "Armor Class")?.value).toBe("16");
    expect(entries.find((entry) => entry.label === "Agility")?.value).toContain("+2 modifier");
    expect(entries.filter((entry) => entry.reference.section === "derived").map((entry) => entry.label)).not.toContain("Guard");
  });
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
