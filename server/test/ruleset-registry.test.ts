import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULESET,
  DEFAULT_RULESET_ID,
  DND_5E_RULESET,
  DND_5E_RULESET_DESCRIPTOR,
  RulesetRegistry,
  createDefaultRulesetRegistry,
  dnd5eAbilityModifier,
  dnd5eProficiencyBonus,
  resolveDnd5eCheck,
  VELVET_LEGACY_RULESET,
  type RulesetModule,
} from "../src/rulesets/index.js";

describe("D&D 5e development ruleset", () => {
  it("publishes an immutable, versioned descriptor with capabilities", () => {
    expect(DND_5E_RULESET_DESCRIPTOR).toMatchObject({
      id: "dnd-5e",
      version: "1.0.0",
      name: "SRD 5.1 (2014 Fifth Edition) Development Module",
      source: {
        title: "System Reference Document 5.1",
        publisher: "Wizards of the Coast LLC",
        edition: "2014 fifth edition",
        url: "https://dnd.wizards.com/resources/systems-reference-document",
      },
      license: {
        name: "Creative Commons Attribution 4.0 International",
        identifier: "CC-BY-4.0",
        url: "https://creativecommons.org/licenses/by/4.0/legalcode",
        attribution: "This work includes material taken from the System Reference Document 5.1 (SRD 5.1) by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under CC-BY-4.0, available at https://creativecommons.org/licenses/by/4.0/legalcode.",
      },
      abilities: [
        { id: "strength", name: "Strength", abbreviation: "STR" },
        { id: "dexterity", name: "Dexterity", abbreviation: "DEX" },
        { id: "constitution", name: "Constitution", abbreviation: "CON" },
        { id: "intelligence", name: "Intelligence", abbreviation: "INT" },
        { id: "wisdom", name: "Wisdom", abbreviation: "WIS" },
        { id: "charisma", name: "Charisma", abbreviation: "CHA" },
      ],
      difficultyClasses: [
        { id: "very-easy", name: "Very Easy", value: 5 },
        { id: "easy", name: "Easy", value: 10 },
        { id: "medium", name: "Medium", value: 15 },
        { id: "hard", name: "Hard", value: 20 },
        { id: "very-hard", name: "Very Hard", value: 25 },
        { id: "nearly-impossible", name: "Nearly Impossible", value: 30 },
      ],
    });
    expect(Object.isFrozen(DND_5E_RULESET_DESCRIPTOR)).toBe(true);
    expect(Object.isFrozen(DND_5E_RULESET_DESCRIPTOR.source)).toBe(true);
    expect(Object.isFrozen(DND_5E_RULESET_DESCRIPTOR.license)).toBe(true);
    expect(Object.isFrozen(DND_5E_RULESET_DESCRIPTOR.supportedMechanics)).toBe(true);
    expect(DND_5E_RULESET_DESCRIPTOR.capabilities).toContainEqual({ id: "checks", version: "1.0.0", status: "supported" });
    expect(Object.isFrozen(DND_5E_RULESET_DESCRIPTOR.capabilities)).toBe(true);
    expect(DND_5E_RULESET_DESCRIPTOR.capabilities?.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(DND_5E_RULESET_DESCRIPTOR.abilities)).toBe(true);
    expect(DND_5E_RULESET_DESCRIPTOR.abilities.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(DND_5E_RULESET_DESCRIPTOR.difficultyClasses)).toBe(true);
    expect(DND_5E_RULESET_DESCRIPTOR.difficultyClasses.every(Object.isFrozen)).toBe(true);
    expect(DND_5E_RULESET.mechanics?.resolveAttack).toBeTypeOf("function");
    expect(Object.isFrozen(DND_5E_RULESET.mechanics)).toBe(true);
  });

  it("calculates ability modifiers and level-based proficiency bonuses", () => {
    expect([1, 8, 9, 10, 11, 20].map(dnd5eAbilityModifier)).toEqual([-5, -1, -1, 0, 0, 5]);
    expect([1, 4, 5, 8, 9, 12, 13, 16, 17, 20].map(dnd5eProficiencyBonus)).toEqual([
      2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    ]);
    expect(() => dnd5eProficiencyBonus(0)).toThrow("level must be between 1 and 20");
    expect(() => dnd5eProficiencyBonus(21)).toThrow("level must be between 1 and 20");
  });

  it("resolves checks deterministically from an injected d20 value", () => {
    expect(resolveDnd5eCheck({ d20: 12, abilityScore: 14, proficiencyBonus: 3, dc: 17 })).toEqual({
      d20: 12,
      abilityModifier: 2,
      proficiencyBonus: 3,
      total: 17,
      dc: 17,
      success: true,
    });
    expect(resolveDnd5eCheck({ d20: 11, abilityScore: 14, proficiencyBonus: 3, dc: 17 }).success).toBe(false);
    expect(resolveDnd5eCheck({ d20: 1, abilityScore: 20, proficiencyBonus: 6, dc: 10 }).success).toBe(true);
    expect(resolveDnd5eCheck({ d20: 20, abilityScore: 1, proficiencyBonus: 0, dc: 20 }).success).toBe(false);
    expect(() => resolveDnd5eCheck({ d20: 0, abilityScore: 10, proficiencyBonus: 0, dc: 10 })).toThrow(
      "d20 must be between 1 and 20",
    );
  });
});

describe("ruleset registry", () => {
  const alternate: RulesetModule = Object.freeze({
    descriptor: Object.freeze({
      id: "test-rules",
      version: "1",
      name: "Test Rules",
      scope: "Test-only rules.",
      source: Object.freeze({ title: "Test", publisher: "Test", edition: "Test", url: "https://example.com/source" }),
      license: Object.freeze({ name: "Test", identifier: "Test", url: "https://example.com/license", attribution: "Test" }),
      supportedMechanics: Object.freeze([]),
      abilities: Object.freeze([]),
      difficultyClasses: Object.freeze([]),
    }),
    abilityModifier: () => 0,
    proficiencyBonus: () => 0,
    resolveCheck: ({ d20, dc }) => Object.freeze({
      d20,
      abilityModifier: 0,
      proficiencyBonus: 0,
      total: d20,
      dc,
      success: d20 >= dc,
    }),
  });

  it("uses D&D 5e as the default while allowing another module to be selected", () => {
    const defaults = createDefaultRulesetRegistry();
    expect(DEFAULT_RULESET_ID).toBe("dnd-5e");
    expect(DEFAULT_RULESET).toBe(DND_5E_RULESET);
    expect(defaults.get(DEFAULT_RULESET_ID)).toBe(DND_5E_RULESET);

    defaults.register(alternate);
    expect(defaults.get("test-rules")).toBe(alternate);
    expect(defaults.list()).toEqual([DND_5E_RULESET, VELVET_LEGACY_RULESET, alternate]);
    expect(Object.isFrozen(defaults.list())).toBe(true);
  });

  it("rejects duplicate and unknown ruleset IDs", () => {
    expect(() => new RulesetRegistry([alternate, alternate])).toThrow("duplicate ruleset identity: test-rules@1");
    const registry = new RulesetRegistry([alternate]);
    expect(() => registry.register(alternate)).toThrow("duplicate ruleset identity: test-rules@1");
    expect(() => registry.get("missing", "1")).toThrow("unknown ruleset identity: missing@1");
  });

  it("resolves exact versions and keeps the Velvet legacy adapter behavior available", () => {
    const registry = createDefaultRulesetRegistry();
    expect(registry.get("dnd-5e", "1.0.0")).toBe(DND_5E_RULESET);
    expect(() => registry.get("dnd-5e", "0.1.0")).toThrow("unknown ruleset identity: dnd-5e@0.1.0");
    expect(registry.get("velvet-starter-v1", "1.0.0").resolveCheck({ d20: 10, abilityScore: 15,
      proficiencyBonus: 2, dc: 14 })).toMatchObject({ abilityModifier: 2, total: 14, success: true });
  });
});
