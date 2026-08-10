import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MAX_ADVENTURE_TURN_TOOLS, adventureTurnStateSchema, confirmationDecisionSchema, narrationStatusSchema,
  appendToolProposalInputSchema, privateAdventureTurnSchema, providerCallMetadataSchema, roleSafeAdventureTurnSchema, toolProposalSchema,
  type AdventureTurnState, type ConfirmationDecisionKind, type NarrationStatus,
} from "../src/adventure-turns.js";
import { roleSafeConfirmationPolicySchema } from "../src/confirmation-policy.js";

const at = "2035-01-01T00:00:00.000Z";
const later = "2035-01-01T00:00:01.000Z";
const safePolicy={version:"v1" as const,category:"ambiguous-consequential-change" as const,requiresConfirmation:true,
  requiredAuthorizer:"controller" as const,review:{summary:"Review a consequential change.",consequences:[{kind:"campaign-change" as const,text:"Campaign state may change"}]}};
const policy={...safePolicy,proposedCommandDigest:"a".repeat(64),observedDomains:[{domain:"timeline",revision:0}],attestedAt:at};
const base = { turnId: "turn", campaignId: "campaign", timelineId: "timeline", sessionId: "session", actorId: "actor",
  principalId: "principal", mode: "original" as const, priorTurnId: null, state: "declared" as const, narrationStatus: "none" as const,
  revision: 0, campaignRevision: 1, createdAt: at, updatedAt: at };

describe("M1.10 adventure-turn contracts", () => {
  it("structurally rejects opaque identities in confirmation display text",()=>{
    expect(roleSafeConfirmationPolicySchema.safeParse({...safePolicy,review:{...safePolicy.review,
      summary:"Change 123e4567-e89b-12d3-a456-426614174000"}}).success).toBe(false);
    expect(roleSafeConfirmationPolicySchema.safeParse({...safePolicy,review:{...safePolicy.review,
      consequences:[{kind:"campaign-change",text:"Digest "+"a".repeat(64)}]}}).success).toBe(false);
  });
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
    expect(appendToolProposalInputSchema.safeParse({ ...input, executionBinding: { idempotencyKey: "caller-owned" } }).success).toBe(false);
    expect(appendToolProposalInputSchema.safeParse({ ...input, extra: true }).success).toBe(false);
  });

  it("bounds strict tool proposals and confirmation expiry", () => {
    const executionBinding = { idempotencyKey: "mechanics-key", commandType: "roll_actor_dice" as const, campaignId: "campaign",
      timelineId: "timeline", actorId: "actor", sourceTurnId: "turn" };
    const proposal = { proposalId: "proposal", position: 0, toolName: "roll", argumentsJson: "{}", proposedAt: at, executionBinding,policy,
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
      executionBinding: { idempotencyKey: "private-key", commandType: "roll_actor_dice", campaignId: "campaign", timelineId: "timeline", actorId: "actor", sourceTurnId: "turn" },policy:{...policy,requiresConfirmation:false,category:"deterministic-roll" as const},
      confirmation: { state: "not-required" } } as const;
    const privateTurn = { ...base, declaration: "I inspect the seal", toolCalls: [{ proposal, status: "approved", receiptLinks: [] }],
      providerCalls: [], receiptLinks: [] } as const;
    expect(privateAdventureTurnSchema.parse(privateTurn)).toEqual(privateTurn);
    expect(roleSafeAdventureTurnSchema.safeParse(privateTurn).success).toBe(false);
    const {principalId:_principalId,...safeBase}=base;const safe = { ...safeBase, proposals: [{ proposalId: "proposal", position: 0, toolName: "roll", proposedAt: at,policy:{...safePolicy,requiresConfirmation:false,category:"deterministic-roll" as const},
      confirmation: { state: "not-required" } }], receiptLinks: [] } as const;
    expect(roleSafeAdventureTurnSchema.parse(safe)).toEqual(safe);
    expect(JSON.stringify(safe)).not.toMatch(/secret|private-key|executionBinding|principalId/);
  });

  it("allows only a strict subset of approved proposal receipts while confirmed", () => {
    const decision = (proposalId: string) => ({ state: "decided" as const, decision: { decisionId: `decision-${proposalId}`,
      proposalId, principalId: "principal", decision: "approved" as const, expectedTurnRevision: 2,
      idempotencyKey: `decision-${proposalId}`, expiresAt: later, decidedAt: at } });
    const proposal = (proposalId: string, position: number) => ({ proposalId, position, toolName: "roll", argumentsJson: "{}",
       proposedAt: at,policy, executionBinding: { idempotencyKey: `key-${proposalId}`, commandType: "roll_actor_dice" as const,
        campaignId: "campaign", timelineId: "timeline", actorId: "actor", sourceTurnId: "turn" }, confirmation: decision(proposalId) });
    const link = (proposalId: string) => ({ linkId: `link-${proposalId}`, campaignId: "campaign", commandId: `command-${proposalId}`,
      proposalId, sourceTurnId: "turn", linkedAt: at });
    const firstLink = link("one");
    const partial = { ...base, state: "confirmed" as const, declaration: "I inspect the seal",
      toolCalls: [{ proposal: proposal("one", 0), status: "committed" as const, receiptLinks: [firstLink] },
        { proposal: proposal("two", 1), status: "approved" as const, receiptLinks: [] }],
      providerCalls: [], receiptLinks: [firstLink] };
    expect(privateAdventureTurnSchema.parse(partial)).toEqual(partial);
    expect(privateAdventureTurnSchema.safeParse({ ...partial, state: "mechanics-committed", narrationStatus: "pending" }).success).toBe(false);
    expect(privateAdventureTurnSchema.safeParse({ ...partial, state: "proposed" }).success).toBe(false);
    const secondLink = link("two");
    const complete = { ...partial, state: "mechanics-committed" as const, narrationStatus: "pending" as const,
      toolCalls: [partial.toolCalls[0], { ...partial.toolCalls[1], status: "committed" as const, receiptLinks: [secondLink] }],
      receiptLinks: [firstLink, secondLink] };
    expect(privateAdventureTurnSchema.parse(complete)).toEqual(complete);
  });
});
