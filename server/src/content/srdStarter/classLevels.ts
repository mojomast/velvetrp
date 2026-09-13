import type { StarterReference, StarterReferences } from "./references.js";

function classLevelMetadata(classRef: StarterReference, levelRef: StarterReference, className: string, level: number, hitDie: number) {
  return {
    reference: levelRef,
    name: `${className} Level ${level}`,
    description: `SRD ${className} level ${level} progression metadata; subclass and execution-dependent features remain unsupported.`,
    tags: ["srd-5.1", "unsupported-runtime", `${className.toLowerCase()}-${level}`],
    mechanics: { classRef, level, proficiencyBonus: level < 5 ? 2 : 3, hpGain: level === 2 ? 6 : 6, abilityRefs: [], spellRefs: [],
      resourceGrants: [{ resourceId: `hit-dice-d${hitDie}`, maxIncrease: 1, currentIncrease: 1 }] },
  };
}

export function buildClassLevels(refs: StarterReferences) {
  const { klass, cleric, barbarian, rogue, wizard, paladin, ranger, level, levelTwo, levelThree, clericOne, barbarianOne, rogueOne, wizardOne, paladinOne, rangerOne, attack, secondWind, actionSurge, rage, sneakAttack, wizardSpellbook, divineSense, layOnHands, favoredEnemy, naturalExplorer, bless, cureWounds, healingWord, magicMissile, falseLife, shield: shieldSpell, wizardCantrip, rayOfFrost, levelRefs } = refs;
  return [
    { reference: level, name: "Fighter Level 1", description: "Level-one hit points use the Fighter d10 maximum and proficiency bonus +2. Second Wind is tracked as a short-rest power; its healing effect is not executable.", tags: ["srd-5.1", "fighter-1-2"], mechanics: { classRef: klass, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [attack, secondWind], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
    { reference: levelTwo, name: "Fighter Level 2", description: "Level-two advancement uses the SRD fixed hit-point increase of 6 before Constitution modifier and grants Action Surge tracking. Proficiency remains +2.", tags: ["srd-5.1", "fighter-1-2"], mechanics: { classRef: klass, level: 2, proficiencyBonus: 2, hpGain: 6, abilityRefs: [actionSurge], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
    { reference: levelThree, name: "Fighter Level 3", description: "Martial Archetype is an SRD level-three Fighter feature, but no SRD archetype is implemented in this pack. The canonical progression profile caps advancement at level 2.", tags: ["srd-5.1", "unsupported-runtime", "martial-archetype-gate"], mechanics: { classRef: klass, level: 3, proficiencyBonus: 2, hpGain: 6, abilityRefs: [], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
    { reference: clericOne, name: "Cleric Level 1", description: "Level-one Cleric hit points use the d8 maximum. Bless, Cure Wounds, and Healing Word are exact prepared-spell selections; the supported healing spells enforce their target and range contracts.", tags: ["srd-5.1", "cleric-1", "prepared-spells"], mechanics: { classRef: cleric, level: 1, proficiencyBonus: 2, hpGain: 8, abilityRefs: [], spellRefs: [], preparedSpellRefs: [bless, cureWounds, healingWord], resourceGrants: [{ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 }] } },
    { reference: barbarianOne, name: "Barbarian Level 1", description: "Level-one Barbarian uses the d12 maximum and tracks two Rage uses per long rest as bounded capacity metadata.", tags: ["srd-5.1", "barbarian-1", "unsupported-runtime"], mechanics: { classRef: barbarian, level: 1, proficiencyBonus: 2, hpGain: 12, abilityRefs: [rage], spellRefs: [], resourceGrants: [{ resourceId: "rage", maxIncrease: 2, currentIncrease: 2, recovery: "long-rest" }, { resourceId: "hit-dice-d12", maxIncrease: 1, currentIncrease: 1 }] } },
    { reference: rogueOne, name: "Rogue Level 1", description: "Level-one Rogue uses the d8 maximum and grants Sneak Attack metadata; its conditional damage is not executable here.", tags: ["srd-5.1", "rogue-1", "unsupported-runtime"], mechanics: { classRef: rogue, level: 1, proficiencyBonus: 2, hpGain: 8, abilityRefs: [sneakAttack], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 }] } },
    { reference: wizardOne, name: "Wizard Level 1", description: "Level-one Wizard uses the d6 maximum, grants a closed spellbook feature, two first-level spell slots, two exact cantrips, and Magic Missile preparation metadata.", tags: ["srd-5.1", "wizard-1", "unsupported-runtime"], mechanics: { classRef: wizard, level: 1, proficiencyBonus: 2, hpGain: 6, abilityRefs: [wizardSpellbook], spellRefs: [wizardCantrip, rayOfFrost], preparedSpellRefs: [magicMissile, falseLife, shieldSpell], resourceGrants: [{ resourceId: "spell-slot-1", maxIncrease: 2, currentIncrease: 2, recovery: "long-rest" }, { resourceId: "hit-dice-d6", maxIncrease: 1, currentIncrease: 1 }] } },
    { reference: paladinOne, name: "Paladin Level 1", description: "Level-one Paladin uses the d10 maximum and tracks five points of Lay on Hands capacity; the healing resolution is not executable here.", tags: ["srd-5.1", "paladin-1", "unsupported-runtime"], mechanics: { classRef: paladin, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [divineSense, layOnHands], spellRefs: [], resourceGrants: [{ resourceId: "lay-on-hands", maxIncrease: 5, currentIncrease: 5, recovery: "long-rest" }, { resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
    { reference: rangerOne, name: "Ranger Level 1", description: "Level-one Ranger uses the d10 maximum and grants the closed Favored Enemy and Natural Explorer feature metadata.", tags: ["srd-5.1", "ranger-1", "unsupported-runtime"], mechanics: { classRef: ranger, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [favoredEnemy, naturalExplorer], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
    classLevelMetadata(cleric, levelRefs.clericTwo, "Cleric", 2, 8),
    classLevelMetadata(cleric, levelRefs.clericThree, "Cleric", 3, 8),
    classLevelMetadata(barbarian, levelRefs.barbarianTwo, "Barbarian", 2, 12),
    classLevelMetadata(barbarian, levelRefs.barbarianThree, "Barbarian", 3, 12),
    classLevelMetadata(rogue, levelRefs.rogueTwo, "Rogue", 2, 8),
    classLevelMetadata(rogue, levelRefs.rogueThree, "Rogue", 3, 8),
    classLevelMetadata(wizard, levelRefs.wizardTwo, "Wizard", 2, 6),
    classLevelMetadata(wizard, levelRefs.wizardThree, "Wizard", 3, 6),
    classLevelMetadata(paladin, levelRefs.paladinTwo, "Paladin", 2, 10),
    classLevelMetadata(paladin, levelRefs.paladinThree, "Paladin", 3, 10),
    classLevelMetadata(ranger, levelRefs.rangerTwo, "Ranger", 2, 10),
    classLevelMetadata(ranger, levelRefs.rangerThree, "Ranger", 3, 10),
  ];
}
