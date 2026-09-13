import { describe, expect, it } from "vitest";
import { DND_5E_RULESET_DESCRIPTOR, deriveDnd5eExhaustionEffects, planDnd5eAttackConditions } from "../src/rulesets/index.js";

describe("SRD 5.1 exhaustion", () => {
  it("maps each level to its mechanical effects", () => {
    expect(deriveDnd5eExhaustionEffects(0)).toEqual({ level: 0, checkDisadvantage: false, speedMultiplier: 1, attackDisadvantage: false, saveDisadvantage: false, hitPointMaximumMultiplier: 1 });
    expect(deriveDnd5eExhaustionEffects(1)).toMatchObject({ checkDisadvantage: true, speedMultiplier: 1, attackDisadvantage: false });
    expect(deriveDnd5eExhaustionEffects(2)).toMatchObject({ speedMultiplier: 0.5, attackDisadvantage: false });
    expect(deriveDnd5eExhaustionEffects(3)).toMatchObject({ speedMultiplier: 0.5, attackDisadvantage: true, saveDisadvantage: true });
    expect(deriveDnd5eExhaustionEffects(4)).toMatchObject({ hitPointMaximumMultiplier: 0.5 });
    expect(deriveDnd5eExhaustionEffects(5)).toMatchObject({ speedMultiplier: 0 });
    expect(deriveDnd5eExhaustionEffects(6)).toMatchObject({ speedMultiplier: 0, hitPointMaximumMultiplier: 0.5 });
  });

  it("rejects out-of-range levels", () => {
    expect(() => deriveDnd5eExhaustionEffects(-1)).toThrow();
    expect(() => deriveDnd5eExhaustionEffects(7)).toThrow();
    expect(() => deriveDnd5eExhaustionEffects(1.5)).toThrow();
  });

  it("imposes attack disadvantage from level 3 and cancels against target advantage", () => {
    expect(planDnd5eAttackConditions({ attacker: [], target: [], kind: "melee", attackerExhaustion: 2 })).toMatchObject({ mode: "normal" });
    expect(planDnd5eAttackConditions({ attacker: [], target: [], kind: "melee", attackerExhaustion: 3 })).toMatchObject({ mode: "disadvantage" });
    expect(planDnd5eAttackConditions({ attacker: [], target: ["restrained"], kind: "melee", attackerExhaustion: 4 })).toMatchObject({ mode: "normal" });
  });

  it("advertises exhaustion as exhaustion@1.0.0 partial", () => {
    expect(DND_5E_RULESET_DESCRIPTOR.capabilities?.find(capability => capability.id === "exhaustion"))
      .toEqual({ id: "exhaustion", version: "1.0.0", status: "partial" });
  });
});
