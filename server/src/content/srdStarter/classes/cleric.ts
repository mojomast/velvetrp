import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel } from "./classLevelBuilder.js";

export function clericDefinition(refs: StarterReferences) {
  return {
    reference: refs.cleric,
    name: "Cleric",
    description: "Bounded SRD Cleric progression includes levels 1-3 as metadata; spell execution and domain choices remain unsupported.",
    tags: ["srd-5.1", "cleric-1-3", "prepared-spells"],
    mechanics: { hitDie: 8, primaryAttribute: "wisdom", savingAttributes: ["wisdom", "charisma"], levelRefs: [refs.clericOne, refs.levelRefs.clericTwo, refs.levelRefs.clericThree] },
  };
}

export function clericLevels(refs: StarterReferences) {
  const { cleric, clericOne, bless, cureWounds, healingWord } = refs;
  return [
    { reference: clericOne, name: "Cleric Level 1", description: "Level-one Cleric hit points use the d8 maximum. Bless, Cure Wounds, and Healing Word are exact prepared-spell selections; the supported healing spells enforce their target and range contracts.", tags: ["srd-5.1", "cleric-1", "prepared-spells"], mechanics: { classRef: cleric, level: 1, proficiencyBonus: 2, hpGain: 8, abilityRefs: [], spellRefs: [], preparedSpellRefs: [bless, cureWounds, healingWord], resourceGrants: [{ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 }] } },
    buildUnsupportedClassLevel(cleric, refs.levelRefs.clericTwo, "Cleric", 2, 8),
    buildUnsupportedClassLevel(cleric, refs.levelRefs.clericThree, "Cleric", 3, 8),
  ];
}
