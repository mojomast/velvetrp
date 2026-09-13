import { describe, expect, it } from "vitest";
import { adjustedCombatDamage } from "../src/repo/encounter/damageAdjustment.js";

describe("combat damage adjustment", () => {
  it("applies the shared SRD adjustment math to runtime damage", () => {
    expect(adjustedCombatDamage(9, "none")).toBe(9);
    expect(adjustedCombatDamage(9, "resistance")).toBe(4);
    expect(adjustedCombatDamage(9, "vulnerability")).toBe(18);
    expect(adjustedCombatDamage(9, "immunity")).toBe(0);
    expect(adjustedCombatDamage(0, "vulnerability")).toBe(0);
  });
});
