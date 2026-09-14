import type { StarterReferences } from "../references.js";
import { classLevelRef, classRef, proficiencyBonusFor } from "./classLevelBuilder.js";

const RANGER_SLUG = "ranger";
const RANGER_HIT_DIE = 10 as const;
const RANGER_HP_GAIN = Math.floor(RANGER_HIT_DIE / 2) + 1;
const UNSUPPORTED_TAG = "unsupported-runtime";
const HUNTER_DEFINITION_ID = "srd-5.1:subclass:hunter";

interface RangerLevelData {
  description: string;
  featureTags: readonly string[];
}

/** SRD 5.1 Ranger features by level expressed as bounded, non-executable metadata. */
const RANGER_LEVEL_DATA: readonly RangerLevelData[] = [
  { description: "Favored Enemy and Natural Explorer are recorded as bounded feature metadata; their tracking effects are not executable.", featureTags: ["favored-enemy", "natural-explorer"] },
  { description: "Fighting Style and Spellcasting are recorded as bounded metadata; neither is executable.", featureTags: ["fighting-style", "spellcasting"] },
  { description: "Primeval Awareness and the Ranger Archetype gate are recorded; the Hunter archetype is a bounded subclass selection.", featureTags: ["primeval-awareness", "ranger-archetype"] },
  { description: "Ability Score Improvement is recorded as bounded advancement metadata.", featureTags: ["ability-score-improvement"] },
  { description: "Extra Attack is recorded as bounded metadata; the additional weapon attack is not executable.", featureTags: ["extra-attack"] },
  { description: "Favored Enemy improvements and the Hunter archetype feature are recorded as bounded metadata.", featureTags: ["favored-enemy"] },
  { description: "No new Ranger feature at this level.", featureTags: [] },
  { description: "Ability Score Improvement and Land's Stride are recorded as bounded metadata.", featureTags: ["ability-score-improvement", "lands-stride"] },
  { description: "No new Ranger feature at this level.", featureTags: [] },
  { description: "Hide in Plain Sight and the Hunter archetype feature are recorded as bounded metadata.", featureTags: ["hide-in-plain-sight"] },
  { description: "No new Ranger feature at this level.", featureTags: [] },
  { description: "Ability Score Improvement is recorded as bounded advancement metadata.", featureTags: ["ability-score-improvement"] },
  { description: "No new Ranger feature at this level.", featureTags: [] },
  { description: "Vanish is recorded as bounded metadata; its hide and stealth effects are not executable.", featureTags: ["vanish"] },
  { description: "No new Ranger feature at this level.", featureTags: [] },
  { description: "Ability Score Improvement is recorded as bounded advancement metadata.", featureTags: ["ability-score-improvement"] },
  { description: "No new Ranger feature at this level.", featureTags: [] },
  { description: "Feral Senses are recorded as bounded metadata.", featureTags: ["feral-senses"] },
  { description: "Ability Score Improvement is recorded as bounded advancement metadata.", featureTags: ["ability-score-improvement"] },
  { description: "Foe Slayer is recorded as bounded metadata; its attack or damage bonus is not executable.", featureTags: ["foe-slayer"] },
];

function rangerLevelRef(refs: StarterReferences, level: number) {
  if (level === 1) return refs.rangerOne;
  if (level === 2) return refs.levelRefs.rangerTwo;
  if (level === 3) return refs.levelRefs.rangerThree;
  return classLevelRef(refs, `${RANGER_SLUG}-${level}`);
}

function hunterRef(refs: StarterReferences) {
  return refs.ref("subclass", HUNTER_DEFINITION_ID);
}

export function rangerDefinition(refs: StarterReferences) {
  return {
    reference: classRef(refs, RANGER_SLUG),
    name: "Ranger",
    description: "Bounded SRD 5.1 Ranger progression covers levels 1-20 as metadata; Favored Enemy, Natural Explorer, spellcasting, and Hunter archetype execution remain unsupported.",
    tags: ["srd-5.1", "ranger", UNSUPPORTED_TAG],
    mechanics: { hitDie: RANGER_HIT_DIE, primaryAttribute: "dexterity", savingAttributes: ["strength", "dexterity"], levelRefs: Array.from({ length: 20 }, (_, index) => rangerLevelRef(refs, index + 1)) },
  };
}

export function rangerLevels(refs: StarterReferences) {
  const classReference = classRef(refs, RANGER_SLUG);
  const hunter = hunterRef(refs);
  return RANGER_LEVEL_DATA.map((data, index) => {
    const level = index + 1;
    return {
      reference: rangerLevelRef(refs, level),
      name: `Ranger Level ${level}`,
      description: `SRD 5.1 Ranger level ${level}: ${data.description}`,
      tags: ["srd-5.1", UNSUPPORTED_TAG, `ranger-${level}`, ...data.featureTags],
      mechanics: {
        classRef: classReference,
        level,
        proficiencyBonus: proficiencyBonusFor(level),
        hpGain: level === 1 ? RANGER_HIT_DIE : RANGER_HP_GAIN,
        abilityRefs: level === 1 ? [refs.favoredEnemy, refs.naturalExplorer] : ([] as string[]),
        spellRefs: [] as string[],
        resourceGrants: [{ resourceId: `hit-dice-d${RANGER_HIT_DIE}`, maxIncrease: 1, currentIncrease: 1 }],
        ...(level === 3 ? { progressionChoices: [{ choiceId: "ranger-subclass", required: true as const, count: 1 as const, kind: "subclass" as const, options: [hunter] }] } : {}),
      },
    };
  });
}

export function rangerSubclasses(refs: StarterReferences) {
  return [{
    reference: hunterRef(refs),
    name: "Hunter",
    description: "Bounded SRD 5.1 Hunter archetype metadata for the Ranger class; Hunter's Prey, Defensive Tactics, Multiattack, and Superior Hunter's Defense remain unsupported.",
    tags: ["srd-5.1", "subclass", "ranger"],
    mechanics: { classRef: refs.ranger, level: 3, abilityRefs: [] as string[] },
  }];
}
