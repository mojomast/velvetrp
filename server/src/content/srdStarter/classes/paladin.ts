import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel } from "./classLevelBuilder.js";

export function paladinDefinition(refs: StarterReferences) {
  return {
    reference: refs.paladin,
    name: "Paladin",
    description: "Bounded SRD Paladin progression includes levels 1-3 as metadata; oath and smite execution remain unsupported.",
    tags: ["srd-5.1", "paladin-1-3", "unsupported-runtime"],
    mechanics: { hitDie: 10, primaryAttribute: "charisma", savingAttributes: ["wisdom", "charisma"], levelRefs: [refs.paladinOne, refs.levelRefs.paladinTwo, refs.levelRefs.paladinThree] },
  };
}

export function paladinLevels(refs: StarterReferences) {
  const { paladin, paladinOne, divineSense, layOnHands } = refs;
  return [
    { reference: paladinOne, name: "Paladin Level 1", description: "Level-one Paladin uses the d10 maximum and tracks five points of Lay on Hands capacity; the healing resolution is not executable here.", tags: ["srd-5.1", "paladin-1", "unsupported-runtime"], mechanics: { classRef: paladin, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [divineSense, layOnHands], spellRefs: [], resourceGrants: [{ resourceId: "lay-on-hands", maxIncrease: 5, currentIncrease: 5, recovery: "long-rest" }, { resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
    buildUnsupportedClassLevel(paladin, refs.levelRefs.paladinTwo, "Paladin", 2, 10),
    buildUnsupportedClassLevel(paladin, refs.levelRefs.paladinThree, "Paladin", 3, 10),
  ];
}
