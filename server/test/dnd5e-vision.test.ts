import { describe, expect, it } from "vitest";
import {
  dnd5eSpecialSense,
  lightLevelAt,
  obscurementPenalty,
  passivePerceptionObscurementAdjustment,
  resolveDnd5eVision,
} from "../src/rulesets/dnd5e/vision.js";
import { planDnd5eAttackConditions } from "../src/rulesets/dnd5e/attack.js";

describe("SRD 5.1 light levels", () => {
  it("resolves the brightest level across overlapping sources", () => {
    const torch = { id: "torch", brightFeet: 20, dimFeet: 20 };
    expect(lightLevelAt({ sources: [torch], distanceFeet: 10 })).toBe("bright-light");
    expect(lightLevelAt({ sources: [torch], distanceFeet: 30 })).toBe("dim-light");
    expect(lightLevelAt({ sources: [torch], distanceFeet: 45 })).toBe("darkness");
    const candle = { id: "candle", brightFeet: 5, dimFeet: 5 };
    expect(lightLevelAt({ sources: [candle, torch], distanceFeet: 15 })).toBe("bright-light");
    expect(lightLevelAt({ sources: [], distanceFeet: 0 })).toBe("darkness");
  });
});

describe("SRD 5.1 obscurement", () => {
  it("publishes the sight-blocking and passive Perception effects", () => {
    expect(obscurementPenalty("none")).toEqual({ blocksSight: false, passivePerceptionPenalty: 0 });
    expect(obscurementPenalty("lightly-obscured")).toEqual({ blocksSight: false, passivePerceptionPenalty: 5 });
    expect(obscurementPenalty("heavily-obscured")).toEqual({ blocksSight: true, passivePerceptionPenalty: 0 });
    expect(passivePerceptionObscurementAdjustment("lightly-obscured")).toBe(-5);
  });
});

describe("SRD 5.1 vision resolution", () => {
  it("blocks sight in darkness without a special sense", () => {
    const result = resolveDnd5eVision({ light: "darkness", obscurement: "none", distanceFeet: 30 });
    expect(result).toMatchObject({ visible: false, unseen: true, attackDisadvantageAgainst: true, attackDisadvantageWhileUnseen: true, seesInDarkness: false });
  });

  it("reveals darkness within darkvision range but not beyond it", () => {
    const near = resolveDnd5eVision({ light: "darkness", obscurement: "none", senses: ["darkvision"], senseRangeFeet: 60, distanceFeet: 30 });
    expect(near).toMatchObject({ visible: true, unseen: false, seesInDarkness: true });
    const far = resolveDnd5eVision({ light: "darkness", obscurement: "none", senses: ["darkvision"], senseRangeFeet: 60, distanceFeet: 90 });
    expect(far).toMatchObject({ visible: false, unseen: true });
  });

  it("lets blindsight and truesight ignore darkness and obscurement entirely", () => {
    for (const sense of ["blindsight", "truesight"] as const) {
      const result = resolveDnd5eVision({ light: "darkness", obscurement: "heavily-obscured", senses: [sense], distanceFeet: 100 });
      expect(result).toMatchObject({ visible: true, unseen: false, effectiveObscurement: "none" });
    }
  });

  it("does not let darkvision see through heavy obscurement", () => {
    const result = resolveDnd5eVision({ light: "bright-light", obscurement: "heavily-obscured", senses: ["darkvision"], senseRangeFeet: 60, distanceFeet: 10 });
    expect(result).toMatchObject({ visible: false, unseen: true, effectiveObscurement: "heavily-obscured" });
  });

  it("treats lightly obscured spaces as visible but penalized", () => {
    const result = resolveDnd5eVision({ light: "bright-light", obscurement: "lightly-obscured", distanceFeet: 10 });
    expect(result).toMatchObject({ visible: true, unseen: false, effectiveObscurement: "lightly-obscured" });
    expect(result.attackDisadvantageAgainst).toBe(false);
  });

  it("bounds and validates special sense descriptors", () => {
    expect(dnd5eSpecialSense("darkvision", 60)).toEqual({ sense: "darkvision", rangeFeet: 60 });
    expect(dnd5eSpecialSense("truesight")).toEqual({ sense: "truesight", rangeFeet: null });
    expect(() => dnd5eSpecialSense("darkvision", -1)).toThrow();
  });
});

describe("SRD 5.1 unseen combatants affect attack rolls", () => {
  const base = { attacker: [], target: [], kind: "melee" } as const;
  it("grants advantage to an unseen attacker and disadvantage against an unseen target", () => {
    expect(planDnd5eAttackConditions({ ...base, attackerUnseen: true }).mode).toBe("advantage");
    expect(planDnd5eAttackConditions({ ...base, targetUnseen: true }).mode).toBe("disadvantage");
  });

  it("cancels unseen advantage and disadvantage against each other", () => {
    expect(planDnd5eAttackConditions({ ...base, attackerUnseen: true, targetUnseen: true }).mode).toBe("normal");
  });
});
