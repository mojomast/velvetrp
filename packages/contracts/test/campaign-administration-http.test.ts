import { describe, expect, it } from "vitest";
import {
  campaignAdministrationHttpArchiveRequestSchema,
  campaignAdministrationHttpArchiveResponseSchema,
  campaignAdministrationHttpGetResponseSchema,
  campaignAdministrationHttpMembershipCreateRequestSchema,
  campaignAdministrationHttpMembershipDeleteRequestSchema,
  campaignAdministrationHttpMembershipListResponseSchema,
  campaignAdministrationHttpMembershipMutationResponseSchema,
  campaignAdministrationHttpMembershipUpdateRequestSchema,
  campaignAdministrationHttpPatchRequestSchema,
  campaignAdministrationHttpPatchResponseSchema,
  campaignAdministrationHttpRoomDetachRequestSchema,
  campaignAdministrationHttpRoomDetachResponseSchema,
} from "../src/campaign-administration-http.js";

describe("campaign administration HTTP contracts", () => {
  it("keeps patch input strict and non-empty", () => {
    expect(campaignAdministrationHttpPatchRequestSchema.safeParse({ expectedRevision: 1, idempotencyKey: "key" }).success).toBe(false);
    expect(campaignAdministrationHttpPatchRequestSchema.safeParse({ expectedRevision: 1, idempotencyKey: "key", status: "published", extra: true }).success).toBe(false);
  });
  const campaign = {
    id: "campaign", actorRole: "owner" as const, status: "draft" as const, activeTimelineId: "timeline", revision: 0,
    updatedAt: "2030-01-01T00:00:00.000Z",
    settings: { maxPlayers: 4, allowPlayerDice: true, safetyMode: "standard" as const, recapVisibility: "members" as const, gmNotes: "private" },
  };
  const receipt = {
    commandId: "command", campaignId: "campaign", type: "administration_updated" as const,
    revisionBefore: 0, revisionAfter: 1, occurredAt: "2030-01-01T00:00:00.000Z",
    events: [{ eventId: "event", commandId: "command", campaignId: "campaign", type: "administration_updated" as const,
      revision: 1, occurredAt: "2030-01-01T00:00:00.000Z", data: {} }],
  };

  it("uses a campaign envelope for GET", () => {
    expect(campaignAdministrationHttpGetResponseSchema.parse({ campaign }).campaign.actorRole).toBe("owner");
    expect(campaignAdministrationHttpGetResponseSchema.safeParse(campaign).success).toBe(false);
  });

  it("uses campaign and receipt envelopes for PATCH and DELETE", () => {
    const response = { campaign, receipt };
    expect(campaignAdministrationHttpPatchResponseSchema.parse(response)).toEqual(response);
    expect(campaignAdministrationHttpArchiveResponseSchema.parse(response)).toEqual(response);
    expect(campaignAdministrationHttpPatchResponseSchema.safeParse({ campaign, receipt, extra: true }).success).toBe(false);
  });

  it("requires an exact archive confirmation request", () => {
    const request = { expectedRevision: 0, idempotencyKey: "archive-1", confirmationName: "Campaign Name" };
    expect(campaignAdministrationHttpArchiveRequestSchema.parse(request)).toEqual(request);
    expect(campaignAdministrationHttpArchiveRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);
    expect(campaignAdministrationHttpArchiveRequestSchema.safeParse({ expectedRevision: 0, idempotencyKey: "archive-1" }).success).toBe(false);
  });

  it("uses strict route-owned membership requests and public projections", () => {
    const membership = { principalId: "member", role: "player" as const, createdAt: "2030-01-01T00:00:00.000Z" };
    const create = { principalId: "member", role: "player" as const, expectedRevision: 0, idempotencyKey: "member-add" };
    const update = { role: "gm" as const, expectedRevision: 0, idempotencyKey: "member-change" };
    const remove = { expectedRevision: 0, idempotencyKey: "member-remove" };

    expect(campaignAdministrationHttpMembershipCreateRequestSchema.parse(create)).toEqual(create);
    expect(campaignAdministrationHttpMembershipUpdateRequestSchema.parse(update)).toEqual(update);
    expect(campaignAdministrationHttpMembershipDeleteRequestSchema.parse(remove)).toEqual(remove);
    expect(campaignAdministrationHttpMembershipListResponseSchema.parse({ memberships: [membership] }))
      .toEqual({ memberships: [membership] });
    expect(campaignAdministrationHttpMembershipCreateRequestSchema.safeParse({ ...create, campaignId: "campaign" }).success).toBe(false);
    expect(campaignAdministrationHttpMembershipUpdateRequestSchema.safeParse({ ...update, principalId: "member" }).success).toBe(false);
    expect(campaignAdministrationHttpMembershipDeleteRequestSchema.safeParse({ ...remove, principalId: "member" }).success).toBe(false);
    expect(campaignAdministrationHttpMembershipListResponseSchema.safeParse({ memberships: [{ ...membership, campaignId: "campaign" }] }).success).toBe(false);
    expect(campaignAdministrationHttpMembershipMutationResponseSchema.safeParse({ membership, receipt }).success).toBe(true);
    expect(campaignAdministrationHttpMembershipMutationResponseSchema.safeParse({ membership: { ...membership, campaignId: "campaign" }, receipt }).success).toBe(false);
  });

  it("uses a strict path-owned room detach request and attachment projection", () => {
    const request = { expectedRevision: 0, idempotencyKey: "room-detach" };
    const attachment = { sessionId: " room/opaque ", attachedAt: "2030-01-01T00:00:00.000Z" };

    expect(campaignAdministrationHttpRoomDetachRequestSchema.parse(request)).toEqual(request);
    expect(campaignAdministrationHttpRoomDetachResponseSchema.parse({ attachment, receipt })).toEqual({ attachment, receipt });
    expect(campaignAdministrationHttpRoomDetachRequestSchema.safeParse({ ...request, sessionId: attachment.sessionId }).success).toBe(false);
    expect(campaignAdministrationHttpRoomDetachResponseSchema.safeParse({ attachment: { ...attachment, campaignId: "campaign" }, receipt }).success).toBe(false);
    expect(campaignAdministrationHttpRoomDetachResponseSchema.safeParse({ attachment, receipt, extra: true }).success).toBe(false);
  });
});
