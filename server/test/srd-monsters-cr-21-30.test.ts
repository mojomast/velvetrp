import { describe, expect, it } from "vitest";
import { contentCatalogDefinitionSchema, enemyTemplateCatalogDefinitionSchema } from "@velvet/contracts";
import { cr21To30Band } from "../src/content/srdStarter/monsters/cr-21-30.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const { abilities, enemies } = cr21To30Band(refs);

describe("SRD 5.1 monsters of challenge rating 21 through 30", () => {
  it("provides a bounded band of at least ten CR-21 through CR-30 enemy templates", () => {
    expect(enemies.length).toBeGreaterThanOrEqual(10);
    for (const enemy of enemies) {
      expect(enemy.reference.definitionId.startsWith("srd-5.1:enemy-template:")).toBe(true);
    }
  });

  it("parses every ability and enemy with the content catalog schema", () => {
    for (const ability of abilities) {
      expect(() => contentCatalogDefinitionSchema.parse(ability), ability.reference.definitionId).not.toThrow();
    }
    for (const enemy of enemies) {
      expect(() => contentCatalogDefinitionSchema.parse(enemy), enemy.reference.definitionId).not.toThrow();
    }
  });

  it("gives every enemy a tier and a combat profile", () => {
    for (const enemy of enemies) {
      const parsed = enemyTemplateCatalogDefinitionSchema.parse(enemy);
      expect(parsed.mechanics.tier).toBeGreaterThanOrEqual(1);
      expect(parsed.mechanics.combatProfile).toBeDefined();
    }
  });

  it("keeps ability and enemy identifiers unique", () => {
    const abilityIds = abilities.map((ability) => ability.reference.definitionId);
    const enemyIds = enemies.map((enemy) => enemy.reference.definitionId);
    expect(new Set(abilityIds).size).toBe(abilityIds.length);
    expect(new Set(enemyIds).size).toBe(enemyIds.length);
  });
});
