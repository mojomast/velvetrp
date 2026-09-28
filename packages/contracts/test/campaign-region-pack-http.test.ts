import { describe, expect, it } from "vitest";
import {
  MAX_REGION_PACK_CONNECTIONS,
  MAX_REGION_PACK_EXCLUSIONS,
  MAX_REGION_PACK_LOCATIONS,
  campaignRegionPackLinkedSchema,
  campaignRegionPackRequestSchema,
  campaignRegionPackResponseSchema,
} from "../src/index.js";

const valid = {
  idempotencyKey: "region-pack-1",
  brief: "A rain-soaked river district around a silent bell tower.",
  locationCount: 6,
};

describe("campaign region pack contracts", () => {
  it("accepts a minimal bounded request and applies linkage defaults", () => {
    const parsed = campaignRegionPackRequestSchema.parse(valid);
    expect(parsed.locationCount).toBe(6);
    expect(parsed.linked).toBeUndefined();
    expect(parsed.tone).toBeUndefined();
    expect(parsed.anchorLocationKey).toBeUndefined();
  });

  it("accepts every optional field and strict linkage hint", () => {
    const parsed = campaignRegionPackRequestSchema.parse({
      ...valid,
      tone: "Melancholic",
      exclusions: ["time travel", "guns"],
      anchorLocationKey: "canal-gate",
      linked: { npcs: true, quests: false, clues: true, storyNodes: true, factions: true, encounters: false },
    });
    expect(parsed.exclusions).toEqual(["time travel", "guns"]);
    expect(parsed.anchorLocationKey).toBe("canal-gate");
    expect(parsed.linked).toMatchObject({ quests: false, encounters: false });
  });

  it("rejects out-of-bounds counts, blank briefs, unknown fields, and bad anchors", () => {
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, locationCount: 3 }).success).toBe(false);
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, locationCount: 17 }).success).toBe(false);
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, locationCount: MAX_REGION_PACK_LOCATIONS }).success).toBe(true);
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, brief: "   " }).success).toBe(false);
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, brief: "x".repeat(2_001) }).success).toBe(false);
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, tone: "x".repeat(201) }).success).toBe(false);
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, exclusions: Array.from({ length: MAX_REGION_PACK_EXCLUSIONS + 1 }, (_value, index) => `e${index}`) }).success).toBe(false);
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, anchorLocationKey: "Bad Key" }).success).toBe(false);
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, campaignId: "campaign-1" }).success).toBe(false);
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, locationCount: 4.5 }).success).toBe(false);
    expect(campaignRegionPackRequestSchema.safeParse({ ...valid, idempotencyKey: "bad key" }).success).toBe(false);
  });

  it("rejects unknown linkage keys", () => {
    expect(campaignRegionPackLinkedSchema.safeParse({ monsters: true }).success).toBe(false);
    expect(campaignRegionPackLinkedSchema.parse({ npcs: true }).npcs).toBe(true);
  });

  it("strictly shapes the applied response and its designated start", () => {
    const response = {
      campaignId: "campaign-1",
      draft: {
        draftId: "draft-1", campaignId: "campaign-1", kind: "campaign-content", state: "applied",
        revision: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
      appliedArtifactKeys: ["river-gate", "river-gate-to-bell"],
      receipt: { receiptId: "receipt-1", appliedAt: "2026-01-01T00:00:00.000Z" },
      startLocation: { artifactKey: "river-gate", locationId: "gen-location-river-gate", name: "River Gate" },
    };
    expect(campaignRegionPackResponseSchema.parse(response)).toEqual(response);
    expect(campaignRegionPackResponseSchema.safeParse({ ...response, appliedArtifactKeys: [] }).success).toBe(false);
    expect(campaignRegionPackResponseSchema.safeParse({ ...response, appliedArtifactKeys: Array.from({ length: 129 }, (_v, i) => `k-${i}`) }).success).toBe(false);
    expect(campaignRegionPackResponseSchema.safeParse({ ...response, startLocation: { artifactKey: null, locationId: "loc", name: "Loc", designatedAt: "2026-01-01T00:00:00.000Z" } }).success).toBe(false);
    expect(campaignRegionPackResponseSchema.parse({ ...response, startLocation: null }).startLocation).toBeNull();
    expect(campaignRegionPackResponseSchema.safeParse({ ...response, providerPayload: "private" }).success).toBe(false);
  });

  it("exposes the connection bound for the route and validator", () => {
    expect(MAX_REGION_PACK_LOCATIONS).toBe(16);
    expect(MAX_REGION_PACK_CONNECTIONS).toBe(24);
  });
});
