import {
  DND_5E_DEPRIVATION,
  planDnd5eTravel,
  resolveDnd5eFoodAndWater,
  resolveDnd5eForcedMarch,
  resolveDnd5eHazardExposure,
  type Dnd5eFoodAndWaterResolution,
  type Dnd5eForcedMarchResolution,
  type Dnd5eHazardExposureInput,
  type Dnd5eHazardExposureResolution,
  type Dnd5eTravelPace,
  type Dnd5eTravelPlan,
} from "../../rulesets/dnd5e/adventuring.js";
import { frozenList, requireNonNegativeInteger } from "../../rulesets/dnd5e/internal.js";

/**
 * Deterministic adventuring-day composition. This module owns no persistence
 * and no HTTP surface: it projects the pure SRD rules onto a bounded adventure
 * state so callers can apply an exhaustion/damage delta through their own
 * repository boundary. Every die outcome is supplied by the caller.
 */

export type Dnd5eAdventureState = Readonly<{
  /** Current exhaustion level, 0-6. */
  exhaustion: number;
  hitPoints: number;
  maxHitPoints: number;
  /** Completed days without food before the day being resolved. */
  daysWithoutFood: number;
}>;

export type Dnd5eAdventureTravelInput = Readonly<{
  pace: Dnd5eTravelPace;
  hours: number;
  constitutionScore: number;
  proficiencyBonus?: number;
  /** One d20 per forced-march hour beyond the eighth. */
  saveRolls?: readonly number[];
}>;

export type Dnd5eAdventureFoodInput = Readonly<{
  constitutionScore: number;
  foodPounds: number;
  waterGallons: number;
  hotWeather?: boolean;
  waterSaveRoll?: number;
  proficiencyBonus?: number;
}>;

export type Dnd5eAdventureDayInput = Readonly<{
  state: Dnd5eAdventureState;
  travel: Dnd5eAdventureTravelInput;
  hazard?: Dnd5eHazardExposureInput;
  foodAndWater?: Dnd5eAdventureFoodInput;
}>;

export type Dnd5eAdventureDayPlan = Readonly<{
  milesTraveled: number;
  travel: Dnd5eTravelPlan;
  forcedMarch: Dnd5eForcedMarchResolution;
  hazard: Dnd5eHazardExposureResolution | null;
  deprivation: Dnd5eFoodAndWaterResolution | null;
  exhaustionGained: number;
  damageTaken: number;
  resultingExhaustion: number;
  resultingHitPoints: number;
  dead: boolean;
  segments: readonly string[];
  reasons: readonly string[];
}>;

export function planDnd5eAdventureDay(input: Dnd5eAdventureDayInput): Dnd5eAdventureDayPlan {
  const { state } = input;
  requireNonNegativeInteger(state.exhaustion, "exhaustion");
  if (state.exhaustion > DND_5E_DEPRIVATION.exhaustionDeathLevel) throw new RangeError("exhaustion must be between 0 and 6");
  requireNonNegativeInteger(state.hitPoints, "hit points");
  requireNonNegativeInteger(state.maxHitPoints, "maximum hit points");
  requireNonNegativeInteger(state.daysWithoutFood, "days without food");
  if (state.hitPoints > state.maxHitPoints) throw new RangeError("hit points exceed maximum hit points");

  const travel = planDnd5eTravel({ pace: input.travel.pace, hours: input.travel.hours });
  const forcedMarch = resolveDnd5eForcedMarch({
    hours: input.travel.hours,
    constitutionScore: input.travel.constitutionScore,
    ...(input.travel.proficiencyBonus !== undefined ? { proficiencyBonus: input.travel.proficiencyBonus } : {}),
    ...(input.travel.saveRolls !== undefined ? { saveRolls: input.travel.saveRolls } : {}),
  });

  const hazard = input.hazard ? resolveDnd5eHazardExposure(input.hazard) : null;

  let deprivation: Dnd5eFoodAndWaterResolution | null = null;
  if (input.foodAndWater) {
    const food = input.foodAndWater;
    const ateFullRations = food.foodPounds >= DND_5E_DEPRIVATION.foodPoundsPerDay;
    deprivation = resolveDnd5eFoodAndWater({
      constitutionScore: food.constitutionScore,
      daysWithoutFood: ateFullRations ? 0 : state.daysWithoutFood + 1,
      waterGallons: food.waterGallons,
      existingExhaustion: state.exhaustion,
      ...(food.hotWeather !== undefined ? { hotWeather: food.hotWeather } : {}),
      ...(food.waterSaveRoll !== undefined ? { waterSaveRoll: food.waterSaveRoll } : {}),
      ...(food.proficiencyBonus !== undefined ? { proficiencyBonus: food.proficiencyBonus } : {}),
    });
  }

  const exhaustionGained = forcedMarch.exhaustionLevels + (hazard?.exhaustionGained ?? 0) + (deprivation?.exhaustionGained ?? 0);
  const damageTaken = hazard?.damage ?? 0;
  const resultingExhaustion = state.exhaustion + exhaustionGained;
  const resultingHitPoints = Math.max(0, state.hitPoints - damageTaken);
  const dead = resultingExhaustion >= DND_5E_DEPRIVATION.exhaustionDeathLevel || resultingHitPoints === 0;
  const reasons: string[] = [];
  if (resultingExhaustion >= DND_5E_DEPRIVATION.exhaustionDeathLevel) reasons.push("exhaustion reached level 6");
  if (resultingHitPoints === 0) reasons.push("hit points reached 0");

  const segments: string[] = [`traveled ${travel.miles} miles at a ${travel.pace} pace`];
  if (forcedMarch.forcedHours > 0) segments.push(`forced march: ${forcedMarch.forcedHours} hour(s), ${forcedMarch.exhaustionLevels} exhaustion`);
  if (hazard) segments.push(`${hazard.name}: ${hazard.exhaustionGained} exhaustion, ${hazard.damage} damage`);
  if (deprivation) segments.push(`deprivation: ${deprivation.waterRations} water rations, ${deprivation.exhaustionGained} exhaustion`);
  if (exhaustionGained > 0) segments.push(`gained ${exhaustionGained} exhaustion level(s)`);
  if (damageTaken > 0) segments.push(`took ${damageTaken} damage`);

  return Object.freeze({
    milesTraveled: travel.miles,
    travel,
    forcedMarch,
    hazard,
    deprivation,
    exhaustionGained,
    damageTaken,
    resultingExhaustion,
    resultingHitPoints,
    dead,
    segments: frozenList(segments),
    reasons: frozenList(reasons),
  });
}
