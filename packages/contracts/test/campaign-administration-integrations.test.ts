import { describe, expect, it } from "vitest";
import { safetyActionCommandSchema, sessionZeroSafetyUpdateCommandSchema, shopBuyPolicyCommandSchema } from "../src/index.js";

describe("campaign administration integration contracts", () => {
  it("requires explicit confirmation and revision/idempotency binding for safety actions", () => {
    expect(safetyActionCommandSchema.safeParse({ action: "pause", confirmed: false, expectedRevision: 2, idempotencyKey: "pause-1" }).success).toBe(false);
    expect(safetyActionCommandSchema.parse({ action: "rewind", confirmed: true, expectedRevision: 2, idempotencyKey: "rewind-1" }).action).toBe("rewind");
  });

  it("bounds safety text and permits zero only as the explicit no-paid-buy policy", () => {
    expect(sessionZeroSafetyUpdateCommandSchema.safeParse({ hardLimits: ["x".repeat(201)], veils: [], pvpPolicy: "disallowed",
      romancePolicy: "disallowed", lethalityPolicy: "nonlethal-default", expectedRevision: 0, idempotencyKey: "safety-1" }).success).toBe(false);
    expect(shopBuyPolicyCommandSchema.parse({ shopId: "shop", stockId: "stock", payoutUnitMinor: 0, expectedRevision: 0,
      idempotencyKey: "policy-1" }).payoutUnitMinor).toBe(0);
  });
});
