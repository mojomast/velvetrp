import { describe, expect, it } from "vitest";
import { campaignHistoryHttpPublicReceiptSchema } from "../src/campaign-history-http.js";

const completed = {
  kind: "journey" as const, status: "completed" as const, origin: "Old Gate", destination: "Silver Harbor",
  currentLocation: "Silver Harbor", legs: 2, elapsedMinutes: 120, interruption: null,
  revisionBefore: 0, revisionAfter: 2, occurredAt: "2030-01-01T00:00:00.000Z",
};
const interrupted = {
  kind: "journey" as const, status: "interrupted" as const, origin: "Old Gate", destination: "Silver Harbor",
  currentLocation: "Waystation", legs: 1, elapsedMinutes: 60,
  interruption: { kind: "weather" as const, summary: "A cold squall crosses the route." },
  revisionBefore: 0, revisionAfter: 1, occurredAt: "2030-01-01T00:00:00.000Z",
};

describe("public journey receipt", () => {
  it("accepts completed and interrupted journeys with only public fields", () => {
    expect(campaignHistoryHttpPublicReceiptSchema.parse(completed)).toEqual(completed);
    expect(campaignHistoryHttpPublicReceiptSchema.parse(interrupted)).toEqual(interrupted);
  });

  it("rejects internal identities, path bindings, and raw rolls", () => {
    for (const key of ["commandId", "campaignId", "journeyId", "originLocationId", "requestedDestinationLocationId",
      "currentLocationId", "path", "eventChecks", "triggerRoll", "eventRoll", "weight", "principalId", "digest"]) {
      expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...completed, [key]: "private" }).success).toBe(false);
      expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...interrupted, [key]: "private" }).success).toBe(false);
    }
  });

  it("bounds legs, elapsed time, and interruption shape", () => {
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...completed, legs: 33, revisionAfter: 33 }).success).toBe(false);
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...completed, legs: -1 }).success).toBe(false);
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...completed, elapsedMinutes: -1 }).success).toBe(false);
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...interrupted, interruption: { kind: "magic", summary: "x" } }).success).toBe(false);
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...interrupted, interruption: { kind: "weather", summary: "" } }).success).toBe(false);
  });

  it("keeps status and interruption consistent and advances once per leg", () => {
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...completed, interruption: { kind: "weather", summary: "x" } }).success).toBe(false);
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...interrupted, interruption: null }).success).toBe(false);
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...completed, revisionAfter: 3 }).success).toBe(false);
  });
});
