import { describe, expect, it } from "vitest";
import {
  DND_5E_DEPRIVATION,
  DND_5E_DOWNTIME_ACTIVITIES,
  DND_5E_ENVIRONMENTAL_HAZARDS,
  DND_5E_LIFESTYLES,
  DND_5E_POISON_MODELS,
  DND_5E_TRAVEL_PACES,
  planDnd5eDowntime,
  planDnd5eSuffocation,
  planDnd5eTravel,
  resolveDnd5eAdventuringFall,
  resolveDnd5eDiseaseInterval,
  resolveDnd5eFoodAndWater,
  resolveDnd5eForcedMarch,
  resolveDnd5eHazardExposure,
  resolveDnd5eLifestyleExpense,
  resolveDnd5ePoisonExposure,
  type Dnd5eEnvironmentalHazard,
} from "../src/rulesets/dnd5e/adventuring.js";
import { resolveDnd5eFalling } from "../src/rulesets/dnd5e/movement.js";
import { planDnd5eAdventureDay } from "../src/repo/adventure/adventuringDayRuntime.js";

describe("SRD 5.1 travel pace", () => {
  it("publishes the miles-per-hour, miles-per-day, and perception effects", () => {
    expect(DND_5E_TRAVEL_PACES.fast).toMatchObject({ milesPerHour: 4, milesPerDay: 30, passivePerceptionPenalty: 5, canStealth: false });
    expect(DND_5E_TRAVEL_PACES.normal).toMatchObject({ milesPerHour: 3, milesPerDay: 24, passivePerceptionPenalty: 0, canStealth: false });
    expect(DND_5E_TRAVEL_PACES.slow).toMatchObject({ milesPerHour: 2, milesPerDay: 18, passivePerceptionPenalty: 0, canStealth: true });
  });

  it("plans an eight-hour travel day by default", () => {
    expect(planDnd5eTravel({ pace: "fast" })).toEqual({
      pace: "fast", hours: 8, miles: 32, milesPerHour: 4, milesPerDay: 30, feetPerMinute: 400,
      passivePerceptionPenalty: 5, passivePerceptionAdjustment: -5, canStealth: false,
    });
    expect(planDnd5eTravel({ pace: "slow", hours: 4 })).toMatchObject({ miles: 8, canStealth: true, passivePerceptionAdjustment: 0 });
  });

  it("rejects an unknown pace", () => {
    expect(() => planDnd5eTravel({ pace: "sprint" as "fast", hours: 1 })).toThrow(/unknown travel pace/);
  });
});

describe("SRD 5.1 forced march", () => {
  it("adds no exhaustion within eight hours", () => {
    expect(resolveDnd5eForcedMarch({ hours: 8, constitutionScore: 10 })).toMatchObject({ forcedHours: 0, exhaustionLevels: 0, saves: [] });
  });

  it("requires a DC 10 + hours-past-eight save for each further hour", () => {
    const resolution = resolveDnd5eForcedMarch({ hours: 10, constitutionScore: 10, saveRolls: [10, 12] });
    expect(resolution.forcedHours).toBe(2);
    expect(resolution.saves).toEqual([
      { hour: 9, dc: 11, d20: 10, total: 10, success: false },
      { hour: 10, dc: 12, d20: 12, total: 12, success: true },
    ]);
    expect(resolution.exhaustionLevels).toBe(1);
  });

  it("requires exactly one roll per forced hour", () => {
    expect(() => resolveDnd5eForcedMarch({ hours: 10, constitutionScore: 10, saveRolls: [10] })).toThrow(/exactly 2 Constitution save rolls/);
  });
});

describe("SRD 5.1 suffocation", () => {
  it("holds breath for 1 + Constitution modifier minutes with a 30-second floor", () => {
    expect(planDnd5eSuffocation({ constitutionScore: 10 })).toEqual({
      constitutionModifier: 0, holdBreathSeconds: 60, holdBreathRounds: 10, surviveRounds: 1, dropsToZeroOnRound: 12,
    });
    expect(planDnd5eSuffocation({ constitutionScore: 8 })).toMatchObject({ constitutionModifier: -1, holdBreathSeconds: 30, holdBreathRounds: 5, surviveRounds: 1, dropsToZeroOnRound: 7 });
    expect(planDnd5eSuffocation({ constitutionScore: 20 })).toMatchObject({ constitutionModifier: 5, holdBreathSeconds: 360, holdBreathRounds: 60, surviveRounds: 5, dropsToZeroOnRound: 66 });
  });
});

describe("SRD 5.1 falling delegation", () => {
  it("reuses the movement resolver rather than duplicating it", () => {
    const input = { distanceFeet: 30, rolls: [3, 5, 2] } as const;
    const delegated = resolveDnd5eAdventuringFall(input);
    expect(delegated).toEqual(resolveDnd5eFalling(input));
    expect(delegated).toMatchObject({ dice: 3, damage: 10, landProne: true });
  });
});

describe("SRD 5.1 food and water", () => {
  it("grants 3 + Constitution modifier days of food before exhaustion", () => {
    expect(DND_5E_DEPRIVATION.starvationGraceDaysBase).toBe(3);
    expect(resolveDnd5eFoodAndWater({ constitutionScore: 10, daysWithoutFood: 4 }).foodExhaustion).toBe(1);
    expect(resolveDnd5eFoodAndWater({ constitutionScore: 10, daysWithoutFood: 3 }).foodExhaustion).toBe(0);
    expect(resolveDnd5eFoodAndWater({ constitutionScore: 20, daysWithoutFood: 8 }).starvationGraceDays).toBe(8);
  });

  it("awards no exhaustion for a full gallon of water", () => {
    expect(resolveDnd5eFoodAndWater({ constitutionScore: 10, waterGallons: 1 })).toMatchObject({ waterRations: "full", waterExhaustion: 0, exhaustionGained: 0, dead: false });
  });

  it("forces a DC 15 save on half rations and doubles the cost when already exhausted", () => {
    const failed = resolveDnd5eFoodAndWater({ constitutionScore: 10, waterGallons: 0.5, waterSaveRoll: 1 });
    expect(failed.waterRations).toBe("half");
    expect(failed.waterSave).toMatchObject({ dc: 15, total: 1, success: false });
    expect(failed.waterExhaustion).toBe(1);
    expect(resolveDnd5eFoodAndWater({ constitutionScore: 10, waterGallons: 0.5, waterSaveRoll: 20 }).waterExhaustion).toBe(0);
    expect(resolveDnd5eFoodAndWater({ constitutionScore: 10, waterGallons: 0.5, waterSaveRoll: 1, existingExhaustion: 2 }).waterExhaustion).toBe(2);
  });

  it("automatically exhausts with less than half rations and in hot weather", () => {
    expect(resolveDnd5eFoodAndWater({ constitutionScore: 10, waterGallons: 0 }).waterRations).toBe("none");
    expect(resolveDnd5eFoodAndWater({ constitutionScore: 10, waterGallons: 0 }).waterExhaustion).toBe(1);
    expect(resolveDnd5eFoodAndWater({ constitutionScore: 10, waterGallons: 0, existingExhaustion: 1 }).waterExhaustion).toBe(2);
    expect(resolveDnd5eFoodAndWater({ constitutionScore: 10, waterGallons: 1, hotWeather: true, waterSaveRoll: 20 }).waterRations).toBe("half");
  });

  it("reports death at exhaustion level 6", () => {
    const resolution = resolveDnd5eFoodAndWater({ constitutionScore: 10, daysWithoutFood: 10, waterGallons: 1, existingExhaustion: 5 });
    expect(resolution.exhaustionGained).toBe(7);
    expect(resolution.resultingExhaustion).toBe(12);
    expect(resolution.dead).toBe(true);
  });

  it("requires a save roll when only half the water is available", () => {
    expect(() => resolveDnd5eFoodAndWater({ constitutionScore: 10, waterGallons: 0.5 })).toThrow(/half water rations require/);
  });
});

describe("SRD 5.1 environmental hazards", () => {
  it("models extreme cold and extreme heat exhaustion saves", () => {
    expect(DND_5E_ENVIRONMENTAL_HAZARDS["extreme-cold"]).toMatchObject({ baseDc: 10, intervalHours: 1, exhaustionPerFailure: 1 });
    expect(DND_5E_ENVIRONMENTAL_HAZARDS["extreme-heat"]).toMatchObject({ baseDc: 5, dcIncreasePerInterval: 1 });
  });

  it("resolves hourly heat saves with a rising DC", () => {
    const resolution = resolveDnd5eHazardExposure({ hazard: "extreme-heat", hours: 3, constitutionScore: 10, saveRolls: [1, 1, 1] });
    expect(resolution.saves.map((save) => save.dc)).toEqual([5, 6, 7]);
    expect(resolution.exhaustionGained).toBe(3);
  });

  it("succeeds automatically in cold weather gear", () => {
    const resolution = resolveDnd5eHazardExposure({ hazard: "extreme-cold", hours: 3, constitutionScore: 10, protected: true });
    expect(resolution).toMatchObject({ saveCount: 3, protected: true, exhaustionGained: 0, saves: [] });
    expect(resolution.reasons[0]).toMatch(/protection automatically succeeds/);
  });

  it("returns strong-wind and heavy-precipitation effects without a save", () => {
    expect(resolveDnd5eHazardExposure({ hazard: "strong-wind", hours: 2 })).toMatchObject({ saveCount: 0, exhaustionGained: 0, damage: 0 });
    expect(DND_5E_ENVIRONMENTAL_HAZARDS["strong-wind"].effects.length).toBeGreaterThan(0);
    expect(DND_5E_ENVIRONMENTAL_HAZARDS["heavy-precipitation"].effects.length).toBeGreaterThan(0);
  });

  it("resolves bounded hazard damage when a hazard model deals it", () => {
    const searingAsh: Dnd5eEnvironmentalHazard = {
      id: "extreme-heat", name: "Searing Ash", saveAbility: "constitution", baseDc: 12, dcIncreasePerInterval: 0,
      intervalHours: 2, exhaustionPerFailure: 1, protectedAutomaticallySucceeds: false,
      damage: { count: 1, sides: 6 }, damageIntervalHours: 1, effects: [],
    };
    const resolution = resolveDnd5eHazardExposure({ hazard: searingAsh, hours: 2, constitutionScore: 10, saveRolls: [20], damageRolls: [3, 4] });
    expect(resolution).toMatchObject({ saveCount: 1, exhaustionGained: 0, damage: 7 });
    expect(resolution.damageEvidence?.evidence[0]?.rolls).toEqual([3, 4]);
  });
});

describe("SRD 5.1 poison", () => {
  it("applies damage and the poisoned condition on a failed save", () => {
    const resolution = resolveDnd5ePoisonExposure({ poison: "assassins-blood", constitutionScore: 10, d20: 1, damageRolls: [6] });
    expect(resolution).toMatchObject({ success: false, damage: 6, condition: "poisoned", conditionHours: 24, damageType: "poison" });
  });

  it("halves damage and avoids the condition on a successful save", () => {
    const resolution = resolveDnd5ePoisonExposure({ poison: "assassins-blood", constitutionScore: 10, d20: 20, damageRolls: [6] });
    expect(resolution).toMatchObject({ success: true, damage: 3, condition: null, conditionHours: 0 });
  });

  it("adds the fail-by-five effect", () => {
    expect(resolveDnd5ePoisonExposure({ poison: "drow-poison", constitutionScore: 10, d20: 1 }).failByFiveEffect).toBe("unconscious");
    expect(resolveDnd5ePoisonExposure({ poison: "drow-poison", constitutionScore: 10, d20: 9 }).failByFiveEffect).toBeNull();
  });

  it("halves multi-die damage on a successful save", () => {
    expect(resolveDnd5ePoisonExposure({ poison: "serpent-venom", constitutionScore: 10, d20: 20, damageRolls: [2, 2, 2] }).damage).toBe(3);
  });

  it("publishes a bounded model set and rejects unknown poisons", () => {
    expect(Object.keys(DND_5E_POISON_MODELS).length).toBeGreaterThanOrEqual(5);
    expect(() => resolveDnd5ePoisonExposure({ poison: "unknown", constitutionScore: 10, d20: 10 })).toThrow(/unknown poison/);
  });
});

describe("SRD 5.1 disease", () => {
  it("applies interval damage on a failed save", () => {
    const resolution = resolveDnd5eDiseaseInterval({ disease: "cackle-fever", constitutionScore: 10, d20: 1, damageRolls: [4] });
    expect(resolution).toMatchObject({ success: false, damage: 4, damageType: "psychic", exhaustionGained: 0, effect: null });
  });

  it("tracks recovery successes", () => {
    const resolution = resolveDnd5eDiseaseInterval({ disease: "cackle-fever", constitutionScore: 10, d20: 20, priorSuccesses: 2 });
    expect(resolution).toMatchObject({ success: true, successes: 3, recovered: true });
    expect(resolution.reasons[0]).toMatch(/recovered after 3 successful saves/);
  });

  it("applies exhaustion and effects for other diseases", () => {
    expect(resolveDnd5eDiseaseInterval({ disease: "sewer-plague", constitutionScore: 10, d20: 1 }).exhaustionGained).toBe(1);
    expect(resolveDnd5eDiseaseInterval({ disease: "sight-rot", constitutionScore: 10, d20: 1 }).effect).toBe("blinded");
  });
});

describe("SRD 5.1 lifestyle expenses", () => {
  it("lists the seven lifestyle tiers with daily costs", () => {
    expect(DND_5E_LIFESTYLES.map((tier) => tier.id)).toEqual(["wretched", "squalid", "poor", "modest", "comfortable", "wealthy", "aristocratic"]);
    expect(resolveDnd5eLifestyleExpense({ lifestyle: "modest", days: 3 })).toEqual({ lifestyle: "modest", name: "Modest", days: 3, costSp: 30, costGp: 3 });
    expect(resolveDnd5eLifestyleExpense({ lifestyle: "aristocratic", days: 1 })).toMatchObject({ costSp: 100, costGp: 10 });
    expect(resolveDnd5eLifestyleExpense({ lifestyle: "wretched", days: 30 })).toMatchObject({ costSp: 0, costGp: 0 });
  });

  it("rejects an unknown lifestyle", () => {
    expect(() => resolveDnd5eLifestyleExpense({ lifestyle: "royal" as "modest", days: 1 })).toThrow(/unknown lifestyle/);
  });
});

describe("SRD 5.1 downtime", () => {
  it("publishes bounded day counts and costs", () => {
    expect(DND_5E_DOWNTIME_ACTIVITIES.crafting).toMatchObject({ minimumDays: 1, outputValuePerDayGp: 5, requiresToolProficiency: true });
    expect(DND_5E_DOWNTIME_ACTIVITIES.training.minimumDays).toBe(250);
    expect(DND_5E_DOWNTIME_ACTIVITIES.recuperating).toMatchObject({ minimumDays: 3, saveDc: 15 });
  });

  it("plans crafting output and cost", () => {
    expect(planDnd5eDowntime({ activity: "crafting", days: 2 })).toMatchObject({ completed: true, costGp: 5, outputValueGp: 10, effects: ["craft nonmagical items with a market value of up to 5 gp per day"] });
  });

  it("marks training incomplete until the required days elapse", () => {
    expect(planDnd5eDowntime({ activity: "training", days: 100 })).toMatchObject({ completed: false, costGp: 100, outputValueGp: 0, effects: [] });
    expect(planDnd5eDowntime({ activity: "training", days: 100 }).reasons[0]).toMatch(/requires at least 250 days/);
    expect(planDnd5eDowntime({ activity: "training", days: 250 })).toMatchObject({ completed: true, effects: ["gain proficiency with a tool or language"] });
  });

  it("resolves the recuperating Constitution save", () => {
    const success = planDnd5eDowntime({ activity: "recuperating", days: 3, constitutionScore: 10, d20: 15 });
    expect(success.save).toMatchObject({ dc: 15, total: 15, success: true });
    expect(success.effects).toHaveLength(1);
    const failure = planDnd5eDowntime({ activity: "recuperating", days: 3, constitutionScore: 10, d20: 1 });
    expect(failure).toMatchObject({ save: { dc: 15, total: 1, success: false }, effects: [] });
  });
});

describe("adventuring day composition", () => {
  it("composes travel, forced march, hazard, and deprivation into one delta", () => {
    const plan = planDnd5eAdventureDay({
      state: { exhaustion: 0, hitPoints: 20, maxHitPoints: 20, daysWithoutFood: 0 },
      travel: { pace: "normal", hours: 10, constitutionScore: 10, saveRolls: [1, 1] },
      hazard: { hazard: "extreme-heat", hours: 1, constitutionScore: 10, saveRolls: [1] },
      foodAndWater: { constitutionScore: 10, foodPounds: 0, waterGallons: 0.5, waterSaveRoll: 1 },
    });
    expect(plan.milesTraveled).toBe(30);
    expect(plan.forcedMarch.exhaustionLevels).toBe(2);
    expect(plan.hazard?.exhaustionGained).toBe(1);
    expect(plan.deprivation?.exhaustionGained).toBe(1);
    expect(plan.exhaustionGained).toBe(4);
    expect(plan.resultingExhaustion).toBe(4);
    expect(plan.resultingHitPoints).toBe(20);
    expect(plan.dead).toBe(false);
  });

  it("applies hazard damage to hit points and reports death", () => {
    const searingAsh: Dnd5eEnvironmentalHazard = {
      id: "extreme-heat", name: "Searing Ash", saveAbility: "constitution", baseDc: 12, dcIncreasePerInterval: 0,
      intervalHours: 1, exhaustionPerFailure: 1, protectedAutomaticallySucceeds: false,
      damage: { count: 1, sides: 6 }, damageIntervalHours: 1, effects: [],
    };
    const plan = planDnd5eAdventureDay({
      state: { exhaustion: 0, hitPoints: 6, maxHitPoints: 20, daysWithoutFood: 0 },
      travel: { pace: "normal", hours: 1, constitutionScore: 10 },
      hazard: { hazard: searingAsh, hours: 1, constitutionScore: 10, saveRolls: [20], damageRolls: [6] },
    });
    expect(plan.damageTaken).toBe(6);
    expect(plan.resultingHitPoints).toBe(0);
    expect(plan.dead).toBe(true);
    expect(plan.reasons).toContain("hit points reached 0");
  });

  it("reports death when exhaustion reaches level 6", () => {
    const plan = planDnd5eAdventureDay({
      state: { exhaustion: 5, hitPoints: 6, maxHitPoints: 20, daysWithoutFood: 0 },
      travel: { pace: "normal", hours: 10, constitutionScore: 10, saveRolls: [1, 1] },
    });
    expect(plan.resultingExhaustion).toBe(7);
    expect(plan.dead).toBe(true);
    expect(plan.reasons).toContain("exhaustion reached level 6");
  });

  it("validates the adventure state", () => {
    expect(() => planDnd5eAdventureDay({
      state: { exhaustion: 7, hitPoints: 1, maxHitPoints: 20, daysWithoutFood: 0 },
      travel: { pace: "normal", hours: 1, constitutionScore: 10 },
    })).toThrow(/exhaustion must be between 0 and 6/);
    expect(() => planDnd5eAdventureDay({
      state: { exhaustion: 0, hitPoints: 21, maxHitPoints: 20, daysWithoutFood: 0 },
      travel: { pace: "normal", hours: 1, constitutionScore: 10 },
    })).toThrow(/hit points exceed maximum hit points/);
  });
});
