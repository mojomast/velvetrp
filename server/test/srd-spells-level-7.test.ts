import { describe, expect, it } from "vitest";
import { spellCatalogDefinitionSchema } from "@velvet/contracts";
import { buildLevel7Spells } from "../src/content/srdStarter/spells/level-7.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const spells = buildLevel7Spells(refs);

describe("SRD 5.1 7th-level spells", () => {
  it("covers at least ten 7th-level spells", () => {
    expect(spells.length).toBeGreaterThanOrEqual(10);
  });

  it("parses every definition with level-7 mechanics", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.mechanics.level).toBe(7);
    }
  });

  it("mints unique srd-5.1 spell definitionIds", () => {
    const ids = spells.map((spell) => spell.reference.definitionId);
    for (const id of ids) expect(id.startsWith("srd-5.1:spell:")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every entry metadata-only with empty effects", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.mechanics.effects).toEqual([]);
      expect(parsed.tags).toContain("metadata-only");
    }
  });
});
