import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CampaignDetailResponse,
  CampaignListResponse,
  CampaignMembershipRead,
  CampaignRenameRequest,
  CampaignRenameResponse,
  CampaignStarterSetupRequest,
  CampaignStarterSetupResponse,
  CampaignTimeline,
  DeepReadonly,
  OriginalStarterPresentation,
} from "../src/index.js";
import {
  addCampaignMembershipInputSchema,
  apiProblemSchema,
  attachCampaignSessionInputSchema,
  campaignAccessSchema,
  campaignListResponseSchema,
  campaignMemberRoleSchema,
  campaignMembershipReadSchema,
  campaignMembershipSchema,
  campaignRenameRequestSchema,
  campaignRenameResponseSchema,
  campaignRenameResultSchema,
  campaignStarterSetupRequestSchema,
  campaignStarterSetupResponseSchema,
  campaignSchema,
  campaignRoleSchema,
  campaignSessionAttachmentSchema,
  campaignTimelineSchema,
  createCampaignInputSchema,
  campaignCreateRequestSchema,
  campaignCreateResponseSchema,
  campaignDetailResponseSchema,
  campaignDetailSchema,
  detachCampaignSessionInputSchema,
  requestIdSchema,
  ORIGINAL_STARTER_ID,
  ORIGINAL_STARTER_PACK_ID,
  ORIGINAL_STARTER_PACK_VERSION,
  ORIGINAL_STARTER_PRESENTATION,
  originalStarterPresentationSchema,
  renameCampaignInputSchema,
  resourceIdSchema,
  revisionSchema,
  roleplayFeatureFlagsSchema,
  rpgFeatureFlagsSchema,
  utcIsoTimestampSchema,
} from "../src/index.js";

describe("feature flag contracts", () => {
  it("validates legacy roleplay flags without retaining additive fields", () => {
    expect(roleplayFeatureFlagsSchema.parse({ voice: false, images: true, future: true })).toEqual({
      voice: false,
      images: true,
    });
    expect(() => roleplayFeatureFlagsSchema.parse({ voice: "true", images: false })).toThrow();
  });

  it("requires every RPG feature to be an explicit boolean", () => {
    const flags = { campaign: false, mechanics: false, combat: false, studio: false, remoteAuthentication: false };
    expect(rpgFeatureFlagsSchema.parse(flags)).toEqual(flags);
    expect(() => rpgFeatureFlagsSchema.parse({ ...flags, combat: 1 })).toThrow();
  });
});

describe("RPG domain primitives", () => {
  it("validates contract-compatible resource IDs and campaign roles", () => {
    expect(resourceIdSchema.parse("campaign:local-owner_1.test")).toBe("campaign:local-owner_1.test");
    expect(campaignRoleSchema.options).toEqual(["owner", "gm", "player", "observer"]);
    expect(campaignMemberRoleSchema.options).toEqual(["gm", "player", "observer"]);
    for (const invalid of ["", "contains space", "slash/id", "x".repeat(129)]) {
      expect(resourceIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires millisecond UTC ISO timestamps", () => {
    expect(utcIsoTimestampSchema.parse("2030-04-05T06:07:08.009Z")).toBe("2030-04-05T06:07:08.009Z");
    expect(utcIsoTimestampSchema.safeParse("2030-04-05T06:07:08Z").success).toBe(false);
    expect(utcIsoTimestampSchema.safeParse("2030-04-05T06:07:08.009+01:00").success).toBe(false);
  });
});

describe("campaign contracts", () => {
  it("fixes starter setup to one strict identifier and the minimal detail response", () => {
    const request = { starterId: ORIGINAL_STARTER_ID };
    expect(campaignStarterSetupRequestSchema.parse(request)).toEqual(request);
    expect(campaignStarterSetupRequestSchema.safeParse({ starterId: "other" }).success).toBe(false);
    expect(campaignStarterSetupRequestSchema.safeParse({ ...request, content: {} }).success).toBe(false);
    expect(campaignStarterSetupResponseSchema).toBe(campaignDetailResponseSchema);
    expectTypeOf(request).toMatchTypeOf<CampaignStarterSetupRequest>();
    expectTypeOf<CampaignStarterSetupResponse>().toEqualTypeOf<CampaignDetailResponse>();
    expect(ORIGINAL_STARTER_ID).toBe(`${ORIGINAL_STARTER_PACK_ID}@${ORIGINAL_STARTER_PACK_VERSION}`);
    expect(ORIGINAL_STARTER_PRESENTATION.starterId)
      .toBe(`${ORIGINAL_STARTER_PRESENTATION.pack.id}@${ORIGINAL_STARTER_PRESENTATION.pack.version}`);
  });

  it("exports one strict client-safe starter presentation", () => {
    expect(originalStarterPresentationSchema.parse(ORIGINAL_STARTER_PRESENTATION))
      .toEqual(ORIGINAL_STARTER_PRESENTATION);
    expect(ORIGINAL_STARTER_PRESENTATION).toMatchObject({
      starterId: ORIGINAL_STARTER_ID,
      rulesProfile: { id: "velvet:rules:original-narrative", name: "Velvet Original Narrative" },
      pack: { id: "velvet:original-starter", version: "1.0.0+d15042935818", name: "Velvet Original Starter" },
      races: [{ name: "Avelune" }],
      backgrounds: [{ name: "Rainledger" }],
      classes: [{ name: "Pathmender" }],
    });
    expect(originalStarterPresentationSchema.safeParse({ ...ORIGINAL_STARTER_PRESENTATION, extra: true }).success).toBe(false);
  });

  it("deep-freezes every layer of the parsed starter presentation", () => {
    const expectDeeplyFrozen = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) expectDeeplyFrozen(child);
    };
    expectDeeplyFrozen(ORIGINAL_STARTER_PRESENTATION);
    expectTypeOf(ORIGINAL_STARTER_PRESENTATION)
      .toEqualTypeOf<DeepReadonly<OriginalStarterPresentation>>();

    const mutationAttempts = [
      () => { (ORIGINAL_STARTER_PRESENTATION as unknown as { starterId: string }).starterId = "mutation"; },
      () => { (ORIGINAL_STARTER_PRESENTATION.rulesProfile as unknown as { name: string }).name = "Mutation"; },
      () => { (ORIGINAL_STARTER_PRESENTATION.pack as unknown as { version: string }).version = "9.9.9"; },
      () => { (ORIGINAL_STARTER_PRESENTATION.classes as unknown as unknown[]).push({}); },
      () => { (ORIGINAL_STARTER_PRESENTATION.classes[0] as unknown as { name: string }).name = "Mutation"; },
      () => { (ORIGINAL_STARTER_PRESENTATION.races as unknown as unknown[]).splice(0, 1); },
      () => { (ORIGINAL_STARTER_PRESENTATION.races[0] as unknown as { description: string }).description = "Mutation"; },
      () => { (ORIGINAL_STARTER_PRESENTATION.backgrounds as unknown as unknown[]).pop(); },
      () => { (ORIGINAL_STARTER_PRESENTATION.backgrounds[0] as unknown as { id: string }).id = "mutation"; },
    ];
    for (const mutate of mutationAttempts) expect(mutate).toThrow(TypeError);
    expect(originalStarterPresentationSchema.parse(ORIGINAL_STARTER_PRESENTATION))
      .toEqual(ORIGINAL_STARTER_PRESENTATION);
  });

  it("normalizes a strict bounded creation input", () => {
    expect(createCampaignInputSchema.parse({ name: "  The Long Road  " })).toEqual({ name: "The Long Road" });
    expect(campaignCreateRequestSchema).toBe(createCampaignInputSchema);
    for (const invalid of [
      { name: "" },
      { name: "   " },
      { name: "x".repeat(201) },
      { name: 7 },
      { name: "Valid", unknown: true },
    ]) {
      expect(createCampaignInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates exact campaign create request and response envelopes", () => {
    const campaign = {
      id: "campaign-one",
      name: "The Long Road",
      activeTimelineId: "timeline-one",
      ownerPrincipalId: "local-owner",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
    expect(campaignCreateRequestSchema.parse({ name: "  The Long Road  " })).toEqual({ name: "The Long Road" });
    expect(campaignCreateResponseSchema.parse({ campaign })).toEqual({ campaign });
    expect(campaignCreateRequestSchema.safeParse({ name: "Road", ownerPrincipalId: "spoof" }).success).toBe(false);
    expect(campaignCreateResponseSchema.safeParse({ campaign, extra: true }).success).toBe(false);
  });

  it("normalizes a strict bounded rename input", () => {
    expect(renameCampaignInputSchema.parse({ name: "  A New Road  " })).toEqual({ name: "A New Road" });
    for (const invalid of [
      { name: "" },
      { name: "   " },
      { name: "x".repeat(201) },
      { name: 7 },
      { name: "Valid", unknown: true },
    ]) {
      expect(renameCampaignInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates the strict stale-safe rename HTTP contracts", () => {
    const request = {
      name: "  A New Road  ",
      expectedUpdatedAt: "2030-04-05T06:07:08.009Z",
    };
    expect(campaignRenameRequestSchema.parse(request)).toEqual({
      name: "A New Road",
      expectedUpdatedAt: "2030-04-05T06:07:08.009Z",
    });
    const campaign = {
      id: "campaign-one",
      name: "A New Road",
      updatedAt: "2030-04-05T06:07:09.010Z",
    };
    expect(campaignRenameResponseSchema.parse({ campaign })).toEqual({ campaign });
    expect(Object.keys(campaignRenameResultSchema.shape)).toEqual(["id", "name", "updatedAt"]);

    for (const invalid of [
      { name: "Road" },
      { name: "Road", expectedUpdatedAt: "2030-04-05T06:07:08Z" },
      { name: "Road", expectedUpdatedAt: "2030-04-05T06:07:08.009+00:00" },
      { name: "Road", expectedUpdatedAt: "2030-04-05T06:07:08.009Z", extra: true },
    ]) {
      expect(campaignRenameRequestSchema.safeParse(invalid).success).toBe(false);
    }
    expect(campaignRenameResponseSchema.safeParse({ campaign: { ...campaign, id: "bad id" } }).success).toBe(false);
    expect(campaignRenameResponseSchema.safeParse({ campaign: { ...campaign, updatedAt: "not-a-time" } }).success).toBe(false);
    expect(campaignRenameResponseSchema.safeParse({ campaign: { ...campaign, ownerPrincipalId: "local-owner" } }).success).toBe(false);
    expect(campaignRenameResponseSchema.safeParse({ campaign, extra: true }).success).toBe(false);
  });

  it("infers only the stale-safe rename request and minimal response fields", () => {
    expectTypeOf<CampaignRenameRequest>().toEqualTypeOf<{ name: string; expectedUpdatedAt: string }>();
    expectTypeOf<CampaignRenameResponse>().toEqualTypeOf<{
      campaign: { id: string; name: string; updatedAt: string };
    }>();
  });

  it("validates the exact campaign projection", () => {
    const campaign = {
      id: "campaign-one",
      name: "The Long Road",
      activeTimelineId: "timeline-one",
      ownerPrincipalId: "local-owner",
      createdAt: "2030-04-05T06:07:08.009Z",
      updatedAt: "2030-04-05T06:07:08.009Z",
    };
    expect(campaignSchema.parse(campaign)).toEqual(campaign);
    expect(campaignSchema.safeParse({ ...campaign, id: "invalid id" }).success).toBe(false);
    expect(campaignSchema.safeParse({ ...campaign, createdAt: "2030-04-05T06:07:08Z" }).success).toBe(false);
    expect(campaignSchema.safeParse({ ...campaign, unknown: true }).success).toBe(false);
  });

  it("validates the exact strict campaign timeline projection", () => {
    const timeline = {
      id: "timeline-one",
      campaignId: "campaign-one",
      revision: 0,
      createdAt: "2030-04-05T06:07:08.009Z",
    };

    expect(campaignTimelineSchema.parse(timeline)).toEqual(timeline);
    expect(Object.keys(campaignTimelineSchema.shape)).toEqual(["id", "campaignId", "revision", "createdAt"]);
    expect(campaignTimelineSchema.shape.id).toBe(resourceIdSchema);
    expect(campaignTimelineSchema.shape.campaignId).toBe(resourceIdSchema);
    expect(campaignTimelineSchema.shape.revision).toBe(revisionSchema);
    expect(campaignTimelineSchema.shape.createdAt).toBe(utcIsoTimestampSchema);

    for (const [field, value] of [
      ["id", "invalid id"],
      ["campaignId", "invalid/campaign"],
      ["createdAt", "2030-04-05T06:07:08Z"],
      ["createdAt", "2030-04-05T06:07:08.009+01:00"],
    ] as const) {
      expect(campaignTimelineSchema.safeParse({ ...timeline, [field]: value }).success).toBe(false);
    }

    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(campaignTimelineSchema.safeParse({ ...timeline, revision }).success).toBe(false);
    }
    for (const revision of [0, Number.MAX_SAFE_INTEGER]) {
      expect(campaignTimelineSchema.parse({ ...timeline, revision }).revision).toBe(revision);
    }

    for (const extra of ["active", "status", "fork", "events", "updatedAt"] as const) {
      expect(campaignTimelineSchema.safeParse({ ...timeline, [extra]: extra }).success).toBe(false);
    }
    for (const requiredField of ["id", "campaignId", "revision", "createdAt"] as const) {
      const incomplete: Partial<typeof timeline> = { ...timeline };
      delete incomplete[requiredField];
      expect(campaignTimelineSchema.safeParse(incomplete).success).toBe(false);
    }
  });

  it("infers only the campaign timeline wire fields", () => {
    expectTypeOf<CampaignTimeline>().toEqualTypeOf<{
      id: string;
      campaignId: string;
      revision: number;
      createdAt: string;
    }>();
  });

  it("validates a strict campaign access projection for every role", () => {
    const campaign = {
      id: "campaign-one",
      name: "The Long Road",
      activeTimelineId: "timeline-one",
      ownerPrincipalId: "local-owner",
      createdAt: "2030-04-05T06:07:08.009Z",
      updatedAt: "2030-04-05T06:07:08.009Z",
    };
    for (const actorRole of ["owner", "gm", "player", "observer"] as const) {
      expect(campaignAccessSchema.parse({ ...campaign, actorRole })).toEqual({ ...campaign, actorRole });
    }
    expect(campaignAccessSchema.safeParse(campaign).success).toBe(false);
    expect(campaignAccessSchema.safeParse({ ...campaign, actorRole: "admin" }).success).toBe(false);
    expect(campaignAccessSchema.safeParse({ ...campaign, actorRole: "owner", unknown: true }).success).toBe(false);
  });

  it("validates the exact strict campaign list response", () => {
    const campaign = {
      id: "campaign-one",
      name: "The Long Road",
      activeTimelineId: "timeline-one",
      ownerPrincipalId: "local-owner",
      createdAt: "2030-04-05T06:07:08.009Z",
      updatedAt: "2030-04-05T06:07:08.009Z",
      actorRole: "owner" as const,
    };
    const response = { campaigns: [campaign] };

    expect(campaignListResponseSchema.parse(response)).toEqual(response);
    expect(campaignListResponseSchema.parse({ campaigns: [] })).toEqual({ campaigns: [] });
    expect(campaignListResponseSchema.safeParse({ campaigns: [campaign], unknown: true }).success).toBe(false);
    expect(campaignListResponseSchema.safeParse({ campaign: [campaign] }).success).toBe(false);
    expect(campaignListResponseSchema.safeParse({ campaigns: [{ ...campaign, actorRole: "admin" }] }).success).toBe(false);
  });

  it("infers only the campaign list response wire fields", () => {
    expectTypeOf<CampaignListResponse>().toEqualTypeOf<{
      campaigns: Array<{
        id: string;
        name: string;
        activeTimelineId: string;
        ownerPrincipalId: string;
        createdAt: string;
        updatedAt: string;
        actorRole: "owner" | "gm" | "player" | "observer";
      }>;
    }>();
  });

  it("validates the minimal strict campaign detail and content-state union", () => {
    const base = {
      id: "campaign-one",
      name: "The Long Road",
      actorRole: "gm" as const,
      createdAt: "2030-04-05T06:07:08.009Z",
      updatedAt: "2030-04-06T06:07:08.009Z",
    };
    const unconfigured = { ...base, content: { status: "unconfigured" as const } };
    const configured = {
      ...base,
      content: {
        status: "configured" as const,
        rulesProfileId: "rules-one",
        contentPacks: [
          { packId: "pack-a", packVersion: "1.0.0" },
          { packId: "pack-b", packVersion: "2" },
        ],
      },
    };

    expect(campaignDetailSchema.parse(unconfigured)).toEqual(unconfigured);
    expect(campaignDetailResponseSchema.parse({ campaign: configured })).toEqual({ campaign: configured });
    expect(Object.keys(campaignDetailSchema.shape)).toEqual([
      "id", "name", "actorRole", "createdAt", "updatedAt", "content",
    ]);
    for (const invalid of [
      { ...unconfigured, ownerPrincipalId: "local-owner" },
      { ...unconfigured, activeTimelineId: "timeline-one" },
      { ...unconfigured, updatedAt: "2030-04-04T06:07:08.009Z" },
      { ...base, content: { status: "unconfigured", rulesProfileId: "rules-one" } },
      { ...base, content: { status: "configured", rulesProfileId: "rules-one" } },
      { ...base, content: { status: "configured", contentPacks: [] } },
      { ...base, content: { status: "configured", rulesProfileId: "rules-one", contentPacks: [], extra: true } },
      {
        ...base,
        content: {
          status: "configured",
          rulesProfileId: "rules-one",
          contentPacks: [{ packId: "same", packVersion: "1" }, { packId: "same", packVersion: "2" }],
        },
      },
    ]) {
      expect(campaignDetailSchema.safeParse(invalid).success).toBe(false);
    }
    expect(campaignDetailResponseSchema.safeParse({ campaign: configured, extra: true }).success).toBe(false);
  });

  it("infers only the minimal campaign detail response fields", () => {
    expectTypeOf<CampaignDetailResponse>().toEqualTypeOf<{
      campaign: {
        id: string;
        name: string;
        actorRole: "owner" | "gm" | "player" | "observer";
        createdAt: string;
        updatedAt: string;
        content:
          | { status: "unconfigured" }
          | {
            status: "configured";
            rulesProfileId: string;
            contentPacks: Array<{ packId: string; packVersion: string }>;
          };
      };
    }>();
  });

  it("validates strict add-campaign-membership input for member roles only", () => {
    for (const role of ["gm", "player", "observer"] as const) {
      expect(addCampaignMembershipInputSchema.parse({ principalId: "principal-one", role }))
        .toEqual({ principalId: "principal-one", role });
    }
    expect(addCampaignMembershipInputSchema.safeParse({ principalId: "principal-one", role: "owner" }).success)
      .toBe(false);
    expect(addCampaignMembershipInputSchema.safeParse({ principalId: "invalid principal", role: "gm" }).success)
      .toBe(false);
    expect(addCampaignMembershipInputSchema.safeParse({ principalId: "principal-one", role: "gm", unknown: true }).success)
      .toBe(false);
  });

  it("validates the exact campaign membership projection", () => {
    const membership = {
      campaignId: "campaign-one",
      principalId: "principal-one",
      role: "player",
      createdAt: "2030-04-05T06:07:08.009Z",
    } as const;
    expect(campaignMembershipSchema.parse(membership)).toEqual(membership);
    expect(campaignMembershipSchema.safeParse({ ...membership, role: "owner" }).success).toBe(false);
    expect(campaignMembershipSchema.safeParse({ ...membership, createdAt: "2030-04-05T06:07:08Z" }).success).toBe(false);
    expect(campaignMembershipSchema.safeParse({ ...membership, unknown: true }).success).toBe(false);
  });

  it("validates a separate strict campaign membership read for every role", () => {
    const membership = {
      campaignId: "campaign-one",
      principalId: "principal-one",
      createdAt: "2030-04-05T06:07:08.009Z",
    } as const;

    for (const role of ["owner", "gm", "player", "observer"] as const) {
      expect(campaignMembershipReadSchema.parse({ ...membership, role })).toEqual({ ...membership, role });
    }

    expect(campaignMembershipReadSchema.safeParse({ ...membership, role: "admin" }).success).toBe(false);
    expect(campaignMembershipReadSchema.safeParse({ ...membership, role: "gm", campaignId: "invalid campaign" }).success)
      .toBe(false);
    expect(campaignMembershipReadSchema.safeParse({ ...membership, role: "gm", principalId: "invalid principal" }).success)
      .toBe(false);
    expect(campaignMembershipReadSchema.safeParse({ ...membership, role: "gm", createdAt: "2030-04-05T06:07:08Z" }).success)
      .toBe(false);
    expect(campaignMembershipReadSchema.safeParse({ ...membership, role: "gm", unknown: true }).success).toBe(false);
    const completeMembership = { ...membership, role: "gm" as const };
    for (const requiredField of ["campaignId", "principalId", "role", "createdAt"] as const) {
      const incompleteMembership: Partial<typeof completeMembership> = { ...completeMembership };
      delete incompleteMembership[requiredField];
      expect(campaignMembershipReadSchema.safeParse(incompleteMembership).success).toBe(false);
    }
  });

  it("infers the exact campaign membership read type without widening add semantics", () => {
    expectTypeOf<CampaignMembershipRead>().toEqualTypeOf<{
      campaignId: string;
      principalId: string;
      role: "owner" | "gm" | "player" | "observer";
      createdAt: string;
    }>();

    const ownerMembership = {
      campaignId: "campaign-one",
      principalId: "principal-one",
      role: "owner",
      createdAt: "2030-04-05T06:07:08.009Z",
    } as const;
    expect(campaignMembershipReadSchema.safeParse(ownerMembership).success).toBe(true);
    expect(campaignMembershipSchema.safeParse(ownerMembership).success).toBe(false);
    expect(addCampaignMembershipInputSchema.safeParse({ principalId: "principal-one", role: "owner" }).success)
      .toBe(false);
  });

  it("validates strict campaign-session attachment input with an opaque legacy session ID", () => {
    const input = { campaignId: "campaign-one", sessionId: " session/legacy value " };
    expect(attachCampaignSessionInputSchema.parse(input)).toEqual(input);
    expect(attachCampaignSessionInputSchema.safeParse({ ...input, campaignId: "invalid campaign" }).success).toBe(false);
    expect(attachCampaignSessionInputSchema.safeParse({ ...input, sessionId: "" }).success).toBe(false);
    expect(attachCampaignSessionInputSchema.safeParse({ ...input, unknown: true }).success).toBe(false);
  });

  it("validates strict campaign-session detach input with an opaque preserved session ID", () => {
    const input = { campaignId: "campaign-one", sessionId: " session/legacy value " };
    expect(detachCampaignSessionInputSchema.parse(input)).toEqual(input);
    expect(detachCampaignSessionInputSchema.safeParse({ ...input, campaignId: "invalid campaign" }).success).toBe(false);
    expect(detachCampaignSessionInputSchema.safeParse({ ...input, sessionId: "" }).success).toBe(false);
    expect(detachCampaignSessionInputSchema.safeParse({ ...input, unknown: true }).success).toBe(false);
  });

  it("validates the exact campaign-session attachment projection", () => {
    const attachment = {
      campaignId: "campaign-one",
      sessionId: "session/legacy value",
      attachedAt: "2030-04-05T06:07:08.009Z",
    };
    expect(campaignSessionAttachmentSchema.parse(attachment)).toEqual(attachment);
    expect(campaignSessionAttachmentSchema.safeParse({ ...attachment, sessionId: "" }).success).toBe(false);
    expect(campaignSessionAttachmentSchema.safeParse({ ...attachment, attachedAt: "2030-04-05T06:07:08Z" }).success).toBe(false);
    expect(campaignSessionAttachmentSchema.safeParse({ ...attachment, unknown: true }).success).toBe(false);
  });
});

describe("API problem contracts", () => {
  it("validates a structured problem with its compatibility error field", () => {
    const problem = {
      type: "https://velvet.local/problems/not-found",
      title: "Not found",
      status: 404,
      detail: "resource not found",
      instance: "/api/rpg/v1/missing",
      code: "NOT_FOUND",
      requestId: "request-1",
      error: "resource not found",
    };
    expect(apiProblemSchema.parse(problem)).toEqual(problem);
  });

  it("rejects invalid statuses and unsafe request IDs", () => {
    expect(requestIdSchema.safeParse("unsafe\nheader").success).toBe(false);
    expect(apiProblemSchema.safeParse({
      type: "https://velvet.local/problems/error",
      title: "Error",
      status: 200,
      detail: "bad status",
      code: "ERROR",
      requestId: "request-1",
      error: "bad status",
    }).success).toBe(false);
  });
});
