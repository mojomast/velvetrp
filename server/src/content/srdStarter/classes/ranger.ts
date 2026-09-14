import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel } from "./classLevelBuilder.js";

export function rangerDefinition(refs: StarterReferences) {
  return {
    reference: refs.ranger,
    name: "Ranger",
    description: "Bounded SRD Ranger progression includes levels 1-3 as metadata; favored terrain and archetype execution remain unsupported.",
    tags: ["srd-5.1", "ranger-1-3", "unsupported-runtime"],
    mechanics: { hitDie: 10, primaryAttribute: "dexterity", savingAttributes: ["strength", "dexterity"], levelRefs: [refs.rangerOne, refs.levelRefs.rangerTwo, refs.levelRefs.rangerThree] },
  };
}

export function rangerLevels(refs: StarterReferences) {
  const { ranger, rangerOne, favoredEnemy, naturalExplorer } = refs;
  return [
    { reference: rangerOne, name: "Ranger Level 1", description: "Level-one Ranger uses the d10 maximum and grants the closed Favored Enemy and Natural Explorer feature metadata.", tags: ["srd-5.1", "ranger-1", "unsupported-runtime"], mechanics: { classRef: ranger, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [favoredEnemy, naturalExplorer], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
    buildUnsupportedClassLevel(ranger, refs.levelRefs.rangerTwo, "Ranger", 2, 10),
    buildUnsupportedClassLevel(ranger, refs.levelRefs.rangerThree, "Ranger", 3, 10),
  ];
}
