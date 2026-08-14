import { describe, expect, it } from "vitest";
import {
  adventureTurnConfirmRequestSchema, adventureTurnGetResponseSchema, adventureTurnInitialReconcileRequestSchema,
  adventureTurnStreamEventSchema, adventureTurnStreamRequestSchema,
} from "../src/adventure-turns-http.js";
import { decideToolProposalsInputSchema } from "../src/adventure-turns.js";

const at = "2035-01-01T00:00:00.000Z";
const turn = { turnId: "turn", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: "original", priorTurnId: null, declaration: "I listen",
  state: "declared", revision: 0, createdAt: at, updatedAt: at };

describe("M2.11 adventure turn HTTP contracts", () => {
  it("accepts only exact initial and resume stream variants", () => {
    const initial = { campaignId: "campaign", sessionId: "session", actorId: "actor", declaration: "I listen", expectedRevision: 0, idempotencyKey: "turn" };
    expect(adventureTurnStreamRequestSchema.parse(initial)).toEqual(initial);
    expect(adventureTurnStreamRequestSchema.parse({ resumeToken: "v1.dHVybg.ZGVjaXNpb24" })).toBeTruthy();
    const variant = { variant: "narration-retry", campaignId: "campaign", sessionId: "session", actorId: "actor",
      priorTurnId: "turn", expectedRevision: 2, idempotencyKey: "retry" };
    expect(adventureTurnStreamRequestSchema.parse(variant)).toEqual(variant);
    expect(adventureTurnStreamRequestSchema.safeParse({ ...variant, declaration: "private" }).success).toBe(false);
    expect(adventureTurnStreamRequestSchema.safeParse({ ...initial, resumeToken: "v1.dHVybg.ZGVjaXNpb24" }).success).toBe(false);
  });

  it("keeps reconciliation locators exact and resume tokens role-safe", () => {
    const locator = { campaignId: "campaign", sessionId: "session", actorId: "actor", idempotencyKey: "initial" };
    expect(adventureTurnInitialReconcileRequestSchema.parse(locator)).toEqual(locator);
    expect(adventureTurnInitialReconcileRequestSchema.safeParse({ ...locator, declaration: "secret" }).success).toBe(false);
    expect(adventureTurnGetResponseSchema.parse({ turn, proposals: [], confirmation: { state: "none" }, receipts: [],
      narrationStatus: { status: "completed", text: "Done", source: "provider-assisted" }, resumeToken: "v1.dHVybg.ZGlnZXN0" })).toBeTruthy();
  });

  it("closes and bounds the public SSE vocabulary", () => {
    const event = { type: "turn_started", sequence: 0, timestamp: at, payload: { turn } };
    expect(adventureTurnStreamEventSchema.parse(event)).toEqual(event);
    expect(adventureTurnStreamEventSchema.safeParse({ ...event, provider: "private" }).success).toBe(false);
    expect(adventureTurnStreamEventSchema.safeParse({ ...event, type: "delta" }).success).toBe(false);
  });

  it("requires unique plural proposal IDs and exact decision names", () => {
    const command = { proposalIds: ["one", "two"], decision: "approve", expectedRevision: 2, idempotencyKey: "confirm" };
    expect(adventureTurnConfirmRequestSchema.parse(command)).toEqual(command);
    expect(adventureTurnConfirmRequestSchema.safeParse({ ...command, proposalIds: ["one", "one"] }).success).toBe(false);
    expect(adventureTurnConfirmRequestSchema.safeParse({ ...command, decision: "approved" }).success).toBe(false);
    expect(adventureTurnConfirmRequestSchema.safeParse({ ...command,
      proposalIds: Array.from({ length: 32 }, (_, index) => `proposal-${index}`) }).success).toBe(true);
    expect(adventureTurnConfirmRequestSchema.safeParse({ ...command,
      proposalIds: Array.from({ length: 33 }, (_, index) => `proposal-${index}`) }).success).toBe(false);
    const repositoryCommand = { turnId: "turn", proposalIds: ["one", "two"], decision: "approved",
      expectedTurnRevision: 2, expectedCampaignRevision: 0, idempotencyKey: "confirm" };
    expect(decideToolProposalsInputSchema.parse(repositoryCommand)).toEqual(repositoryCommand);
    expect(decideToolProposalsInputSchema.safeParse({ ...repositoryCommand, proposalIds: ["one", "one"] }).success).toBe(false);
    expect(decideToolProposalsInputSchema.safeParse({ ...repositoryCommand,
      proposalIds: Array.from({ length: 32 }, (_, index) => `proposal-${index}`) }).success).toBe(true);
    expect(decideToolProposalsInputSchema.safeParse({ ...repositoryCommand,
      proposalIds: Array.from({ length: 33 }, (_, index) => `proposal-${index}`) }).success).toBe(false);
  });
});
