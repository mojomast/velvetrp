import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { bardDefinition, bardLevels, bardSubclasses } from "../src/content/srdStarter/classes/bard.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const definition = bardDefinition(refs);
const levels = bardLevels(refs);
const subclasses = bardSubclasses(refs);

describe("SRD 5.1 Bard class", () => {
  it("parses the Bard class definition with d8 hit die and Charisma mechanics", () => {
    const parsed = classCatalogDefinitionSchema.parse(definition);
    expect(parsed.name).toBe("Bard");
    expect(parsed.mechanics.hitDie).toBe(8);
    expect(parsed.mechanics.primaryAttribute).toBe("charisma");
    expect(parsed.mechanics.savingAttributes).toEqual(["dexterity", "charisma"]);
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
      expect(parsed.mechanics.hpGain).toBe(parsed.mechanics.level === 1 ? 8 : 5);
      expect(parsed.mechanics.abilityRefs).toEqual([]);
      expect(parsed.mechanics.spellRefs).toEqual([]);
    }
  });

  it("grants the d8 hit die at level 1", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[0]);
    expect(parsed.mechanics.resourceGrants).toContainEqual({ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 });
  });

  it("points the level 3 subclass choice at College of Lore", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[2]);
    const choice = parsed.mechanics.progressionChoices?.find((candidate) => candidate.kind === "subclass");
    expect(choice).toBeDefined();
    expect(choice?.kind === "subclass" ? choice.options[0]?.definitionId : undefined).toBe("srd-5.1:subclass:college-of-lore");
  });

  it("parses the College of Lore subclass bound to the Bard class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]);
    expect(parsed.reference.definitionId).toBe("srd-5.1:subclass:college-of-lore");
    expect(parsed.mechanics.classRef.definitionId).toBe("srd-5.1:class:bard");
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.abilityRefs).toEqual([]);
  });
});
