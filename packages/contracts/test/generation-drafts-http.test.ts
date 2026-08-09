import { describe, expect, it } from "vitest";
import { generationDraftApplyRequestSchema, generationDraftApplyResponseSchema, generationDraftCreateRequestSchema, generationDraftGetResponseSchema } from "../src/generation-drafts-http.js";

describe("M2.11 generation draft HTTP contracts", () => {
  it("accepts only exact roadmap create and apply shapes", () => {
    const create = { campaignId: "campaign", kind: "npc", brief: "A careful guide", constraints: ["No hidden powers"], idempotencyKey: "draft" };
    expect(generationDraftCreateRequestSchema.parse(create)).toEqual(create);
    expect(generationDraftCreateRequestSchema.safeParse({ ...create, expectedRevision: 0 }).success).toBe(false);
    const apply = { selectedChanges: ["brief"], expectedRevision: 0, idempotencyKey: "apply" };
    expect(generationDraftApplyRequestSchema.parse(apply)).toEqual(apply);
    expect(generationDraftApplyRequestSchema.safeParse({ ...apply, selectedChanges: ["brief", "brief"] }).success).toBe(false);
  });

  it("requires explicit fallback provenance", () => {
    const at = "2035-01-01T00:00:00.000Z";
    const response = { draft: { draftId: "draft", campaignId: "campaign", kind: "npc", state: "staged", revision: 0, createdAt: at, updatedAt: at },
      provenance: { source: "user-brief", method: "deterministic-fallback", applicationScope: "draft-review" },
      changes: [{ changeId: "brief", summary: "Review user brief", content: { brief: "A guide", constraints: [] } }], validationIssues: [] };
    expect(generationDraftGetResponseSchema.parse(response)).toEqual(response);
    expect(generationDraftGetResponseSchema.safeParse({ ...response, provenance: { source: "llm", method: "generated" } }).success).toBe(false);
  });

  it("labels apply receipts as draft-only review sealing", () => {
    const at = "2035-01-01T00:00:00.000Z";
    const response = { draft: { draftId: "draft", campaignId: "campaign", kind: "npc", state: "applied", revision: 2, createdAt: at, updatedAt: at },
      application: { scope: "draft-only", campaignDomainMutated: false },
      receipts: [{ receiptId: "receipt", reviewDecisionId: "review", scope: "draft-only", selectedChanges: ["brief"], appliedAt: at }] };
    expect(generationDraftApplyResponseSchema.parse(response)).toEqual(response);
  });
});
