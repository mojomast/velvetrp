import { describe, expect, it } from "vitest";
import {
  planDnd5eConcentrationDamage, planDnd5eDamageAdjustment, resolveDnd5eAttack,
  resolveDnd5eDamageRoll, resolveDnd5eInitiative,
} from "../src/rulesets/index.js";

describe("SRD combat mechanics", () => {
  it("resolves AC attacks with natural 1 misses and natural 20 critical hits", () => {
    expect(resolveDnd5eAttack({ rolls: [1], abilityScore: 30, proficiencyBonus: 6, armorClass: 1 })).toMatchObject({ hit: false, automaticMiss: true, critical: false });
    expect(resolveDnd5eAttack({ rolls: [20], abilityScore: 1, armorClass: 40 })).toMatchObject({ hit: true, automaticMiss: false, critical: true });
    expect(resolveDnd5eAttack({ rolls: [14], abilityScore: 16, proficiencyBonus: 3, armorClass: 20 })).toMatchObject({ total: 20, hit: true, critical: false });
  });

  it("accepts critical thresholds from 2 through 20 without making natural 1 critical", () => {
    expect(resolveDnd5eAttack({ rolls: [1], abilityScore: 30, armorClass: 1, criticalThreshold: 2 })).toMatchObject({ hit: false, automaticMiss: true, critical: false });
    expect(resolveDnd5eAttack({ rolls: [2], abilityScore: 10, armorClass: 30, criticalThreshold: 2 })).toMatchObject({ hit: true, automaticMiss: false, critical: true });
    expect(resolveDnd5eAttack({ rolls: [19], abilityScore: 30, armorClass: 1, criticalThreshold: 20 })).toMatchObject({ hit: true, critical: false });
    expect(resolveDnd5eAttack({ rolls: [20], abilityScore: 1, armorClass: 40, criticalThreshold: 20 })).toMatchObject({ hit: true, critical: true });
  });

  it("rejects critical thresholds outside the integer range from 2 through 20", () => {
    for (const criticalThreshold of [0, 1, 21]) {
      expect(() => resolveDnd5eAttack({ rolls: [20], abilityScore: 10, armorClass: 10, criticalThreshold })).toThrow("critical threshold must be between 2 and 20");
    }
    expect(() => resolveDnd5eAttack({ rolls: [20], abilityScore: 10, armorClass: 10, criticalThreshold: 19.5 })).toThrow("critical threshold must be an integer");
  });

  it("doubles damage dice, not modifiers, on critical hits and preserves evidence", () => {
    const damage = resolveDnd5eDamageRoll({ dice: [{ count: 1, sides: 8 }, { count: 2, sides: 6 }], rolls: [[8, 3], [1, 2, 5, 6]], modifier: 4, critical: true });
    expect(damage).toEqual({ critical: true, evidence: [{ count: 1, sides: 8, rolls: [8, 3], subtotal: 11 }, { count: 2, sides: 6, rolls: [1, 2, 5, 6], subtotal: 14 }], modifier: 4, total: 29 });
    expect(Object.isFrozen(damage.evidence)).toBe(true);
    expect(() => resolveDnd5eDamageRoll({ dice: [{ count: 1, sides: 6 }], rolls: [[7]] })).toThrow("between 1 and 6");
  });

  it("floors resistance after total damage and composes explicit adjustments", () => {
    expect(planDnd5eDamageAdjustment(7, "resistance").applied).toBe(3);
    expect(planDnd5eDamageAdjustment(7, "vulnerability").applied).toBe(14);
    expect(planDnd5eDamageAdjustment(7, "immunity").hitPointDelta).toBe(0);
    for (let damage = 0; damage <= 100; damage += 1) expect(planDnd5eDamageAdjustment(damage, "resistance").applied).toBe(Math.floor(damage / 2));
  });

  it("orders initiative deterministically without inventing dice", () => {
    expect(resolveDnd5eInitiative([
      { id: "z", dexterityScore: 12, roll: 10 }, { id: "a", dexterityScore: 12, roll: 10 }, { id: "fast", dexterityScore: 18, roll: 8 },
    ]).map(({ id }) => id)).toEqual(["fast", "a", "z"]);
  });

  it("plans concentration DCs and resolves injected Constitution saves", () => {
    expect(planDnd5eConcentrationDamage(21, true)).toEqual({ required: true, dc: 10, broken: false });
    expect(planDnd5eConcentrationDamage(22, true, { rolls: [7], constitutionScore: 14, proficiencyBonus: 3 })).toMatchObject({ required: true, dc: 11, broken: false, check: { kind: "concentration-check", total: 12 } });
    expect(planDnd5eConcentrationDamage(40, true, { rolls: [5], constitutionScore: 10 })).toMatchObject({ dc: 20, broken: true });
    expect(planDnd5eConcentrationDamage(10, false)).toEqual({ required: false, dc: null, broken: false });
  });
});
