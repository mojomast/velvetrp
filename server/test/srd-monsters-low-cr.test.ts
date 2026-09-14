import { describe, expect, it } from "vitest";
import {
  abilityCatalogDefinitionSchema,
  enemyTemplateCatalogDefinitionSchema,
  SRD_5_1_STARTER_IDENTITY,
} from "@velvet/contracts";
import { buildAbilities } from "../src/content/srdStarter/abilities.js";
import { buildEnemies } from "../src/content/srdStarter/enemies.js";
import { createStarterReferences } from "../src/content/srdStarter/references.js";
import { monsterAttackStepsFromContent } from "../src/repo/encounter/monster/content.js";

const refs = createStarterReferences(SRD_5_1_STARTER_IDENTITY.packVersion);
const enemies = buildEnemies(refs);
const abilities = buildAbilities(refs);

/**
 * CR is not a catalog field on `enemy-template`, so each template carries its
 * challenge rating band as a `cr-*` tag. This table is the test's source of
 * truth for the SRD 5.1 numbers the definitions must reproduce.
 */
type ExpectedMonster = Readonly<{
  id: string;
  name: string;
  cr: "cr-0" | "cr-1-8" | "cr-1-4" | "cr-1-2";
  ac: number;
  hp: number;
  speed: number;
  attackId: string;
  attackBonus: number;
  damage: Readonly<{ damageType: string; count: number; sides: number; modifier: number }>;
  traits: readonly string[];
}>;

const LOW_CR_MONSTERS: readonly ExpectedMonster[] = [
  // Challenge rating 0
  { id: "srd-5.1:enemy-template:bat", name: "Bat", cr: "cr-0", ac: 12, hp: 1, speed: 30, attackId: "srd-5.1:ability:bat-bite", attackBonus: 0, damage: { damageType: "piercing", count: 1, sides: 4, modifier: -1 }, traits: [] },
  { id: "srd-5.1:enemy-template:cat", name: "Cat", cr: "cr-0", ac: 12, hp: 2, speed: 40, attackId: "srd-5.1:ability:cat-claws", attackBonus: 0, damage: { damageType: "slashing", count: 1, sides: 4, modifier: -1 }, traits: [] },
  { id: "srd-5.1:enemy-template:crab", name: "Crab", cr: "cr-0", ac: 11, hp: 2, speed: 20, attackId: "srd-5.1:ability:crab-claw", attackBonus: 0, damage: { damageType: "bludgeoning", count: 1, sides: 4, modifier: -1 }, traits: [] },
  { id: "srd-5.1:enemy-template:giant-fire-beetle", name: "Giant Fire Beetle", cr: "cr-0", ac: 13, hp: 4, speed: 30, attackId: "srd-5.1:ability:giant-fire-beetle-bite", attackBonus: 1, damage: { damageType: "slashing", count: 1, sides: 6, modifier: -1 }, traits: [] },
  { id: "srd-5.1:enemy-template:jackal", name: "Jackal", cr: "cr-0", ac: 12, hp: 3, speed: 40, attackId: "srd-5.1:ability:jackal-bite", attackBonus: 1, damage: { damageType: "piercing", count: 1, sides: 4, modifier: -1 }, traits: ["srd-5.1:ability:enemy-pack-tactics"] },
  { id: "srd-5.1:enemy-template:lizard", name: "Lizard", cr: "cr-0", ac: 10, hp: 2, speed: 20, attackId: "srd-5.1:ability:lizard-bite", attackBonus: 0, damage: { damageType: "piercing", count: 1, sides: 4, modifier: -1 }, traits: [] },
  { id: "srd-5.1:enemy-template:rat", name: "Rat", cr: "cr-0", ac: 10, hp: 1, speed: 20, attackId: "srd-5.1:ability:rat-bite", attackBonus: 0, damage: { damageType: "piercing", count: 1, sides: 4, modifier: -1 }, traits: [] },
  { id: "srd-5.1:enemy-template:weasel", name: "Weasel", cr: "cr-0", ac: 13, hp: 1, speed: 30, attackId: "srd-5.1:ability:weasel-bite", attackBonus: 5, damage: { damageType: "piercing", count: 1, sides: 4, modifier: -1 }, traits: [] },
  // Challenge rating 1/8
  { id: "srd-5.1:enemy-template:blood-hawk", name: "Blood Hawk", cr: "cr-1-8", ac: 12, hp: 7, speed: 60, attackId: "srd-5.1:ability:blood-hawk-beak", attackBonus: 4, damage: { damageType: "piercing", count: 1, sides: 4, modifier: 2 }, traits: ["srd-5.1:ability:enemy-pack-tactics"] },
  { id: "srd-5.1:enemy-template:cultist", name: "Cultist", cr: "cr-1-8", ac: 12, hp: 9, speed: 30, attackId: "srd-5.1:ability:cultist-scimitar", attackBonus: 3, damage: { damageType: "slashing", count: 1, sides: 6, modifier: 1 }, traits: [] },
  { id: "srd-5.1:enemy-template:giant-rat", name: "Giant Rat", cr: "cr-1-8", ac: 12, hp: 7, speed: 30, attackId: "srd-5.1:ability:giant-rat-bite", attackBonus: 4, damage: { damageType: "piercing", count: 1, sides: 4, modifier: 2 }, traits: ["srd-5.1:ability:enemy-pack-tactics"] },
  { id: "srd-5.1:enemy-template:giant-weasel", name: "Giant Weasel", cr: "cr-1-8", ac: 13, hp: 9, speed: 40, attackId: "srd-5.1:ability:giant-weasel-bite", attackBonus: 5, damage: { damageType: "piercing", count: 1, sides: 4, modifier: 3 }, traits: [] },
  { id: "srd-5.1:enemy-template:guard", name: "Guard", cr: "cr-1-8", ac: 16, hp: 11, speed: 30, attackId: "srd-5.1:ability:guard-spear", attackBonus: 3, damage: { damageType: "piercing", count: 1, sides: 6, modifier: 1 }, traits: [] },
  { id: "srd-5.1:enemy-template:kobold", name: "Kobold", cr: "cr-1-8", ac: 12, hp: 5, speed: 30, attackId: "srd-5.1:ability:kobold-dagger", attackBonus: 4, damage: { damageType: "piercing", count: 1, sides: 4, modifier: 2 }, traits: ["srd-5.1:ability:enemy-pack-tactics", "srd-5.1:ability:kobold-sunlight-sensitivity"] },
  { id: "srd-5.1:enemy-template:mastiff", name: "Mastiff", cr: "cr-1-8", ac: 12, hp: 5, speed: 40, attackId: "srd-5.1:ability:mastiff-bite", attackBonus: 3, damage: { damageType: "piercing", count: 1, sides: 6, modifier: 1 }, traits: [] },
  { id: "srd-5.1:enemy-template:tribal-warrior", name: "Tribal Warrior", cr: "cr-1-8", ac: 12, hp: 11, speed: 30, attackId: "srd-5.1:ability:tribal-warrior-spear", attackBonus: 3, damage: { damageType: "piercing", count: 1, sides: 6, modifier: 1 }, traits: ["srd-5.1:ability:enemy-pack-tactics"] },
  // Challenge rating 1/4
  { id: "srd-5.1:enemy-template:axe-beak", name: "Axe Beak", cr: "cr-1-4", ac: 11, hp: 19, speed: 50, attackId: "srd-5.1:ability:axe-beak-beak", attackBonus: 4, damage: { damageType: "slashing", count: 1, sides: 8, modifier: 2 }, traits: [] },
  { id: "srd-5.1:enemy-template:boar", name: "Boar", cr: "cr-1-4", ac: 11, hp: 11, speed: 40, attackId: "srd-5.1:ability:boar-tusk", attackBonus: 3, damage: { damageType: "slashing", count: 1, sides: 6, modifier: 1 }, traits: [] },
  { id: "srd-5.1:enemy-template:constrictor-snake", name: "Constrictor Snake", cr: "cr-1-4", ac: 12, hp: 13, speed: 30, attackId: "srd-5.1:ability:constrictor-snake-bite", attackBonus: 4, damage: { damageType: "piercing", count: 1, sides: 6, modifier: 2 }, traits: [] },
  { id: "srd-5.1:enemy-template:giant-bat", name: "Giant Bat", cr: "cr-1-4", ac: 13, hp: 22, speed: 60, attackId: "srd-5.1:ability:giant-bat-bite", attackBonus: 4, damage: { damageType: "piercing", count: 1, sides: 6, modifier: 2 }, traits: [] },
  { id: "srd-5.1:enemy-template:giant-lizard", name: "Giant Lizard", cr: "cr-1-4", ac: 12, hp: 19, speed: 30, attackId: "srd-5.1:ability:giant-lizard-bite", attackBonus: 4, damage: { damageType: "piercing", count: 1, sides: 8, modifier: 2 }, traits: [] },
  { id: "srd-5.1:enemy-template:giant-wolf-spider", name: "Giant Wolf Spider", cr: "cr-1-4", ac: 13, hp: 11, speed: 40, attackId: "srd-5.1:ability:giant-wolf-spider-bite", attackBonus: 3, damage: { damageType: "piercing", count: 1, sides: 6, modifier: 1 }, traits: [] },
  { id: "srd-5.1:enemy-template:panther", name: "Panther", cr: "cr-1-4", ac: 12, hp: 13, speed: 50, attackId: "srd-5.1:ability:panther-bite", attackBonus: 4, damage: { damageType: "piercing", count: 1, sides: 6, modifier: 2 }, traits: [] },
  { id: "srd-5.1:enemy-template:skeleton", name: "Skeleton", cr: "cr-1-4", ac: 13, hp: 13, speed: 30, attackId: "srd-5.1:ability:skeleton-shortsword", attackBonus: 4, damage: { damageType: "piercing", count: 1, sides: 6, modifier: 2 }, traits: [] },
  { id: "srd-5.1:enemy-template:zombie", name: "Zombie", cr: "cr-1-4", ac: 8, hp: 22, speed: 20, attackId: "srd-5.1:ability:zombie-slam", attackBonus: 3, damage: { damageType: "bludgeoning", count: 1, sides: 6, modifier: 1 }, traits: ["srd-5.1:ability:zombie-undead-fortitude"] },
  // Challenge rating 1/2
  { id: "srd-5.1:enemy-template:ape", name: "Ape", cr: "cr-1-2", ac: 12, hp: 19, speed: 30, attackId: "srd-5.1:ability:ape-fist", attackBonus: 5, damage: { damageType: "bludgeoning", count: 1, sides: 6, modifier: 3 }, traits: [] },
  { id: "srd-5.1:enemy-template:black-bear", name: "Black Bear", cr: "cr-1-2", ac: 11, hp: 19, speed: 40, attackId: "srd-5.1:ability:black-bear-bite", attackBonus: 3, damage: { damageType: "piercing", count: 1, sides: 6, modifier: 2 }, traits: [] },
  { id: "srd-5.1:enemy-template:crocodile", name: "Crocodile", cr: "cr-1-2", ac: 12, hp: 19, speed: 20, attackId: "srd-5.1:ability:crocodile-bite", attackBonus: 4, damage: { damageType: "piercing", count: 1, sides: 10, modifier: 2 }, traits: [] },
  { id: "srd-5.1:enemy-template:giant-goat", name: "Giant Goat", cr: "cr-1-2", ac: 11, hp: 19, speed: 40, attackId: "srd-5.1:ability:giant-goat-ram", attackBonus: 5, damage: { damageType: "bludgeoning", count: 2, sides: 4, modifier: 3 }, traits: [] },
  { id: "srd-5.1:enemy-template:hobgoblin", name: "Hobgoblin", cr: "cr-1-2", ac: 18, hp: 11, speed: 30, attackId: "srd-5.1:ability:hobgoblin-longsword", attackBonus: 3, damage: { damageType: "slashing", count: 1, sides: 8, modifier: 1 }, traits: ["srd-5.1:ability:hobgoblin-martial-advantage"] },
  { id: "srd-5.1:enemy-template:orc", name: "Orc", cr: "cr-1-2", ac: 13, hp: 15, speed: 30, attackId: "srd-5.1:ability:orc-greataxe", attackBonus: 5, damage: { damageType: "slashing", count: 1, sides: 12, modifier: 3 }, traits: ["srd-5.1:ability:orc-aggressive"] },
  { id: "srd-5.1:enemy-template:scout", name: "Scout", cr: "cr-1-2", ac: 13, hp: 16, speed: 30, attackId: "srd-5.1:ability:scout-shortsword", attackBonus: 4, damage: { damageType: "piercing", count: 1, sides: 6, modifier: 2 }, traits: [] },
  { id: "srd-5.1:enemy-template:warhorse", name: "Warhorse", cr: "cr-1-2", ac: 11, hp: 19, speed: 60, attackId: "srd-5.1:ability:warhorse-hooves", attackBonus: 6, damage: { damageType: "bludgeoning", count: 2, sides: 6, modifier: 4 }, traits: [] },
  { id: "srd-5.1:enemy-template:worg", name: "Worg", cr: "cr-1-2", ac: 13, hp: 26, speed: 50, attackId: "srd-5.1:ability:worg-bite", attackBonus: 5, damage: { damageType: "piercing", count: 2, sides: 6, modifier: 3 }, traits: [] },
];

type Reference = { packId: string; packVersion: string; kind: string; definitionId: string };
const referenceKey = (reference: Reference) => `${reference.packId}\0${reference.packVersion}\0${reference.kind}\0${reference.definitionId}`;
const abilityByReference = new Map(abilities.map((ability) => [referenceKey(ability.reference), ability] as const));

describe("SRD 5.1 monsters, challenge rating 0 to 1/2", () => {
  it("defines the expected low-CR enemy templates with SRD challenge/AC/HP mechanics", () => {
    for (const expected of LOW_CR_MONSTERS) {
      const enemy = enemies.find((candidate) => candidate.reference.definitionId === expected.id);
      expect(enemy, expected.id).toBeDefined();
      const parsed = enemyTemplateCatalogDefinitionSchema.parse(enemy);
      expect(parsed.name).toBe(expected.name);
      expect(parsed.tags).toContain("srd-5.1");
      expect(parsed.tags, `${expected.name} challenge rating tag`).toContain(expected.cr);
      expect(parsed.mechanics.tier).toBe(1);
      expect(parsed.mechanics.defense, `${expected.name} AC`).toBe(expected.ac);
      expect(parsed.mechanics.maxHp, `${expected.name} HP`).toBe(expected.hp);
      expect(parsed.mechanics.speed, `${expected.name} speed`).toBe(expected.speed);
      expect(parsed.mechanics.combatProfile?.attack.attackBonus, `${expected.name} attack bonus`).toBe(expected.attackBonus);
    }
  });

  it("parses every enemy-template and ability definition built for the starter pack", () => {
    for (const enemy of enemies) {
      expect(() => enemyTemplateCatalogDefinitionSchema.parse(enemy), enemy.reference.definitionId).not.toThrow();
    }
    for (const ability of abilities) {
      expect(() => abilityCatalogDefinitionSchema.parse(ability), ability.reference.definitionId).not.toThrow();
    }
  });

  it("resolves every enemy ability reference to a definition in the same pack", () => {
    for (const enemy of enemies) {
      const parsed = enemyTemplateCatalogDefinitionSchema.parse(enemy);
      const profileAttack = parsed.mechanics.combatProfile?.attack.abilityRef;
      const abilityRefs = profileAttack ? [...parsed.mechanics.abilityRefs, profileAttack] : [...parsed.mechanics.abilityRefs];
      expect(abilityRefs.length).toBeGreaterThan(0);
      for (const abilityRef of abilityRefs) {
        expect(abilityRef.packId).toBe(enemy.reference.packId);
        expect(abilityRef.packVersion).toBe(enemy.reference.packVersion);
        expect(abilityRef.kind).toBe("ability");
        expect(abilityByReference.has(referenceKey(abilityRef)), `${enemy.name} -> ${abilityRef.definitionId}`).toBe(true);
      }
    }
  });

  it("gives every low-CR attack ability bounded executable mechanics", () => {
    for (const expected of LOW_CR_MONSTERS) {
      const ability = abilities.find((candidate) => candidate.reference.definitionId === expected.attackId);
      expect(ability, expected.attackId).toBeDefined();
      const parsedAbility = abilityCatalogDefinitionSchema.parse(ability);
      expect(parsedAbility.mechanics.actionCost).toBe("action");
      expect(parsedAbility.mechanics.target).toBe("enemy");
      expect(parsedAbility.mechanics.effects[0]).toMatchObject({
        type: "damage",
        damageType: expected.damage.damageType,
        dice: { count: expected.damage.count, sides: expected.damage.sides, modifier: expected.damage.modifier },
      });

      const enemy = enemies.find((candidate) => candidate.reference.definitionId === expected.id)!;
      const parsedEnemy = enemyTemplateCatalogDefinitionSchema.parse(enemy);
      const steps = monsterAttackStepsFromContent(parsedEnemy, [parsedAbility]);
      expect(steps, `${expected.name} executable steps`).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        abilityId: expected.attackId,
        attackBonus: expected.attackBonus,
        damageDie: { count: expected.damage.count, sides: expected.damage.sides },
        damageModifier: expected.damage.modifier,
        damageType: expected.damage.damageType,
      });
    }
  });

  it("resolves the referenced low-CR traits to bounded enemy-trait markers", () => {
    for (const expected of LOW_CR_MONSTERS) {
      for (const traitId of expected.traits) {
        const trait = abilities.find((candidate) => candidate.reference.definitionId === traitId);
        expect(trait, traitId).toBeDefined();
        const parsed = abilityCatalogDefinitionSchema.parse(trait);
        expect(parsed.tags).toContain("srd-5.1");
        expect(parsed.tags).toContain("enemy-trait");
        expect(parsed.mechanics.effects).toEqual([]);
        expect(parsed.mechanics.target).toBe("self");
      }
    }
  });

  it("keeps the original starter enemies unchanged", () => {
    const existing = [
      ["velvet:test-fixture:enemy-template:training-dummy", "Training Dummy", 8, 10],
      ["srd-5.1:enemy-template:goblin", "Goblin", 7, 15],
      ["srd-5.1:enemy-template:bandit", "Bandit", 11, 12],
      ["srd-5.1:enemy-template:wolf", "Wolf", 11, 13],
    ] as const;
    for (const [definitionId, name, maxHp, defense] of existing) {
      const enemy = enemies.find((candidate) => candidate.reference.definitionId === definitionId);
      expect(enemy, definitionId).toBeDefined();
      const parsed = enemyTemplateCatalogDefinitionSchema.parse(enemy);
      expect(parsed.name).toBe(name);
      expect(parsed.mechanics.maxHp).toBe(maxHp);
      expect(parsed.mechanics.defense).toBe(defense);
    }
  });
});
