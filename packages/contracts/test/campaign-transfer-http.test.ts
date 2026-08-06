import { describe, expect, it } from "vitest";
import {
  campaignTransferHttpDryRunRequestSchema,
  campaignTransferHttpDryRunResponseSchema,
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
});
