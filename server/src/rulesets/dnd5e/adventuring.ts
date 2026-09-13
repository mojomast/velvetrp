import type { AbilityId, DamageRollResolution, DiceTerm } from "../types.js";
import { resolveDnd5eDamageRoll } from "./damage.js";
import { dnd5eAbilityModifier, resolveDnd5eCheck } from "./d20.js";
import { frozenList, requireNonNegativeInteger } from "./internal.js";
import { resolveDnd5eFalling, type FallingInput, type FallingResolution } from "./movement.js";

/**
 * SRD 5.1 adventuring environment, hazards, and downtime. Every resolver is
 * pure and deterministic: dice outcomes are supplied explicitly and never
 * generated here. Falling is intentionally delegated to the movement module so
 * the shared damage-roll contract is reused rather than duplicated.
 */

/* ------------------------------------------------------------------ */
/* Travel pace                                                         */
/* ------------------------------------------------------------------ */

export type Dnd5eTravelPace = "fast" | "normal" | "slow";

export type Dnd5eTravelPaceProfile = Readonly<{
  pace: Dnd5eTravelPace;
  feetPerMinute: number;
  milesPerHour: number;
  milesPerDay: number;
  /** Positive number subtracted from passive Wisdom (Perception). */
  passivePerceptionPenalty: number;
  canStealth: boolean;
}>;

/** A normal day of travel assumes eight hours of movement. */
export const DND_5E_TRAVEL_HOURS_PER_DAY = 8;

/**
 * SRD 5.1 travel pace table. Fast travel is less perceptive and cannot be made
 * stealthily; only a slow pace allows Stealth.
 */
export const DND_5E_TRAVEL_PACES: Readonly<Record<Dnd5eTravelPace, Dnd5eTravelPaceProfile>> = Object.freeze({
  fast: Object.freeze({ pace: "fast", feetPerMinute: 400, milesPerHour: 4, milesPerDay: 30, passivePerceptionPenalty: 5, canStealth: false }),
  normal: Object.freeze({ pace: "normal", feetPerMinute: 300, milesPerHour: 3, milesPerDay: 24, passivePerceptionPenalty: 0, canStealth: false }),
  slow: Object.freeze({ pace: "slow", feetPerMinute: 200, milesPerHour: 2, milesPerDay: 18, passivePerceptionPenalty: 0, canStealth: true }),
});

export type Dnd5eTravelPlan = Readonly<{
  pace: Dnd5eTravelPace;
  hours: number;
  miles: number;
  milesPerHour: number;
  milesPerDay: number;
  feetPerMinute: number;
  passivePerceptionPenalty: number;
  /** Signed adjustment applied to a passive Perception score. */
  passivePerceptionAdjustment: number;
  canStealth: boolean;
}>;

export function planDnd5eTravel(input: Readonly<{ pace: Dnd5eTravelPace; hours?: number }>): Dnd5eTravelPlan {
  const profile = DND_5E_TRAVEL_PACES[input.pace];
  if (!profile) throw new Error(`unknown travel pace: ${input.pace}`);
  const hours = input.hours ?? DND_5E_TRAVEL_HOURS_PER_DAY;
  requireNonNegativeInteger(hours, "travel hours");
  return Object.freeze({
    pace: profile.pace,
    hours,
    miles: profile.milesPerHour * hours,
    milesPerHour: profile.milesPerHour,
    milesPerDay: profile.milesPerDay,
    feetPerMinute: profile.feetPerMinute,
    passivePerceptionPenalty: profile.passivePerceptionPenalty,
    passivePerceptionAdjustment: profile.passivePerceptionPenalty > 0 ? -profile.passivePerceptionPenalty : 0,
    canStealth: profile.canStealth,
  });
}

export type Dnd5eForcedMarchSave = Readonly<{ hour: number; dc: number; d20: number; total: number; success: boolean }>;

export type Dnd5eForcedMarchResolution = Readonly<{
  hours: number;
  forcedHours: number;
  exhaustionLevels: number;
  saves: readonly Dnd5eForcedMarchSave[];
}>;

/**
 * SRD 5.1 forced march. For each hour of travel beyond the eighth, a creature
 * makes a Constitution saving throw at the end of the hour; the DC is 10 + 1
 * for each hour past 8. Each failure adds one level of exhaustion.
 */
export function resolveDnd5eForcedMarch(input: Readonly<{
  hours: number;
  constitutionScore: number;
  proficiencyBonus?: number;
  /** One d20 roll per hour beyond the eighth. */
  saveRolls?: readonly number[];
}>): Dnd5eForcedMarchResolution {
  requireNonNegativeInteger(input.hours, "travel hours");
  const forcedHours = Math.max(0, input.hours - DND_5E_TRAVEL_HOURS_PER_DAY);
  const rolls = input.saveRolls ?? [];
  if (rolls.length !== forcedHours) throw new RangeError(`forced march requires exactly ${forcedHours} Constitution save roll${forcedHours === 1 ? "" : "s"}`);
  const proficiencyBonus = input.proficiencyBonus ?? 0;
  requireNonNegativeInteger(proficiencyBonus, "proficiency bonus");
  const saves = rolls.map((d20, index) => {
    const hour = DND_5E_TRAVEL_HOURS_PER_DAY + index + 1;
    const dc = 10 + (hour - DND_5E_TRAVEL_HOURS_PER_DAY);
    const resolution = resolveDnd5eCheck({ d20, abilityScore: input.constitutionScore, proficiencyBonus, dc });
    return Object.freeze({ hour, dc, d20, total: resolution.total, success: resolution.success });
  });
  return Object.freeze({ hours: input.hours, forcedHours, exhaustionLevels: saves.filter((save) => !save.success).length, saves: frozenList(saves) });
}

/* ------------------------------------------------------------------ */
/* Suffocation                                                         */
/* ------------------------------------------------------------------ */

export type Dnd5eSuffocationPlan = Readonly<{
  constitutionModifier: number;
  /** 1 + Constitution modifier minutes, minimum 30 seconds. */
  holdBreathSeconds: number;
  holdBreathRounds: number;
  /** Constitution modifier rounds, minimum one round. */
  surviveRounds: number;
  /** Round on which the creature drops to 0 hit points. */
  dropsToZeroOnRound: number;
}>;

/**
 * SRD 5.1 suffocation. A creature holds its breath for 1 + Constitution
 * modifier minutes (minimum 30 seconds), then survives for a number of rounds
 * equal to its Constitution modifier (minimum one), then drops to 0 hit points
 * at the start of its next turn.
 */
export function planDnd5eSuffocation(input: Readonly<{ constitutionScore: number }>): Dnd5eSuffocationPlan {
  const constitutionModifier = dnd5eAbilityModifier(input.constitutionScore);
  const holdBreathSeconds = Math.max(30, 60 * (1 + constitutionModifier));
  const holdBreathRounds = Math.ceil(holdBreathSeconds / 6);
  const surviveRounds = Math.max(1, constitutionModifier);
  return Object.freeze({
    constitutionModifier,
    holdBreathSeconds,
    holdBreathRounds,
    surviveRounds,
    dropsToZeroOnRound: holdBreathRounds + surviveRounds + 1,
  });
}

/* ------------------------------------------------------------------ */
/* Falling (delegated)                                                 */
/* ------------------------------------------------------------------ */

/** Delegates to the shared movement falling resolver; never re-implements it. */
export function resolveDnd5eAdventuringFall(input: FallingInput): FallingResolution {
  return resolveDnd5eFalling(input);
}

/* ------------------------------------------------------------------ */
/* Food and water                                                      */
/* ------------------------------------------------------------------ */

export const DND_5E_DEPRIVATION = Object.freeze({
  foodPoundsPerDay: 1,
  starvationGraceDaysBase: 3,
  waterGallonsPerDay: 1,
  waterGallonsPerDayHot: 2,
  dehydrationSaveDc: 15,
  exhaustionDeathLevel: 6,
});

export type Dnd5eFoodAndWaterInput = Readonly<{
  constitutionScore: number;
  /** Complete days without food, including the day being resolved. */
  daysWithoutFood?: number;
  /** Gallons of water consumed during the day. */
  waterGallons?: number;
  hotWeather?: boolean;
  /** d20 for the half-ration Constitution save, when applicable. */
  waterSaveRoll?: number;
  proficiencyBonus?: number;
  existingExhaustion?: number;
}>;

export type Dnd5eFoodAndWaterResolution = Readonly<{
  starvationGraceDays: number;
  foodExhaustion: number;
  waterGallonsRequired: number;
  waterRations: "full" | "half" | "none";
  waterSave: Readonly<{ dc: number; d20: number; total: number; success: boolean }> | null;
  waterExhaustion: number;
  exhaustionGained: number;
  existingExhaustion: number;
  resultingExhaustion: number;
  dead: boolean;
}>;

function requireNonNegativeNumber(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number`);
}

/**
 * SRD 5.1 food and water. A creature can go 3 + Constitution modifier days
 * (minimum one) without food, then gains one exhaustion level per further day.
 * It needs one gallon of water per day (two in hot weather); half rations force
 * a DC 15 Constitution save, and less than half automatically causes
 * exhaustion. Exhaustion 6 is death.
 */
export function resolveDnd5eFoodAndWater(input: Dnd5eFoodAndWaterInput): Dnd5eFoodAndWaterResolution {
  const constitutionModifier = dnd5eAbilityModifier(input.constitutionScore);
  const starvationGraceDays = Math.max(1, DND_5E_DEPRIVATION.starvationGraceDaysBase + constitutionModifier);
  const daysWithoutFood = input.daysWithoutFood ?? 0;
  requireNonNegativeInteger(daysWithoutFood, "days without food");
  const foodExhaustion = Math.max(0, daysWithoutFood - starvationGraceDays);

  const waterGallonsRequired = input.hotWeather ? DND_5E_DEPRIVATION.waterGallonsPerDayHot : DND_5E_DEPRIVATION.waterGallonsPerDay;
  const waterConsumed = input.waterGallons ?? 0;
  requireNonNegativeNumber(waterConsumed, "water gallons");
  const existingExhaustion = input.existingExhaustion ?? 0;
  requireNonNegativeInteger(existingExhaustion, "existing exhaustion");

  let waterRations: Dnd5eFoodAndWaterResolution["waterRations"] = "none";
  let waterSave: Dnd5eFoodAndWaterResolution["waterSave"] = null;
  let waterExhaustion = 0;
  if (waterConsumed >= waterGallonsRequired) {
    waterRations = "full";
  } else if (waterConsumed >= waterGallonsRequired / 2) {
    waterRations = "half";
    const d20 = input.waterSaveRoll;
    if (d20 === undefined) throw new RangeError("half water rations require a Constitution save roll");
    const proficiencyBonus = input.proficiencyBonus ?? 0;
    requireNonNegativeInteger(proficiencyBonus, "proficiency bonus");
    const check = resolveDnd5eCheck({ d20, abilityScore: input.constitutionScore, proficiencyBonus, dc: DND_5E_DEPRIVATION.dehydrationSaveDc });
    waterSave = Object.freeze({ dc: check.dc, d20: check.d20, total: check.total, success: check.success });
    if (!check.success) waterExhaustion = existingExhaustion > 0 ? 2 : 1;
  } else {
    waterExhaustion = existingExhaustion > 0 ? 2 : 1;
  }

  const exhaustionGained = foodExhaustion + waterExhaustion;
  const resultingExhaustion = existingExhaustion + exhaustionGained;
  return Object.freeze({
    starvationGraceDays,
    foodExhaustion,
    waterGallonsRequired,
    waterRations,
    waterSave,
    waterExhaustion,
    exhaustionGained,
    existingExhaustion,
    resultingExhaustion,
    dead: resultingExhaustion >= DND_5E_DEPRIVATION.exhaustionDeathLevel,
  });
}

/* ------------------------------------------------------------------ */
/* Environmental hazards                                               */
/* ------------------------------------------------------------------ */

export type Dnd5eEnvironmentalHazardId = "extreme-cold" | "extreme-heat" | "strong-wind" | "heavy-precipitation";

export type Dnd5eEnvironmentalHazard = Readonly<{
  id: Dnd5eEnvironmentalHazardId;
  name: string;
  saveAbility: AbilityId | null;
  baseDc: number;
  dcIncreasePerInterval: number;
  intervalHours: number;
  exhaustionPerFailure: number;
  protectedAutomaticallySucceeds: boolean;
  damage: DiceTerm | null;
  damageIntervalHours: number | null;
  effects: readonly string[];
}>;

/**
 * SRD 5.1 / bounded environmental hazards. Extreme cold (DC 10) and extreme
 * heat (DC 5, rising by 1 each hour) force hourly Constitution saves and one
 * exhaustion level per failure; proper clothing or resistance automatically
 * succeeds. Strong wind and heavy precipitation impose listed effects and
 * require no save in the SRD.
 */
export const DND_5E_ENVIRONMENTAL_HAZARDS: Readonly<Record<Dnd5eEnvironmentalHazardId, Dnd5eEnvironmentalHazard>> = Object.freeze({
  "extreme-cold": Object.freeze({
    id: "extreme-cold", name: "Extreme Cold", saveAbility: "constitution", baseDc: 10, dcIncreasePerInterval: 0,
    intervalHours: 1, exhaustionPerFailure: 1, protectedAutomaticallySucceeds: true, damage: null, damageIntervalHours: null,
    effects: frozenList(["gain one level of exhaustion on a failed save at the end of each hour"]),
  }),
  "extreme-heat": Object.freeze({
    id: "extreme-heat", name: "Extreme Heat", saveAbility: "constitution", baseDc: 5, dcIncreasePerInterval: 1,
    intervalHours: 1, exhaustionPerFailure: 1, protectedAutomaticallySucceeds: true, damage: null, damageIntervalHours: null,
    effects: frozenList(["gain one level of exhaustion on a failed save at the end of each hour", "the save DC increases by 1 each hour after the first"]),
  }),
  "strong-wind": Object.freeze({
    id: "strong-wind", name: "Strong Wind", saveAbility: null, baseDc: 0, dcIncreasePerInterval: 0,
    intervalHours: 1, exhaustionPerFailure: 0, protectedAutomaticallySucceeds: false, damage: null, damageIntervalHours: null,
    effects: frozenList([
      "disadvantage on ranged weapon attack rolls",
      "disadvantage on Wisdom (Perception) checks that rely on hearing",
      "open flames are extinguished and fog is dispersed",
      "nonmagical flying is nearly impossible; a flying creature must land or fall",
    ]),
  }),
  "heavy-precipitation": Object.freeze({
    id: "heavy-precipitation", name: "Heavy Precipitation", saveAbility: null, baseDc: 0, dcIncreasePerInterval: 0,
    intervalHours: 1, exhaustionPerFailure: 0, protectedAutomaticallySucceeds: false, damage: null, damageIntervalHours: null,
    effects: frozenList([
      "the area is lightly obscured",
      "disadvantage on Wisdom (Perception) checks that rely on sight",
      "open flames are extinguished",
    ]),
  }),
});

export type Dnd5eHazardSave = Readonly<{ interval: number; dc: number; d20: number; total: number; success: boolean }>;

export type Dnd5eHazardExposureResolution = Readonly<{
  hazard: Dnd5eEnvironmentalHazardId;
  name: string;
  hours: number;
  intervalHours: number;
  saveCount: number;
  protected: boolean;
  saves: readonly Dnd5eHazardSave[];
  exhaustionGained: number;
  damage: number;
  damageEvidence: DamageRollResolution | null;
  effects: readonly string[];
  reasons: readonly string[];
}>;

export type Dnd5eHazardExposureInput = Readonly<{
  hazard: Dnd5eEnvironmentalHazardId | Dnd5eEnvironmentalHazard;
  hours: number;
  constitutionScore?: number;
  proficiencyBonus?: number;
  /** One d20 per save interval. */
  saveRolls?: readonly number[];
  /** Cold or hot weather protection, where the hazard allows automatic success. */
  protected?: boolean;
  /** d6 values for the hazard's damage dice, when it deals damage. */
  damageRolls?: readonly number[];
}>;

function resolveHazardModel(hazard: Dnd5eEnvironmentalHazardId | Dnd5eEnvironmentalHazard): Dnd5eEnvironmentalHazard {
  if (typeof hazard !== "string") return hazard;
  const model = DND_5E_ENVIRONMENTAL_HAZARDS[hazard];
  if (!model) throw new Error(`unknown environmental hazard: ${hazard}`);
  return model;
}

export function resolveDnd5eHazardExposure(input: Dnd5eHazardExposureInput): Dnd5eHazardExposureResolution {
  const hazard = resolveHazardModel(input.hazard);
  requireNonNegativeInteger(input.hours, "exposure hours");
  const protectedByGear = input.protected ?? false;
  const reasons: string[] = [];
  let saves: Dnd5eHazardSave[] = [];
  let exhaustionGained = 0;
  let saveCount = 0;
  if (hazard.saveAbility) {
    saveCount = Math.ceil(input.hours / hazard.intervalHours);
    if (protectedByGear && hazard.protectedAutomaticallySucceeds) {
      exhaustionGained = 0;
      reasons.push(`protection automatically succeeds against ${hazard.name.toLowerCase()}`);
    } else if (saveCount > 0) {
      if (input.constitutionScore === undefined) throw new RangeError("a Constitution score is required for this hazard");
      const rolls = input.saveRolls ?? [];
      if (rolls.length !== saveCount) throw new RangeError(`${hazard.name.toLowerCase()} requires exactly ${saveCount} save roll${saveCount === 1 ? "" : "s"}`);
      const proficiencyBonus = input.proficiencyBonus ?? 0;
      requireNonNegativeInteger(proficiencyBonus, "proficiency bonus");
      saves = rolls.map((d20, index) => {
        const interval = index + 1;
        const dc = hazard.baseDc + hazard.dcIncreasePerInterval * index;
        const check = resolveDnd5eCheck({ d20, abilityScore: input.constitutionScore!, proficiencyBonus, dc });
        return Object.freeze({ interval, dc, d20, total: check.total, success: check.success });
      });
      exhaustionGained = saves.filter((save) => !save.success).length * hazard.exhaustionPerFailure;
    }
  }

  let damage = 0;
  let damageEvidence: DamageRollResolution | null = null;
  if (hazard.damage && hazard.damageIntervalHours) {
    const intervals = Math.ceil(input.hours / hazard.damageIntervalHours);
    const term = Object.freeze({ count: hazard.damage.count * intervals, sides: hazard.damage.sides });
    const resolution = resolveDnd5eDamageRoll({ dice: [term], rolls: [input.damageRolls ?? []] });
    damage = resolution.total;
    damageEvidence = resolution;
  }

  return Object.freeze({
    hazard: hazard.id,
    name: hazard.name,
    hours: input.hours,
    intervalHours: hazard.intervalHours,
    saveCount,
    protected: protectedByGear,
    saves: frozenList(saves),
    exhaustionGained,
    damage,
    damageEvidence,
    effects: hazard.effects,
    reasons: frozenList(reasons),
  });
}

/* ------------------------------------------------------------------ */
/* Disease and poison                                                  */
/* ------------------------------------------------------------------ */

export type Dnd5ePoisonDelivery = "contact" | "ingested" | "inhaled" | "injury";

export type Dnd5ePoisonModel = Readonly<{
  id: string;
  name: string;
  delivery: Dnd5ePoisonDelivery;
  saveAbility: AbilityId;
  saveDc: number;
  /** "immediate" or an onset in hours. */
  onset: "immediate" | number;
  /** 0 when the poison resolves after a single save. */
  intervalHours: number;
  damage: DiceTerm | null;
  damageType: string | null;
  halfDamageOnSuccess: boolean;
  condition: string | null;
  conditionHours: number;
  /** Extra effect when the save fails by 5 or more. */
  failByFiveEffect: string | null;
  recoverySuccesses: number;
}>;

/** Bounded SRD poison models: save, onset, interval, damage, and condition. */
export const DND_5E_POISON_MODELS: Readonly<Record<string, Dnd5ePoisonModel>> = Object.freeze({
  "assassins-blood": Object.freeze({
    id: "assassins-blood", name: "Assassin's Blood", delivery: "ingested", saveAbility: "constitution", saveDc: 10,
    onset: "immediate", intervalHours: 0, damage: Object.freeze({ count: 1, sides: 12 }), damageType: "poison",
    halfDamageOnSuccess: true, condition: "poisoned", conditionHours: 24, failByFiveEffect: null, recoverySuccesses: 0,
  }),
  "basic-poison": Object.freeze({
    id: "basic-poison", name: "Basic Poison", delivery: "injury", saveAbility: "constitution", saveDc: 10,
    onset: "immediate", intervalHours: 0, damage: Object.freeze({ count: 1, sides: 4 }), damageType: "poison",
    halfDamageOnSuccess: false, condition: "poisoned", conditionHours: 0, failByFiveEffect: null, recoverySuccesses: 0,
  }),
  "drow-poison": Object.freeze({
    id: "drow-poison", name: "Drow Poison", delivery: "injury", saveAbility: "constitution", saveDc: 13,
    onset: "immediate", intervalHours: 0, damage: null, damageType: null, halfDamageOnSuccess: false,
    condition: "poisoned", conditionHours: 1, failByFiveEffect: "unconscious", recoverySuccesses: 0,
  }),
  "purple-worm-poison": Object.freeze({
    id: "purple-worm-poison", name: "Purple Worm Poison", delivery: "injury", saveAbility: "constitution", saveDc: 15,
    onset: "immediate", intervalHours: 0, damage: Object.freeze({ count: 12, sides: 6 }), damageType: "poison",
    halfDamageOnSuccess: true, condition: null, conditionHours: 0, failByFiveEffect: null, recoverySuccesses: 0,
  }),
  "serpent-venom": Object.freeze({
    id: "serpent-venom", name: "Serpent Venom", delivery: "injury", saveAbility: "constitution", saveDc: 11,
    onset: "immediate", intervalHours: 0, damage: Object.freeze({ count: 3, sides: 6 }), damageType: "poison",
    halfDamageOnSuccess: true, condition: null, conditionHours: 0, failByFiveEffect: null, recoverySuccesses: 0,
  }),
});

export type Dnd5ePoisonExposureInput = Readonly<{
  poison: string | Dnd5ePoisonModel;
  constitutionScore: number;
  proficiencyBonus?: number;
  d20: number;
  /** Damage dice values; required when the poison deals damage. */
  damageRolls?: readonly number[];
}>;

export type Dnd5ePoisonExposureResolution = Readonly<{
  poison: string;
  name: string;
  delivery: Dnd5ePoisonDelivery;
  saveDc: number;
  d20: number;
  total: number;
  success: boolean;
  onset: "immediate" | number;
  damage: number;
  damageEvidence: DamageRollResolution | null;
  damageType: string | null;
  condition: string | null;
  conditionHours: number;
  failByFiveEffect: string | null;
  recoverySuccesses: number;
  reasons: readonly string[];
}>;

function resolvePoisonModel(poison: string | Dnd5ePoisonModel): Dnd5ePoisonModel {
  if (typeof poison !== "string") return poison;
  const model = DND_5E_POISON_MODELS[poison];
  if (!model) throw new Error(`unknown poison: ${poison}`);
  return model;
}

export function resolveDnd5ePoisonExposure(input: Dnd5ePoisonExposureInput): Dnd5ePoisonExposureResolution {
  const poison = resolvePoisonModel(input.poison);
  const proficiencyBonus = input.proficiencyBonus ?? 0;
  requireNonNegativeInteger(proficiencyBonus, "proficiency bonus");
  const check = resolveDnd5eCheck({ d20: input.d20, abilityScore: input.constitutionScore, proficiencyBonus, dc: poison.saveDc });
  const reasons: string[] = [];
  let damage = 0;
  let damageEvidence: DamageRollResolution | null = null;
  if (poison.damage) {
    const resolution = resolveDnd5eDamageRoll({ dice: [poison.damage], rolls: [input.damageRolls ?? []] });
    damageEvidence = resolution;
    damage = check.success && poison.halfDamageOnSuccess ? Math.floor(resolution.total / 2) : check.success ? 0 : resolution.total;
  }
  const failedByFive = poison.saveDc - check.total >= 5;
  const condition = check.success ? null : poison.condition;
  const failByFiveEffect = !check.success && failedByFive ? poison.failByFiveEffect : null;
  if (check.success) reasons.push("successful save avoids the condition" + (poison.halfDamageOnSuccess && poison.damage ? " and halves the damage" : ""));
  if (failByFiveEffect) reasons.push(`failed the save by 5 or more: ${failByFiveEffect}`);
  return Object.freeze({
    poison: poison.id,
    name: poison.name,
    delivery: poison.delivery,
    saveDc: poison.saveDc,
    d20: check.d20,
    total: check.total,
    success: check.success,
    onset: poison.onset,
    damage,
    damageEvidence,
    damageType: poison.damageType,
    condition,
    conditionHours: check.success ? 0 : poison.conditionHours,
    failByFiveEffect,
    recoverySuccesses: poison.recoverySuccesses,
    reasons: frozenList(reasons),
  });
}

export type Dnd5eDiseaseModel = Readonly<{
  id: string;
  name: string;
  saveAbility: AbilityId;
  saveDc: number;
  incubationDays: number;
  intervalDays: number;
  damage: DiceTerm | null;
  damageType: string | null;
  exhaustionPerInterval: number;
  effect: string | null;
  /** Successful interval saves needed to recover; 0 when a single save ends it. */
  recoverySuccesses: number;
}>;

/** Bounded SRD disease models: incubation, interval saves, and effects. */
export const DND_5E_DISEASE_MODELS: Readonly<Record<string, Dnd5eDiseaseModel>> = Object.freeze({
  "cackle-fever": Object.freeze({
    id: "cackle-fever", name: "Cackle Fever", saveAbility: "constitution", saveDc: 13, incubationDays: 3, intervalDays: 1,
    damage: Object.freeze({ count: 1, sides: 6 }), damageType: "psychic", exhaustionPerInterval: 0, effect: null, recoverySuccesses: 3,
  }),
  "sewer-plague": Object.freeze({
    id: "sewer-plague", name: "Sewer Plague", saveAbility: "constitution", saveDc: 11, incubationDays: 3, intervalDays: 1,
    damage: null, damageType: null, exhaustionPerInterval: 1, effect: null, recoverySuccesses: 3,
  }),
  "sight-rot": Object.freeze({
    id: "sight-rot", name: "Sight Rot", saveAbility: "constitution", saveDc: 15, incubationDays: 1, intervalDays: 1,
    damage: null, damageType: null, exhaustionPerInterval: 0, effect: "blinded", recoverySuccesses: 0,
  }),
});

export type Dnd5eDiseaseIntervalInput = Readonly<{
  disease: string | Dnd5eDiseaseModel;
  constitutionScore: number;
  proficiencyBonus?: number;
  d20: number;
  /** Damage dice values for this interval; required when the disease deals damage. */
  damageRolls?: readonly number[];
  priorSuccesses?: number;
}>;

export type Dnd5eDiseaseIntervalResolution = Readonly<{
  disease: string;
  name: string;
  saveDc: number;
  d20: number;
  total: number;
  success: boolean;
  successes: number;
  recoverySuccesses: number;
  recovered: boolean;
  damage: number;
  damageEvidence: DamageRollResolution | null;
  damageType: string | null;
  exhaustionGained: number;
  effect: string | null;
  reasons: readonly string[];
}>;

function resolveDiseaseModel(disease: string | Dnd5eDiseaseModel): Dnd5eDiseaseModel {
  if (typeof disease !== "string") return disease;
  const model = DND_5E_DISEASE_MODELS[disease];
  if (!model) throw new Error(`unknown disease: ${disease}`);
  return model;
}

export function resolveDnd5eDiseaseInterval(input: Dnd5eDiseaseIntervalInput): Dnd5eDiseaseIntervalResolution {
  const disease = resolveDiseaseModel(input.disease);
  const proficiencyBonus = input.proficiencyBonus ?? 0;
  requireNonNegativeInteger(proficiencyBonus, "proficiency bonus");
  const priorSuccesses = input.priorSuccesses ?? 0;
  requireNonNegativeInteger(priorSuccesses, "prior disease successes");
  const check = resolveDnd5eCheck({ d20: input.d20, abilityScore: input.constitutionScore, proficiencyBonus, dc: disease.saveDc });
  const successes = check.success ? priorSuccesses + 1 : 0;
  const recovered = disease.recoverySuccesses > 0 && successes >= disease.recoverySuccesses;
  const reasons: string[] = [];
  let damage = 0;
  let damageEvidence: DamageRollResolution | null = null;
  if (!check.success && disease.damage) {
    const resolution = resolveDnd5eDamageRoll({ dice: [disease.damage], rolls: [input.damageRolls ?? []] });
    damage = resolution.total;
    damageEvidence = resolution;
  }
  const exhaustionGained = !check.success ? disease.exhaustionPerInterval : 0;
  const effect = !check.success && !recovered ? disease.effect : null;
  if (recovered) reasons.push(`recovered after ${successes} successful saves`);
  return Object.freeze({
    disease: disease.id,
    name: disease.name,
    saveDc: disease.saveDc,
    d20: check.d20,
    total: check.total,
    success: check.success,
    successes,
    recoverySuccesses: disease.recoverySuccesses,
    recovered,
    damage,
    damageEvidence,
    damageType: disease.damageType,
    exhaustionGained,
    effect,
    reasons: frozenList(reasons),
  });
}

/* ------------------------------------------------------------------ */
/* Lifestyle expenses                                                  */
/* ------------------------------------------------------------------ */

export type Dnd5eLifestyleId = "wretched" | "squalid" | "poor" | "modest" | "comfortable" | "wealthy" | "aristocratic";

export type Dnd5eLifestyle = Readonly<{ id: Dnd5eLifestyleId; name: string; costSpPerDay: number }>;

/** SRD 5.1 lifestyle expense tiers expressed in silver pieces per day. */
export const DND_5E_LIFESTYLES: readonly Dnd5eLifestyle[] = Object.freeze([
  Object.freeze({ id: "wretched", name: "Wretched", costSpPerDay: 0 }),
  Object.freeze({ id: "squalid", name: "Squalid", costSpPerDay: 1 }),
  Object.freeze({ id: "poor", name: "Poor", costSpPerDay: 2 }),
  Object.freeze({ id: "modest", name: "Modest", costSpPerDay: 10 }),
  Object.freeze({ id: "comfortable", name: "Comfortable", costSpPerDay: 20 }),
  Object.freeze({ id: "wealthy", name: "Wealthy", costSpPerDay: 40 }),
  Object.freeze({ id: "aristocratic", name: "Aristocratic", costSpPerDay: 100 }),
]);

export type Dnd5eLifestyleExpense = Readonly<{ lifestyle: Dnd5eLifestyleId; name: string; days: number; costSp: number; costGp: number }>;

export function resolveDnd5eLifestyleExpense(input: Readonly<{ lifestyle: Dnd5eLifestyleId; days: number }>): Dnd5eLifestyleExpense {
  const tier = DND_5E_LIFESTYLES.find((entry) => entry.id === input.lifestyle);
  if (!tier) throw new Error(`unknown lifestyle: ${input.lifestyle}`);
  requireNonNegativeInteger(input.days, "lifestyle days");
  const costSp = tier.costSpPerDay * input.days;
  return Object.freeze({ lifestyle: tier.id, name: tier.name, days: input.days, costSp, costGp: costSp / 10 });
}

/* ------------------------------------------------------------------ */
/* Downtime activities                                                 */
/* ------------------------------------------------------------------ */

export type Dnd5eDowntimeActivityId = "crafting" | "training" | "researching" | "recuperating";

export type Dnd5eDowntimeActivity = Readonly<{
  id: Dnd5eDowntimeActivityId;
  name: string;
  minimumDays: number;
  costPerDayGp: number;
  outputValuePerDayGp: number;
  requiresToolProficiency: boolean;
  saveAbility: AbilityId | null;
  saveDc: number | null;
  effects: readonly string[];
}>;

/** Bounded SRD downtime activities and their day counts and outcomes. */
export const DND_5E_DOWNTIME_ACTIVITIES: Readonly<Record<Dnd5eDowntimeActivityId, Dnd5eDowntimeActivity>> = Object.freeze({
  crafting: Object.freeze({
    id: "crafting", name: "Crafting", minimumDays: 1, costPerDayGp: 2.5, outputValuePerDayGp: 5, requiresToolProficiency: true,
    saveAbility: null, saveDc: null, effects: frozenList(["craft nonmagical items with a market value of up to 5 gp per day"]),
  }),
  training: Object.freeze({
    id: "training", name: "Training", minimumDays: 250, costPerDayGp: 1, outputValuePerDayGp: 0, requiresToolProficiency: false,
    saveAbility: null, saveDc: null, effects: frozenList(["gain proficiency with a tool or language"]),
  }),
  researching: Object.freeze({
    id: "researching", name: "Researching", minimumDays: 1, costPerDayGp: 1, outputValuePerDayGp: 0, requiresToolProficiency: false,
    saveAbility: null, saveDc: null, effects: frozenList(["uncover lore or information"]),
  }),
  recuperating: Object.freeze({
    id: "recuperating", name: "Recuperating", minimumDays: 3, costPerDayGp: 1, outputValuePerDayGp: 0, requiresToolProficiency: false,
    saveAbility: "constitution", saveDc: 15,
    effects: frozenList(["end one effect preventing hit point recovery, one ability-score reduction, or one hit point maximum reduction"]),
  }),
});

export type Dnd5eDowntimeInput = Readonly<{
  activity: Dnd5eDowntimeActivityId;
  days: number;
  constitutionScore?: number;
  proficiencyBonus?: number;
  /** d20 for the recuperating Constitution save, when applicable. */
  d20?: number;
}>;

export type Dnd5eDowntimePlan = Readonly<{
  activity: Dnd5eDowntimeActivityId;
  name: string;
  days: number;
  completed: boolean;
  costGp: number;
  outputValueGp: number;
  save: Readonly<{ dc: number; d20: number; total: number; success: boolean }> | null;
  effects: readonly string[];
  reasons: readonly string[];
}>;

export function planDnd5eDowntime(input: Dnd5eDowntimeInput): Dnd5eDowntimePlan {
  const activity = DND_5E_DOWNTIME_ACTIVITIES[input.activity];
  if (!activity) throw new Error(`unknown downtime activity: ${input.activity}`);
  requireNonNegativeInteger(input.days, "downtime days");
  const completed = input.days >= activity.minimumDays;
  const reasons: string[] = [];
  if (!completed) reasons.push(`${activity.name.toLowerCase()} requires at least ${activity.minimumDays} day${activity.minimumDays === 1 ? "" : "s"}`);
  const costGp = activity.costPerDayGp * input.days;
  const outputValueGp = activity.outputValuePerDayGp * input.days;
  let save: Dnd5eDowntimePlan["save"] = null;
  let effects: readonly string[] = [];
  if (completed && activity.saveAbility && activity.saveDc !== null) {
    if (input.constitutionScore === undefined || input.d20 === undefined) throw new RangeError(`${activity.name.toLowerCase()} requires a Constitution score and a save roll`);
    const proficiencyBonus = input.proficiencyBonus ?? 0;
    requireNonNegativeInteger(proficiencyBonus, "proficiency bonus");
    const check = resolveDnd5eCheck({ d20: input.d20, abilityScore: input.constitutionScore, proficiencyBonus, dc: activity.saveDc });
    save = Object.freeze({ dc: check.dc, d20: check.d20, total: check.total, success: check.success });
    effects = check.success ? activity.effects : frozenList([]);
  } else if (completed) {
    effects = activity.effects;
  }
  return Object.freeze({ activity: activity.id, name: activity.name, days: input.days, completed, costGp, outputValueGp, save, effects, reasons: frozenList(reasons) });
}
