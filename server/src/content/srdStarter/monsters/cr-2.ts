import type { StarterReferences } from "../references.js";
import {
  monsterAttack,
  monsterTrait,
  monsterTemplate,
  type MonsterAttackSpec,
  type MonsterBand,
  type MonsterTemplateSpec,
} from "./enemyBuilder.js";

type TraitSpec = Readonly<{ slug: string; name: string; description: string }>;

/**
 * SRD 5.1 challenge-rating-2 monster band. Each profile keeps one executable
 * basic melee attack plus bounded trait markers for notable passives,
 * multiattacks, and other non-executable actions.
 */
export function cr2Band(refs: StarterReferences): MonsterBand {
  const abilities: object[] = [];
  const enemies: object[] = [];

  const define = (
    attack: MonsterAttackSpec,
    traits: readonly TraitSpec[],
    template: Omit<MonsterTemplateSpec, "primaryAttack" | "traitRefs">,
  ): void => {
    const primaryAttack = monsterAttack(refs, attack);
    const traitAbilities = traits.map((trait) => monsterTrait(refs, trait.slug, trait.name, trait.description));
    abilities.push(primaryAttack, ...traitAbilities);
    enemies.push(monsterTemplate(refs, {
      ...template,
      primaryAttack: primaryAttack.reference,
      traitRefs: traitAbilities.map((trait) => trait.reference),
    }));
  };

  define(
    { abilitySlug: "ankheg-bite", name: "Ankheg Bite", damageType: "slashing", count: 2, sides: 6, modifier: 3 },
    [{ slug: "ankheg-acid-spray", name: "Acid Spray", description: "The ankheg sprays acid in a 30-foot line (DC 13 Dexterity save, 3d6 acid); the area attack is metadata only." }],
    { slug: "ankheg", name: "Ankheg", cr: 2, crTag: "cr-2", maxHp: 39, defense: 14, speed: 30, attackBonus: 5 },
  );
  define(
    { abilitySlug: "awakened-tree-slam", name: "Awakened Tree Slam", damageType: "bludgeoning", count: 3, sides: 6, modifier: 4 },
    [{ slug: "awakened-tree-false-appearance", name: "False Appearance", description: "While motionless, the tree is indistinguishable from a normal tree." }],
    { slug: "awakened-tree", name: "Awakened Tree", cr: 2, crTag: "cr-2", maxHp: 59, defense: 13, speed: 20, attackBonus: 6, resistances: ["bludgeoning", "piercing"], vulnerabilities: ["fire"] },
  );
  define(
    { abilitySlug: "azer-warhammer", name: "Azer Warhammer", damageType: "bludgeoning", count: 1, sides: 8, modifier: 3 },
    [
      { slug: "azer-heated-body", name: "Heated Body", description: "A creature that touches the azer or hits it with a melee attack within 5 feet takes 1d10 fire damage." },
      { slug: "azer-heated-weapons", name: "Heated Weapons", description: "A hit with a metal melee weapon deals an extra 1d6 fire damage." },
      { slug: "azer-illumination", name: "Illumination", description: "The azer sheds bright light in a 10-foot radius and dim light for 10 more feet." },
    ],
    { slug: "azer", name: "Azer", cr: 2, crTag: "cr-2", maxHp: 39, defense: 17, speed: 30, attackBonus: 5, immunities: ["fire"] },
  );
  define(
    { abilitySlug: "bandit-captain-scimitar", name: "Bandit Captain Scimitar", damageType: "slashing", count: 1, sides: 6, modifier: 3 },
    [
      { slug: "bandit-captain-multiattack", name: "Multiattack", description: "The captain makes three melee attacks (two scimitar, one dagger) or two ranged dagger attacks." },
      { slug: "bandit-captain-parry", name: "Parry", description: "The captain adds 2 to its AC against one melee attack when it can see the attacker and wields a melee weapon." },
    ],
    { slug: "bandit-captain", name: "Bandit Captain", cr: 2, crTag: "cr-2", maxHp: 65, defense: 15, speed: 30, attackBonus: 5 },
  );
  define(
    { abilitySlug: "berserker-greataxe", name: "Berserker Greataxe", damageType: "slashing", count: 1, sides: 12, modifier: 3 },
    [{ slug: "berserker-reckless", name: "Reckless", description: "The berserker can gain advantage on melee attacks this turn while granting advantage to attackers." }],
    { slug: "berserker", name: "Berserker", cr: 2, crTag: "cr-2", maxHp: 67, defense: 13, speed: 30, attackBonus: 5 },
  );
  define(
    { abilitySlug: "black-dragon-wyrmling-bite", name: "Black Dragon Wyrmling Bite", damageType: "piercing", count: 1, sides: 10, modifier: 2 },
    [
      { slug: "black-dragon-wyrmling-amphibious", name: "Amphibious", description: "The dragon can breathe air and water." },
      { slug: "black-dragon-wyrmling-acid-breath", name: "Acid Breath", description: "The dragon exhales acid in a 15-foot line (DC 11 Dexterity save, 5d8 acid); the area attack is metadata only." },
    ],
    { slug: "black-dragon-wyrmling", name: "Black Dragon Wyrmling", cr: 2, crTag: "cr-2", maxHp: 33, defense: 17, speed: 30, attackBonus: 4 },
  );
  define(
    { abilitySlug: "bronze-dragon-wyrmling-bite", name: "Bronze Dragon Wyrmling Bite", damageType: "piercing", count: 1, sides: 10, modifier: 3 },
    [
      { slug: "bronze-dragon-wyrmling-amphibious", name: "Amphibious", description: "The dragon can breathe air and water." },
      { slug: "bronze-dragon-wyrmling-breath-weapons", name: "Breath Weapons", description: "The dragon exhales lightning in a 40-foot line (DC 12 Dexterity save, 3d10 lightning); the area attack is metadata only." },
    ],
    { slug: "bronze-dragon-wyrmling", name: "Bronze Dragon Wyrmling", cr: 2, crTag: "cr-2", maxHp: 32, defense: 17, speed: 30, attackBonus: 5, immunities: ["storm"] },
  );
  define(
    { abilitySlug: "centaur-pike", name: "Centaur Pike", damageType: "piercing", count: 1, sides: 10, modifier: 4 },
    [
      { slug: "centaur-multiattack", name: "Multiattack", description: "The centaur makes two attacks: pike and hooves, or two longbow attacks." },
      { slug: "centaur-charge", name: "Charge", description: "After moving 30 feet straight, a pike hit deals an extra 3d6 piercing damage." },
    ],
    { slug: "centaur", name: "Centaur", cr: 2, crTag: "cr-2", maxHp: 45, defense: 12, speed: 50, attackBonus: 6 },
  );
  define(
    { abilitySlug: "cult-fanatic-dagger", name: "Cult Fanatic Dagger", damageType: "piercing", count: 1, sides: 4, modifier: 2 },
    [
      { slug: "cult-fanatic-multiattack", name: "Multiattack", description: "The fanatic makes two melee attacks." },
      { slug: "cult-fanatic-dark-devotion", name: "Dark Devotion", description: "The fanatic has advantage on saving throws against being charmed or frightened." },
      { slug: "cult-fanatic-spellcasting", name: "Spellcasting", description: "4th-level Wisdom spellcaster (save DC 11, +3 to hit with spell attacks); prepared spells are metadata only." },
    ],
    { slug: "cult-fanatic", name: "Cult Fanatic", cr: 2, crTag: "cr-2", maxHp: 22, defense: 13, speed: 30, attackBonus: 4 },
  );
  define(
    { abilitySlug: "druid-quarterstaff", name: "Druid Quarterstaff", damageType: "bludgeoning", count: 1, sides: 6, modifier: 0 },
    [{ slug: "druid-spellcasting", name: "Spellcasting", description: "4th-level Wisdom spellcaster (save DC 12, +4 to hit with spell attacks); prepared spells are metadata only." }],
    { slug: "druid", name: "Druid", cr: 2, crTag: "cr-2", maxHp: 27, defense: 11, speed: 30, attackBonus: 2 },
  );
  define(
    { abilitySlug: "ettercap-bite", name: "Ettercap Bite", damageType: "piercing", count: 1, sides: 8, modifier: 2 },
    [
      { slug: "ettercap-multiattack", name: "Multiattack", description: "The ettercap makes two attacks: one bite and one claws." },
      { slug: "ettercap-spider-climb", name: "Spider Climb", description: "The ettercap can climb difficult surfaces, including upside down on ceilings." },
      { slug: "ettercap-web-sense", name: "Web Sense", description: "In contact with a web, the ettercap knows the location of any creature touching the same web." },
      { slug: "ettercap-web-walker", name: "Web Walker", description: "The ettercap ignores movement restrictions caused by webbing." },
    ],
    { slug: "ettercap", name: "Ettercap", cr: 2, crTag: "cr-2", maxHp: 44, defense: 13, speed: 30, attackBonus: 4 },
  );
  define(
    { abilitySlug: "gargoyle-claws", name: "Gargoyle Claws", damageType: "slashing", count: 1, sides: 6, modifier: 2 },
    [
      { slug: "gargoyle-multiattack", name: "Multiattack", description: "The gargoyle makes two attacks: one bite and one claws." },
      { slug: "gargoyle-false-appearance", name: "False Appearance", description: "While motionless, the gargoyle is indistinguishable from an inanimate statue." },
    ],
    { slug: "gargoyle", name: "Gargoyle", cr: 2, crTag: "cr-2", maxHp: 52, defense: 15, speed: 30, attackBonus: 4, resistances: ["bludgeoning", "piercing", "slashing"] },
  );
  define(
    { abilitySlug: "gelatinous-cube-pseudopod", name: "Gelatinous Cube Pseudopod", damageType: "physical", count: 3, sides: 6, modifier: 0 },
    [
      { slug: "gelatinous-cube-ooze-cube", name: "Ooze Cube", description: "The cube fills its space; entering creatures are subjected to Engulf." },
      { slug: "gelatinous-cube-transparent", name: "Transparent", description: "Spotting a motionless, hidden cube requires a DC 15 Wisdom (Perception) check." },
    ],
    { slug: "gelatinous-cube", name: "Gelatinous Cube", cr: 2, crTag: "cr-2", maxHp: 84, defense: 6, speed: 15, attackBonus: 4 },
  );
  define(
    { abilitySlug: "ghast-bite", name: "Ghast Bite", damageType: "piercing", count: 2, sides: 8, modifier: 3 },
    [
      { slug: "ghast-stench", name: "Stench", description: "A creature starting its turn within 5 feet must succeed on a DC 10 Constitution save or be poisoned." },
      { slug: "ghast-turn-defiance", name: "Turn Defiance", description: "The ghast and nearby ghouls have advantage on saves against effects that turn undead." },
    ],
    { slug: "ghast", name: "Ghast", cr: 2, crTag: "cr-2", maxHp: 36, defense: 13, speed: 30, attackBonus: 3 },
  );
  define(
    { abilitySlug: "giant-boar-tusk", name: "Giant Boar Tusk", damageType: "slashing", count: 2, sides: 6, modifier: 3 },
    [
      { slug: "giant-boar-charge", name: "Charge", description: "After moving 20 feet straight, a tusk hit deals an extra 2d6 slashing damage." },
      { slug: "giant-boar-relentless", name: "Relentless", description: "Damage of 10 or less that would drop the boar to 0 hit points leaves it at 1 instead." },
    ],
    { slug: "giant-boar", name: "Giant Boar", cr: 2, crTag: "cr-2", maxHp: 42, defense: 12, speed: 40, attackBonus: 5 },
  );
  define(
    { abilitySlug: "giant-constrictor-snake-bite", name: "Giant Constrictor Snake Bite", damageType: "piercing", count: 2, sides: 6, modifier: 4 },
    [{ slug: "giant-constrictor-snake-constrict", name: "Constrict", description: "A constrict hit grapples and restrains the target (escape DC 16); the grapple is metadata only." }],
    { slug: "giant-constrictor-snake", name: "Giant Constrictor Snake", cr: 2, crTag: "cr-2", maxHp: 60, defense: 12, speed: 30, attackBonus: 6 },
  );
  define(
    { abilitySlug: "giant-elk-ram", name: "Giant Elk Ram", damageType: "bludgeoning", count: 2, sides: 6, modifier: 4 },
    [{ slug: "giant-elk-charge", name: "Charge", description: "After moving 20 feet straight, a ram hit deals an extra 2d6 damage and can knock the target prone." }],
    { slug: "giant-elk", name: "Giant Elk", cr: 2, crTag: "cr-2", maxHp: 42, defense: 15, speed: 60, attackBonus: 6 },
  );
  define(
    { abilitySlug: "gibbering-mouther-bites", name: "Gibbering Mouther Bites", damageType: "piercing", count: 5, sides: 6, modifier: 0 },
    [
      { slug: "gibbering-mouther-multiattack", name: "Multiattack", description: "The mouther makes one bite attack and, if it can, uses Blinding Spittle." },
      { slug: "gibbering-mouther-aberrant-ground", name: "Aberrant Ground", description: "The ground in a 10-foot radius is difficult terrain and can knock creatures prone." },
      { slug: "gibbering-mouther-gibbering", name: "Gibbering", description: "The mouther babbles, forcing nearby creatures to make a DC 10 Wisdom save or be unable to take reactions." },
    ],
    { slug: "gibbering-mouther", name: "Gibbering Mouther", cr: 2, crTag: "cr-2", maxHp: 67, defense: 9, speed: 10, attackBonus: 2 },
  );
  define(
    { abilitySlug: "green-dragon-wyrmling-bite", name: "Green Dragon Wyrmling Bite", damageType: "piercing", count: 1, sides: 10, modifier: 2 },
    [
      { slug: "green-dragon-wyrmling-amphibious", name: "Amphibious", description: "The dragon can breathe air and water." },
      { slug: "green-dragon-wyrmling-poison-breath", name: "Poison Breath", description: "The dragon exhales poisonous gas in a 15-foot cone (DC 11 Constitution save, 6d6 poison); the area attack is metadata only." },
    ],
    { slug: "green-dragon-wyrmling", name: "Green Dragon Wyrmling", cr: 2, crTag: "cr-2", maxHp: 38, defense: 17, speed: 30, attackBonus: 4 },
  );
  define(
    { abilitySlug: "grick-tentacles", name: "Grick Tentacles", damageType: "slashing", count: 2, sides: 6, modifier: 2 },
    [
      { slug: "grick-multiattack", name: "Multiattack", description: "The grick makes one tentacles attack; a hit enables one beak attack against the same target." },
      { slug: "grick-stone-camouflage", name: "Stone Camouflage", description: "The grick has advantage on Dexterity (Stealth) checks made to hide in rocky terrain." },
    ],
    { slug: "grick", name: "Grick", cr: 2, crTag: "cr-2", maxHp: 27, defense: 14, speed: 30, attackBonus: 4, resistances: ["bludgeoning", "piercing", "slashing"] },
  );
  define(
    { abilitySlug: "griffon-beak", name: "Griffon Beak", damageType: "piercing", count: 1, sides: 8, modifier: 4 },
    [
      { slug: "griffon-multiattack", name: "Multiattack", description: "The griffon makes two attacks: one beak and one claws." },
      { slug: "griffon-keen-sight", name: "Keen Sight", description: "The griffon has advantage on Wisdom (Perception) checks that rely on sight." },
    ],
    { slug: "griffon", name: "Griffon", cr: 2, crTag: "cr-2", maxHp: 59, defense: 12, speed: 30, attackBonus: 6 },
  );
  define(
    { abilitySlug: "hunter-shark-bite", name: "Hunter Shark Bite", damageType: "piercing", count: 2, sides: 8, modifier: 4 },
    [
      { slug: "hunter-shark-blood-frenzy", name: "Blood Frenzy", description: "The shark has advantage on melee attacks against a creature that does not have all its hit points." },
      { slug: "hunter-shark-water-breathing", name: "Water Breathing", description: "The shark can breathe only underwater." },
    ],
    { slug: "hunter-shark", name: "Hunter Shark", cr: 2, crTag: "cr-2", maxHp: 45, defense: 12, speed: 40, attackBonus: 6 },
  );
  define(
    { abilitySlug: "merrow-harpoon", name: "Merrow Harpoon", damageType: "piercing", count: 2, sides: 6, modifier: 4 },
    [
      { slug: "merrow-multiattack", name: "Multiattack", description: "The merrow makes two attacks: one bite and one claws or harpoon." },
      { slug: "merrow-amphibious", name: "Amphibious", description: "The merrow can breathe air and water." },
    ],
    { slug: "merrow", name: "Merrow", cr: 2, crTag: "cr-2", maxHp: 45, defense: 13, speed: 10, attackBonus: 6 },
  );
  define(
    { abilitySlug: "mimic-bite", name: "Mimic Bite", damageType: "piercing", count: 1, sides: 8, modifier: 3 },
    [
      { slug: "mimic-adhesive", name: "Adhesive", description: "In object form the mimic adheres to anything that touches it, grappling the creature (escape DC 13)." },
      { slug: "mimic-false-appearance", name: "False Appearance", description: "While motionless, the mimic is indistinguishable from an ordinary object." },
      { slug: "mimic-grappler", name: "Grappler", description: "The mimic has advantage on attacks against any creature grappled by it." },
      { slug: "mimic-shapechanger", name: "Shapechanger", description: "The mimic can polymorph into an object or back into its amorphous form." },
    ],
    { slug: "mimic", name: "Mimic", cr: 2, crTag: "cr-2", maxHp: 58, defense: 12, speed: 15, attackBonus: 5 },
  );
  define(
    { abilitySlug: "minotaur-skeleton-greataxe", name: "Minotaur Skeleton Greataxe", damageType: "slashing", count: 2, sides: 12, modifier: 4 },
    [{ slug: "minotaur-skeleton-charge", name: "Charge", description: "After moving 10 feet straight, a gore hit deals an extra 2d8 piercing damage and can push the target." }],
    { slug: "minotaur-skeleton", name: "Minotaur Skeleton", cr: 2, crTag: "cr-2", maxHp: 67, defense: 12, speed: 40, attackBonus: 6, vulnerabilities: ["bludgeoning"] },
  );
  define(
    { abilitySlug: "ochre-jelly-pseudopod", name: "Ochre Jelly Pseudopod", damageType: "bludgeoning", count: 2, sides: 6, modifier: 2 },
    [
      { slug: "ochre-jelly-amorphous", name: "Amorphous", description: "The jelly can move through a space as narrow as 1 inch wide without squeezing." },
      { slug: "ochre-jelly-spider-climb", name: "Spider Climb", description: "The jelly can climb difficult surfaces, including upside down on ceilings." },
      { slug: "ochre-jelly-split", name: "Split", description: "Lightning or slashing damage can split the jelly into two smaller jellies." },
    ],
    { slug: "ochre-jelly", name: "Ochre Jelly", cr: 2, crTag: "cr-2", maxHp: 45, defense: 8, speed: 10, attackBonus: 4, immunities: ["storm", "slashing"] },
  );
  define(
    { abilitySlug: "ogre-greatclub", name: "Ogre Greatclub", damageType: "bludgeoning", count: 2, sides: 8, modifier: 4 },
    [],
    { slug: "ogre", name: "Ogre", cr: 2, crTag: "cr-2", maxHp: 59, defense: 11, speed: 40, attackBonus: 6 },
  );
  define(
    { abilitySlug: "ogre-zombie-morningstar", name: "Ogre Zombie Morningstar", damageType: "bludgeoning", count: 2, sides: 8, modifier: 4 },
    [{ slug: "ogre-zombie-undead-fortitude", name: "Undead Fortitude", description: "A Constitution save against a damage DC can leave the zombie at 1 hit point instead of 0, unless the damage is radiant or a critical hit." }],
    { slug: "ogre-zombie", name: "Ogre Zombie", cr: 2, crTag: "cr-2", maxHp: 85, defense: 8, speed: 30, attackBonus: 6 },
  );
  define(
    { abilitySlug: "pegasus-hooves", name: "Pegasus Hooves", damageType: "bludgeoning", count: 2, sides: 6, modifier: 4 },
    [],
    { slug: "pegasus", name: "Pegasus", cr: 2, crTag: "cr-2", maxHp: 59, defense: 12, speed: 60, attackBonus: 6 },
  );
  define(
    { abilitySlug: "plesiosaurus-bite", name: "Plesiosaurus Bite", damageType: "piercing", count: 3, sides: 6, modifier: 4 },
    [{ slug: "plesiosaurus-hold-breath", name: "Hold Breath", description: "The plesiosaurus can hold its breath for 1 hour." }],
    { slug: "plesiosaurus", name: "Plesiosaurus", cr: 2, crTag: "cr-2", maxHp: 68, defense: 13, speed: 20, attackBonus: 6 },
  );
  define(
    { abilitySlug: "polar-bear-bite", name: "Polar Bear Bite", damageType: "piercing", count: 1, sides: 8, modifier: 5 },
    [
      { slug: "polar-bear-multiattack", name: "Multiattack", description: "The bear makes two attacks: one bite and one claws." },
      { slug: "polar-bear-keen-smell", name: "Keen Smell", description: "The bear has advantage on Wisdom (Perception) checks that rely on smell." },
    ],
    { slug: "polar-bear", name: "Polar Bear", cr: 2, crTag: "cr-2", maxHp: 42, defense: 12, speed: 40, attackBonus: 7 },
  );
  define(
    { abilitySlug: "priest-mace", name: "Priest Mace", damageType: "bludgeoning", count: 1, sides: 6, modifier: 0 },
    [
      { slug: "priest-divine-eminence", name: "Divine Eminence", description: "As a bonus action the priest can expend a spell slot to add 3d6 radiant damage to melee weapon hits." },
      { slug: "priest-spellcasting", name: "Spellcasting", description: "5th-level Wisdom spellcaster (save DC 13, +5 to hit with spell attacks); prepared spells are metadata only." },
    ],
    { slug: "priest", name: "Priest", cr: 2, crTag: "cr-2", maxHp: 27, defense: 13, speed: 25, attackBonus: 2 },
  );
  define(
    { abilitySlug: "rhinoceros-gore", name: "Rhinoceros Gore", damageType: "bludgeoning", count: 2, sides: 8, modifier: 5 },
    [{ slug: "rhinoceros-charge", name: "Charge", description: "After moving 20 feet straight, a gore hit deals an extra 2d8 bludgeoning damage and can push the target prone." }],
    { slug: "rhinoceros", name: "Rhinoceros", cr: 2, crTag: "cr-2", maxHp: 45, defense: 11, speed: 40, attackBonus: 7 },
  );
  define(
    { abilitySlug: "rug-of-smothering-smother", name: "Rug of Smothering Smother", damageType: "bludgeoning", count: 2, sides: 6, modifier: 3 },
    [
      { slug: "rug-of-smothering-antimagic-susceptibility", name: "Antimagic Susceptibility", description: "The rug is incapacitated in an antimagic field and is subject to dispel magic." },
      { slug: "rug-of-smothering-damage-transfer", name: "Damage Transfer", description: "While grappling, the rug takes half of the damage dealt to it and the grappled creature takes the other half." },
      { slug: "rug-of-smothering-false-appearance", name: "False Appearance", description: "While motionless, the rug is indistinguishable from a normal rug." },
    ],
    { slug: "rug-of-smothering", name: "Rug of Smothering", cr: 2, crTag: "cr-2", maxHp: 33, defense: 12, speed: 10, attackBonus: 5 },
  );
  define(
    { abilitySlug: "saber-toothed-tiger-bite", name: "Saber-Toothed Tiger Bite", damageType: "piercing", count: 1, sides: 10, modifier: 5 },
    [
      { slug: "saber-toothed-tiger-keen-smell", name: "Keen Smell", description: "The tiger has advantage on Wisdom (Perception) checks that rely on smell." },
      { slug: "saber-toothed-tiger-pounce", name: "Pounce", description: "After moving 20 feet straight, a claw hit forces a DC 14 Strength save or knocks the target prone." },
    ],
    { slug: "saber-toothed-tiger", name: "Saber-Toothed Tiger", cr: 2, crTag: "cr-2", maxHp: 52, defense: 12, speed: 40, attackBonus: 6 },
  );
  define(
    { abilitySlug: "sea-hag-claws", name: "Sea Hag Claws", damageType: "slashing", count: 2, sides: 6, modifier: 3 },
    [
      { slug: "sea-hag-amphibious", name: "Amphibious", description: "The hag can breathe air and water." },
      { slug: "sea-hag-horrific-appearance", name: "Horrific Appearance", description: "A humanoid starting its turn within 30 feet must succeed on a DC 11 Wisdom save or be frightened." },
      { slug: "sea-hag-death-glare", name: "Death Glare", description: "A frightened creature that can see the hag must succeed on a DC 11 Wisdom save or drop to 0 hit points." },
      { slug: "sea-hag-illusory-appearance", name: "Illusory Appearance", description: "The hag can mask herself and her possessions with a magical illusion." },
    ],
    { slug: "sea-hag", name: "Sea Hag", cr: 2, crTag: "cr-2", maxHp: 52, defense: 14, speed: 30, attackBonus: 5 },
  );
  define(
    { abilitySlug: "silver-dragon-wyrmling-bite", name: "Silver Dragon Wyrmling Bite", damageType: "piercing", count: 1, sides: 10, modifier: 4 },
    [{ slug: "silver-dragon-wyrmling-breath-weapons", name: "Breath Weapons", description: "The dragon exhales cold in a 15-foot cone (DC 13 Constitution save, 4d8 cold) or paralyzing gas; the area attacks are metadata only." }],
    { slug: "silver-dragon-wyrmling", name: "Silver Dragon Wyrmling", cr: 2, crTag: "cr-2", maxHp: 45, defense: 17, speed: 30, attackBonus: 6, immunities: ["cold"] },
  );
  define(
    { abilitySlug: "swarm-of-poisonous-snakes-bites", name: "Swarm of Poisonous Snakes Bites", damageType: "piercing", count: 2, sides: 6, modifier: 0 },
    [{ slug: "swarm-of-poisonous-snakes-swarm", name: "Swarm", description: "The swarm can occupy another creature's space and cannot regain hit points or gain temporary hit points." }],
    { slug: "swarm-of-poisonous-snakes", name: "Swarm of Poisonous Snakes", cr: 2, crTag: "cr-2", maxHp: 36, defense: 14, speed: 30, attackBonus: 6, resistances: ["bludgeoning", "piercing", "slashing"] },
  );
  define(
    { abilitySlug: "wererat-shortsword", name: "Wererat Shortsword", damageType: "piercing", count: 1, sides: 6, modifier: 2 },
    [
      { slug: "wererat-multiattack", name: "Multiattack", description: "The wererat makes two attacks, only one of which can be a bite." },
      { slug: "wererat-keen-smell", name: "Keen Smell", description: "The wererat has advantage on Wisdom (Perception) checks that rely on smell." },
      { slug: "wererat-shapechanger", name: "Shapechanger", description: "The wererat can polymorph into a rat-humanoid hybrid or a giant rat, or back into its true humanoid form." },
    ],
    { slug: "wererat", name: "Wererat", cr: 2, crTag: "cr-2", maxHp: 33, defense: 12, speed: 30, attackBonus: 4, immunities: ["bludgeoning", "piercing", "slashing"] },
  );
  define(
    { abilitySlug: "white-dragon-wyrmling-bite", name: "White Dragon Wyrmling Bite", damageType: "piercing", count: 1, sides: 10, modifier: 2 },
    [{ slug: "white-dragon-wyrmling-cold-breath", name: "Cold Breath", description: "The dragon exhales icy hail in a 15-foot cone (DC 12 Constitution save, 5d8 cold); the area attack is metadata only." }],
    { slug: "white-dragon-wyrmling", name: "White Dragon Wyrmling", cr: 2, crTag: "cr-2", maxHp: 32, defense: 16, speed: 30, attackBonus: 4, immunities: ["cold"] },
  );
  define(
    { abilitySlug: "will-o-wisp-shock", name: "Will-o'-Wisp Shock", damageType: "storm", count: 2, sides: 8, modifier: 0 },
    [
      { slug: "will-o-wisp-consume-life", name: "Consume Life", description: "As a bonus action the wisp can target a living creature at 0 hit points, which must succeed on a DC 10 Constitution save or die." },
      { slug: "will-o-wisp-ephemeral", name: "Ephemeral", description: "The will-o'-wisp can't wear or carry anything." },
      { slug: "will-o-wisp-incorporeal-movement", name: "Incorporeal Movement", description: "The wisp can move through creatures and objects as difficult terrain, taking 1d10 force damage if it ends its turn inside an object." },
      { slug: "will-o-wisp-variable-illumination", name: "Variable Illumination", description: "The wisp sheds bright light in a 5- to 20-foot radius and dim light for an equal additional distance." },
    ],
    { slug: "will-o-wisp", name: "Will-o'-Wisp", cr: 2, crTag: "cr-2", maxHp: 22, defense: 19, speed: 50, attackBonus: 4, resistances: ["bludgeoning", "cold", "fire", "piercing", "slashing"], immunities: ["storm"] },
  );

  return { abilities, enemies };
}
