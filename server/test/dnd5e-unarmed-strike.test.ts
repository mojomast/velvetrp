import { describe, expect, it } from "vitest";
import { DND_5E_RULESET_DESCRIPTOR, DND_5E_UNARMED_STRIKE, resolveDnd5eAttack, resolveDnd5eDamageRoll } from "../src/rulesets/index.js";

describe("SRD 5.1 unarmed strike", () => {
  it("is a proficient melee Strength attack for one plus the Strength modifier bludgeoning", () => {
    expect(DND_5E_UNARMED_STRIKE).toMatchObject({
      attackAbility: "strength", attackType: "melee", damageType: "bludgeoning", flatDamageBonus: 1, proficient: true,
    });
    expect(DND_5E_UNARMED_STRIKE.damageDie).toEqual({ count: 0, sides: 4 });
  });

  it("adds the flat bonus once and never doubles it on a critical", () => {
    const normal = resolveDnd5eDamageRoll({ dice: [DND_5E_UNARMED_STRIKE.damageDie], rolls: [[]], modifier: DND_5E_UNARMED_STRIKE.flatDamageBonus + 3 });
    expect(normal.total).toBe(4);
    expect(normal.evidence).toEqual([expect.objectContaining({ count: 0, sides: 4, subtotal: 0 })]);
    const critical = resolveDnd5eDamageRoll({ dice: [DND_5E_UNARMED_STRIKE.damageDie], rolls: [[]], modifier: DND_5E_UNARMED_STRIKE.flatDamageBonus + 3, critical: true });
    expect(critical.total).toBe(4);
    expect(critical.critical).toBe(true);
  });

  it("resolves against AC with the shared critical and natural-1 rules", () => {
    const hit = resolveDnd5eAttack({ rolls: [10], abilityScore: 16, proficiencyBonus: 2, armorClass: 13 });
    expect(hit.hit).toBe(true);
    expect(hit.total).toBe(15);
    const miss = resolveDnd5eAttack({ rolls: [1], abilityScore: 16, proficiencyBonus: 2, armorClass: 5 });
    expect(miss.hit).toBe(false);
    expect(miss.automaticMiss).toBe(true);
  });

  it("advertises the unarmed extension through the attacks capability", () => {
    const attacks = DND_5E_RULESET_DESCRIPTOR.capabilities?.find(capability => capability.id === "attacks");
    expect(attacks).toEqual({ id: "attacks", version: "1.5.0", status: "supported" });
  });
});
