import type { StarterReference, StarterReferences } from "../references.js";
import { classLevelRef, proficiencyBonusFor } from "./classLevelBuilder.js";

const FIGHTER_SLUG = "fighter";
const FIGHTER_HIT_DIE = 10 as const;
const FIGHTER_HP_GAIN = Math.floor(FIGHTER_HIT_DIE / 2) + 1;
const UNSUPPORTED_TAG = "unsupported-runtime";

const FIGHTER_LEVEL_NUMBERS = Array.from({ length: 20 }, (_, index) => index + 1);

/** SRD 5.1 Fighter features by level, expressed as bounded non-executable metadata. */
const FIGHTER_FEATURE_NOTES: Record<number, string> = {
  1: "grants the Fighting Style choice and Second Wind tracking",
  2: "grants Action Surge tracking",
  3: "offers the Martial Archetype subclass progression choice",
  4: "marks the Ability Score Improvement step",
  5: "grants Extra Attack",
  6: "marks the Ability Score Improvement step",
  7: "represents the Martial Archetype feature step",
  8: "marks the Ability Score Improvement step",
  9: "grants Indomitable tracking",
  10: "represents the Martial Archetype feature step",
  11: "improves Extra Attack",
  12: "marks the Ability Score Improvement step",
  13: "grants a second Indomitable use",
  14: "marks the Ability Score Improvement step",
  15: "represents the Martial Archetype feature step",
  16: "marks the Ability Score Improvement step",
  17: "grants a second Action Surge use and a third Indomitable use",
  18: "represents the Martial Archetype feature step",
  19: "marks the Ability Score Improvement step",
  20: "improves Extra Attack again",
};

/** Bounded numeric feature capacity layered on top of each level's hit die grant. */
const FIGHTER_FEATURE_GRANTS: Record<number, readonly { resourceId: string; maxIncrease: number; currentIncrease: number; recovery?: "short-rest" | "long-rest" }[]> = {
  2: [{ resourceId: "action-surge", maxIncrease: 1, currentIncrease: 1, recovery: "short-rest" }],
  9: [{ resourceId: "indomitable", maxIncrease: 1, currentIncrease: 1, recovery: "long-rest" }],
  13: [{ resourceId: "indomitable", maxIncrease: 1, currentIncrease: 1, recovery: "long-rest" }],
  17: [{ resourceId: "action-surge", maxIncrease: 1, currentIncrease: 1, recovery: "short-rest" }, { resourceId: "indomitable", maxIncrease: 1, currentIncrease: 1, recovery: "long-rest" }],
};

function levelReference(refs: StarterReferences, level: number) {
  if (level === 1) return refs.level;
  if (level === 2) return refs.levelTwo;
  if (level === 3) return refs.levelThree;
  return classLevelRef(refs, `${FIGHTER_SLUG}-${level}`);
}

function championReference(refs: StarterReferences) {
  return refs.ref("subclass", "srd-5.1:subclass:champion");
}

function hitDieGrant() {
  return { resourceId: `hit-dice-d${FIGHTER_HIT_DIE}`, maxIncrease: 1, currentIncrease: 1 };
}

function resourceGrants(level: number) {
  return [hitDieGrant(), ...(FIGHTER_FEATURE_GRANTS[level] ?? [])];
}

function featureDescription(level: number) {
  const note = FIGHTER_FEATURE_NOTES[level] ?? "progression metadata";
  return `SRD 5.1 Fighter level ${level} ${note}; the feature remains unsupported at runtime.`;
}

export function fighterDefinition(refs: StarterReferences) {
  return {
    reference: refs.klass,
    name: "Fighter",
    description: "Bounded SRD 5.1 Fighter progression covers levels 1-20 as metadata, including the Champion Martial Archetype. Fighting Style, Action Surge, Extra Attack, and Indomitable remain unsupported at runtime.",
    tags: ["srd-5.1", "fighter", UNSUPPORTED_TAG],
    mechanics: { hitDie: FIGHTER_HIT_DIE, primaryAttribute: "strength", savingAttributes: ["strength", "constitution"], levelRefs: FIGHTER_LEVEL_NUMBERS.map((level) => levelReference(refs, level)) },
  };
}

export function fighterLevels(refs: StarterReferences) {
  const { attack, secondWind, actionSurge } = refs;
  const classReference = refs.klass;
  const subclass = championReference(refs);
  const level = (number: number, abilityRefs: StarterReference[]) => ({
    reference: levelReference(refs, number),
    name: `Fighter Level ${number}`,
    description: featureDescription(number),
    tags: ["srd-5.1", UNSUPPORTED_TAG, `${FIGHTER_SLUG}-${number}`],
    mechanics: { classRef: classReference, level: number, proficiencyBonus: proficiencyBonusFor(number), hpGain: number === 1 ? FIGHTER_HIT_DIE : FIGHTER_HP_GAIN, abilityRefs, spellRefs: [] as string[], resourceGrants: resourceGrants(number), ...(number === 3 ? { progressionChoices: [{ choiceId: "fighter-subclass", required: true as const, count: 1 as const, kind: "subclass" as const, options: [subclass] }] } : {}) },
  });
  return [
    level(1, [attack, secondWind]),
    level(2, [actionSurge]),
    level(3, []),
    ...FIGHTER_LEVEL_NUMBERS.slice(3).map((number) => level(number, [])),
  ];
}

export function fighterSubclasses(refs: StarterReferences) {
  return [{
    reference: championReference(refs),
    name: "Champion",
    description: "Bounded SRD 5.1 Champion Martial Archetype metadata for the Fighter class; Improved Critical, Remarkable Athlete, Additional Fighting Style, Superior Critical, and Survivor remain unsupported at runtime.",
    tags: ["srd-5.1", "subclass", "fighter"],
    mechanics: { classRef: refs.klass, level: 3, abilityRefs: [] as string[] },
  }];
}
