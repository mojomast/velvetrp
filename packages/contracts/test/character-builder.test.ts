import { describe, expect, it } from "vitest";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  characterBuilderAllocationRequestSchema,
  characterBuilderAllocationSchema,
  characterBuilderPointBuyCost,
  characterDraftViewSchema,
  characterDerivedCalculatorInputSchema,
  createCharacterDraftInputSchema,
} from "../src/index.js";

const standardScores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };

describe("character builder contracts", () => {
  it("accepts every caller allocation and enforces exact standard-array and point-buy bounds", () => {
    expect(CHARACTER_BUILDER_STANDARD_ARRAY).toEqual([15, 14, 13, 12, 10, 8]);
    expect(characterBuilderAllocationRequestSchema.parse({ method: "standard-array", scores: standardScores })).toBeTruthy();
    expect(characterBuilderAllocationRequestSchema.parse({ method: "manual", scores: { ...standardScores, craft: 20 } })).toBeTruthy();
    const pointBuy = { might: 15, agility: 15, resolve: 13, insight: 10, presence: 10, craft: 8 };
    expect(characterBuilderPointBuyCost(pointBuy)).toBe(27);
    expect(characterBuilderAllocationRequestSchema.parse({ method: "point-buy", scores: pointBuy })).toBeTruthy();
    expect(() => characterBuilderAllocationRequestSchema.parse({ method: "standard-array", scores: { ...standardScores, craft: 10 } })).toThrow();
    expect(() => characterBuilderAllocationRequestSchema.parse({ method: "point-buy", scores: { ...standardScores, craft: 9 } })).toThrow();
  });

  it("allows no caller-provided server roll result and strictly validates persisted terms", () => {
    expect(characterBuilderAllocationRequestSchema.parse({ method: "server-roll" })).toEqual({ method: "server-roll" });
    expect(() => characterBuilderAllocationRequestSchema.parse({ method: "server-roll", scores: standardScores })).toThrow();
    expect(() => characterBuilderAllocationSchema.parse({ method: "server-roll", algorithm: "velvet-4d6-drop-first-lowest-v1",
      scores: standardScores, terms: [] })).toThrow();
  });

  it("rejects unknown command and calculator fields", () => {
    expect(() => createCharacterDraftInputSchema.parse({ personaId: "p", controllerPrincipalId: "local-owner", durability: "durable",
      allocation: { method: "server-roll", results: [18] }, idempotencyKey: "key", privateNotes: "not a sheet concern" })).toThrow();
    expect(() => characterDerivedCalculatorInputSchema.parse({ scores: standardScores, racialBonuses: {}, classHp: 10,
      raceSpeed: 30, proficiencyBonus: 2, spellcastingAttribute: "resolve", maxHp: 999 })).toThrow();
  });

  it("models an optional exact prepared-spells group without changing legacy groups", () => {
    const spell = { kind: "spell" as const, packId: "pack", packVersion: "1", definitionId: "bless" };
    const group = { id: "prepared-spells" as const, required: true as const, options: [{ reference: spell, name: "Bless", description: "A blessing." }] };
    expect(group.options[0]!.reference).toEqual(spell);
    expect(() => characterDraftViewSchema.shape.choiceGroups.parse([
      { id: "race", required: true, options: [{ reference: { kind: "race", packId: "pack", packVersion: "1", definitionId: "race" }, name: "Human", description: "A race." }] },
      { id: "background", required: true, options: [{ reference: { kind: "background", packId: "pack", packVersion: "1", definitionId: "background" }, name: "Sage", description: "A background." }] },
      { id: "class", required: true, options: [{ reference: { kind: "class", packId: "pack", packVersion: "1", definitionId: "class" }, name: "Cleric", description: "A class." }] },
      { id: "starter-grant", required: true, options: ["kit", "currency"] }, group,
    ])).not.toThrow();
  });
});
