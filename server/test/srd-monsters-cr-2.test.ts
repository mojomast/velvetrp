import { describe, expect, it } from "vitest";
import { contentCatalogDefinitionSchema } from "@velvet/contracts";
import { cr2Band } from "../src/content/srdStarter/monsters/cr-2.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const band = cr2Band(refs);

describe("SRD 5.1 monsters, challenge rating 2", () => {
  it("covers the CR-2 roster with at least twelve enemy templates", () => {
    expect(band.enemies.length).toBeGreaterThanOrEqual(12);
    const names = band.enemies.map((enemy) => (enemy as { name: string }).name);
    for (const expected of ["Ogre", "Gargoyle", "Mimic", "Ghast", "Wererat"]) {
      expect(names).toContain(expected);
    }
  });

  it("parses every CR-2 ability and enemy template with the catalog schema", () => {
    expect(band.abilities.length).toBeGreaterThan(0);
    for (const ability of band.abilities) {
      expect(() => contentCatalogDefinitionSchema.parse(ability)).not.toThrow();
    }
    for (const enemy of band.enemies) {
      expect(() => contentCatalogDefinitionSchema.parse(enemy)).not.toThrow();
    }
  });

  it("gives every enemy a tier and a pinned combat profile", () => {
    for (const enemy of band.enemies) {
      const parsed = contentCatalogDefinitionSchema.parse(enemy);
      if (!("tier" in parsed.mechanics)) throw new Error("expected enemy-template mechanics");
      expect(parsed.mechanics.tier).toBeGreaterThanOrEqual(1);
      expect(parsed.mechanics.combatProfile).toBeDefined();
    }
  });

  it("keeps ability and enemy definition ids unique", () => {
    const definitions = [...band.abilities, ...band.enemies] as readonly { reference: { definitionId: string } }[];
    const ids = definitions.map((definition) => definition.reference.definitionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
