import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { monkDefinition, monkLevels, monkSubclasses } from "../src/content/srdStarter/classes/monk.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const monkClass = monkDefinition(refs);
const levels = monkLevels(refs);
const subclasses = monkSubclasses(refs);

describe("SRD 5.1 Monk class", () => {
  it("parses the class definition with the d8/dexterity Monk identity", () => {
    const parsed = classCatalogDefinitionSchema.parse(monkClass);
    expect(parsed.reference.definitionId).toBe("srd-5.1:class:monk");
    expect(parsed.mechanics.hitDie).toBe(8);
    expect(parsed.mechanics.primaryAttribute).toBe("dexterity");
    expect(parsed.mechanics.savingAttributes).toEqual(["strength", "dexterity"]);
    expect(parsed.mechanics.levelRefs).toHaveLength(20);
  });

  it("builds exactly the contiguous levels 1 through 20", () => {
    expect(levels).toHaveLength(20);
    expect(levels.map((level) => level.mechanics.level)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("parses every class level against the formulaic progression contract", () => {
    for (const level of levels) {
      const parsed = classLevelCatalogDefinitionSchema.parse(level);
      expect(parsed.mechanics.proficiencyBonus).toBe(2 + Math.floor((parsed.mechanics.level - 1) / 4));
      expect(parsed.mechanics.hpGain).toBe(parsed.mechanics.level === 1 ? 8 : 5);
      expect(parsed.mechanics.classRef.definitionId).toBe("srd-5.1:class:monk");
      expect(parsed.mechanics.abilityRefs).toEqual([]);
      expect(parsed.mechanics.spellRefs).toEqual([]);
    }
  });

  it("grants the level-one hit die and the level-three subclass choice", () => {
    const levelOne = classLevelCatalogDefinitionSchema.parse(levels[0]!);
    expect(levelOne.mechanics.resourceGrants).toContainEqual({ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 });

    const levelThree = classLevelCatalogDefinitionSchema.parse(levels[2]!);
    expect(levelThree.mechanics.progressionChoices).toEqual([
      { choiceId: "monk-subclass", required: true, count: 1, kind: "subclass", options: [subclasses[0]!.reference] },
    ]);
  });

  it("parses the Way of the Open Hand subclass bound to the Monk class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]!);
    expect(parsed.reference.definitionId).toBe("srd-5.1:subclass:way-of-the-open-hand");
    expect(parsed.name).toBe("Way of the Open Hand");
    expect(parsed.tags).toEqual(expect.arrayContaining(["srd-5.1", "subclass", "monk"]));
    expect(parsed.mechanics.classRef).toEqual(monkClass.reference);
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.abilityRefs).toEqual([]);
  });
});
