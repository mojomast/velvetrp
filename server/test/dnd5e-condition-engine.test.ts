import { describe, expect, it } from "vitest";
import {
  DND_5E_CONDITIONS, DND_5E_PERSISTED_CONDITIONS, deriveDnd5eConditionEffects, deriveDnd5eExhaustionEffects,
  deriveDnd5eFrightenedEffects, isDnd5eExhaustionFatal, planDnd5eAttackConditions,
} from "../src/rulesets/dnd5e.js";
import { DND_5E_RULESET_DESCRIPTOR } from "../src/rulesets/index.js";
import {
  actionBlockingConditions, combatConditionNames, movementDenialConditions, saveAutoFailConditions,
} from "../src/repo/encounter/combatConditionRuntime.js";

const SRD_5_1_CONDITIONS = [
  "blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled", "incapacitated",
  "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious",
];

describe("SRD 5.1 condition engine", () => {
  it("represents all fifteen conditions and persists the fourteen closed conditions", () => {
    expect(DND_5E_CONDITIONS).toHaveLength(15);
    expect(new Set(DND_5E_CONDITIONS).size).toBe(15);
    expect([...DND_5E_CONDITIONS].sort()).toEqual([...SRD_5_1_CONDITIONS].sort());
    expect([...DND_5E_PERSISTED_CONDITIONS].sort()).toEqual(SRD_5_1_CONDITIONS.filter((condition) => condition !== "exhaustion").sort());
    expect([...combatConditionNames].sort()).toEqual([...DND_5E_PERSISTED_CONDITIONS].sort());
  });

  it("automates invisible, paralyzed, and petrified attack interactions", () => {
    expect(planDnd5eAttackConditions({ attacker: ["invisible"], target: [], kind: "melee" }))
      .toEqual({ mode: "advantage", autoCritical: false });
    expect(planDnd5eAttackConditions({ attacker: [], target: ["invisible"], kind: "melee" }))
      .toEqual({ mode: "disadvantage", autoCritical: false });
    expect(planDnd5eAttackConditions({ attacker: [], target: ["paralyzed"], kind: "melee" }))
      .toEqual({ mode: "advantage", autoCritical: true });
    expect(planDnd5eAttackConditions({ attacker: [], target: ["petrified"], kind: "melee" }))
      .toEqual({ mode: "advantage", autoCritical: true });
    expect(planDnd5eAttackConditions({ attacker: [], target: ["paralyzed"], kind: "ranged" }))
      .toEqual({ mode: "advantage", autoCritical: false });
  });

  it("denies actions and reactions for the five incapacitating conditions", () => {
    for (const condition of ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious"] as const) {
      const effects = deriveDnd5eConditionEffects([condition]);
      expect(effects.actionsDenied, condition).toBe(true);
      expect(effects.reactionsDenied, condition).toBe(true);
    }
    expect(deriveDnd5eConditionEffects(["charmed"]).actionsDenied).toBe(false);
    expect(deriveDnd5eConditionEffects([]).reactionsDenied).toBe(false);
  });

  it("denies movement for the six speed-zeroing conditions", () => {
    for (const condition of ["grappled", "paralyzed", "petrified", "restrained", "stunned", "unconscious"] as const) {
      expect(deriveDnd5eConditionEffects([condition]).speedZero, condition).toBe(true);
    }
    expect(deriveDnd5eConditionEffects(["blinded"]).speedZero).toBe(false);
  });

  it("auto-fails Strength and Dexterity saves while paralyzed or petrified", () => {
    for (const condition of ["paralyzed", "petrified"] as const) {
      const effects = deriveDnd5eConditionEffects([condition]);
      expect(effects.strengthSaveAutoFail, condition).toBe(true);
      expect(effects.dexteritySaveAutoFail, condition).toBe(true);
    }
    expect(deriveDnd5eConditionEffects(["stunned"]).strengthSaveAutoFail).toBe(false);
    expect(deriveDnd5eConditionEffects(["restrained"]).dexteritySaveAutoFail).toBe(false);
  });

  it("models frightened line of sight and poisoned roll hindrance", () => {
    expect(deriveDnd5eFrightenedEffects({ frightened: true, sourceInLineOfSight: true }))
      .toEqual({ abilityCheckDisadvantage: true, attackRollDisadvantage: true, canApproachSource: false });
    expect(deriveDnd5eFrightenedEffects({ frightened: true, sourceInLineOfSight: false }))
      .toEqual({ abilityCheckDisadvantage: false, attackRollDisadvantage: false, canApproachSource: false });
    expect(deriveDnd5eFrightenedEffects({ frightened: false, sourceInLineOfSight: true }))
      .toEqual({ abilityCheckDisadvantage: false, attackRollDisadvantage: false, canApproachSource: true });
    expect(deriveDnd5eConditionEffects(["poisoned"]))
      .toMatchObject({ abilityCheckDisadvantage: true, attackRollDisadvantage: true });
    expect(deriveDnd5eConditionEffects(["frightened"]))
      .toMatchObject({ abilityCheckDisadvantage: true, attackRollDisadvantage: true });
  });

  it("grants petrified all-damage resistance and unawareness", () => {
    expect(deriveDnd5eConditionEffects(["petrified"]))
      .toMatchObject({ damageResistance: true, unawareOfSurroundings: true });
    expect(deriveDnd5eConditionEffects(["restrained"]))
      .toMatchObject({ damageResistance: false, unawareOfSurroundings: false });
  });

  it("completes the six exhaustion levels and level-six death", () => {
    expect(deriveDnd5eExhaustionEffects(6)).toEqual({ level: 6, checkDisadvantage: true, speedMultiplier: 0, attackDisadvantage: true, saveDisadvantage: true, hitPointMaximumMultiplier: 0.5 });
    expect(deriveDnd5eExhaustionEffects(1)).toMatchObject({ checkDisadvantage: true, speedMultiplier: 1, attackDisadvantage: false });
    expect(deriveDnd5eExhaustionEffects(2)).toMatchObject({ speedMultiplier: 0.5 });
    expect(deriveDnd5eExhaustionEffects(3)).toMatchObject({ attackDisadvantage: true, saveDisadvantage: true });
    expect(deriveDnd5eExhaustionEffects(4)).toMatchObject({ hitPointMaximumMultiplier: 0.5 });
    expect(deriveDnd5eExhaustionEffects(5)).toMatchObject({ speedMultiplier: 0 });
    expect(isDnd5eExhaustionFatal(5)).toBe(false);
    expect(isDnd5eExhaustionFatal(6)).toBe(true);
    expect(() => isDnd5eExhaustionFatal(7)).toThrow();
  });

  it("exposes the runtime denial sets for the new conditions", () => {
    for (const condition of ["paralyzed", "petrified"] as const) {
      expect(actionBlockingConditions.has(condition), condition).toBe(true);
      expect(saveAutoFailConditions.has(condition), condition).toBe(true);
    }
    for (const condition of ["grappled", "paralyzed", "petrified", "restrained", "stunned", "unconscious"] as const) {
      expect(movementDenialConditions.has(condition), condition).toBe(true);
    }
  });

  it("advertises the expanded condition engine as conditions@1.2.0", () => {
    expect(DND_5E_RULESET_DESCRIPTOR.capabilities?.find((capability) => capability.id === "conditions"))
      .toEqual({ id: "conditions", version: "1.2.0", status: "partial" });
  });
});
