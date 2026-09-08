import { describe, expect, it } from "vitest";
import { restCommandSchema, restReceiptSchema } from "../src/rest.js";

describe("M1.5 rest contracts", () => {
  it("has strict short and long rest commands", () => {
    const command = { type: "take_short_rest", campaignId: "campaign", actorId: "actor", expectedRevision: 3, idempotencyKey: "rest-1" };
    expect(restCommandSchema.parse(command)).toEqual(command);
    expect(restCommandSchema.safeParse({ ...command, duration: 60 }).success).toBe(false);
    expect(restCommandSchema.parse({ ...command, hitDiceToSpend: 1 })).toMatchObject({ hitDiceToSpend: 1 });
    expect(restCommandSchema.safeParse({ ...command, hitDiceToSpend: 0 }).success).toBe(false);
    for (const hitDiceToSpend of [-1, 1.5, 129]) expect(restCommandSchema.safeParse({ ...command, hitDiceToSpend }).success).toBe(false);
    expect(restCommandSchema.safeParse({ ...command, type: "take_long_rest", hitDiceToSpend: 1 }).success).toBe(false);
    expect(restCommandSchema.safeParse({ ...command, hitDiceToSpend: 1, rolls: [10] }).success).toBe(false);
    expect(restCommandSchema.safeParse({ ...command, eligibility: "safe" }).success).toBe(false);
  });

  it("records revisioned recovery deltas", () => {
    const receipt = { restId: "rest", campaignId: "campaign", actorId: "actor", kind: "long", recoveredAt: "2030-01-01T00:00:00.000Z", recovery: { resources: [{ resourceId: "health", before: 2, after: 10 }] }, revisionBefore: 3, revisionAfter: 4, idempotencyKey: "rest-1" };
    expect(restReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(restReceiptSchema.safeParse({ ...receipt, revisionAfter: 5 }).success).toBe(false);
    expect(restReceiptSchema.safeParse({ ...receipt, eligibility: "safe" }).success).toBe(false);
    expect(restReceiptSchema.parse({ ...receipt, kind: "short", hitDice: { dieSize: 10, spent: 2, rolls: [3, 8], constitutionModifier: 2, hitPointsRecovered: 7 } })).toMatchObject({ hitDice: { rolls: [3, 8] } });
    expect(restReceiptSchema.safeParse({ ...receipt, hitDice: { dieSize: 10, spent: 2, rolls: [3], constitutionModifier: 2, hitPointsRecovered: 5 } }).success).toBe(false);
  });
});
