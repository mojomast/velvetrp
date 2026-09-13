import type { AbilityId } from "../types.js";
import { frozenList, requireInteger } from "./internal.js";

/**
 * Bounded SRD 5.1 multiclassing vocabulary. It is deliberately pure data and
 * pure functions: no database, clock, network, random source, or mutable state.
 * Every exported collection and result object is frozen.
 */

/** The seven classes this bounded SRD 5.1 pack models. */
export type Dnd5eMulticlassClassId =
  | "barbarian"
  | "cleric"
  | "fighter"
  | "paladin"
  | "ranger"
  | "rogue"
  | "wizard";

export const DND_5E_MULTICLASS_CLASS_IDS: readonly Dnd5eMulticlassClassId[] = frozenList([
  "barbarian",
  "cleric",
  "fighter",
  "paladin",
  "ranger",
  "rogue",
  "wizard",
]);

export interface Dnd5eMulticlassPrerequisite {
  /** "all" requires every listed minimum; "any" requires one of them. */
  readonly mode: "all" | "any";
  readonly minimums: Readonly<Partial<Record<AbilityId, number>>>;
}

const prerequisite = (mode: "all" | "any", minimums: Partial<Record<AbilityId, number>>): Dnd5eMulticlassPrerequisite =>
  Object.freeze({ mode, minimums: Object.freeze({ ...minimums }) });

/** SRD 5.1 multiclass ability-score prerequisites for every modeled class. */
export const DND_5E_MULTICLASS_PREREQUISITES: Readonly<Record<Dnd5eMulticlassClassId, Dnd5eMulticlassPrerequisite>> =
  Object.freeze({
    barbarian: prerequisite("all", { strength: 13 }),
    cleric: prerequisite("all", { wisdom: 13 }),
    fighter: prerequisite("any", { strength: 13, dexterity: 13 }),
    paladin: prerequisite("all", { strength: 13, charisma: 13 }),
    ranger: prerequisite("all", { dexterity: 13, wisdom: 13 }),
    rogue: prerequisite("all", { dexterity: 13 }),
    wizard: prerequisite("all", { intelligence: 13 }),
  });

/** True when the six SRD ability scores satisfy a class's multiclass minimums. */
export function qualifiesForMulticlass(
  classId: Dnd5eMulticlassClassId,
  scores: Readonly<Record<AbilityId, number>>,
): boolean {
  const entry = DND_5E_MULTICLASS_PREREQUISITES[classId];
  const checks = (Object.entries(entry.minimums) as Array<[AbilityId, number]>)
    .map(([ability, minimum]) => scores[ability] >= minimum);
  return entry.mode === "any" ? checks.some(Boolean) : checks.every(Boolean);
}

/** Closed proficiency categories granted when multiclassing into a class. */
export type Dnd5eMulticlassProficiency =
  | "light-armor"
  | "medium-armor"
  | "heavy-armor"
  | "shields"
  | "simple-weapons"
  | "martial-weapons";

/** SRD 5.1 proficiencies gained on multiclassing into each modeled class. */
export const DND_5E_MULTICLASS_PROFICIENCY_GRANTS: Readonly<Record<Dnd5eMulticlassClassId, readonly Dnd5eMulticlassProficiency[]>> =
  Object.freeze({
    barbarian: frozenList(["shields", "simple-weapons", "martial-weapons"] as const),
    cleric: frozenList(["light-armor", "medium-armor", "shields"] as const),
    fighter: frozenList(["light-armor", "medium-armor", "shields", "simple-weapons", "martial-weapons"] as const),
    paladin: frozenList(["light-armor", "medium-armor", "shields", "simple-weapons", "martial-weapons"] as const),
    ranger: frozenList(["light-armor", "medium-armor", "shields", "simple-weapons", "martial-weapons"] as const),
    rogue: frozenList(["light-armor"] as const),
    wizard: frozenList([] as const),
  });

/** Grants only proficiencies not already held, in stable SRD grant order. */
export function multiclassProficiencyGrants(
  classId: Dnd5eMulticlassClassId,
  current: readonly Dnd5eMulticlassProficiency[],
): readonly Dnd5eMulticlassProficiency[] {
  const already = new Set(current);
  return frozenList(DND_5E_MULTICLASS_PROFICIENCY_GRANTS[classId].filter((entry) => !already.has(entry)));
}

export type Dnd5eCasterWeight = "full" | "half" | "third" | "none";

/** Weighting used to combine caster levels for the multiclass slot table. */
export const DND_5E_MULTICLASS_CASTER_WEIGHTS: Readonly<Record<Dnd5eMulticlassClassId, Dnd5eCasterWeight>> =
  Object.freeze({
    barbarian: "none",
    cleric: "full",
    fighter: "none",
    paladin: "half",
    ranger: "half",
    rogue: "none",
    wizard: "full",
  });

const CASTER_WEIGHT_DIVISOR: Readonly<Record<Dnd5eCasterWeight, number>> = Object.freeze({
  full: 1,
  half: 2,
  third: 3,
  none: 0,
});

/** Contribution of one class level to the combined caster level (rounded down). */
export function casterLevelContribution(weight: Dnd5eCasterWeight, classLevel: number): number {
  requireInteger(classLevel, "class level");
  if (classLevel < 0 || classLevel > 20) throw new RangeError("class level must be between 0 and 20");
  const divisor = CASTER_WEIGHT_DIVISOR[weight];
  return divisor === 0 ? 0 : Math.floor(classLevel / divisor);
}

export interface Dnd5eMulticlassLevel {
  readonly classId: Dnd5eMulticlassClassId;
  readonly level: number;
}

/** Adds full, half (rounded down), and third (rounded down) caster levels. */
export function combinedMulticlassCasterLevel(levels: readonly Dnd5eMulticlassLevel[]): number {
  let total = 0;
  for (const entry of levels) {
    requireInteger(entry.level, "class level");
    if (entry.level < 1 || entry.level > 20) throw new RangeError("class level must be between 1 and 20");
    total += casterLevelContribution(DND_5E_MULTICLASS_CASTER_WEIGHTS[entry.classId], entry.level);
  }
  return Math.min(20, total);
}

/** Spell slots for spell levels 1-9; absent levels are zero and omitted. */
export type Dnd5eSpellSlots = Readonly<Record<number, number>>;

/** SRD 5.1 multiclass spell-slot table indexed by combined caster level 1-20. */
export const DND_5E_MULTICLASS_SPELL_SLOT_TABLE: readonly (readonly number[])[] = Object.freeze([
  Object.freeze([2, 0, 0, 0, 0, 0, 0, 0, 0]),
  Object.freeze([3, 0, 0, 0, 0, 0, 0, 0, 0]),
  Object.freeze([4, 2, 0, 0, 0, 0, 0, 0, 0]),
  Object.freeze([4, 3, 0, 0, 0, 0, 0, 0, 0]),
  Object.freeze([4, 3, 2, 0, 0, 0, 0, 0, 0]),
  Object.freeze([4, 3, 3, 0, 0, 0, 0, 0, 0]),
  Object.freeze([4, 3, 3, 1, 0, 0, 0, 0, 0]),
  Object.freeze([4, 3, 3, 2, 0, 0, 0, 0, 0]),
  Object.freeze([4, 3, 3, 3, 1, 0, 0, 0, 0]),
  Object.freeze([4, 3, 3, 3, 2, 0, 0, 0, 0]),
  Object.freeze([4, 3, 3, 3, 2, 1, 0, 0, 0]),
  Object.freeze([4, 3, 3, 3, 2, 1, 0, 0, 0]),
  Object.freeze([4, 3, 3, 3, 2, 1, 1, 0, 0]),
  Object.freeze([4, 3, 3, 3, 2, 1, 1, 0, 0]),
  Object.freeze([4, 3, 3, 3, 2, 1, 1, 1, 0]),
  Object.freeze([4, 3, 3, 3, 2, 1, 1, 1, 0]),
  Object.freeze([4, 3, 3, 3, 2, 1, 1, 1, 1]),
  Object.freeze([4, 3, 3, 3, 3, 1, 1, 1, 1]),
  Object.freeze([4, 3, 3, 3, 3, 2, 1, 1, 1]),
  Object.freeze([4, 3, 3, 3, 3, 2, 2, 1, 1]),
]);

/** Combined caster level 1-20 to frozen nonzero spell slots for levels 1-9. */
export function multiclassSpellSlots(combinedCasterLevel: number): Dnd5eSpellSlots {
  requireInteger(combinedCasterLevel, "combined caster level");
  if (combinedCasterLevel < 1 || combinedCasterLevel > 20) {
    throw new RangeError("combined caster level must be between 1 and 20");
  }
  const row = DND_5E_MULTICLASS_SPELL_SLOT_TABLE[combinedCasterLevel - 1]!;
  const slots: Record<number, number> = {};
  row.forEach((count, index) => {
    if (count > 0) slots[index + 1] = count;
  });
  return Object.freeze(slots);
}

/** Combined caster level for the supplied multiclass levels, then its slots. */
export function multiclassSpellSlotsFor(levels: readonly Dnd5eMulticlassLevel[]): Dnd5eSpellSlots {
  const combined = combinedMulticlassCasterLevel(levels);
  if (combined < 1) return Object.freeze({});
  return multiclassSpellSlots(combined);
}
