import { describe, expect, it } from "vitest";
import {
  campaignAdministrationHttpPatchRequestSchema,
  campaignAdministrationHttpResponseSchema,
} from "../src/campaign-administration-http.js";

describe("campaign administration HTTP contracts", () => {
  it("keeps patch input strict and non-empty", () => {
    expect(campaignAdministrationHttpPatchRequestSchema.safeParse({ expectedRevision: 1, idempotencyKey: "key" }).success).toBe(false);
    expect(campaignAdministrationHttpPatchRequestSchema.safeParse({ expectedRevision: 1, idempotencyKey: "key", status: "published", extra: true }).success).toBe(false);
  });
  it("accepts the role-discriminated administration projection", () => {
    expect(campaignAdministrationHttpResponseSchema.parse({
      id: "campaign", actorRole: "owner", status: "draft", activeTimelineId: "timeline", revision: 0,
      updatedAt: "2030-01-01T00:00:00.000Z",
      settings: { maxPlayers: 4, allowPlayerDice: true, safetyMode: "standard", recapVisibility: "members", gmNotes: "private" },
    }).actorRole).toBe("owner");
  });
});
