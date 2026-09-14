import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { rangerDefinition, rangerLevels, rangerSubclasses } from "../src/content/srdStarter/classes/ranger.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");

describe("SRD 5.1 Ranger class", () => {
  it("parses the Ranger class definition with bounded mechanics", () => {
    const parsed = classCatalogDefinitionSchema.parse(rangerDefinition(refs));
    expect(parsed.reference.definitionId).toBe("srd-5.1:class:ranger");
    expect(parsed.mechanics.hitDie).toBe(10);
    expect(parsed.mechanics.primaryAttribute).toBe("dexterity");
    expect(parsed.mechanics.savingAttributes).toEqual(["strength", "dexterity"]);
    expect(parsed.mechanics.levelRefs).toHaveLength(20);
  });

  it("defines exactly the contiguous levels 1 through 20", () => {
    const levels = rangerLevels(refs);
    expect(levels).toHaveLength(20);
    const levelNumbers = levels.map((level) => level.mechanics.level).sort((a, b) => a - b);
    expect(levelNumbers).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("parses every class level definition with formula-derived bonuses", () => {
    for (const level of rangerLevels(refs)) {
      const parsed = classLevelCatalogDefinitionSchema.parse(level);
      expect(parsed.mechanics.proficiencyBonus).toBe(2 + Math.floor((parsed.mechanics.level - 1) / 4));
      expect(parsed.mechanics.hpGain).toBe(parsed.mechanics.level === 1 ? 10 : 6);
      expect(parsed.mechanics.spellRefs).toEqual([]);
    }
  });

  it("grants the d10 hit die at level 1 and points the level-3 choice at the Hunter", () => {
    const levels = rangerLevels(refs);
    const levelOne = classLevelCatalogDefinitionSchema.parse(levels.find((level) => level.mechanics.level === 1)!);
    expect(levelOne.mechanics.resourceGrants).toContainEqual({ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 });
    const levelThree = classLevelCatalogDefinitionSchema.parse(levels.find((level) => level.mechanics.level === 3)!);
    const choice = levelThree.mechanics.progressionChoices?.find((entry) => entry.choiceId === "ranger-subclass");
    expect(choice).toMatchObject({ required: true, count: 1, kind: "subclass" });
    expect(choice?.options.map((option) => option.definitionId)).toEqual(["srd-5.1:subclass:hunter"]);
  });

  it("parses the Hunter subclass bound to the Ranger class", () => {
    const subclasses = rangerSubclasses(refs);
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]!);
    expect(parsed.reference.definitionId).toBe("srd-5.1:subclass:hunter");
    expect(parsed.reference.kind).toBe("subclass");
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.classRef).toEqual(classCatalogDefinitionSchema.parse(rangerDefinition(refs)).reference);
  });
});
