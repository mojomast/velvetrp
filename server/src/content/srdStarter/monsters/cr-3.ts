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
 * SRD 5.1 challenge-rating-3 monster band. Each profile keeps one executable
 * basic melee attack plus bounded trait markers for notable passives,
 * multiattacks, breath weapons, and other non-executable actions. Damage types
 * outside the bounded vocabulary (acid, poison, necrotic, psychic, thunder) are
 * omitted rather than remapped; lightning is mapped to storm.
 */
export function cr3Band(refs: StarterReferences): MonsterBand {
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
    { abilitySlug: "basilisk-bite", name: "Basilisk Bite", damageType: "piercing", count: 2, sides: 6, modifier: 3 },
    [{ slug: "basilisk-petrifying-gaze", name: "Petrifying Gaze", description: "A creature starting its turn within 30 feet that can see the basilisk must make a DC 12 Constitution save or begin turning to stone; the gaze is metadata only." }],
    { slug: "basilisk", name: "Basilisk", cr: 3, crTag: "cr-3", maxHp: 52, defense: 15, speed: 20, attackBonus: 5 },
  );

  define(
    { abilitySlug: "bearded-devil-glaive", name: "Bearded Devil Glaive", damageType: "slashing", count: 1, sides: 10, modifier: 3 },
    [
      { slug: "bearded-devil-multiattack", name: "Multiattack", description: "The devil makes two attacks: one with its beard and one with its glaive." },
      { slug: "bearded-devil-beard", name: "Beard", description: "Melee attack dealing 1d8 + 2 piercing damage with a DC 12 Constitution save against poison; the poison damage and disease rider are not executable." },
      { slug: "bearded-devil-devils-sight", name: "Devil's Sight", description: "Magical darkness does not impede the devil's darkvision." },
      { slug: "bearded-devil-magic-resistance", name: "Magic Resistance", description: "The devil has advantage on saving throws against spells and other magical effects." },
      { slug: "bearded-devil-steadfast", name: "Steadfast", description: "The devil cannot be frightened while it can see an allied creature within 30 feet." },
    ],
    { slug: "bearded-devil", name: "Bearded Devil", cr: 3, crTag: "cr-3", maxHp: 52, defense: 13, speed: 30, attackBonus: 5, resistances: ["cold", "physical"], immunities: ["fire"] },
  );

  define(
    { abilitySlug: "blue-dragon-wyrmling-bite", name: "Blue Dragon Wyrmling Bite", damageType: "piercing", count: 1, sides: 10, modifier: 3 },
    [{ slug: "blue-dragon-wyrmling-lightning-breath", name: "Lightning Breath", description: "The wyrmling exhales lightning in a 30-foot line (DC 12 Dexterity save, 4d10 lightning); the area breath attack is metadata only." }],
    { slug: "blue-dragon-wyrmling", name: "Blue Dragon Wyrmling", cr: 3, crTag: "cr-3", maxHp: 52, defense: 17, speed: 30, attackBonus: 5, immunities: ["storm"] },
  );

  define(
    { abilitySlug: "doppelganger-slam", name: "Doppelganger Slam", damageType: "bludgeoning", count: 1, sides: 6, modifier: 4 },
    [
      { slug: "doppelganger-multiattack", name: "Multiattack", description: "The doppelganger makes two melee attacks." },
      { slug: "doppelganger-shapechanger", name: "Shapechanger", description: "The doppelganger can polymorph into a Small or Medium humanoid it has seen; form changes are not modeled." },
      { slug: "doppelganger-ambusher", name: "Ambusher", description: "The doppelganger has advantage on attack rolls against any creature it has surprised." },
      { slug: "doppelganger-surprise-attack", name: "Surprise Attack", description: "A surprised target hit during the first round takes an extra 3d6 damage; the rider is metadata only." },
      { slug: "doppelganger-read-thoughts", name: "Read Thoughts", description: "The doppelganger magically reads surface thoughts within 60 feet; detection is not executable." },
    ],
    { slug: "doppelganger", name: "Doppelganger", cr: 3, crTag: "cr-3", maxHp: 52, defense: 14, speed: 30, attackBonus: 6 },
  );

  define(
    { abilitySlug: "giant-scorpion-sting", name: "Giant Scorpion Sting", damageType: "piercing", count: 1, sides: 10, modifier: 2 },
    [
      { slug: "giant-scorpion-multiattack", name: "Multiattack", description: "The scorpion makes three attacks: two with its claws and one with its sting." },
      { slug: "giant-scorpion-claw", name: "Claw", description: "Melee attack dealing 1d8 + 2 bludgeoning damage and grappling the target (escape DC 12); the grapple is metadata only." },
    ],
    { slug: "giant-scorpion", name: "Giant Scorpion", cr: 3, crTag: "cr-3", maxHp: 52, defense: 15, speed: 40, attackBonus: 4 },
  );

  define(
    { abilitySlug: "gold-dragon-wyrmling-bite", name: "Gold Dragon Wyrmling Bite", damageType: "piercing", count: 1, sides: 10, modifier: 4 },
    [
      { slug: "gold-dragon-wyrmling-breath-weapons", name: "Breath Weapons", description: "The wyrmling uses Fire Breath or Sleep Breath; the cone/area breath attacks are metadata only." },
      { slug: "gold-dragon-wyrmling-amphibious", name: "Amphibious", description: "The dragon can breathe air and water." },
    ],
    { slug: "gold-dragon-wyrmling", name: "Gold Dragon Wyrmling", cr: 3, crTag: "cr-3", maxHp: 60, defense: 17, speed: 30, attackBonus: 6, immunities: ["fire"] },
  );

  define(
    { abilitySlug: "green-hag-claws", name: "Green Hag Claws", damageType: "slashing", count: 2, sides: 8, modifier: 4 },
    [
      { slug: "green-hag-innate-spellcasting", name: "Innate Spellcasting", description: "The hag's innate spellcasting (Charisma, DC 12) and its spell list are metadata only." },
      { slug: "green-hag-mimicry", name: "Mimicry", description: "The hag can mimic animal sounds and humanoid voices; a listener can tell they are imitations with a successful DC 14 Wisdom check." },
      { slug: "green-hag-invisible-passage", name: "Invisible Passage", description: "The hag magically turns invisible until she attacks or casts a spell; invisibility is not modeled." },
      { slug: "green-hag-amphibious", name: "Amphibious", description: "The hag can breathe air and water." },
    ],
    { slug: "green-hag", name: "Green Hag", cr: 3, crTag: "cr-3", maxHp: 82, defense: 17, speed: 30, attackBonus: 6 },
  );

  define(
    { abilitySlug: "hell-hound-bite", name: "Hell Hound Bite", damageType: "piercing", count: 1, sides: 8, modifier: 3 },
    [
      { slug: "hell-hound-fire-breath", name: "Fire Breath", description: "The hound exhales fire in a 15-foot cone (DC 12 Dexterity save, 6d6 fire); the area breath attack is metadata only." },
      { slug: "hell-hound-pack-tactics", name: "Pack Tactics", description: "The hound has advantage on an attack roll when an active ally is within 5 feet of the target." },
      { slug: "hell-hound-keen-hearing-and-smell", name: "Keen Hearing and Smell", description: "The hound has advantage on Wisdom (Perception) checks that rely on hearing or smell." },
    ],
    { slug: "hell-hound", name: "Hell Hound", cr: 3, crTag: "cr-3", maxHp: 45, defense: 15, speed: 50, attackBonus: 5, immunities: ["fire"] },
  );

  define(
    { abilitySlug: "killer-whale-bite", name: "Killer Whale Bite", damageType: "piercing", count: 5, sides: 6, modifier: 4 },
    [
      { slug: "killer-whale-echolocation", name: "Echolocation", description: "The whale cannot use its blindsight while deafened." },
      { slug: "killer-whale-hold-breath", name: "Hold Breath", description: "The whale can hold its breath for 30 minutes." },
      { slug: "killer-whale-keen-hearing", name: "Keen Hearing", description: "The whale has advantage on Wisdom (Perception) checks that rely on hearing." },
    ],
    { slug: "killer-whale", name: "Killer Whale", cr: 3, crTag: "cr-3", maxHp: 90, defense: 12, speed: 60, attackBonus: 6 },
  );

  define(
    { abilitySlug: "knight-greatsword", name: "Knight Greatsword", damageType: "slashing", count: 2, sides: 6, modifier: 3 },
    [
      { slug: "knight-multiattack", name: "Multiattack", description: "The knight makes two melee attacks." },
      { slug: "knight-parry", name: "Parry", description: "The knight adds 2 to its AC against one melee attack when it can see the attacker and wields a melee weapon." },
      { slug: "knight-leadership", name: "Leadership", description: "The knight can bolster allies within 30 feet for 1 minute; the morale bonus is metadata only." },
      { slug: "knight-brave", name: "Brave", description: "The knight has advantage on saving throws against being frightened." },
    ],
    { slug: "knight", name: "Knight", cr: 3, crTag: "cr-3", maxHp: 52, defense: 18, speed: 30, attackBonus: 5 },
  );

  define(
    { abilitySlug: "manticore-bite", name: "Manticore Bite", damageType: "piercing", count: 1, sides: 8, modifier: 3 },
    [
      { slug: "manticore-multiattack", name: "Multiattack", description: "The manticore makes three attacks: one with its bite and two with its claws, or three with its tail spikes." },
      { slug: "manticore-claw", name: "Claw", description: "Melee attack dealing 1d6 + 3 slashing damage; the second and third attacks of the multiattack are metadata only." },
      { slug: "manticore-tail-spike", name: "Tail Spike", description: "Ranged attack dealing 1d8 + 3 piercing damage; the ranged attack is metadata only." },
      { slug: "manticore-tail-spike-regrowth", name: "Tail Spike Regrowth", description: "The manticore has twenty-four tail spikes that regrow after a long rest." },
    ],
    { slug: "manticore", name: "Manticore", cr: 3, crTag: "cr-3", maxHp: 68, defense: 14, speed: 30, attackBonus: 5 },
  );

  define(
    { abilitySlug: "minotaur-greataxe", name: "Minotaur Greataxe", damageType: "slashing", count: 2, sides: 12, modifier: 4 },
    [
      { slug: "minotaur-charge", name: "Charge", description: "If the minotaur moves at least 10 feet straight toward a target and hits with a gore attack, the target takes an extra 3d8 piercing damage and may be knocked prone; the rider is metadata only." },
      { slug: "minotaur-reckless", name: "Reckless", description: "The minotaur can gain advantage on all melee weapon attack rolls during its turn while granting advantage to attackers." },
      { slug: "minotaur-labyrinthine-recall", name: "Labyrinthine Recall", description: "The minotaur can perfectly recall any path it has traveled." },
    ],
    { slug: "minotaur", name: "Minotaur", cr: 3, crTag: "cr-3", maxHp: 76, defense: 14, speed: 40, attackBonus: 6 },
  );

  define(
    { abilitySlug: "mummy-rotting-fist", name: "Mummy Rotting Fist", damageType: "bludgeoning", count: 2, sides: 6, modifier: 3 },
    [
      { slug: "mummy-multiattack", name: "Multiattack", description: "The mummy can use its Dreadful Glare and makes one attack with its rotting fist." },
      { slug: "mummy-dreadful-glare", name: "Dreadful Glare", description: "One creature within 60 feet that can see the mummy must make a DC 11 Wisdom save or be frightened; the fear effect is metadata only." },
    ],
    { slug: "mummy", name: "Mummy", cr: 3, crTag: "cr-3", maxHp: 58, defense: 11, speed: 20, attackBonus: 5, resistances: ["physical"], vulnerabilities: ["fire"] },
  );

  define(
    { abilitySlug: "nightmare-hooves", name: "Nightmare Hooves", damageType: "bludgeoning", count: 2, sides: 8, modifier: 4 },
    [
      { slug: "nightmare-ethereal-stride", name: "Ethereal Stride", description: "The nightmare and up to three willing creatures within 5 feet can enter the Ethereal Plane; plane shifting is not modeled." },
      { slug: "nightmare-confer-fire-resistance", name: "Confer Fire Resistance", description: "The nightmare can grant resistance to fire damage to anyone riding it." },
      { slug: "nightmare-illumination", name: "Illumination", description: "The nightmare sheds bright light in a 10-foot radius and dim light for an additional 10 feet." },
    ],
    { slug: "nightmare", name: "Nightmare", cr: 3, crTag: "cr-3", maxHp: 68, defense: 13, speed: 60, attackBonus: 6, immunities: ["fire"] },
  );

  define(
    { abilitySlug: "owlbear-claws", name: "Owlbear Claws", damageType: "slashing", count: 2, sides: 8, modifier: 5 },
    [
      { slug: "owlbear-multiattack", name: "Multiattack", description: "The owlbear makes two attacks: one with its beak and one with its claws." },
      { slug: "owlbear-keen-sight-and-smell", name: "Keen Sight and Smell", description: "The owlbear has advantage on Wisdom (Perception) checks that rely on sight or smell." },
    ],
    { slug: "owlbear", name: "Owlbear", cr: 3, crTag: "cr-3", maxHp: 59, defense: 13, speed: 40, attackBonus: 7 },
  );

  define(
    { abilitySlug: "phase-spider-bite", name: "Phase Spider Bite", damageType: "piercing", count: 1, sides: 10, modifier: 2 },
    [
      { slug: "phase-spider-ethereal-jaunt", name: "Ethereal Jaunt", description: "As a bonus action, the spider can shift from the Material Plane to the Ethereal Plane or back; plane shifting is metadata only." },
      { slug: "phase-spider-spider-climb", name: "Spider Climb", description: "The spider can climb difficult surfaces, including ceilings, without an ability check." },
      { slug: "phase-spider-web-walker", name: "Web Walker", description: "The spider ignores movement restrictions caused by webbing." },
    ],
    { slug: "phase-spider", name: "Phase Spider", cr: 3, crTag: "cr-3", maxHp: 32, defense: 13, speed: 30, attackBonus: 4 },
  );

  define(
    { abilitySlug: "veteran-longsword", name: "Veteran Longsword", damageType: "slashing", count: 1, sides: 8, modifier: 3 },
    [
      { slug: "veteran-multiattack", name: "Multiattack", description: "The veteran makes two longsword attacks, and can make a shortsword attack if one is drawn." },
      { slug: "veteran-heavy-crossbow", name: "Heavy Crossbow", description: "Ranged attack dealing 1d10 + 1 piercing damage; the ranged attack is metadata only." },
      { slug: "veteran-shortsword", name: "Shortsword", description: "Melee attack dealing 1d6 + 3 piercing damage; the additional shortsword attack is metadata only." },
    ],
    { slug: "veteran", name: "Veteran", cr: 3, crTag: "cr-3", maxHp: 58, defense: 17, speed: 30, attackBonus: 5 },
  );

  define(
    { abilitySlug: "werewolf-bite", name: "Werewolf Bite", damageType: "piercing", count: 1, sides: 8, modifier: 2 },
    [
      { slug: "werewolf-multiattack", name: "Multiattack", description: "The werewolf makes two attacks: two with its spear (humanoid form) or one with its bite and one with its claws (hybrid form)." },
      { slug: "werewolf-shapechanger", name: "Shapechanger", description: "The werewolf can polymorph into a wolf-humanoid hybrid or a wolf; form changes are not modeled." },
      { slug: "werewolf-keen-hearing-and-smell", name: "Keen Hearing and Smell", description: "The werewolf has advantage on Wisdom (Perception) checks that rely on hearing or smell." },
    ],
    { slug: "werewolf", name: "Werewolf", cr: 3, crTag: "cr-3", maxHp: 58, defense: 11, speed: 30, attackBonus: 4, immunities: ["physical"] },
  );

  define(
    { abilitySlug: "wight-longsword", name: "Wight Longsword", damageType: "slashing", count: 1, sides: 8, modifier: 2 },
    [
      { slug: "wight-multiattack", name: "Multiattack", description: "The wight makes two longsword attacks or two longbow attacks, and can use Life Drain in place of one longsword attack." },
      { slug: "wight-life-drain", name: "Life Drain", description: "Melee attack dealing 1d6 + 2 necrotic damage and a DC 13 Constitution save against reduced hit point maximum; the necrotic rider is not representable and is metadata only." },
      { slug: "wight-sunlight-sensitivity", name: "Sunlight Sensitivity", description: "While in sunlight, the wight has disadvantage on attack rolls and sight-based Wisdom (Perception) checks." },
    ],
    { slug: "wight", name: "Wight", cr: 3, crTag: "cr-3", maxHp: 45, defense: 14, speed: 30, attackBonus: 4, immunities: ["physical"] },
  );

  define(
    { abilitySlug: "winter-wolf-bite", name: "Winter Wolf Bite", damageType: "piercing", count: 2, sides: 6, modifier: 4 },
    [
      { slug: "winter-wolf-cold-breath", name: "Cold Breath", description: "The wolf exhales freezing wind in a 15-foot cone (DC 12 Dexterity save, 4d8 cold); the area breath attack is metadata only." },
      { slug: "winter-wolf-pack-tactics", name: "Pack Tactics", description: "The wolf has advantage on an attack roll when an active ally is within 5 feet of the target." },
      { slug: "winter-wolf-snow-camouflage", name: "Snow Camouflage", description: "The wolf has advantage on Dexterity (Stealth) checks made to hide in snowy terrain." },
    ],
    { slug: "winter-wolf", name: "Winter Wolf", cr: 3, crTag: "cr-3", maxHp: 75, defense: 13, speed: 50, attackBonus: 6, immunities: ["cold"] },
  );

  return { abilities, enemies };
}
