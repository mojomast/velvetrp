import { describe, expect, it } from "vitest";
import {
  campaignHistoryHttpCheckpointRequestSchema,
  campaignHistoryHttpCheckpointResponseSchema,
  campaignHistoryHttpCommandReceiptSchema,
  campaignHistoryHttpPublicReceiptSchema,
  campaignHistoryHttpEventsQuerySchema,
  campaignHistoryHttpEventsResponseSchema,
  campaignHistoryHttpForkRequestSchema,
  campaignHistoryHttpForkResponseSchema,
  campaignHistoryHttpRecapRequestSchema,
  campaignHistoryHttpRecapResponseSchema,
  campaignHistoryHttpTimelinesResponseSchema,
} from "../src/campaign-history-http.js";

const event = {
  eventId: "event", commandId: "command", timelineId: "timeline", actorId: "actor", sourceTurnId: null,
  type: "actor_attribute_set" as const, revision: 1, occurredAt: "2030-01-01T00:00:00.000Z",
  data: { attributeId: "strength", valueBefore: 10, valueAfter: 12 },
};
const receiptEvent = {
  eventId: "receipt-event", commandId: "command", type: "checkpoint_created" as const, revision: 1,
  occurredAt: "2030-01-01T00:00:00.000Z", data: {},
};
const receipt = {
  commandId: "command", type: "checkpoint_created" as const, revisionBefore: 0, revisionAfter: 1,
  occurredAt: "2030-01-01T00:00:00.000Z", events: [receiptEvent],
};

describe("campaign history HTTP contracts", () => {
  it("uses a timeline list envelope with the active timeline", () => {
    const timeline = { id: "timeline", parentTimelineId: null, forkedFromRevision: null, revision: 1,
      createdAt: "2030-01-01T00:00:00.000Z", active: true };

    expect(campaignHistoryHttpTimelinesResponseSchema.parse({ activeTimelineId: "timeline", timelines: [timeline] }))
      .toEqual({ activeTimelineId: "timeline", timelines: [timeline] });
    expect(campaignHistoryHttpTimelinesResponseSchema.safeParse({ activeTimelineId: "timeline", timelines: [{ ...timeline, campaignId: "campaign" }] }).success).toBe(false);
  });

  it("validates paginated event queries and public event responses", () => {
    expect(campaignHistoryHttpEventsQuerySchema.parse({ timelineId: "timeline", afterRevision: 0, limit: 100 }))
      .toEqual({ timelineId: "timeline", afterRevision: 0, limit: 100 });
    expect(campaignHistoryHttpEventsQuerySchema.safeParse({ timelineId: "timeline", limit: 101 }).success).toBe(false);
    expect(campaignHistoryHttpEventsQuerySchema.safeParse({ timelineId: "timeline", afterRevision: 0 }).success).toBe(false);
    expect(campaignHistoryHttpEventsQuerySchema.safeParse({ timelineId: "timeline", campaignId: "campaign" }).success).toBe(false);
    expect(campaignHistoryHttpEventsResponseSchema.parse({ events: [event], nextAfterRevision: 1 }))
      .toEqual({ events: [event], nextAfterRevision: 1 });
    expect(campaignHistoryHttpEventsResponseSchema.safeParse({ events: [{ ...event, campaignId: "campaign" }], nextAfterRevision: null }).success).toBe(false);
  });

  it("keeps command receipts public and internally consistent", () => {
    expect(campaignHistoryHttpCommandReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(campaignHistoryHttpCommandReceiptSchema.safeParse({ ...receipt, campaignId: "campaign" }).success).toBe(false);
    expect(campaignHistoryHttpCommandReceiptSchema.safeParse({ ...receipt, events: [{ ...receiptEvent, commandId: "other" }] }).success).toBe(false);
  });

  it("exposes a strict discriminated receipt read projection without identities or generic payloads", () => {
    const mechanic = { kind: "mechanic", revisionBefore: 0, revisionAfter: 1,
      occurredAt: "2030-01-01T00:00:00.000Z", event: { type: "actor_attribute_set",
        data: { valueBefore: 10, valueAfter: 12 } } };
    const administration = { kind: "administration", type: "checkpoint_created",
      revisionBefore: 0, revisionAfter: 1, occurredAt: "2030-01-01T00:00:00.000Z" };
    const travel = { kind: "travel", destination: "Glass Harbor", revisionBefore: 3, revisionAfter: 4,
      occurredAt: "2030-01-01T00:00:00.000Z" };
    expect(campaignHistoryHttpPublicReceiptSchema.parse(mechanic)).toEqual(mechanic);
    expect(campaignHistoryHttpPublicReceiptSchema.parse(administration)).toEqual(administration);
    expect(campaignHistoryHttpPublicReceiptSchema.parse(travel)).toEqual(travel);
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...mechanic, commandId: "command" }).success).toBe(false);
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...administration, data: { private: true } }).success).toBe(false);
    expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...mechanic, event: { ...mechanic.event, actorId: "actor" } }).success).toBe(false);
    for (const privateKey of ["commandId", "candidateId", "providerCallId", "locationId", "connectionId", "actorId", "principalId", "digest"]) {
      expect(campaignHistoryHttpPublicReceiptSchema.safeParse({ ...travel, [privateKey]: "private" }).success).toBe(false);
    }
  });

  it("uses strict checkpoint, fork, and recap create envelopes", () => {
    const checkpoint = { id: "checkpoint", timelineId: "timeline", timelineRevision: 1, label: "Opening",
      createdAt: "2030-01-01T00:00:00.000Z" };
    const timeline = { id: "fork", parentTimelineId: "timeline", forkedFromRevision: 1, revision: 1,
      createdAt: "2030-01-01T00:00:00.000Z", active: true };
    const recap = { id: "recap", timelineId: "timeline", throughRevision: 1, selectedSessionIds: ["session"],
      visibility: "members" as const, text: "The party arrived.", createdAt: "2030-01-01T00:00:00.000Z" };
    const checkpointRequest = { timelineId: "timeline", timelineRevision: 1, label: "Opening", expectedRevision: 0, idempotencyKey: "checkpoint" };
    const forkRequest = { checkpointId: "checkpoint", expectedRevision: 1, idempotencyKey: "fork" };
    const recapRequest = { timelineId: "timeline", throughRevision: 1, selectedSessionIds: ["session"], visibility: "members" as const,
      text: "The party arrived.", expectedRevision: 2, idempotencyKey: "recap" };

    expect(campaignHistoryHttpCheckpointRequestSchema.parse(checkpointRequest)).toEqual(checkpointRequest);
    expect(campaignHistoryHttpForkRequestSchema.parse(forkRequest)).toEqual(forkRequest);
    expect(campaignHistoryHttpRecapRequestSchema.parse(recapRequest)).toEqual(recapRequest);
    expect(campaignHistoryHttpCheckpointRequestSchema.safeParse({ ...checkpointRequest, campaignId: "campaign" }).success).toBe(false);
    expect(campaignHistoryHttpRecapRequestSchema.safeParse({ ...recapRequest, text: "" }).success).toBe(false);
    expect(campaignHistoryHttpCheckpointResponseSchema.parse({ checkpoint, receipt })).toEqual({ checkpoint, receipt });
    expect(campaignHistoryHttpForkResponseSchema.parse({ timeline, receipt })).toEqual({ timeline, receipt });
    expect(campaignHistoryHttpRecapResponseSchema.parse({ recap, receipt })).toEqual({ recap, receipt });
    expect(campaignHistoryHttpRecapResponseSchema.safeParse({ recap: { ...recap, campaignId: "campaign" }, receipt }).success).toBe(false);
  });
});
