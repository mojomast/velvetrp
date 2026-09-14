import { describe, expect, it } from "vitest";
import { contentCatalogDefinitionSchema, enemyTemplateCatalogDefinitionSchema } from "@velvet/contracts";
import { cr12To14Band } from "../src/content/srdStarter/monsters/cr-12-14.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const { abilities, enemies } = cr12To14Band(refs);

describe("SRD 5.1 monsters of challenge rating 12, 13, and 14", () => {
  it("provides a bounded band covering every CR-12 to CR-14 enemy template", () => {
    expect(enemies.length).toBeGreaterThanOrEqual(11);
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
      expect(parsed.mechanics.tier).toBeGreaterThanOrEqual(12);
      expect(parsed.mechanics.combatProfile).toBeDefined();
      const crTag = parsed.tags.find((tag) => tag.startsWith("cr-"));
      expect(crTag).toMatch(/^cr-1[234]$/);
    }
  });

  it("keeps ability and enemy identifiers unique", () => {
    const abilityIds = abilities.map((ability) => ability.reference.definitionId);
    const enemyIds = enemies.map((enemy) => enemy.reference.definitionId);
    expect(new Set(abilityIds).size).toBe(abilityIds.length);
    expect(new Set(enemyIds).size).toBe(enemyIds.length);
  });
});
