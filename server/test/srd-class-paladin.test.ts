import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { paladinDefinition, paladinLevels, paladinSubclasses } from "../src/content/srdStarter/classes/paladin.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const definition = paladinDefinition(refs);
const levels = paladinLevels(refs);
const subclasses = paladinSubclasses(refs);

describe("SRD 5.1 Paladin class", () => {
  it("parses the Paladin class definition with bounded mechanics", () => {
    const parsed = classCatalogDefinitionSchema.parse(definition);
    expect(parsed.reference.definitionId).toBe("srd-5.1:class:paladin");
    expect(parsed.mechanics.hitDie).toBe(10);
    expect(parsed.mechanics.primaryAttribute).toBe("charisma");
    expect(parsed.mechanics.savingAttributes).toEqual(["wisdom", "charisma"]);
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
      if (parsed.mechanics.level !== 1) expect(parsed.mechanics.abilityRefs).toEqual([]);
      expect(parsed.mechanics.spellRefs).toEqual([]);
      expect(parsed.mechanics.proficiencyBonus).toBe(2 + Math.floor((parsed.mechanics.level - 1) / 4));
    }
  });

  it("grants the d10 hit die and Lay on Hands pool at level 1", () => {
    const levelOne = classLevelCatalogDefinitionSchema.parse(levels.find((level) => level.mechanics.level === 1)!);
    expect(levelOne.mechanics.hpGain).toBe(10);
    expect(levelOne.mechanics.resourceGrants).toContainEqual({ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 });
    expect(levelOne.mechanics.resourceGrants).toContainEqual({ resourceId: "lay-on-hands", maxIncrease: 5, currentIncrease: 5, recovery: "long-rest" });
  });

  it("offers the Oath of Devotion subclass choice at level 3", () => {
    const levelThree = classLevelCatalogDefinitionSchema.parse(levels.find((level) => level.mechanics.level === 3)!);
    const choice = levelThree.mechanics.progressionChoices?.find((entry) => entry.choiceId === "paladin-subclass");
    expect(choice).toMatchObject({ required: true, count: 1, kind: "subclass" });
    expect(choice?.options.map((option) => option.definitionId)).toEqual(["srd-5.1:subclass:oath-of-devotion"]);
  });

  it("parses the Oath of Devotion subclass bound to the Paladin class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]!);
    expect(parsed.reference.definitionId).toBe("srd-5.1:subclass:oath-of-devotion");
    expect(parsed.reference.kind).toBe("subclass");
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.classRef).toEqual(classCatalogDefinitionSchema.parse(definition).reference);
  });
});
