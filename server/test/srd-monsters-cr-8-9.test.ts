import { describe, expect, it } from "vitest";
import { contentCatalogDefinitionSchema } from "@velvet/contracts";
import { cr8To9Band } from "../src/content/srdStarter/monsters/cr-8-9.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

type Reference = { packId: string; packVersion: string; kind: string; definitionId: string };
type CatalogDefinition = {
  reference: Reference;
  name: string;
  tags: string[];
  mechanics: {
    abilityRefs?: Reference[];
    combatProfile?: { kind: string; attack: { abilityRef: Reference; attackBonus: number } };
  };
};

const refs = createStarterReferences("1.6.0+test");
const band = cr8To9Band(refs);
const abilities = band.abilities as CatalogDefinition[];
const enemies = band.enemies as CatalogDefinition[];

describe("SRD 5.1 monsters, challenge rating 8 and 9", () => {
  it("provides a bounded band of at least sixteen CR-8 and CR-9 enemy templates", () => {
    expect(enemies.length).toBeGreaterThanOrEqual(16);
    for (const enemy of enemies) {
      expect(enemy.reference.kind).toBe("enemy-template");
      expect(enemy.reference.definitionId.startsWith("srd-5.1:enemy-template:")).toBe(true);
      expect(enemy.tags.some((tag) => tag === "cr-8" || tag === "cr-9")).toBe(true);
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
      const parsed = contentCatalogDefinitionSchema.parse(enemy);
      expect(parsed.reference.kind).toBe("enemy-template");
      expect((parsed.mechanics as { tier?: number }).tier, `${parsed.name} tier`).toBeGreaterThanOrEqual(1);
      expect(enemy.mechanics.combatProfile, `${enemy.name} combat profile`).toBeDefined();
      expect(enemy.mechanics.combatProfile?.kind).toBe("dnd-5e-pinned-basic-attack-v1");
    }
  });

  it("keeps ability and enemy identifiers unique", () => {
    const abilityIds = abilities.map((ability) => ability.reference.definitionId);
    const enemyIds = enemies.map((enemy) => enemy.reference.definitionId);
    expect(new Set(abilityIds).size).toBe(abilityIds.length);
    expect(new Set(enemyIds).size).toBe(enemyIds.length);
  });
});
