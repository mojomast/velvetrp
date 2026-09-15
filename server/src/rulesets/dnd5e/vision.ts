import type { RulesetCapability } from "../types.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";

/**
 * SRD 5.1 vision, light, and obscurement. Pure and deterministic: callers supply
 * the ambient light, the obscurement of the observer/target spaces, and any
 * special senses. The module returns the resulting visibility and the attack
 * roll consequences, never a database or random value.
 */

export const DND_5E_VISION_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "vision-light", version: "1.0.0", status: "supported" as const }),
]);

export type Dnd5eLightLevel = "bright-light" | "dim-light" | "darkness";
export type Dnd5eObscurement = "none" | "lightly-obscured" | "heavily-obscured";
export type Dnd5eSpecialSense = "darkvision" | "blindsight" | "truesight";

export type Dnd5eVisionInput = Readonly<{
  /** Ambient light in the space the observer is looking into. */
  light: Dnd5eLightLevel;
  /** Obscurement of the observed space (fog, foliage, smoke, etc.). */
  obscurement: Dnd5eObscurement;
  /** Special senses the observer has. */
  senses?: readonly Dnd5eSpecialSense[];
  /** Feet of darkvision, blindsight, or truesight range; absent means unlimited for that sense. */
  senseRangeFeet?: number;
  /** Distance from the observer to the observed space in feet. */
  distanceFeet: number;
}>;

export type Dnd5eVisibility = Readonly<{
  /** Whether the observer can see the target space at all. */
  visible: boolean;
  /** The effective obscurement after the observer's senses are applied. */
  effectiveObscurement: Dnd5eObscurement;
  /** True when the target is heavily obscured from the observer (unseen). */
  unseen: boolean;
  /** Attack rolls against the target have disadvantage (unseen target). */
  attackDisadvantageAgainst: boolean;
  /** The observer's own attack rolls have disadvantage (attacking while unseen). */
  attackDisadvantageWhileUnseen: boolean;
  /** The observer sees normally in what would otherwise be darkness. */
  seesInDarkness: boolean;
  reasons: readonly string[];
}>;

const SENSE_ORDER: readonly Dnd5eSpecialSense[] = Object.freeze(["darkvision", "blindsight", "truesight"]);

/** Heavily obscured spaces block sight; lightly obscured spaces impose Perception disadvantage. */
export function obscurementPenalty(obscurement: Dnd5eObscurement): Readonly<{ blocksSight: boolean; passivePerceptionPenalty: number }> {
  if (obscurement === "heavily-obscured") return Object.freeze({ blocksSight: true, passivePerceptionPenalty: 0 });
  if (obscurement === "lightly-obscured") return Object.freeze({ blocksSight: false, passivePerceptionPenalty: 5 });
  return Object.freeze({ blocksSight: false, passivePerceptionPenalty: 0 });
}

/**
 * Resolves whether an observer can see a space and the resulting attack-roll
 * effects. In darkness, a special sense within range reveals the space as if it
 * were bright light (darkvision) or negates obscurement entirely (blindsight,
 * truesight). Lightly obscured spaces do not block sight but impose the SRD
 * Perception penalty; heavily obscured spaces are unseen.
 */
export function resolveDnd5eVision(input: Dnd5eVisionInput): Dnd5eVisibility {
  requireNonNegativeInteger(input.distanceFeet, "vision distance");
  if (input.senseRangeFeet !== undefined) requireNonNegativeInteger(input.senseRangeFeet, "sense range");
  const senses = input.senses ?? [];
  const inRange = (sense: Dnd5eSpecialSense): boolean => senses.includes(sense)
    && (input.senseRangeFeet === undefined || input.distanceFeet <= input.senseRangeFeet);
  const truesight = inRange("truesight");
  const blindsight = inRange("blindsight");
  const darkvision = inRange("darkvision");
  const reasons: string[] = [];

  // Blindsight and truesight perceive through darkness and obscurement.
  const seesThroughObscurement = truesight || blindsight;
  const effectiveObscurement: Dnd5eObscurement = seesThroughObscurement ? "none" : input.obscurement;
  const darknessRevealed = input.light === "darkness" && (truesight || blindsight || darkvision);
  const dimRevealed = input.light === "dim-light" && (truesight || blindsight);
  if (darknessRevealed) reasons.push(`${truesight ? "truesight" : blindsight ? "blindsight" : "darkvision"} reveals the space in darkness`);
  if (seesThroughObscurement) reasons.push(`${truesight ? "truesight" : "blindsight"} negates obscurement`);

  const blockedByLight = input.light === "darkness" && !darknessRevealed;
  const blockedByObscurement = obscurementPenalty(effectiveObscurement).blocksSight;
  const visible = !blockedByLight && !blockedByObscurement;
  const unseen = !visible;
  if (blockedByLight) reasons.push("darkness blocks sight without a special sense");
  if (blockedByObscurement) reasons.push(`${effectiveObscurement} blocks sight`);

  return Object.freeze({
    visible,
    effectiveObscurement,
    unseen,
    attackDisadvantageAgainst: unseen,
    attackDisadvantageWhileUnseen: unseen,
    seesInDarkness: darknessRevealed || dimRevealed,
    reasons: frozenList(reasons),
  });
}

export type Dnd5eLightSource = Readonly<{
  id: string;
  /** Bright-light radius in feet. */
  brightFeet: number;
  /** Additional dim-light radius beyond the bright radius, in feet. */
  dimFeet: number;
}>;

/** The light level at a distance from one or more light sources, brightest wins. */
export function lightLevelAt(input: Readonly<{ sources: readonly Dnd5eLightSource[]; distanceFeet: number }>): Dnd5eLightLevel {
  requireNonNegativeInteger(input.distanceFeet, "light distance");
  let level: Dnd5eLightLevel = "darkness";
  for (const source of input.sources) {
    requireNonNegativeInteger(source.brightFeet, "bright radius");
    requireNonNegativeInteger(source.dimFeet, "dim radius");
    if (input.distanceFeet <= source.brightFeet) return "bright-light";
    if (input.distanceFeet <= source.brightFeet + source.dimFeet) level = "dim-light";
  }
  return level;
}

/** Passive Wisdom (Perception) adjustment for an obscurement level. */
export function passivePerceptionObscurementAdjustment(obscurement: Dnd5eObscurement): number {
  return -obscurementPenalty(obscurement).passivePerceptionPenalty;
}

/** Validates a special sense range, returning a frozen bounded descriptor. */
export function dnd5eSpecialSense(sense: Dnd5eSpecialSense, rangeFeet?: number): Readonly<{ sense: Dnd5eSpecialSense; rangeFeet: number | null }> {
  if (!SENSE_ORDER.includes(sense)) throw new Error(`unknown special sense: ${sense}`);
  if (rangeFeet !== undefined) { requireInteger(rangeFeet, "sense range"); requireNonNegativeInteger(rangeFeet, "sense range"); }
  return Object.freeze({ sense, rangeFeet: rangeFeet ?? null });
}
