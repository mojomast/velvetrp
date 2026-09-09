import { describe, expect, it } from "vitest";
import {
  campaignStartingLocationDesignationRequestSchema,
  campaignStartingLocationDesignationResponseSchema,
  campaignStartingLocationReadResponseSchema,
} from "../src/index.js";

const at = "2035-01-01T00:00:00.000Z";

describe("campaign starting location HTTP contracts", () => {
  it("accepts only a location, campaign revision, and idempotency key", () => {
    const request = { locationId: "harbor", expectedRevision: 3, idempotencyKey: "designate-harbor" };
    expect(campaignStartingLocationDesignationRequestSchema.parse(request)).toEqual(request);
    for (const field of ["campaignId", "principalId", "role", "actorId", "moveActors"]) {
      expect(campaignStartingLocationDesignationRequestSchema.safeParse({ ...request, [field]: "forbidden" }).success).toBe(false);
    }
  });

  it("represents an authoritative named designation or null", () => {
    expect(campaignStartingLocationReadResponseSchema.parse({ campaignId: "campaign", revision: 3, startingLocation: null }))
      .toEqual({ campaignId: "campaign", revision: 3, startingLocation: null });
    const response = { campaignId: "campaign", revision: 4,
      startingLocation: { locationId: "harbor", name: "Rain Harbor", designatedAt: at },
      receipt: { commandId: "command", idempotencyKey: "designate-harbor", revisionBefore: 3, revisionAfter: 4, occurredAt: at } };
    expect(campaignStartingLocationDesignationResponseSchema.parse(response)).toEqual(response);
    expect(campaignStartingLocationDesignationResponseSchema.safeParse({ ...response, revision: 3 }).success).toBe(false);
  });
});
