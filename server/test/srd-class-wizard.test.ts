import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { wizardDefinition, wizardLevels, wizardSubclasses } from "../src/content/srdStarter/classes/wizard.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const definition = wizardDefinition(refs);
const levels = wizardLevels(refs);
const subclasses = wizardSubclasses(refs);

describe("SRD 5.1 Wizard class", () => {
  it("parses the Wizard class definition with d6 hit die and Intelligence mechanics", () => {
    const parsed = classCatalogDefinitionSchema.parse(definition);
    expect(parsed.reference.definitionId).toBe("srd-5.1:class:wizard");
    expect(parsed.mechanics.hitDie).toBe(6);
    expect(parsed.mechanics.primaryAttribute).toBe("intelligence");
    expect(parsed.mechanics.savingAttributes).toEqual(["intelligence", "wisdom"]);
    expect(parsed.mechanics.levelRefs).toHaveLength(20);
  });

  it("builds exactly the contiguous level set 1..20", () => {
    expect(levels).toHaveLength(20);
    const numbers = levels.map((level) => classLevelCatalogDefinitionSchema.parse(level).mechanics.level);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("parses every class level with the expected proficiency bonus, hp, and empty refs", () => {
    for (const level of levels) {
      const parsed = classLevelCatalogDefinitionSchema.parse(level);
      expect(parsed.mechanics.proficiencyBonus).toBe(2 + Math.floor((parsed.mechanics.level - 1) / 4));
      expect(parsed.mechanics.hpGain).toBe(parsed.mechanics.level === 1 ? 6 : 4);
      if (parsed.mechanics.level !== 1) {
        expect(parsed.mechanics.abilityRefs).toEqual([]);
        expect(parsed.mechanics.spellRefs).toEqual([]);
      }
    }
  });

  it("keeps the level-1 spellbook, cantrips, prepared spells, and d6 hit-die grant", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[0]!);
    expect(parsed.mechanics.abilityRefs.map((reference) => reference.definitionId)).toEqual(["srd-5.1:ability:wizard-spellbook"]);
    expect(parsed.mechanics.spellRefs.map((reference) => reference.definitionId)).toEqual(["srd-5.1:spell:fire-bolt", "srd-5.1:spell:ray-of-frost"]);
    expect(parsed.mechanics.preparedSpellRefs?.map((reference) => reference.definitionId)).toEqual(["srd-5.1:spell:magic-missile", "srd-5.1:spell:false-life", "srd-5.1:spell:shield"]);
    expect(parsed.mechanics.resourceGrants).toContainEqual({ resourceId: "hit-dice-d6", maxIncrease: 1, currentIncrease: 1 });
  });

  it("points the level-3 subclass choice at the School of Evocation", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[2]!);
    const choice = parsed.mechanics.progressionChoices?.find((candidate) => candidate.choiceId === "wizard-subclass");
    expect(choice).toMatchObject({ required: true, count: 1, kind: "subclass" });
    expect(choice?.options.map((option) => option.definitionId)).toEqual(["srd-5.1:subclass:school-of-evocation"]);
  });

  it("parses the School of Evocation subclass bound to the Wizard class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]!);
    expect(parsed.reference.definitionId).toBe("srd-5.1:subclass:school-of-evocation");
    expect(parsed.reference.kind).toBe("subclass");
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.classRef).toEqual(classCatalogDefinitionSchema.parse(definition).reference);
  });
});
