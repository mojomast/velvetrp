import type { StarterReferences } from "../references.js";
import {
  monsterAttack,
  monsterTemplate,
  monsterTrait,
  type MonsterAttackSpec,
  type MonsterTemplateSpec,
} from "./enemyBuilder.js";

type Cr12To14Trait = { slug: string; name: string; description: string };

type Cr12To14Monster = {
  attack: MonsterAttackSpec;
  traits?: readonly Cr12To14Trait[];
  template: Omit<MonsterTemplateSpec, "cr" | "crTag" | "primaryAttack" | "traitRefs">;
};

const BAND_CR: Readonly<Record<number, string>> = {
  12: "cr-12",
  13: "cr-13",
  14: "cr-14",
};

function defineMonster(refs: StarterReferences, cr: number, monster: Cr12To14Monster) {
  const crTag = BAND_CR[cr];
  if (!crTag) throw new Error(`cr12To14Band only supports CR 12, 13, or 14; received ${cr}`);
  const attack = monsterAttack(refs, monster.attack);
  const traits = (monster.traits ?? []).map((trait) => monsterTrait(refs, trait.slug, trait.name, trait.description));
  const enemy = monsterTemplate(refs, {
    ...monster.template,
    cr,
    crTag,
    primaryAttack: attack.reference,
    traitRefs: traits.map((trait) => trait.reference),
  });
  return { abilities: [attack, ...traits], enemy };
}

/**
 * Every SRD 5.1 monster whose challenge rating is exactly 12, 13, or 14. The
 * complete band is eleven stat blocks: Archmage and Erinyes (CR 12); Adult
 * Brass Dragon, Adult White Dragon, Nalfeshnee, Rakshasa, Storm Giant, and
 * Vampire (CR 13); Adult Black Dragon, Adult Copper Dragon, and Ice Devil
 * (CR 14). Each profile keeps one executable basic attack; multiattack,
 * breath weapons, legendary resistance, recharge, and other non-executable
 * actions are carried as bounded metadata.
 */
export function cr12To14Band(refs: StarterReferences) {
  const monsters = [
    defineMonster(refs, 12, {
      attack: { abilitySlug: "archmage-dagger", name: "Archmage Dagger", damageType: "piercing", count: 1, sides: 4, modifier: 2 },
      traits: [
        { slug: "archmage-magic-resistance", name: "Magic Resistance", description: "The archmage has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "archmage-spellcasting", name: "Spellcasting", description: "The archmage is an 18th-level spellcaster with Intelligence-based prepared wizard spells. Spellcasting is metadata only in this pack." },
      ],
      template: { slug: "archmage", name: "Archmage", maxHp: 99, defense: 12, speed: 30, attackBonus: 6, resistances: ["physical"] },
    }),
    defineMonster(refs, 12, {
      attack: { abilitySlug: "erinyes-longsword", name: "Erinyes Longsword", damageType: "slashing", count: 1, sides: 8, modifier: 4 },
      traits: [
        { slug: "erinyes-hellish-weapons", name: "Hellish Weapons", description: "The erinyes's weapon attacks are magical and deal an extra 13 (3d8) poison damage on a hit. The extra damage is metadata only." },
        { slug: "erinyes-magic-resistance", name: "Magic Resistance", description: "The erinyes has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "erinyes-parry", name: "Parry", description: "The erinyes adds 4 to its AC against one melee attack that would hit it as a reaction. The reaction is metadata only." },
      ],
      template: { slug: "erinyes", name: "Erinyes", maxHp: 153, defense: 18, speed: 30, attackBonus: 8, resistances: ["cold", "physical"], immunities: ["fire"] },
    }),
    defineMonster(refs, 13, {
      attack: { abilitySlug: "adult-brass-dragon-bite", name: "Adult Brass Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 6 },
      traits: [
        { slug: "adult-brass-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead. The substitution is metadata only." },
        { slug: "adult-brass-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet must succeed on a DC 16 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "adult-brass-dragon-breath-weapons", name: "Breath Weapons (Recharge 5-6)", description: "The dragon exhales a fire line or a sleep cone. Area breath weapons are not executable in this pack." },
        { slug: "adult-brass-dragon-multiattack", name: "Multiattack", description: "The dragon uses Frightful Presence and then makes three attacks (one bite and two claws); only the pinned bite is executable." },
      ],
      template: { slug: "adult-brass-dragon", name: "Adult Brass Dragon", maxHp: 172, defense: 18, speed: 40, attackBonus: 11, immunities: ["fire"] },
    }),
    defineMonster(refs, 13, {
      attack: { abilitySlug: "adult-white-dragon-bite", name: "Adult White Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 6 },
      traits: [
        { slug: "adult-white-dragon-ice-walk", name: "Ice Walk", description: "The dragon can move across and climb icy surfaces without an ability check and ignores ice or snow difficult terrain. Movement is not modeled." },
        { slug: "adult-white-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead. The substitution is metadata only." },
        { slug: "adult-white-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet must succeed on a DC 14 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "adult-white-dragon-cold-breath", name: "Cold Breath (Recharge 5-6)", description: "The dragon exhales an icy blast in a 60-foot cone (DC 19 Constitution save). The area and save are metadata only." },
      ],
      template: { slug: "adult-white-dragon", name: "Adult White Dragon", maxHp: 200, defense: 18, speed: 40, attackBonus: 11, immunities: ["cold"] },
    }),
    defineMonster(refs, 13, {
      attack: { abilitySlug: "nalfeshnee-bite", name: "Nalfeshnee Bite", damageType: "piercing", count: 5, sides: 10, modifier: 5 },
      traits: [
        { slug: "nalfeshnee-magic-resistance", name: "Magic Resistance", description: "The nalfeshnee has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "nalfeshnee-horror-nimbus", name: "Horror Nimbus (Recharge 5-6)", description: "The nalfeshnee emits multicolored light; creatures within 15 feet failing a DC 15 Wisdom save are frightened. The save and condition are metadata only." },
        { slug: "nalfeshnee-teleport", name: "Teleport", description: "The nalfeshnee magically teleports up to 120 feet to an unoccupied space it can see. Teleportation is metadata only." },
        { slug: "nalfeshnee-multiattack", name: "Multiattack", description: "The nalfeshnee uses Horror Nimbus if it can and then makes three attacks (one bite and two claws); only the pinned bite is executable." },
      ],
      template: { slug: "nalfeshnee", name: "Nalfeshnee", maxHp: 184, defense: 18, speed: 20, attackBonus: 10, resistances: ["cold", "fire", "storm", "physical"] },
    }),
    defineMonster(refs, 13, {
      attack: { abilitySlug: "rakshasa-claw", name: "Rakshasa Claw", damageType: "slashing", count: 2, sides: 6, modifier: 2 },
      traits: [
        { slug: "rakshasa-limited-magic-immunity", name: "Limited Magic Immunity", description: "The rakshasa can't be affected or detected by spells of 6th level or lower unless it wishes to be. Spell immunity is metadata only." },
        { slug: "rakshasa-innate-spellcasting", name: "Innate Spellcasting", description: "The rakshasa's Charisma-based innate spellcasting (spell save DC 18) is metadata only; spell selection is not executable in this pack." },
        { slug: "rakshasa-multiattack", name: "Multiattack", description: "The rakshasa makes two claw attacks; only the single pinned claw is executable." },
      ],
      template: { slug: "rakshasa", name: "Rakshasa", maxHp: 110, defense: 16, speed: 40, attackBonus: 7, immunities: ["physical"] },
    }),
    defineMonster(refs, 13, {
      attack: { abilitySlug: "storm-giant-greatsword", name: "Storm Giant Greatsword", damageType: "slashing", count: 6, sides: 6, modifier: 9 },
      traits: [
        { slug: "storm-giant-amphibious", name: "Amphibious", description: "The giant can breathe air and water. Breathing is not modeled." },
        { slug: "storm-giant-innate-spellcasting", name: "Innate Spellcasting", description: "The giant's Charisma-based innate spellcasting (spell save DC 17) is metadata only; spell selection is not executable in this pack." },
        { slug: "storm-giant-lightning-strike", name: "Lightning Strike (Recharge 5-6)", description: "The giant hurls a lightning bolt at a point within 500 feet (DC 17 Dexterity save, 12d8 lightning). The area and save are metadata only." },
      ],
      template: { slug: "storm-giant", name: "Storm Giant", maxHp: 230, defense: 16, speed: 50, attackBonus: 14, resistances: ["cold"], immunities: ["storm"] },
    }),
    defineMonster(refs, 13, {
      attack: { abilitySlug: "vampire-unarmed-strike", name: "Vampire Unarmed Strike", damageType: "bludgeoning", count: 1, sides: 8, modifier: 4 },
      traits: [
        { slug: "vampire-shapechanger", name: "Shapechanger", description: "The vampire can polymorph into a Tiny bat or a Medium cloud of mist, or back into its true form. The transformation is metadata only." },
        { slug: "vampire-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the vampire fails a saving throw, it can choose to succeed instead. The substitution is metadata only." },
        { slug: "vampire-misty-escape", name: "Misty Escape", description: "When it drops to 0 hit points outside its resting place, the vampire transforms into a cloud of mist instead of falling unconscious. The escape is metadata only." },
        { slug: "vampire-regeneration", name: "Regeneration", description: "The vampire regains 20 hit points at the start of its turn if it has at least 1 hit point and isn't in sunlight or running water. The regeneration is metadata only." },
        { slug: "vampire-spider-climb", name: "Spider Climb", description: "The vampire can climb difficult surfaces, including upside down on ceilings, without an ability check. Movement is not modeled." },
      ],
      template: { slug: "vampire", name: "Vampire", maxHp: 144, defense: 16, speed: 30, attackBonus: 9, resistances: ["physical"] },
    }),
    defineMonster(refs, 14, {
      attack: { abilitySlug: "adult-black-dragon-bite", name: "Adult Black Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 6 },
      traits: [
        { slug: "adult-black-dragon-amphibious", name: "Amphibious", description: "The dragon can breathe air and water. Breathing is not modeled." },
        { slug: "adult-black-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead. The substitution is metadata only." },
        { slug: "adult-black-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet must succeed on a DC 16 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "adult-black-dragon-acid-breath", name: "Acid Breath (Recharge 5-6)", description: "The dragon exhales acid in a 60-foot line (DC 18 Dexterity save). The area, save, and acid damage are metadata only." },
        { slug: "adult-black-dragon-multiattack", name: "Multiattack", description: "The dragon uses Frightful Presence and then makes three attacks (one bite and two claws); only the pinned bite is executable." },
      ],
      template: { slug: "adult-black-dragon", name: "Adult Black Dragon", maxHp: 195, defense: 19, speed: 40, attackBonus: 11 },
    }),
    defineMonster(refs, 14, {
      attack: { abilitySlug: "adult-copper-dragon-bite", name: "Adult Copper Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 6 },
      traits: [
        { slug: "adult-copper-dragon-legendary-resistance", name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead. The substitution is metadata only." },
        { slug: "adult-copper-dragon-frightful-presence", name: "Frightful Presence", description: "Creatures within 120 feet must succeed on a DC 16 Wisdom save or be frightened for 1 minute. The save and condition are metadata only." },
        { slug: "adult-copper-dragon-breath-weapons", name: "Breath Weapons (Recharge 5-6)", description: "The dragon exhales an acid line or a slowing cone. Area breath weapons are not executable in this pack." },
        { slug: "adult-copper-dragon-multiattack", name: "Multiattack", description: "The dragon uses Frightful Presence and then makes three attacks (one bite and two claws); only the pinned bite is executable." },
      ],
      template: { slug: "adult-copper-dragon", name: "Adult Copper Dragon", maxHp: 184, defense: 18, speed: 40, attackBonus: 11 },
    }),
    defineMonster(refs, 14, {
      attack: { abilitySlug: "ice-devil-bite", name: "Ice Devil Bite", damageType: "piercing", count: 2, sides: 6, modifier: 5 },
      traits: [
        { slug: "ice-devil-devils-sight", name: "Devil's Sight", description: "Magical darkness doesn't impede the ice devil's darkvision. Lighting is not modeled." },
        { slug: "ice-devil-magic-resistance", name: "Magic Resistance", description: "The ice devil has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "ice-devil-wall-of-ice", name: "Wall of Ice", description: "The ice devil magically forms an opaque wall or dome of ice within 60 feet. The wall is not executable in this pack." },
        { slug: "ice-devil-multiattack", name: "Multiattack", description: "The devil makes three attacks: one with its bite, one with its claws, and one with its tail; only the pinned bite is executable." },
      ],
      template: { slug: "ice-devil", name: "Ice Devil", maxHp: 180, defense: 18, speed: 40, attackBonus: 10, resistances: ["physical"], immunities: ["fire"] },
    }),
  ];

  return {
    abilities: monsters.flatMap((monster) => monster.abilities),
    enemies: monsters.map((monster) => monster.enemy),
  };
}
