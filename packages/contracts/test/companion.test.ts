import { describe, expect, expectTypeOf, it } from "vitest";
import {
  COMPANION_GRANT_EXERCISE_UNAVAILABLE,
  companionAdministrationCommandSchema,
  companionAdministrationReceiptSchema,
  companionCommandFamilySchema,
  companionDecisionSchema,
  companionGrantManagementProjectionSchema,
  companionGrantPublicProjectionSchema,
  companionGrantSchema,
  companionProposalPublicProjectionSchema,
  companionProposalSchema,
  createCompanionGrantInputSchema,
  createCompanionInputSchema,
  revokeCompanionGrantInputSchema,
  type CompanionCommandFamily,
} from "../src/companion.js";

const at = "2035-01-01T00:00:00.000Z";
const later = "2035-01-02T00:00:00.000Z";
const digest = "a".repeat(64);
const policy = {
  version: "v1" as const,
  category: "companion-change" as const,
  requiresConfirmation: true,
  requiredAuthorizer: "controller" as const,
  review: { summary: "Use the companion ability.", consequences: [{ kind: "campaign-change" as const, text: "The campaign state may change." }] },
  proposedCommandDigest: digest,
  observedDomains: [{ domain: "companion", revision: 1 }],
  attestedAt: at,
};
const command = { family: "power-use" as const, actorScope: { kind: "campaign-actor" as const, actorId: "actor" },
  resourceScope: { kind: "powers" as const }, arguments: { powerId: "power" } };
const grant = {
  grantId: "grant", campaignId: "campaign", npcId: "npc", grantedByPrincipalId: "owner", granteePrincipalId: "grantee",
  allowedCommandFamilies: ["power-use", "rest"] as const,
  actorScope: { kind: "campaign-actor" as const, actorId: "actor" }, resourceScope: { kind: "powers" as const },
  maxSpend: 20, maxUses: 3, startsAt: at, expiresAt: later, revokedAt: null, revocationReason: null,
  confirmationPolicy: "domain-policy" as const, createdAt: at,
};

describe("M5.2 companion core contracts", () => {
  it("closes companion command families and retains exact proposer-owned review data", () => {
    expect(companionCommandFamilySchema.options).toEqual([
      "travel", "rest", "power-use", "inventory-consume", "inventory-transfer", "purchase", "currency-transfer",
      "combat-action", "world-change", "quest-change", "story-change",
    ]);
    expectTypeOf<CompanionCommandFamily>().toEqualTypeOf<typeof companionCommandFamilySchema._output>();
    const proposal = { proposalId: "proposal", campaignId: "campaign", sessionId: "session", npcId: "npc",
      proposer: { kind: "provider" as const, providerCallId: "provider-call" }, command, commandDigest: digest,
      policy, policyDigest: "b".repeat(64), confirmationState: "pending" as const, proposedAt: at };
    expect(companionProposalSchema.parse(proposal)).toEqual(proposal);
    expect(companionProposalSchema.parse({ ...proposal, command: { ...command, actorScope: { kind: "none" } } }))
      .toMatchObject({ command: { actorScope: { kind: "none" } } });
    expect(companionProposalSchema.safeParse({ ...proposal, command: { ...command, actorScope: undefined, actorId: "npc" } }).success).toBe(false);
    expect(companionProposalSchema.safeParse({ ...proposal, commandDigest: "b".repeat(64) }).success).toBe(false);
    expect(companionProposalSchema.safeParse({ ...proposal, authorityPrincipalId: "provider" }).success).toBe(false);

    const decision = { decisionId: "decision", proposalId: "proposal", campaignId: "campaign", npcId: "npc",
      decidedByPrincipalId: "owner", decision: "approved" as const, reviewedCommandFamily: "power-use" as const,
      reviewedCommandDigest: digest, reviewedPolicyDigest: "b".repeat(64),
      resultingReceipt: { receiptId: "receipt", proposalId: "proposal", decisionId: "decision",
        commandId: "command", commandFamily: "power-use" as const,
        payload: { resultingRevision: 2 }, payloadDigest: digest, occurredAt: later }, decidedAt: later };
    expect(companionDecisionSchema.parse(decision)).toEqual(decision);
    expect(companionDecisionSchema.safeParse({ ...decision, decision: "rejected" }).success).toBe(false);
    expect(companionDecisionSchema.safeParse({ ...decision, resultingReceipt: { ...decision.resultingReceipt, commandFamily: "rest" } }).success).toBe(false);
  });

  it("requires bounded closed grants with scope, limits, timing, revocation, and non-bypass confirmation", () => {
    expect(companionGrantSchema.parse(grant)).toEqual(grant);
    for (const invalid of [
      { ...grant, allowedCommandFamilies: ["arbitrary-command"] },
      { ...grant, allowedCommandFamilies: ["rest", "rest"] },
      { ...grant, actorScope: { kind: "none" } },
      { ...grant, resourceScope: { kind: "restricted", resourceIds: ["opaque"] } },
      { ...grant, expiresAt: at },
      { ...grant, confirmationPolicy: "never" },
      { ...grant, revokedAt: later },
      { ...grant, granteePrincipalId: "owner" },
    ]) expect(companionGrantSchema.safeParse(invalid).success).toBe(false);
    expect(companionGrantSchema.parse({ ...grant, revokedAt: later, revocationReason: "Owner revoked access." })).toMatchObject({ revokedAt: later });
  });

  it("freezes exact revisioned administration command and receipt contracts", () => {
    const administration = { commandId: "command", campaignId: "campaign", npcId: "npc", principalId: "owner",
      kind: "grant-create" as const, idempotencyKey: "grant", expectedRevision: 1, resultingRevision: 2,
      payload: { grantId: "grant" }, payloadDigest: digest, createdAt: at };
    expect(companionAdministrationCommandSchema.parse(administration)).toEqual(administration);
    expect(companionAdministrationCommandSchema.safeParse({ ...administration, resultingRevision: 3 }).success).toBe(false);
    expect(companionAdministrationCommandSchema.safeParse({ ...administration, kind: "grant-exercise" }).success).toBe(false);
    const receipt = { receiptId: "receipt", commandId: "command", campaignId: "campaign", npcId: "npc",
      idempotencyKey: "grant", kind: "grant-create" as const, resultingRevision: 2, commandPayloadDigest: digest,
      outcome: { grantId: "grant" }, outcomeDigest: digest, occurredAt: at };
    expect(companionAdministrationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(companionAdministrationReceiptSchema.safeParse({ ...receipt, callerPrincipalId: "spoof" }).success).toBe(false);
  });

  it("keeps management identity private and makes pre-L5 exercise explicitly unavailable", () => {
    const management = { ...grant, exercise: COMPANION_GRANT_EXERCISE_UNAVAILABLE };
    expect(companionGrantManagementProjectionSchema.parse(management)).toEqual(management);
    const publicGrant = { commandFamilies: ["power-use"], startsAt: at, expiresAt: later, revokedAt: null,
      exercise: COMPANION_GRANT_EXERCISE_UNAVAILABLE };
    expect(companionGrantPublicProjectionSchema.parse(publicGrant)).toEqual(publicGrant);
    expect(companionGrantPublicProjectionSchema.safeParse({ ...publicGrant, grantId: "grant" }).success).toBe(false);
    expect(companionGrantPublicProjectionSchema.safeParse({ ...publicGrant, granteePrincipalId: "grantee" }).success).toBe(false);
    expect(companionGrantPublicProjectionSchema.safeParse({ ...publicGrant, exercise: { available: true } }).success).toBe(false);

    const safeProposal = { commandFamily: "power-use", confirmationState: "pending", policy: {
      version: policy.version, category: policy.category, requiresConfirmation: true, requiredAuthorizer: "controller",
      review: policy.review,
    }, proposedAt: at };
    expect(companionProposalPublicProjectionSchema.parse(safeProposal)).toEqual(safeProposal);
    expect(companionProposalPublicProjectionSchema.safeParse({ ...safeProposal, proposer: { kind: "provider", providerCallId: "private" } }).success).toBe(false);
  });

  it("accepts target grantees but rejects caller principals and impersonation in administration inputs", () => {
    const create = { sessionId: "session", npcId: "npc", expectedRevision: 0, idempotencyKey: "create" };
    expect(createCompanionInputSchema.parse(create)).toEqual(create);
    const createGrant = { npcId: grant.npcId, granteePrincipalId: grant.granteePrincipalId,
      allowedCommandFamilies: grant.allowedCommandFamilies, actorScope: grant.actorScope, resourceScope: grant.resourceScope,
      maxSpend: grant.maxSpend, maxUses: grant.maxUses, startsAt: grant.startsAt, expiresAt: grant.expiresAt,
      confirmationPolicy: grant.confirmationPolicy,
      expectedRevision: 1, idempotencyKey: "grant" };
    expect(createCompanionGrantInputSchema.parse(createGrant)).toEqual({
      npcId: grant.npcId, granteePrincipalId: grant.granteePrincipalId, allowedCommandFamilies: grant.allowedCommandFamilies,
      actorScope: grant.actorScope, resourceScope: grant.resourceScope, maxSpend: grant.maxSpend, maxUses: grant.maxUses,
      startsAt: grant.startsAt, expiresAt: grant.expiresAt,
      confirmationPolicy: grant.confirmationPolicy, expectedRevision: 1, idempotencyKey: "grant",
    });
    const revoke = { npcId: "npc", grantId: "grant", reason: "No longer needed.", expectedRevision: 2, idempotencyKey: "revoke" };
    expect(revokeCompanionGrantInputSchema.parse(revoke)).toEqual(revoke);
    for (const input of [create, createGrant, revoke]) {
      expect((input === create ? createCompanionInputSchema : input === revoke ? revokeCompanionGrantInputSchema : createCompanionGrantInputSchema)
        .safeParse({ ...input, callerPrincipalId: "spoof" }).success).toBe(false);
      expect((input === create ? createCompanionInputSchema : input === revoke ? revokeCompanionGrantInputSchema : createCompanionGrantInputSchema)
        .safeParse({ ...input, impersonatePrincipalId: "spoof" }).success).toBe(false);
    }
  });
});
