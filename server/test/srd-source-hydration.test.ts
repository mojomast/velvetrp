import { describe, expect, it } from "vitest";
import { itemCatalogDefinitionSchema, raceCatalogDefinitionSchema, spellCatalogDefinitionSchema } from "@velvet/contracts";
import { SRD_5_1_STARTER_CATALOG } from "../src/content/srdStarterCatalog.js";

// Independent source inventory: official SRD 5.1 PDF pp. 4–6, 63–70, 146 and 191.
const addedItems = [
  "greatclub", "javelin", "light-hammer", "sickle", "dart", "sling", "flail", "glaive",
  "greataxe", "halberd", "lance", "maul", "morningstar", "pike", "scimitar", "shortsword",
  "trident", "war-pick", "warhammer", "whip", "hand-crossbow", "heavy-crossbow", "longbow", "half-plate",
  "burglars-pack", "diplomats-pack", "dungeoneers-pack", "entertainers-pack", "priests-pack", "scholars-pack",
  "arcane-focus-crystal", "arcane-focus-orb", "arcane-focus-rod", "arcane-focus-staff", "arcane-focus-wand",
  "druidic-focus-sprig-of-mistletoe", "druidic-focus-totem", "druidic-focus-wooden-staff", "druidic-focus-yew-wand",
  "holy-symbol-amulet", "holy-symbol-emblem", "holy-symbol-reliquary",
];
const definition = (kind: string, id: string) => {
  const entries = SRD_5_1_STARTER_CATALOG.definitions.filter(entry => entry.reference.definitionId === `srd-5.1:${kind}:${id}`);
  expect(entries, `${kind}:${id}`).toHaveLength(1);
  return entries[0];
};

describe("reviewed SRD 5.1 source hydration", () => {
  it("publishes every reviewed equipment addition exactly once", () => {
    expect(addedItems).toHaveLength(42);
    for (const id of addedItems) {
      const item = itemCatalogDefinitionSchema.parse(definition("item", id));
      expect(item.reference.packVersion).toBe(SRD_5_1_STARTER_CATALOG.manifest.packVersion);
    }
    const maul = itemCatalogDefinitionSchema.parse(definition("item", "maul"));
    expect(maul.mechanics.engineDetails?.equipmentProfile).toMatchObject({
      damage: { type: "bludgeoning", die: { count: 2, sides: 6 } },
    });
    expect(itemCatalogDefinitionSchema.parse(definition("item", "half-plate")).mechanics).toMatchObject({
      price: { amount: 750 }, engineDetails: { weightPounds: 40, equipmentProfile: {
        baseArmorClass: 15, dexterity: { policy: "capped", maxBonus: 2 }, strengthRequirement: null, stealthDisadvantage: true,
      } },
    });
  });

  it.each([
    ["hill-dwarf", "dwarf", { constitution: 2, wisdom: 1 }],
    ["high-elf", "elf", { dexterity: 2, intelligence: 1 }],
    ["lightfoot-halfling", "halfling", { dexterity: 2, charisma: 1 }],
    ["rock-gnome", "gnome", { intelligence: 2, constitution: 1 }],
  ] as const)("retains inherited %s traits without invented resources", (id, baseId, bonuses) => {
    const race = raceCatalogDefinitionSchema.parse(definition("race", id));
    const base = raceCatalogDefinitionSchema.parse(definition("race", baseId));
    expect(race.mechanics.attributeBonuses).toEqual(bonuses);
    for (const field of ["size", "speed", "abilityRefs", "damageResistances", "senses"] as const) {
      expect(race.mechanics[field]).toEqual(base.mechanics[field]);
    }
    expect(race.mechanics.languages).toEqual(base.mechanics.languages);
    expect(race.mechanics).not.toHaveProperty("resourceGrants");
  });

  it("keeps new high-level spells inert and their source durations truthful", () => {
    const ward = spellCatalogDefinitionSchema.parse(definition("spell", "forbiddance"));
    const wall = spellCatalogDefinitionSchema.parse(definition("spell", "wall-of-thorns"));
    expect(ward.mechanics).toMatchObject({ level: 6, castingTime: "10-minutes", concentration: false, ritual: true, effects: [] });
    expect(ward.mechanics.duration).toBeUndefined();
    expect(ward.description).toContain("1 day");
    expect(wall.mechanics).toMatchObject({ level: 6, range: 120, saveType: "dexterity", concentration: true, effects: [] });
  });
});
