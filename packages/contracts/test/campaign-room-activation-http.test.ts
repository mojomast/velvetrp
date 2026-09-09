import { describe, expect, it } from "vitest";
import { campaignRoomActivationReadinessSchema, campaignRoomActivationRequestSchema } from "../src/index.js";

describe("campaign room activation contracts", () => {
  it("accepts only revision and idempotency, never caller authority or placement", () => {
    const input = { expectedRevision: 0, idempotencyKey: "start-room" };
    expect(campaignRoomActivationRequestSchema.parse(input)).toEqual(input);
    for (const field of ["principalId", "role", "actorId", "locationId", "sessionId", "consent"]) {
      expect(campaignRoomActivationRequestSchema.safeParse({ ...input, [field]: "owner" }).success).toBe(false);
    }
    expect(campaignRoomActivationRequestSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false);
  });
  it("requires readiness to agree with its bounded blockers", () => {
    const state = { campaignId: "campaign", sessionId: "room", expectedRevision: 0, active: false,
      ready: false, blockers: ["starting-location-required"], actorIds: ["actor"] };
    expect(campaignRoomActivationReadinessSchema.parse(state)).toEqual(state);
    expect(campaignRoomActivationReadinessSchema.safeParse({ ...state, ready: true }).success).toBe(false);
    expect(campaignRoomActivationReadinessSchema.safeParse({ ...state, blockers: ["private-note"] }).success).toBe(false);
  });
});
