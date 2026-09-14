import { describe, expect, it } from "vitest";
import { spellCatalogDefinitionSchema } from "@velvet/contracts";
import { buildLevel8Spells } from "../src/content/srdStarter/spells/level-8.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const spells = buildLevel8Spells(refs);

describe("SRD 5.1 level-8 spells", () => {
  it("builds at least eight bounded level-8 spell definitions", () => {
    expect(spells.length).toBeGreaterThanOrEqual(8);
  });

  it("parses every level-8 spell against the catalog schema", () => {
    for (const spell of spells) {
      expect(() => spellCatalogDefinitionSchema.parse(spell)).not.toThrow();
    }
  });

  it("keeps every level-8 spell at mechanics.level 8", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.mechanics.level).toBe(8);
    }
  });

  it("mints unique srd-5.1 spell ids and leaves effects empty", () => {
    const parsed = spells.map((spell) => spellCatalogDefinitionSchema.parse(spell));
    const ids = parsed.map((spell) => spell.reference.definitionId);
    expect(ids.every((id) => id.startsWith("srd-5.1:spell:"))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spell of parsed) {
      expect(spell.mechanics.effects).toEqual([]);
    }
  });
});
