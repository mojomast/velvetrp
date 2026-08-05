import { describe, expect, it, vi } from "vitest";
import { calculateCharacterDerivedStats, rollCharacterBuilderAttributes } from "../src/repo/index.js";

describe("closed character calculator and server roll", () => {
  it("derives the complete fixed vector and explanatory inputs", () => {
    const result = calculateCharacterDerivedStats({
      scores: { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 },
      racialBonuses: { resolve: 1, insight: 1 }, classHp: 10, raceSpeed: 30,
      proficiencyBonus: 2, spellcastingAttribute: "resolve",
    });
    expect(result).toMatchObject({ maxHp: 12, defenses: { guard: 12, evasion: 12, will: 11 }, initiative: 2,
      speed: 30, carryingLimit: 225, spellAttack: 4, saveDc: 12 });
    expect(result.explanations.map((value) => value.statistic)).toEqual([
      "max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc",
    ]);
  });

  it("rolls all 24 physical dice independently with exact bounds and persists terms", () => {
    const values = Array.from({ length: 24 }, (_, index) => index % 6 + 1);
    const integer = vi.fn((_min: number, _max: number) => values.shift()!);
    const first = rollCharacterBuilderAttributes({ integer });
    expect(integer).toHaveBeenCalledTimes(24);
    expect(integer.mock.calls.every((call) => call[0] === 1 && call[1] === 7)).toBe(true);
    expect(first.terms).toHaveLength(6);
    expect(first.terms.every((term) => term.score === term.dice.reduce((sum, die) => sum + die, 0) - term.dice[term.droppedIndex]!)).toBe(true);
    const repeat = Array.from({ length: 24 }, (_, index) => index % 6 + 1);
    expect(rollCharacterBuilderAttributes({ integer: () => repeat.shift()! })).toEqual(first);
  });

  it("keeps controlled all-odd and all-even physical outcomes reachable", () => {
    const odd = [1, 3, 5, 1], even = [2, 4, 6, 2];
    const oddValues = Array.from({ length: 6 }, () => odd).flat(), evenValues = Array.from({ length: 6 }, () => even).flat();
    expect(rollCharacterBuilderAttributes({ integer: () => oddValues.shift()! }).terms.every((term) => term.dice.every((die) => die % 2 === 1))).toBe(true);
    expect(rollCharacterBuilderAttributes({ integer: () => evenValues.shift()! }).terms.every((term) => term.dice.every((die) => die % 2 === 0))).toBe(true);
  });

  it("rejects an invalid or failing RNG without a fallback call", () => {
    const invalid = vi.fn(() => -1);
    expect(() => rollCharacterBuilderAttributes({ integer: invalid })).toThrow("out-of-range");
    expect(invalid).toHaveBeenCalledOnce();
    const failing = vi.fn(() => { throw new Error("rng unavailable"); });
    expect(() => rollCharacterBuilderAttributes({ integer: failing })).toThrow("rng unavailable");
    expect(failing).toHaveBeenCalledOnce();
  });
});
