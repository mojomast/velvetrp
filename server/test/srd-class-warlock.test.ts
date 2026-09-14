import { describe, expect, it } from "vitest";
import {
  classCatalogDefinitionSchema,
  classLevelCatalogDefinitionSchema,
  subclassCatalogDefinitionSchema,
} from "@velvet/contracts";
import { createStarterReferences } from "../src/content/srdStarter/references.js";
import { warlockDefinition, warlockLevels, warlockSubclasses } from "../src/content/srdStarter/classes/warlock.js";

const refs = createStarterReferences("1.6.0+test");
const definition = warlockDefinition(refs);
const levels = warlockLevels(refs);
const subclasses = warlockSubclasses(refs);

const parsedLevels = levels.map((level) => classLevelCatalogDefinitionSchema.parse(level));

describe("SRD 5.1 Warlock", () => {
  it("parses the class definition", () => {
    const parsed = classCatalogDefinitionSchema.parse(definition);
    expect(parsed.reference).toMatchObject({ kind: "class", definitionId: "srd-5.1:class:warlock" });
    expect(parsed.mechanics.hitDie).toBe(8);
    expect(parsed.mechanics.primaryAttribute).toBe("charisma");
    expect(parsed.mechanics.savingAttributes).toEqual(["wisdom", "charisma"]);
    expect(parsed.mechanics.levelRefs).toHaveLength(20);
  });

  it("builds exactly twenty contiguous class levels", () => {
    expect(levels).toHaveLength(20);
    expect(parsedLevels.map((level) => level.mechanics.level)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("parses every level with derived proficiency and hit-point gain", () => {
    for (const level of parsedLevels) {
      expect(level.mechanics.abilityRefs).toEqual([]);
      expect(level.mechanics.spellRefs).toEqual([]);
      expect(level.mechanics.proficiencyBonus).toBe(2 + Math.floor((level.mechanics.level - 1) / 4));
      expect(level.mechanics.hpGain).toBe(level.mechanics.level === 1 ? 8 : 5);
    }
  });

  it("grants the d8 hit die at level 1", () => {
    const first = parsedLevels.find((level) => level.mechanics.level === 1)!;
    expect(first.mechanics.resourceGrants).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 }),
    ]));
  });

  it("points the level-three subclass choice at The Fiend", () => {
    const third = parsedLevels.find((level) => level.mechanics.level === 3)!;
    const choice = third.mechanics.progressionChoices?.find((entry) => entry.choiceId === "warlock-subclass");
    expect(choice?.kind).toBe("subclass");
    const subclass = subclassCatalogDefinitionSchema.parse(
      subclasses.find((entry) => entry.reference.definitionId === "srd-5.1:subclass:the-fiend")!,
    );
    expect(choice?.options.map((option) => option.definitionId)).toContain(subclass.reference.definitionId);
  });

  it("parses The Fiend bound to the Warlock class", () => {
    expect(subclasses).toHaveLength(1);
    const parsed = subclassCatalogDefinitionSchema.parse(subclasses[0]);
    expect(parsed.name).toBe("The Fiend");
    expect(parsed.tags).toEqual(expect.arrayContaining(["srd-5.1", "subclass", "warlock"]));
    expect(parsed.mechanics.classRef).toMatchObject({ kind: "class", definitionId: "srd-5.1:class:warlock" });
    expect(parsed.mechanics.level).toBe(3);
  });
});
