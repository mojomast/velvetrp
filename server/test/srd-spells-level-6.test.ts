import { describe, expect, it } from "vitest";
import { spellCatalogDefinitionSchema } from "@velvet/contracts";
import { createStarterReferences } from "../src/content/srdStarter/references.js";
import { buildLevel6Spells } from "../src/content/srdStarter/spells/level-6.js";

const refs = createStarterReferences("1.6.0+test");
const spells = buildLevel6Spells(refs);

describe("SRD 5.1 level-6 spells", () => {
  it("builds a breadth-first level-6 list with unique, prefixed definition IDs", () => {
    expect(spells.length).toBeGreaterThanOrEqual(12);
    const ids = spells.map((spell) => spell.reference.definitionId);
    for (const id of ids) expect(id.startsWith("srd-5.1:spell:")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parses every spell against the spell catalog schema", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.reference.kind).toBe("spell");
      expect(parsed.tags).toEqual(expect.arrayContaining(["srd-5.1", "level-6", "metadata-only"]));
    }
  });

  it("pins every spell to 6th level", () => {
    for (const spell of spells) {
      expect(spellCatalogDefinitionSchema.parse(spell).mechanics.level).toBe(6);
    }
  });

  it("keeps every spell bounded to empty metadata-only effects", () => {
    for (const spell of spells) {
      expect(spellCatalogDefinitionSchema.parse(spell).mechanics.effects).toEqual([]);
    }
  });
});
