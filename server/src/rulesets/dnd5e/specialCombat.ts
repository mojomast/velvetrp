import type { RulesetCapability } from "../types.js";
import { dnd5eAbilityModifier } from "./d20.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";

/**
 * SRD 5.1 mounted and underwater combat. Pure and deterministic: callers supply
 * size, training, swimming speed, and forced-movement evidence, and the module
 * returns bounded plans and attack-roll consequences. No dice are generated.
 */

export const DND_5E_SPECIAL_COMBAT_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "mounted-combat", version: "1.0.0", status: "supported" as const }),
  Object.freeze({ id: "underwater-combat", version: "1.0.0", status: "supported" as const }),
]);

export type Dnd5eCreatureSize = "tiny" | "small" | "medium" | "large" | "huge" | "gargantuan";

const SIZE_RANK: Readonly<Record<Dnd5eCreatureSize, number>> = Object.freeze({
  tiny: 0, small: 1, medium: 2, large: 3, huge: 4, gargantuan: 5,
});

/** SRD 5.1: a mount must be willing, at least one size larger, and anatomically suitable. */
export type Dnd5eMountInput = Readonly<{
  riderSize: Dnd5eCreatureSize;
  mountSize: Dnd5eCreatureSize;
  /** The mount is willing to bear a rider. */
  willing: boolean;
  /** The mount has been trained to accept a rider (controls it while mounted). */
  trained: boolean;
  /** The mount has the anatomy to serve as a mount. */
  suitableAnatomy: boolean;
  /** Movement budget available for the mount/dismount. */
  speed: number;
}>;

export type Dnd5eMountPlan = Readonly<{
  legal: boolean;
  /** Half the speed is spent to mount or dismount. */
  costFeet: number;
  /** True when the rider controls the mount; false for an independent mount. */
  controlled: boolean;
  reasons: readonly string[];
}>;

/**
 * Plans mounting or dismounting. Mounting costs half your speed; a trained mount
 * is controlled by the rider, an untrained one acts independently.
 */
export function planDnd5eMount(input: Dnd5eMountInput): Dnd5eMountPlan {
  requireNonNegativeInteger(input.speed, "speed");
  const reasons: string[] = [];
  if (!input.willing) reasons.push("a mount must be willing");
  if (SIZE_RANK[input.mountSize] <= SIZE_RANK[input.riderSize]) reasons.push("a mount must be at least one size larger than the rider");
  if (!input.suitableAnatomy) reasons.push("the mount lacks suitable anatomy");
  const costFeet = Math.floor(input.speed / 2);
  return Object.freeze({
    legal: reasons.length === 0,
    costFeet,
    controlled: input.trained,
    reasons: frozenList(reasons),
  });
}

/**
 * SRD 5.1: while mounted, you have advantage on melee attack rolls against any
 * unmounted creature smaller than your mount.
 */
export function mountedMeleeAdvantage(input: Readonly<{
  attackerMounted: boolean;
  targetMounted: boolean;
  targetSize: Dnd5eCreatureSize;
  mountSize: Dnd5eCreatureSize;
}>): boolean {
  return input.attackerMounted && !input.targetMounted
    && SIZE_RANK[input.targetSize] < SIZE_RANK[input.mountSize];
}

export type Dnd5eMountSaveResolution = Readonly<{
  dc: number;
  roll: number;
  total: number;
  success: boolean;
  /** On failure the rider falls off, lands prone, and takes the fall. */
  dismounted: boolean;
  landedProne: boolean;
}>;

/**
 * SRD 5.1: if an effect moves your mount against its will while you are on it,
 * succeed on a DC 10 Dexterity saving throw or fall off, landing prone within 5
 * feet of the mount. The saving throw roll is caller-supplied.
 */
export function resolveDnd5eMountForcedMovement(input: Readonly<{
  dexterityScore: number;
  /** The forced-movement saving throw d20 face. */
  roll: number;
}>): Dnd5eMountSaveResolution {
  requireInteger(input.roll, "mount save roll");
  if (input.roll < 1 || input.roll > 20) throw new RangeError("mount save roll must be between 1 and 20");
  const dc = 10;
  const total = input.roll + dnd5eAbilityModifier(input.dexterityScore);
  const success = total >= dc;
  return Object.freeze({ dc, roll: input.roll, total, success, dismounted: !success, landedProne: !success });
}

export type Dnd5eMountKnockdownResolution = Readonly<{
  /** True when the rider used its reaction to dismount as the mount fell. */
  usedReaction: boolean;
  /** The rider lands on its feet when it spent the reaction, otherwise prone. */
  mounted: boolean;
  landedProne: boolean;
}>;

/**
 * SRD 5.1: if your mount is knocked prone, you can use your reaction to dismount
 * it as it falls and land on your feet. Otherwise you are dismounted and fall
 * prone within 5 feet of it.
 */
export function resolveDnd5eMountKnockdown(input: Readonly<{ reactionAvailable: boolean }>): Dnd5eMountKnockdownResolution {
  return Object.freeze({
    usedReaction: input.reactionAvailable,
    mounted: false,
    landedProne: !input.reactionAvailable,
  });
}

/** SRD 5.1 underwater melee weapons that ignore the no-swim-speed penalty. */
export const DND_5E_UNDERWATER_MELEE_EXCEPTIONS: readonly string[] = Object.freeze([
  "dagger", "javelin", "shortsword", "spear", "trident",
]);

/** SRD 5.1 underwater ranged weapons/thrown weapons that ignore the penalty. */
export const DND_5E_UNDERWATER_RANGED_EXCEPTIONS: readonly string[] = Object.freeze([
  "crossbow", "net", "javelin", "spear", "trident", "dart",
]);

export type Dnd5eUnderwaterAttackInput = Readonly<{
  kind: "melee" | "ranged" | "thrown";
  /** The attacker has a natural or magically granted swimming speed. */
  hasSwimSpeed: boolean;
  /** The weapon's normalized category key, e.g. "dagger" or "crossbow". */
  weapon: string;
  /** True when a ranged/thrown target is beyond the weapon's normal range. */
  beyondNormalRange?: boolean;
}>;

export type Dnd5eUnderwaterAttackPlan = Readonly<{
  /** The attack roll has disadvantage. */
  disadvantage: boolean;
  /** A ranged attack beyond normal range automatically misses. */
  automaticMiss: boolean;
  reasons: readonly string[];
}>;

/**
 * SRD 5.1 underwater combat: a creature without a swimming speed has
 * disadvantage on melee attacks unless the weapon is a dagger, javelin,
 * shortsword, spear, or trident. A ranged attack automatically misses beyond
 * normal range and otherwise has disadvantage unless the weapon is a crossbow,
 * a net, or a thrown weapon such as a javelin, spear, trident, or dart.
 */
export function planDnd5eUnderwaterAttack(input: Dnd5eUnderwaterAttackInput): Dnd5eUnderwaterAttackPlan {
  const reasons: string[] = [];
  if (input.hasSwimSpeed) return Object.freeze({ disadvantage: false, automaticMiss: false, reasons: frozenList(reasons) });
  if (input.kind === "melee") {
    const exempt = DND_5E_UNDERWATER_MELEE_EXCEPTIONS.includes(input.weapon);
    if (!exempt) reasons.push("melee attack without a swim speed has disadvantage unless the weapon is a dagger, javelin, shortsword, spear, or trident");
    return Object.freeze({ disadvantage: !exempt, automaticMiss: false, reasons: frozenList(reasons) });
  }
  if (input.beyondNormalRange) {
    reasons.push("a ranged attack beyond normal range automatically misses underwater");
    return Object.freeze({ disadvantage: false, automaticMiss: true, reasons: frozenList(reasons) });
  }
  const exempt = DND_5E_UNDERWATER_RANGED_EXCEPTIONS.includes(input.weapon);
  if (!exempt) reasons.push("ranged attack without a swim speed has disadvantage unless the weapon is a crossbow, a net, or a thrown weapon");
  return Object.freeze({ disadvantage: !exempt, automaticMiss: false, reasons: frozenList(reasons) });
}

/**
 * SRD 5.1: creatures and objects fully immersed in water have resistance to
 * fire damage.
 */
export function dnd5eUnderwaterDamageAdjustment(damageType: string, fullyImmersed: boolean): "resistance" | "none" {
  return fullyImmersed && damageType === "fire" ? "resistance" : "none";
}
