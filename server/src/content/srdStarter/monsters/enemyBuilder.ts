import type { StarterReference, StarterReferences } from "../references.js";

/**
 * Shared builders for SRD monster content. Each CR band owns one file under
 * `monsters/` and exports a `band(refs)` returning `{ abilities, enemies }`;
 * this module only standardizes the bounded shapes so bands stay small and
 * parallel-safe.
 */

export type MonsterDamageType =
  | "physical" | "bludgeoning" | "piercing" | "slashing" | "fire" | "frost"
  | "cold" | "force" | "storm" | "radiant" | "shadow";

export interface MonsterAttackSpec {
  abilitySlug: string;
  name: string;
  damageType: MonsterDamageType;
  count: number;
  sides: 4 | 6 | 8 | 10 | 12;
  modifier: number;
}

/** One executable basic melee attack ability for a monster. */
export function monsterAttack(refs: StarterReferences, spec: MonsterAttackSpec) {
  return {
    reference: refs.ref("ability", `srd-5.1:ability:${spec.abilitySlug}`),
    name: spec.name,
    description: `The executable basic melee attack selected from the ${spec.name} entry.`,
    tags: ["srd-5.1", "enemy-basic-attack"],
    mechanics: {
      actionCost: "action" as const, recovery: "none" as const, uses: 0, target: "enemy" as const,
      effects: [{ type: "damage" as const, damageType: spec.damageType, dice: { count: spec.count, sides: spec.sides, modifier: spec.modifier } }],
    },
  };
}

/** One bounded, non-executable monster trait marker. */
export function monsterTrait(refs: StarterReferences, slug: string, name: string, description: string) {
  return {
    reference: refs.ref("ability", `srd-5.1:ability:${slug}`),
    name,
    description,
    tags: ["srd-5.1", "enemy-trait", "bounded", "unsupported-runtime"],
    mechanics: { actionCost: "passive" as const, recovery: "none" as const, uses: 0, target: "self" as const, effects: [] },
  };
}

export interface MonsterTemplateSpec {
  slug: string;
  name: string;
  cr: number;
  crTag: string;
  maxHp: number;
  defense: number;
  speed: number;
  attackBonus: number;
  primaryAttack: StarterReference;
  traitRefs?: readonly StarterReference[];
  resistances?: readonly MonsterDamageType[];
  vulnerabilities?: readonly MonsterDamageType[];
  immunities?: readonly MonsterDamageType[];
}

export function monsterTemplate(refs: StarterReferences, spec: MonsterTemplateSpec) {
  const tier = Math.min(20, Math.max(1, Math.ceil(spec.cr)));
  const traitRefs = spec.traitRefs ?? [];
  return {
    reference: refs.ref("enemy-template", `srd-5.1:enemy-template:${spec.slug}`),
    name: spec.name,
    description: `${spec.name} is a bounded SRD 5.1 enemy profile; only its basic attack is executable.`,
    tags: ["srd-5.1", "enemy-basic-attack", "bounded", spec.crTag, ...(traitRefs.length > 0 ? ["enemy-trait"] : [])],
    mechanics: {
      tier, challengeRating: spec.cr, maxHp: spec.maxHp, defense: spec.defense, speed: spec.speed,
      abilityRefs: [spec.primaryAttack, ...traitRefs],
      resistances: [...(spec.resistances ?? [])],
      vulnerabilities: [...(spec.vulnerabilities ?? [])],
      immunities: [...(spec.immunities ?? [])],
      combatProfile: {
        kind: "dnd-5e-pinned-basic-attack-v1" as const,
        proficiencyBonus: 2,
        attack: { abilityRef: spec.primaryAttack, attackBonus: spec.attackBonus },
      },
    },
    private: {
      tactics: "Use the pinned basic attack against the deterministic legal target.",
      gmNotes: `${spec.name} is a bounded SRD 5.1 basic attack; other actions and traits are metadata only.`,
      hiddenAbilityRefs: [],
    },
  };
}

export interface MonsterBand {
  abilities: object[];
  enemies: object[];
}

export type MonsterBandBuilder = (refs: StarterReferences) => MonsterBand;
