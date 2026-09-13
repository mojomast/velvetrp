import { describe, expect, it } from "vitest";
import type { AbilityId } from "../src/rulesets/types.js";
import {
  combinedMulticlassCasterLevel,
  casterLevelContribution,
  DND_5E_MULTICLASS_CASTER_WEIGHTS,
  DND_5E_MULTICLASS_CLASS_IDS,
  DND_5E_MULTICLASS_PREREQUISITES,
  DND_5E_MULTICLASS_PROFICIENCY_GRANTS,
  DND_5E_MULTICLASS_SPELL_SLOT_TABLE,
  multiclassProficiencyGrants,
  multiclassSpellSlots,
  multiclassSpellSlotsFor,
  qualifiesForMulticlass,
  type Dnd5eMulticlassProficiency,
} from "../src/rulesets/dnd5e/multiclassing.js";

const abilityScores = (overrides: Partial<Record<AbilityId, number>> = {}): Record<AbilityId, number> => ({
  strength: 10,
  dexterity: 10,
  constitution: 10,
  intelligence: 10,
  wisdom: 10,
  charisma: 10,
  ...overrides,
});

describe("SRD 5.1 multiclass prerequisites", () => {
  it("declares exhaustive bounded prerequisites for the seven modeled classes", () => {
    expect(Object.keys(DND_5E_MULTICLASS_PREREQUISITES).sort()).toEqual([...DND_5E_MULTICLASS_CLASS_IDS].sort());
    expect(DND_5E_MULTICLASS_PREREQUISITES.barbarian).toEqual({ mode: "all", minimums: { strength: 13 } });
    expect(DND_5E_MULTICLASS_PREREQUISITES.cleric).toEqual({ mode: "all", minimums: { wisdom: 13 } });
    expect(DND_5E_MULTICLASS_PREREQUISITES.fighter).toEqual({ mode: "any", minimums: { strength: 13, dexterity: 13 } });
    expect(DND_5E_MULTICLASS_PREREQUISITES.paladin).toEqual({ mode: "all", minimums: { strength: 13, charisma: 13 } });
    expect(DND_5E_MULTICLASS_PREREQUISITES.ranger).toEqual({ mode: "all", minimums: { dexterity: 13, wisdom: 13 } });
    expect(DND_5E_MULTICLASS_PREREQUISITES.rogue).toEqual({ mode: "all", minimums: { dexterity: 13 } });
    expect(DND_5E_MULTICLASS_PREREQUISITES.wizard).toEqual({ mode: "all", minimums: { intelligence: 13 } });
    expect(Object.isFrozen(DND_5E_MULTICLASS_PREREQUISITES)).toBe(true);
    expect(Object.isFrozen(DND_5E_MULTICLASS_PREREQUISITES.fighter.minimums)).toBe(true);
  });

  it("checks all-of and any-of minimums against six ability scores", () => {
    expect(qualifiesForMulticlass("barbarian", abilityScores({ strength: 13 }))).toBe(true);
    expect(qualifiesForMulticlass("barbarian", abilityScores({ strength: 12 }))).toBe(false);
    expect(qualifiesForMulticlass("fighter", abilityScores({ dexterity: 13 }))).toBe(true);
    expect(qualifiesForMulticlass("fighter", abilityScores({ strength: 13 }))).toBe(true);
    expect(qualifiesForMulticlass("fighter", abilityScores({ strength: 12, dexterity: 12 }))).toBe(false);
    expect(qualifiesForMulticlass("paladin", abilityScores({ strength: 13, charisma: 13 }))).toBe(true);
    expect(qualifiesForMulticlass("paladin", abilityScores({ strength: 13, charisma: 12 }))).toBe(false);
    expect(qualifiesForMulticlass("ranger", abilityScores({ dexterity: 13, wisdom: 13 }))).toBe(true);
    expect(qualifiesForMulticlass("ranger", abilityScores({ dexterity: 13, wisdom: 12 }))).toBe(false);
    expect(qualifiesForMulticlass("wizard", abilityScores({ intelligence: 13 }))).toBe(true);
    expect(qualifiesForMulticlass("rogue", abilityScores({ dexterity: 13 }))).toBe(true);
  });
});

describe("SRD 5.1 multiclass proficiency grants", () => {
  it("grants bounded proficiencies without duplicating existing ones", () => {
    const fighter = multiclassProficiencyGrants("fighter", []);
    expect(fighter).toEqual(["light-armor", "medium-armor", "shields", "simple-weapons", "martial-weapons"]);
    expect(multiclassProficiencyGrants("fighter", ["light-armor", "shields"]))
      .toEqual(["medium-armor", "simple-weapons", "martial-weapons"]);
    expect(multiclassProficiencyGrants("wizard", [])).toEqual([]);
    expect(multiclassProficiencyGrants("barbarian", ["shields", "simple-weapons"])).toEqual(["martial-weapons"]);
    expect(Object.isFrozen(DND_5E_MULTICLASS_PROFICIENCY_GRANTS)).toBe(true);
    expect(Object.isFrozen(multiclassProficiencyGrants("rogue", []))).toBe(true);
  });

  it("keeps each grant list unique and within the closed proficiency vocabulary", () => {
    const allowed = new Set<Dnd5eMulticlassProficiency>([
      "light-armor", "medium-armor", "heavy-armor", "shields", "simple-weapons", "martial-weapons",
    ]);
    for (const classId of DND_5E_MULTICLASS_CLASS_IDS) {
      const grants = DND_5E_MULTICLASS_PROFICIENCY_GRANTS[classId];
      expect(new Set(grants).size, classId).toBe(grants.length);
      for (const grant of grants) expect(allowed.has(grant), `${classId}:${grant}`).toBe(true);
    }
  });
});

describe("SRD 5.1 combined multiclass spell slots", () => {
  it("weights full, half, third, and non-casters deterministically and rounds down", () => {
    expect(DND_5E_MULTICLASS_CASTER_WEIGHTS.wizard).toBe("full");
    expect(DND_5E_MULTICLASS_CASTER_WEIGHTS.cleric).toBe("full");
    expect(DND_5E_MULTICLASS_CASTER_WEIGHTS.paladin).toBe("half");
    expect(DND_5E_MULTICLASS_CASTER_WEIGHTS.ranger).toBe("half");
    expect(DND_5E_MULTICLASS_CASTER_WEIGHTS.barbarian).toBe("none");
    expect(casterLevelContribution("full", 3)).toBe(3);
    expect(casterLevelContribution("half", 1)).toBe(0);
    expect(casterLevelContribution("half", 3)).toBe(1);
    expect(casterLevelContribution("third", 3)).toBe(1);
    expect(casterLevelContribution("third", 6)).toBe(2);
    expect(casterLevelContribution("none", 20)).toBe(0);
    expect(() => casterLevelContribution("full", 21)).toThrow();
    expect(() => casterLevelContribution("full", 1.5)).toThrow();
  });

  it("sums multiclass caster levels and caps the table lookup at twenty", () => {
    expect(combinedMulticlassCasterLevel([{ classId: "wizard", level: 3 }, { classId: "paladin", level: 2 }])).toBe(4);
    expect(combinedMulticlassCasterLevel([{ classId: "cleric", level: 5 }, { classId: "ranger", level: 4 }])).toBe(7);
    expect(combinedMulticlassCasterLevel([{ classId: "fighter", level: 10 }, { classId: "rogue", level: 10 }])).toBe(0);
    expect(() => combinedMulticlassCasterLevel([{ classId: "wizard", level: 0 }])).toThrow();
  });

  it("exposes a full twenty-level table with nine slot columns per row", () => {
    expect(DND_5E_MULTICLASS_SPELL_SLOT_TABLE).toHaveLength(20);
    for (const row of DND_5E_MULTICLASS_SPELL_SLOT_TABLE) {
      expect(row).toHaveLength(9);
      expect(Object.isFrozen(row)).toBe(true);
    }
    expect(multiclassSpellSlots(1)).toEqual({ 1: 2 });
    expect(multiclassSpellSlots(3)).toEqual({ 1: 4, 2: 2 });
    expect(multiclassSpellSlots(20)).toEqual({ 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 2, 8: 1, 9: 1 });
    expect(Object.isFrozen(multiclassSpellSlots(20))).toBe(true);
  });

  it("applies half-caster and third-caster weighting before the slot lookup", () => {
    expect(multiclassSpellSlotsFor([{ classId: "paladin", level: 2 }])).toEqual({ 1: 2 });
    expect(multiclassSpellSlotsFor([{ classId: "paladin", level: 4 }])).toEqual({ 1: 3 });
    expect(multiclassSpellSlotsFor([{ classId: "ranger", level: 3 }])).toEqual({ 1: 2 });
    expect(multiclassSpellSlotsFor([{ classId: "wizard", level: 3 }, { classId: "paladin", level: 2 }])).toEqual({ 1: 4, 2: 3 });
    expect(multiclassSpellSlotsFor([{ classId: "barbarian", level: 5 }])).toEqual({});
    expect(multiclassSpellSlotsFor([{ classId: "fighter", level: 3 }, { classId: "rogue", level: 3 }])).toEqual({});
    expect(() => multiclassSpellSlots(0)).toThrow();
    expect(() => multiclassSpellSlots(21)).toThrow();
  });

  it("returns equal frozen values for equal inputs", () => {
    const first = multiclassSpellSlots(11);
    const second = multiclassSpellSlots(11);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
