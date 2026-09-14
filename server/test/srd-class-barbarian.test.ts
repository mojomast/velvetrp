import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { barbarianDefinition, barbarianLevels, barbarianSubclasses } from "../src/content/srdStarter/classes/barbarian.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const definition = barbarianDefinition(refs);
const levels = barbarianLevels(refs);
const subclasses = barbarianSubclasses(refs);

describe("SRD 5.1 Barbarian class", () => {
  it("parses the Barbarian class definition with d12 hit die and Strength mechanics", () => {
    const parsed = classCatalogDefinitionSchema.parse(definition);
    expect(parsed.reference.definitionId).toBe("srd-5.1:class:barbarian");
    expect(parsed.mechanics.hitDie).toBe(12);
    expect(parsed.mechanics.primaryAttribute).toBe("strength");
    expect(parsed.mechanics.savingAttributes).toEqual(["strength", "constitution"]);
    expect(parsed.mechanics.levelRefs).toHaveLength(20);
  });

  it("builds exactly the contiguous level set 1..20", () => {
    expect(levels).toHaveLength(20);
    const numbers = levels.map((level) => classLevelCatalogDefinitionSchema.parse(level).mechanics.level);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("parses every class level with formula-derived proficiency and hp gains", () => {
    for (const level of levels) {
      const parsed = classLevelCatalogDefinitionSchema.parse(level);
      expect(parsed.mechanics.proficiencyBonus).toBe(2 + Math.floor((parsed.mechanics.level - 1) / 4));
      expect(parsed.mechanics.hpGain).toBe(parsed.mechanics.level === 1 ? 12 : 7);
      expect(parsed.mechanics.spellRefs).toEqual([]);
    }
  });

  it("grants the d12 hit die and rage capacity at level 1", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[0]);
    expect(parsed.mechanics.resourceGrants).toContainEqual({ resourceId: "hit-dice-d12", maxIncrease: 1, currentIncrease: 1 });
    expect(parsed.mechanics.resourceGrants).toContainEqual({ resourceId: "rage", maxIncrease: 2, currentIncrease: 2, recovery: "long-rest" });
    expect(parsed.mechanics.abilityRefs.map((ability) => ability.definitionId)).toEqual(["srd-5.1:ability:barbarian-rage"]);
  });

  it("points the level 3 subclass choice at Path of the Berserker", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[2]);
    const choice = parsed.mechanics.progressionChoices?.find((candidate) => candidate.kind === "subclass");
    expect(choice).toMatchObject({ choiceId: "barbarian-subclass", required: true, count: 1, kind: "subclass" });
    expect(choice?.kind === "subclass" ? choice.options.map((option) => option.definitionId) : []).toEqual(["srd-5.1:subclass:path-of-the-berserker"]);
  });

  it("parses the Path of the Berserker subclass bound to the Barbarian class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]);
    expect(parsed.reference.definitionId).toBe("srd-5.1:subclass:path-of-the-berserker");
    expect(parsed.reference.kind).toBe("subclass");
    expect(parsed.tags).toEqual(["srd-5.1", "subclass", "barbarian"]);
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.classRef).toEqual(classCatalogDefinitionSchema.parse(definition).reference);
    expect(parsed.mechanics.abilityRefs).toEqual([]);
  });
});
