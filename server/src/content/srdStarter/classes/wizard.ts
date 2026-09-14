import type { StarterReferences } from "../references.js";
import { classLevelRef, proficiencyBonusFor } from "./classLevelBuilder.js";

/** SRD 5.1 full-caster spell slots by character level (index 0 = level 1). */
const WIZARD_SLOTS: readonly (readonly number[])[] = [
  [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

/** SRD 5.1 Wizard features by level, expressed as bounded non-executable metadata. */
const WIZARD_FEATURES: readonly string[] = [
  "grants Arcane Recovery and Intelligence-based spellcasting.",
  "represents the Arcane Tradition step.",
  "offers the School of Evocation subclass progression choice.",
  "marks the Ability Score Improvement step.",
  "represents third-level spell slots.",
  "represents the Arcane Tradition feature step.",
  "represents fourth-level spell slots.",
  "marks the Ability Score Improvement step.",
  "represents fifth-level spell slots.",
  "represents the Arcane Tradition feature step.",
  "represents sixth-level spell slots.",
  "marks the Ability Score Improvement step.",
  "represents seventh-level spell slots.",
  "represents the Arcane Tradition feature step.",
  "represents eighth-level spell slots.",
  "marks the Ability Score Improvement step.",
  "represents ninth-level spell slots.",
  "grants Spell Mastery.",
  "marks the Ability Score Improvement step.",
  "grants Signature Spells.",
];

const WIZARD_LEVEL_NUMBERS = Array.from({ length: 20 }, (_, index) => index + 1);

function levelReference(refs: StarterReferences, level: number) {
  if (level === 1) return refs.wizardOne;
  if (level === 2) return refs.levelRefs.wizardTwo;
  if (level === 3) return refs.levelRefs.wizardThree;
  return classLevelRef(refs, `wizard-${level}`);
}

function schoolOfEvocationRef(refs: StarterReferences) {
  return refs.ref("subclass", "srd-5.1:subclass:school-of-evocation");
}

function spellSlotGrants(level: number) {
  const current = WIZARD_SLOTS[level - 1] ?? [];
  const previous = WIZARD_SLOTS[level - 2] ?? [];
  return current.flatMap((count, index) => {
    const increase = count - (previous[index] ?? 0);
    return increase > 0 ? [{ resourceId: `spell-slot-${index + 1}`, maxIncrease: increase, currentIncrease: increase, recovery: "long-rest" as const }] : [];
  });
}

function featureGrants(level: number) {
  if (level === 18) return [{ resourceId: "spell-mastery", maxIncrease: 2, currentIncrease: 2, recovery: "long-rest" as const }];
  if (level === 20) return [{ resourceId: "signature-spells", maxIncrease: 2, currentIncrease: 2, recovery: "long-rest" as const }];
  return [];
}

function featureDescription(level: number, feature: string) {
  return `SRD 5.1 Wizard level ${level} bounded progression metadata: ${feature} Execution remains unsupported.`;
}

export function wizardDefinition(refs: StarterReferences) {
  return {
    reference: refs.wizard,
    name: "Wizard",
    description: "Bounded SRD 5.1 Wizard progression covers levels 1-20 as metadata, including Arcane Recovery, Spell Mastery, Signature Spells, and the School of Evocation. Spell execution and Arcane Tradition features remain unsupported at runtime.",
    tags: ["srd-5.1", "wizard", "unsupported-runtime"],
    mechanics: { hitDie: 6, primaryAttribute: "intelligence", savingAttributes: ["intelligence", "wisdom"], levelRefs: WIZARD_LEVEL_NUMBERS.map((level) => levelReference(refs, level)) },
  };
}

export function wizardLevels(refs: StarterReferences) {
  return WIZARD_FEATURES.map((feature, index) => {
    const level = index + 1;
    const isLevelOne = level === 1;
    return {
      reference: levelReference(refs, level),
      name: `Wizard Level ${level}`,
      description: featureDescription(level, feature),
      tags: isLevelOne ? ["srd-5.1", "wizard-1", "unsupported-runtime"] : ["srd-5.1", "unsupported-runtime", `wizard-${level}`],
      mechanics: {
        classRef: refs.wizard, level, proficiencyBonus: proficiencyBonusFor(level), hpGain: level === 1 ? 6 : 4,
        abilityRefs: isLevelOne ? [refs.wizardSpellbook] : [] as string[],
        spellRefs: isLevelOne ? [refs.wizardCantrip, refs.rayOfFrost] : [] as string[],
        ...(isLevelOne ? { preparedSpellRefs: [refs.magicMissile, refs.falseLife, refs.shield] } : {}),
        resourceGrants: [
          ...spellSlotGrants(level),
          { resourceId: "hit-dice-d6", maxIncrease: 1, currentIncrease: 1 },
          ...featureGrants(level),
        ],
        ...(level === 3 ? { progressionChoices: [{ choiceId: "wizard-subclass", required: true as const, count: 1 as const, kind: "subclass" as const, options: [schoolOfEvocationRef(refs)] }] } : {}),
      },
    };
  });
}

export function wizardSubclasses(refs: StarterReferences) {
  return [{
    reference: schoolOfEvocationRef(refs),
    name: "School of Evocation",
    description: "Bounded SRD 5.1 School of Evocation subclass metadata bound to the Wizard class at level 3; its features remain unsupported.",
    tags: ["srd-5.1", "subclass", "wizard"],
    mechanics: { classRef: refs.wizard, level: 3, abilityRefs: [] as string[] },
  }];
}
