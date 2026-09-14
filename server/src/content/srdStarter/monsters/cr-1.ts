import type { StarterReference, StarterReferences } from "../references.js";
import {
  monsterAttack,
  monsterTemplate,
  monsterTrait,
  type MonsterAttackSpec,
  type MonsterBand,
  type MonsterTemplateSpec,
} from "./enemyBuilder.js";

type MonsterMeta = Omit<MonsterTemplateSpec, "primaryAttack" | "traitRefs">;

/**
 * Every SRD 5.1 monster whose challenge rating is exactly 1. Each profile keeps
 * one executable basic attack; multiattack and signature traits are carried as
 * bounded metadata (tagged `unsupported-runtime`) because this pack does not
 * model positioning, saving throws, or per-turn attack sequences.
 */
export function cr1Band(refs: StarterReferences): MonsterBand {
  const abilities: object[] = [];
  const enemies: object[] = [];
  const traitCache = new Map<string, StarterReference>();

  const trait = (slug: string, name: string, description: string): StarterReference => {
    const cached = traitCache.get(slug);
    if (cached) return cached;
    const created = monsterTrait(refs, slug, name, description);
    abilities.push(created);
    traitCache.set(slug, created.reference);
    return created.reference;
  };

  const monster = (meta: MonsterMeta, attack: MonsterAttackSpec, traits: readonly StarterReference[] = []) => {
    const primaryAttack = monsterAttack(refs, attack);
    abilities.push(primaryAttack);
    enemies.push(monsterTemplate(refs, { ...meta, primaryAttack: primaryAttack.reference, traitRefs: traits }));
  };

  const multiattack = trait("cr1-multiattack", "Multiattack", "Multiattack is bounded metadata: additional attacks per turn are not executable in this pack.");
  const packTactics = trait("cr1-pack-tactics", "Pack Tactics", "Pack Tactics grants advantage while an ally threatens the target; positioning is not modeled, so this is metadata only.");
  const keenSmell = trait("cr1-keen-smell", "Keen Smell", "Keen Smell grants advantage on Wisdom (Perception) checks that rely on smell; metadata only.");
  const magicResistance = trait("cr1-magic-resistance", "Magic Resistance", "Magic Resistance grants advantage on saving throws against spells and other magical effects; metadata only.");
  const sunlightSensitivity = trait("cr1-sunlight-sensitivity", "Sunlight Sensitivity", "Sunlight Sensitivity imposes disadvantage in sunlight; lighting is not modeled, so this is metadata only.");
  const shapechanger = trait("cr1-shapechanger", "Shapechanger", "Shapechanger allows a beast-form polymorph; alternate forms are not executable in this pack.");

  monster(
    { slug: "animated-armor", name: "Animated Armor", cr: 1, crTag: "cr-1", maxHp: 33, defense: 18, speed: 25, attackBonus: 4 },
    { abilitySlug: "animated-armor-slam", name: "Animated Armor Slam", damageType: "bludgeoning", count: 1, sides: 6, modifier: 2 },
    [
      multiattack,
      trait("animated-armor-antimagic-susceptibility", "Antimagic Susceptibility", "Antimagic Susceptibility: the armor is incapacitated in an antimagic field and can be targeted by dispel magic; metadata only."),
      trait("animated-armor-false-appearance", "False Appearance", "False Appearance: while motionless, the armor is indistinguishable from an ordinary suit of armor; metadata only."),
    ],
  );

  monster(
    { slug: "brass-dragon-wyrmling", name: "Brass Dragon Wyrmling", cr: 1, crTag: "cr-1", maxHp: 16, defense: 16, speed: 30, attackBonus: 4, immunities: ["fire"] },
    { abilitySlug: "brass-dragon-wyrmling-bite", name: "Brass Dragon Wyrmling Bite", damageType: "piercing", count: 1, sides: 10, modifier: 2 },
    [trait("brass-dragon-wyrmling-breath-weapons", "Breath Weapons", "Breath Weapons (recharge 5-6): a fire line or a sleep cone. Area breath weapons are not executable in this pack.")],
  );

  monster(
    { slug: "brown-bear", name: "Brown Bear", cr: 1, crTag: "cr-1", maxHp: 34, defense: 11, speed: 40, attackBonus: 6 },
    { abilitySlug: "brown-bear-bite", name: "Brown Bear Bite", damageType: "piercing", count: 1, sides: 8, modifier: 4 },
    [multiattack, keenSmell],
  );

  monster(
    { slug: "bugbear", name: "Bugbear", cr: 1, crTag: "cr-1", maxHp: 27, defense: 16, speed: 30, attackBonus: 4 },
    { abilitySlug: "bugbear-morningstar", name: "Bugbear Morningstar", damageType: "piercing", count: 2, sides: 8, modifier: 2 },
    [
      trait("bugbear-brute", "Brute", "Brute: melee weapon damage rolls add one extra damage die; the extra die is not executable in this pack."),
      trait("bugbear-surprise-attack", "Surprise Attack", "Surprise Attack: an extra 2d6 damage against a surprised target; surprise is not modeled, so this is metadata only."),
    ],
  );

  monster(
    { slug: "copper-dragon-wyrmling", name: "Copper Dragon Wyrmling", cr: 1, crTag: "cr-1", maxHp: 22, defense: 16, speed: 30, attackBonus: 4 },
    { abilitySlug: "copper-dragon-wyrmling-bite", name: "Copper Dragon Wyrmling Bite", damageType: "piercing", count: 1, sides: 10, modifier: 2 },
    [trait("copper-dragon-wyrmling-breath-weapons", "Breath Weapons", "Breath Weapons (recharge 5-6): an acid line or a slowing cone. Area breath weapons are not executable in this pack.")],
  );

  monster(
    { slug: "death-dog", name: "Death Dog", cr: 1, crTag: "cr-1", maxHp: 39, defense: 12, speed: 40, attackBonus: 4 },
    { abilitySlug: "death-dog-bite", name: "Death Dog Bite", damageType: "piercing", count: 1, sides: 6, modifier: 2 },
    [
      multiattack,
      trait("death-dog-two-headed", "Two-Headed", "Two-Headed: advantage on Wisdom (Perception) checks and on saving throws against being blinded, deafened, stunned, or knocked unconscious; metadata only."),
    ],
  );

  monster(
    { slug: "dire-wolf", name: "Dire Wolf", cr: 1, crTag: "cr-1", maxHp: 37, defense: 14, speed: 50, attackBonus: 5 },
    { abilitySlug: "dire-wolf-bite", name: "Dire Wolf Bite", damageType: "piercing", count: 2, sides: 6, modifier: 3 },
    [
      packTactics,
      trait("dire-wolf-keen-hearing-and-smell", "Keen Hearing and Smell", "Keen Hearing and Smell grants advantage on Wisdom (Perception) checks that rely on hearing or smell; metadata only."),
    ],
  );

  monster(
    { slug: "dryad", name: "Dryad", cr: 1, crTag: "cr-1", maxHp: 22, defense: 11, speed: 30, attackBonus: 2 },
    { abilitySlug: "dryad-club", name: "Dryad Club", damageType: "bludgeoning", count: 1, sides: 4, modifier: 0 },
    [
      magicResistance,
      trait("dryad-fey-ancestry", "Fey Ancestry", "Fey Ancestry grants advantage against being charmed and immunity to magical sleep; metadata only."),
      trait("dryad-innate-spellcasting", "Innate Spellcasting", "Innate Spellcasting (druidcraft, guidance, produce flame, and others) is metadata only; spell selection is not executable in this pack."),
    ],
  );

  monster(
    { slug: "duergar", name: "Duergar", cr: 1, crTag: "cr-1", maxHp: 26, defense: 16, speed: 25, attackBonus: 4 },
    { abilitySlug: "duergar-war-pick", name: "Duergar War Pick", damageType: "piercing", count: 1, sides: 8, modifier: 2 },
    [
      trait("duergar-resilience", "Duergar Resilience", "Duergar Resilience grants advantage on saving throws against poison, illusions, and charm or paralysis; metadata only."),
      sunlightSensitivity,
      trait("duergar-enlarge", "Enlarge", "Enlarge is a one-minute size and damage-die change; size change is not executable in this pack."),
      trait("duergar-invisibility", "Invisibility", "Invisibility is bounded metadata; the runtime does not model hidden states."),
    ],
  );

  monster(
    { slug: "ghoul", name: "Ghoul", cr: 1, crTag: "cr-1", maxHp: 22, defense: 12, speed: 30, attackBonus: 2 },
    { abilitySlug: "ghoul-bite", name: "Ghoul Bite", damageType: "piercing", count: 2, sides: 6, modifier: 2 },
    [trait("ghoul-paralysis", "Paralysis", "Paralysis: the claws force a DC 10 Constitution save or paralyze the target; saving-throw riders are not executable in this pack.")],
  );

  monster(
    { slug: "giant-eagle", name: "Giant Eagle", cr: 1, crTag: "cr-1", maxHp: 26, defense: 13, speed: 10, attackBonus: 5 },
    { abilitySlug: "giant-eagle-beak", name: "Giant Eagle Beak", damageType: "piercing", count: 1, sides: 6, modifier: 3 },
    [
      multiattack,
      trait("giant-eagle-keen-sight", "Keen Sight", "Keen Sight grants advantage on Wisdom (Perception) checks that rely on sight; metadata only."),
    ],
  );

  monster(
    { slug: "giant-hyena", name: "Giant Hyena", cr: 1, crTag: "cr-1", maxHp: 45, defense: 12, speed: 50, attackBonus: 5 },
    { abilitySlug: "giant-hyena-bite", name: "Giant Hyena Bite", damageType: "piercing", count: 2, sides: 6, modifier: 3 },
    [trait("giant-hyena-rampage", "Rampage", "Rampage: after reducing a creature to 0 hit points, the hyena can move and make a bite attack as a bonus action; metadata only.")],
  );

  monster(
    { slug: "giant-octopus", name: "Giant Octopus", cr: 1, crTag: "cr-1", maxHp: 52, defense: 11, speed: 10, attackBonus: 5 },
    { abilitySlug: "giant-octopus-tentacles", name: "Giant Octopus Tentacles", damageType: "bludgeoning", count: 2, sides: 6, modifier: 3 },
    [
      trait("giant-octopus-hold-breath", "Hold Breath", "Hold Breath: the octopus can hold its breath for 1 hour out of water; metadata only."),
      trait("giant-octopus-underwater-camouflage", "Underwater Camouflage", "Underwater Camouflage grants advantage on Dexterity (Stealth) checks while underwater; metadata only."),
    ],
  );

  monster(
    { slug: "giant-spider", name: "Giant Spider", cr: 1, crTag: "cr-1", maxHp: 26, defense: 14, speed: 30, attackBonus: 5 },
    { abilitySlug: "giant-spider-bite", name: "Giant Spider Bite", damageType: "piercing", count: 1, sides: 8, modifier: 3 },
    [
      trait("giant-spider-spider-climb", "Spider Climb", "Spider Climb: the spider can climb difficult surfaces and ceilings; climbing is not modeled, so this is metadata only."),
      trait("giant-spider-web-sense", "Web Sense", "Web Sense: the spider knows the location of any creature in contact with the same web; metadata only."),
      trait("giant-spider-web-walker", "Web Walker", "Web Walker: the spider ignores movement restrictions caused by webbing; metadata only."),
    ],
  );

  monster(
    { slug: "giant-toad", name: "Giant Toad", cr: 1, crTag: "cr-1", maxHp: 39, defense: 11, speed: 20, attackBonus: 4 },
    { abilitySlug: "giant-toad-bite", name: "Giant Toad Bite", damageType: "piercing", count: 1, sides: 10, modifier: 2 },
    [
      trait("giant-toad-amphibious", "Amphibious", "Amphibious: the toad can breathe air and water; metadata only."),
      trait("giant-toad-swallow", "Swallow", "Swallow: the toad can swallow a grappled Medium or smaller target; swallowing is not executable in this pack."),
    ],
  );

  monster(
    { slug: "giant-vulture", name: "Giant Vulture", cr: 1, crTag: "cr-1", maxHp: 22, defense: 10, speed: 10, attackBonus: 4 },
    { abilitySlug: "giant-vulture-beak", name: "Giant Vulture Beak", damageType: "piercing", count: 2, sides: 4, modifier: 2 },
    [
      multiattack,
      packTactics,
      trait("giant-vulture-keen-sight-and-smell", "Keen Sight and Smell", "Keen Sight and Smell grants advantage on Wisdom (Perception) checks that rely on sight or smell; metadata only."),
    ],
  );

  monster(
    { slug: "harpy", name: "Harpy", cr: 1, crTag: "cr-1", maxHp: 38, defense: 11, speed: 20, attackBonus: 3 },
    { abilitySlug: "harpy-claws", name: "Harpy Claws", damageType: "slashing", count: 2, sides: 4, modifier: 1 },
    [
      multiattack,
      trait("harpy-luring-song", "Luring Song", "Luring Song charms listeners who fail a DC 11 Wisdom save; the charm is not executable in this pack."),
    ],
  );

  monster(
    { slug: "hippogriff", name: "Hippogriff", cr: 1, crTag: "cr-1", maxHp: 19, defense: 11, speed: 40, attackBonus: 5 },
    { abilitySlug: "hippogriff-beak", name: "Hippogriff Beak", damageType: "piercing", count: 1, sides: 10, modifier: 3 },
    [
      multiattack,
      trait("hippogriff-keen-sight", "Keen Sight", "Keen Sight grants advantage on Wisdom (Perception) checks that rely on sight; metadata only."),
    ],
  );

  monster(
    { slug: "imp", name: "Imp", cr: 1, crTag: "cr-1", maxHp: 10, defense: 13, speed: 20, attackBonus: 5, resistances: ["cold", "physical"], immunities: ["fire"] },
    { abilitySlug: "imp-sting", name: "Imp Sting", damageType: "piercing", count: 1, sides: 4, modifier: 3 },
    [
      shapechanger,
      trait("imp-devils-sight", "Devil's Sight", "Devil's Sight: magical darkness does not impede the imp's darkvision; metadata only."),
      magicResistance,
    ],
  );

  monster(
    { slug: "lion", name: "Lion", cr: 1, crTag: "cr-1", maxHp: 26, defense: 12, speed: 50, attackBonus: 5 },
    { abilitySlug: "lion-bite", name: "Lion Bite", damageType: "piercing", count: 1, sides: 8, modifier: 3 },
    [
      multiattack,
      keenSmell,
      packTactics,
      trait("lion-pounce", "Pounce", "Pounce: if the lion moves 20 feet toward a target and hits with a claw, the target may be knocked prone and the lion can make a bite attack; metadata only."),
      trait("lion-running-leap", "Running Leap", "Running Leap: with a 10-foot running start, the lion can long jump up to 25 feet; movement is not modeled."),
    ],
  );

  monster(
    { slug: "quasit", name: "Quasit", cr: 1, crTag: "cr-1", maxHp: 7, defense: 13, speed: 40, attackBonus: 4, resistances: ["cold", "fire", "storm", "physical"] },
    { abilitySlug: "quasit-claw", name: "Quasit Claw", damageType: "piercing", count: 1, sides: 4, modifier: 3 },
    [shapechanger, magicResistance],
  );

  monster(
    { slug: "specter", name: "Specter", cr: 1, crTag: "cr-1", maxHp: 22, defense: 12, speed: 50, attackBonus: 4, resistances: ["cold", "fire", "storm", "physical"] },
    { abilitySlug: "specter-life-drain", name: "Specter Life Drain", damageType: "shadow", count: 3, sides: 6, modifier: 0 },
    [
      trait("specter-incorporeal-movement", "Incorporeal Movement", "Incorporeal Movement: the specter can move through creatures and objects as difficult terrain; movement is not modeled."),
      sunlightSensitivity,
    ],
  );

  monster(
    { slug: "spy", name: "Spy", cr: 1, crTag: "cr-1", maxHp: 27, defense: 12, speed: 30, attackBonus: 4 },
    { abilitySlug: "spy-shortsword", name: "Spy Shortsword", damageType: "piercing", count: 1, sides: 6, modifier: 2 },
    [
      multiattack,
      trait("spy-cunning-action", "Cunning Action", "Cunning Action: Dash, Disengage, or Hide as a bonus action; movement and hiding are not modeled."),
      trait("spy-sneak-attack", "Sneak Attack", "Sneak Attack: an extra 2d6 damage once per turn under the SRD condition; the conditional rider is metadata only."),
    ],
  );

  monster(
    { slug: "swarm-of-quippers", name: "Swarm of Quippers", cr: 1, crTag: "cr-1", maxHp: 28, defense: 13, speed: 40, attackBonus: 5, resistances: ["physical"] },
    { abilitySlug: "swarm-of-quippers-bites", name: "Swarm of Quippers Bites", damageType: "piercing", count: 4, sides: 6, modifier: 0 },
    [
      trait("swarm-of-quippers-blood-frenzy", "Blood Frenzy", "Blood Frenzy: advantage on melee attacks against a creature missing hit points; metadata only."),
      trait("swarm-of-quippers-swarm", "Swarm", "Swarm: the swarm can occupy another creature's space and cannot regain hit points; metadata only."),
      trait("swarm-of-quippers-water-breathing", "Water Breathing", "Water Breathing: the swarm can breathe only underwater; metadata only."),
    ],
  );

  monster(
    { slug: "tiger", name: "Tiger", cr: 1, crTag: "cr-1", maxHp: 37, defense: 12, speed: 40, attackBonus: 5 },
    { abilitySlug: "tiger-bite", name: "Tiger Bite", damageType: "piercing", count: 1, sides: 10, modifier: 3 },
    [
      multiattack,
      keenSmell,
      trait("tiger-pounce", "Pounce", "Pounce: if the tiger moves 20 feet toward a target and hits with a claw, the target may be knocked prone and the tiger can make a bite attack; metadata only."),
    ],
  );

  return { abilities, enemies };
}
