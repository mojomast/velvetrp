import type { StarterReferences } from "../references.js";
import {
  monsterAttack,
  monsterTemplate,
  monsterTrait,
  type MonsterAttackSpec,
  type MonsterTemplateSpec,
} from "./enemyBuilder.js";

type BandTrait = { slug: string; name: string; description: string };

type BandMonster = {
  attack: MonsterAttackSpec;
  traits?: readonly BandTrait[];
  template: Omit<MonsterTemplateSpec, "primaryAttack" | "traitRefs">;
};

/**
 * Local helper mirroring the other high-CR bands: one executable basic attack
 * plus bounded trait metadata, pinned to the monster's own CR tag. Unlike the
 * single-CR bands this builder keeps `cr`/`crTag` on the template because this
 * module spans challenge ratings 15 and 16.
 */
function defineMonster(refs: StarterReferences, monster: BandMonster) {
  const attack = monsterAttack(refs, monster.attack);
  const traits = (monster.traits ?? []).map((trait) => monsterTrait(refs, trait.slug, trait.name, trait.description));
  const enemy = monsterTemplate(refs, {
    ...monster.template,
    primaryAttack: attack.reference,
    traitRefs: traits.map((trait) => trait.reference),
  });
  return { abilities: [attack, ...traits], enemy };
}

/**
 * Every SRD 5.1 monster whose challenge rating is exactly 15 or 16. Each profile
 * keeps one executable basic attack; multiattack, breath weapons, legendary
 * actions, and signature traits are carried as bounded metadata (tagged
 * `unsupported-runtime`) because this pack does not model positioning, saving
 * throws, or per-turn attack sequences.
 */
export function cr15To16Band(refs: StarterReferences) {
  const monsters = [
    defineMonster(refs, {
      attack: { abilitySlug: "adult-bronze-dragon-bite", name: "Adult Bronze Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 7 },
      traits: [
        { slug: "adult-bronze-dragon-amphibious", name: "Amphibious", description: "Amphibious: the dragon can breathe air and water; breathing modes are metadata only." },
        { slug: "adult-bronze-dragon-legendary-resistance", name: "Legendary Resistance", description: "Legendary Resistance (3/day): the dragon can choose to succeed on a failed saving throw; saving throws are metadata only." },
        { slug: "adult-bronze-dragon-frightful-presence", name: "Frightful Presence", description: "Frightful Presence: creatures within 120 feet that fail a DC 17 Wisdom save are frightened for 1 minute; the save and condition are metadata only." },
        { slug: "adult-bronze-dragon-multiattack", name: "Multiattack", description: "Multiattack: the dragon uses Frightful Presence and then makes one bite and two claw attacks; only the pinned bite is executable." },
        { slug: "adult-bronze-dragon-breath-weapons", name: "Breath Weapons", description: "Breath Weapons (recharge 5-6): a 90-foot lightning line (DC 19 Dexterity save) or a 30-foot repulsion cone (DC 19 Strength save); area breath weapons are metadata only." },
        { slug: "adult-bronze-dragon-wing-attack", name: "Wing Attack", description: "Wing Attack (legendary action, costs 2): nearby creatures must make a DC 20 Dexterity save or take bludgeoning damage and fall prone; legendary actions are metadata only." },
      ],
      template: { slug: "adult-bronze-dragon", name: "Adult Bronze Dragon", cr: 15, crTag: "cr-15", maxHp: 212, defense: 19, speed: 40, attackBonus: 12, immunities: ["storm"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "adult-green-dragon-bite", name: "Adult Green Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 6 },
      traits: [
        { slug: "adult-green-dragon-amphibious", name: "Amphibious", description: "Amphibious: the dragon can breathe air and water; breathing modes are metadata only." },
        { slug: "adult-green-dragon-legendary-resistance", name: "Legendary Resistance", description: "Legendary Resistance (3/day): the dragon can choose to succeed on a failed saving throw; saving throws are metadata only." },
        { slug: "adult-green-dragon-frightful-presence", name: "Frightful Presence", description: "Frightful Presence: creatures within 120 feet that fail a DC 16 Wisdom save are frightened for 1 minute; the save and condition are metadata only." },
        { slug: "adult-green-dragon-multiattack", name: "Multiattack", description: "Multiattack: the dragon uses Frightful Presence and then makes one bite and two claw attacks; only the pinned bite is executable." },
        { slug: "adult-green-dragon-poison-breath", name: "Poison Breath", description: "Poison Breath (recharge 5-6): a 60-foot cone forces a DC 18 Constitution save for 56 (16d6) poison damage; the area breath and poison damage are metadata only." },
        { slug: "adult-green-dragon-wing-attack", name: "Wing Attack", description: "Wing Attack (legendary action, costs 2): nearby creatures must make a DC 19 Dexterity save or take bludgeoning damage and fall prone; legendary actions are metadata only." },
      ],
      template: { slug: "adult-green-dragon", name: "Adult Green Dragon", cr: 15, crTag: "cr-15", maxHp: 207, defense: 19, speed: 40, attackBonus: 11 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "mummy-lord-rotting-fist", name: "Mummy Lord Rotting Fist", damageType: "bludgeoning", count: 3, sides: 6, modifier: 4 },
      traits: [
        { slug: "mummy-lord-magic-resistance", name: "Magic Resistance", description: "Magic Resistance: the mummy lord has advantage on saving throws against spells and other magical effects; the advantage is metadata only." },
        { slug: "mummy-lord-rejuvenation", name: "Rejuvenation", description: "Rejuvenation: a destroyed mummy lord gains a new body in 24 hours if its heart is intact; revival is metadata only." },
        { slug: "mummy-lord-spellcasting", name: "Spellcasting", description: "Spellcasting: the mummy lord is a 10th-level cleric spellcaster (spell save DC 17); prepared spells are not executable in this pack." },
        { slug: "mummy-lord-multiattack", name: "Multiattack", description: "Multiattack: the mummy lord uses Dreadful Glare and makes one rotting fist attack; only the pinned fist is executable." },
        { slug: "mummy-lord-dreadful-glare", name: "Dreadful Glare", description: "Dreadful Glare: one visible creature must make a DC 16 Wisdom save or be frightened, and by 5 or more also paralyzed; the save and conditions are metadata only." },
        { slug: "mummy-lord-legendary-actions", name: "Legendary Actions", description: "Legendary Actions: the mummy lord can make a rotting fist attack, use Blinding Dust, or spend two actions on Blasphemous Word, Channel Negative Energy, or Whirlwind of Sand; legendary actions are metadata only." },
      ],
      template: { slug: "mummy-lord", name: "Mummy Lord", cr: 15, crTag: "cr-15", maxHp: 97, defense: 17, speed: 20, attackBonus: 9, resistances: ["bludgeoning", "piercing", "slashing"], vulnerabilities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "purple-worm-bite", name: "Purple Worm Bite", damageType: "piercing", count: 3, sides: 8, modifier: 9 },
      traits: [
        { slug: "purple-worm-tunneler", name: "Tunneler", description: "Tunneler: the worm can burrow through solid rock at half its burrow speed, leaving a 10-foot-diameter tunnel; terrain is not modeled." },
        { slug: "purple-worm-multiattack", name: "Multiattack", description: "Multiattack: the worm makes one bite and one tail stinger attack; only the pinned bite is executable." },
        { slug: "purple-worm-swallow", name: "Swallow", description: "Swallow: a Large or smaller target that fails a DC 19 Dexterity save is swallowed, blinded, and restrained, taking 21 (6d6) acid damage each turn; the save and condition are metadata only." },
        { slug: "purple-worm-tail-stinger", name: "Tail Stinger", description: "Tail Stinger: the worm strikes for 19 (3d6 + 9) piercing damage and a DC 19 Constitution save against 42 (12d6) poison damage; the poison rider is metadata only." },
      ],
      template: { slug: "purple-worm", name: "Purple Worm", cr: 15, crTag: "cr-15", maxHp: 247, defense: 18, speed: 50, attackBonus: 9 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "adult-blue-dragon-bite", name: "Adult Blue Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 7 },
      traits: [
        { slug: "adult-blue-dragon-legendary-resistance", name: "Legendary Resistance", description: "Legendary Resistance (3/day): the dragon can choose to succeed on a failed saving throw; saving throws are metadata only." },
        { slug: "adult-blue-dragon-frightful-presence", name: "Frightful Presence", description: "Frightful Presence: creatures within 120 feet that fail a DC 17 Wisdom save are frightened for 1 minute; the save and condition are metadata only." },
        { slug: "adult-blue-dragon-multiattack", name: "Multiattack", description: "Multiattack: the dragon uses Frightful Presence and then makes one bite and two claw attacks; only the pinned bite is executable." },
        { slug: "adult-blue-dragon-lightning-breath", name: "Lightning Breath", description: "Lightning Breath (recharge 5-6): a 90-foot line forces a DC 19 Dexterity save for 66 (12d10) lightning damage; the area breath is metadata only." },
        { slug: "adult-blue-dragon-wing-attack", name: "Wing Attack", description: "Wing Attack (legendary action, costs 2): nearby creatures must make a DC 20 Dexterity save or take bludgeoning damage and fall prone; legendary actions are metadata only." },
      ],
      template: { slug: "adult-blue-dragon", name: "Adult Blue Dragon", cr: 16, crTag: "cr-16", maxHp: 225, defense: 19, speed: 40, attackBonus: 12, immunities: ["storm"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "adult-silver-dragon-bite", name: "Adult Silver Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 8 },
      traits: [
        { slug: "adult-silver-dragon-legendary-resistance", name: "Legendary Resistance", description: "Legendary Resistance (3/day): the dragon can choose to succeed on a failed saving throw; saving throws are metadata only." },
        { slug: "adult-silver-dragon-frightful-presence", name: "Frightful Presence", description: "Frightful Presence: creatures within 120 feet that fail a DC 18 Wisdom save are frightened for 1 minute; the save and condition are metadata only." },
        { slug: "adult-silver-dragon-multiattack", name: "Multiattack", description: "Multiattack: the dragon uses Frightful Presence and then makes one bite and two claw attacks; only the pinned bite is executable." },
        { slug: "adult-silver-dragon-breath-weapons", name: "Breath Weapons", description: "Breath Weapons (recharge 5-6): a 60-foot cone forces a DC 20 Constitution save for 58 (13d8) cold damage, or a paralyzing cone with the same save; area breath weapons are metadata only." },
        { slug: "adult-silver-dragon-wing-attack", name: "Wing Attack", description: "Wing Attack (legendary action, costs 2): nearby creatures must make a DC 22 Dexterity save or take bludgeoning damage and fall prone; legendary actions are metadata only." },
      ],
      template: { slug: "adult-silver-dragon", name: "Adult Silver Dragon", cr: 16, crTag: "cr-16", maxHp: 243, defense: 19, speed: 40, attackBonus: 13, immunities: ["cold"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "iron-golem-slam", name: "Iron Golem Slam", damageType: "bludgeoning", count: 3, sides: 8, modifier: 7 },
      traits: [
        { slug: "iron-golem-fire-absorption", name: "Fire Absorption", description: "Fire Absorption: the golem takes no fire damage and instead regains hit points equal to the fire damage dealt; absorption is metadata only." },
        { slug: "iron-golem-immutable-form", name: "Immutable Form", description: "Immutable Form: the golem is immune to any spell or effect that would alter its form; not executable at runtime." },
        { slug: "iron-golem-magic-resistance", name: "Magic Resistance", description: "Magic Resistance: the golem has advantage on saving throws against spells and other magical effects; the advantage is metadata only." },
        { slug: "iron-golem-magic-weapons", name: "Magic Weapons", description: "Magic Weapons: the golem's weapon attacks are magical; magic weapon handling is metadata only." },
        { slug: "iron-golem-multiattack", name: "Multiattack", description: "Multiattack: the golem makes two melee attacks with its slam or sword; only the pinned slam is executable." },
        { slug: "iron-golem-poison-breath", name: "Poison Breath", description: "Poison Breath (recharge 5-6): a 15-foot cone forces a DC 19 Constitution save for 45 (10d8) poison damage; the area breath and poison damage are metadata only." },
      ],
      template: { slug: "iron-golem", name: "Iron Golem", cr: 16, crTag: "cr-16", maxHp: 210, defense: 20, speed: 30, attackBonus: 13, immunities: ["fire", "bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "marilith-longsword", name: "Marilith Longsword", damageType: "slashing", count: 2, sides: 8, modifier: 4 },
      traits: [
        { slug: "marilith-magic-resistance", name: "Magic Resistance", description: "Magic Resistance: the marilith has advantage on saving throws against spells and other magical effects; the advantage is metadata only." },
        { slug: "marilith-magic-weapons", name: "Magic Weapons", description: "Magic Weapons: the marilith's weapon attacks are magical; magic weapon handling is metadata only." },
        { slug: "marilith-reactive", name: "Reactive", description: "Reactive: the marilith can take one reaction on every turn in combat; reaction tracking is metadata only." },
        { slug: "marilith-multiattack", name: "Multiattack", description: "Multiattack: the marilith makes six longsword attacks and one tail attack; only the pinned longsword is executable." },
        { slug: "marilith-tail", name: "Tail", description: "Tail: the marilith deals 15 (2d10 + 4) bludgeoning damage and can grapple a Medium or smaller target (escape DC 19); the grapple rider is metadata only." },
        { slug: "marilith-parry", name: "Parry", description: "Parry: the marilith adds 5 to its AC against one melee attack as a reaction; the reaction is metadata only." },
      ],
      template: { slug: "marilith", name: "Marilith", cr: 16, crTag: "cr-16", maxHp: 189, defense: 18, speed: 40, attackBonus: 9, resistances: ["cold", "fire", "storm", "bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "planetar-greatsword", name: "Planetar Greatsword", damageType: "slashing", count: 4, sides: 6, modifier: 7 },
      traits: [
        { slug: "planetar-angelic-weapons", name: "Angelic Weapons", description: "Angelic Weapons: the planetar's weapon attacks are magical and deal an extra 22 (5d8) radiant damage on a hit; the extra radiant damage is metadata only." },
        { slug: "planetar-divine-awareness", name: "Divine Awareness", description: "Divine Awareness: the planetar knows if it hears a lie; not executable at runtime." },
        { slug: "planetar-innate-spellcasting", name: "Innate Spellcasting", description: "Innate Spellcasting: the planetar casts spells with Charisma (spell save DC 20); spell selection is not executable in this pack." },
        { slug: "planetar-magic-resistance", name: "Magic Resistance", description: "Magic Resistance: the planetar has advantage on saving throws against spells and other magical effects; the advantage is metadata only." },
        { slug: "planetar-multiattack", name: "Multiattack", description: "Multiattack: the planetar makes two greatsword attacks; only the single pinned greatsword is executable." },
        { slug: "planetar-healing-touch", name: "Healing Touch", description: "Healing Touch (4/day): the planetar restores 30 (6d8 + 3) hit points and frees the target from curses and conditions; healing is metadata only." },
      ],
      template: { slug: "planetar", name: "Planetar", cr: 16, crTag: "cr-16", maxHp: 200, defense: 19, speed: 40, attackBonus: 12, resistances: ["radiant", "bludgeoning", "piercing", "slashing"] },
    }),
  ];

  return {
    abilities: monsters.flatMap((monster) => monster.abilities),
    enemies: monsters.map((monster) => monster.enemy),
  };
}
