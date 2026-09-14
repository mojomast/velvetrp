import { describe, expect, it } from "vitest";
import { spellCatalogDefinitionSchema } from "@velvet/contracts";
import { buildLevel2Spells } from "../src/content/srdStarter/spells/level-2.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const spells = buildLevel2Spells(refs);

describe("SRD 5.1 2nd-level spells", () => {
  it("builds at least twenty level-2 spell definitions", () => {
    expect(spells.length).toBeGreaterThanOrEqual(20);
  });

  it("parses every spell against the spell catalog schema at level 2", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.mechanics.level).toBe(2);
    }
  });

  it("mints unique, namespaced spell definitionIds", () => {
    const ids = spells.map((spell) => spell.reference.definitionId);
    for (const id of ids) expect(id.startsWith("srd-5.1:spell:")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every spell metadata-only with empty effects", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.mechanics.effects).toEqual([]);
      expect(parsed.tags).toContain("metadata-only");
    }
  });
});
