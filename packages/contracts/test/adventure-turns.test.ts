import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MAX_ADVENTURE_TURN_TOOLS, adventureTurnStateSchema, confirmationDecisionSchema, narrationStatusSchema,
  appendToolProposalInputSchema, privateAdventureTurnSchema, providerCallMetadataSchema, roleSafeAdventureTurnSchema, toolProposalSchema,
  type AdventureTurnState, type ConfirmationDecisionKind, type NarrationStatus,
} from "../src/adventure-turns.js";

const at = "2035-01-01T00:00:00.000Z";
const later = "2035-01-01T00:00:01.000Z";
const base = { turnId: "turn", campaignId: "campaign", timelineId: "timeline", sessionId: "session", actorId: "actor",
  principalId: "principal", mode: "original" as const, priorTurnId: null, state: "declared" as const, narrationStatus: "none" as const,
  revision: 0, campaignRevision: 1, createdAt: at, updatedAt: at };

describe("M1.10 adventure-turn contracts", () => {
  it("publishes exhaustive closed lifecycle vocabularies", () => {
    expect(adventureTurnStateSchema.options).toEqual(["declared", "proposed", "awaiting-confirmation", "confirmed", "mechanics-committed", "narrating", "completed", "cancelled", "failed"]);
    expect(narrationStatusSchema.options).toEqual(["none", "pending", "in-progress", "completed", "failed"]);
    expectTypeOf<AdventureTurnState>().toEqualTypeOf<"declared" | "proposed" | "awaiting-confirmation" | "confirmed" | "mechanics-committed" | "narrating" | "completed" | "cancelled" | "failed">();
    expectTypeOf<NarrationStatus>().toEqualTypeOf<"none" | "pending" | "in-progress" | "completed" | "failed">();
    expectTypeOf<ConfirmationDecisionKind>().toEqualTypeOf<"approved" | "rejected" | "expired">();
  });

  it("strictly validates mutation inputs and cross-field confirmation timing", () => {
    const input = { turnId: "turn", expectedTurnRevision: 0, expectedCampaignRevision: 1, idempotencyKey: "proposal",
      toolName: "roll", arguments: {}, requiresConfirmation: true, confirmationExpiresAt: later };
    expect(appendToolProposalInputSchema.parse(input)).toEqual(input);
    expect(appendToolProposalInputSchema.safeParse({ ...input, confirmationExpiresAt: null }).success).toBe(false);
    expect(appendToolProposalInputSchema.safeParse({ ...input, extra: true }).success).toBe(false);
  });

  it("bounds strict tool proposals and confirmation expiry", () => {
    const proposal = { proposalId: "proposal", position: 0, toolName: "roll", argumentsJson: "{}", proposedAt: at,
      confirmation: { state: "pending", expiresAt: later } } as const;
    expect(toolProposalSchema.parse(proposal)).toEqual(proposal);
    for (const invalid of [{ ...proposal, position: MAX_ADVENTURE_TURN_TOOLS }, { ...proposal, argumentsJson: "[]" },
      { ...proposal, secret: true }]) expect(toolProposalSchema.safeParse(invalid).success).toBe(false);
    const decision = { decisionId: "decision", proposalId: "proposal", principalId: "principal", decision: "approved",
      expectedTurnRevision: 2, idempotencyKey: "decision-key", expiresAt: later, decidedAt: at } as const;
    expect(confirmationDecisionSchema.parse(decision)).toEqual(decision);
    expect(confirmationDecisionSchema.safeParse({ ...decision, decision: "expired" }).success).toBe(false);
    expect(confirmationDecisionSchema.safeParse({ ...decision, decision: "approved", decidedAt: later }).success).toBe(false);
  });

  it("requires append-phase-specific provider metadata", () => {
    const started = { recordId: "record", callId: "call", phase: "started", provider: "provider", model: "model", attempt: 1,
      promptTokens: null, completionTokens: null, outcomeCode: null, recordedAt: at } as const;
    expect(providerCallMetadataSchema.parse(started)).toEqual(started);
    expect(providerCallMetadataSchema.safeParse({ ...started, promptTokens: 1 }).success).toBe(false);
    expect(providerCallMetadataSchema.safeParse({ ...started, phase: "succeeded" }).success).toBe(false);
    expect(providerCallMetadataSchema.safeParse({ ...started, phase: "failed", outcomeCode: "timeout", extra: true }).success).toBe(false);
  });

  it("structurally separates role-safe and private projections", () => {
    const proposal = { proposalId: "proposal", position: 0, toolName: "roll", argumentsJson: "{\"secret\":true}", proposedAt: at,
      confirmation: { state: "not-required" } } as const;
    const privateTurn = { ...base, declaration: "I inspect the seal", toolCalls: [{ proposal, status: "approved", receiptLinks: [] }],
      providerCalls: [], receiptLinks: [] } as const;
    expect(privateAdventureTurnSchema.parse(privateTurn)).toEqual(privateTurn);
    expect(roleSafeAdventureTurnSchema.safeParse(privateTurn).success).toBe(false);
    const safe = { ...base, proposals: [{ proposalId: "proposal", position: 0, toolName: "roll", proposedAt: at,
      confirmation: { state: "not-required" } }], receiptLinks: [] } as const;
    expect(roleSafeAdventureTurnSchema.parse(safe)).toEqual(safe);
    expect(JSON.stringify(safe)).not.toContain("secret");
  });
});
