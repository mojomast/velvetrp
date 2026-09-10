import { describe, expect, it } from "vitest";
import {
  MAX_CAMPAIGN_CONTEXT_INSPECTION_RECALL_HITS,
  MAX_CAMPAIGN_CONTEXT_INSPECTION_SAFE_RESPONSE_UTF8_BYTES,
  campaignContextInspectionResponseSchema,
} from "../src/campaign-context-inspection-http.js";

const identity = { campaignId: "campaign", sessionId: "room", lane: "adventure-planning", dispatchId: "dispatch" };
const base = {
  version: "1.0",
  identity,
  availability: "available",
  dispatch: { recordedPhase: "planned", certainty: "recorded", settlement: "settled" },
  sections: [{ status: "included", kind: "safety", label: "Safety", authority: "system-safety", text: "Follow campaign safety rules.", displayedUtf8Bytes: 29 }],
  recallHits: [{ sourceId: "source", sourceLabel: "Old declaration", sourceLink: "/history/source", authority: "intent", text: "We promised to return.", displayedUtf8Bytes: 22 }],
  usage: { storedRecallPacketUtf8Bytes: 128, storedMessageContentUtf8Bytes: 256, serializedStoredRequestUtf8Bytes: 512, displayedSafeResponseUtf8Bytes: 51, reportedPromptTokens: 42, reportedCompletionTokens: 18, reservedPromptTokens: 64, reservedCompletionTokens: 32 },
} as const;

describe("campaign context inspection contract", () => {
  it("accepts an exact safe projection with independently named units", () => {
    expect(campaignContextInspectionResponseSchema.parse(base)).toEqual(base);
  });

  it("rejects unknown fields, unsupported versions, and raw request-shaped fields", () => {
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, extra: true }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, version: "2.0" }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, query: "return to the keep" }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, request: { messages: [] }, queryHash: "a".repeat(64) }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, sections: [{ ...base.sections[0], privateToolArguments: { target: "hidden" } }] }).success).toBe(false);
  });

  it("enforces response, section, and recall caps", () => {
    const hits = Array.from({ length: MAX_CAMPAIGN_CONTEXT_INSPECTION_RECALL_HITS + 1 }, (_, index) => ({ ...base.recallHits[0], sourceId: `source-${index}` }));
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, recallHits: hits }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, usage: { ...base.usage, displayedSafeResponseUtf8Bytes: MAX_CAMPAIGN_CONTEXT_INSPECTION_SAFE_RESPONSE_UTF8_BYTES + 1 } }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, sections: [{ ...base.sections[0], text: "x".repeat(8_193) }] }).success).toBe(false);
  });

  it("requires exact UTF-8 display counters for safe text", () => {
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, sections: [{ ...base.sections[0], displayedUtf8Bytes: 28 }] }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, recallHits: [{ ...base.recallHits[0], displayedUtf8Bytes: 21 }] }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, sections: [{ ...base.sections[0], text: "A🙂", displayedUtf8Bytes: 5 }], recallHits: [], usage: { ...base.usage, displayedSafeResponseUtf8Bytes: 5 } }).success).toBe(true);
  });

  it("accepts only a strict unavailable provenance response", () => {
    const unavailable = { version: "1.0", identity, availability: "unavailable", reason: "provenance-not-recorded" } as const;
    expect(campaignContextInspectionResponseSchema.parse(unavailable)).toEqual(unavailable);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...unavailable, sections: [] }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...unavailable, reason: "missing" }).success).toBe(false);
  });

  it("keeps byte counters and token counters distinct and withholds request-derived counters", () => {
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, usage: { ...base.usage, promptTokens: 42 } }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, usage: { ...base.usage, displayedSafeResponseUtf8Bytes: 50 } }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...base, usage: { ...base.usage, reportedPromptTokens: -1 } }).success).toBe(false);
    const withheld = { ...base, sections: [{ status: "withheld", kind: "recall", reason: "current-visibility-revoked" }], recallHits: [], usage: { storedRecallPacketUtf8Bytes: null, storedMessageContentUtf8Bytes: null, serializedStoredRequestUtf8Bytes: null, displayedSafeResponseUtf8Bytes: 0, reportedPromptTokens: null, reportedCompletionTokens: null, reservedPromptTokens: null, reservedCompletionTokens: null } };
    expect(campaignContextInspectionResponseSchema.safeParse(withheld).success).toBe(true);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...withheld, usage: { ...withheld.usage, serializedStoredRequestUtf8Bytes: 512 } }).success).toBe(false);
    expect(campaignContextInspectionResponseSchema.safeParse({ ...withheld, usage: { ...withheld.usage, reservedPromptTokens: 64 } }).success).toBe(false);
  });
});
