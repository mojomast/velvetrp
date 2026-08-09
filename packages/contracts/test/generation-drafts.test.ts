import { describe, expect, expectTypeOf, it } from "vitest";
import {
  generationDraftApplyStateSchema, generationDraftKindSchema, generationDraftReviewStateSchema,
  generationDraftStateSchema, generationDraftValidationSchema, privateGenerationDraftSchema,
  roleSafeGenerationDraftSchema, type GenerationDraftApplyState, type GenerationDraftKind,
  type GenerationDraftReviewState, type GenerationDraftState,
} from "../src/generation-drafts.js";

const at = "2035-01-01T00:00:00.000Z";
const base = { draftId: "draft", campaignId: "campaign", timelineId: "timeline", sessionId: null, kind: "encounter" as const,
  state: "staged" as const, reviewState: "pending" as const, applyState: "not-ready" as const,
  revision: 0, campaignRevision: 3, createdAt: at, updatedAt: at };

describe("M1.10 generation-draft contracts", () => {
  it("publishes exhaustive kind, lifecycle, review, and apply vocabularies", () => {
    expect(generationDraftKindSchema.options).toEqual(["encounter", "location", "npc", "faction", "quest", "storyline", "content-pack"]);
    expect(generationDraftStateSchema.options).toEqual(["staged", "in-review", "approved", "rejected", "applied", "cancelled"]);
    expect(generationDraftReviewStateSchema.options).toEqual(["pending", "approved", "rejected"]);
    expect(generationDraftApplyStateSchema.options).toEqual(["not-ready", "ready", "applied"]);
    expectTypeOf<GenerationDraftKind>().toEqualTypeOf<"encounter" | "location" | "npc" | "faction" | "quest" | "storyline" | "content-pack">();
    expectTypeOf<GenerationDraftState>().toEqualTypeOf<"staged" | "in-review" | "approved" | "rejected" | "applied" | "cancelled">();
    expectTypeOf<GenerationDraftReviewState>().toEqualTypeOf<"pending" | "approved" | "rejected">();
    expectTypeOf<GenerationDraftApplyState>().toEqualTypeOf<"not-ready" | "ready" | "applied">();
  });

  it("requires validation truth to match bounded error issues", () => {
    const error = { path: ["enemies", 0], code: "missing-template", severity: "error", message: "Template is missing" } as const;
    expect(generationDraftValidationSchema.parse({ valid: false, issues: [error], validatedAt: at }).issues).toEqual([error]);
    expect(generationDraftValidationSchema.safeParse({ valid: true, issues: [error], validatedAt: at }).success).toBe(false);
    expect(generationDraftValidationSchema.safeParse({ valid: false, issues: [], validatedAt: at }).success).toBe(false);
    expect(generationDraftValidationSchema.safeParse({ valid: true, issues: [], validatedAt: at, extra: true }).success).toBe(false);
  });

  it("structurally separates safe metadata from staged generated content", () => {
    const privateDraft = { ...base, principalId: "gm", stagedContent: { gmSecret: "hidden", enemies: [] },
      validation: { valid: true, issues: [], validatedAt: at }, reviewDecision: null, receiptLinks: [], applyReceipt: null } as const;
    expect(privateGenerationDraftSchema.parse(privateDraft)).toEqual(privateDraft);
    expect(roleSafeGenerationDraftSchema.safeParse(privateDraft).success).toBe(false);
    const safe = { ...base, validationSummary: { valid: true, errorCount: 0, warningCount: 0 }, receiptLinks: [], applyReceiptId: null } as const;
    expect(roleSafeGenerationDraftSchema.parse(safe)).toEqual(safe);
    expect(JSON.stringify(safe)).not.toContain("gmSecret");
  });
});
