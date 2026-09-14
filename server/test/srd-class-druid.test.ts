import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { druidDefinition, druidLevels, druidSubclasses } from "../src/content/srdStarter/classes/druid.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const definition = druidDefinition(refs);
const levels = druidLevels(refs);
const subclasses = druidSubclasses(refs);

describe("SRD 5.1 Druid class", () => {
  it("parses the Druid class definition with bounded mechanics", () => {
    const parsed = classCatalogDefinitionSchema.parse(definition);
    expect(parsed.reference.definitionId).toBe("srd-5.1:class:druid");
    expect(parsed.mechanics.hitDie).toBe(8);
    expect(parsed.mechanics.primaryAttribute).toBe("wisdom");
    expect(parsed.mechanics.savingAttributes).toEqual(["intelligence", "wisdom"]);
    expect(parsed.mechanics.levelRefs).toHaveLength(20);
  });

  it("defines exactly the contiguous levels 1 through 20", () => {
    expect(levels).toHaveLength(20);
    const levelNumbers = levels.map((level) => level.mechanics.level).sort((a, b) => a - b);
    expect(levelNumbers).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("parses every class level definition with formula-derived bonuses", () => {
    for (const level of levels) {
      const parsed = classLevelCatalogDefinitionSchema.parse(level);
      expect(parsed.mechanics.abilityRefs).toEqual([]);
      expect(parsed.mechanics.spellRefs).toEqual([]);
      expect(parsed.mechanics.proficiencyBonus).toBe(2 + Math.floor((parsed.mechanics.level - 1) / 4));
    }
  });

  it("grants the d8 hit die at level 1", () => {
    const levelOne = classLevelCatalogDefinitionSchema.parse(levels.find((level) => level.mechanics.level === 1)!);
    expect(levelOne.mechanics.hpGain).toBe(8);
    expect(levelOne.mechanics.resourceGrants).toContainEqual({ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 });
  });

  it("offers the Circle of the Land subclass choice at level 3", () => {
    const levelThree = classLevelCatalogDefinitionSchema.parse(levels.find((level) => level.mechanics.level === 3)!);
    const choice = levelThree.mechanics.progressionChoices?.find((entry) => entry.choiceId === "druid-subclass");
    expect(choice).toMatchObject({ required: true, count: 1, kind: "subclass" });
    expect(choice?.options.map((option) => option.definitionId)).toEqual(["srd-5.1:subclass:circle-of-the-land"]);
  });

  it("parses the Circle of the Land subclass bound to the Druid class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]!);
    expect(parsed.reference.definitionId).toBe("srd-5.1:subclass:circle-of-the-land");
    expect(parsed.reference.kind).toBe("subclass");
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.classRef).toEqual(classCatalogDefinitionSchema.parse(definition).reference);
  });
});
