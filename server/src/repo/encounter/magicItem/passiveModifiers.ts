import { isAttuned } from "./attunement.js";
import { stableKey } from "./internal.js";
import type {
  MagicAbilityId,
  MagicAttunementState,
  MagicCheckTarget,
  MagicDamageScope,
  MagicFlatTarget,
  MagicItemDefinition,
  MagicPassiveModifier,
} from "./types.js";

/**
 * Derives a passive-modifier plan from equipped/attuned items. The engine only
 * produces data; it never mutates actor, campaign, or effect state. Callers
 * decide whether to feed the plan into a derived-values consumer.
 */

export type MagicEquippedItem = Readonly<{
  key: string;
  definition: MagicItemDefinition;
  equipped: boolean;
}>;

export type MagicDerivedContribution = Readonly<{
  sourceItemKey: string;
  modifier: MagicPassiveModifier;
}>;

export type MagicDerivedValuesPlan = Readonly<{
  armorClass: number;
  savingThrows: Readonly<Record<MagicAbilityId, number>>;
  attackRoll: number;
  damageRoll: number;
  advantages: readonly MagicCheckTarget[];
  resistances: readonly MagicDamageScope[];
  vulnerabilities: readonly MagicDamageScope[];
  immunities: readonly MagicDamageScope[];
  contributions: readonly MagicDerivedContribution[];
}>;

export type PlanDerivedValuesInput = Readonly<{
  items: readonly MagicEquippedItem[];
  attunement: MagicAttunementState;
}>;

const ABILITY_IDS: readonly MagicAbilityId[] = Object.freeze([
  "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
]);

function flatAmount(modifier: MagicPassiveModifier): number | null {
  if (modifier.kind === "flat") return modifier.amount;
  if (modifier.kind === "proficiency") return modifier.bonus;
  return null;
}

function addToFlatTarget(target: MagicFlatTarget, amount: number, totals: {
  armorClass: number;
  savingThrows: Record<MagicAbilityId, number>;
  attackRoll: number;
  damageRoll: number;
}): void {
  if (target.kind === "armor-class") totals.armorClass += amount;
  else if (target.kind === "attack-roll") totals.attackRoll += amount;
  else if (target.kind === "damage-roll") totals.damageRoll += amount;
  else totals.savingThrows[target.ability] += amount;
}

function sortedUnique<T>(values: readonly T[]): readonly T[] {
  const seen = new Map<string, T>();
  for (const value of values) seen.set(stableKey(value), value);
  return Object.freeze([...seen.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, value]) => value));
}

/** True when an item's passive modifiers are active: equipped, and attuned when required. */
export function passiveModifierActive(item: MagicEquippedItem, entry: { requireAttunement: boolean }, attunement: MagicAttunementState): boolean {
  return item.equipped && (!entry.requireAttunement || isAttuned(attunement, item.key));
}

export function planDerivedValues(input: PlanDerivedValuesInput): MagicDerivedValuesPlan {
  const totals = { armorClass: 0, attackRoll: 0, damageRoll: 0,
    savingThrows: Object.fromEntries(ABILITY_IDS.map((id) => [id, 0])) as Record<MagicAbilityId, number> };
  const advantages: MagicCheckTarget[] = [];
  const resistances: MagicDamageScope[] = [];
  const vulnerabilities: MagicDamageScope[] = [];
  const immunities: MagicDamageScope[] = [];
  const contributions: MagicDerivedContribution[] = [];
  for (const item of input.items) {
    for (const entry of item.definition.passiveModifiers) {
      if (!passiveModifierActive(item, entry, input.attunement)) continue;
      const modifier = entry.modifier;
      contributions.push(Object.freeze({ sourceItemKey: item.key, modifier: Object.freeze({ ...modifier }) }));
      const flat = flatAmount(modifier);
      if (flat !== null && (modifier.kind === "flat" || modifier.kind === "proficiency")) addToFlatTarget(modifier.target, flat, totals);
      else if (modifier.kind === "advantage") advantages.push(Object.freeze({ ...modifier.target }));
      else if (modifier.kind === "resistance") resistances.push(modifier.damageType);
      else if (modifier.kind === "vulnerability") vulnerabilities.push(modifier.damageType);
      else if (modifier.kind === "immunity") immunities.push(modifier.damageType);
    }
  }
  return Object.freeze({
    armorClass: totals.armorClass,
    savingThrows: Object.freeze({ ...totals.savingThrows }),
    attackRoll: totals.attackRoll,
    damageRoll: totals.damageRoll,
    advantages: sortedUnique(advantages),
    resistances: sortedUnique(resistances),
    vulnerabilities: sortedUnique(vulnerabilities),
    immunities: sortedUnique(immunities),
    contributions: Object.freeze(contributions),
  });
}
