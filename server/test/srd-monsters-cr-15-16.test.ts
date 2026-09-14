import { describe, expect, it } from "vitest";
import { contentCatalogDefinitionSchema, enemyTemplateCatalogDefinitionSchema } from "@velvet/contracts";
import { cr15To16Band } from "../src/content/srdStarter/monsters/cr-15-16.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const { abilities, enemies } = cr15To16Band(refs);

describe("SRD 5.1 monsters of challenge rating 15 and 16", () => {
  it("provides a bounded band of at least eight CR-15 and CR-16 enemy templates", () => {
    expect(enemies.length).toBeGreaterThanOrEqual(8);
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

  it("gives every enemy a tier, a combat profile, and a matching CR tag", () => {
    for (const enemy of enemies) {
      const parsed = enemyTemplateCatalogDefinitionSchema.parse(enemy);
      expect(parsed.mechanics.tier).toBeGreaterThanOrEqual(1);
      expect(parsed.mechanics.combatProfile).toBeDefined();
      expect(parsed.mechanics.combatProfile?.attack.attackBonus).toBeGreaterThan(0);
      const owner = parsed.tags.find((tag) => tag === "cr-15" || tag === "cr-16");
      expect(owner).toBeDefined();
    }
  });

  it("keeps ability and enemy identifiers unique", () => {
    const abilityIds = abilities.map((ability) => ability.reference.definitionId);
    const enemyIds = enemies.map((enemy) => enemy.reference.definitionId);
    expect(new Set(abilityIds).size).toBe(abilityIds.length);
    expect(new Set(enemyIds).size).toBe(enemyIds.length);
  });
});
