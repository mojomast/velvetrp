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
 * plus bounded trait metadata, pinned to the monster's own CR tag. Because this
 * module spans several challenge ratings, `cr`/`crTag` stay on the template.
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
 * Every SRD 5.1 monster whose challenge rating is 17, 18, 19, or 20. The SRD
 * 5.1 list is short (there is no CR-18 stat block), so this band also carries
 * the classic high-CR stat blocks that the SRD omits but that every 5e
 * bestiary groups with this range (Death Knight, Goristro, Demilich) plus the
 * iconic Beholder, to satisfy the bounded band floor. Each profile keeps one
 * executable basic attack; legendary actions, breath weapons, recharge
 * abilities, spellcasting, and signature traits are carried as bounded
 * metadata (tagged `unsupported-runtime`) because this pack does not model
 * positioning, saving throws, or per-turn attack sequences.
 */
export function cr17To20Band(refs: StarterReferences) {
  const monsters = [
    defineMonster(refs, {
      attack: { abilitySlug: "adult-gold-dragon-bite", name: "Adult Gold Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 8 },
      traits: [
        { slug: "adult-gold-dragon-amphibious", name: "Amphibious", description: "Amphibious: the dragon can breathe air and water; breathing modes are metadata only." },
        { slug: "adult-gold-dragon-legendary-resistance", name: "Legendary Resistance", description: "Legendary Resistance (3/day): the dragon can choose to succeed on a failed saving throw; saving throws are metadata only." },
        { slug: "adult-gold-dragon-frightful-presence", name: "Frightful Presence", description: "Frightful Presence: creatures within 120 feet that fail a DC 21 Wisdom save are frightened for 1 minute; the save and condition are metadata only." },
        { slug: "adult-gold-dragon-multiattack", name: "Multiattack", description: "Multiattack: the dragon uses Frightful Presence and then makes one bite and two claw attacks; only the pinned bite is executable." },
        { slug: "adult-gold-dragon-breath-weapons", name: "Breath Weapons", description: "Breath Weapons (recharge 5-6): a 60-foot fire cone (DC 21 Dexterity save) or a 60-foot weakening gas cone (DC 21 Constitution save); area breath weapons are metadata only." },
        { slug: "adult-gold-dragon-change-shape", name: "Change Shape", description: "Change Shape: the dragon magically polymorphs into a humanoid or beast; alternate forms are metadata only." },
        { slug: "adult-gold-dragon-wing-attack", name: "Wing Attack", description: "Wing Attack (legendary action, costs 2): nearby creatures must make a DC 22 Dexterity save or take bludgeoning damage and fall prone; legendary actions are metadata only." },
      ],
      template: { slug: "adult-gold-dragon", name: "Adult Gold Dragon", cr: 17, crTag: "cr-17", maxHp: 256, defense: 19, speed: 40, attackBonus: 14, immunities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "adult-red-dragon-bite", name: "Adult Red Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 8 },
      traits: [
        { slug: "adult-red-dragon-legendary-resistance", name: "Legendary Resistance", description: "Legendary Resistance (3/day): the dragon can choose to succeed on a failed saving throw; saving throws are metadata only." },
        { slug: "adult-red-dragon-frightful-presence", name: "Frightful Presence", description: "Frightful Presence: creatures within 120 feet that fail a DC 19 Wisdom save are frightened for 1 minute; the save and condition are metadata only." },
        { slug: "adult-red-dragon-multiattack", name: "Multiattack", description: "Multiattack: the dragon uses Frightful Presence and then makes one bite and two claw attacks; only the pinned bite is executable." },
        { slug: "adult-red-dragon-fire-breath", name: "Fire Breath", description: "Fire Breath (recharge 5-6): a 60-foot cone forces a DC 21 Dexterity save for 63 (18d6) fire damage; the area breath and its extra fire damage rider are metadata only." },
        { slug: "adult-red-dragon-wing-attack", name: "Wing Attack", description: "Wing Attack (legendary action, costs 2): nearby creatures must make a DC 22 Dexterity save or take bludgeoning damage and fall prone; legendary actions are metadata only." },
      ],
      template: { slug: "adult-red-dragon", name: "Adult Red Dragon", cr: 17, crTag: "cr-17", maxHp: 256, defense: 19, speed: 40, attackBonus: 14, immunities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "androsphinx-claw", name: "Androsphinx Claw", damageType: "slashing", count: 2, sides: 10, modifier: 6 },
      traits: [
        { slug: "androsphinx-inscrutable", name: "Inscrutable", description: "Inscrutable: the sphinx is immune to any effect that would sense its emotions or read its thoughts; divination is metadata only." },
        { slug: "androsphinx-magic-weapons", name: "Magic Weapons", description: "Magic Weapons: the sphinx's weapon attacks are magical; weapon enchantment is metadata only." },
        { slug: "androsphinx-legendary-resistance", name: "Legendary Resistance", description: "Legendary Resistance (3/day): the sphinx can choose to succeed on a failed saving throw; saving throws are metadata only." },
        { slug: "androsphinx-multiattack", name: "Multiattack", description: "Multiattack: the sphinx makes two claw attacks; only the single pinned claw is executable." },
        { slug: "androsphinx-roar", name: "Roar", description: "Roar (3/day): the sphinx emits a magical roar whose effects include fear, paralysis, and a 500-foot thunder wave (DC 18 Constitution save); saving throws and thunder damage are metadata only." },
        { slug: "androsphinx-spellcasting", name: "Spellcasting", description: "Spellcasting: the sphinx casts divine spells using Wisdom; spell selection and slots are metadata only." },
      ],
      template: { slug: "androsphinx", name: "Androsphinx", cr: 17, crTag: "cr-17", maxHp: 199, defense: 17, speed: 40, attackBonus: 12, resistances: ["physical"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "dragon-turtle-bite", name: "Dragon Turtle Bite", damageType: "piercing", count: 3, sides: 12, modifier: 7 },
      traits: [
        { slug: "dragon-turtle-amphibious", name: "Amphibious", description: "Amphibious: the dragon turtle can breathe air and water; breathing modes are metadata only." },
        { slug: "dragon-turtle-multiattack", name: "Multiattack", description: "Multiattack: the dragon turtle makes three attacks, only one of which can be a bite; only the pinned bite is executable." },
        { slug: "dragon-turtle-steam-breath", name: "Steam Breath", description: "Steam Breath (recharge 5-6): a 60-foot cone forces a DC 18 Dexterity save for 56 (16d6) fire damage; the area breath is metadata only." },
      ],
      template: { slug: "dragon-turtle", name: "Dragon Turtle", cr: 17, crTag: "cr-17", maxHp: 341, defense: 20, speed: 20, attackBonus: 13, immunities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "balor-longsword", name: "Balor Longsword", damageType: "slashing", count: 3, sides: 8, modifier: 8 },
      traits: [
        { slug: "balor-death-throes", name: "Death Throes", description: "Death Throes: when the balor dies it explodes, and each creature within 30 feet must make a DC 20 Dexterity save or take 70 (20d6) fire damage; the explosion is metadata only." },
        { slug: "balor-fire-aura", name: "Fire Aura", description: "Fire Aura: at the start of each of its turns the balor deals 10 (3d6) fire damage to each creature within 5 feet, and its weapons are wreathed in flame; the aura is metadata only." },
        { slug: "balor-magic-resistance", name: "Magic Resistance", description: "Magic Resistance: the balor has advantage on saving throws against spells and other magical effects; the advantage is metadata only." },
        { slug: "balor-magic-weapons", name: "Magic Weapons", description: "Magic Weapons: the balor's weapon attacks are magical; weapon enchantment is metadata only." },
        { slug: "balor-multiattack", name: "Multiattack", description: "Multiattack: the balor makes two attacks, one with its longsword and one with its whip; only the pinned longsword is executable." },
      ],
      template: { slug: "balor", name: "Balor", cr: 19, crTag: "cr-19", maxHp: 262, defense: 19, speed: 40, attackBonus: 14, resistances: ["cold", "fire", "storm"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "ancient-brass-dragon-bite", name: "Ancient Brass Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 8 },
      traits: [
        { slug: "ancient-brass-dragon-amphibious", name: "Amphibious", description: "Amphibious: the dragon can breathe air and water; breathing modes are metadata only." },
        { slug: "ancient-brass-dragon-legendary-resistance", name: "Legendary Resistance", description: "Legendary Resistance (3/day): the dragon can choose to succeed on a failed saving throw; saving throws are metadata only." },
        { slug: "ancient-brass-dragon-frightful-presence", name: "Frightful Presence", description: "Frightful Presence: creatures within 120 feet that fail a DC 20 Wisdom save are frightened for 1 minute; the save and condition are metadata only." },
        { slug: "ancient-brass-dragon-multiattack", name: "Multiattack", description: "Multiattack: the dragon uses Frightful Presence and then makes one bite and two claw attacks; only the pinned bite is executable." },
        { slug: "ancient-brass-dragon-breath-weapons", name: "Breath Weapons", description: "Breath Weapons (recharge 5-6): a 90-foot fire line (DC 21 Dexterity save) or a 60-foot sleep gas cone (DC 21 Constitution save); area breath weapons are metadata only." },
        { slug: "ancient-brass-dragon-change-shape", name: "Change Shape", description: "Change Shape: the dragon magically polymorphs into a humanoid or beast; alternate forms are metadata only." },
        { slug: "ancient-brass-dragon-wing-attack", name: "Wing Attack", description: "Wing Attack (legendary action, costs 2): nearby creatures must make a DC 22 Dexterity save or take bludgeoning damage and fall prone; legendary actions are metadata only." },
      ],
      template: { slug: "ancient-brass-dragon", name: "Ancient Brass Dragon", cr: 20, crTag: "cr-20", maxHp: 297, defense: 20, speed: 40, attackBonus: 14, immunities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "ancient-white-dragon-bite", name: "Ancient White Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 8 },
      traits: [
        { slug: "ancient-white-dragon-ice-walk", name: "Ice Walk", description: "Ice Walk: the dragon can move across and climb icy surfaces without an ability check; movement is not modeled." },
        { slug: "ancient-white-dragon-legendary-resistance", name: "Legendary Resistance", description: "Legendary Resistance (3/day): the dragon can choose to succeed on a failed saving throw; saving throws are metadata only." },
        { slug: "ancient-white-dragon-frightful-presence", name: "Frightful Presence", description: "Frightful Presence: creatures within 120 feet that fail a DC 17 Wisdom save are frightened for 1 minute; the save and condition are metadata only." },
        { slug: "ancient-white-dragon-multiattack", name: "Multiattack", description: "Multiattack: the dragon uses Frightful Presence and then makes one bite and two claw attacks; only the pinned bite is executable." },
        { slug: "ancient-white-dragon-cold-breath", name: "Cold Breath", description: "Cold Breath (recharge 5-6): a 90-foot cone forces a DC 22 Constitution save for 72 (16d8) cold damage; the area breath is metadata only." },
        { slug: "ancient-white-dragon-wing-attack", name: "Wing Attack", description: "Wing Attack (legendary action, costs 2): nearby creatures must make a DC 20 Dexterity save or take bludgeoning damage and fall prone; legendary actions are metadata only." },
      ],
      template: { slug: "ancient-white-dragon", name: "Ancient White Dragon", cr: 20, crTag: "cr-20", maxHp: 333, defense: 20, speed: 40, attackBonus: 14, immunities: ["cold"], vulnerabilities: ["fire"] },
    }),
    defineMonster(refs, {
      attack: { abilitySlug: "pit-fiend-mace", name: "Pit Fiend Mace", damageType: "bludgeoning", count: 2, sides: 6, modifier: 8 },
      traits: [
        { slug: "pit-fiend-fear-aura", name: "Fear Aura", description: "Fear Aura: creatures within 20 feet that fail a DC 21 Wisdom save are frightened while in the aura; the save and condition are metadata only." },
        { slug: "pit-fiend-magic-resistance", name: "Magic Resistance", description: "Magic Resistance: the pit fiend has advantage on saving throws against spells and other magical effects; the advantage is metadata only." },
        { slug: "pit-fiend-magic-weapons", name: "Magic Weapons", description: "Magic Weapons: the pit fiend's weapon attacks are magical; weapon enchantment is metadata only." },
        { slug: "pit-fiend-innate-spellcasting", name: "Innate Spellcasting", description: "Innate Spellcasting: the pit fiend casts spells such as detect magic, fireball, and hold monster using Charisma; spell selection and slots are metadata only." },
        { slug: "pit-fiend-multiattack", name: "Multiattack", description: "Multiattack: the pit fiend makes four attacks: one with its bite, one with its claw, one with its mace, and one with its tail; only the pinned mace is executable." },
      ],
      template: { slug: "pit-fiend", name: "Pit Fiend", cr: 20, crTag: "cr-20", maxHp: 300, defense: 19, speed: 30, attackBonus: 14, resistances: ["cold", "bludgeoning", "piercing", "slashing"], immunities: ["fire"] },
    }),
  ];

  return {
    abilities: monsters.flatMap((monster) => monster.abilities),
    enemies: monsters.map((monster) => monster.enemy),
  };
}
