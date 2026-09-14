import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel, classLevelRef, proficiencyBonusFor } from "./classLevelBuilder.js";

const PALADIN_SLUG = "paladin";
const PALADIN_HIT_DIE = 10 as const;
const PALADIN_HP_GAIN = Math.floor(PALADIN_HIT_DIE / 2) + 1;
const UNSUPPORTED_TAG = "unsupported-runtime";

const PALADIN_LEVEL_NUMBERS = Array.from({ length: 20 }, (_, index) => index + 1);

/** SRD 5.1 Paladin features by level, expressed as bounded non-executable metadata. */
const PALADIN_FEATURE_NOTES: Record<number, string> = {
  1: "grants Divine Sense and Lay on Hands",
  2: "grants Fighting Style, Spellcasting, and Divine Smite",
  3: "grants Divine Health and offers the Sacred Oath subclass choice",
  4: "marks the Ability Score Improvement step",
  5: "grants Extra Attack",
  6: "grants Aura of Protection",
  7: "grants the Sacred Oath feature",
  8: "marks the Ability Score Improvement step",
  9: "represents third-level spell slots",
  10: "grants Aura of Courage",
  11: "grants Improved Divine Smite",
  12: "marks the Ability Score Improvement step",
  13: "represents fourth-level spell slots",
  14: "grants Cleansing Touch",
  15: "grants the Sacred Oath feature",
  16: "marks the Ability Score Improvement step",
  17: "represents fifth-level spell slots",
  18: "improves the Aura of Protection and Aura of Courage range",
  19: "marks the Ability Score Improvement step",
  20: "grants the Sacred Oath capstone feature",
};

function levelReference(refs: StarterReferences, level: number) {
  if (level === 1) return refs.paladinOne;
  if (level === 2) return refs.levelRefs.paladinTwo;
  if (level === 3) return refs.levelRefs.paladinThree;
  return classLevelRef(refs, `${PALADIN_SLUG}-${level}`);
}

function subclassReference(refs: StarterReferences) {
  return refs.ref("subclass", "srd-5.1:subclass:oath-of-devotion");
}

function hitDieGrant() {
  return { resourceId: `hit-dice-d${PALADIN_HIT_DIE}`, maxIncrease: 1, currentIncrease: 1 };
}

function featureDescription(level: number) {
  const note = PALADIN_FEATURE_NOTES[level] ?? "progression metadata";
  return `SRD 5.1 Paladin level ${level} ${note}; the feature remains unsupported at runtime.`;
}

export function paladinDefinition(refs: StarterReferences) {
  return {
    reference: refs.paladin,
    name: "Paladin",
    description: "Bounded SRD 5.1 Paladin progression covers levels 1-20 as metadata, including the Oath of Devotion subclass choice. Smites, auras, and oath features remain unsupported at runtime.",
    tags: ["srd-5.1", PALADIN_SLUG, UNSUPPORTED_TAG],
    mechanics: { hitDie: PALADIN_HIT_DIE, primaryAttribute: "charisma", savingAttributes: ["wisdom", "charisma"], levelRefs: PALADIN_LEVEL_NUMBERS.map((level) => levelReference(refs, level)) },
  };
}

export function paladinLevels(refs: StarterReferences) {
  const { paladin, divineSense, layOnHands } = refs;
  const subclass = subclassReference(refs);
  const unsupportedLevel = (level: number) => {
    const base = buildUnsupportedClassLevel(paladin, levelReference(refs, level), "Paladin", level, PALADIN_HIT_DIE);
    return {
      ...base,
      description: featureDescription(level),
      tags: ["srd-5.1", UNSUPPORTED_TAG, `${PALADIN_SLUG}-${level}`],
      mechanics: { ...base.mechanics, proficiencyBonus: proficiencyBonusFor(level), hpGain: PALADIN_HP_GAIN },
    };
  };
  return [
    { reference: levelReference(refs, 1), name: "Paladin Level 1", description: featureDescription(1), tags: ["srd-5.1", UNSUPPORTED_TAG, "paladin-1"], mechanics: { classRef: paladin, level: 1, proficiencyBonus: proficiencyBonusFor(1), hpGain: PALADIN_HIT_DIE, abilityRefs: [divineSense, layOnHands], spellRefs: [], resourceGrants: [{ resourceId: "lay-on-hands", maxIncrease: 5, currentIncrease: 5, recovery: "long-rest" }, hitDieGrant()] } },
    { reference: levelReference(refs, 2), name: "Paladin Level 2", description: featureDescription(2), tags: ["srd-5.1", UNSUPPORTED_TAG, "paladin-2"], mechanics: { classRef: paladin, level: 2, proficiencyBonus: proficiencyBonusFor(2), hpGain: PALADIN_HP_GAIN, abilityRefs: [], spellRefs: [], resourceGrants: [hitDieGrant()] } },
    { reference: levelReference(refs, 3), name: "Paladin Level 3", description: featureDescription(3), tags: ["srd-5.1", UNSUPPORTED_TAG, "paladin-3"], mechanics: { classRef: paladin, level: 3, proficiencyBonus: proficiencyBonusFor(3), hpGain: PALADIN_HP_GAIN, abilityRefs: [], spellRefs: [], resourceGrants: [hitDieGrant()], progressionChoices: [{ choiceId: "paladin-subclass", required: true, count: 1, kind: "subclass", options: [subclass] }] } },
    ...PALADIN_LEVEL_NUMBERS.slice(3).map(unsupportedLevel),
  ];
}

export function paladinSubclasses(refs: StarterReferences) {
  return [{
    reference: subclassReference(refs),
    name: "Oath of Devotion",
    description: "Bounded SRD 5.1 Oath of Devotion subclass metadata bound to the Paladin class at level 3; its oath features remain unsupported at runtime.",
    tags: ["srd-5.1", "subclass", PALADIN_SLUG],
    mechanics: { classRef: refs.paladin, level: 3, abilityRefs: [] as string[] },
  }];
}
