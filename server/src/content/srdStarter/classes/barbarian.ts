import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel, classLevelRef, proficiencyBonusFor } from "./classLevelBuilder.js";

const BARBARIAN_SLUG = "barbarian";
const BARBARIAN_HIT_DIE = 12 as const;
const BARBARIAN_HP_GAIN = Math.floor(BARBARIAN_HIT_DIE / 2) + 1;
const UNSUPPORTED_TAG = "unsupported-runtime";

const BARBARIAN_LEVEL_NUMBERS = Array.from({ length: 20 }, (_, index) => index + 1);

/** SRD 5.1 Barbarian features by level, expressed as bounded non-executable metadata. */
const BARBARIAN_FEATURE_NOTES: Record<number, string> = {
  1: "grants Unarmored Defense and two Rage uses per long rest",
  2: "grants Reckless Attack and Danger Sense",
  3: "opens the Primal Path choice and the Path of the Berserker progression",
  4: "marks the Ability Score Improvement step",
  5: "grants Extra Attack and Fast Movement",
  6: "represents the Primal Path feature step",
  7: "grants Feral Instinct",
  8: "marks the Ability Score Improvement step",
  9: "grants Brutal Critical with one extra weapon damage die",
  10: "represents the Primal Path feature step",
  11: "grants Relentless Rage",
  12: "marks the Ability Score Improvement step",
  13: "improves Brutal Critical to two extra weapon damage dice",
  14: "represents the Primal Path feature step",
  15: "grants Persistent Rage",
  16: "marks the Ability Score Improvement step",
  17: "improves Brutal Critical to three extra weapon damage dice",
  18: "grants Indomitable Might",
  19: "marks the Ability Score Improvement step",
  20: "grants Primal Champion",
};

function levelReference(refs: StarterReferences, level: number) {
  if (level === 1) return refs.barbarianOne;
  if (level === 2) return refs.levelRefs.barbarianTwo;
  if (level === 3) return refs.levelRefs.barbarianThree;
  return classLevelRef(refs, `${BARBARIAN_SLUG}-${level}`);
}

function pathOfTheBerserkerRef(refs: StarterReferences) {
  return refs.ref("subclass", "srd-5.1:subclass:path-of-the-berserker");
}

function featureDescription(level: number) {
  const note = BARBARIAN_FEATURE_NOTES[level] ?? "progression metadata";
  return `SRD 5.1 Barbarian level ${level} ${note}; the feature remains unsupported at runtime.`;
}

function unsupportedLevel(refs: StarterReferences, level: number) {
  const base = buildUnsupportedClassLevel(refs.barbarian, levelReference(refs, level), "Barbarian", level, BARBARIAN_HIT_DIE);
  return {
    ...base,
    description: featureDescription(level),
    mechanics: { ...base.mechanics, proficiencyBonus: proficiencyBonusFor(level), hpGain: BARBARIAN_HP_GAIN },
  };
}

export function barbarianDefinition(refs: StarterReferences) {
  return {
    reference: refs.barbarian,
    name: "Barbarian",
    description: "Bounded SRD 5.1 Barbarian progression covers levels 1-20 as metadata; rage, Unarmored Defense, and the Path of the Berserker execution remain unsupported at runtime.",
    tags: ["srd-5.1", "barbarian", UNSUPPORTED_TAG],
    mechanics: { hitDie: BARBARIAN_HIT_DIE, primaryAttribute: "strength", savingAttributes: ["strength", "constitution"], levelRefs: BARBARIAN_LEVEL_NUMBERS.map((level) => levelReference(refs, level)) },
  };
}

export function barbarianLevels(refs: StarterReferences) {
  const berserker = pathOfTheBerserkerRef(refs);
  const levelThree = unsupportedLevel(refs, 3);
  return [
    { reference: refs.barbarianOne, name: "Barbarian Level 1", description: featureDescription(1), tags: ["srd-5.1", UNSUPPORTED_TAG, "barbarian-1"], mechanics: { classRef: refs.barbarian, level: 1, proficiencyBonus: proficiencyBonusFor(1), hpGain: BARBARIAN_HIT_DIE, abilityRefs: [refs.rage], spellRefs: [], resourceGrants: [{ resourceId: "rage", maxIncrease: 2, currentIncrease: 2, recovery: "long-rest" }, { resourceId: "hit-dice-d12", maxIncrease: 1, currentIncrease: 1 }] } },
    unsupportedLevel(refs, 2),
    { ...levelThree, mechanics: { ...levelThree.mechanics, progressionChoices: [{ choiceId: "barbarian-subclass", required: true, count: 1, kind: "subclass", options: [berserker] }] } },
    ...BARBARIAN_LEVEL_NUMBERS.slice(3).map((level) => unsupportedLevel(refs, level)),
  ];
}

export function barbarianSubclasses(refs: StarterReferences) {
  return [{
    reference: pathOfTheBerserkerRef(refs),
    name: "Path of the Berserker",
    description: "Bounded SRD 5.1 Path of the Berserker subclass metadata bound to the Barbarian class at level 3; its features remain unsupported at runtime.",
    tags: ["srd-5.1", "subclass", "barbarian"],
    mechanics: { classRef: refs.barbarian, level: 3, abilityRefs: [] },
  }];
}
