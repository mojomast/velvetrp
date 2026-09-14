import type { StarterReferences } from "../references.js";
import { classLevelRef, classRef, proficiencyBonusFor } from "./classLevelBuilder.js";

/** SRD 5.1 full-caster spell slots by character level (index 0 = level 1). */
const BARD_SLOTS: readonly (readonly number[])[] = [
  [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

const BARD_FEATURES: readonly string[] = [
  "Spellcasting uses Charisma and Bardic Inspiration grants three long-rest uses.",
  "Jack of All Trades adds half proficiency to untrained checks and Song of Rest improves short-rest healing.",
  "Bard College selection and Expertise in two skills.",
  "Ability Score Improvement.",
  "Font of Inspiration restores Bardic Inspiration on a short or long rest.",
  "Countercharm and the selected Bard College feature.",
  "No new Bard feature at this level.",
  "Ability Score Improvement.",
  "Song of Rest improves to a d8.",
  "Magical Secrets adds two spells from any class and Expertise covers two more skills.",
  "No new Bard feature at this level.",
  "Ability Score Improvement.",
  "Song of Rest improves to a d10.",
  "Magical Secrets adds two more spells from any class.",
  "Song of Rest improves to a d12.",
  "Ability Score Improvement.",
  "No new Bard feature at this level.",
  "Magical Secrets adds two more spells from any class.",
  "Ability Score Improvement.",
  "Superior Inspiration restores Bardic Inspiration when rolling initiative with none remaining.",
];

function spellSlotGrants(level: number) {
  const current = BARD_SLOTS[level - 1] ?? [];
  const previous = BARD_SLOTS[level - 2] ?? [];
  return current.flatMap((count, index) => {
    const increase = count - (previous[index] ?? 0);
    return increase > 0 ? [{ resourceId: `spell-slot-${index + 1}`, maxIncrease: increase, currentIncrease: increase }] : [];
  });
}

function collegeOfLoreRef(refs: StarterReferences) {
  return refs.ref("subclass", "srd-5.1:subclass:college-of-lore");
}

export function bardDefinition(refs: StarterReferences) {
  return {
    reference: classRef(refs, "bard"),
    name: "Bard",
    description: "Bounded SRD Bard progression covers levels 1-20 as metadata; spellcasting, Bardic Inspiration, and College of Lore features are not executable.",
    tags: ["srd-5.1", "bard"],
    mechanics: { hitDie: 8, primaryAttribute: "charisma", savingAttributes: ["dexterity", "charisma"], levelRefs: Array.from({ length: 20 }, (_, index) => classLevelRef(refs, `bard-${index + 1}`)) },
  };
}

export function bardLevels(refs: StarterReferences) {
  const classReference = classRef(refs, "bard");
  return BARD_FEATURES.map((feature, index) => {
    const level = index + 1;
    return {
      reference: classLevelRef(refs, `bard-${level}`),
      name: `Bard Level ${level}`,
      description: `Bard level ${level} bounded progression metadata: ${feature} Execution remains unsupported.`,
      tags: ["srd-5.1", "unsupported-runtime", `bard-${level}`],
      mechanics: {
        classRef: classReference, level, proficiencyBonus: proficiencyBonusFor(level), hpGain: level === 1 ? 8 : 5, abilityRefs: [] as string[], spellRefs: [] as string[],
        resourceGrants: [
          { resourceId: "hit-dice-d8", maxIncrease: 1, currentIncrease: 1 },
          ...(level === 1 ? [{ resourceId: "bardic-inspiration", maxIncrease: 3, currentIncrease: 3, recovery: "long-rest" as const }] : []),
          ...spellSlotGrants(level),
        ],
        ...(level === 3 ? { progressionChoices: [{ choiceId: "bard-subclass", required: true as const, count: 1 as const, kind: "subclass" as const, options: [collegeOfLoreRef(refs)] }] } : {}),
      },
    };
  });
}

export function bardSubclasses(refs: StarterReferences) {
  return [{
    reference: collegeOfLoreRef(refs),
    name: "College of Lore",
    description: "Bounded SRD College of Lore metadata for the Bard class; its features remain unsupported.",
    tags: ["srd-5.1", "subclass", "bard"],
    mechanics: { classRef: classRef(refs, "bard"), level: 3, abilityRefs: [] as string[] },
  }];
}
