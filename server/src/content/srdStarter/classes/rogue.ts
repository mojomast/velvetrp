import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel, classLevelRef, classRef, proficiencyBonusFor } from "./classLevelBuilder.js";

const ROGUE_SLUG = "rogue";
const ROGUE_HIT_DIE = 8 as const;
const ROGUE_HP_GAIN = Math.floor(ROGUE_HIT_DIE / 2) + 1;
const UNSUPPORTED_TAG = "unsupported-runtime";

const ROGUE_LEVEL_NUMBERS = Array.from({ length: 20 }, (_, index) => index + 1);

/** SRD 5.1 Rogue features by level, expressed as bounded non-executable metadata. */
const ROGUE_FEATURE_NOTES: Record<number, string> = {
  1: "grants Sneak Attack 1d6 and Expertise in two skills",
  2: "grants Cunning Action",
  3: "offers the Thief archetype subclass choice and Sneak Attack 2d6",
  4: "marks the Ability Score Improvement step",
  5: "grants Uncanny Dodge and Sneak Attack 3d6",
  6: "adds Expertise in two more skills",
  7: "grants Evasion and Sneak Attack 4d6",
  8: "marks the Ability Score Improvement step",
  9: "upgrades Sneak Attack to 5d6",
  10: "marks the Ability Score Improvement step",
  11: "grants Reliable Talent and Sneak Attack 6d6",
  12: "marks the Ability Score Improvement step",
  13: "upgrades Sneak Attack to 7d6",
  14: "grants Blindsense",
  15: "grants Slippery Mind and Sneak Attack 8d6",
  16: "marks the Ability Score Improvement step",
  17: "upgrades Sneak Attack to 9d6",
  18: "grants Elusive",
  19: "marks the Ability Score Improvement step and Sneak Attack 10d6",
  20: "grants Stroke of Luck",
};

/** Feature tags kept as bounded metadata; no executable ability or spell ids are invented. */
const ROGUE_FEATURE_TAGS: Record<number, readonly string[]> = {
  1: ["rogue-sneak-attack", "rogue-expertise"],
  2: ["rogue-cunning-action"],
  3: ["rogue-archetype"],
  5: ["rogue-uncanny-dodge"],
  7: ["rogue-evasion"],
  11: ["rogue-reliable-talent"],
  14: ["rogue-blindsense"],
  15: ["rogue-slippery-mind"],
  18: ["rogue-elusive"],
  20: ["rogue-stroke-of-luck"],
};

function levelReference(refs: StarterReferences, level: number) {
  if (level === 1) return refs.rogueOne;
  if (level === 2) return refs.levelRefs.rogueTwo;
  if (level === 3) return refs.levelRefs.rogueThree;
  return classLevelRef(refs, `${ROGUE_SLUG}-${level}`);
}

function subclassReference(refs: StarterReferences) {
  return refs.ref("subclass", "srd-5.1:subclass:thief");
}

function featureTags(level: number) {
  return ["srd-5.1", UNSUPPORTED_TAG, `rogue-${level}`, ...(ROGUE_FEATURE_TAGS[level] ?? [])];
}

function featureDescription(level: number) {
  const note = ROGUE_FEATURE_NOTES[level] ?? "progression metadata";
  return `SRD 5.1 Rogue level ${level} ${note}; the feature remains unsupported at runtime.`;
}

export function rogueDefinition(refs: StarterReferences) {
  return {
    reference: classRef(refs, ROGUE_SLUG),
    name: "Rogue",
    description: "Bounded SRD 5.1 Rogue progression covers levels 1-20 as metadata; Sneak Attack, Expertise, Evasion, and the Thief archetype remain unsupported at runtime.",
    tags: ["srd-5.1", "rogue", UNSUPPORTED_TAG],
    mechanics: { hitDie: ROGUE_HIT_DIE, primaryAttribute: "dexterity", savingAttributes: ["dexterity", "intelligence"], levelRefs: ROGUE_LEVEL_NUMBERS.map((level) => levelReference(refs, level)) },
  };
}

export function rogueLevels(refs: StarterReferences) {
  const classReference = classRef(refs, ROGUE_SLUG);
  const subclass = subclassReference(refs);
  const unsupportedLevel = (level: number) => {
    const base = buildUnsupportedClassLevel(classReference, levelReference(refs, level), "Rogue", level, ROGUE_HIT_DIE);
    return {
      ...base,
      description: featureDescription(level),
      tags: featureTags(level),
      mechanics: {
        ...base.mechanics,
        proficiencyBonus: proficiencyBonusFor(level),
        hpGain: ROGUE_HP_GAIN,
        ...(level === 3 ? { progressionChoices: [{ choiceId: "rogue-subclass", required: true as const, count: 1 as const, kind: "subclass" as const, options: [subclass] }] } : {}),
      },
    };
  };
  return [
    { reference: refs.rogueOne, name: "Rogue Level 1", description: featureDescription(1), tags: featureTags(1), mechanics: { classRef: classReference, level: 1, proficiencyBonus: proficiencyBonusFor(1), hpGain: ROGUE_HIT_DIE, abilityRefs: [refs.sneakAttack], spellRefs: [] as string[], resourceGrants: [{ resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 }] } },
    ...ROGUE_LEVEL_NUMBERS.slice(1).map(unsupportedLevel),
  ];
}

export function rogueSubclasses(refs: StarterReferences) {
  return [{
    reference: subclassReference(refs),
    name: "Thief",
    description: "Bounded SRD 5.1 Thief subclass metadata bound to the Rogue class at level 3; its features remain unsupported at runtime.",
    tags: ["srd-5.1", "subclass", "rogue"],
    mechanics: { classRef: refs.rogue, level: 3, abilityRefs: [] as string[] },
  }];
}
