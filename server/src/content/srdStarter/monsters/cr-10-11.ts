import type { StarterReferences } from "../references.js";
import {
  monsterAttack,
  monsterTemplate,
  monsterTrait,
  type MonsterAttackSpec,
  type MonsterBand,
  type MonsterTemplateSpec,
} from "./enemyBuilder.js";

type BandTrait = { slug: string; name: string; description: string };

type Cr10To11Monster = {
  cr: 10 | 11;
  attack: MonsterAttackSpec;
  traits?: readonly BandTrait[];
  template: Omit<MonsterTemplateSpec, "cr" | "crTag" | "primaryAttack" | "traitRefs">;
};

/**
 * Local `defineMonster` mirrors the low-CR bands: one executable basic attack,
 * notable traits as bounded metadata, then a pinned template whose `cr`, `crTag`,
 * and combat profile all agree. Trait slugs are prefixed by the monster slug so
 * every ability identifier stays unique across the whole starter catalog.
 */
function defineMonster(refs: StarterReferences, monster: Cr10To11Monster) {
  const attack = monsterAttack(refs, monster.attack);
  const traits = (monster.traits ?? []).map((trait) => monsterTrait(refs, trait.slug, trait.name, trait.description));
  const enemy = monsterTemplate(refs, {
    ...monster.template,
    cr: monster.cr,
    crTag: monster.cr === 11 ? "cr-11" : "cr-10",
    primaryAttack: attack.reference,
    traitRefs: traits.map((trait) => trait.reference),
  });
  return { abilities: [attack, ...traits], enemy };
}

/**
 * Every SRD 5.1 monster whose challenge rating is exactly 10 or 11. Each profile
 * keeps one executable basic attack; multiattack, breath weapons, innate
 * spellcasting, and signature traits are carried as bounded metadata (tagged
 * `unsupported-runtime`) because this pack does not model positioning, saving
 * throws, or per-turn attack sequences. `dao` and `marid` are the two remaining
 * 5e CR-11 genies and are included so the band covers the full CR-11 genie set.
 */
export function cr10To11Band(refs: StarterReferences): MonsterBand {
  const monsters: Cr10To11Monster[] = [
    {
      cr: 10,
      attack: { abilitySlug: "aboleth-tentacle", name: "Aboleth Tentacle", damageType: "bludgeoning", count: 2, sides: 6, modifier: 5 },
      traits: [
        { slug: "aboleth-amphibious", name: "Amphibious", description: "The aboleth can breathe air and water. Not executable at runtime." },
        { slug: "aboleth-mucous-cloud", name: "Mucous Cloud", description: "While underwater, a creature that touches the aboleth or hits it with a melee attack within 5 feet must succeed on a DC 14 Constitution save or become diseased. The save and disease are metadata only." },
        { slug: "aboleth-probing-telepathy", name: "Probing Telepathy", description: "If a creature communicates telepathically with the aboleth, the aboleth learns its greatest desires. Not executable at runtime." },
        { slug: "aboleth-multiattack", name: "Multiattack", description: "The aboleth makes three tentacle attacks; only the single pinned tentacle is executable." },
      ],
      template: { slug: "aboleth", name: "Aboleth", maxHp: 135, defense: 17, speed: 10, attackBonus: 9 },
    },
    {
      cr: 10,
      attack: { abilitySlug: "deva-mace", name: "Deva Mace", damageType: "bludgeoning", count: 1, sides: 6, modifier: 4 },
      traits: [
        { slug: "deva-angelic-weapons", name: "Angelic Weapons", description: "The deva's weapon attacks are magical and deal an extra 4d8 radiant damage on a hit. The extra damage is metadata only." },
        { slug: "deva-innate-spellcasting", name: "Innate Spellcasting", description: "The deva innately casts detect evil and good at will and commune and raise dead once per day. Spell selection is not executable in this pack." },
        { slug: "deva-magic-resistance", name: "Magic Resistance", description: "The deva has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "deva-multiattack", name: "Multiattack", description: "The deva makes two melee attacks; only the single pinned mace is executable." },
        { slug: "deva-healing-touch", name: "Healing Touch", description: "The deva touches another creature to restore 20 hit points and free it from curses, disease, poison, blindness, or deafness. Healing is metadata only." },
      ],
      template: { slug: "deva", name: "Deva", maxHp: 136, defense: 17, speed: 30, attackBonus: 8, resistances: ["radiant", "physical"] },
    },
    {
      cr: 10,
      attack: { abilitySlug: "guardian-naga-bite", name: "Guardian Naga Bite", damageType: "piercing", count: 1, sides: 8, modifier: 4 },
      traits: [
        { slug: "guardian-naga-rejuvenation", name: "Rejuvenation", description: "If it dies, the guardian naga returns to life in 1d6 days and regains all its hit points unless a wish spell prevents it. Not executable at runtime." },
        { slug: "guardian-naga-spellcasting", name: "Spellcasting", description: "The guardian naga is an 11th-level cleric spellcaster (spell save DC 16); spell selection is not executable in this pack." },
        { slug: "guardian-naga-magic-resistance", name: "Magic Resistance", description: "The guardian naga has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "guardian-naga-spit-poison", name: "Spit Poison", description: "The guardian naga makes a ranged poison attack that forces a DC 15 Constitution save for 10d8 poison damage. The save and poison are metadata only." },
      ],
      template: { slug: "guardian-naga", name: "Guardian Naga", maxHp: 127, defense: 18, speed: 40, attackBonus: 8 },
    },
    {
      cr: 10,
      attack: { abilitySlug: "stone-golem-slam", name: "Stone Golem Slam", damageType: "bludgeoning", count: 3, sides: 8, modifier: 6 },
      traits: [
        { slug: "stone-golem-immutable-form", name: "Immutable Form", description: "The stone golem is immune to any spell or effect that would alter its form. Not executable at runtime." },
        { slug: "stone-golem-magic-resistance", name: "Magic Resistance", description: "The stone golem has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "stone-golem-magic-weapons", name: "Magic Weapons", description: "The stone golem's weapon attacks are magical. Not executable at runtime." },
        { slug: "stone-golem-slow", name: "Slow", description: "The stone golem targets creatures within 10 feet with a DC 17 Wisdom save that halves speed and limits actions. The save and condition are metadata only." },
        { slug: "stone-golem-multiattack", name: "Multiattack", description: "The stone golem makes two slam attacks; only the single pinned slam is executable." },
      ],
      template: { slug: "stone-golem", name: "Stone Golem", maxHp: 178, defense: 17, speed: 30, attackBonus: 10, immunities: ["physical"] },
    },
    {
      cr: 10,
      attack: { abilitySlug: "young-gold-dragon-bite", name: "Young Gold Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 6 },
      traits: [
        { slug: "young-gold-dragon-amphibious", name: "Amphibious", description: "The young gold dragon can breathe air and water. Not executable at runtime." },
        { slug: "young-gold-dragon-multiattack", name: "Multiattack", description: "The dragon makes three attacks: one bite and two claws; only the pinned bite is executable." },
        { slug: "young-gold-dragon-breath-weapons", name: "Breath Weapons", description: "The dragon exhales a DC 17 fire cone or weakening gas (recharge 5-6). Area breath weapons and saves are not executable in this pack." },
      ],
      template: { slug: "young-gold-dragon", name: "Young Gold Dragon", maxHp: 178, defense: 18, speed: 40, attackBonus: 10, immunities: ["fire"] },
    },
    {
      cr: 10,
      attack: { abilitySlug: "young-red-dragon-bite", name: "Young Red Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 6 },
      traits: [
        { slug: "young-red-dragon-multiattack", name: "Multiattack", description: "The dragon makes three attacks: one bite and two claws; only the pinned bite is executable." },
        { slug: "young-red-dragon-fire-breath", name: "Fire Breath", description: "The dragon exhales fire in a 30-foot cone (recharge 5-6, DC 17 Dexterity save, 16d6 fire). The area and save are metadata only." },
      ],
      template: { slug: "young-red-dragon", name: "Young Red Dragon", maxHp: 178, defense: 18, speed: 40, attackBonus: 10, immunities: ["fire"] },
    },
    {
      cr: 11,
      attack: { abilitySlug: "behir-bite", name: "Behir Bite", damageType: "piercing", count: 3, sides: 10, modifier: 6 },
      traits: [
        { slug: "behir-multiattack", name: "Multiattack", description: "The behir makes two attacks: one bite and one constrict; only the pinned bite is executable." },
        { slug: "behir-constrict", name: "Constrict", description: "The behir's constrict deals 2d10+6 bludgeoning plus 2d10+6 slashing and grapples the target. The grapple is metadata only." },
        { slug: "behir-swallow", name: "Swallow", description: "The behir can swallow a grappled target, which is blinded and restrained and takes acid damage each turn. The swallow is metadata only." },
        { slug: "behir-lightning-breath", name: "Lightning Breath", description: "The behir exhales lightning in a 20-foot line (recharge 5-6, DC 16 Dexterity save, 12d10 lightning). The area and save are metadata only." },
      ],
      template: { slug: "behir", name: "Behir", maxHp: 168, defense: 17, speed: 50, attackBonus: 10, immunities: ["storm"] },
    },
    {
      cr: 11,
      attack: { abilitySlug: "djinni-scimitar", name: "Djinni Scimitar", damageType: "slashing", count: 2, sides: 6, modifier: 5 },
      traits: [
        { slug: "djinni-elemental-demise", name: "Elemental Demise", description: "If the djinni dies, its body disintegrates into a warm breeze. Not executable at runtime." },
        { slug: "djinni-innate-spellcasting", name: "Innate Spellcasting", description: "The djinni innately casts detect evil and good and detect magic at will and several spells including creation and gaseous form. Spell selection is not executable in this pack." },
        { slug: "djinni-create-whirlwind", name: "Create Whirlwind", description: "The djinni creates a 5-foot-radius, 30-foot-tall whirlwind that damages and restrains creatures. The area and condition are metadata only." },
        { slug: "djinni-multiattack", name: "Multiattack", description: "The djinni makes three scimitar attacks; only the single pinned scimitar is executable." },
      ],
      template: { slug: "djinni", name: "Djinni", maxHp: 161, defense: 17, speed: 30, attackBonus: 9, immunities: ["storm"] },
    },
    {
      cr: 11,
      attack: { abilitySlug: "efreeti-scimitar", name: "Efreeti Scimitar", damageType: "slashing", count: 2, sides: 6, modifier: 6 },
      traits: [
        { slug: "efreeti-elemental-demise", name: "Elemental Demise", description: "If the efreeti dies, its body disintegrates in a flash of fire and puff of smoke. Not executable at runtime." },
        { slug: "efreeti-innate-spellcasting", name: "Innate Spellcasting", description: "The efreeti innately casts detect magic at will and several spells including enlarge/reduce, gaseous form, and invisibility. Spell selection is not executable in this pack." },
        { slug: "efreeti-hurl-flame", name: "Hurl Flame", description: "The efreeti hurls a magical flame as a ranged attack for 5d6 fire damage. Ranged attacks are metadata only." },
        { slug: "efreeti-multiattack", name: "Multiattack", description: "The efreeti makes two scimitar attacks or uses Hurl Flame twice; only the pinned scimitar is executable." },
      ],
      template: { slug: "efreeti", name: "Efreeti", maxHp: 200, defense: 17, speed: 40, attackBonus: 10, immunities: ["fire"] },
    },
    {
      cr: 11,
      attack: { abilitySlug: "gynosphinx-claw", name: "Gynosphinx Claw", damageType: "slashing", count: 2, sides: 8, modifier: 4 },
      traits: [
        { slug: "gynosphinx-inscrutable", name: "Inscrutable", description: "The gynosphinx is immune to effects that sense emotions or read thoughts and to any effect that would reveal whether it is lying. Not executable at runtime." },
        { slug: "gynosphinx-magic-weapons", name: "Magic Weapons", description: "The gynosphinx's weapon attacks are magical. Not executable at runtime." },
        { slug: "gynosphinx-spellcasting", name: "Spellcasting", description: "The gynosphinx is a 9th-level wizard spellcaster (spell save DC 17) with several spells including dispel magic and legend lore. Spell selection is not executable in this pack." },
        { slug: "gynosphinx-multiattack", name: "Multiattack", description: "The gynosphinx makes two claw attacks; only the single pinned claw is executable." },
      ],
      template: { slug: "gynosphinx", name: "Gynosphinx", maxHp: 136, defense: 17, speed: 40, attackBonus: 9, resistances: ["physical"] },
    },
    {
      cr: 11,
      attack: { abilitySlug: "horned-devil-fork", name: "Horned Devil Fork", damageType: "piercing", count: 2, sides: 8, modifier: 6 },
      traits: [
        { slug: "horned-devil-devils-sight", name: "Devil's Sight", description: "Magical darkness does not impede the horned devil's darkvision. Lighting is not modeled." },
        { slug: "horned-devil-magic-resistance", name: "Magic Resistance", description: "The horned devil has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "horned-devil-hurl-flame", name: "Hurl Flame", description: "The horned devil hurls flame as a ranged attack for 4d6 fire damage, igniting flammable objects. Ranged attacks are metadata only." },
        { slug: "horned-devil-multiattack", name: "Multiattack", description: "The horned devil makes three melee attacks: two with its fork and one with its tail, or two hurl flame attacks; only the pinned fork is executable." },
      ],
      template: { slug: "horned-devil", name: "Horned Devil", maxHp: 178, defense: 18, speed: 20, attackBonus: 10, resistances: ["cold", "physical"], immunities: ["fire"] },
    },
    {
      cr: 11,
      attack: { abilitySlug: "remorhaz-bite", name: "Remorhaz Bite", damageType: "piercing", count: 6, sides: 10, modifier: 7 },
      traits: [
        { slug: "remorhaz-heated-body", name: "Heated Body", description: "A creature that touches the remorhaz or hits it with a melee attack within 5 feet takes 3d6 fire damage. The touch damage is metadata only." },
        { slug: "remorhaz-swallow", name: "Swallow", description: "The remorhaz can swallow a grappled target, which is blinded and restrained and takes 6d6 acid damage each turn. The swallow is metadata only." },
      ],
      template: { slug: "remorhaz", name: "Remorhaz", maxHp: 195, defense: 17, speed: 30, attackBonus: 11, immunities: ["cold", "fire"] },
    },
    {
      cr: 11,
      attack: { abilitySlug: "roc-beak", name: "Roc Beak", damageType: "piercing", count: 4, sides: 8, modifier: 9 },
      traits: [
        { slug: "roc-keen-sight", name: "Keen Sight", description: "The roc has advantage on Wisdom (Perception) checks that rely on sight. The advantage is metadata only." },
        { slug: "roc-multiattack", name: "Multiattack", description: "The roc makes two attacks: one with its beak and one with its talons; only the pinned beak is executable." },
      ],
      template: { slug: "roc", name: "Roc", maxHp: 248, defense: 15, speed: 20, attackBonus: 13 },
    },
  ];

  const built = monsters.map((monster) => defineMonster(refs, monster));
  return {
    abilities: built.flatMap((monster) => monster.abilities),
    enemies: built.map((monster) => monster.enemy),
  };
}
