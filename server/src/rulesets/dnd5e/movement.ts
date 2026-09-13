import type {
  DamageRollResolution, EncumbranceInput, EncumbrancePlan, InitiativeEntry, InitiativeResult, MovementInput, MovementPlan, RulesetCapability,
} from "../types.js";
import { resolveDnd5eDamageRoll } from "./damage.js";
import { dnd5eAbilityModifier } from "./d20.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";

export const DND_5E_MOVEMENT_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "initiative", version: "1.0.0", status: "supported" as const }),
  Object.freeze({ id: "movement", version: "1.5.0", status: "partial" as const }),
]);

export function resolveDnd5eInitiative(entries: readonly InitiativeEntry[]): readonly InitiativeResult[] {
  const seen = new Set<string>();
  const results = entries.map((entry) => {
    if (!entry.id || seen.has(entry.id)) throw new Error(`initiative ID must be unique and non-empty: ${entry.id}`);
    seen.add(entry.id);
    requireInteger(entry.roll, "initiative roll");
    if (entry.roll < 1 || entry.roll > 20) throw new RangeError("initiative roll must be between 1 and 20");
    const dexterityModifier = dnd5eAbilityModifier(entry.dexterityScore);
    const bonus = entry.bonus ?? 0;
    requireInteger(bonus, "initiative bonus");
    return Object.freeze({ id: entry.id, roll: entry.roll, dexterityModifier, bonus, total: entry.roll + dexterityModifier + bonus });
  });
  results.sort((a, b) => b.total - a.total || b.dexterityModifier - a.dexterityModifier || a.id.localeCompare(b.id));
  return frozenList(results);
}

/**
 * SRD 5.1 carrying capacity. Encumbered (weight above 5 x Strength) reduces
 * speed by 10; heavily encumbered (above 10 x Strength) reduces speed by 20 and
 * imposes disadvantage on ability checks, saving throws, and attacks. Capacity
 * is 15 x Strength.
 */
export function planDnd5eEncumbrance(input: EncumbranceInput): EncumbrancePlan {
  requireNonNegativeInteger(input.carriedWeight, "carried weight");
  requireInteger(input.strengthScore, "strength score");
  if (input.strengthScore < 1 || input.strengthScore > 30) throw new RangeError("strength score must be between 1 and 30");
  const heavily = input.carriedWeight > input.strengthScore * 10;
  const encumbered = input.carriedWeight > input.strengthScore * 5;
  return Object.freeze({
    tier: heavily ? "heavily-encumbered" : encumbered ? "encumbered" : "unencumbered",
    carryingCapacity: input.strengthScore * 15,
    speedReduction: heavily ? 20 : encumbered ? 10 : 0,
    checkPenaltyDisadvantage: heavily,
  });
}

export function planDnd5eMovement(input: MovementInput): MovementPlan {
  requireNonNegativeInteger(input.distance, "distance");
  requireNonNegativeInteger(input.speed, "speed");
  const mode = input.mode ?? "walk";
  const specialSpeed = input.specialSpeed;
  if (specialSpeed !== undefined) requireNonNegativeInteger(specialSpeed, "special speed");
  const extraCost = input.difficultTerrain ? 1 : 0;
  const modeCost = mode === "walk" || specialSpeed !== undefined ? 1 : 2;
  const cost = input.distance * (modeCost + extraCost);
  const budget = (specialSpeed ?? input.speed) * (input.dash ? 2 : 1);
  const reasons = cost > budget ? ["movement cost exceeds available speed"] : [];
  return Object.freeze({ distance: input.distance, cost, budget, remaining: Math.max(0, budget - cost), legal: reasons.length === 0, reasons: frozenList(reasons) });
}

/**
 * SRD 5.1 jump input. A creature that moves at least 10 feet immediately
 * before a jump gains the full distance; without that run-up the distance is
 * halved. Each foot cleared or climbed costs a foot of movement.
 */
export type JumpInput = Readonly<{
  strengthScore: number;
  /** Feet moved immediately before the jump. At least 10 grants the full jump. */
  runUpFeet?: number;
  /** Available movement budget in feet for the jump. */
  speed: number;
}>;

export type JumpPlan = Readonly<{
  kind: "long" | "high";
  runUp: boolean;
  distanceFeet: number;
  cost: number;
  budget: number;
  remaining: number;
  legal: boolean;
  reasons: readonly string[];
}>;

function planDnd5eJump(kind: "long" | "high", input: JumpInput, jumpFeet: number): JumpPlan {
  requireInteger(input.strengthScore, "strength score");
  if (input.strengthScore < 1 || input.strengthScore > 30) throw new RangeError("strength score must be between 1 and 30");
  const runUpFeet = input.runUpFeet ?? 0;
  requireNonNegativeInteger(runUpFeet, "run-up distance");
  requireNonNegativeInteger(input.speed, "speed");
  const runUp = runUpFeet >= 10;
  const distanceFeet = Math.max(0, runUp ? jumpFeet : Math.floor(jumpFeet / 2));
  const cost = distanceFeet;
  const budget = input.speed;
  const reasons = cost > budget ? ["jump distance exceeds available movement"] : [];
  return Object.freeze({ kind, runUp, distanceFeet, cost, budget, remaining: Math.max(0, budget - cost), legal: reasons.length === 0, reasons: frozenList(reasons) });
}

/** SRD 5.1 long jump: Strength score feet with a 10-foot run-up, half otherwise. */
export function planDnd5eLongJump(input: JumpInput): JumpPlan {
  return planDnd5eJump("long", input, input.strengthScore);
}

/** SRD 5.1 high jump: 3 + Strength modifier feet with a 10-foot run-up, half (rounded down) otherwise. */
export function planDnd5eHighJump(input: JumpInput): JumpPlan {
  return planDnd5eJump("high", input, 3 + dnd5eAbilityModifier(input.strengthScore));
}

/**
 * SRD 5.1 falling input. Falling deals 1d6 bludgeoning damage per 10 feet
 * fallen, to a maximum of 20d6, and the creature lands prone unless the fall
 * is avoided. Rolled d6 values are supplied explicitly so the resolution stays
 * deterministic and reuses the shared damage-roll dice contract.
 */
export type FallingInput = Readonly<{
  distanceFeet: number;
  /** Rolled d6 values, one per 10 feet fallen (capped at 20 dice). */
  rolls?: readonly number[];
  /** True when the fall is avoided, preventing the prone landing. */
  avoided?: boolean;
}>;

export type FallingResolution = Readonly<{
  distanceFeet: number;
  dice: number;
  damage: number;
  landProne: boolean;
  avoided: boolean;
  /** Shared damage-roll evidence, or null when the fall deals no dice. */
  evidence: DamageRollResolution | null;
}>;

export function resolveDnd5eFalling(input: FallingInput): FallingResolution {
  requireNonNegativeInteger(input.distanceFeet, "fall distance");
  const dice = Math.min(20, Math.floor(input.distanceFeet / 10));
  const rolls = input.rolls ?? [];
  if (rolls.length !== dice) throw new RangeError(`falling requires exactly ${dice} d6 roll${dice === 1 ? "" : "s"}`);
  const evidence = dice > 0 ? resolveDnd5eDamageRoll({ dice: [{ count: dice, sides: 6 }], rolls: [rolls] }) : null;
  const avoided = input.avoided ?? false;
  return Object.freeze({
    distanceFeet: input.distanceFeet,
    dice,
    damage: evidence?.total ?? 0,
    landProne: !avoided && input.distanceFeet > 0,
    avoided,
    evidence,
  });
}

const DND_5E_SPECIAL_MOVEMENT_MODES: readonly string[] = Object.freeze(["climb", "swim", "crawl", "squeeze", "fly"]);

export type SpecialMovementMode = "climb" | "swim" | "crawl" | "squeeze" | "fly";

export type SpecialMovementInput = Readonly<{
  mode: SpecialMovementMode;
  distance: number;
  speed: number;
  difficultTerrain?: boolean;
  /** Fly speed, when it differs from the walking speed. */
  flySpeed?: number;
  /** True when the creature can hover; metadata used only by fly mode. */
  hovering?: boolean;
}>;

export type SpecialMovementPlan = Readonly<{
  mode: SpecialMovementMode;
  distance: number;
  costPerFoot: number;
  cost: number;
  budget: number;
  remaining: number;
  legal: boolean;
  reasons: readonly string[];
  /** Squeezing imposes disadvantage on attack rolls and Dexterity saving throws. */
  attackDisadvantage: boolean;
  dexteritySaveDisadvantage: boolean;
  /** Fly mode only: whether the creature can hover in place. */
  hovering: boolean;
}>;

/**
 * SRD 5.1 climbing, swimming, crawling, squeezing, and flying. Climbing,
 * swimming, and crawling cost 1 extra foot per foot (2 feet per foot) and
 * difficult terrain doubles that; squeezing also costs 2 feet per foot and
 * imposes disadvantage on attack rolls and Dexterity saves. A fly speed is
 * spent like any other speed and hovering is metadata.
 */
export function planDnd5eSpecialMovement(input: SpecialMovementInput): SpecialMovementPlan {
  if (!DND_5E_SPECIAL_MOVEMENT_MODES.includes(input.mode)) throw new Error(`unknown special movement mode: ${input.mode}`);
  requireNonNegativeInteger(input.distance, "distance");
  requireNonNegativeInteger(input.speed, "speed");
  if (input.flySpeed !== undefined) requireNonNegativeInteger(input.flySpeed, "fly speed");
  const squeezes = input.mode === "squeeze";
  const doublesTerrain = input.mode === "climb" || input.mode === "swim" || input.mode === "crawl";
  const baseCostPerFoot = input.mode === "fly" ? 1 : 2;
  const costPerFoot = doublesTerrain && input.difficultTerrain ? baseCostPerFoot * 2 : baseCostPerFoot;
  const cost = input.distance * costPerFoot;
  const budget = input.mode === "fly" ? input.flySpeed ?? input.speed : input.speed;
  const reasons = cost > budget ? ["movement cost exceeds available speed"] : [];
  return Object.freeze({
    mode: input.mode,
    distance: input.distance,
    costPerFoot,
    cost,
    budget,
    remaining: Math.max(0, budget - cost),
    legal: reasons.length === 0,
    reasons: frozenList(reasons),
    attackDisadvantage: squeezes,
    dexteritySaveDisadvantage: squeezes,
    hovering: input.mode === "fly" && (input.hovering ?? false),
  });
}
