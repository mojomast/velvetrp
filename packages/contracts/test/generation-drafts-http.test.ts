import { describe, expect, it } from "vitest";
import { generationDraftApplyRequestSchema, generationDraftApplyResponseSchema, generationDraftCreateRequestSchema, generationDraftGetResponseSchema } from "../src/generation-drafts-http.js";

describe("M2.11 generation draft HTTP contracts", () => {
  it("accepts only exact roadmap create and apply shapes", () => {
    const create = { campaignId: "campaign", sessionId: "session", brief: "A careful guide", visibleLocation: "The road", tone: "quiet", difficulty: "standard", partyActorIds: ["actor"], pinnedEnemyTemplates: [{ kind: "enemy-template", packId: "pack", packVersion: "1", definitionId: "wolf" }], exclusions: ["No hidden powers"], idempotencyKey: "draft" };
    expect(generationDraftCreateRequestSchema.parse(create)).toEqual(create);
    expect(generationDraftCreateRequestSchema.safeParse({ ...create, expectedRevision: 0 }).success).toBe(false);
    const apply = { expectedRevision: 0, idempotencyKey: "apply" };
    expect(generationDraftApplyRequestSchema.parse(apply)).toEqual(apply);
    expect(generationDraftApplyRequestSchema.safeParse({ ...apply, selectedChanges: ["brief"] }).success).toBe(false);
  });

  it("projects only safe encounter facts", () => {
    const at = "2035-01-01T00:00:00.000Z";
    const response = { draft: { draftId: "draft", campaignId: "campaign", kind: "encounter", state: "staged", revision: 0, createdAt: at, updatedAt: at },
      encounter: { name: "Road ambush", enemyCount: 2, terrain: "road", motives: "delay", rewardNarrative: "safe passage" }, validationIssues: [] };
    expect(generationDraftGetResponseSchema.parse(response)).toEqual(response);
    expect(generationDraftGetResponseSchema.safeParse({ ...response, provider: "secret" }).success).toBe(false);
  });

  it("labels apply receipts as authoritative encounter application", () => {
    const at = "2035-01-01T00:00:00.000Z";
    const response = { draft: { draftId: "draft", campaignId: "campaign", kind: "encounter", state: "applied", revision: 2, createdAt: at, updatedAt: at },
      application: { scope: "encounter", campaignDomainMutated: true, encounterId: "encounter" },
      receipts: [{ receiptId: "receipt", reviewDecisionId: "review", scope: "encounter", encounterId: "encounter", appliedAt: at }] };
    expect(generationDraftApplyResponseSchema.parse(response)).toEqual(response);
  });
});
