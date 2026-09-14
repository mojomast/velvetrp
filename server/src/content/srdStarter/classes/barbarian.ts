import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel } from "./classLevelBuilder.js";

export function barbarianDefinition(refs: StarterReferences) {
  return {
    reference: refs.barbarian,
    name: "Barbarian",
    description: "Bounded SRD Barbarian progression includes levels 1-3 as metadata; rage and primal-path execution remain unsupported.",
    tags: ["srd-5.1", "barbarian-1-3", "unsupported-runtime"],
    mechanics: { hitDie: 12, primaryAttribute: "strength", savingAttributes: ["strength", "constitution"], levelRefs: [refs.barbarianOne, refs.levelRefs.barbarianTwo, refs.levelRefs.barbarianThree] },
  };
}

export function barbarianLevels(refs: StarterReferences) {
  const { barbarian, barbarianOne, rage } = refs;
  return [
    { reference: barbarianOne, name: "Barbarian Level 1", description: "Level-one Barbarian uses the d12 maximum and tracks two Rage uses per long rest as bounded capacity metadata.", tags: ["srd-5.1", "barbarian-1", "unsupported-runtime"], mechanics: { classRef: barbarian, level: 1, proficiencyBonus: 2, hpGain: 12, abilityRefs: [rage], spellRefs: [], resourceGrants: [{ resourceId: "rage", maxIncrease: 2, currentIncrease: 2, recovery: "long-rest" }, { resourceId: "hit-dice-d12", maxIncrease: 1, currentIncrease: 1 }] } },
    buildUnsupportedClassLevel(barbarian, refs.levelRefs.barbarianTwo, "Barbarian", 2, 12),
    buildUnsupportedClassLevel(barbarian, refs.levelRefs.barbarianThree, "Barbarian", 3, 12),
  ];
}
