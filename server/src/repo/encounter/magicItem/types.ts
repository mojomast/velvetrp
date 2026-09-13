/**
 * Engine-local magic-item vocabulary.
 *
 * The published item contract (`itemCatalogDefinitionSchema`) is frozen for
 * this batch and cannot express attunement, charges, passive modifiers, or
 * granted powers. These input types deliberately mirror the shape future
 * pinned content will need without editing `@velvet/contracts`.
 */

export const MAGIC_ITEM_ATTUNEMENT_LIMIT = 3 as const;

export type MagicAbilityId =
  | "strength"
  | "dexterity"
  | "constitution"
  | "intelligence"
  | "wisdom"
  | "charisma";

export type MagicDamageType =
  | "acid"
  | "bludgeoning"
  | "cold"
  | "fire"
  | "force"
  | "lightning"
  | "necrotic"
  | "piercing"
  | "poison"
  | "psychic"
  | "radiant"
  | "slashing"
  | "thunder";

/** A completed rest kind supplied as input state; long rests subsume short. */
export type MagicRestKind = "short-rest" | "long-rest";

export type MagicItemReference = Readonly<{
  packId: string;
  packVersion: string;
  definitionId: string;
}>;

export type MagicPowerReference = Readonly<{
  kind: "ability" | "spell";
  packId: string;
  packVersion: string;
  definitionId: string;
}>;

/** Present only when the item requires attunement; carries its prerequisite. */
export type MagicItemAttunement = Readonly<{ prerequisite: MagicRestKind }> | null;

export type MagicChargeEvent = "dawn" | MagicRestKind;

export type MagicChargeRecharge =
  | Readonly<{ kind: "event"; event: MagicChargeEvent; amount: number }>
  | Readonly<{ kind: "roll"; dieSides: number; minimum: number; amount: number }>
  | Readonly<{ kind: "none" }>;

export type MagicItemCharges = Readonly<{ maximum: number; recharge: MagicChargeRecharge }>;

export type MagicFlatTarget = Readonly<
  | { kind: "armor-class" }
  | { kind: "saving-throw"; ability: MagicAbilityId }
  | { kind: "attack-roll" }
  | { kind: "damage-roll" }
>;

export type MagicCheckTarget = Readonly<
  | { kind: "saving-throw"; ability: MagicAbilityId }
  | { kind: "attack-roll" }
>;

export type MagicDamageScope = MagicDamageType | "all";

export type MagicPassiveModifier = Readonly<
  | { kind: "flat"; amount: number; target: MagicFlatTarget }
  | { kind: "proficiency"; bonus: number; target: MagicFlatTarget }
  | { kind: "advantage"; target: MagicCheckTarget }
  | { kind: "resistance"; damageType: MagicDamageScope }
  | { kind: "vulnerability"; damageType: MagicDamageScope }
  | { kind: "immunity"; damageType: MagicDamageScope }
>;

export type MagicItemPassiveModifier = Readonly<{
  modifier: MagicPassiveModifier;
  requireAttunement: boolean;
}>;

export type MagicGrantedPower = Readonly<{
  /** Stable identity inside the owning definition; unique per item. */
  key: string;
  power: MagicPowerReference;
  requireAttunement: boolean;
  actionCost: "action" | "bonus-action" | "reaction";
  /** Charges consumed by this granted power; zero means at will. */
  cost: number;
}>;

export type MagicItemDefinition = Readonly<{
  reference: MagicItemReference;
  name: string;
  attunement: MagicItemAttunement;
  charges: MagicItemCharges | null;
  passiveModifiers: readonly MagicItemPassiveModifier[];
  grantedPowers: readonly MagicGrantedPower[];
}>;

export type MagicAttunementEntry = Readonly<{
  key: string;
  definition: MagicItemReference;
  attunedAt: string;
}>;

/** A serializable attunement set; never mutated in place by the engine. */
export type MagicAttunementState = Readonly<{
  actorId: string;
  entries: readonly MagicAttunementEntry[];
}>;

export type MagicChargeState = Readonly<{
  itemKey: string;
  current: number;
  maximum: number;
}>;

/** The bounded rest/dawn state an attunement prerequisite reads from. */
export type MagicAttunementPrerequisiteState = Readonly<{
  satisfiedRest: MagicRestKind | null;
}>;

/** Narrow injected dice seam; mirrors the monster engine's RNG contract. */
export type MagicItemDice = Readonly<{
  integer(minInclusive: number, maxExclusive: number): number;
}>;
