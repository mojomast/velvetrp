import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel, classLevelRef, classRef, proficiencyBonusFor } from "./classLevelBuilder.js";

/** Bounded SRD 5.1 Monk feature notes, one per level 1..20. Ki is represented
 * as a short-rest resource pool and every other feature is metadata only. */
const MONK_FEATURES: readonly string[] = [
  "Unarmored Defense and Martial Arts are tracked as bounded feature metadata; the d8 hit die is granted.",
  "Ki is tracked as a short-rest resource pool and Unarmored Movement adds speed; neither is executable.",
  "Deflect Missiles and the Monastic Tradition gate are recorded; the Way of the Open Hand is a bounded subclass selection.",
  "Ability Score Improvement and Slow Fall are recorded as bounded advancement metadata.",
  "Extra Attack and Stunning Strike are recorded; the additional attack and stun save are not executable.",
  "Ki-Empowered Strikes and the Way of the Open Hand Wholeness of Body feature are recorded as bounded metadata.",
  "Evasion and Stillness of Mind are recorded; their reactive effects are not executable.",
  "Ability Score Improvement is recorded as bounded advancement metadata.",
  "Unarmored Movement improvement (vertical surfaces and liquids) is recorded as bounded metadata.",
  "Purity of Body is recorded as bounded metadata; its immunity is not executable.",
  "The Way of the Open Hand Tranquility feature is recorded as bounded metadata.",
  "Ability Score Improvement is recorded as bounded advancement metadata.",
  "Tongue of the Sun and Moon is recorded as bounded metadata.",
  "Diamond Soul is recorded as bounded metadata; its saving throw proficiencies are not executable.",
  "Timeless Body is recorded as bounded metadata.",
  "Ability Score Improvement is recorded as bounded advancement metadata.",
  "The Way of the Open Hand Quivering Palm feature is recorded as bounded metadata.",
  "Empty Body is recorded as bounded metadata.",
  "Ability Score Improvement is recorded as bounded advancement metadata.",
  "Perfect Self is recorded as bounded metadata; its ki recovery is not executable.",
];

function monkSubclassRef(refs: StarterReferences) {
  return refs.ref("subclass", "srd-5.1:subclass:way-of-the-open-hand");
}

function buildMonkLevel(refs: StarterReferences, level: number) {
  const base = buildUnsupportedClassLevel(classRef(refs, "monk"), classLevelRef(refs, `monk-${level}`), "Monk", level, 8);
  return {
    ...base,
    description: `SRD Monk level ${level} progression metadata. ${MONK_FEATURES[level - 1]}`,
    mechanics: {
      ...base.mechanics,
      proficiencyBonus: proficiencyBonusFor(level),
      hpGain: level === 1 ? 8 : 5,
      resourceGrants: [
        ...base.mechanics.resourceGrants,
        ...(level >= 2 ? [{ resourceId: "ki", maxIncrease: level === 2 ? 2 : 1, currentIncrease: level === 2 ? 2 : 1, recovery: "short-rest" as const }] : []),
      ],
      ...(level === 3 ? { progressionChoices: [{ choiceId: "monk-subclass", required: true, count: 1, kind: "subclass", options: [monkSubclassRef(refs)] }] } : {}),
    },
  };
}

export function monkDefinition(refs: StarterReferences) {
  return {
    reference: classRef(refs, "monk"),
    name: "Monk",
    description: "Bounded SRD Monk progression includes levels 1-20 as metadata. Ki, Martial Arts, and the Way of the Open Hand are tracked as bounded feature metadata and are not executable.",
    tags: ["srd-5.1", "monk-1-20", "unsupported-runtime"],
    mechanics: { hitDie: 8, primaryAttribute: "dexterity", savingAttributes: ["strength", "dexterity"], levelRefs: Array.from({ length: 20 }, (_, index) => classLevelRef(refs, `monk-${index + 1}`)) },
  };
}

export function monkLevels(refs: StarterReferences) {
  return Array.from({ length: 20 }, (_, index) => buildMonkLevel(refs, index + 1));
}

export function monkSubclasses(refs: StarterReferences) {
  return [
    {
      reference: monkSubclassRef(refs),
      name: "Way of the Open Hand",
      description: "The Way of the Open Hand is a Monastic Tradition introduced at Monk level 3. Open Hand Technique, Wholeness of Body, Tranquility, and Quivering Palm remain bounded metadata and are not executable.",
      tags: ["srd-5.1", "subclass", "monk"],
      mechanics: { classRef: classRef(refs, "monk"), level: 3, abilityRefs: [] },
    },
  ];
}
