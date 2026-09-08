import { describe, expect, it } from "vitest";
import { combatReactionAvailabilitySchema, opportunityAttackReactionSchema } from "../src/index.js";

describe("opportunity reaction contracts", () => {
  it("requires an explicit inverse availability state", () => {
    expect(combatReactionAvailabilitySchema.parse({ combatantId: "reactor", round: 1, available: true, used: false }).available).toBe(true);
    expect(combatReactionAvailabilitySchema.safeParse({ combatantId: "reactor", round: 1, available: true, used: true }).success).toBe(false);
  });

  it("closes the automatic departure trigger vocabulary", () => {
    expect(opportunityAttackReactionSchema.parse({ reactionId: "reaction-1", reactorCombatantId: "reactor", targetCombatantId: "mover", round: 1, trigger: "left-reach" }).trigger).toBe("left-reach");
    expect(opportunityAttackReactionSchema.safeParse({ reactionId: "reaction-1", reactorCombatantId: "reactor", targetCombatantId: "mover", round: 1, trigger: "moved" }).success).toBe(false);
  });
});
