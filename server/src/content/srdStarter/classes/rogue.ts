import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel } from "./classLevelBuilder.js";

export function rogueDefinition(refs: StarterReferences) {
  return {
    reference: refs.rogue,
    name: "Rogue",
    description: "Bounded SRD Rogue progression includes levels 1-3 as metadata; expertise and archetype execution remain unsupported.",
    tags: ["srd-5.1", "rogue-1-3", "unsupported-runtime"],
    mechanics: { hitDie: 8, primaryAttribute: "dexterity", savingAttributes: ["dexterity", "intelligence"], levelRefs: [refs.rogueOne, refs.levelRefs.rogueTwo, refs.levelRefs.rogueThree] },
  };
}

export function rogueLevels(refs: StarterReferences) {
  const { rogue, rogueOne, sneakAttack } = refs;
  return [
    { reference: rogueOne, name: "Rogue Level 1", description: "Level-one Rogue uses the d8 maximum and grants Sneak Attack metadata; its conditional damage is not executable here.", tags: ["srd-5.1", "rogue-1", "unsupported-runtime"], mechanics: { classRef: rogue, level: 1, proficiencyBonus: 2, hpGain: 8, abilityRefs: [sneakAttack], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 }] } },
    buildUnsupportedClassLevel(rogue, refs.levelRefs.rogueTwo, "Rogue", 2, 8),
    buildUnsupportedClassLevel(rogue, refs.levelRefs.rogueThree, "Rogue", 3, 8),
  ];
}
