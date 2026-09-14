import type { StarterReferences } from "../references.js";
import { classLevelRef, classRef, proficiencyBonusFor } from "./classLevelBuilder.js";

interface SorcererResourceGrant {
  resourceId: string;
  maxIncrease: number;
  currentIncrease: number;
  recovery?: "long-rest";
}

interface SorcererLevelData {
  description: string;
  grants: readonly SorcererResourceGrant[];
}

/**
 * Bounded per-level Sorcerer metadata. Font of Magic, Metamagic, and Sorcerous
 * Origin features are described but not executable; Sorcery Points and the
 * highest available spell-slot capacity are tracked as capacity-only grants.
 */
const SORCERER_LEVEL_DATA: readonly SorcererLevelData[] = [
  { description: "Level-one Sorcerer casts with Charisma and uses the d6 maximum hit die; Sorcerous Origin selection is deferred to level 3 in this pack.", grants: [{ resourceId: "spell-slot-1", maxIncrease: 2, currentIncrease: 2 }] },
  { description: "Font of Magic unlocks Sorcery Points for flexible spellcasting; point-to-slot conversion is not executable.", grants: [{ resourceId: "sorcery-points", maxIncrease: 2, currentIncrease: 2, recovery: "long-rest" }, { resourceId: "spell-slot-1", maxIncrease: 3, currentIncrease: 3 }] },
  { description: "Metamagic and the Draconic Bloodline Sorcerous Origin gate are offered as bounded catalog metadata.", grants: [{ resourceId: "sorcery-points", maxIncrease: 3, currentIncrease: 3, recovery: "long-rest" }, { resourceId: "spell-slot-2", maxIncrease: 2, currentIncrease: 2 }] },
  { description: "Ability Score Improvement is an SRD Sorcerer choice; this pack records the level without applying the increase.", grants: [{ resourceId: "sorcery-points", maxIncrease: 4, currentIncrease: 4, recovery: "long-rest" }, { resourceId: "spell-slot-2", maxIncrease: 3, currentIncrease: 3 }] },
  { description: "Third-level spell slots become available; no other Sorcerer feature is executable at this level.", grants: [{ resourceId: "sorcery-points", maxIncrease: 5, currentIncrease: 5, recovery: "long-rest" }, { resourceId: "spell-slot-3", maxIncrease: 2, currentIncrease: 2 }] },
  { description: "Draconic Bloodline Elemental Affinity is a subclass feature; its damage bonus is not executable.", grants: [{ resourceId: "sorcery-points", maxIncrease: 6, currentIncrease: 6, recovery: "long-rest" }, { resourceId: "spell-slot-3", maxIncrease: 3, currentIncrease: 3 }] },
  { description: "Fourth-level spell slots become available; no other Sorcerer feature is executable at this level.", grants: [{ resourceId: "sorcery-points", maxIncrease: 7, currentIncrease: 7, recovery: "long-rest" }, { resourceId: "spell-slot-4", maxIncrease: 1, currentIncrease: 1 }] },
  { description: "Ability Score Improvement is recorded as bounded metadata only and is not applied.", grants: [{ resourceId: "sorcery-points", maxIncrease: 8, currentIncrease: 8, recovery: "long-rest" }, { resourceId: "spell-slot-4", maxIncrease: 2, currentIncrease: 2 }] },
  { description: "Fifth-level spell slots become available; no other Sorcerer feature is executable at this level.", grants: [{ resourceId: "sorcery-points", maxIncrease: 9, currentIncrease: 9, recovery: "long-rest" }, { resourceId: "spell-slot-5", maxIncrease: 1, currentIncrease: 1 }] },
  { description: "Metamagic options expand at level 10; metamagic execution remains unsupported.", grants: [{ resourceId: "sorcery-points", maxIncrease: 10, currentIncrease: 10, recovery: "long-rest" }, { resourceId: "spell-slot-5", maxIncrease: 2, currentIncrease: 2 }] },
  { description: "Sixth-level spell slots become available; no other Sorcerer feature is executable at this level.", grants: [{ resourceId: "sorcery-points", maxIncrease: 11, currentIncrease: 11, recovery: "long-rest" }, { resourceId: "spell-slot-6", maxIncrease: 1, currentIncrease: 1 }] },
  { description: "Ability Score Improvement is recorded as bounded metadata only and is not applied.", grants: [{ resourceId: "sorcery-points", maxIncrease: 12, currentIncrease: 12, recovery: "long-rest" }, { resourceId: "spell-slot-6", maxIncrease: 1, currentIncrease: 1 }] },
  { description: "Seventh-level spell slots become available; no other Sorcerer feature is executable at this level.", grants: [{ resourceId: "sorcery-points", maxIncrease: 13, currentIncrease: 13, recovery: "long-rest" }, { resourceId: "spell-slot-7", maxIncrease: 1, currentIncrease: 1 }] },
  { description: "Draconic Bloodline Dragon Wings is a subclass feature; flight execution remains unsupported.", grants: [{ resourceId: "sorcery-points", maxIncrease: 14, currentIncrease: 14, recovery: "long-rest" }, { resourceId: "spell-slot-7", maxIncrease: 1, currentIncrease: 1 }] },
  { description: "Eighth-level spell slots become available; no other Sorcerer feature is executable at this level.", grants: [{ resourceId: "sorcery-points", maxIncrease: 15, currentIncrease: 15, recovery: "long-rest" }, { resourceId: "spell-slot-8", maxIncrease: 1, currentIncrease: 1 }] },
  { description: "Ability Score Improvement is recorded as bounded metadata only and is not applied.", grants: [{ resourceId: "sorcery-points", maxIncrease: 16, currentIncrease: 16, recovery: "long-rest" }, { resourceId: "spell-slot-8", maxIncrease: 1, currentIncrease: 1 }] },
  { description: "Ninth-level spell slots become available; no other Sorcerer feature is executable at this level.", grants: [{ resourceId: "sorcery-points", maxIncrease: 17, currentIncrease: 17, recovery: "long-rest" }, { resourceId: "spell-slot-9", maxIncrease: 1, currentIncrease: 1 }] },
  { description: "Draconic Bloodline Draconic Presence is a subclass feature; its aura effect remains unsupported.", grants: [{ resourceId: "sorcery-points", maxIncrease: 18, currentIncrease: 18, recovery: "long-rest" }, { resourceId: "spell-slot-9", maxIncrease: 1, currentIncrease: 1 }] },
  { description: "Ability Score Improvement is recorded as bounded metadata only; lower-level spell slots also increase.", grants: [{ resourceId: "sorcery-points", maxIncrease: 19, currentIncrease: 19, recovery: "long-rest" }, { resourceId: "spell-slot-6", maxIncrease: 2, currentIncrease: 2 }] },
  { description: "Sorcerous Restoration restores Sorcery Points on a short rest; the recovery effect is not executable.", grants: [{ resourceId: "sorcery-points", maxIncrease: 20, currentIncrease: 20, recovery: "long-rest" }, { resourceId: "spell-slot-7", maxIncrease: 2, currentIncrease: 2 }] },
];

const SORCERER_CLASS_SLUG = "sorcerer";
const DRACONIC_BLOODLINE_DEFINITION_ID = "srd-5.1:subclass:draconic-bloodline";

export function sorcererDefinition(refs: StarterReferences) {
  return {
    reference: classRef(refs, SORCERER_CLASS_SLUG),
    name: "Sorcerer",
    description: "Bounded SRD 5.1 Sorcerer progression covers levels 1-20 as catalog metadata; Font of Magic, Metamagic, and Draconic Bloodline execution remain unsupported.",
    tags: ["srd-5.1", "sorcerer-1-20", "unsupported-runtime"],
    mechanics: {
      hitDie: 6,
      primaryAttribute: "charisma",
      savingAttributes: ["constitution", "charisma"],
      levelRefs: SORCERER_LEVEL_DATA.map((_, index) => classLevelRef(refs, `${SORCERER_CLASS_SLUG}-${index + 1}`)),
    },
  };
}

export function sorcererLevels(refs: StarterReferences) {
  const sorcerer = classRef(refs, SORCERER_CLASS_SLUG);
  const draconicBloodline = refs.ref("subclass", DRACONIC_BLOODLINE_DEFINITION_ID);
  return SORCERER_LEVEL_DATA.map((data, index) => {
    const level = index + 1;
    return {
      reference: classLevelRef(refs, `${SORCERER_CLASS_SLUG}-${level}`),
      name: `Sorcerer Level ${level}`,
      description: data.description,
      tags: ["srd-5.1", `sorcerer-${level}`, "unsupported-runtime"],
      mechanics: {
        classRef: sorcerer,
        level,
        proficiencyBonus: proficiencyBonusFor(level),
        hpGain: level === 1 ? 6 : 4,
        abilityRefs: [],
        spellRefs: [],
        resourceGrants: [{ resourceId: "hit-dice-d6", maxIncrease: 1, currentIncrease: 1 }, ...data.grants],
        ...(level === 3
          ? { progressionChoices: [{ choiceId: "sorcerer-subclass", required: true as const, count: 1 as const, kind: "subclass" as const, options: [draconicBloodline] }] }
          : {}),
      },
    };
  });
}

export function sorcererSubclasses(refs: StarterReferences) {
  return [
    {
      reference: refs.ref("subclass", DRACONIC_BLOODLINE_DEFINITION_ID),
      name: "Draconic Bloodline",
      description: "Bounded SRD 5.1 Sorcerer subclass metadata; draconic resilience, elemental affinity, and dragon wings execution remain unsupported.",
      tags: ["srd-5.1", "subclass", "sorcerer"],
      mechanics: { classRef: classRef(refs, SORCERER_CLASS_SLUG), level: 3, abilityRefs: [] },
    },
  ];
}
