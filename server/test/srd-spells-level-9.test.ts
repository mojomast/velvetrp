import { describe, expect, it } from "vitest";
import { spellCatalogDefinitionSchema } from "@velvet/contracts";
import { buildLevel9Spells } from "../src/content/srdStarter/spells/level-9.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const spells = buildLevel9Spells(refs);

describe("SRD 5.1 9th-level spells", () => {
  it("builds a non-trivial set of level-9 definitions", () => {
    expect(spells.length).toBeGreaterThanOrEqual(6);
    for (const spell of spells) {
      expect(spell.mechanics.level).toBe(9);
    }
  });

  it("parses every spell against the spell catalog schema", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.reference.kind).toBe("spell");
      expect(parsed.reference.packVersion).toBe("1.6.0+test");
      expect(parsed.tags).toEqual(expect.arrayContaining(["srd-5.1", "level-9", "metadata-only"]));
    }
  });

  it("mints unique srd-5.1 spell definitionIds", () => {
    const ids = spells.map((spell) => spell.reference.definitionId);
    for (const id of ids) {
      expect(id.startsWith("srd-5.1:spell:")).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every definition bounded with an empty effects array", () => {
    for (const spell of spells) {
      expect(spell.mechanics.effects).toEqual([]);
    }
  });
});
