import { describe, expect, it } from "vitest";
import {
  abilityCatalogDefinitionSchema,
  contentCatalogDefinitionSchema,
  enemyTemplateCatalogDefinitionSchema,
} from "@velvet/contracts";
import { cr4Band } from "../src/content/srdStarter/monsters/cr-4.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";

type Reference = { packId: string; packVersion: string; kind: string; definitionId: string };
type CatalogDefinition = {
  reference: Reference;
  name: string;
  tags: string[];
  mechanics: { abilityRefs?: Reference[] };
};

const refs = createStarterReferences("1.6.0+test");
const band = cr4Band(refs);
const abilities = band.abilities as CatalogDefinition[];
const enemies = band.enemies as CatalogDefinition[];

const referenceKey = (reference: Reference) => `${reference.packId}\0${reference.packVersion}\0${reference.kind}\0${reference.definitionId}`;

describe("SRD 5.1 monsters, challenge rating 4", () => {
  it("defines at least eight unique namespaced CR-4 enemy templates and abilities", () => {
    expect(enemies.length).toBeGreaterThanOrEqual(8);

    const enemyIds = enemies.map((enemy) => enemy.reference.definitionId);
    expect(new Set(enemyIds).size).toBe(enemyIds.length);
    for (const enemy of enemies) {
      expect(enemy.reference.kind).toBe("enemy-template");
      expect(enemy.reference.definitionId.startsWith("srd-5.1:enemy-template:")).toBe(true);
      expect(enemy.tags).toContain("srd-5.1");
      expect(enemy.tags).toContain("cr-4");
    }

    const abilityIds = abilities.map((ability) => ability.reference.definitionId);
    expect(new Set(abilityIds).size).toBe(abilityIds.length);
    for (const ability of abilities) {
      expect(ability.reference.kind).toBe("ability");
      expect(ability.reference.definitionId.startsWith("srd-5.1:ability:")).toBe(true);
    }
  });

  it("parses every band ability and enemy with the content catalog schema", () => {
    for (const ability of abilities) {
      expect(() => contentCatalogDefinitionSchema.parse(ability), ability.reference.definitionId).not.toThrow();
    }
    for (const enemy of enemies) {
      expect(() => contentCatalogDefinitionSchema.parse(enemy), enemy.reference.definitionId).not.toThrow();
    }
  });

  it("gives every enemy a bounded tier and a pinned combat profile backed by a band ability", () => {
    const abilityKeys = new Set(abilities.map((ability) => referenceKey(ability.reference)));
    for (const enemy of enemies) {
      const parsed = enemyTemplateCatalogDefinitionSchema.parse(enemy);
      expect(parsed.mechanics.tier, `${parsed.name} tier`).toBeGreaterThanOrEqual(1);
      expect(parsed.mechanics.combatProfile?.kind, `${parsed.name} combat profile`).toBe("dnd-5e-pinned-basic-attack-v1");

      const attack = parsed.mechanics.combatProfile?.attack;
      expect(attack, `${parsed.name} pinned attack`).toBeDefined();
      if (!attack) continue;
      expect(abilityKeys.has(referenceKey(attack.abilityRef)), `${parsed.name} -> ${attack.abilityRef.definitionId}`).toBe(true);
      expect(parsed.mechanics.abilityRefs.some((abilityRef) => referenceKey(abilityRef) === referenceKey(attack.abilityRef))).toBe(true);
    }
  });

  it("keeps executable attacks and metadata-only traits within the bounded mechanics", () => {
    for (const ability of abilities) {
      const parsed = abilityCatalogDefinitionSchema.parse(ability);
      if (parsed.tags.includes("enemy-trait")) {
        expect(parsed.mechanics.actionCost, `${parsed.name} trait cost`).toBe("passive");
        expect(parsed.mechanics.target, `${parsed.name} trait target`).toBe("self");
        expect(parsed.mechanics.effects, `${parsed.name} trait effects`).toEqual([]);
      } else {
        expect(parsed.tags).toContain("enemy-basic-attack");
        expect(parsed.mechanics.actionCost, `${parsed.name} attack cost`).toBe("action");
        expect(parsed.mechanics.target, `${parsed.name} attack target`).toBe("enemy");
        expect(parsed.mechanics.effects[0]).toMatchObject({ type: "damage" });
      }
    }
  });
});
