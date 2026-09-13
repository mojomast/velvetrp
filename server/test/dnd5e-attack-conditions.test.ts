import { describe, expect, it } from "vitest";
import { DND_5E_RULESET_DESCRIPTOR, planDnd5eAttackConditions, type ConditionId } from "../src/rulesets/index.js";

const plan = (attacker: ConditionId[], target: ConditionId[], kind: "melee" | "ranged" | "thrown" = "melee", longRange = false) =>
  planDnd5eAttackConditions({ attacker, target, kind, longRange });

describe("SRD 5.1 condition attack effects", () => {
  it("keeps an unhindered attack normal", () => {
    expect(plan([], [])).toEqual({ mode: "normal", autoCritical: false });
  });

  it("imposes disadvantage on a hindered attacker", () => {
    for (const condition of ["blinded", "poisoned", "prone", "restrained"] as const) {
      expect(plan([condition], [])).toMatchObject({ mode: "disadvantage" });
    }
    expect(plan([], [], "ranged", true)).toMatchObject({ mode: "disadvantage" });
  });

  it("grants advantage against an open target", () => {
    for (const condition of ["blinded", "restrained", "stunned", "unconscious"] as const) {
      expect(plan([], [condition])).toMatchObject({ mode: "advantage" });
    }
  });

  it("treats a prone target as melee advantage but ranged disadvantage", () => {
    expect(plan([], ["prone"], "melee")).toMatchObject({ mode: "advantage" });
    expect(plan([], ["prone"], "ranged")).toMatchObject({ mode: "disadvantage" });
  });

  it("grants advantage for a help or hidden benefit that cancels against hindrance", () => {
    expect(plan([], [], "melee")).toMatchObject({ mode: "normal" });
    expect(planDnd5eAttackConditions({ attacker: [], target: [], kind: "melee", attackerBenefit: true })).toMatchObject({ mode: "advantage" });
    expect(planDnd5eAttackConditions({ attacker: ["prone"], target: [], kind: "melee", attackerBenefit: true })).toMatchObject({ mode: "normal" });
  });

  it("cancels advantage and disadvantage from any source", () => {
    expect(plan(["blinded"], ["restrained"])).toEqual({ mode: "normal", autoCritical: false });
    expect(plan(["prone"], ["prone"], "melee")).toEqual({ mode: "normal", autoCritical: false });
  });

  it("auto-crits a melee hit against an unconscious, paralyzed, or petrified target only", () => {
    for (const condition of ["unconscious", "paralyzed", "petrified"] as const) {
      expect(plan([], [condition], "melee")).toMatchObject({ autoCritical: true });
      expect(plan([], [condition], "ranged")).toMatchObject({ autoCritical: false });
    }
    expect(plan([], ["restrained"], "melee")).toMatchObject({ autoCritical: false });
  });

  it("advertises the expanded condition effects as conditions@1.1.0", () => {
    const conditions = DND_5E_RULESET_DESCRIPTOR.capabilities?.find(capability => capability.id === "conditions");
    expect(conditions).toEqual({ id: "conditions", version: "1.1.0", status: "partial" });
  });
});
