import { describe, expect, it } from "vitest";
import { spellCatalogDefinitionSchema } from "@velvet/contracts";
import { createStarterReferences } from "../src/content/srdStarter/references.js";
import { buildLevel3Spells } from "../src/content/srdStarter/spells/level-3.js";

const spells = buildLevel3Spells(createStarterReferences("1.6.0+test"));

describe("SRD 5.1 level-3 spells", () => {
  it("covers at least twenty level-3 spells", () => {
    expect(spells.length).toBeGreaterThanOrEqual(20);
  });

  it("parses every definition against the spell catalog schema", () => {
    for (const spell of spells) {
      expect(() => spellCatalogDefinitionSchema.parse(spell)).not.toThrow();
    }
  });

  it("pins every spell to spell level 3", () => {
    for (const spell of spells) {
      expect(spell.mechanics.level).toBe(3);
    }
  });

  it("mints unique srd-5.1 spell references and keeps effects bounded", () => {
    const definitionIds = spells.map((spell) => spell.reference.definitionId);
    for (const definitionId of definitionIds) {
      expect(definitionId.startsWith("srd-5.1:spell:")).toBe(true);
    }
    expect(new Set(definitionIds).size).toBe(definitionIds.length);
    for (const spell of spells) {
      expect(spell.mechanics.effects).toEqual([]);
    }
  });
});
