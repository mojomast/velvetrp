import { describe, expect, it } from "vitest";
import {
  planDnd5eHighJump,
  planDnd5eLongJump,
  planDnd5eSpecialMovement,
  resolveDnd5eFalling,
  type SpecialMovementMode,
} from "../src/rulesets/index.js";

describe("SRD 5.1 long jump", () => {
  it("uses the full Strength score with at least a 10-foot run-up", () => {
    expect(planDnd5eLongJump({ strengthScore: 15, runUpFeet: 10, speed: 30 })).toEqual({
      kind: "long", runUp: true, distanceFeet: 15, cost: 15, budget: 30, remaining: 15, legal: true, reasons: [],
    });
  });

  it("halves the distance without a run-up", () => {
    expect(planDnd5eLongJump({ strengthScore: 15, runUpFeet: 9, speed: 30 })).toMatchObject({
      kind: "long", runUp: false, distanceFeet: 7, cost: 7, legal: true,
    });
  });

  it("is illegal when the jump exceeds the movement budget", () => {
    const plan = planDnd5eLongJump({ strengthScore: 15, runUpFeet: 10, speed: 10 });
    expect(plan).toMatchObject({ legal: false, remaining: 0, reasons: ["jump distance exceeds available movement"] });
  });

  it("rejects out-of-range Strength scores", () => {
    expect(() => planDnd5eLongJump({ strengthScore: 0, speed: 30 })).toThrow();
  });
});

describe("SRD 5.1 high jump", () => {
  it("uses 3 + Strength modifier with a run-up", () => {
    expect(planDnd5eHighJump({ strengthScore: 15, runUpFeet: 10, speed: 30 })).toMatchObject({
      kind: "high", runUp: true, distanceFeet: 5, cost: 5, legal: true,
    });
  });

  it("halves and rounds down without a run-up", () => {
    expect(planDnd5eHighJump({ strengthScore: 15, speed: 30 })).toMatchObject({ runUp: false, distanceFeet: 2 });
    expect(planDnd5eHighJump({ strengthScore: 16, speed: 30 })).toMatchObject({ runUp: false, distanceFeet: 3 });
  });

  it("never produces a negative height", () => {
    expect(planDnd5eHighJump({ strengthScore: 1, speed: 30 }).distanceFeet).toBe(0);
  });
});

describe("SRD 5.1 falling", () => {
  it("rolls 1d6 per 10 feet and lands prone", () => {
    const resolution = resolveDnd5eFalling({ distanceFeet: 30, rolls: [3, 5, 2] });
    expect(resolution).toMatchObject({ distanceFeet: 30, dice: 3, damage: 10, landProne: true, avoided: false });
    expect(resolution.evidence?.evidence[0]?.rolls).toEqual([3, 5, 2]);
  });

  it("caps the dice at 20d6 for a 200-foot fall", () => {
    const rolls = Array.from({ length: 20 }, (_, index) => (index % 6) + 1);
    const resolution = resolveDnd5eFalling({ distanceFeet: 200, rolls });
    expect(resolution.dice).toBe(20);
    expect(resolution.damage).toBe(rolls.reduce((sum, roll) => sum + roll, 0));
  });

  it("deals no dice for a fall under 10 feet and does not land prone at 0 feet", () => {
    expect(resolveDnd5eFalling({ distanceFeet: 5 })).toMatchObject({ dice: 0, damage: 0, landProne: true, evidence: null });
    expect(resolveDnd5eFalling({ distanceFeet: 0 })).toMatchObject({ dice: 0, damage: 0, landProne: false });
  });

  it("does not land prone when the fall is avoided", () => {
    expect(resolveDnd5eFalling({ distanceFeet: 30, rolls: [1, 1, 1], avoided: true })).toMatchObject({ landProne: false, avoided: true });
  });

  it("requires exactly one d6 per 10 feet within range", () => {
    expect(() => resolveDnd5eFalling({ distanceFeet: 30, rolls: [1, 2] })).toThrow(/exactly 3 d6/);
    expect(() => resolveDnd5eFalling({ distanceFeet: 10, rolls: [7] })).toThrow(/between 1 and 6/);
  });
});

describe("SRD 5.1 special movement", () => {
  it("charges 1 extra foot per foot for climbing, swimming, and crawling", () => {
    for (const mode of ["climb", "swim", "crawl"] as const) {
      expect(planDnd5eSpecialMovement({ mode, distance: 10, speed: 30 })).toMatchObject({
        mode, costPerFoot: 2, cost: 20, budget: 30, remaining: 10, legal: true,
      });
    }
  });

  it("doubles the cost for difficult terrain while climbing", () => {
    expect(planDnd5eSpecialMovement({ mode: "climb", distance: 10, speed: 30, difficultTerrain: true })).toMatchObject({
      costPerFoot: 4, cost: 40, legal: false,
    });
  });

  it("returns squeezing disadvantages as data without applying them globally", () => {
    expect(planDnd5eSpecialMovement({ mode: "squeeze", distance: 10, speed: 30 })).toMatchObject({
      costPerFoot: 2, cost: 20, attackDisadvantage: true, dexteritySaveDisadvantage: true, hovering: false,
    });
    expect(planDnd5eSpecialMovement({ mode: "crawl", distance: 10, speed: 30 })).toMatchObject({
      attackDisadvantage: false, dexteritySaveDisadvantage: false,
    });
  });

  it("spends a fly speed like any other speed and treats hovering as metadata", () => {
    expect(planDnd5eSpecialMovement({ mode: "fly", distance: 30, speed: 30 })).toMatchObject({
      costPerFoot: 1, cost: 30, budget: 30, legal: true, hovering: false,
    });
    expect(planDnd5eSpecialMovement({ mode: "fly", distance: 30, speed: 30, flySpeed: 60, hovering: true })).toMatchObject({
      cost: 30, budget: 60, remaining: 30, hovering: true,
    });
  });

  it("rejects an unknown movement mode", () => {
    expect(() => planDnd5eSpecialMovement({ mode: "burrow" as SpecialMovementMode, distance: 10, speed: 30 })).toThrow(/unknown special movement mode/);
  });
});
