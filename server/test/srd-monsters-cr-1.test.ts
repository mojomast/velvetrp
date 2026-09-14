import { describe, expect, it } from "vitest";
import {
  abilityCatalogDefinitionSchema,
  contentCatalogDefinitionSchema,
  enemyTemplateCatalogDefinitionSchema,
} from "@velvet/contracts";
import { cr1Band } from "../src/content/srdStarter/monsters/cr-1.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const band = cr1Band(refs);

describe("SRD 5.1 monsters, challenge rating 1", () => {
  it("covers the CR-1 roster with a basic attack and metadata traits", () => {
    expect(band.enemies.length).toBeGreaterThanOrEqual(15);
    expect(band.abilities.length).toBeGreaterThan(band.enemies.length);
  });

  it("parses every ability and enemy with the content catalog schema", () => {
    for (const ability of band.abilities) {
      expect(() => contentCatalogDefinitionSchema.parse(ability)).not.toThrow();
    }
    for (const enemy of band.enemies) {
      expect(() => contentCatalogDefinitionSchema.parse(enemy)).not.toThrow();
    }
  });

  it("gives every enemy a tier of at least one and a combat profile", () => {
    for (const enemy of band.enemies) {
      const parsed = enemyTemplateCatalogDefinitionSchema.parse(enemy);
      expect(parsed.mechanics.tier).toBeGreaterThanOrEqual(1);
      expect(parsed.mechanics.combatProfile).toBeDefined();
      expect(parsed.mechanics.tier).toBe(1);
    }
  });

  it("keeps ability and enemy slugs and ids unique", () => {
    const abilityIds = band.abilities.map((ability) => abilityCatalogDefinitionSchema.parse(ability).reference.definitionId);
    const enemyIds = band.enemies.map((enemy) => enemyTemplateCatalogDefinitionSchema.parse(enemy).reference.definitionId);

    expect(new Set(abilityIds).size).toBe(abilityIds.length);
    expect(new Set(enemyIds).size).toBe(enemyIds.length);
    for (const id of abilityIds) expect(id).toMatch(/^srd-5\.1:ability:[a-z0-9-]+$/);
    for (const id of enemyIds) expect(id).toMatch(/^srd-5\.1:enemy-template:[a-z0-9-]+$/);
  });
});
