import { describe, expect, it } from "vitest";
import { combatActionResolutionSchema, legalCombatActionSchema } from "../src/index.js";

describe("bounded ranged combat contracts", () => {
  it("accepts isolated thrown attack evidence without ammunition facts", () => {
    const resolution = {
      actionId: "action", legalActionId: "attack:thrown:dagger", kind: "attack", actingCombatantId: "actor", targetIds: ["enemy"],
      roundBefore: 1, roundAfter: 1, currentCombatantBefore: "actor", currentCombatantAfter: "actor",
      outcomes: [{ kind: "damage", targetId: "enemy", damageType: "piercing", requested: 4, applied: 4, hitPointsBefore: 10, hitPointsAfter: 6,
        statusBefore: "active", statusAfter: "active", attackAbility: "dexterity", attackModifier: 3, rangeFeet: 20, normalRangeFeet: 20,
        longRangeFeet: 60, disadvantage: false, thrownItemEntryId: "dagger-stack", thrownItemBefore: 2, thrownItemAfter: 1,
        targetEvidence: [{ targetCombatantId: "enemy", lineOfEffect: "clear", cover: "none", blockedBy: [] }] }],
    };
    expect(combatActionResolutionSchema.parse(resolution).outcomes[0]).toMatchObject({ thrownItemAfter: 1 });
  });

  it("accepts server-derived ranged attack facts", () => {
    expect(legalCombatActionSchema.parse({ kind: "attack", attackId: "attack:ranged:shortbow", attackType: "ranged", targetCombatantIds: ["enemy"] })).toMatchObject({ attackType: "ranged" });
    const resolution = {
      actionId: "action", legalActionId: "attack:ranged:shortbow", kind: "attack", actingCombatantId: "actor", targetIds: ["enemy"],
      roundBefore: 1, roundAfter: 1, currentCombatantBefore: "actor", currentCombatantAfter: "actor",
      outcomes: [{ kind: "damage", targetId: "enemy", damageType: "piercing", requested: 5, applied: 5, hitPointsBefore: 10, hitPointsAfter: 5,
        statusBefore: "active", statusAfter: "active", attackAbility: "dexterity", attackModifier: 3, rangeFeet: 60, normalRangeFeet: 80,
        longRangeFeet: 320, disadvantage: false, ammunitionResourceId: "arrows", ammunitionBefore: 2, ammunitionAfter: 1 }],
    };
    expect(combatActionResolutionSchema.parse(resolution).outcomes[0]).toMatchObject({ attackAbility: "dexterity", ammunitionAfter: 1 });
  });

  it("rejects malformed ranged facts", () => {
    expect(legalCombatActionSchema.safeParse({ kind: "attack", attackId: "attack:ranged:x", attackType: "ranged", targetCombatantIds: [] }).success).toBe(false);
  });
});
