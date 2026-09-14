import { describe, expect, it } from "vitest";
import { spellCatalogDefinitionSchema } from "@velvet/contracts";
import { buildLevel1Spells } from "../src/content/srdStarter/spells/level-1.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const spells = buildLevel1Spells(refs);

const ORIGINAL_IDS = [
  "srd-5.1:spell:bless",
  "srd-5.1:spell:cure-wounds",
  "srd-5.1:spell:magic-missile",
  "srd-5.1:spell:shield",
  "srd-5.1:spell:healing-word",
  "srd-5.1:spell:guiding-bolt",
  "srd-5.1:spell:false-life",
];

describe("SRD 5.1 1st-level spells", () => {
  it("builds at least thirty-five level-1 spell definitions", () => {
    expect(spells.length).toBeGreaterThanOrEqual(35);
  });

  it("parses every spell against the spell catalog schema at level 1", () => {
    for (const spell of spells) {
      const parsed = spellCatalogDefinitionSchema.parse(spell);
      expect(parsed.mechanics.level).toBe(1);
    }
  });

  it("mints unique, namespaced spell definitionIds", () => {
    const ids = spells.map((spell) => spell.reference.definitionId);
    for (const id of ids) expect(id.startsWith("srd-5.1:spell:")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves the seven original level-1 spell definitionIds", () => {
    const ids = new Set(spells.map((spell) => spell.reference.definitionId));
    for (const id of ORIGINAL_IDS) expect(ids.has(id)).toBe(true);
  });
});
