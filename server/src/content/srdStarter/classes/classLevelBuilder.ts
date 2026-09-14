import type { StarterReference, StarterReferences } from "../references.js";

/**
 * Shared builders for class progression definitions. Each class owns its own
 * module under `classes/`; this file only provides the formulaic parts so the
 * per-class modules stay small and parallel-safe.
 */

export function classLevelRef(refs: StarterReferences, slug: string): StarterReference {
  return refs.ref("class-level", `srd-5.1:class-level:${slug}`);
}

export function classRef(refs: StarterReferences, slug: string): StarterReference {
  return refs.ref("class", `srd-5.1:class:${slug}`);
}

export function proficiencyBonusFor(level: number): number {
  return 2 + Math.floor((level - 1) / 4);
}

export function buildUnsupportedClassLevel(
  classRef: StarterReference,
  levelRef: StarterReference,
  className: string,
  level: number,
  hitDie: number,
) {
  return {
    reference: levelRef,
    name: `${className} Level ${level}`,
    description: `SRD ${className} level ${level} progression metadata; subclass and execution-dependent features remain unsupported.`,
    tags: ["srd-5.1", "unsupported-runtime", `${className.toLowerCase()}-${level}`],
    mechanics: {
      classRef,
      level,
      proficiencyBonus: level < 5 ? 2 : 3,
      hpGain: 6,
      abilityRefs: [],
      spellRefs: [],
      resourceGrants: [{ resourceId: `hit-dice-d${hitDie}`, maxIncrease: 1, currentIncrease: 1 }],
    },
  };
}
