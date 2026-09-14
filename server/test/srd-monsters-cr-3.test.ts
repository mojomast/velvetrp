import { describe, expect, it } from "vitest";
import { contentCatalogDefinitionSchema } from "@velvet/contracts";
import { cr3Band } from "../src/content/srdStarter/monsters/cr-3.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

type Reference = { packId: string; packVersion: string; kind: string; definitionId: string };
type CatalogDefinition = {
  reference: Reference;
  name: string;
  tags: string[];
  mechanics: { tier?: number; combatProfile?: unknown };
};

const refs = createStarterReferences("1.6.0+test");
const band = cr3Band(refs);
const abilities = band.abilities as CatalogDefinition[];
const enemies = band.enemies as CatalogDefinition[];

describe("SRD 5.1 monsters, challenge rating 3", () => {
  it("covers the CR-3 roster with at least ten enemy templates", () => {
    expect(enemies.length).toBeGreaterThanOrEqual(10);
    const names = enemies.map((enemy) => enemy.name);
    for (const expected of ["Basilisk", "Bearded Devil", "Mummy", "Minotaur", "Owlbear", "Werewolf", "Wight", "Winter Wolf"]) {
      expect(names).toContain(expected);
    }
  });

  it("parses every CR-3 ability and enemy template with the catalog schema", () => {
    expect(abilities.length).toBeGreaterThan(0);
    for (const ability of abilities) {
      expect(() => contentCatalogDefinitionSchema.parse(ability), ability.reference.definitionId).not.toThrow();
    }
    for (const enemy of enemies) {
      expect(() => contentCatalogDefinitionSchema.parse(enemy), enemy.reference.definitionId).not.toThrow();
    }
  });

  it("gives every enemy a tier and a pinned combat profile", () => {
    for (const enemy of enemies) {
      const parsed = contentCatalogDefinitionSchema.parse(enemy);
      if (!("tier" in parsed.mechanics)) throw new Error("expected enemy-template mechanics");
      expect(parsed.mechanics.tier).toBeGreaterThanOrEqual(1);
      expect(parsed.mechanics.combatProfile).toBeDefined();
    }
  });

  it("keeps ability and enemy definition ids and slugs unique", () => {
    const definitions = [...band.abilities, ...band.enemies] as readonly { reference: { definitionId: string } }[];
    const ids = definitions.map((definition) => definition.reference.definitionId);
    expect(new Set(ids).size).toBe(ids.length);

    const enemySlugs = enemies.map((enemy) => enemy.reference.definitionId.replace("srd-5.1:enemy-template:", ""));
    expect(new Set(enemySlugs).size).toBe(enemySlugs.length);

    const abilitySlugs = abilities.map((ability) => ability.reference.definitionId.replace("srd-5.1:ability:", ""));
    expect(new Set(abilitySlugs).size).toBe(abilitySlugs.length);
  });
});
