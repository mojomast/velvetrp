import { describe, expect, it } from "vitest";
import {
  DND_5E_UNDERWATER_MELEE_EXCEPTIONS,
  DND_5E_UNDERWATER_RANGED_EXCEPTIONS,
  dnd5eUnderwaterDamageAdjustment,
  mountedMeleeAdvantage,
  planDnd5eMount,
  planDnd5eUnderwaterAttack,
  resolveDnd5eMountForcedMovement,
  resolveDnd5eMountKnockdown,
} from "../src/rulesets/dnd5e/specialCombat.js";
import { planDnd5eAttackConditions } from "../src/rulesets/dnd5e/attack.js";

describe("SRD 5.1 mounting", () => {
  it("requires a willing, larger, suitably shaped mount and costs half your speed", () => {
    expect(planDnd5eMount({ riderSize: "medium", mountSize: "large", willing: true, trained: true, suitableAnatomy: true, speed: 30 }))
      .toMatchObject({ legal: true, costFeet: 15, controlled: true, reasons: [] });
    const tooSmall = planDnd5eMount({ riderSize: "medium", mountSize: "medium", willing: true, trained: true, suitableAnatomy: true, speed: 30 });
    expect(tooSmall.legal).toBe(false);
    expect(tooSmall.reasons).toContain("a mount must be at least one size larger than the rider");
    expect(planDnd5eMount({ riderSize: "medium", mountSize: "large", willing: false, trained: true, suitableAnatomy: true, speed: 30 }).legal).toBe(false);
    expect(planDnd5eMount({ riderSize: "medium", mountSize: "large", willing: true, trained: true, suitableAnatomy: false, speed: 30 }).legal).toBe(false);
  });

  it("marks an untrained mount as independent", () => {
    expect(planDnd5eMount({ riderSize: "small", mountSize: "large", willing: true, trained: false, suitableAnatomy: true, speed: 40 }))
      .toMatchObject({ legal: true, costFeet: 20, controlled: false });
  });
});

describe("SRD 5.1 mounted melee advantage", () => {
  it("only applies against an unmounted creature smaller than the mount", () => {
    expect(mountedMeleeAdvantage({ attackerMounted: true, targetMounted: false, targetSize: "medium", mountSize: "large" })).toBe(true);
    expect(mountedMeleeAdvantage({ attackerMounted: true, targetMounted: true, targetSize: "medium", mountSize: "large" })).toBe(false);
    expect(mountedMeleeAdvantage({ attackerMounted: true, targetMounted: false, targetSize: "large", mountSize: "large" })).toBe(false);
    expect(mountedMeleeAdvantage({ attackerMounted: false, targetMounted: false, targetSize: "small", mountSize: "large" })).toBe(false);
  });
});

describe("SRD 5.1 forced dismount", () => {
  it("resolves the DC 10 Dexterity save and dismounts prone on failure", () => {
    const success = resolveDnd5eMountForcedMovement({ dexterityScore: 14, roll: 8 });
    expect(success).toMatchObject({ dc: 10, total: 10, success: true, dismounted: false, landedProne: false });
    const failure = resolveDnd5eMountForcedMovement({ dexterityScore: 10, roll: 5 });
    expect(failure).toMatchObject({ dc: 10, total: 5, success: false, dismounted: true, landedProne: true });
    expect(() => resolveDnd5eMountForcedMovement({ dexterityScore: 10, roll: 21 })).toThrow();
  });

  it("lets a rider land on its feet when it spends its reaction as the mount falls", () => {
    expect(resolveDnd5eMountKnockdown({ reactionAvailable: true })).toEqual({ usedReaction: true, mounted: false, landedProne: false });
    expect(resolveDnd5eMountKnockdown({ reactionAvailable: false })).toEqual({ usedReaction: false, mounted: false, landedProne: true });
  });
});

describe("SRD 5.1 underwater combat", () => {
  it("exempts a swim speed from every underwater penalty", () => {
    expect(planDnd5eUnderwaterAttack({ kind: "melee", hasSwimSpeed: true, weapon: "longsword" })).toMatchObject({ disadvantage: false, automaticMiss: false });
    expect(planDnd5eUnderwaterAttack({ kind: "ranged", hasSwimSpeed: true, weapon: "longbow", beyondNormalRange: true })).toMatchObject({ disadvantage: false, automaticMiss: false });
  });

  it("applies melee disadvantage without a swim speed unless the weapon is exempt", () => {
    expect(planDnd5eUnderwaterAttack({ kind: "melee", hasSwimSpeed: false, weapon: "longsword" }).disadvantage).toBe(true);
    for (const weapon of DND_5E_UNDERWATER_MELEE_EXCEPTIONS) {
      expect(planDnd5eUnderwaterAttack({ kind: "melee", hasSwimSpeed: false, weapon }).disadvantage, weapon).toBe(false);
    }
  });

  it("auto-misses a ranged attack beyond normal range and otherwise penalizes non-exempt weapons", () => {
    expect(planDnd5eUnderwaterAttack({ kind: "ranged", hasSwimSpeed: false, weapon: "longbow", beyondNormalRange: true }))
      .toMatchObject({ automaticMiss: true, disadvantage: false });
    expect(planDnd5eUnderwaterAttack({ kind: "ranged", hasSwimSpeed: false, weapon: "longbow" }).disadvantage).toBe(true);
    for (const weapon of DND_5E_UNDERWATER_RANGED_EXCEPTIONS) {
      expect(planDnd5eUnderwaterAttack({ kind: "ranged", hasSwimSpeed: false, weapon }).disadvantage, weapon).toBe(false);
    }
  });

  it("grants fire resistance while fully immersed", () => {
    expect(dnd5eUnderwaterDamageAdjustment("fire", true)).toBe("resistance");
    expect(dnd5eUnderwaterDamageAdjustment("fire", false)).toBe("none");
    expect(dnd5eUnderwaterDamageAdjustment("cold", true)).toBe("none");
  });
});

describe("SRD 5.1 special combat folds into attack conditions", () => {
  const base = { attacker: [], target: [], kind: "melee" } as const;
  it("applies underwater disadvantage and mounted advantage", () => {
    expect(planDnd5eAttackConditions({ ...base, underwaterDisadvantage: true }).mode).toBe("disadvantage");
    expect(planDnd5eAttackConditions({ ...base, mountedAdvantage: true }).mode).toBe("advantage");
    expect(planDnd5eAttackConditions({ ...base, mountedAdvantage: true, underwaterDisadvantage: true }).mode).toBe("normal");
  });
});
