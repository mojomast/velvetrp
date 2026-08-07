import { describe, expect, it } from "vitest";
import {
  campaignTransferHttpApplyRequestSchema,
  campaignTransferHttpApplyResponseSchema,
  campaignTransferHttpDryRunRequestSchema,
  campaignTransferHttpDryRunResponseSchema,
  campaignTransferHttpExportDocumentSchema,
  campaignTransferHttpExportQuerySchema,
} from "../src/campaign-transfer-http.js";

const at = "2035-01-02T03:04:05.006Z";
const packageValue = {
  formatVersion: 1,
  exportedAt: at,
  campaign: { name: "Campaign", status: "draft" as const, settings: { maxPlayers: 6,
    allowPlayerDice: true, safetyMode: "standard" as const, recapVisibility: "members" as const, gmNotes: "" }, administrationRevision: 0 },
  timelines: [{ sourceId: "timeline", parentSourceId: null, forkedFromRevision: null, revision: 0, createdAt: at, events: [] }],
  activeTimelineSourceId: "timeline",
  content: { status: "unconfigured" as const },
  records: { actors: [], checkpoints: [], recaps: [], memberships: [], roomAttachments: [],
    administration: { events: [], receipts: [] } },
  excluded: ["credentials", "localPaths", "usageHistory", "privateActorState"] as const,
};

describe("campaign transfer HTTP contracts", () => {
  it("accepts only the exact required export query", () => {
    expect(campaignTransferHttpExportQuerySchema.parse({ includeMessages: "true" })).toEqual({ includeMessages: "true" });
    expect(campaignTransferHttpExportQuerySchema.safeParse({ includeMessages: true }).success).toBe(false);
    expect(campaignTransferHttpExportQuerySchema.safeParse({ includeMessages: "false", extra: "x" }).success).toBe(false);
  });

  it("validates the strict export-only message archive and graph", () => {
    const message = { id: "message-1", role: "character" as const, speakerCharacterId: "legacy-character",
      content: "alternate reply", parentId: null, swipeGroupId: "swipe-1", swipeIndex: 1,
      sequence: 2, status: "aborted" as const, createdAt: at };
    const value = { package: { ...packageValue, records: { ...packageValue.records,
      roomAttachments: [{ sessionId: "legacy-room", attachedAt: at }] } },
      messages: { included: true as const, rooms: [{ sessionId: "legacy-room", activeLeafId: "message-1",
        messages: [message] }] } };
    expect(campaignTransferHttpExportDocumentSchema.parse(value)).toEqual(value);
    expect(campaignTransferHttpExportDocumentSchema.safeParse({ ...value, messages: { included: true,
      rooms: [{ ...value.messages.rooms[0], activeLeafId: "other" }] } }).success).toBe(false);
    expect(campaignTransferHttpExportDocumentSchema.safeParse({ ...value, messages: { included: true,
      rooms: [{ ...value.messages.rooms[0], messages: [{ ...message, usage: null }] }] } }).success).toBe(false);
    expect(campaignTransferHttpExportDocumentSchema.safeParse({ ...value, messages: { included: true,
      rooms: [{ ...value.messages.rooms[0], messages: [{ ...message, parentId: message.id }] }] } }).success).toBe(false);
    expect(campaignTransferHttpExportDocumentSchema.parse({ package: packageValue,
      messages: { included: false } })).toEqual({ package: packageValue, messages: { included: false } });
  });

  it("accepts only an exact dry-run package request", () => {
    const request = { package: packageValue, mode: "dry-run" as const };

    expect(campaignTransferHttpDryRunRequestSchema.parse(request)).toEqual(request);
    expect(campaignTransferHttpDryRunRequestSchema.safeParse({ package: packageValue, mode: "apply" }).success).toBe(false);
    expect(campaignTransferHttpDryRunRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);
  });

  it("returns the dry-run report without exposing the package hash", () => {
    const response = { importId: "import", report: { valid: true, conflicts: [], missingReferences: [], warnings: [],
      counts: { timelines: 1, events: 0, actors: 0, checkpoints: 0, recaps: 0, memberships: 0, roomAttachments: 0 } } };

    expect(campaignTransferHttpDryRunResponseSchema.parse(response)).toEqual(response);
    expect(campaignTransferHttpDryRunResponseSchema.safeParse({ ...response, packageHash: "a".repeat(64) }).success).toBe(false);
  });

  it("accepts only an idempotency key and an explicitly empty resolution set", () => {
    const request = { idempotencyKey: "apply-key", conflictResolutions: [] };
    expect(campaignTransferHttpApplyRequestSchema.parse(request)).toEqual(request);
    expect(campaignTransferHttpApplyRequestSchema.safeParse({ ...request,
      conflictResolutions: ["ignore warning"] }).success).toBe(false);
    expect(campaignTransferHttpApplyRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);
  });

  it("binds apply responses to strict administration envelopes", () => {
    const campaign = { id: "campaign", actorRole: "owner" as const, status: "draft" as const,
      activeTimelineId: "timeline", revision: 1, updatedAt: at, settings: { maxPlayers: 6,
        allowPlayerDice: true, safetyMode: "standard" as const, recapVisibility: "members" as const, gmNotes: "" } };
    const event = { eventId: "event", commandId: "command", campaignId: "campaign", type: "import_applied" as const,
      revision: 1, occurredAt: at, data: {} };
    const response = { campaign, receipt: { commandId: "command", campaignId: "campaign",
      type: "import_applied" as const, revisionBefore: 0, revisionAfter: 1, occurredAt: at, events: [event] as [typeof event] } };
    expect(campaignTransferHttpApplyResponseSchema.parse(response)).toEqual(response);
    expect(campaignTransferHttpApplyResponseSchema.safeParse({ ...response, internal: true }).success).toBe(false);
  });
});
