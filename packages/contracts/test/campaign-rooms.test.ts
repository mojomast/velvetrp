import { describe, expect, it } from "vitest";
import {
  campaignRoomAttachRequestSchema,
  campaignRoomAttachResponseSchema,
  campaignRoomLinkingResponseSchema,
  MAX_CAMPAIGN_ROOM_SUMMARIES,
} from "../src/index.js";

const at = "2030-01-01T00:00:00.000Z";
const summary = { sessionId: " room/opaque ", title: "Room", participantNames: ["Aria"], createdAt: at };

describe("campaign room HTTP contracts", () => {
  it("keeps opaque IDs exact and rejects private or unknown fields", () => {
    expect(campaignRoomAttachRequestSchema.parse({ sessionId: summary.sessionId })).toEqual({ sessionId: summary.sessionId });
    expect(campaignRoomAttachRequestSchema.safeParse({ sessionId: "" }).success).toBe(false);
    expect(campaignRoomAttachRequestSchema.safeParse({ sessionId: "room", campaignId: "private" }).success).toBe(false);
    expect(campaignRoomAttachResponseSchema.parse({ attachment: { sessionId: summary.sessionId, attachedAt: at } }))
      .toEqual({ attachment: { sessionId: summary.sessionId, attachedAt: at } });
    expect(campaignRoomAttachResponseSchema.safeParse({
      attachment: { sessionId: "room", attachedAt: at, campaignId: "private" },
    }).success).toBe(false);
  });

  it("enforces bounded, disjoint, deterministically ordered safe summaries", () => {
    const attached = { ...summary, attachedAt: at, stopped: false };
    expect(campaignRoomLinkingResponseSchema.parse({ attached: [attached], eligible: [] }))
      .toEqual({ attached: [attached], eligible: [] });
    for (const [index, invalid] of [
      { attached: [{ ...attached, private: true }], eligible: [] },
      { attached: [attached, attached], eligible: [] },
      { attached: [attached], eligible: [summary] },
      { attached: [], eligible: [{ ...summary, participantNames: [] }] },
      { attached: [], eligible: [{ ...summary, participantNames: ["\ud800"] }] },
      { attached: [], eligible: [summary], private: true },
    ].entries()) expect(campaignRoomLinkingResponseSchema.safeParse(invalid).success, `invalid case ${index}`).toBe(false);
    expect(campaignRoomLinkingResponseSchema.safeParse({
      attached: [], eligible: Array.from({ length: MAX_CAMPAIGN_ROOM_SUMMARIES + 1 }, (_, index) => ({
        ...summary, sessionId: `room-${String(index).padStart(4, "0")}`,
      })),
    }).success).toBe(false);
  });
});
