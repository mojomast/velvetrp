import { describe, expect, it } from "vitest";
import { spellCatalogDefinitionSchema } from "@velvet/contracts";
import { buildLevel0Spells } from "../src/content/srdStarter/spells/level-0.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const spells = buildLevel0Spells(refs);

describe("SRD 5.1 cantrips", () => {
  it("builds at least twenty cantrip definitions", () => {
    expect(spells.length).toBeGreaterThanOrEqual(20);
  });

  it("parses every cantrip against the spell catalog schema at level 0", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.mechanics.level).toBe(0);
    }
  });

  it("mints unique, namespaced spell definitionIds", () => {
    const ids = spells.map((spell) => spell.reference.definitionId);
    for (const id of ids) expect(id.startsWith("srd-5.1:spell:")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves the five original cantrip definitionIds", () => {
    const ids = new Set(spells.map((spell) => spell.reference.definitionId));
    for (const slug of ["light", "fire-bolt", "ray-of-frost", "mage-hand", "sacred-flame"]) {
      expect(ids.has(`srd-5.1:spell:${slug}`)).toBe(true);
    }
  });
});
