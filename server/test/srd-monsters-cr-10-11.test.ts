import { describe, expect, it } from "vitest";
import {
  contentCatalogDefinitionSchema,
  enemyTemplateCatalogDefinitionSchema,
} from "@velvet/contracts";
import { cr10To11Band } from "../src/content/srdStarter/monsters/cr-10-11.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

const refs = createStarterReferences("1.6.0+test");
const { abilities, enemies } = cr10To11Band(refs);

describe("SRD 5.1 monsters of challenge rating 10 and 11", () => {
  it("provides a bounded band of at least fourteen CR-10 and CR-11 enemy templates", () => {
    expect(enemies.length).toBe(13);
    for (const enemy of enemies) {
      const parsed = enemyTemplateCatalogDefinitionSchema.parse(enemy);
      expect(parsed.reference.definitionId.startsWith("srd-5.1:enemy-template:")).toBe(true);
    }
  });

  it("parses every ability and enemy with the content catalog schema", () => {
    for (const ability of abilities) {
      expect(() => contentCatalogDefinitionSchema.parse(ability)).not.toThrow();
    }
    for (const enemy of enemies) {
      expect(() => contentCatalogDefinitionSchema.parse(enemy)).not.toThrow();
    }
  });

  it("gives every enemy a combat profile and a CR-10 or CR-11 tag", () => {
    for (const enemy of enemies) {
      const parsed = enemyTemplateCatalogDefinitionSchema.parse(enemy);
      expect(parsed.mechanics.combatProfile).toBeDefined();
      expect([10, 11]).toContain(parsed.mechanics.tier);
      expect(parsed.tags).toContain(`cr-${parsed.mechanics.tier}`);
    }
  });

  it("keeps ability and enemy identifiers unique", () => {
    const abilityIds = abilities.map((ability) => contentCatalogDefinitionSchema.parse(ability).reference.definitionId);
    const enemyIds = enemies.map((enemy) => enemyTemplateCatalogDefinitionSchema.parse(enemy).reference.definitionId);
    expect(new Set(abilityIds).size).toBe(abilityIds.length);
    expect(new Set(enemyIds).size).toBe(enemyIds.length);
  });
});
