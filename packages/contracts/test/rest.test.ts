import { describe, expect, it } from "vitest";
import { restCommandSchema, restReceiptSchema } from "../src/rest.js";

describe("M1.5 rest contracts", () => {
  it("has strict short and long rest commands", () => {
    const command = { type: "take_short_rest", campaignId: "campaign", actorId: "actor", expectedRevision: 3, idempotencyKey: "rest-1" };
    expect(restCommandSchema.parse(command)).toEqual(command);
    expect(restCommandSchema.safeParse({ ...command, duration: 60 }).success).toBe(false);
  });

  it("records revisioned recovery deltas", () => {
    const receipt = { restId: "rest", campaignId: "campaign", actorId: "actor", kind: "long", recoveredAt: "2030-01-01T00:00:00.000Z", recovery: { resources: [{ resourceId: "health", before: 2, after: 10 }] }, revisionBefore: 3, revisionAfter: 4, idempotencyKey: "rest-1" };
    expect(restReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(restReceiptSchema.safeParse({ ...receipt, revisionAfter: 5 }).success).toBe(false);
  });
});
