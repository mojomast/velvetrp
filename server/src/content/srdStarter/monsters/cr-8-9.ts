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
  cr: 8 | 9;
  attack: MonsterAttackSpec;
  traits?: readonly BandTrait[];
  template: Omit<MonsterTemplateSpec, "cr" | "crTag" | "primaryAttack" | "traitRefs">;
};

function defineMonster(refs: StarterReferences, monster: BandMonster) {
  const attack = monsterAttack(refs, monster.attack);
  const traits = (monster.traits ?? []).map((trait) => monsterTrait(refs, trait.slug, trait.name, trait.description));
  const enemy = monsterTemplate(refs, {
    ...monster.template,
    cr: monster.cr,
    crTag: monster.cr === 8 ? "cr-8" : "cr-9",
    primaryAttack: attack.reference,
    traitRefs: traits.map((trait) => trait.reference),
  });
  return { abilities: [attack, ...traits], enemy };
}

/**
 * Every SRD 5.1 monster whose challenge rating is exactly 8 or 9. Each profile
 * keeps one executable basic attack; multiattack, breath weapons, and signature
 * traits are carried as bounded metadata (tagged `unsupported-runtime`) because
 * this pack does not model positioning, saving throws, or per-turn attack
 * sequences. Damage types are restricted to the bounded starter vocabulary, so
 * acid, poison, necrotic, psychic, and thunder are omitted and lightning is
 * expressed as `storm`.
 */
export function cr8To9Band(refs: StarterReferences) {
  const monsters = [
    // Challenge rating 8
    defineMonster(refs, {
      cr: 8,
      attack: { abilitySlug: "assassin-shortsword", name: "Assassin Shortsword", damageType: "piercing", count: 1, sides: 6, modifier: 3 },
      traits: [
        { slug: "assassin-multiattack", name: "Multiattack", description: "The assassin makes two shortsword attacks; only the single pinned shortsword is executable." },
        { slug: "assassin-assassinate", name: "Assassinate", description: "Assassinate grants advantage against any creature that has not yet acted and turns a hit against a surprised creature into a critical hit. Surprise and critical overrides are metadata only." },
        { slug: "assassin-evasion", name: "Evasion", description: "Evasion: a successful Dexterity save against an effect that allows a half-damage save instead results in no damage. Reflex saves are not modeled." },
        { slug: "assassin-sneak-attack", name: "Sneak Attack (1/Turn)", description: "Sneak Attack deals an extra 4d6 damage once per turn when the assassin has advantage or an ally is within 5 feet of the target. The conditional rider is metadata only." },
      ],
      template: { slug: "assassin", name: "Assassin", maxHp: 78, defense: 15, speed: 30, attackBonus: 6 },
    }),
    defineMonster(refs, {
      cr: 8,
      attack: { abilitySlug: "chain-devil-chain", name: "Chain Devil Chain", damageType: "slashing", count: 2, sides: 6, modifier: 4 },
      traits: [
        { slug: "chain-devil-multiattack", name: "Multiattack", description: "The chain devil makes two attacks with its chain; only the single pinned chain attack is executable." },
        { slug: "chain-devil-devils-sight", name: "Devil's Sight", description: "Magical darkness does not impede the chain devil's darkvision. Lighting is not modeled." },
        { slug: "chain-devil-magic-resistance", name: "Magic Resistance", description: "Magic Resistance grants advantage on saving throws against spells and other magical effects; metadata only." },
      ],
      template: { slug: "chain-devil", name: "Chain Devil", maxHp: 85, defense: 16, speed: 30, attackBonus: 8, resistances: ["cold", "physical"], immunities: ["fire"] },
    }),
    defineMonster(refs, {
      cr: 8,
      attack: { abilitySlug: "cloaker-bite", name: "Cloaker Bite", damageType: "piercing", count: 2, sides: 6, modifier: 3 },
      traits: [
        { slug: "cloaker-multiattack", name: "Multiattack", description: "The cloaker makes a bite attack and a tail attack; only the single pinned bite is executable." },
        { slug: "cloaker-damage-transfer", name: "Damage Transfer", description: "While attached to a creature, the cloaker takes only half the damage dealt to it and the target takes the other half. Attachment is not modeled." },
        { slug: "cloaker-false-appearance", name: "False Appearance", description: "While motionless, the cloaker is indistinguishable from a dark leather cloak. Presentation is metadata only." },
        { slug: "cloaker-light-sensitivity", name: "Light Sensitivity", description: "While in bright light the cloaker has disadvantage on attack rolls and on Wisdom (Perception) checks that rely on sight. Lighting is not modeled." },
      ],
      template: { slug: "cloaker", name: "Cloaker", maxHp: 78, defense: 14, speed: 10, attackBonus: 6 },
    }),
    defineMonster(refs, {
      cr: 8,
      attack: { abilitySlug: "frost-giant-greataxe", name: "Frost Giant Greataxe", damageType: "slashing", count: 3, sides: 12, modifier: 6 },
      traits: [
        { slug: "frost-giant-multiattack", name: "Multiattack", description: "The frost giant makes two greataxe attacks; only the single pinned greataxe is executable." },
      ],
      template: { slug: "frost-giant", name: "Frost Giant", maxHp: 138, defense: 15, speed: 40, attackBonus: 9, immunities: ["cold"] },
    }),
    defineMonster(refs, {
      cr: 8,
      attack: { abilitySlug: "hezrou-bite", name: "Hezrou Bite", damageType: "piercing", count: 2, sides: 10, modifier: 4 },
      traits: [
        { slug: "hezrou-multiattack", name: "Multiattack", description: "The hezrou makes one bite and two claw attacks; only the single pinned bite is executable." },
        { slug: "hezrou-magic-resistance", name: "Magic Resistance", description: "Magic Resistance grants advantage on saving throws against spells and other magical effects; metadata only." },
        { slug: "hezrou-stench", name: "Stench", description: "Each creature that starts its turn within 10 feet of the hezrou must succeed on a DC 13 Constitution save or be poisoned until the start of its next turn. The save and condition are metadata only." },
      ],
      template: { slug: "hezrou", name: "Hezrou", maxHp: 136, defense: 16, speed: 30, attackBonus: 7, resistances: ["cold", "fire", "storm", "physical"] },
    }),
    defineMonster(refs, {
      cr: 8,
      attack: { abilitySlug: "hydra-bite", name: "Hydra Bite", damageType: "piercing", count: 1, sides: 10, modifier: 5 },
      traits: [
        { slug: "hydra-multiattack", name: "Multiattack", description: "The hydra makes as many bite attacks as it has heads; only the single pinned bite is executable." },
        { slug: "hydra-hold-breath", name: "Hold Breath", description: "The hydra can hold its breath for 1 hour. Breath tracking is not modeled." },
        { slug: "hydra-multiple-heads", name: "Multiple Heads", description: "The hydra has five heads and can regrow lost heads unless fire damage is applied to a stump. Head tracking is not modeled." },
        { slug: "hydra-reactive-heads", name: "Reactive Heads", description: "The hydra can take one reaction per head. Multiple reactions are not modeled." },
        { slug: "hydra-wakeful", name: "Wakeful", description: "While any head is awake the hydra cannot be surprised. Surprise is not modeled." },
      ],
      template: { slug: "hydra", name: "Hydra", maxHp: 172, defense: 15, speed: 30, attackBonus: 8 },
    }),
    defineMonster(refs, {
      cr: 8,
      attack: { abilitySlug: "spirit-naga-bite", name: "Spirit Naga Bite", damageType: "piercing", count: 1, sides: 6, modifier: 4 },
      traits: [
        { slug: "spirit-naga-rejuvenation", name: "Rejuvenation", description: "If it dies, the spirit naga returns to life after 1d6 days and regains all its hit points. Revival is not modeled." },
        { slug: "spirit-naga-spellcasting", name: "Spellcasting", description: "The spirit naga casts spells using Charisma (save DC 15) with no material components. Spell selection is not executable in this pack." },
      ],
      template: { slug: "spirit-naga", name: "Spirit Naga", maxHp: 75, defense: 15, speed: 40, attackBonus: 7 },
    }),
    defineMonster(refs, {
      cr: 8,
      attack: { abilitySlug: "tyrannosaurus-rex-bite", name: "Tyrannosaurus Rex Bite", damageType: "piercing", count: 4, sides: 12, modifier: 7 },
      traits: [
        { slug: "tyrannosaurus-rex-multiattack", name: "Multiattack", description: "The tyrannosaurus makes one bite and one tail attack; only the single pinned bite is executable." },
      ],
      template: { slug: "tyrannosaurus-rex", name: "Tyrannosaurus Rex", maxHp: 136, defense: 13, speed: 50, attackBonus: 10 },
    }),
    defineMonster(refs, {
      cr: 8,
      attack: { abilitySlug: "young-bronze-dragon-bite", name: "Young Bronze Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 5 },
      traits: [
        { slug: "young-bronze-dragon-amphibious", name: "Amphibious", description: "The young bronze dragon can breathe air and water. Breath tracking is not modeled." },
        { slug: "young-bronze-dragon-multiattack", name: "Multiattack", description: "The dragon makes one bite and two claw attacks; only the single pinned bite is executable." },
        { slug: "young-bronze-dragon-breath-weapons", name: "Breath Weapons", description: "Breath Weapons (recharge 5-6): a 60-foot lightning line or a 30-foot repulsion cone. Area breath weapons are not executable in this pack." },
      ],
      template: { slug: "young-bronze-dragon", name: "Young Bronze Dragon", maxHp: 142, defense: 18, speed: 40, attackBonus: 8, immunities: ["storm"] },
    }),
    defineMonster(refs, {
      cr: 8,
      attack: { abilitySlug: "young-green-dragon-bite", name: "Young Green Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 4 },
      traits: [
        { slug: "young-green-dragon-amphibious", name: "Amphibious", description: "The young green dragon can breathe air and water. Breath tracking is not modeled." },
        { slug: "young-green-dragon-multiattack", name: "Multiattack", description: "The dragon makes one bite and two claw attacks; only the single pinned bite is executable." },
        { slug: "young-green-dragon-poison-breath", name: "Poison Breath", description: "Poison Breath (recharge 5-6): a 30-foot cone dealing poison damage. Poison is outside the bounded damage vocabulary, so the breath is metadata only." },
      ],
      template: { slug: "young-green-dragon", name: "Young Green Dragon", maxHp: 136, defense: 18, speed: 40, attackBonus: 7 },
    }),

    // Challenge rating 9
    defineMonster(refs, {
      cr: 9,
      attack: { abilitySlug: "bone-devil-claw", name: "Bone Devil Claw", damageType: "slashing", count: 1, sides: 8, modifier: 4 },
      traits: [
        { slug: "bone-devil-multiattack", name: "Multiattack", description: "The bone devil makes three attacks: one bite, one claw, and one sting; only the single pinned claw is executable." },
        { slug: "bone-devil-devils-sight", name: "Devil's Sight", description: "Magical darkness does not impede the bone devil's darkvision. Lighting is not modeled." },
        { slug: "bone-devil-magic-resistance", name: "Magic Resistance", description: "Magic Resistance grants advantage on saving throws against spells and other magical effects; metadata only." },
      ],
      template: { slug: "bone-devil", name: "Bone Devil", maxHp: 142, defense: 19, speed: 40, attackBonus: 8, resistances: ["cold", "physical"], immunities: ["fire"] },
    }),
    defineMonster(refs, {
      cr: 9,
      attack: { abilitySlug: "clay-golem-slam", name: "Clay Golem Slam", damageType: "bludgeoning", count: 2, sides: 10, modifier: 5 },
      traits: [
        { slug: "clay-golem-multiattack", name: "Multiattack", description: "The clay golem makes two slam attacks; only the single pinned slam is executable." },
        { slug: "clay-golem-acid-absorption", name: "Acid Absorption", description: "Whenever the golem is subjected to acid damage it takes no damage and regains hit points equal to the acid damage dealt. Damage-type absorption is not modeled." },
        { slug: "clay-golem-berserk", name: "Berserk", description: "While below half its hit points at the start of its turn, the golem may go berserk. The conditional behavior is metadata only." },
        { slug: "clay-golem-immutable-form", name: "Immutable Form", description: "The golem is immune to any spell or effect that would alter its form. Such effects are not modeled." },
        { slug: "clay-golem-magic-resistance", name: "Magic Resistance", description: "Magic Resistance grants advantage on saving throws against spells and other magical effects; metadata only." },
        { slug: "clay-golem-magic-weapons", name: "Magic Weapons", description: "The golem's weapon attacks are magical. Damage-type resistance arithmetic is not modeled." },
      ],
      template: { slug: "clay-golem", name: "Clay Golem", maxHp: 133, defense: 14, speed: 20, attackBonus: 8, immunities: ["physical"] },
    }),
    defineMonster(refs, {
      cr: 9,
      attack: { abilitySlug: "cloud-giant-morningstar", name: "Cloud Giant Morningstar", damageType: "piercing", count: 3, sides: 8, modifier: 8 },
      traits: [
        { slug: "cloud-giant-multiattack", name: "Multiattack", description: "The cloud giant makes two morningstar attacks; only the single pinned morningstar is executable." },
        { slug: "cloud-giant-keen-smell", name: "Keen Smell", description: "Keen Smell grants advantage on Wisdom (Perception) checks that rely on smell; metadata only." },
        { slug: "cloud-giant-innate-spellcasting", name: "Innate Spellcasting", description: "The giant casts detect magic, fog cloud, light, and other spells using Charisma. Spell selection is not executable in this pack." },
      ],
      template: { slug: "cloud-giant", name: "Cloud Giant", maxHp: 200, defense: 14, speed: 40, attackBonus: 12 },
    }),
    defineMonster(refs, {
      cr: 9,
      attack: { abilitySlug: "fire-giant-greatsword", name: "Fire Giant Greatsword", damageType: "slashing", count: 6, sides: 6, modifier: 7 },
      traits: [
        { slug: "fire-giant-multiattack", name: "Multiattack", description: "The fire giant makes two greatsword attacks; only the single pinned greatsword is executable." },
      ],
      template: { slug: "fire-giant", name: "Fire Giant", maxHp: 162, defense: 18, speed: 30, attackBonus: 11, immunities: ["fire"] },
    }),
    defineMonster(refs, {
      cr: 9,
      attack: { abilitySlug: "glabrezu-pincer", name: "Glabrezu Pincer", damageType: "bludgeoning", count: 2, sides: 10, modifier: 5 },
      traits: [
        { slug: "glabrezu-multiattack", name: "Multiattack", description: "The glabrezu makes two pincer attacks and two fist attacks; only the single pinned pincer is executable." },
        { slug: "glabrezu-innate-spellcasting", name: "Innate Spellcasting", description: "The glabrezu casts detect magic, dispel magic, confusion, and other spells using Charisma. Spell selection is not executable in this pack." },
        { slug: "glabrezu-magic-resistance", name: "Magic Resistance", description: "Magic Resistance grants advantage on saving throws against spells and other magical effects; metadata only." },
      ],
      template: { slug: "glabrezu", name: "Glabrezu", maxHp: 157, defense: 17, speed: 40, attackBonus: 9, resistances: ["cold", "fire", "storm", "physical"] },
    }),
    defineMonster(refs, {
      cr: 9,
      attack: { abilitySlug: "treant-slam", name: "Treant Slam", damageType: "bludgeoning", count: 3, sides: 6, modifier: 6 },
      traits: [
        { slug: "treant-multiattack", name: "Multiattack", description: "The treant makes two slam attacks; only the single pinned slam is executable." },
        { slug: "treant-false-appearance", name: "False Appearance", description: "While motionless, the treant is indistinguishable from an ordinary tree. Presentation is metadata only." },
        { slug: "treant-siege-monster", name: "Siege Monster", description: "The treant deals double damage to objects and structures. Object damage is not modeled." },
      ],
      template: { slug: "treant", name: "Treant", maxHp: 138, defense: 16, speed: 30, attackBonus: 10, resistances: ["physical"], vulnerabilities: ["fire"] },
    }),
    defineMonster(refs, {
      cr: 9,
      attack: { abilitySlug: "young-blue-dragon-bite", name: "Young Blue Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 5 },
      traits: [
        { slug: "young-blue-dragon-multiattack", name: "Multiattack", description: "The dragon makes one bite and two claw attacks; only the single pinned bite is executable." },
        { slug: "young-blue-dragon-lightning-breath", name: "Lightning Breath", description: "Lightning Breath (recharge 5-6): a 60-foot line dealing lightning (storm) damage. Area breath weapons are not executable in this pack." },
      ],
      template: { slug: "young-blue-dragon", name: "Young Blue Dragon", maxHp: 152, defense: 18, speed: 40, attackBonus: 9, immunities: ["storm"] },
    }),
    defineMonster(refs, {
      cr: 9,
      attack: { abilitySlug: "young-silver-dragon-bite", name: "Young Silver Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 6 },
      traits: [
        { slug: "young-silver-dragon-multiattack", name: "Multiattack", description: "The dragon makes one bite and two claw attacks; only the single pinned bite is executable." },
        { slug: "young-silver-dragon-breath-weapons", name: "Breath Weapons", description: "Breath Weapons (recharge 5-6): a 30-foot cold cone or a 30-foot paralyzing cone. Area breath weapons and paralysis are not executable in this pack." },
      ],
      template: { slug: "young-silver-dragon", name: "Young Silver Dragon", maxHp: 168, defense: 18, speed: 40, attackBonus: 10, immunities: ["cold"] },
    }),
  ];

  return {
    abilities: monsters.flatMap((monster) => monster.abilities),
    enemies: monsters.map((monster) => monster.enemy),
  };
}
