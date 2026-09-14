import type { StarterReferences } from "../references.js";
import {
  monsterAttack,
  monsterTemplate,
  monsterTrait,
  type MonsterAttackSpec,
  type MonsterTemplateSpec,
} from "./enemyBuilder.js";

type Cr67Trait = { slug: string; name: string; description: string };

type Cr67Monster = {
  cr: 6 | 7;
  attack: MonsterAttackSpec;
  traits?: readonly Cr67Trait[];
  template: Omit<MonsterTemplateSpec, "cr" | "crTag" | "primaryAttack" | "traitRefs">;
};

/**
 * Defines one monster profile: a single executable basic attack plus bounded
 * trait metadata. Every monster carries its own CR so the band can mix CR 6 and
 * CR 7 while keeping the correct `crTag`.
 */
function defineMonster(refs: StarterReferences, monster: Cr67Monster) {
  const attack = monsterAttack(refs, monster.attack);
  const traits = (monster.traits ?? []).map((trait) => monsterTrait(refs, trait.slug, trait.name, trait.description));
  const enemy = monsterTemplate(refs, {
    ...monster.template,
    cr: monster.cr,
    crTag: monster.cr === 6 ? "cr-6" : "cr-7",
    primaryAttack: attack.reference,
    traitRefs: traits.map((trait) => trait.reference),
  });
  return { abilities: [attack, ...traits], enemy };
}

/**
 * Every SRD 5.1 monster whose challenge rating is 6 or 7. Each profile keeps one
 * executable basic attack selected so that its damage type is representable by
 * the bounded effect vocabulary; multiattack, breath weapons, spellcasting,
 * legendary-adjacent actions, and regeneration are carried as metadata tagged
 * `unsupported-runtime` because this pack does not model positioning, saving
 * throws, or per-turn attack sequences.
 */
export function cr6To7Band(refs: StarterReferences) {
  const monsters = [
    defineMonster(refs, {
      cr: 6,
      attack: { abilitySlug: "chimera-bite", name: "Chimera Bite", damageType: "piercing", count: 2, sides: 6, modifier: 4 },
      traits: [
        { slug: "chimera-multiattack", name: "Multiattack", description: "The chimera makes three attacks: one with its bite, one with its horns, and one with its claws; only the pinned bite is executable." },
        { slug: "chimera-fire-breath", name: "Fire Breath", description: "The dragon head exhales fire in a 15-foot cone (recharge 5-6); each creature must make a DC 15 Dexterity save, taking 7d8 fire damage on a failure. The area and save are metadata only." },
      ],
      template: { slug: "chimera", name: "Chimera", maxHp: 114, defense: 14, speed: 30, attackBonus: 7 },
    }),
    defineMonster(refs, {
      cr: 6,
      attack: { abilitySlug: "drider-longsword", name: "Drider Longsword", damageType: "slashing", count: 1, sides: 8, modifier: 3 },
      traits: [
        { slug: "drider-fey-ancestry", name: "Fey Ancestry", description: "The drider has advantage on saving throws against being charmed, and magic cannot put the drider to sleep. The advantage is metadata only." },
        { slug: "drider-innate-spellcasting", name: "Innate Spellcasting", description: "The drider's innate spellcasting is bounded metadata; spell selection is not executable in this pack." },
        { slug: "drider-spider-climb", name: "Spider Climb", description: "The drider can climb difficult surfaces, including upside down on ceilings, without an ability check. Grid movement is not modeled." },
        { slug: "drider-sunlight-sensitivity", name: "Sunlight Sensitivity", description: "While in sunlight, the drider has disadvantage on attack rolls and Wisdom (Perception) checks. Lighting is not modeled." },
        { slug: "drider-web-walker", name: "Web Walker", description: "The drider ignores movement restrictions caused by webbing. Movement is not modeled." },
        { slug: "drider-multiattack", name: "Multiattack", description: "The drider makes three attacks with its longsword or longbow, and can replace one with a bite; only the pinned longsword is executable." },
      ],
      template: { slug: "drider", name: "Drider", maxHp: 123, defense: 19, speed: 30, attackBonus: 6 },
    }),
    defineMonster(refs, {
      cr: 6,
      attack: { abilitySlug: "invisible-stalker-slam", name: "Invisible Stalker Slam", damageType: "bludgeoning", count: 2, sides: 6, modifier: 3 },
      traits: [
        { slug: "invisible-stalker-invisibility", name: "Invisibility", description: "The invisible stalker is invisible. Hidden states are not modeled, so this is metadata only." },
        { slug: "invisible-stalker-faultless-tracker", name: "Faultless Tracker", description: "The invisible stalker knows the direction and distance to its quarried target on the same plane. Tracking is not modeled." },
        { slug: "invisible-stalker-multiattack", name: "Multiattack", description: "The invisible stalker makes two slam attacks; only the single pinned slam is executable." },
      ],
      template: { slug: "invisible-stalker", name: "Invisible Stalker", maxHp: 104, defense: 14, speed: 50, attackBonus: 6, resistances: ["bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      cr: 6,
      attack: { abilitySlug: "mage-dagger", name: "Mage Dagger", damageType: "piercing", count: 1, sides: 4, modifier: 2 },
      traits: [
        { slug: "mage-spellcasting", name: "Spellcasting", description: "The mage is a 9th-level spellcaster (spell save DC 14) with a prepared spell list; monster spellcasting is bounded metadata only." },
      ],
      template: { slug: "mage", name: "Mage", maxHp: 40, defense: 12, speed: 30, attackBonus: 5 },
    }),
    defineMonster(refs, {
      cr: 6,
      attack: { abilitySlug: "mammoth-gore", name: "Mammoth Gore", damageType: "piercing", count: 4, sides: 8, modifier: 7 },
      traits: [
        { slug: "mammoth-trampling-charge", name: "Trampling Charge", description: "If the mammoth moves at least 20 feet straight toward a creature and hits with a gore attack, the target must make a DC 12 Strength save or be knocked prone. The charge is metadata only." },
        { slug: "mammoth-stomp", name: "Stomp", description: "The mammoth can stomp a prone creature for 4d10+7 bludgeoning damage; the prone gate is metadata only." },
      ],
      template: { slug: "mammoth", name: "Mammoth", maxHp: 126, defense: 13, speed: 40, attackBonus: 10 },
    }),
    defineMonster(refs, {
      cr: 6,
      attack: { abilitySlug: "medusa-shortsword", name: "Medusa Shortsword", damageType: "piercing", count: 1, sides: 6, modifier: 2 },
      traits: [
        { slug: "medusa-petrifying-gaze", name: "Petrifying Gaze", description: "A creature that starts its turn within 30 feet and can see the medusa's eyes must make a DC 14 Constitution save or begin turning to stone. The save and condition are metadata only." },
        { slug: "medusa-multiattack", name: "Multiattack", description: "The medusa makes three melee attacks (snake hair and two shortsword) or two longbow attacks; only the pinned shortsword is executable." },
      ],
      template: { slug: "medusa", name: "Medusa", maxHp: 127, defense: 15, speed: 30, attackBonus: 5 },
    }),
    defineMonster(refs, {
      cr: 6,
      attack: { abilitySlug: "vrock-beak", name: "Vrock Beak", damageType: "piercing", count: 2, sides: 6, modifier: 3 },
      traits: [
        { slug: "vrock-magic-resistance", name: "Magic Resistance", description: "The vrock has advantage on saving throws against spells and other magical effects. The advantage is metadata only." },
        { slug: "vrock-multiattack", name: "Multiattack", description: "The vrock makes two attacks: one with its beak and one with its talons; only the pinned beak is executable." },
        { slug: "vrock-spores", name: "Spores", description: "A 15-foot-radius cloud of toxic spores forces a DC 14 Constitution save and repeats poison damage each turn. The area and poison rider are metadata only." },
        { slug: "vrock-stunning-screech", name: "Stunning Screech", description: "Creatures within 20 feet that can hear the vrock must make a DC 14 Constitution save or be stunned for 1 minute. The save and condition are metadata only." },
      ],
      template: { slug: "vrock", name: "Vrock", maxHp: 104, defense: 15, speed: 40, attackBonus: 6, resistances: ["cold", "fire", "storm", "bludgeoning", "piercing", "slashing"] },
    }),
    defineMonster(refs, {
      cr: 6,
      attack: { abilitySlug: "wyvern-bite", name: "Wyvern Bite", damageType: "piercing", count: 2, sides: 6, modifier: 4 },
      traits: [
        { slug: "wyvern-multiattack", name: "Multiattack", description: "The wyvern makes two attacks: one with its bite and one with its stinger; while flying it can use its claws. Only the pinned bite is executable." },
      ],
      template: { slug: "wyvern", name: "Wyvern", maxHp: 110, defense: 13, speed: 20, attackBonus: 7 },
    }),
    defineMonster(refs, {
      cr: 6,
      attack: { abilitySlug: "young-brass-dragon-bite", name: "Young Brass Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 4 },
      traits: [
        { slug: "young-brass-dragon-multiattack", name: "Multiattack", description: "The dragon makes three attacks: one with its bite and two with its claws; only the pinned bite is executable." },
        { slug: "young-brass-dragon-breath-weapons", name: "Breath Weapons", description: "The dragon uses either a fire line or a sleep cone (recharge 5-6). The area breath weapons and their saves are metadata only." },
      ],
      template: { slug: "young-brass-dragon", name: "Young Brass Dragon", maxHp: 110, defense: 17, speed: 40, attackBonus: 7, immunities: ["fire"] },
    }),
    defineMonster(refs, {
      cr: 6,
      attack: { abilitySlug: "young-white-dragon-bite", name: "Young White Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 4 },
      traits: [
        { slug: "young-white-dragon-multiattack", name: "Multiattack", description: "The dragon makes three attacks: one with its bite and two with its claws; only the pinned bite is executable." },
        { slug: "young-white-dragon-ice-walk", name: "Ice Walk", description: "The dragon can move across and climb icy surfaces without an ability check. Movement is not modeled." },
        { slug: "young-white-dragon-cold-breath", name: "Cold Breath", description: "The dragon exhales an icy blast in a 30-foot cone (recharge 5-6); creatures must make a DC 15 Constitution save, taking 10d8 cold damage on a failure. The area and save are metadata only." },
      ],
      template: { slug: "young-white-dragon", name: "Young White Dragon", maxHp: 133, defense: 17, speed: 40, attackBonus: 7, immunities: ["cold"] },
    }),
    defineMonster(refs, {
      cr: 7,
      attack: { abilitySlug: "giant-ape-fist", name: "Giant Ape Fist", damageType: "bludgeoning", count: 3, sides: 10, modifier: 6 },
      traits: [
        { slug: "giant-ape-multiattack", name: "Multiattack", description: "The giant ape makes two fist attacks; only the single pinned fist is executable." },
      ],
      template: { slug: "giant-ape", name: "Giant Ape", maxHp: 157, defense: 12, speed: 40, attackBonus: 9 },
    }),
    defineMonster(refs, {
      cr: 7,
      attack: { abilitySlug: "oni-glaive", name: "Oni Glaive", damageType: "slashing", count: 2, sides: 10, modifier: 4 },
      traits: [
        { slug: "oni-innate-spellcasting", name: "Innate Spellcasting", description: "The oni's innate spellcasting (spell save DC 13) is bounded metadata; spell selection is not executable in this pack." },
        { slug: "oni-magic-weapons", name: "Magic Weapons", description: "The oni's weapon attacks are magical. Damage-type interactions are not modeled." },
        { slug: "oni-regeneration", name: "Regeneration", description: "The oni regains 10 hit points at the start of its turn if it has at least 1 hit point. The regeneration is metadata only." },
        { slug: "oni-change-shape", name: "Change Shape", description: "The oni can magically polymorph into a Small or Medium humanoid or a Large giant. Alternate forms are not executable in this pack." },
        { slug: "oni-multiattack", name: "Multiattack", description: "The oni makes two attacks with its claws or its glaive; only the pinned glaive is executable." },
      ],
      template: { slug: "oni", name: "Oni", maxHp: 110, defense: 16, speed: 30, attackBonus: 7 },
    }),
    defineMonster(refs, {
      cr: 7,
      attack: { abilitySlug: "shield-guardian-fist", name: "Shield Guardian Fist", damageType: "bludgeoning", count: 2, sides: 6, modifier: 4 },
      traits: [
        { slug: "shield-guardian-bound", name: "Bound", description: "The shield guardian is magically bound to an amulet and shares a telepathic link with its wearer. The bond is metadata only." },
        { slug: "shield-guardian-regeneration", name: "Regeneration", description: "The shield guardian regains 10 hit points at the start of its turn if it has at least 1 hit point. The regeneration is metadata only." },
        { slug: "shield-guardian-spell-storing", name: "Spell Storing", description: "The amulet's wearer can cause the guardian to store one spell of 4th level or lower. Spell storage is not executable in this pack." },
        { slug: "shield-guardian-multiattack", name: "Multiattack", description: "The shield guardian makes two fist attacks; only the single pinned fist is executable." },
      ],
      template: { slug: "shield-guardian", name: "Shield Guardian", maxHp: 142, defense: 17, speed: 30, attackBonus: 7 },
    }),
    defineMonster(refs, {
      cr: 7,
      attack: { abilitySlug: "stone-giant-greatclub", name: "Stone Giant Greatclub", damageType: "bludgeoning", count: 3, sides: 8, modifier: 6 },
      traits: [
        { slug: "stone-giant-stone-camouflage", name: "Stone Camouflage", description: "The giant has advantage on Dexterity (Stealth) checks made to hide in rocky terrain. The advantage is metadata only." },
        { slug: "stone-giant-multiattack", name: "Multiattack", description: "The giant makes two greatclub attacks; only the single pinned greatclub is executable." },
      ],
      template: { slug: "stone-giant", name: "Stone Giant", maxHp: 126, defense: 17, speed: 40, attackBonus: 9 },
    }),
    defineMonster(refs, {
      cr: 7,
      attack: { abilitySlug: "young-black-dragon-bite", name: "Young Black Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 4 },
      traits: [
        { slug: "young-black-dragon-amphibious", name: "Amphibious", description: "The dragon can breathe air and water. Not executable at runtime." },
        { slug: "young-black-dragon-acid-breath", name: "Acid Breath", description: "The dragon exhales acid in a 30-foot line (recharge 5-6); creatures must make a DC 14 Dexterity save, taking 11d8 acid damage on a failure. The area and save are metadata only." },
        { slug: "young-black-dragon-multiattack", name: "Multiattack", description: "The dragon makes three attacks: one with its bite and two with its claws; only the pinned bite is executable." },
      ],
      template: { slug: "young-black-dragon", name: "Young Black Dragon", maxHp: 127, defense: 18, speed: 40, attackBonus: 7 },
    }),
    defineMonster(refs, {
      cr: 7,
      attack: { abilitySlug: "young-copper-dragon-bite", name: "Young Copper Dragon Bite", damageType: "piercing", count: 2, sides: 10, modifier: 4 },
      traits: [
        { slug: "young-copper-dragon-multiattack", name: "Multiattack", description: "The dragon makes three attacks: one with its bite and two with its claws; only the pinned bite is executable." },
        { slug: "young-copper-dragon-breath-weapons", name: "Breath Weapons", description: "The dragon uses either an acid line or a slowing cone (recharge 5-6). The area breath weapons and their saves are metadata only." },
      ],
      template: { slug: "young-copper-dragon", name: "Young Copper Dragon", maxHp: 119, defense: 17, speed: 40, attackBonus: 7 },
    }),
  ];

  return {
    abilities: monsters.flatMap((monster) => monster.abilities),
    enemies: monsters.map((monster) => monster.enemy),
  };
}
