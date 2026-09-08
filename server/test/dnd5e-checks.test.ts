import { describe, expect, it } from "vitest";
import {
  DND_5E_SKILL_ABILITIES, dnd5ePassiveCheck, dnd5eRollMode, resolveDnd5eAbilityTest,
  resolveDnd5eD20Test, resolveDnd5eSkillTest,
} from "../src/rulesets/index.js";

describe("SRD d20 tests", () => {
  it("cancels any advantage and disadvantage sources", () => {
    expect(dnd5eRollMode(0, 0)).toBe("normal");
    expect(dnd5eRollMode(3, 0)).toBe("advantage");
    expect(dnd5eRollMode(0, 2)).toBe("disadvantage");
    expect(dnd5eRollMode(5, 1)).toBe("normal");
  });

  it("retains supplied dice evidence and selects the correct face", () => {
    const advantage = resolveDnd5eD20Test({ rolls: [3, 17], abilityScore: 14, proficiencyBonus: 3, dc: 20, advantageSources: 1 });
    expect(advantage).toMatchObject({ evidence: { supplied: [3, 17], mode: "advantage", selectedIndex: 1, selected: 17 }, abilityModifier: 2, appliedProficiency: 3, total: 22, success: true });
    const disadvantage = resolveDnd5eD20Test({ rolls: [3, 17], abilityScore: 14, dc: 6, disadvantageSources: 1 });
    expect(disadvantage.evidence.selected).toBe(3);
    const cancelled = resolveDnd5eD20Test({ rolls: [11], abilityScore: 10, dc: 11, advantageSources: 4, disadvantageSources: 1 });
    expect(cancelled.evidence.mode).toBe("normal");
    expect(Object.isFrozen(advantage.evidence.supplied)).toBe(true);
  });

  it("supports proficiency, half proficiency, and expertise with floor rounding", () => {
    const totals = ([0, 0.5, 1, 2] as const).map((proficiencyMultiplier) => resolveDnd5eD20Test({ rolls: [10], abilityScore: 10, proficiencyBonus: 3, proficiencyMultiplier, dc: 0 }).total);
    expect(totals).toEqual([10, 11, 13, 16]);
  });

  it("labels ability, skill, save, and concentration checks", () => {
    expect(DND_5E_SKILL_ABILITIES.athletics).toBe("strength");
    expect(resolveDnd5eSkillTest("perception", { rolls: [10], abilityScore: 16, dc: 13 })).toMatchObject({ kind: "skill-check", skill: "perception", ability: "wisdom", success: true });
    expect(resolveDnd5eAbilityTest("saving-throw", "dexterity", { rolls: [8], abilityScore: 18, dc: 12 })).toMatchObject({ kind: "saving-throw", ability: "dexterity", success: true });
  });

  it("applies passive advantage adjustments after cancellation", () => {
    expect(dnd5ePassiveCheck(16, 3)).toBe(16);
    expect(dnd5ePassiveCheck(16, 3, 1, 1, 0)).toBe(21);
    expect(dnd5ePassiveCheck(16, 3, 1, 0, 1)).toBe(11);
    expect(dnd5ePassiveCheck(16, 3, 1, 1, 1)).toBe(16);
  });

  it("obeys monotonic DC and modifier properties across broad input ranges", () => {
    for (let score = 1; score <= 30; score += 1) {
      for (let roll = 1; roll <= 20; roll += 1) {
        const low = resolveDnd5eD20Test({ rolls: [roll], abilityScore: score, dc: 10 });
        const high = resolveDnd5eD20Test({ rolls: [roll], abilityScore: score, dc: 11 });
        if (high.success) expect(low.success).toBe(true);
        expect(low.total).toBe(roll + Math.floor((score - 10) / 2));
      }
    }
  });

  it("rejects absent, excess, and invalid injected dice", () => {
    expect(() => resolveDnd5eD20Test({ rolls: [], abilityScore: 10, dc: 10 })).toThrow("exactly 1");
    expect(() => resolveDnd5eD20Test({ rolls: [10], abilityScore: 10, dc: 10, advantageSources: 1 })).toThrow("exactly 2");
    expect(() => resolveDnd5eD20Test({ rolls: [21], abilityScore: 10, dc: 10 })).toThrow("between 1 and 20");
  });
});
