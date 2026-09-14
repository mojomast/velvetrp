import { describe, expect, it } from "vitest";
import {
  adjustedEncounterXp,
  challengeRatingKey,
  encounterDifficulty,
  encounterMultiplier,
  monsterXp,
  partyXpThresholds,
  rawEncounterXp,
} from "../src/rulesets/dnd5e/encounterXp.js";

describe("SRD challenge-rating XP table", () => {
  it("resolves fractional and integer challenge ratings", () => {
    expect(challengeRatingKey(0)).toBe("0");
    expect(challengeRatingKey(0.125)).toBe("1/8");
    expect(challengeRatingKey(0.25)).toBe("1/4");
    expect(challengeRatingKey(0.5)).toBe("1/2");
    expect(challengeRatingKey(30)).toBe("30");
    expect(() => challengeRatingKey(0.3)).toThrow();
    expect(() => challengeRatingKey(31)).toThrow();
  });

  it("returns canonical SRD XP values", () => {
    expect(monsterXp(0)).toBe(10);
    expect(monsterXp(0.125)).toBe(25);
    expect(monsterXp(0.5)).toBe(100);
    expect(monsterXp(1)).toBe(200);
    expect(monsterXp(5)).toBe(1800);
    expect(monsterXp(20)).toBe(25000);
    expect(monsterXp(30)).toBe(155000);
  });
});

describe("SRD encounter multiplier", () => {
  it("follows the multiple-monster table for a normal party", () => {
    expect(encounterMultiplier(1, 4)).toBe(1);
    expect(encounterMultiplier(2, 4)).toBe(1.5);
    expect(encounterMultiplier(4, 4)).toBe(2);
    expect(encounterMultiplier(8, 4)).toBe(2.5);
    expect(encounterMultiplier(12, 4)).toBe(3);
    expect(encounterMultiplier(16, 4)).toBe(4);
  });

  it("adjusts one step for parties below 3 or above 5", () => {
    expect(encounterMultiplier(1, 2)).toBe(1.5);
    expect(encounterMultiplier(4, 2)).toBe(2.5);
    expect(encounterMultiplier(4, 6)).toBe(1.5);
    expect(encounterMultiplier(16, 6)).toBe(3);
  });
});

describe("SRD encounter difficulty", () => {
  it("sums per-character thresholds across the party", () => {
    expect(partyXpThresholds([1])).toEqual({ easy: 25, medium: 50, hard: 75, deadly: 100 });
    expect(partyXpThresholds([3])).toEqual({ easy: 75, medium: 150, hard: 225, deadly: 400 });
    expect(partyXpThresholds([3, 3])).toEqual({ easy: 150, medium: 300, hard: 450, deadly: 800 });
    expect(() => partyXpThresholds([])).toThrow();
    expect(() => partyXpThresholds([21])).toThrow();
  });

  it("applies the multiplier and classifies difficulty", () => {
    const monsters = [{ challengeRating: 1, count: 4 }] as const;
    expect(rawEncounterXp(monsters)).toBe(800);
    expect(adjustedEncounterXp(monsters, 4)).toBe(1600);
    expect(encounterDifficulty(1600, [3, 3])).toBe("deadly");
    expect(encounterDifficulty(1600, [5, 5, 5, 5])).toBe("easy");
    expect(encounterDifficulty(10, [20, 20, 20, 20])).toBe("trivial");
    expect(adjustedEncounterXp([], 4)).toBe(0);
  });
});
