import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { rogueDefinition, rogueLevels, rogueSubclasses } from "../src/content/srdStarter/classes/rogue.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const definition = rogueDefinition(refs);
const levels = rogueLevels(refs);
const subclasses = rogueSubclasses(refs);

describe("SRD 5.1 Rogue class", () => {
  it("parses the Rogue class definition with d8 hit die and Dexterity mechanics", () => {
    const parsed = classCatalogDefinitionSchema.parse(definition);
    expect(parsed.reference.definitionId).toBe("srd-5.1:class:rogue");
    expect(parsed.mechanics.hitDie).toBe(8);
    expect(parsed.mechanics.primaryAttribute).toBe("dexterity");
    expect(parsed.mechanics.savingAttributes).toEqual(["dexterity", "intelligence"]);
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
      expect(parsed.mechanics.spellRefs).toEqual([]);
    }
  });

  it("grants the d8 hit die and preserves the Sneak Attack ability ref at level 1", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[0]);
    expect(parsed.mechanics.resourceGrants).toContainEqual({ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 });
    expect(parsed.mechanics.abilityRefs.map((ability) => ability.definitionId)).toContain("srd-5.1:ability:rogue-sneak-attack");
    expect(levels[0]!.reference.definitionId).toBe("srd-5.1:class-level:rogue-1");
  });

  it("points the level 3 subclass choice at Thief", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[2]);
    const choice = parsed.mechanics.progressionChoices?.find((candidate) => candidate.choiceId === "rogue-subclass");
    expect(choice).toMatchObject({ required: true, count: 1, kind: "subclass" });
    expect(choice?.options.map((option) => option.definitionId)).toEqual(["srd-5.1:subclass:thief"]);
  });

  it("parses the Thief subclass bound to the Rogue class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]);
    expect(parsed.reference.definitionId).toBe("srd-5.1:subclass:thief");
    expect(parsed.reference.kind).toBe("subclass");
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.abilityRefs).toEqual([]);
    expect(parsed.mechanics.classRef).toEqual(classCatalogDefinitionSchema.parse(definition).reference);
  });
});
