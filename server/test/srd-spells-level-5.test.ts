import { describe, expect, it } from "vitest";
import { spellCatalogDefinitionSchema } from "@velvet/contracts";
import { buildLevel5Spells } from "../src/content/srdStarter/spells/level-5.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const spells = buildLevel5Spells(refs);

describe("SRD 5.1 level-5 spells", () => {
  it("builds at least fifteen 5th-level spells with unique prefixed IDs", () => {
    expect(spells.length).toBeGreaterThanOrEqual(15);
    const ids = spells.map((spell) => spell.reference.definitionId);
    expect(ids.every((id) => id.startsWith("srd-5.1:spell:"))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parses every spell against the spell catalog schema", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.reference.kind).toBe("spell");
      expect(parsed.tags).toEqual(expect.arrayContaining(["srd-5.1", "level-5", "metadata-only"]));
    }
  });

  it("marks every spell as level 5", () => {
    for (const spell of spells) {
      expect(spell.mechanics.level).toBe(5);
    }
  });

  it("keeps every spell bounded with an empty effects array", () => {
    for (const spell of spells) {
      expect(spell.mechanics.effects).toEqual([]);
    }
  });
});
