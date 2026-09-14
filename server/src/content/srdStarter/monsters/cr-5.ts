import type { StarterReferences } from "../references.js";
import {
  monsterAttack,
  monsterTemplate,
  monsterTrait,
  type MonsterAttackSpec,
  type MonsterTemplateSpec,
} from "./enemyBuilder.js";

type Cr5Trait = { slug: string; name: string; description: string };

type Cr5Monster = {
  attack: MonsterAttackSpec;
  traits?: readonly Cr5Trait[];
  template: Omit<MonsterTemplateSpec, "cr" | "crTag" | "primaryAttack" | "traitRefs">;
};

function defineMonster(refs: StarterReferences, monster: Cr5Monster) {
  const attack = monsterAttack(refs, monster.attack);
  const traits = (monster.traits ?? []).map((trait) => monsterTrait(refs, trait.slug, trait.name, trait.description));
  const enemy = monsterTemplate(refs, {
    ...monster.template,
    cr: 5,
    crTag: "cr-5",
    primaryAttack: attack.reference,
    traitRefs: traits.map((trait) => trait.reference),
  });
  return { abilities: [attack, ...traits], enemy };
}

export function cr5Band(refs: StarterReferences) {
  const monsters = [
    defineMonster(refs, {
      attack: { abilitySlug: "air-elemental-slam", name: "Air Elemental Slam", damageType: "bludgeoning", count: 2, sides: 8, modifier: 5 },
      traits: [
        { slug: "air-elemental-air-form", name: "Air Form", description: "The air elemental can enter a hostile creature's space and stop there, and can move through a space as narrow as 1 inch without squeezing. Not executable at runtime." },
        { slug: "air-elemental-multiattack", name: "Multiattack", description: "The air elemental makes two slam attacks; only the single pinned slam is executable." },
      ],
      template: { slug: "air-elemental", name: "Air Elemental", maxHp: 90, defense: 15, speed: 90, attackBonus: 8, resistances: ["storm", "bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "barbed-devil-claw", name: "Barbed Devil Claw", damageType: "piercing", count: 1, sides: 6, modifier: 3 },
      traits: [
        { slug: "barbed-devil-barbed-hide", name: "Barbed Hide", description: "At the start of each of its turns, the barbed devil deals 1d10 piercing damage to any creature grappling it. The rider is metadata only." },
        { slug: "barbed-devil-devils-sight", name: "Devil's Sight", description: "Magical darkness does not impede the barbed devil's darkvision. Lighting is not modeled." },
        { slug: "barbed-devil-multiattack", name: "Multiattack", description: "The barbed devil makes three melee attacks (claw, claw, tail) or two hurl flame attacks; only the pinned claw is executable." },
      ],
      template: { slug: "barbed-devil", name: "Barbed Devil", maxHp: 110, defense: 15, speed: 30, attackBonus: 6, resistances: ["cold", "bludgeoning", "piercing", "slashing"], immunities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "bulette-bite", name: "Bulette Bite", damageType: "piercing", count: 4, sides: 12, modifier: 4 },
      traits: [
        { slug: "bulette-standing-leap", name: "Standing Leap", description: "The bulette's long jump is up to 30 feet and its high jump up to 15 feet, with or without a running start. Grid movement is not modeled." },
        { slug: "bulette-deadly-leap", name: "Deadly Leap", description: "If the bulette jumps at least 15 feet, creatures in its landing space must make a DC 17 Strength or Dexterity save or take bludgeoning damage and fall prone. The save and condition are metadata only." },
      ],
      template: { slug: "bulette", name: "Bulette", maxHp: 94, defense: 17, speed: 40, attackBonus: 7 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "earth-elemental-slam", name: "Earth Elemental Slam", damageType: "bludgeoning", count: 2, sides: 8, modifier: 5 },
      traits: [
        { slug: "earth-elemental-earth-glide", name: "Earth Glide", description: "The earth elemental can burrow through nonmagical, unworked earth and stone without disturbing it. Not executable at runtime." },
        { slug: "earth-elemental-siege-monster", name: "Siege Monster", description: "The earth elemental deals double damage to objects and structures. Object damage is not modeled." },
        { slug: "earth-elemental-multiattack", name: "Multiattack", description: "The earth elemental makes two slam attacks; only the single pinned slam is executable." },
      ],
      template: { slug: "earth-elemental", name: "Earth Elemental", maxHp: 126, defense: 17, speed: 30, attackBonus: 8, resistances: ["bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "fire-elemental-touch", name: "Fire Elemental Touch", damageType: "fire", count: 2, sides: 6, modifier: 3 },
      traits: [
        { slug: "fire-elemental-fire-form", name: "Fire Form", description: "A creature that touches the fire elemental or hits it with a melee attack within 5 feet takes 1d10 fire damage, and the elemental can move through a space as narrow as 1 inch. The touch damage is metadata only." },
        { slug: "fire-elemental-illumination", name: "Illumination", description: "The fire elemental sheds bright light in a 30-foot radius and dim light for an additional 30 feet. Lighting is not modeled." },
        { slug: "fire-elemental-water-susceptibility", name: "Water Susceptibility", description: "For every 5 feet the fire elemental moves in water, or for every gallon of water splashed on it, it takes 1 cold damage. The vulnerability rider is metadata only." },
        { slug: "fire-elemental-multiattack", name: "Multiattack", description: "The fire elemental makes two touch attacks; only the single pinned touch is executable." },
      ],
      template: { slug: "fire-elemental", name: "Fire Elemental", maxHp: 102, defense: 13, speed: 50, attackBonus: 6, resistances: ["bludgeoning", "piercing", "slashing"], immunities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "flesh-golem-slam", name: "Flesh Golem Slam", damageType: "bludgeoning", count: 2, sides: 8, modifier: 4 },
      traits: [
        { slug: "flesh-golem-berserk", name: "Berserk", description: "When the flesh golem starts its turn with 40 hit points or fewer, it may go berserk and attack the nearest creature. The behavior is metadata only." },
        { slug: "flesh-golem-aversion-to-fire", name: "Aversion to Fire", description: "If the flesh golem takes fire damage, it has disadvantage on attack rolls and ability checks until the end of its next turn. The disadvantage is metadata only." },
        { slug: "flesh-golem-immutable-form", name: "Immutable Form", description: "The flesh golem is immune to any spell or effect that would alter its form. Not executable at runtime." },
        { slug: "flesh-golem-magic-resistance", name: "Magic Resistance", description: "The flesh golem has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
      ],
      template: { slug: "flesh-golem", name: "Flesh Golem", maxHp: 93, defense: 9, speed: 30, attackBonus: 7, immunities: ["storm", "bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "giant-crocodile-bite", name: "Giant Crocodile Bite", damageType: "piercing", count: 3, sides: 10, modifier: 5 },
      traits: [
        { slug: "giant-crocodile-hold-breath", name: "Hold Breath", description: "The giant crocodile can hold its breath for 30 minutes. Not executable at runtime." },
        { slug: "giant-crocodile-multiattack", name: "Multiattack", description: "The giant crocodile makes two attacks: one with its bite and one with its tail; only the pinned bite is executable." },
      ],
      template: { slug: "giant-crocodile", name: "Giant Crocodile", maxHp: 85, defense: 14, speed: 30, attackBonus: 8 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "giant-shark-bite", name: "Giant Shark Bite", damageType: "piercing", count: 3, sides: 10, modifier: 6 },
      traits: [
        { slug: "giant-shark-blood-frenzy", name: "Blood Frenzy", description: "The giant shark has advantage on melee attack rolls against any creature that does not have all its hit points. The advantage is metadata only." },
        { slug: "giant-shark-water-breathing", name: "Water Breathing", description: "The giant shark can breathe only underwater. Not executable at runtime." },
      ],
      template: { slug: "giant-shark", name: "Giant Shark", maxHp: 126, defense: 13, speed: 50, attackBonus: 9 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "gladiator-spear", name: "Gladiator Spear", damageType: "piercing", count: 2, sides: 6, modifier: 4 },
      traits: [
        { slug: "gladiator-brave", name: "Brave", description: "The gladiator has advantage on saving throws against being frightened. The advantage is metadata only." },
        { slug: "gladiator-brute", name: "Brute", description: "A melee weapon deals one extra die of its damage when the gladiator hits with it. The extra die is metadata only." },
        { slug: "gladiator-parry", name: "Parry", description: "The gladiator adds 3 to its AC against one melee attack that would hit it as a reaction. The reaction is metadata only." },
        { slug: "gladiator-multiattack", name: "Multiattack", description: "The gladiator makes three melee attacks or two ranged attacks; only the pinned spear is executable." },
      ],
      template: { slug: "gladiator", name: "Gladiator", maxHp: 112, defense: 16, speed: 30, attackBonus: 7 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "gorgon-hooves", name: "Gorgon Hooves", damageType: "bludgeoning", count: 2, sides: 8, modifier: 5 },
      traits: [
        { slug: "gorgon-trampling-charge", name: "Trampling Charge", description: "If the gorgon moves at least 20 feet straight toward a creature and then hits it with a hooves attack, the target must succeed on a DC 16 Strength save or be knocked prone. The charge is metadata only." },
        { slug: "gorgon-petrifying-breath", name: "Petrifying Breath", description: "The gorgon exhales petrifying gas in a 30-foot cone (recharge 5-6); creatures must make a DC 13 Constitution save or begin turning to stone. The save and condition are metadata only." },
      ],
      template: { slug: "gorgon", name: "Gorgon", maxHp: 114, defense: 19, speed: 30, attackBonus: 8 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "half-red-dragon-veteran-longsword", name: "Half-Red Dragon Veteran Longsword", damageType: "slashing", count: 1, sides: 8, modifier: 3 },
      traits: [
        { slug: "half-red-dragon-veteran-fire-breath", name: "Fire Breath", description: "The veteran exhales fire in a 15-foot cone (recharge 5-6); creatures must make a DC 15 Dexterity save, taking 7d6 fire damage on a failure. The area and save are metadata only." },
        { slug: "half-red-dragon-veteran-multiattack", name: "Multiattack", description: "The veteran makes two longsword attacks or two shortsword attacks; only the pinned longsword is executable." },
      ],
      template: { slug: "half-red-dragon-veteran", name: "Half-Red Dragon Veteran", maxHp: 65, defense: 18, speed: 30, attackBonus: 5, resistances: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "hill-giant-greatclub", name: "Hill Giant Greatclub", damageType: "bludgeoning", count: 2, sides: 8, modifier: 5 },
      traits: [
        { slug: "hill-giant-multiattack", name: "Multiattack", description: "The hill giant makes two greatclub attacks; only the single pinned greatclub is executable." },
      ],
      template: { slug: "hill-giant", name: "Hill Giant", maxHp: 105, defense: 11, speed: 40, attackBonus: 8 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "otyugh-bite", name: "Otyugh Bite", damageType: "piercing", count: 2, sides: 8, modifier: 4 },
      traits: [
        { slug: "otyugh-limited-telepathy", name: "Limited Telepathy", description: "The otyugh can magically transmit simple messages within 120 feet to creatures that can understand a language. Not executable at runtime." },
        { slug: "otyugh-multiattack", name: "Multiattack", description: "The otyugh makes three attacks: one with its bite and two with its tentacles; only the pinned bite is executable." },
      ],
      template: { slug: "otyugh", name: "Otyugh", maxHp: 114, defense: 12, speed: 30, attackBonus: 6 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "roper-bite", name: "Roper Bite", damageType: "piercing", count: 4, sides: 8, modifier: 4 },
      traits: [
        { slug: "roper-false-appearance", name: "False Appearance", description: "While motionless, the roper is indistinguishable from an ordinary cave formation such as a stalagmite. Not executable at runtime." },
        { slug: "roper-grasping-tendrils", name: "Grasping Tendrils", description: "The roper can have up to six tendrils at a time; a creature hit by a tendril is grappled (escape DC 15). The grapple is metadata only." },
        { slug: "roper-spider-climb", name: "Spider Climb", description: "The roper can climb difficult surfaces, including upside down on ceilings, without an ability check. Grid movement is not modeled." },
        { slug: "roper-multiattack", name: "Multiattack", description: "The roper makes four attacks with its tendrils, uses Reel, and makes one bite attack; only the pinned bite is executable." },
      ],
      template: { slug: "roper", name: "Roper", maxHp: 93, defense: 20, speed: 10, attackBonus: 7 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "salamander-spear", name: "Salamander Spear", damageType: "piercing", count: 2, sides: 6, modifier: 4 },
      traits: [
        { slug: "salamander-heated-body", name: "Heated Body", description: "A creature that touches the salamander or hits it with a melee attack within 5 feet takes 2d6 fire damage. The touch damage is metadata only." },
        { slug: "salamander-heated-weapons", name: "Heated Weapons", description: "Any metal melee weapon the salamander wields deals an extra 1d6 fire damage on a hit. The extra damage is metadata only." },
        { slug: "salamander-multiattack", name: "Multiattack", description: "The salamander makes two attacks: one with its spear and one with its tail; only the pinned spear is executable." },
      ],
      template: { slug: "salamander", name: "Salamander", maxHp: 90, defense: 15, speed: 30, attackBonus: 7, resistances: ["bludgeoning", "piercing", "slashing"], immunities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "shambling-mound-slam", name: "Shambling Mound Slam", damageType: "bludgeoning", count: 2, sides: 8, modifier: 4 },
      traits: [
        { slug: "shambling-mound-lightning-absorption", name: "Lightning Absorption", description: "Whenever the shambling mound is subjected to lightning damage, it takes no damage and regains hit points equal to the damage dealt. The absorption is metadata only." },
        { slug: "shambling-mound-engulf", name: "Engulf", description: "The shambling mound can engulf a grappled Medium or smaller creature, which is blinded, restrained, and unable to breathe. The engulf is metadata only." },
        { slug: "shambling-mound-multiattack", name: "Multiattack", description: "The shambling mound makes two slam attacks; only the single pinned slam is executable." },
      ],
      template: { slug: "shambling-mound", name: "Shambling Mound", maxHp: 136, defense: 15, speed: 20, attackBonus: 7, resistances: ["cold", "fire", "bludgeoning", "piercing", "slashing"], immunities: ["storm"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "triceratops-gore", name: "Triceratops Gore", damageType: "piercing", count: 4, sides: 8, modifier: 6 },
      traits: [
        { slug: "triceratops-trampling-charge", name: "Trampling Charge", description: "If the triceratops moves at least 20 feet straight toward a creature and then hits it with a gore attack, the target must succeed on a DC 13 Strength save or be knocked prone. The charge is metadata only." },
      ],
      template: { slug: "triceratops", name: "Triceratops", maxHp: 95, defense: 13, speed: 50, attackBonus: 9 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "troll-claw", name: "Troll Claw", damageType: "slashing", count: 2, sides: 6, modifier: 4 },
      traits: [
        { slug: "troll-keen-smell", name: "Keen Smell", description: "The troll has advantage on Wisdom (Perception) checks that rely on smell. The advantage is metadata only." },
        { slug: "troll-regeneration", name: "Regeneration", description: "The troll regains 10 hit points at the start of its turn unless it took acid or fire damage since its last turn. The regeneration is metadata only." },
        { slug: "troll-reckless", name: "Reckless", description: "At the start of its turn, the troll can gain advantage on melee weapon attack rolls during that turn, but attack rolls against it have advantage until the start of its next turn. The toggles are metadata only." },
        { slug: "troll-multiattack", name: "Multiattack", description: "The troll makes three attacks: one with its bite and two with its claws; only the pinned claw is executable." },
      ],
      template: { slug: "troll", name: "Troll", maxHp: 84, defense: 15, speed: 30, attackBonus: 7 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "vampire-spawn-claws", name: "Vampire Spawn Claws", damageType: "slashing", count: 2, sides: 6, modifier: 3 },
      traits: [
        { slug: "vampire-spawn-regeneration", name: "Regeneration", description: "The vampire spawn regains 10 hit points at the start of its turn if it has at least 1 hit point and is not in sunlight or running water. The regeneration is metadata only." },
        { slug: "vampire-spawn-spider-climb", name: "Spider Climb", description: "The vampire spawn can climb difficult surfaces, including upside down on ceilings, without an ability check. Grid movement is not modeled." },
        { slug: "vampire-spawn-sunlight-sensitivity", name: "Sunlight Sensitivity", description: "While in sunlight, the vampire spawn has disadvantage on attack rolls and Wisdom (Perception) checks. Lighting is not modeled." },
        { slug: "vampire-spawn-multiattack", name: "Multiattack", description: "The vampire spawn makes two attacks, only one of which can be a bite; only the pinned claws are executable." },
      ],
      template: { slug: "vampire-spawn", name: "Vampire Spawn", maxHp: 82, defense: 15, speed: 30, attackBonus: 6, resistances: ["bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "water-elemental-slam", name: "Water Elemental Slam", damageType: "bludgeoning", count: 2, sides: 8, modifier: 4 },
      traits: [
        { slug: "water-elemental-water-form", name: "Water Form", description: "The water elemental can enter a hostile creature's space and stop there, and can move through a space as narrow as 1 inch without squeezing. Not executable at runtime." },
        { slug: "water-elemental-freeze", name: "Freeze", description: "If the water elemental takes cold damage, it partially freezes and its speed is reduced by 20 feet until the end of its next turn. The slow is metadata only." },
        { slug: "water-elemental-whelm", name: "Whelm", description: "The water elemental can engulf a Large or smaller creature, which is grappled and unable to breathe. The engulf is metadata only." },
        { slug: "water-elemental-multiattack", name: "Multiattack", description: "The water elemental makes two slam attacks; only the single pinned slam is executable." },
      ],
      template: { slug: "water-elemental", name: "Water Elemental", maxHp: 114, defense: 14, speed: 30, attackBonus: 7, resistances: ["cold", "fire", "bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "werebear-bite", name: "Werebear Bite", damageType: "piercing", count: 2, sides: 8, modifier: 5 },
      traits: [
        { slug: "werebear-shapechanger", name: "Shapechanger", description: "The werebear can use its action to polymorph into a Large bear-humanoid hybrid or a Large brown bear, or back into its true humanoid form. The transformation is metadata only." },
        { slug: "werebear-keen-smell", name: "Keen Smell", description: "The werebear has advantage on Wisdom (Perception) checks that rely on smell. The advantage is metadata only." },
        { slug: "werebear-multiattack", name: "Multiattack", description: "In bear form, the werebear makes two claw attacks; in hybrid form it makes one bite and one claw attack or two greataxe attacks; only the pinned bite is executable." },
      ],
      template: { slug: "werebear", name: "Werebear", maxHp: 135, defense: 11, speed: 30, attackBonus: 7, immunities: ["bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "wraith-life-drain", name: "Wraith Life Drain", damageType: "shadow", count: 3, sides: 6, modifier: 0 },
      traits: [
        { slug: "wraith-incorporeal-movement", name: "Incorporeal Movement", description: "The wraith can move through other creatures and objects as if they were difficult terrain, taking 5 force damage if it ends its turn inside an object. Not executable at runtime." },
        { slug: "wraith-sunlight-sensitivity", name: "Sunlight Sensitivity", description: "While in sunlight, the wraith has disadvantage on attack rolls and Wisdom (Perception) checks. Lighting is not modeled." },
        { slug: "wraith-create-specter", name: "Create Specter", description: "The wraith can target a humanoid slain by its life drain within 1 minute and raise its spirit as a specter. Summoning is metadata only." },
      ],
      template: { slug: "wraith", name: "Wraith", maxHp: 67, defense: 13, speed: 60, attackBonus: 6, resistances: ["cold", "fire", "storm", "bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "xorn-claw", name: "Xorn Claw", damageType: "slashing", count: 1, sides: 6, modifier: 3 },
      traits: [
        { slug: "xorn-earth-glide", name: "Earth Glide", description: "The xorn can burrow through nonmagical, unworked earth and stone without disturbing it. Not executable at runtime." },
        { slug: "xorn-stone-camouflage", name: "Stone Camouflage", description: "The xorn has advantage on Dexterity (Stealth) checks made to hide in rocky terrain. The advantage is metadata only." },
        { slug: "xorn-treasure-sense", name: "Treasure Sense", description: "The xorn can pinpoint precious metals and stones within 60 feet of it. Not executable at runtime." },
        { slug: "xorn-multiattack", name: "Multiattack", description: "The xorn makes three claw attacks and one bite attack; only the pinned claw is executable." },
      ],
      template: { slug: "xorn", name: "Xorn", maxHp: 73, defense: 19, speed: 20, attackBonus: 6, resistances: ["piercing", "slashing"] },
    }),
  ];

  return {
    abilities: monsters.flatMap((monster) => monster.abilities),
    enemies: monsters.map((monster) => monster.enemy),
  };
}
