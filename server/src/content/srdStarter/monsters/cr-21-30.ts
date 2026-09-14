import type { StarterReferences } from "../references.js";
import {
  monsterAttack,
  monsterTemplate,
  monsterTrait,
  type MonsterAttackSpec,
  type MonsterTemplateSpec,
} from "./enemyBuilder.js";

type Cr21To30Trait = { slug: string; name: string; description: string };

type Cr21To30Monster = {
  attack: MonsterAttackSpec;
  traits?: readonly Cr21To30Trait[];
  template: Omit<MonsterTemplateSpec, "primaryAttack" | "traitRefs">;
};

function defineMonster(refs: StarterReferences, monster: Cr21To30Monster) {
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
 * The complete SRD 5.1 set of monsters whose challenge rating is 21 through 30:
 * the ten ancient metallic and chromatic dragons, the lich, the solar, the
 * kraken, and the tarrasque. Each profile keeps one executable basic attack;
 * legendary actions, spellcasting, breath weapons, and other signature traits
 * are carried as bounded metadata (tagged `unsupported-runtime`) because this
 * pack does not model positioning, saving throws, or per-turn attack sequences.
 * Lightning is mapped to the pack's `storm` damage type; acid, poison, and
 * necrotic riders are omitted because the pack's damage vocabulary excludes
 * those types.
 */
export function cr21To30Band(refs: StarterReferences) {
  const monsters = [
    defineMonster(refs, {
      attack: { abilitySlug: "ancient-black-dragon-bite", name: "Ancient Black Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 8 },
      traits: [
        { slug: "ancient-black-dragon-multiattack", name: "Multiattack", description: "The dragon can use its Frightful Presence and then makes three attacks: one with its bite and two with its claws. Only the single pinned bite is executable." },
        { slug: "ancient-black-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet that are aware of the dragon must succeed on a DC 19 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "ancient-black-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead, three times per day. Not executable at runtime." },
        { slug: "ancient-black-dragon-acid-breath", name: "Acid Breath (Recharge 5-6)", description: "The dragon exhales acid in a 90-foot line; creatures must make a DC 22 Dexterity save, taking 15d8 acid damage on a failure. The area, save, and acid type are metadata only." },
        { slug: "ancient-black-dragon-legendary-actions", name: "Legendary Actions", description: "The dragon can take legendary actions (Detect, Tail Attack, Wing Attack) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "ancient-black-dragon", name: "Ancient Black Dragon", cr: 21, crTag: "cr-21", maxHp: 367, defense: 22, speed: 40, attackBonus: 15 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "ancient-copper-dragon-bite", name: "Ancient Copper Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 8 },
      traits: [
        { slug: "ancient-copper-dragon-multiattack", name: "Multiattack", description: "The dragon can use its Frightful Presence and then makes three attacks: one with its bite and two with its claws. Only the single pinned bite is executable." },
        { slug: "ancient-copper-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet that are aware of the dragon must succeed on a DC 19 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "ancient-copper-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead, three times per day. Not executable at runtime." },
        { slug: "ancient-copper-dragon-breath-weapons", name: "Breath Weapons (Recharge 5-6)", description: "The dragon uses an acid line (DC 22 Dexterity) or a slowing gas cone (DC 22 Constitution). The areas, saves, and acid type are metadata only." },
        { slug: "ancient-copper-dragon-change-shape", name: "Change Shape", description: "The dragon magically polymorphs into a humanoid or beast of no higher challenge rating, or back into its true form. The transformation is metadata only." },
        { slug: "ancient-copper-dragon-legendary-actions", name: "Legendary Actions", description: "The dragon can take legendary actions (Detect, Tail Attack, Wing Attack) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "ancient-copper-dragon", name: "Ancient Copper Dragon", cr: 21, crTag: "cr-21", maxHp: 350, defense: 21, speed: 40, attackBonus: 15 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "lich-paralyzing-touch", name: "Lich Paralyzing Touch", damageType: "cold", count: 3, sides: 6, modifier: 0 },
      traits: [
        { slug: "lich-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the lich fails a saving throw, it can choose to succeed instead, three times per day. Not executable at runtime." },
        { slug: "lich-rejuvenation", name: "Rejuvenation", description: "If the lich is destroyed, it gains a new body in 1d10 days unless its phylactery is destroyed. The rebirth is metadata only." },
        { slug: "lich-spellcasting", name: "Spellcasting", description: "The lich is an 18th-level spellcaster with Intelligence-based spells and save DC 20. Spellcasting is not executable in this pack." },
        { slug: "lich-turn-resistance", name: "Turn Resistance", description: "The lich has advantage on saving throws against any effect that turns undead. The advantage is metadata only." },
        { slug: "lich-paralyzing-touch-rider", name: "Paralyzing Touch", description: "A creature hit by the touch must succeed on a DC 18 Constitution save or be paralyzed for 1 minute. The save and condition are metadata only." },
        { slug: "lich-legendary-actions", name: "Legendary Actions", description: "The lich can take legendary actions (Cantrip, Paralyzing Touch, Frightening Gaze, Disrupt Life) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "lich", name: "Lich", cr: 21, crTag: "cr-21", maxHp: 135, defense: 17, speed: 30, attackBonus: 12, resistances: ["cold", "storm", "bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "solar-greatsword", name: "Solar Greatsword", damageType: "slashing", count: 4, sides: 6, modifier: 8 },
      traits: [
        { slug: "solar-angelic-weapons", name: "Angelic Weapons", description: "The solar's weapon attacks are magical and deal an extra 6d8 radiant damage on a hit. The extra radiant damage is metadata only." },
        { slug: "solar-divine-awareness", name: "Divine Awareness", description: "The solar knows if it hears a lie. Not executable at runtime." },
        { slug: "solar-innate-spellcasting", name: "Innate Spellcasting", description: "The solar's innate spells (detect evil and good, invisibility, commune, and others) use Charisma with save DC 23. Spellcasting is not executable in this pack." },
        { slug: "solar-magic-resistance", name: "Magic Resistance", description: "The solar has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "solar-legendary-actions", name: "Legendary Actions", description: "The solar can take legendary actions (Teleport, Searing Burst, Blinding Gaze) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "solar", name: "Solar", cr: 21, crTag: "cr-21", maxHp: 243, defense: 21, speed: 50, attackBonus: 15, resistances: ["radiant", "bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "ancient-bronze-dragon-bite", name: "Ancient Bronze Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 9 },
      traits: [
        { slug: "ancient-bronze-dragon-amphibious", name: "Amphibious", description: "The dragon can breathe air and water. Not executable at runtime." },
        { slug: "ancient-bronze-dragon-multiattack", name: "Multiattack", description: "The dragon can use its Frightful Presence and then makes three attacks: one with its bite and two with its claws. Only the single pinned bite is executable." },
        { slug: "ancient-bronze-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet that are aware of the dragon must succeed on a DC 20 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "ancient-bronze-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead, three times per day. Not executable at runtime." },
        { slug: "ancient-bronze-dragon-breath-weapons", name: "Breath Weapons (Recharge 5-6)", description: "The dragon uses a lightning line (DC 23 Dexterity, 16d10) or a repulsion cone (DC 23 Strength). The areas, saves, and lightning type are metadata only." },
        { slug: "ancient-bronze-dragon-change-shape", name: "Change Shape", description: "The dragon magically polymorphs into a humanoid or beast of no higher challenge rating, or back into its true form. The transformation is metadata only." },
        { slug: "ancient-bronze-dragon-legendary-actions", name: "Legendary Actions", description: "The dragon can take legendary actions (Detect, Tail Attack, Wing Attack) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "ancient-bronze-dragon", name: "Ancient Bronze Dragon", cr: 22, crTag: "cr-22", maxHp: 444, defense: 22, speed: 40, attackBonus: 16, immunities: ["storm"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "ancient-green-dragon-bite", name: "Ancient Green Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 8 },
      traits: [
        { slug: "ancient-green-dragon-amphibious", name: "Amphibious", description: "The dragon can breathe air and water. Not executable at runtime." },
        { slug: "ancient-green-dragon-multiattack", name: "Multiattack", description: "The dragon can use its Frightful Presence and then makes three attacks: one with its bite and two with its claws. Only the single pinned bite is executable." },
        { slug: "ancient-green-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet that are aware of the dragon must succeed on a DC 19 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "ancient-green-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead, three times per day. Not executable at runtime." },
        { slug: "ancient-green-dragon-poison-breath", name: "Poison Breath (Recharge 5-6)", description: "The dragon exhales poisonous gas in a 90-foot cone; creatures must make a DC 22 Constitution save, taking 22d6 poison damage on a failure. The area, save, and poison type are metadata only." },
        { slug: "ancient-green-dragon-legendary-actions", name: "Legendary Actions", description: "The dragon can take legendary actions (Detect, Tail Attack, Wing Attack) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "ancient-green-dragon", name: "Ancient Green Dragon", cr: 22, crTag: "cr-22", maxHp: 385, defense: 21, speed: 40, attackBonus: 15 },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "ancient-blue-dragon-bite", name: "Ancient Blue Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 9 },
      traits: [
        { slug: "ancient-blue-dragon-multiattack", name: "Multiattack", description: "The dragon can use its Frightful Presence and then makes three attacks: one with its bite and two with its claws. Only the single pinned bite is executable." },
        { slug: "ancient-blue-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet that are aware of the dragon must succeed on a DC 20 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "ancient-blue-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead, three times per day. Not executable at runtime." },
        { slug: "ancient-blue-dragon-lightning-breath", name: "Lightning Breath (Recharge 5-6)", description: "The dragon exhales lightning in a 120-foot line; creatures must make a DC 23 Dexterity save, taking 16d10 lightning (storm) damage on a failure. The area, save, and lightning type are metadata only." },
        { slug: "ancient-blue-dragon-legendary-actions", name: "Legendary Actions", description: "The dragon can take legendary actions (Detect, Tail Attack, Wing Attack) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "ancient-blue-dragon", name: "Ancient Blue Dragon", cr: 23, crTag: "cr-23", maxHp: 481, defense: 22, speed: 40, attackBonus: 16, immunities: ["storm"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "ancient-silver-dragon-bite", name: "Ancient Silver Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 10 },
      traits: [
        { slug: "ancient-silver-dragon-multiattack", name: "Multiattack", description: "The dragon can use its Frightful Presence and then makes three attacks: one with its bite and two with its claws. Only the single pinned bite is executable." },
        { slug: "ancient-silver-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet that are aware of the dragon must succeed on a DC 21 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "ancient-silver-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead, three times per day. Not executable at runtime." },
        { slug: "ancient-silver-dragon-breath-weapons", name: "Breath Weapons (Recharge 5-6)", description: "The dragon uses a cold cone (DC 24 Constitution, 15d8) or a paralyzing gas cone (DC 24 Constitution). The areas, saves, and paralysis are metadata only." },
        { slug: "ancient-silver-dragon-change-shape", name: "Change Shape", description: "The dragon magically polymorphs into a humanoid or beast of no higher challenge rating, or back into its true form. The transformation is metadata only." },
        { slug: "ancient-silver-dragon-legendary-actions", name: "Legendary Actions", description: "The dragon can take legendary actions (Detect, Tail Attack, Wing Attack) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "ancient-silver-dragon", name: "Ancient Silver Dragon", cr: 23, crTag: "cr-23", maxHp: 487, defense: 22, speed: 40, attackBonus: 17, immunities: ["cold"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "kraken-tentacle", name: "Kraken Tentacle", damageType: "bludgeoning", count: 3, sides: 6, modifier: 10 },
      traits: [
        { slug: "kraken-amphibious", name: "Amphibious", description: "The kraken can breathe air and water. Not executable at runtime." },
        { slug: "kraken-freedom-of-movement", name: "Freedom of Movement", description: "The kraken ignores difficult terrain and magical effects that impede movement or restrain it. Movement is not modeled." },
        { slug: "kraken-siege-monster", name: "Siege Monster", description: "The kraken deals double damage to objects and structures. Object damage is not modeled." },
        { slug: "kraken-grapple", name: "Grapple and Restrain", description: "A creature hit by a tentacle is grappled (escape DC 18) and restrained until the grapple ends. The grapple and condition are metadata only." },
        { slug: "kraken-lightning-storm", name: "Lightning Storm", description: "The kraken magically creates three lightning bolts; targets must make a DC 23 Dexterity save, taking 4d10 lightning (storm) damage on a failure. The save and lightning type are metadata only." },
        { slug: "kraken-legendary-actions", name: "Legendary Actions", description: "The kraken can take legendary actions (Tentacle Attack or Fling, Lightning Storm, Ink Cloud) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "kraken", name: "Kraken", cr: 23, crTag: "cr-23", maxHp: 472, defense: 18, speed: 20, attackBonus: 7, immunities: ["storm", "bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "ancient-gold-dragon-bite", name: "Ancient Gold Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 10 },
      traits: [
        { slug: "ancient-gold-dragon-amphibious", name: "Amphibious", description: "The dragon can breathe air and water. Not executable at runtime." },
        { slug: "ancient-gold-dragon-multiattack", name: "Multiattack", description: "The dragon can use its Frightful Presence and then makes three attacks: one with its bite and two with its claws. Only the single pinned bite is executable." },
        { slug: "ancient-gold-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet that are aware of the dragon must succeed on a DC 24 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "ancient-gold-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead, three times per day. Not executable at runtime." },
        { slug: "ancient-gold-dragon-breath-weapons", name: "Breath Weapons (Recharge 5-6)", description: "The dragon uses a fire cone (DC 24 Dexterity, 13d10) or a weakening gas cone (DC 24 Strength). The areas and saves are metadata only." },
        { slug: "ancient-gold-dragon-change-shape", name: "Change Shape", description: "The dragon magically polymorphs into a humanoid or beast of no higher challenge rating, or back into its true form. The transformation is metadata only." },
        { slug: "ancient-gold-dragon-legendary-actions", name: "Legendary Actions", description: "The dragon can take legendary actions (Detect, Tail Attack, Wing Attack) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "ancient-gold-dragon", name: "Ancient Gold Dragon", cr: 24, crTag: "cr-24", maxHp: 546, defense: 22, speed: 40, attackBonus: 17, immunities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "ancient-red-dragon-bite", name: "Ancient Red Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 10 },
      traits: [
        { slug: "ancient-red-dragon-multiattack", name: "Multiattack", description: "The dragon can use its Frightful Presence and then makes three attacks: one with its bite and two with its claws. Only the single pinned bite is executable." },
        { slug: "ancient-red-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet that are aware of the dragon must succeed on a DC 21 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "ancient-red-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead, three times per day. Not executable at runtime." },
        { slug: "ancient-red-dragon-fire-breath", name: "Fire Breath (Recharge 5-6)", description: "The dragon exhales fire in a 90-foot cone; creatures must make a DC 24 Dexterity save, taking 26d6 fire damage on a failure. The area and save are metadata only." },
        { slug: "ancient-red-dragon-legendary-actions", name: "Legendary Actions", description: "The dragon can take legendary actions (Detect, Tail Attack, Wing Attack) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "ancient-red-dragon", name: "Ancient Red Dragon", cr: 24, crTag: "cr-24", maxHp: 546, defense: 22, speed: 40, attackBonus: 17, immunities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "tarrasque-bite", name: "Tarrasque Bite", damageType: "piercing", count: 4, sides: 12, modifier: 10 },
      traits: [
        { slug: "tarrasque-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the tarrasque fails a saving throw, it can choose to succeed instead, three times per day. Not executable at runtime." },
        { slug: "tarrasque-magic-resistance", name: "Magic Resistance", description: "The tarrasque has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "tarrasque-reflective-carapace", name: "Reflective Carapace", description: "The tarrasque can reflect certain magic missile, line, and ray effects back at the caster. The reflection is metadata only." },
        { slug: "tarrasque-siege-monster", name: "Siege Monster", description: "The tarrasque deals double damage to objects and structures. Object damage is not modeled." },
        { slug: "tarrasque-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet that are aware of the tarrasque must succeed on a DC 17 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "tarrasque-multiattack", name: "Multiattack", description: "The tarrasque can use its Frightful Presence and then makes five attacks (bite, two claws, horns, tail); only the single pinned bite is executable." },
        { slug: "tarrasque-swallow", name: "Swallow", description: "The tarrasque can swallow a Large or smaller creature it is grappling; the swallowed creature is blinded and restrained and takes acid damage each turn. The swallow, condition, and acid damage are metadata only." },
        { slug: "tarrasque-legendary-actions", name: "Legendary Actions", description: "The tarrasque can take legendary actions (Attack, Move, Chomp) at the end of another creature's turn. Legendary actions are metadata only." },
      ],
      template: { slug: "tarrasque", name: "Tarrasque", cr: 30, crTag: "cr-30", maxHp: 676, defense: 25, speed: 40, attackBonus: 19, immunities: ["fire", "bludgeoning", "piercing", "slashing"] },
    }),
  ];

  return {
    abilities: monsters.flatMap((monster) => monster.abilities),
    enemies: monsters.map((monster) => monster.enemy),
  };
}
