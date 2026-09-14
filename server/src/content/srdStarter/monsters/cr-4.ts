import type { StarterReferences } from "../references.js";
import {
  monsterAttack,
  monsterTrait,
  monsterTemplate,
  type MonsterBand,
} from "./enemyBuilder.js";

/**
 * SRD 5.1 Challenge Rating 4 monsters as bounded starter catalog content. Each
 * creature's basic melee attack is the single executable action; multiattacks,
 * spellcasting, shapechanging, breath weapons, and similar complex actions are
 * carried as metadata-only traits. Damage types outside the bounded vocabulary
 * (acid, poison, necrotic, psychic, thunder) are omitted rather than remapped.
 */
export function cr4Band(refs: StarterReferences): MonsterBand {
  const abilities: object[] = [];
  const enemies: object[] = [];

  const attack = (spec: Parameters<typeof monsterAttack>[1]) => {
    const ability = monsterAttack(refs, spec);
    abilities.push(ability);
    return ability;
  };
  const trait = (slug: string, name: string, description: string) => {
    const marker = monsterTrait(refs, slug, name, description);
    abilities.push(marker);
    return marker;
  };
  const enemy = (spec: Parameters<typeof monsterTemplate>[1]) => {
    const template = monsterTemplate(refs, spec);
    enemies.push(template);
    return template;
  };

  const blackPuddingPseudopod = attack({
    abilitySlug: "black-pudding-pseudopod",
    name: "Black Pudding Pseudopod",
    damageType: "bludgeoning",
    count: 1,
    sides: 6,
    modifier: 3,
  });
  const blackPuddingAmorphous = trait(
    "black-pudding-amorphous",
    "Amorphous",
    "Black Pudding trait metadata: the ooze can move through a narrow space and is not modeled in the bounded runtime.",
  );
  const blackPuddingCorrosiveForm = trait(
    "black-pudding-corrosive-form",
    "Corrosive Form",
    "Black Pudding Corrosive Form metadata; acid damage to attackers and the object-destroying rider are not executable.",
  );
  const blackPuddingSpiderClimb = trait(
    "black-pudding-spider-climb",
    "Spider Climb",
    "Black Pudding Spider Climb metadata; grid movement and climbing surfaces are not modeled.",
  );
  enemy({
    slug: "black-pudding",
    name: "Black Pudding",
    cr: 4,
    crTag: "cr-4",
    maxHp: 85,
    defense: 7,
    speed: 20,
    attackBonus: 5,
    primaryAttack: blackPuddingPseudopod.reference,
    traitRefs: [blackPuddingAmorphous.reference, blackPuddingCorrosiveForm.reference, blackPuddingSpiderClimb.reference],
    immunities: ["cold", "storm", "slashing"],
  });

  const chuulPincer = attack({
    abilitySlug: "chuul-pincer",
    name: "Chuul Pincer",
    damageType: "bludgeoning",
    count: 2,
    sides: 6,
    modifier: 4,
  });
  const chuulAmphibious = trait(
    "chuul-amphibious",
    "Amphibious",
    "Chuul trait metadata: the creature can breathe air and water; water breathing is not modeled.",
  );
  const chuulSenseMagic = trait(
    "chuul-sense-magic",
    "Sense Magic",
    "Chuul trait metadata: the creature senses magic within 120 feet; detection is not executable.",
  );
  const chuulMultiattack = trait(
    "chuul-multiattack",
    "Multiattack",
    "Chuul action metadata: the SRD multiattack (two pincer attacks) is not executable; only the pinned Pincer attack is used.",
  );
  enemy({
    slug: "chuul",
    name: "Chuul",
    cr: 4,
    crTag: "cr-4",
    maxHp: 93,
    defense: 16,
    speed: 30,
    attackBonus: 6,
    primaryAttack: chuulPincer.reference,
    traitRefs: [chuulAmphibious.reference, chuulSenseMagic.reference, chuulMultiattack.reference],
  });

  const couatlBite = attack({
    abilitySlug: "couatl-bite",
    name: "Couatl Bite",
    damageType: "piercing",
    count: 1,
    sides: 6,
    modifier: 5,
  });
  const couatlInnateSpellcasting = trait(
    "couatl-innate-spellcasting",
    "Innate Spellcasting",
    "Couatl spellcasting metadata; the innate spell list and spell attacks are not executable in this bounded pack.",
  );
  const couatlMagicWeapons = trait(
    "couatl-magic-weapons",
    "Magic Weapons",
    "Couatl trait metadata: its weapon attacks count as magical; the runtime does not model damage reduction.",
  );
  const couatlShieldedMind = trait(
    "couatl-shielded-mind",
    "Shielded Mind",
    "Couatl trait metadata: mind reading and scrying are blocked; divination is not modeled.",
  );
  enemy({
    slug: "couatl",
    name: "Couatl",
    cr: 4,
    crTag: "cr-4",
    maxHp: 97,
    defense: 19,
    speed: 30,
    attackBonus: 8,
    primaryAttack: couatlBite.reference,
    traitRefs: [couatlInnateSpellcasting.reference, couatlMagicWeapons.reference, couatlShieldedMind.reference],
    resistances: ["radiant"],
    immunities: ["physical"],
  });

  const elephantGore = attack({
    abilitySlug: "elephant-gore",
    name: "Elephant Gore",
    damageType: "piercing",
    count: 3,
    sides: 8,
    modifier: 6,
  });
  const elephantTramplingCharge = trait(
    "elephant-trampling-charge",
    "Trampling Charge",
    "Elephant trait metadata: the charge, knock-prone, and bonus stomp sequence is not executable.",
  );
  enemy({
    slug: "elephant",
    name: "Elephant",
    cr: 4,
    crTag: "cr-4",
    maxHp: 76,
    defense: 12,
    speed: 40,
    attackBonus: 8,
    primaryAttack: elephantGore.reference,
    traitRefs: [elephantTramplingCharge.reference],
  });

  const ettinBattleaxe = attack({
    abilitySlug: "ettin-battleaxe",
    name: "Ettin Battleaxe",
    damageType: "slashing",
    count: 2,
    sides: 8,
    modifier: 5,
  });
  const ettinTwoHeads = trait(
    "ettin-two-heads",
    "Two Heads",
    "Ettin trait metadata: advantage on sight and hearing checks and multi-head wakefulness are not modeled.",
  );
  const ettinWakeful = trait(
    "ettin-wakeful",
    "Wakeful",
    "Ettin trait metadata: one head stays awake while the other sleeps; rest behavior is not modeled.",
  );
  const ettinMultiattack = trait(
    "ettin-multiattack",
    "Multiattack",
    "Ettin action metadata: the SRD multiattack (one battleaxe and one morningstar attack) is not executable.",
  );
  enemy({
    slug: "ettin",
    name: "Ettin",
    cr: 4,
    crTag: "cr-4",
    maxHp: 85,
    defense: 12,
    speed: 40,
    attackBonus: 7,
    primaryAttack: ettinBattleaxe.reference,
    traitRefs: [ettinTwoHeads.reference, ettinWakeful.reference, ettinMultiattack.reference],
  });

  const ghostWitheringTouch = attack({
    abilitySlug: "ghost-withering-touch",
    name: "Ghost Withering Touch",
    damageType: "shadow",
    count: 4,
    sides: 6,
    modifier: 3,
  });
  const ghostEtherealSight = trait(
    "ghost-ethereal-sight",
    "Ethereal Sight",
    "Ghost trait metadata: the ability to see into the Ethereal Plane is not modeled.",
  );
  const ghostIncorporealMovement = trait(
    "ghost-incorporeal-movement",
    "Incorporeal Movement",
    "Ghost trait metadata: passing through creatures and objects is not modeled; grid movement is bounded.",
  );
  const ghostHorrifyingVisage = trait(
    "ghost-horrifying-visage",
    "Horrifying Visage",
    "Ghost action metadata: the fear and aging effect is not executable.",
  );
  const ghostPossession = trait(
    "ghost-possession",
    "Possession",
    "Ghost action metadata: possession of a humanoid is not executable in this bounded pack.",
  );
  enemy({
    slug: "ghost",
    name: "Ghost",
    cr: 4,
    crTag: "cr-4",
    maxHp: 45,
    defense: 11,
    speed: 40,
    attackBonus: 5,
    primaryAttack: ghostWitheringTouch.reference,
    traitRefs: [ghostEtherealSight.reference, ghostIncorporealMovement.reference, ghostHorrifyingVisage.reference, ghostPossession.reference],
    resistances: ["fire", "storm", "physical"],
    immunities: ["cold"],
  });

  const lamiaClaws = attack({
    abilitySlug: "lamia-claws",
    name: "Lamia Claws",
    damageType: "slashing",
    count: 2,
    sides: 10,
    modifier: 3,
  });
  const lamiaInnateSpellcasting = trait(
    "lamia-innate-spellcasting",
    "Innate Spellcasting",
    "Lamia spellcasting metadata; the innate spell list and spell attacks are not executable in this bounded pack.",
  );
  const lamiaMultiattack = trait(
    "lamia-multiattack",
    "Multiattack",
    "Lamia action metadata: the SRD multiattack (claws plus dagger or intoxicating touch) is not executable.",
  );
  const lamiaIntoxicatingTouch = trait(
    "lamia-intoxicating-touch",
    "Intoxicating Touch",
    "Lamia action metadata: the curse effect is not executable; only the pinned Claws attack is used.",
  );
  enemy({
    slug: "lamia",
    name: "Lamia",
    cr: 4,
    crTag: "cr-4",
    maxHp: 97,
    defense: 13,
    speed: 30,
    attackBonus: 5,
    primaryAttack: lamiaClaws.reference,
    traitRefs: [lamiaInnateSpellcasting.reference, lamiaMultiattack.reference, lamiaIntoxicatingTouch.reference],
  });

  const redDragonWyrmlingBite = attack({
    abilitySlug: "red-dragon-wyrmling-bite",
    name: "Red Dragon Wyrmling Bite",
    damageType: "piercing",
    count: 1,
    sides: 10,
    modifier: 4,
  });
  const redDragonWyrmlingFireBreath = trait(
    "red-dragon-wyrmling-fire-breath",
    "Fire Breath",
    "Red Dragon Wyrmling action metadata: the recharge fire-breath cone and its saving throw are not executable.",
  );
  enemy({
    slug: "red-dragon-wyrmling",
    name: "Red Dragon Wyrmling",
    cr: 4,
    crTag: "cr-4",
    maxHp: 75,
    defense: 17,
    speed: 30,
    attackBonus: 6,
    primaryAttack: redDragonWyrmlingBite.reference,
    traitRefs: [redDragonWyrmlingFireBreath.reference],
    immunities: ["fire"],
  });

  const succubusIncubusClaw = attack({
    abilitySlug: "succubus-incubus-claw",
    name: "Succubus/Incubus Claw",
    damageType: "slashing",
    count: 1,
    sides: 6,
    modifier: 3,
  });
  const succubusIncubusShapechanger = trait(
    "succubus-incubus-shapechanger",
    "Shapechanger",
    "Succubus/Incubus trait metadata: form changes and their stat adjustments are not executable.",
  );
  const succubusIncubusTelepathicBond = trait(
    "succubus-incubus-telepathic-bond",
    "Telepathic Bond",
    "Succubus/Incubus trait metadata: the telepathic link with its master is not modeled.",
  );
  const succubusIncubusCharm = trait(
    "succubus-incubus-charm",
    "Charm",
    "Succubus/Incubus action metadata: the charm and telepathic control effect is not executable.",
  );
  const succubusIncubusDrainingKiss = trait(
    "succubus-incubus-draining-kiss",
    "Draining Kiss",
    "Succubus/Incubus action metadata: the psychic draining kiss is not executable and is not remapped to a bounded damage type.",
  );
  enemy({
    slug: "succubus-incubus",
    name: "Succubus/Incubus",
    cr: 4,
    crTag: "cr-4",
    maxHp: 66,
    defense: 15,
    speed: 30,
    attackBonus: 5,
    primaryAttack: succubusIncubusClaw.reference,
    traitRefs: [succubusIncubusShapechanger.reference, succubusIncubusTelepathicBond.reference, succubusIncubusCharm.reference, succubusIncubusDrainingKiss.reference],
    resistances: ["cold", "fire", "storm", "physical"],
  });

  const wereboarMaul = attack({
    abilitySlug: "wereboar-maul",
    name: "Wereboar Maul",
    damageType: "bludgeoning",
    count: 2,
    sides: 6,
    modifier: 3,
  });
  const wereboarShapechanger = trait(
    "wereboar-shapechanger",
    "Shapechanger",
    "Wereboar trait metadata: boar, hybrid, and humanoid forms are not modeled; the hybrid profile is used.",
  );
  const wereboarCharge = trait(
    "wereboar-charge",
    "Charge",
    "Wereboar trait metadata: the charge and knock-prone attack rider is not executable.",
  );
  const wereboarRelentless = trait(
    "wereboar-relentless",
    "Relentless",
    "Wereboar trait metadata: the recharge ability that drops it to one hit point instead of zero is not executable.",
  );
  const wereboarMultiattack = trait(
    "wereboar-multiattack",
    "Multiattack",
    "Wereboar action metadata: the SRD multiattack (maul or two tusk attacks) is not executable.",
  );
  enemy({
    slug: "wereboar",
    name: "Wereboar",
    cr: 4,
    crTag: "cr-4",
    maxHp: 78,
    defense: 11,
    speed: 30,
    attackBonus: 5,
    primaryAttack: wereboarMaul.reference,
    traitRefs: [wereboarShapechanger.reference, wereboarCharge.reference, wereboarRelentless.reference, wereboarMultiattack.reference],
    immunities: ["physical"],
  });

  const weretigerBite = attack({
    abilitySlug: "weretiger-bite",
    name: "Weretiger Bite",
    damageType: "piercing",
    count: 1,
    sides: 10,
    modifier: 3,
  });
  const weretigerShapechanger = trait(
    "weretiger-shapechanger",
    "Shapechanger",
    "Weretiger trait metadata: tiger, hybrid, and humanoid forms are not modeled; the hybrid profile is used.",
  );
  const weretigerKeenHearingAndSmell = trait(
    "weretiger-keen-hearing-and-smell",
    "Keen Hearing and Smell",
    "Weretiger trait metadata: advantage on hearing and smell checks is not modeled.",
  );
  const weretigerPounce = trait(
    "weretiger-pounce",
    "Pounce",
    "Weretiger trait metadata: the pounce charge and bonus bite rider is not executable.",
  );
  const weretigerMultiattack = trait(
    "weretiger-multiattack",
    "Multiattack",
    "Weretiger action metadata: the SRD multiattack (humanoid or hybrid form attacks) is not executable.",
  );
  enemy({
    slug: "weretiger",
    name: "Weretiger",
    cr: 4,
    crTag: "cr-4",
    maxHp: 120,
    defense: 12,
    speed: 30,
    attackBonus: 5,
    primaryAttack: weretigerBite.reference,
    traitRefs: [weretigerShapechanger.reference, weretigerKeenHearingAndSmell.reference, weretigerPounce.reference, weretigerMultiattack.reference],
    immunities: ["physical"],
  });

  return { abilities, enemies };
}
