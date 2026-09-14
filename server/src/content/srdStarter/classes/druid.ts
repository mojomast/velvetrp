import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel, classLevelRef, classRef, proficiencyBonusFor } from "./classLevelBuilder.js";

const DRUID_SLUG = "druid";
const DRUID_HIT_DIE = 8 as const;
const DRUID_HP_GAIN = Math.floor(DRUID_HIT_DIE / 2) + 1;
const UNSUPPORTED_TAG = "unsupported-runtime";

const DRUID_LEVEL_NUMBERS = Array.from({ length: 20 }, (_, index) => index + 1);

/** SRD 5.1 Druid features by level, expressed as bounded non-executable metadata. */
const DRUID_FEATURE_NOTES: Record<number, string> = {
  1: "grants Druidic and Wisdom-based spellcasting",
  2: "grants Wild Shape tracking and opens the Druid Circle choice",
  3: "offers the Circle of the Land subclass progression choice",
  4: "marks the Ability Score Improvement step",
  5: "represents third-level spell slots",
  6: "represents the circle feature step",
  7: "represents fourth-level spell slots",
  8: "marks the Ability Score Improvement and Wild Shape flight step",
  9: "represents fifth-level spell slots",
  10: "represents the circle feature step",
  11: "represents sixth-level spell slots",
  12: "marks the Ability Score Improvement step",
  13: "represents seventh-level spell slots",
  14: "represents the circle feature step",
  15: "represents eighth-level spell slots",
  16: "marks the Ability Score Improvement step",
  17: "represents ninth-level spell slots",
  18: "grants Timeless Body and Beast Spells",
  19: "marks the Ability Score Improvement step",
  20: "grants Archdruid",
};

/** The character level at which each spell slot level first becomes available. */
const DRUID_SPELL_SLOT_LEVELS: Record<number, number> = {
  1: 1, 3: 2, 5: 3, 7: 4, 9: 5, 11: 6, 13: 7, 15: 8, 17: 9,
};

function levelReference(refs: StarterReferences, level: number) {
  return classLevelRef(refs, `${DRUID_SLUG}-${level}`);
}

function subclassReference(refs: StarterReferences) {
  return refs.ref("subclass", "srd-5.1:subclass:circle-of-the-land");
}

function hitDieGrant() {
  return { resourceId: `hit-dice-d${DRUID_HIT_DIE}`, maxIncrease: 1, currentIncrease: 1 };
}

function spellSlotGrants(level: number) {
  const spellLevel = DRUID_SPELL_SLOT_LEVELS[level];
  if (spellLevel === undefined) return [];
  return [{ resourceId: `spell-slot-${spellLevel}`, maxIncrease: 1, currentIncrease: 1, recovery: "long-rest" as const }];
}

function featureDescription(level: number) {
  const note = DRUID_FEATURE_NOTES[level] ?? "progression metadata";
  return `SRD 5.1 Druid level ${level} ${note}; the feature remains unsupported at runtime.`;
}

export function druidDefinition(refs: StarterReferences) {
  return {
    reference: classRef(refs, DRUID_SLUG),
    name: "Druid",
    description: "Bounded SRD 5.1 Druid progression covers levels 1-20 as metadata. Wild Shape, spell slots, and the Circle of the Land are tracked as bounded resource grants; spellcasting and shapeshifting remain unsupported at runtime.",
    tags: ["srd-5.1", "druid", UNSUPPORTED_TAG],
    mechanics: { hitDie: DRUID_HIT_DIE, primaryAttribute: "wisdom", savingAttributes: ["intelligence", "wisdom"], levelRefs: DRUID_LEVEL_NUMBERS.map((level) => levelReference(refs, level)) },
  };
}

export function druidLevels(refs: StarterReferences) {
  const classReference = classRef(refs, DRUID_SLUG);
  const subclass = subclassReference(refs);
  const unsupportedLevel = (level: number) => {
    const base = buildUnsupportedClassLevel(classReference, levelReference(refs, level), "Druid", level, DRUID_HIT_DIE);
    return {
      ...base,
      description: featureDescription(level),
      mechanics: { ...base.mechanics, proficiencyBonus: proficiencyBonusFor(level), hpGain: DRUID_HP_GAIN, resourceGrants: [...base.mechanics.resourceGrants, ...spellSlotGrants(level)] },
    };
  };
  return [
    { reference: levelReference(refs, 1), name: "Druid Level 1", description: featureDescription(1), tags: ["srd-5.1", UNSUPPORTED_TAG, "druid-1"], mechanics: { classRef: classReference, level: 1, proficiencyBonus: proficiencyBonusFor(1), hpGain: DRUID_HIT_DIE, abilityRefs: [], spellRefs: [], resourceGrants: [hitDieGrant(), ...spellSlotGrants(1)] } },
    { reference: levelReference(refs, 2), name: "Druid Level 2", description: featureDescription(2), tags: ["srd-5.1", UNSUPPORTED_TAG, "druid-2"], mechanics: { classRef: classReference, level: 2, proficiencyBonus: proficiencyBonusFor(2), hpGain: DRUID_HP_GAIN, abilityRefs: [], spellRefs: [], resourceGrants: [hitDieGrant(), { resourceId: "wild-shape", maxIncrease: 2, currentIncrease: 2, recovery: "short-rest" }] } },
    { reference: levelReference(refs, 3), name: "Druid Level 3", description: featureDescription(3), tags: ["srd-5.1", UNSUPPORTED_TAG, "druid-3"], mechanics: { classRef: classReference, level: 3, proficiencyBonus: proficiencyBonusFor(3), hpGain: DRUID_HP_GAIN, abilityRefs: [], spellRefs: [], resourceGrants: [hitDieGrant(), ...spellSlotGrants(3)], progressionChoices: [{ choiceId: "druid-subclass", required: true, count: 1, kind: "subclass", options: [subclass] }] } },
    ...DRUID_LEVEL_NUMBERS.slice(3).map(unsupportedLevel),
  ];
}

export function druidSubclasses(refs: StarterReferences) {
  return [
    {
      reference: subclassReference(refs),
      name: "Circle of the Land",
      description: "Bounded SRD 5.1 Circle of the Land subclass metadata bound to the Druid class at level 3. Circle spells and land features are not executable.",
      tags: ["srd-5.1", "subclass", "druid"],
      mechanics: { classRef: classRef(refs, DRUID_SLUG), level: 3, abilityRefs: [] },
    },
  ];
}
