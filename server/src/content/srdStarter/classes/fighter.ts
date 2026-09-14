import type { StarterReferences } from "../references.js";

export function fighterDefinition(refs: StarterReferences) {
  return {
    reference: refs.klass,
    name: "Fighter",
    description: "Bounded SRD Fighter progression supports levels 1-2 only. Level 3 Martial Archetype is deliberately not executable.",
    tags: ["srd-5.1", "fighter-1-2"],
    mechanics: { hitDie: 10, primaryAttribute: "strength", savingAttributes: ["strength", "constitution"], levelRefs: [refs.level, refs.levelTwo, refs.levelThree] },
  };
}

export function fighterLevels(refs: StarterReferences) {
  const { attack, secondWind, actionSurge, level, levelTwo, levelThree } = refs;
  return [
    { reference: level, name: "Fighter Level 1", description: "Level-one hit points use the Fighter d10 maximum and proficiency bonus +2. Second Wind is tracked as a short-rest power; its healing effect is not executable.", tags: ["srd-5.1", "fighter-1-2"], mechanics: { classRef: refs.klass, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [attack, secondWind], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
    { reference: levelTwo, name: "Fighter Level 2", description: "Level-two advancement uses the SRD fixed hit-point increase of 6 before Constitution modifier and grants Action Surge tracking. Proficiency remains +2.", tags: ["srd-5.1", "fighter-1-2"], mechanics: { classRef: refs.klass, level: 2, proficiencyBonus: 2, hpGain: 6, abilityRefs: [actionSurge], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
    { reference: levelThree, name: "Fighter Level 3", description: "Martial Archetype is an SRD level-three Fighter feature, but no SRD archetype is implemented in this pack. The canonical progression profile caps advancement at level 2.", tags: ["srd-5.1", "unsupported-runtime", "martial-archetype-gate"], mechanics: { classRef: refs.klass, level: 3, proficiencyBonus: 2, hpGain: 6, abilityRefs: [], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
  ];
}
