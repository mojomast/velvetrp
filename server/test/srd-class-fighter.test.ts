import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { fighterDefinition, fighterLevels, fighterSubclasses } from "../src/content/srdStarter/classes/fighter.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const definition = fighterDefinition(refs);
const levels = fighterLevels(refs);
const subclasses = fighterSubclasses(refs);

describe("SRD 5.1 Fighter class", () => {
  it("parses the Fighter class definition with d10 hit die and Strength mechanics", () => {
    const parsed = classCatalogDefinitionSchema.parse(definition);
    expect(parsed.reference.definitionId).toBe("srd-5.1:class:fighter");
    expect(parsed.mechanics.hitDie).toBe(10);
    expect(parsed.mechanics.primaryAttribute).toBe("strength");
    expect(parsed.mechanics.savingAttributes).toEqual(["strength", "constitution"]);
    expect(parsed.mechanics.levelRefs).toHaveLength(20);
  });

  it("defines exactly the contiguous levels 1 through 20", () => {
    expect(levels).toHaveLength(20);
    const levelNumbers = levels.map((level) => level.mechanics.level).sort((a, b) => a - b);
    expect(levelNumbers).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("parses every class level with formula-derived bonuses and empty spell refs", () => {
    for (const level of levels) {
      const parsed = classLevelCatalogDefinitionSchema.parse(level);
      expect(parsed.mechanics.proficiencyBonus).toBe(2 + Math.floor((parsed.mechanics.level - 1) / 4));
      expect(parsed.mechanics.hpGain).toBe(parsed.mechanics.level === 1 ? 10 : 6);
      expect(parsed.mechanics.spellRefs).toEqual([]);
    }
  });

  it("grants the d10 hit die at level 1 and preserves the level 1-2 ability refs", () => {
    const levelOne = classLevelCatalogDefinitionSchema.parse(levels.find((level) => level.mechanics.level === 1)!);
    expect(levelOne.mechanics.resourceGrants).toContainEqual({ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 });
    expect(levelOne.mechanics.abilityRefs.map((ref) => ref.definitionId)).toEqual(["srd-5.1:ability:longsword-attack", "srd-5.1:ability:fighter-second-wind"]);
    const levelTwo = classLevelCatalogDefinitionSchema.parse(levels.find((level) => level.mechanics.level === 2)!);
    expect(levelTwo.mechanics.abilityRefs.map((ref) => ref.definitionId)).toEqual(["srd-5.1:ability:fighter-action-surge"]);
  });

  it("offers the Champion subclass choice at level 3", () => {
    const levelThree = classLevelCatalogDefinitionSchema.parse(levels.find((level) => level.mechanics.level === 3)!);
    const choice = levelThree.mechanics.progressionChoices?.find((entry) => entry.choiceId === "fighter-subclass");
    expect(choice).toMatchObject({ required: true, count: 1, kind: "subclass" });
    expect(choice?.options.map((option) => option.definitionId)).toEqual(["srd-5.1:subclass:champion"]);
  });

  it("parses the Champion subclass bound to the Fighter class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]!);
    expect(parsed.reference.definitionId).toBe("srd-5.1:subclass:champion");
    expect(parsed.reference.kind).toBe("subclass");
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.classRef).toEqual(classCatalogDefinitionSchema.parse(definition).reference);
  });
});
