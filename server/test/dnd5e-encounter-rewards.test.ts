import { describe, expect, it } from "vitest";
import {
  DND_5E_ENCOUNTER_REWARD_CAPABILITIES,
  SRD_LEVEL_XP_THRESHOLDS,
  planDnd5eEncounterRewards,
} from "../src/rulesets/dnd5e/encounterRewards.js";

describe("planDnd5eEncounterRewards", () => {
  it("awards raw SRD XP without the multiple-monster multiplier", () => {
    const plan = planDnd5eEncounterRewards({
      defeated: [{ challengeRating: 1, count: 4 }],
      currentXp: 0,
      currentLevel: 1,
    });
    expect(plan.xpAwarded).toBe(800);
    expect(plan.totalXp).toBe(800);
  });

  it("flags level-up eligibility and counts a crossed threshold", () => {
    const plan = planDnd5eEncounterRewards({
      defeated: [{ challengeRating: 1, count: 4 }],
      currentXp: 0,
      currentLevel: 1,
    });
    expect(plan.nextLevel).toBe(2);
    expect(plan.nextLevelXp).toBe(300);
    expect(plan.levelUpEligible).toBe(true);
    expect(plan.levelsGained).toBe(1);
  });

  it("stays ineligible below the next threshold", () => {
    const plan = planDnd5eEncounterRewards({
      defeated: [{ challengeRating: 0, count: 1 }],
      currentXp: 100,
      currentLevel: 1,
    });
    expect(plan.totalXp).toBe(110);
    expect(plan.levelUpEligible).toBe(false);
    expect(plan.levelsGained).toBe(0);
  });

  it("reports no next level at the maximum character level", () => {
    const plan = planDnd5eEncounterRewards({
      defeated: [{ challengeRating: 1, count: 1 }],
      currentXp: 355000,
      currentLevel: 20,
    });
    expect(plan.nextLevel).toBeNull();
    expect(plan.nextLevelXp).toBeNull();
    expect(plan.levelUpEligible).toBe(false);
    expect(plan.levelsGained).toBe(0);
  });

  it("is deterministic and does not mutate its input", () => {
    const input = {
      defeated: [{ challengeRating: 2, count: 3 }],
      currentXp: 1000,
      currentLevel: 3,
      thresholds: SRD_LEVEL_XP_THRESHOLDS,
    } as const;
    const snapshot = JSON.stringify(input);
    const first = planDnd5eEncounterRewards(input);
    const second = planDnd5eEncounterRewards(input);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.reasons)).toBe(true);
    expect(Object.isFrozen(DND_5E_ENCOUNTER_REWARD_CAPABILITIES[0])).toBe(true);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("throws on invalid numeric input and marks an unknown level illegal", () => {
    expect(() =>
      planDnd5eEncounterRewards({ defeated: [], currentXp: -1, currentLevel: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      planDnd5eEncounterRewards({ defeated: [], currentXp: 0, currentLevel: 1.5 }),
    ).toThrow(RangeError);
    const plan = planDnd5eEncounterRewards({ defeated: [], currentXp: 0, currentLevel: 21 });
    expect(plan.legal).toBe(false);
    expect(plan.reasons.length).toBeGreaterThan(0);
  });
});
