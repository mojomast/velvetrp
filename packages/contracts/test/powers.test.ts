import { describe, expect, expectTypeOf, it } from "vitest";
import { powerCostSchema, powerUseCommandSchema, type PowerCost } from "../src/powers.js";

const command = {
  type: "use_power", campaignId: "campaign", actorId: "actor", power: { kind: "spell", packId: "starter", packVersion: "1", definitionId: "firebolt" }, targetActorId: null,
  costs: [{ kind: "resource", resourceId: "mana", amount: 2 }, { kind: "slot", slotId: "first", amount: 1 }, { kind: "charge", chargeId: "wand", amount: 1 }],
  expectedRevision: 2, idempotencyKey: "power-2", usedAt: "2026-08-05T12:00:00.000Z",
} as const;

describe("M1.6 power contracts", () => {
  it("accepts only typed resource, slot, and charge costs", () => {
    expect(powerUseCommandSchema.parse(command)).toEqual(command);
    for (const invalid of [
      { kind: "resource", resourceId: "mana", amount: 0 }, { kind: "spell", resourceId: "mana", amount: 1 },
      { kind: "slot", slotId: "first", amount: 1, formula: "level" },
    ]) expect(powerCostSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects duplicate bindings, non-mutation fields, and weak concurrency values", () => {
    expect(powerUseCommandSchema.safeParse({ ...command, costs: [command.costs[0], command.costs[0]] }).success).toBe(false);
    expect(powerUseCommandSchema.safeParse({ ...command, expectedRevision: -1 }).success).toBe(false);
    expect(powerUseCommandSchema.safeParse({ ...command, idempotencyKey: "", script: "spend()" }).success).toBe(false);
  });

  it("requires an exact ability or spell catalog reference, never an invented power kind", () => {
    expect(powerUseCommandSchema.safeParse({ ...command, power: { kind: "power", packId: "starter", packVersion: "1", definitionId: "firebolt" } }).success).toBe(false);
    expect(powerUseCommandSchema.safeParse({ ...command, power: { kind: "ability", packId: "starter", packVersion: "1", definitionId: "ward" } }).success).toBe(true);
  });

  it("publishes a discriminated cost union", () => {
    expectTypeOf<PowerCost["kind"]>().toEqualTypeOf<"resource" | "slot" | "charge">();
  });
});
