import type { MagicItemProperties } from "@velvet/contracts";
import type { StarterReferences } from "../references.js";

/**
 * SRD 5.1 magic armor, shields, and weapons.
 *
 * Only mechanics the pinned `magicItemPropertiesSchema` can express are
 * encoded. Situational, variable, or curse effects are intentionally left
 * empty rather than invented; every entry still carries `mechanics.magic` so
 * `magicItemDefinitionFromCatalog()` treats it as a magic item.
 *
 * SRD 5.1 prices magic items by rarity and does not assign a gold value, so
 * `price.amount` is 0 for every entry.
 */
export function magicArmorWeapons(refs: StarterReferences) {
  const { ref, currency } = refs;
  type PassiveModifier = MagicItemProperties["passiveModifiers"][number];

  const flatAc = (amount: number, requireAttunement: boolean): PassiveModifier => ({ modifier: { kind: "flat", amount, target: { kind: "armor-class" } }, requireAttunement });
  const flatAttack = (amount: number, requireAttunement: boolean): PassiveModifier => ({ modifier: { kind: "flat", amount, target: { kind: "attack-roll" } }, requireAttunement });
  const flatDamage = (amount: number, requireAttunement: boolean): PassiveModifier => ({ modifier: { kind: "flat", amount, target: { kind: "damage-roll" } }, requireAttunement });

  const magic = (
    attunement: MagicItemProperties["attunement"],
    passiveModifiers: MagicItemProperties["passiveModifiers"],
    charges: MagicItemProperties["charges"] = null,
    grantedPowers: MagicItemProperties["grantedPowers"] = [],
  ): MagicItemProperties => ({ attunement, charges, passiveModifiers, grantedPowers });

  const spellPower = (slug: string) => ({ ...ref("spell", `srd-5.1:spell:${slug}`), kind: "spell" as const });

  const armor = (slug: string, name: string, description: string, slot: "body" | "hand", magicProperties: MagicItemProperties) => ({
    reference: ref("item", `srd-5.1:item:${slug}`), name, description, tags: ["srd-5.1", "magic-item", "armor"],
    mechanics: { category: "armor", stackable: false, slot, price: { currency, amount: 0 }, effects: [], magic: magicProperties },
  });
  const weapon = (slug: string, name: string, description: string, magicProperties: MagicItemProperties) => ({
    reference: ref("item", `srd-5.1:item:${slug}`), name, description, tags: ["srd-5.1", "magic-item", "weapon"],
    mechanics: { category: "weapon", stackable: false, slot: "hand", price: { currency, amount: 0 }, effects: [], magic: magicProperties },
  });

  return [
    armor("adamantine-armor", "Adamantine Armor", "Medium or heavy armor reinforced with adamantine; any critical hit against the wearer becomes a normal hit.", "body", magic(null, [])),
    armor("animated-shield", "Animated Shield", "Shield that can be commanded as a bonus action to animate and hover, protecting the wielder with both hands free.", "hand", magic({ prerequisite: "short-rest" }, [])),
    armor("armor-plus-1", "Armor, +1", "Magic armor (light, medium, or heavy) that grants a +1 bonus to AC while worn.", "body", magic(null, [flatAc(1, false)])),
    armor("armor-plus-2", "Armor, +2", "Magic armor (light, medium, or heavy) that grants a +2 bonus to AC while worn.", "body", magic(null, [flatAc(2, false)])),
    armor("armor-plus-3", "Armor, +3", "Magic armor (light, medium, or heavy) that grants a +3 bonus to AC while worn.", "body", magic(null, [flatAc(3, false)])),
    armor("armor-of-invulnerability", "Armor of Invulnerability", "Plate that grants resistance to nonmagical damage and, once per dawn, immunity to nonmagical damage for 10 minutes.", "body", magic({ prerequisite: "short-rest" }, [])),
    armor("armor-of-resistance", "Armor of Resistance", "Magic armor that grants resistance to one damage type chosen by the GM while worn.", "body", magic({ prerequisite: "short-rest" }, [])),
    armor("armor-of-vulnerability", "Armor of Vulnerability", "Cursed plate that grants resistance to one of bludgeoning, piercing, or slashing damage and vulnerability to the other two.", "body", magic({ prerequisite: "short-rest" }, [])),
    armor("arrow-catching-shield", "Arrow-Catching Shield", "Shield that grants a +2 bonus to AC against ranged attacks and can use a reaction to become the target of a nearby ranged attack.", "hand", magic({ prerequisite: "short-rest" }, [])),
    armor("demon-armor", "Demon Armor", "Cursed plate that grants a +1 bonus to AC, lets the wearer understand and speak Abyssal, and turns unarmed strikes into magic slashing weapons.", "body", magic({ prerequisite: "short-rest" }, [flatAc(1, true)])),
    armor("dragon-scale-mail", "Dragon Scale Mail", "Scale mail made from dragon scales that grants a +1 bonus to AC, resistance to a dragon-type damage, and advantage on saves against dragon breath and Frightful Presence.", "body", magic({ prerequisite: "short-rest" }, [flatAc(1, true)])),
    armor("dwarven-plate", "Dwarven Plate", "Plate that grants a +2 bonus to AC and can use a reaction to reduce forced movement along the ground by up to 10 feet.", "body", magic(null, [flatAc(2, false)])),
    armor("elven-chain", "Elven Chain", "Chain shirt that grants a +1 bonus to AC and can be worn without proficiency with medium armor.", "body", magic(null, [flatAc(1, false)])),
    armor("glamoured-studded-leather", "Glamoured Studded Leather", "Studded leather that grants a +1 bonus to AC and can assume the appearance of clothing or another armor as a bonus action.", "body", magic(null, [flatAc(1, false)])),
    armor("mithral-armor", "Mithral Armor", "Light, flexible medium or heavy armor that removes any Stealth disadvantage and Strength requirement.", "body", magic(null, [])),
    armor("plate-armor-of-etherealness", "Plate Armor of Etherealness", "Plate that can be commanded as an action to gain the effect of the etherealness spell for 10 minutes, once per dawn.", "body", magic({ prerequisite: "short-rest" }, [], { maximum: 1, recharge: { kind: "event", event: "dawn", amount: 1 } }, [{ key: "plate-armor-etherealness", power: spellPower("etherealness"), requireAttunement: true, actionCost: "action", cost: 1 }])),
    armor("shield-of-missile-attraction", "Shield of Missile Attraction", "Cursed shield that grants resistance to ranged weapon damage but draws nearby ranged attacks to its bearer.", "hand", magic({ prerequisite: "short-rest" }, [])),
    armor("spellguard-shield", "Spellguard Shield", "Shield that grants advantage on saving throws against spells and other magical effects and imposes disadvantage on spell attacks against the bearer.", "hand", magic({ prerequisite: "short-rest" }, [])),
    weapon("berserker-axe", "Berserker Axe", "Cursed axe that grants a +1 bonus to attack and damage rolls, raises the attuned wielder's HP maximum by 1 per level, and can force a berserk rage.", magic({ prerequisite: "short-rest" }, [flatAttack(1, true), flatDamage(1, true)])),
    weapon("dagger-of-venom", "Dagger of Venom", "Dagger that grants a +1 bonus to attack and damage rolls and can coat its blade in poison once per dawn.", magic(null, [flatAttack(1, false), flatDamage(1, false)])),
    weapon("dancing-sword", "Dancing Sword", "Sword that can be tossed into the air to hover and attack on its wielder's command.", magic({ prerequisite: "short-rest" }, [])),
    weapon("defender", "Defender", "Legendary sword that grants a +3 bonus to attack and damage rolls, any part of which can be shifted to AC until the start of the next turn.", magic({ prerequisite: "short-rest" }, [flatAttack(3, true), flatDamage(3, true)])),
    weapon("dragon-slayer", "Dragon Slayer", "Sword that grants a +1 bonus to attack and damage rolls and deals an extra 3d6 damage to dragons.", magic(null, [flatAttack(1, false), flatDamage(1, false)])),
    weapon("dwarven-thrower", "Dwarven Thrower", "Warhammer that grants a +3 bonus to attack and damage rolls, gains the thrown property, and returns to its wielder's hand after a ranged attack.", magic({ prerequisite: "short-rest" }, [flatAttack(3, true), flatDamage(3, true)])),
    weapon("flame-tongue", "Flame Tongue", "Sword that can erupt in flames as a bonus action, dealing an extra 2d6 fire damage on a hit and shedding bright light.", magic({ prerequisite: "short-rest" }, [])),
    weapon("frost-brand", "Frost Brand", "Sword that deals an extra 1d6 cold damage on a hit and grants resistance to fire damage while held.", magic({ prerequisite: "short-rest" }, [{ modifier: { kind: "resistance", damageType: "fire" }, requireAttunement: true }])),
    weapon("giant-slayer", "Giant Slayer", "Axe or sword that grants a +1 bonus to attack and damage rolls and deals an extra 2d6 damage to giants.", magic(null, [flatAttack(1, false), flatDamage(1, false)])),
    weapon("hammer-of-thunderbolts", "Hammer of Thunderbolts", "Legendary maul that grants a +1 bonus to attack and damage rolls and can spend charges to hurl a thunderclap.", magic({ prerequisite: "short-rest" }, [flatAttack(1, true), flatDamage(1, true)])),
    weapon("holy-avenger", "Holy Avenger", "Paladin's sword that grants a +3 bonus to attack and damage rolls, extra radiant damage to fiends and undead, and an aura of spell resistance.", magic({ prerequisite: "short-rest" }, [flatAttack(3, true), flatDamage(3, true)])),
    weapon("javelin-of-lightning", "Javelin of Lightning", "Javelin that can transform into a bolt of lightning once per dawn, then be used again as a magic weapon.", magic(null, [])),
    weapon("luck-blade", "Luck Blade", "Sword that grants a +1 bonus to attack and damage rolls and saving throws, can reroll a d20 once per dawn, and can cast wish from its charges.", magic({ prerequisite: "short-rest" }, [flatAttack(1, true), flatDamage(1, true)])),
    weapon("mace-of-disruption", "Mace of Disruption", "Mace that deals extra radiant damage to fiends and undead and can destroy a weakened one.", magic({ prerequisite: "short-rest" }, [])),
    weapon("mace-of-smiting", "Mace of Smiting", "Mace that grants a +1 bonus to attack and damage rolls (rising to +3 against constructs) and deals extra bludgeoning damage on a critical hit.", magic(null, [flatAttack(1, false), flatDamage(1, false)])),
    weapon("mace-of-terror", "Mace of Terror", "Mace with 3 charges that can expend a charge to release a wave of terror; it regains 1d3 charges daily at dawn.", magic({ prerequisite: "short-rest" }, [])),
    weapon("nine-lives-stealer", "Nine Lives Stealer", "Sword that grants a +2 bonus to attack and damage rolls and can instantly slay a weakened creature on a critical hit.", magic({ prerequisite: "short-rest" }, [flatAttack(2, true), flatDamage(2, true)])),
    weapon("oathbow", "Oathbow", "Longbow that grants advantage and an extra 3d6 piercing damage against a sworn enemy, at the cost of disadvantage against all others.", magic({ prerequisite: "short-rest" }, [])),
    weapon("scimitar-of-speed", "Scimitar of Speed", "Scimitar that grants a +2 bonus to attack and damage rolls and allows one attack with it as a bonus action each turn.", magic({ prerequisite: "short-rest" }, [flatAttack(2, true), flatDamage(2, true)])),
    weapon("sun-blade", "Sun Blade", "Longsword hilt that forms a blade of radiance, granting a +2 bonus to attack and damage rolls and dealing radiant damage.", magic({ prerequisite: "short-rest" }, [flatAttack(2, true), flatDamage(2, true)])),
    weapon("sword-of-life-stealing", "Sword of Life Stealing", "Sword that deals an extra 3d6 necrotic damage on a critical hit and grants temporary hit points equal to the extra damage.", magic({ prerequisite: "short-rest" }, [])),
    weapon("sword-of-sharpness", "Sword of Sharpness", "Sword that maximizes weapon damage against objects and deals an extra 4d6 slashing damage on a critical hit.", magic({ prerequisite: "short-rest" }, [])),
    weapon("sword-of-wounding", "Sword of Wounding", "Sword whose damage can be regained only through a rest and that can inflict persistent bleeding wounds.", magic({ prerequisite: "short-rest" }, [])),
    weapon("trident-of-fish-command", "Trident of Fish Command", "Trident with 3 charges that can expend a charge to cast dominate beast on a swimming beast; it regains 1d3 charges daily at dawn.", magic({ prerequisite: "short-rest" }, [])),
    weapon("vicious-weapon", "Vicious Weapon", "Weapon that deals an extra 2d6 damage of the weapon's type on a critical hit.", magic(null, [])),
    weapon("vorpal-sword", "Vorpal Sword", "Legendary sword that grants a +3 bonus to attack and damage rolls, ignores resistance to slashing damage, and can sever a creature's head on a critical hit.", magic({ prerequisite: "short-rest" }, [flatAttack(3, true), flatDamage(3, true)])),
    weapon("weapon-plus-1", "Weapon, +1", "Magic weapon (any) that grants a +1 bonus to attack and damage rolls.", magic(null, [flatAttack(1, false), flatDamage(1, false)])),
    weapon("weapon-plus-2", "Weapon, +2", "Magic weapon (any) that grants a +2 bonus to attack and damage rolls.", magic(null, [flatAttack(2, false), flatDamage(2, false)])),
    weapon("weapon-plus-3", "Weapon, +3", "Magic weapon (any) that grants a +3 bonus to attack and damage rolls.", magic(null, [flatAttack(3, false), flatDamage(3, false)])),
  ];
}
