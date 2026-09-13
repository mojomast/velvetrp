import { describe, expect, it } from "vitest";
import { itemCatalogDefinitionSchema, publishContentCatalogInputSchema, SRD_5_1_STARTER_IDENTITY } from "@velvet/contracts";
import { SRD_5_1_STARTER_CATALOG } from "../src/content/srdStarterCatalog.js";
import { MECHANICS_STARTER_CATALOG } from "../src/content/mechanicsStarterCatalog.js";
import { calculateCatalogDigest, validateContentCatalog } from "../src/repo/contentCatalog/catalogValidation.js";

describe("SRD equipment catalog", () => {
  it("imports a valid exact immutable publication and preserves Velvet", () => {
    const catalog = SRD_5_1_STARTER_CATALOG;
    expect(catalog.manifest.packVersion).toBe(SRD_5_1_STARTER_IDENTITY.packVersion);
    expect(catalog.manifest.packVersion).toBe(`${catalog.manifest.packVersion.split("+")[0]}+${calculateCatalogDigest(catalog).slice(0, 12)}`);
    expect(catalog.manifest.digest).toBe(calculateCatalogDigest(catalog));
    expect(validateContentCatalog(catalog)).toMatchObject({ valid: true, issues: [] });
    expect(validateContentCatalog(MECHANICS_STARTER_CATALOG)).toMatchObject({ valid: true, issues: [] });
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it("retains the exact longsword profile and original provenance", () => {
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const sword = itemCatalogDefinitionSchema.parse(definitions.find((entry) => entry.name === "Longsword"));
    expect(sword.mechanics.engineDetails).toEqual({ rulesEngine: "dnd-5e", weightPounds: 3,
      equipmentProfile: { kind: "weapon", proficiency: "martial", attackType: "melee",
        damage: { type: "slashing", die: { count: 1, sides: 8 } },
        properties: [{ property: "versatile", damageDie: { count: 1, sides: 10 } }] } });
    expect(definitions.find((entry) => entry.name === "Acolyte")).toMatchObject({
      mechanics: { itemRefs: [{ definitionId: "srd-5.1:item:acolyte-equipment" }], startingCurrency: { amount: 15 } },
    });
    expect(definitions.find((entry) => entry.name === "Acolyte Equipment")).toMatchObject({
      tags: ["srd-5.1", "bounded-aggregate", "grant-only"],
    });
    expect(definitions.find((entry) => entry.name === "Training Dummy")).toMatchObject({
      reference: { definitionId: "velvet:test-fixture:enemy-template:training-dummy" },
      tags: ["velvet:test-fixture", "original", "non-srd"],
    });
  });

  it.each([
    ["Goblin", "srd-5.1:enemy-template:goblin", 15, 7, 30, 2, 4, "slashing", 1, 6, 2],
    ["Bandit", "srd-5.1:enemy-template:bandit", 12, 11, 30, 2, 3, "slashing", 1, 6, 1],
    ["Wolf", "srd-5.1:enemy-template:wolf", 13, 11, 40, 2, 4, "piercing", 2, 4, 2],
  ] as const)("contains the bounded executable SRD %s profile", (name, definitionId, defense, maxHp, speed, proficiencyBonus, attackBonus, damageType, count, sides, modifier) => {
    const enemy = SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.name === name)!;
    expect(enemy).toMatchObject({ reference: { definitionId }, mechanics: { defense, maxHp, speed,
      combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus, attack: { attackBonus } } } });
    const ability = (enemy as any).mechanics.combatProfile.attack.abilityRef;
    expect(SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.definitionId === ability.definitionId))
      .toMatchObject({ mechanics: { effects: [{ type: "damage", damageType, dice: { count, sides, modifier } }] } });
  });

  it.each([
    ["Leather Armor", 10, 10, "light", 11, { policy: "full" }, null, false, 0],
    ["Chain Shirt", 50, 20, "medium", 13, { policy: "capped", maxBonus: 2 }, null, false, 0],
    ["Chain Mail", 75, 55, "heavy", 16, { policy: "none" }, 13, true, 0],
    ["Shield", 10, 6, "shield", null, { policy: "none" }, null, false, 2],
  ] as const)("contains legal adapted SRD armor: %s", (name, price, weight, category, ac, dexterity, strength, stealth, bonus) => {
    const item = itemCatalogDefinitionSchema.parse(SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.kind === "item" && entry.name === name));
    expect(item.mechanics).toMatchObject({ category: "armor", price: { amount: price },
      slot: category === "shield" ? "hand" : "body", engineDetails: { rulesEngine: "dnd-5e", weightPounds: weight,
        equipmentProfile: { kind: "armor", category, baseArmorClass: ac, dexterity,
          strengthRequirement: strength, stealthDisadvantage: stealth, shieldBonus: bonus } } });
  });

   it("pins the expanded SRD tranche without enabling unsupported execution", () => {
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    expect(definitions.filter((entry) => entry.reference.kind === "race").map((entry) => entry.name))
      .toEqual(expect.arrayContaining(["Human", "Dwarf", "Elf", "Halfling", "Dragonborn", "Gnome", "Half-Orc"]));
    expect(definitions.filter((entry) => entry.reference.kind === "item").length).toBeGreaterThanOrEqual(25);
    expect(definitions.filter((entry) => entry.reference.kind === "class-level").map((entry) => entry.name))
      .toEqual(expect.arrayContaining(["Cleric Level 2", "Cleric Level 3", "Wizard Level 2", "Wizard Level 3"]));
     for (const name of ["Guiding Bolt", "Mage Hand", "Sacred Flame"]) {
       const spell = definitions.find((entry) => entry.reference.kind === "spell" && entry.name === name);
       expect(spell).toMatchObject({ tags: expect.arrayContaining(["metadata-only"]), mechanics: { school: expect.any(String), castingTime: expect.any(String), duration: expect.any(String), attackType: expect.any(String), saveType: expect.any(String), ritual: expect.any(Boolean), components: expect.any(Object) } });
     }
     expect(definitions.find((entry) => entry.name === "Shield")).toMatchObject({
       tags: expect.arrayContaining(["spellcasting"]),
       mechanics: { actionCost: "reaction", target: "self", effects: [{ type: "modifier", statistic: "defense", amount: 5, duration: "round" }] },
     });
     expect(definitions.find((entry) => entry.name === "Magic Missile")).toMatchObject({ tags: expect.arrayContaining(["spellcasting"]) });
     expect(definitions.find((entry) => entry.name === "Healing Word")).toMatchObject({ tags: expect.arrayContaining(["spellcasting"]) });
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(Object.isFrozen(definitions[0])).toBe(true);
  });

  it("pins ranged spell metadata without widening the execution schema", () => {
    const spell = (name: string) => SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.kind === "spell" && entry.name === name)!;
    expect(spell("Magic Missile")).toMatchObject({
      reference: { packId: SRD_5_1_STARTER_IDENTITY.packId, packVersion: SRD_5_1_STARTER_IDENTITY.packVersion, definitionId: "srd-5.1:spell:magic-missile" },
      mechanics: { level: 1, school: "evocation", castingTime: "action", range: 120, target: "enemy", duration: "instantaneous", attackType: "none", saveType: "none", concentration: false, ritual: false, components: { verbal: true, somatic: true, material: true, materialDescription: "a tiny ball of bat guano and sulfur" }, effects: [{ type: "damage", damageType: "force", dice: { count: 3, sides: 4, modifier: 3 } }] },
    });
    expect(spell("Guiding Bolt")).toMatchObject({ mechanics: { school: "evocation", castingTime: "action", range: 120, attackType: "ranged", saveType: "none", effects: [{ type: "damage", damageType: "radiant", dice: { count: 4, sides: 6, modifier: 0 } }] } });
  });

  it.each([
    ["Human", "Medium", 30, ["Common", "one language of choice"], [], [], []],
    ["Dwarf", "Medium", 25, ["Common", "Dwarvish"], ["battleaxe", "handaxe", "light hammer", "warhammer"], ["poison"], [{ kind: "darkvision", rangeFeet: 60 }]],
    ["Elf", "Medium", 30, ["Common", "Elvish"], ["Perception"], [], [{ kind: "darkvision", rangeFeet: 60 }]],
    ["Halfling", "Small", 25, ["Common", "Halfling"], [], [], []],
    ["Dragonborn", "Medium", 30, ["Common", "Draconic"], [], [], []],
    ["Gnome", "Small", 25, ["Common", "Gnomish"], [], [], [{ kind: "darkvision", rangeFeet: 60 }]],
    ["Half-Orc", "Medium", 30, ["Common", "Orc"], ["Intimidation"], [], [{ kind: "darkvision", rangeFeet: 60 }]],
  ] as const)("pins exact %s race metadata", (name, size, speed, languages, proficiencies, damageResistances, senses) => {
    const race = SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.kind === "race" && entry.name === name)!;
    expect(race).toMatchObject({ reference: { packId: SRD_5_1_STARTER_IDENTITY.packId, packVersion: SRD_5_1_STARTER_IDENTITY.packVersion }, mechanics: { size, speed, languages, proficiencies, damageResistances, senses } });
  });

  it.each(["dnd-5e", "velvet-starter-v1"] as const)("checks publication engine %s against equipment details", (engine) => {
    const catalog = structuredClone(SRD_5_1_STARTER_CATALOG);
    catalog.manifest.compatibility.rulesEngine = engine;
    expect(publishContentCatalogInputSchema.safeParse(catalog).success).toBe(engine === "dnd-5e");
    const report = validateContentCatalog(catalog);
    if (engine === "velvet-starter-v1") {
      expect(report.valid).toBe(false);
      expect(report.issues).toContainEqual(expect.objectContaining({
        message: "item engine details must match the publication rules engine",
      }));
    }
  });

  it.each([null, undefined])("accepts legacy Velvet items with engine details %s", (details) => {
    const catalog = structuredClone(MECHANICS_STARTER_CATALOG);
    const item = itemCatalogDefinitionSchema.parse(catalog.definitions.find((entry) => entry.reference.kind === "item"));
    item.mechanics.engineDetails = details;
    const definitions = catalog.definitions.map((entry) => entry.reference.definitionId === item.reference.definitionId ? item : entry);
    expect(publishContentCatalogInputSchema.safeParse({ ...catalog, definitions }).success).toBe(true);
  });
});
