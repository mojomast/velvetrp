import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel } from "./classLevelBuilder.js";

export function wizardDefinition(refs: StarterReferences) {
  return {
    reference: refs.wizard,
    name: "Wizard",
    description: "Bounded SRD Wizard progression includes levels 1-3 as metadata; spell execution and Arcane Tradition remain unsupported.",
    tags: ["srd-5.1", "wizard-1-3", "unsupported-runtime"],
    mechanics: { hitDie: 6, primaryAttribute: "intelligence", savingAttributes: ["intelligence", "wisdom"], levelRefs: [refs.wizardOne, refs.levelRefs.wizardTwo, refs.levelRefs.wizardThree] },
  };
}

export function wizardLevels(refs: StarterReferences) {
  const { wizard, wizardOne, wizardSpellbook, wizardCantrip, rayOfFrost, magicMissile, falseLife, shield: shieldSpell } = refs;
  return [
    { reference: wizardOne, name: "Wizard Level 1", description: "Level-one Wizard uses the d6 maximum, grants a closed spellbook feature, two first-level spell slots, two exact cantrips, and Magic Missile preparation metadata.", tags: ["srd-5.1", "wizard-1", "unsupported-runtime"], mechanics: { classRef: wizard, level: 1, proficiencyBonus: 2, hpGain: 6, abilityRefs: [wizardSpellbook], spellRefs: [wizardCantrip, rayOfFrost], preparedSpellRefs: [magicMissile, falseLife, shieldSpell], resourceGrants: [{ resourceId: "spell-slot-1", maxIncrease: 2, currentIncrease: 2, recovery: "long-rest" }, { resourceId: "hit-dice-d6", maxIncrease: 1, currentIncrease: 1 }] } },
    buildUnsupportedClassLevel(wizard, refs.levelRefs.wizardTwo, "Wizard", 2, 6),
    buildUnsupportedClassLevel(wizard, refs.levelRefs.wizardThree, "Wizard", 3, 6),
  ];
}
