import type { StarterReferences } from "../references.js";
import { buildUnsupportedClassLevel, classLevelRef, classRef, proficiencyBonusFor } from "./classLevelBuilder.js";

/**
 * Bounded SRD 5.1 Warlock metadata: one class, twenty class-level definitions
 * (levels 1-20), and The Fiend subclass. Pact Magic, Eldritch Invocations, Pact
 * Boon, Mystic Arcanum, and patron features are tracked as reference-free
 * resource/tag metadata only; none of them are executable rules.
 */

const WARLOCK_SLUG = "warlock";
const WARLOCK_HIT_DIE = 8;
const WARLOCK_SUBCLASS_ID = "srd-5.1:subclass:the-fiend";
const BASE_TAGS = ["srd-5.1", "warlock", "unsupported-runtime"];

function warlockLevelRef(refs: StarterReferences, level: number) {
  return classLevelRef(refs, `${WARLOCK_SLUG}-${level}`);
}

function warlockSubclassRef(refs: StarterReferences) {
  return refs.ref("subclass", WARLOCK_SUBCLASS_ID);
}

function tags(...extra: string[]) {
  return [...BASE_TAGS, ...extra];
}

function hitDieGrant() {
  return { resourceId: `hit-dice-d${WARLOCK_HIT_DIE}`, maxIncrease: 1, currentIncrease: 1 };
}

function pactMagicGrant() {
  return { resourceId: "pact-magic-slot", maxIncrease: 1, currentIncrease: 1, recovery: "short-rest" as const };
}

function mysticArcanumGrant(spellLevel: number) {
  return { resourceId: `mystic-arcanum-${spellLevel}`, maxIncrease: 1, currentIncrease: 1, recovery: "long-rest" as const };
}

function metadataLevel(
  refs: StarterReferences,
  level: number,
  description: string,
  levelTags: string[],
  resourceGrants: ReturnType<typeof hitDieGrant>[],
  progressionChoices?: object[],
) {
  const base = buildUnsupportedClassLevel(classRef(refs, WARLOCK_SLUG), warlockLevelRef(refs, level), "Warlock", level, WARLOCK_HIT_DIE);
  return {
    ...base,
    description,
    tags: levelTags,
    mechanics: {
      ...base.mechanics,
      proficiencyBonus: proficiencyBonusFor(level),
      hpGain: level === 1 ? WARLOCK_HIT_DIE : Math.floor(WARLOCK_HIT_DIE / 2) + 1,
      resourceGrants,
      ...(progressionChoices ? { progressionChoices } : {}),
    },
  };
}

export function warlockDefinition(refs: StarterReferences) {
  const levelRefs = Array.from({ length: 20 }, (_, index) => warlockLevelRef(refs, index + 1));
  return {
    reference: classRef(refs, WARLOCK_SLUG),
    name: "Warlock",
    description: "Bounded SRD 5.1 Warlock progression covers levels 1-20 as metadata; Pact Magic, Eldritch Invocations, Pact Boon, Mystic Arcanum, and The Fiend features are not executable.",
    tags: ["srd-5.1", "warlock", "warlock-1-20"],
    mechanics: { hitDie: WARLOCK_HIT_DIE, primaryAttribute: "charisma", savingAttributes: ["wisdom", "charisma"], levelRefs },
  };
}

export function warlockLevels(refs: StarterReferences) {
  return [
    metadataLevel(refs, 1, "Level-one Warlock grants Pact Magic, d8 hit points, two cantrips, and two known spells as tracked metadata; spellcasting is not executable.", tags("pact-magic"), [hitDieGrant(), pactMagicGrant()]),
    metadataLevel(refs, 2, "Level-two Warlock gains a second short-rest Pact Magic slot and the Eldritch Invocations feature; invocations are tracked metadata only.", tags("eldritch-invocations"), [hitDieGrant(), pactMagicGrant()]),
    metadataLevel(refs, 3, "Level-three Warlock selects a Pact Boon and an Otherworldly Patron; The Fiend is offered as a bounded subclass choice and remains non-executable.", tags("pact-boon"), [hitDieGrant()], [{ choiceId: "warlock-subclass", required: true, count: 1, kind: "subclass", options: [warlockSubclassRef(refs)] }]),
    metadataLevel(refs, 4, "Level-four Warlock grants an Ability Score Improvement; the increase is tracked as metadata only.", tags("ability-score-improvement"), [hitDieGrant()]),
    metadataLevel(refs, 5, "Level-five Warlock progression metadata; the Pact Magic slot level rises to 3rd.", tags(), [hitDieGrant()]),
    metadataLevel(refs, 6, "Level-six Warlock gains an Otherworldly Patron feature; patron features remain non-executable metadata.", tags("otherworldly-patron-feature"), [hitDieGrant()]),
    metadataLevel(refs, 7, "Level-seven Warlock progression metadata; the Pact Magic slot level rises to 4th.", tags(), [hitDieGrant()]),
    metadataLevel(refs, 8, "Level-eight Warlock grants an Ability Score Improvement; the increase is tracked as metadata only.", tags("ability-score-improvement"), [hitDieGrant()]),
    metadataLevel(refs, 9, "Level-nine Warlock progression metadata; the Pact Magic slot level rises to 5th.", tags(), [hitDieGrant()]),
    metadataLevel(refs, 10, "Level-ten Warlock gains an Otherworldly Patron feature; patron features remain non-executable metadata.", tags("otherworldly-patron-feature"), [hitDieGrant()]),
    metadataLevel(refs, 11, "Level-eleven Warlock gains a third Pact Magic slot and the 6th-level Mystic Arcanum; both are bounded metadata.", tags("mystic-arcanum"), [hitDieGrant(), pactMagicGrant(), mysticArcanumGrant(6)]),
    metadataLevel(refs, 12, "Level-twelve Warlock grants an Ability Score Improvement; the increase is tracked as metadata only.", tags("ability-score-improvement"), [hitDieGrant()]),
    metadataLevel(refs, 13, "Level-thirteen Warlock gains the 7th-level Mystic Arcanum as bounded metadata.", tags("mystic-arcanum"), [hitDieGrant(), mysticArcanumGrant(7)]),
    metadataLevel(refs, 14, "Level-fourteen Warlock gains an Otherworldly Patron feature; patron features remain non-executable metadata.", tags("otherworldly-patron-feature"), [hitDieGrant()]),
    metadataLevel(refs, 15, "Level-fifteen Warlock gains the 8th-level Mystic Arcanum as bounded metadata.", tags("mystic-arcanum"), [hitDieGrant(), mysticArcanumGrant(8)]),
    metadataLevel(refs, 16, "Level-sixteen Warlock grants an Ability Score Improvement; the increase is tracked as metadata only.", tags("ability-score-improvement"), [hitDieGrant()]),
    metadataLevel(refs, 17, "Level-seventeen Warlock gains a fourth Pact Magic slot and the 9th-level Mystic Arcanum; both are bounded metadata.", tags("mystic-arcanum"), [hitDieGrant(), pactMagicGrant(), mysticArcanumGrant(9)]),
    metadataLevel(refs, 18, "Level-eighteen Warlock gains an Otherworldly Patron feature; patron features remain non-executable metadata.", tags("otherworldly-patron-feature"), [hitDieGrant()]),
    metadataLevel(refs, 19, "Level-nineteen Warlock grants an Ability Score Improvement; the increase is tracked as metadata only.", tags("ability-score-improvement"), [hitDieGrant()]),
    metadataLevel(refs, 20, "Level-twenty Warlock gains Eldritch Master, restoring Pact Magic slots on a short rest; tracked as metadata only.", tags("eldritch-master"), [hitDieGrant()]),
  ];
}

export function warlockSubclasses(refs: StarterReferences) {
  return [
    {
      reference: warlockSubclassRef(refs),
      name: "The Fiend",
      description: "The Fiend is a bounded SRD 5.1 Warlock Otherworldly Patron; its expanded spell list and patron features are not executable.",
      tags: ["srd-5.1", "subclass", "warlock"],
      mechanics: { classRef: classRef(refs, WARLOCK_SLUG), level: 3, abilityRefs: [] },
    },
  ];
}
