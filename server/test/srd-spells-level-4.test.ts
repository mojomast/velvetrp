import { describe, expect, it } from "vitest";
import { spellCatalogDefinitionSchema } from "@velvet/contracts";
import { buildLevel4Spells } from "../src/content/srdStarter/spells/level-4.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const spells = buildLevel4Spells(refs);

describe("SRD 5.1 level-4 spells", () => {
  it("provides broad 4th-level coverage", () => {
    expect(spells.length).toBeGreaterThanOrEqual(15);
  });

  it("parses every spell as a bounded level-4 catalog definition", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.mechanics.level).toBe(4);
    }
  });

  it("mints uniquely identified srd-5.1 spell references", () => {
    const definitionIds = spells.map((spell) => spell.reference.definitionId);
    for (const definitionId of definitionIds) {
      expect(definitionId.startsWith("srd-5.1:spell:")).toBe(true);
    }
    expect(new Set(definitionIds).size).toBe(definitionIds.length);
  });

  it("keeps every spell metadata-only with no executable effects", () => {
    for (const spell of spells) {
      expect(spell.mechanics.effects).toEqual([]);
      expect(spell.tags).toContain("srd-5.1");
      expect(spell.tags).toContain("level-4");
      expect(spell.tags).toContain("metadata-only");
    }
  });
});
