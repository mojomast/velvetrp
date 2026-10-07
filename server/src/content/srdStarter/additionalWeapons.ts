import type { StarterReferences } from "./references.js";

// Source: https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf
// Pages 63–64 describe/list half plate; pages 64–66 describe/list weapons.
// Blowgun's flat damage and net's no-damage profile cannot use the weapon damage-die schema.
export function buildAdditionalWeapons(refs: StarterReferences) {
  const { ref, currency } = refs;
  const weapon = (id: string, name: string, description: string, price: number, weightPounds: number, proficiency: "simple" | "martial", attackType: "melee" | "ranged", damageType: "bludgeoning" | "piercing" | "slashing", sides: 4 | 6 | 8 | 10 | 12, properties: unknown[], count: 1 | 2 = 1) => ({
    reference: ref("item", `srd-5.1:item:${id}`), name, description, tags: ["srd-5.1", "equipment"],
    mechanics: { category: "weapon", stackable: false, slot: "hand", price: { currency, amount: price }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds, equipmentProfile: { kind: "weapon", proficiency, attackType, damage: { type: damageType, die: { count, sides } }, properties } } },
  });
  return [
    weapon("greatclub", "Greatclub", "A simple two-handed bludgeoning weapon; SRD cost 2 sp, represented as 0 gp under integer-gold pricing.", 0, 10, "simple", "melee", "bludgeoning", 8, [{ property: "two-handed" }]),
    weapon("javelin", "Javelin", "A simple thrown piercing weapon; SRD cost 5 sp, represented as 0 gp under integer-gold pricing.", 0, 2, "simple", "melee", "piercing", 6, [{ property: "thrown", range: { normalFeet: 30, longFeet: 120 } }]),
    weapon("light-hammer", "Light Hammer", "A simple light and thrown bludgeoning weapon.", 2, 2, "simple", "melee", "bludgeoning", 4, [{ property: "light" }, { property: "thrown", range: { normalFeet: 20, longFeet: 60 } }]),
    weapon("sickle", "Sickle", "A simple light slashing weapon.", 1, 2, "simple", "melee", "slashing", 4, [{ property: "light" }]),
    weapon("dart", "Dart", "A simple finesse and thrown ranged piercing weapon; SRD cost 5 cp, represented as 0 gp under integer-gold pricing.", 0, 0.25, "simple", "ranged", "piercing", 4, [{ property: "finesse" }, { property: "thrown", range: { normalFeet: 20, longFeet: 60 } }]),
    weapon("sling", "Sling", "A simple ranged bludgeoning weapon; SRD cost 1 sp, represented as 0 gp under integer-gold pricing. The SRD lists no weight, represented as 0 lb.", 0, 0, "simple", "ranged", "bludgeoning", 4, [{ property: "ammunition", range: { normalFeet: 30, longFeet: 120 } }]),
    weapon("flail", "Flail", "A martial bludgeoning weapon.", 10, 2, "martial", "melee", "bludgeoning", 8, []),
    weapon("glaive", "Glaive", "A martial heavy two-handed slashing weapon with reach.", 20, 6, "martial", "melee", "slashing", 10, [{ property: "heavy" }, { property: "reach", reachFeet: 10 }, { property: "two-handed" }]),
    weapon("greataxe", "Greataxe", "A martial heavy two-handed slashing weapon.", 30, 7, "martial", "melee", "slashing", 12, [{ property: "heavy" }, { property: "two-handed" }]),
    weapon("halberd", "Halberd", "A martial heavy two-handed slashing weapon with reach.", 20, 6, "martial", "melee", "slashing", 10, [{ property: "heavy" }, { property: "reach", reachFeet: 10 }, { property: "two-handed" }]),
    weapon("lance", "Lance", "A martial piercing weapon with reach. Attacks against targets within 5 feet have disadvantage, and wielding it requires two hands unless mounted; these special rules are descriptive only.", 10, 6, "martial", "melee", "piercing", 12, [{ property: "reach", reachFeet: 10 }, { property: "special" }]),
    weapon("maul", "Maul", "A martial heavy two-handed weapon dealing 2d6 bludgeoning damage.", 10, 10, "martial", "melee", "bludgeoning", 6, [{ property: "heavy" }, { property: "two-handed" }], 2),
    weapon("morningstar", "Morningstar", "A martial piercing weapon.", 15, 4, "martial", "melee", "piercing", 8, []),
    weapon("pike", "Pike", "A martial heavy two-handed piercing weapon with reach.", 5, 18, "martial", "melee", "piercing", 10, [{ property: "heavy" }, { property: "reach", reachFeet: 10 }, { property: "two-handed" }]),
    weapon("scimitar", "Scimitar", "A martial finesse and light slashing weapon.", 25, 3, "martial", "melee", "slashing", 6, [{ property: "finesse" }, { property: "light" }]),
    weapon("shortsword", "Shortsword", "A martial finesse and light piercing weapon.", 10, 2, "martial", "melee", "piercing", 6, [{ property: "finesse" }, { property: "light" }]),
    weapon("trident", "Trident", "A martial versatile and thrown piercing weapon.", 5, 4, "martial", "melee", "piercing", 6, [{ property: "thrown", range: { normalFeet: 20, longFeet: 60 } }, { property: "versatile", damageDie: { count: 1, sides: 8 } }]),
    weapon("war-pick", "War Pick", "A martial piercing weapon.", 5, 2, "martial", "melee", "piercing", 8, []),
    weapon("warhammer", "Warhammer", "A martial versatile bludgeoning weapon.", 15, 2, "martial", "melee", "bludgeoning", 8, [{ property: "versatile", damageDie: { count: 1, sides: 10 } }]),
    weapon("whip", "Whip", "A martial finesse slashing weapon with reach.", 2, 3, "martial", "melee", "slashing", 4, [{ property: "finesse" }, { property: "reach", reachFeet: 10 }]),
    weapon("hand-crossbow", "Hand Crossbow", "A martial light and loading ranged piercing weapon.", 75, 3, "martial", "ranged", "piercing", 6, [{ property: "ammunition", range: { normalFeet: 30, longFeet: 120 } }, { property: "light" }, { property: "loading" }]),
    weapon("heavy-crossbow", "Heavy Crossbow", "A martial heavy two-handed and loading ranged piercing weapon.", 50, 18, "martial", "ranged", "piercing", 10, [{ property: "ammunition", range: { normalFeet: 100, longFeet: 400 } }, { property: "heavy" }, { property: "loading" }, { property: "two-handed" }]),
    weapon("longbow", "Longbow", "A martial heavy two-handed ranged piercing weapon.", 50, 2, "martial", "ranged", "piercing", 8, [{ property: "ammunition", range: { normalFeet: 150, longFeet: 600 } }, { property: "heavy" }, { property: "two-handed" }]),
    { reference: ref("item", "srd-5.1:item:half-plate"), name: "Half Plate", description: "Medium armor with base AC 15, Dexterity contribution capped at +2, and stealth disadvantage.", tags: ["srd-5.1", "equipment"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 750 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 40, equipmentProfile: { kind: "armor", category: "medium", baseArmorClass: 15, dexterity: { policy: "capped", maxBonus: 2 }, strengthRequirement: null, stealthDisadvantage: true, shieldBonus: 0 } } } },
  ];
}
