import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel, classLevelRef, classRef, proficiencyBonusFor } from "./classLevelBuilder.js";

const CLERIC_SLUG = "cleric";
const CLERIC_HIT_DIE = 8 as const;
const CLERIC_HP_GAIN = Math.floor(CLERIC_HIT_DIE / 2) + 1;
const UNSUPPORTED_TAG = "unsupported-runtime";

const CLERIC_LEVEL_NUMBERS = Array.from({ length: 20 }, (_, index) => index + 1);

/** SRD 5.1 Cleric features by level, expressed as bounded non-executable metadata. */
const CLERIC_FEATURE_NOTES: Record<number, string> = {
  1: "grants Wisdom-based spellcasting",
  2: "grants Channel Divinity with Turn Undead",
  3: "offers the Divine Domain subclass progression choice",
  4: "marks the Ability Score Improvement step",
  5: "grants Destroy Undead against low-challenge undead",
  6: "grants a second Channel Divinity use per rest",
  7: "represents fourth-level spell slots",
  8: "marks the Ability Score Improvement and Destroy Undead step",
  9: "represents fifth-level spell slots",
  10: "grants Divine Intervention",
  11: "grants Destroy Undead against stronger undead",
  12: "marks the Ability Score Improvement step",
  13: "represents seventh-level spell slots",
  14: "grants Destroy Undead against stronger undead",
  15: "represents eighth-level spell slots",
  16: "marks the Ability Score Improvement step",
  17: "grants Destroy Undead against stronger undead",
  18: "grants a third Channel Divinity use per rest",
  19: "marks the Ability Score Improvement step",
  20: "grants the Divine Intervention improvement",
};

function levelReference(refs: StarterReferences, level: number) {
  if (level === 1) return refs.clericOne;
  if (level === 2) return refs.levelRefs.clericTwo;
  if (level === 3) return refs.levelRefs.clericThree;
  return classLevelRef(refs, `${CLERIC_SLUG}-${level}`);
}

function subclassReference(refs: StarterReferences) {
  return refs.ref("subclass", "srd-5.1:subclass:life-domain");
}

function hitDieGrant() {
  return { resourceId: `hit-dice-d${CLERIC_HIT_DIE}`, maxIncrease: 1, currentIncrease: 1 };
}

function channelDivinityGrants(level: number) {
  if (level !== 2 && level !== 6 && level !== 18) return [];
  return [{ resourceId: "channel-divinity", maxIncrease: 1, currentIncrease: 1, recovery: "short-rest" as const }];
}

function divineInterventionGrants(level: number) {
  if (level !== 10) return [];
  return [{ resourceId: "divine-intervention", maxIncrease: 1, currentIncrease: 1, recovery: "long-rest" as const }];
}

function featureDescription(level: number) {
  const note = CLERIC_FEATURE_NOTES[level] ?? "progression metadata";
  return `SRD 5.1 Cleric level ${level} ${note}; the feature remains unsupported at runtime.`;
}

export function clericDefinition(refs: StarterReferences) {
  return {
    reference: classRef(refs, CLERIC_SLUG),
    name: "Cleric",
    description: "Bounded SRD 5.1 Cleric progression covers levels 1-20 as metadata. Channel Divinity, Destroy Undead, and Divine Intervention are tracked as bounded resource grants; spell execution and domain features remain unsupported at runtime.",
    tags: ["srd-5.1", "cleric", UNSUPPORTED_TAG],
    mechanics: { hitDie: CLERIC_HIT_DIE, primaryAttribute: "wisdom", savingAttributes: ["wisdom", "charisma"], levelRefs: CLERIC_LEVEL_NUMBERS.map((level) => levelReference(refs, level)) },
  };
}

export function clericLevels(refs: StarterReferences) {
  const { cleric, clericOne, bless, cureWounds, healingWord } = refs;
  const subclass = subclassReference(refs);
  return [
    { reference: clericOne, name: "Cleric Level 1", description: "Level-one Cleric hit points use the d8 maximum. Bless, Cure Wounds, and Healing Word are exact prepared-spell selections; the supported healing spells enforce their target and range contracts.", tags: ["srd-5.1", "cleric-1", "prepared-spells"], mechanics: { classRef: cleric, level: 1, proficiencyBonus: proficiencyBonusFor(1), hpGain: CLERIC_HIT_DIE, abilityRefs: [], spellRefs: [], preparedSpellRefs: [bless, cureWounds, healingWord], resourceGrants: [hitDieGrant()] } },
    ...CLERIC_LEVEL_NUMBERS.slice(1).map((level) => {
      const base = buildUnsupportedClassLevel(cleric, levelReference(refs, level), "Cleric", level, CLERIC_HIT_DIE);
      return {
        ...base,
        description: featureDescription(level),
        tags: ["srd-5.1", UNSUPPORTED_TAG, `cleric-${level}`],
        mechanics: {
          ...base.mechanics,
          proficiencyBonus: proficiencyBonusFor(level),
          hpGain: CLERIC_HP_GAIN,
          resourceGrants: [hitDieGrant(), ...channelDivinityGrants(level), ...divineInterventionGrants(level)],
          ...(level === 3 ? { progressionChoices: [{ choiceId: "cleric-subclass", required: true as const, count: 1 as const, kind: "subclass" as const, options: [subclass] }] } : {}),
        },
      };
    }),
  ];
}

export function clericSubclasses(refs: StarterReferences) {
  return [{
    reference: subclassReference(refs),
    name: "Life Domain",
    description: "Bounded SRD 5.1 Life Domain subclass metadata bound to the Cleric class at level 3; its domain spells and features remain unsupported at runtime.",
    tags: ["srd-5.1", "subclass", "cleric"],
    mechanics: { classRef: refs.cleric, level: 3, abilityRefs: [] as string[] },
  }];
}
