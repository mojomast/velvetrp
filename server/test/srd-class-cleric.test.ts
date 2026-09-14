import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { clericDefinition, clericLevels, clericSubclasses } from "../src/content/srdStarter/classes/cleric.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const definition = clericDefinition(refs);
const levels = clericLevels(refs);
const subclasses = clericSubclasses(refs);

describe("SRD 5.1 Cleric class", () => {
  it("parses the Cleric class definition with d8 hit die and Wisdom mechanics", () => {
    const parsed = classCatalogDefinitionSchema.parse(definition);
    expect(parsed.name).toBe("Cleric");
    expect(parsed.mechanics.hitDie).toBe(8);
    expect(parsed.mechanics.primaryAttribute).toBe("wisdom");
    expect(parsed.mechanics.savingAttributes).toEqual(["wisdom", "charisma"]);
    expect(parsed.mechanics.levelRefs).toHaveLength(20);
  });

  it("builds exactly the contiguous level set 1..20", () => {
    expect(levels).toHaveLength(20);
    const numbers = levels.map((level) => level.mechanics.level).sort((a, b) => a - b);
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

  it("grants the d8 hit die and the prepared spells at level 1", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[0]);
    expect(parsed.mechanics.resourceGrants).toContainEqual({ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 });
    expect(parsed.mechanics.preparedSpellRefs?.map((spell) => spell.definitionId)).toEqual([
      "srd-5.1:spell:bless",
      "srd-5.1:spell:cure-wounds",
      "srd-5.1:spell:healing-word",
    ]);
  });

  it("points the level 3 subclass choice at Life Domain", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[2]);
    const choice = parsed.mechanics.progressionChoices?.find((candidate) => candidate.kind === "subclass");
    expect(choice).toBeDefined();
    expect(choice?.kind === "subclass" ? choice.choiceId : undefined).toBe("cleric-subclass");
    expect(choice?.kind === "subclass" ? choice.options[0]?.definitionId : undefined).toBe("srd-5.1:subclass:life-domain");
  });

  it("parses the Life Domain subclass bound to the Cleric class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]);
    expect(parsed.reference.definitionId).toBe("srd-5.1:subclass:life-domain");
    expect(parsed.reference.kind).toBe("subclass");
    expect(parsed.mechanics.classRef).toEqual(classCatalogDefinitionSchema.parse(definition).reference);
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.abilityRefs).toEqual([]);
  });
});
