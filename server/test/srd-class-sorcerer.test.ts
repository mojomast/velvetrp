import { describe, expect, it } from "vitest";
import { classCatalogDefinitionSchema, classLevelCatalogDefinitionSchema, subclassCatalogDefinitionSchema } from "@velvet/contracts";
import { sorcererDefinition, sorcererLevels, sorcererSubclasses } from "../src/content/srdStarter/classes/sorcerer.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const definition = sorcererDefinition(refs);
const levels = sorcererLevels(refs);
const subclasses = sorcererSubclasses(refs);

describe("SRD 5.1 Sorcerer class", () => {
  it("parses the bounded class definition with Charisma and d6 hit die", () => {
    const parsed = classCatalogDefinitionSchema.parse(definition);
    expect(parsed.reference).toMatchObject({ kind: "class", definitionId: "srd-5.1:class:sorcerer" });
    expect(parsed.mechanics.hitDie).toBe(6);
    expect(parsed.mechanics.primaryAttribute).toBe("charisma");
    expect(parsed.mechanics.savingAttributes).toEqual(["constitution", "charisma"]);
    expect(parsed.mechanics.levelRefs).toHaveLength(20);
  });

  it("emits exactly the contiguous levels 1 through 20", () => {
    expect(levels).toHaveLength(20);
    expect(levels.map((level) => level.mechanics.level)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(new Set(levels.map((level) => level.reference.definitionId)).size).toBe(20);
  });

  it("parses every level with matching proficiency bonus and hit points", () => {
    for (const level of levels) {
      const parsed = classLevelCatalogDefinitionSchema.parse(level);
      expect(parsed.reference.definitionId).toBe(`srd-5.1:class-level:sorcerer-${parsed.mechanics.level}`);
      expect(parsed.mechanics.proficiencyBonus).toBe(2 + Math.floor((parsed.mechanics.level - 1) / 4));
      expect(parsed.mechanics.hpGain).toBe(parsed.mechanics.level === 1 ? 6 : 4);
      expect(parsed.mechanics.abilityRefs).toEqual([]);
      expect(parsed.mechanics.spellRefs).toEqual([]);
      expect(parsed.tags).toContain("unsupported-runtime");
    }
  });

  it("grants the d6 hit die at level one", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[0]);
    expect(parsed.mechanics.resourceGrants).toEqual(expect.arrayContaining([{ resourceId: "hit-dice-d6", maxIncrease: 1, currentIncrease: 1 }]));
  });

  it("offers the Draconic Bloodline subclass choice at level three", () => {
    const parsed = classLevelCatalogDefinitionSchema.parse(levels[2]);
    const choice = parsed.mechanics.progressionChoices?.find((entry) => entry.choiceId === "sorcerer-subclass");
    expect(choice?.kind).toBe("subclass");
    expect(choice?.required).toBe(true);
    expect(choice?.count).toBe(1);
    expect(choice?.options.map((option) => option.definitionId)).toEqual(["srd-5.1:subclass:draconic-bloodline"]);
  });

  it("parses the Draconic Bloodline subclass against the sorcerer class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]);
    expect(parsed.name).toBe("Draconic Bloodline");
    expect(parsed.mechanics.classRef).toEqual(definition.reference);
    expect(parsed.mechanics.level).toBe(3);
    expect(parsed.mechanics.abilityRefs).toEqual([]);
    expect(parsed.tags).toEqual(expect.arrayContaining(["srd-5.1", "subclass", "sorcerer"]));
  });
});
