import { z } from "zod";
import { agentArgumentObjectSchema, agentResultObjectSchema, canonicalSha256DigestSchema } from "./agent-execution.js";
import { campaignSessionAttachmentSchema } from "./campaigns.js";
import { confirmationPolicyAttestationSchema, roleSafeConfirmationPolicySchema } from "./confirmation-policy.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema, principalIdSchema } from "./rpg-characters.js";
import { npcIdSchema } from "./world.js";

export const MAX_COMPANION_GRANT_COMMAND_FAMILIES = 16;

export const companionCommandFamilySchema = z.enum([
  "travel", "rest", "power-use", "inventory-consume", "inventory-transfer",
  "purchase", "currency-transfer", "combat-action", "world-change", "quest-change", "story-change",
]);
export const companionStateSchema = z.enum(["active", "dismissed"]);
export const companionProposalConfirmationStateSchema = z.enum([
  "not-required", "pending", "approved", "rejected", "expired", "cancelled",
]);

/** An NPC companion remains a sidecar identity; a mechanical actor is an optional, explicit campaign relation. */
export const companionProposalActorScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("campaign-actor"), actorId: actorIdSchema }).strict(),
]);

/** Closed coarse resource categories avoid unverifiable polymorphic resource IDs. */
export const companionResourceScopeKindSchema = z.enum([
  "none", "actor-resources", "wallet", "inventory", "powers",
]);
export const companionGrantResourceScopeSchema = z.object({ kind: companionResourceScopeKindSchema }).strict();

/** Providers can propose, but proposer identity never conveys command authority. */
export const companionProposerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("campaign-principal"), principalId: principalIdSchema }).strict(),
  z.object({ kind: z.literal("companion"), npcId: npcIdSchema }).strict(),
  z.object({ kind: z.literal("provider"), providerCallId: resourceIdSchema }).strict(),
  z.object({ kind: z.literal("system"), source: resourceIdSchema }).strict(),
]);

export const companionProposedCommandSchema = z.object({
  family: companionCommandFamilySchema,
  actorScope: companionProposalActorScopeSchema,
  resourceScope: companionGrantResourceScopeSchema,
  arguments: agentArgumentObjectSchema,
}).strict();

export const companionProposalSchema = z.object({
  proposalId: resourceIdSchema,
  campaignId: campaignIdSchema,
  sessionId: campaignSessionAttachmentSchema.shape.sessionId,
  npcId: npcIdSchema,
  proposer: companionProposerSchema,
  command: companionProposedCommandSchema,
  commandDigest: canonicalSha256DigestSchema,
  policy: confirmationPolicyAttestationSchema,
  policyDigest: canonicalSha256DigestSchema,
  confirmationState: companionProposalConfirmationStateSchema,
  proposedAt: utcIsoTimestampSchema,
}).strict().superRefine((proposal, context) => {
  if (proposal.commandDigest !== proposal.policy.proposedCommandDigest) {
    context.addIssue({ code: "custom", path: ["commandDigest"], message: "proposal and policy command digests must agree" });
  }
  if (proposal.policy.requiresConfirmation !== (proposal.confirmationState !== "not-required")) {
    context.addIssue({ code: "custom", path: ["confirmationState"], message: "confirmation state must agree with policy" });
  }
});

export const companionResultingReceiptSchema = z.object({
  receiptId: resourceIdSchema,
  proposalId: resourceIdSchema,
  decisionId: resourceIdSchema,
  commandId: resourceIdSchema,
  commandFamily: companionCommandFamilySchema,
  payload: agentResultObjectSchema,
  payloadDigest: canonicalSha256DigestSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict();

/** Decision references identify the immutable proposal command and policy; exact JSON is read from that proposal. */
export const companionDecisionSchema = z.object({
  decisionId: resourceIdSchema,
  proposalId: resourceIdSchema,
  campaignId: campaignIdSchema,
  npcId: npcIdSchema,
  decidedByPrincipalId: principalIdSchema,
  decision: z.enum(["approved", "rejected", "expired", "cancelled"]),
  reviewedCommandFamily: companionCommandFamilySchema,
  reviewedCommandDigest: canonicalSha256DigestSchema,
  reviewedPolicyDigest: canonicalSha256DigestSchema,
  resultingReceipt: companionResultingReceiptSchema.nullable(),
  decidedAt: utcIsoTimestampSchema,
}).strict().superRefine((decision, context) => {
  if (decision.resultingReceipt !== null && decision.decision !== "approved") {
    context.addIssue({ code: "custom", path: ["resultingReceipt"], message: "only approved decisions can have a resulting receipt" });
  }
  if (decision.resultingReceipt !== null && (decision.resultingReceipt.proposalId !== decision.proposalId
      || decision.resultingReceipt.decisionId !== decision.decisionId
      || decision.resultingReceipt.commandFamily !== decision.reviewedCommandFamily)) {
    context.addIssue({ code: "custom", path: ["resultingReceipt"], message: "receipt must match the reviewed decision" });
  }
});

export const companionGrantActorScopeSchema = z.object({
  kind: z.literal("campaign-actor"),
  actorId: actorIdSchema,
}).strict();
export const companionGrantConfirmationPolicySchema = z.enum(["always", "domain-policy"]);

const grantDefinitionFields = {
  granteePrincipalId: principalIdSchema,
  allowedCommandFamilies: z.array(companionCommandFamilySchema).min(1).max(MAX_COMPANION_GRANT_COMMAND_FAMILIES)
    .refine((families) => new Set(families).size === families.length, "grant command families must be unique"),
  actorScope: companionGrantActorScopeSchema,
  resourceScope: companionGrantResourceScopeSchema,
  maxSpend: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  maxUses: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  startsAt: utcIsoTimestampSchema,
  expiresAt: utcIsoTimestampSchema,
  confirmationPolicy: companionGrantConfirmationPolicySchema,
};

const refineGrantTime = (grant: { startsAt: string; expiresAt: string }, context: z.RefinementCtx) => {
  if (grant.expiresAt <= grant.startsAt) context.addIssue({ code: "custom", path: ["expiresAt"], message: "grant expiry must follow its start" });
};

export const companionGrantSchema = z.object({
  grantId: resourceIdSchema,
  campaignId: campaignIdSchema,
  npcId: npcIdSchema,
  grantedByPrincipalId: principalIdSchema,
  ...grantDefinitionFields,
  revokedAt: utcIsoTimestampSchema.nullable(),
  revocationReason: z.string().trim().min(1).max(500).nullable(),
  createdAt: utcIsoTimestampSchema,
}).strict().superRefine((grant, context) => {
  refineGrantTime(grant, context);
  if (grant.grantedByPrincipalId === grant.granteePrincipalId) {
    context.addIssue({ code: "custom", path: ["granteePrincipalId"], message: "companion grants cannot be self-grants" });
  }
  if ((grant.revokedAt === null) !== (grant.revocationReason === null)) {
    context.addIssue({ code: "custom", path: ["revocationReason"], message: "grant revocation time and reason must be set together" });
  }
});

export const companionAdministrationCommandKindSchema = z.enum(["companion-create", "grant-create", "grant-revoke"]);
export const companionAdministrationCommandSchema = z.object({
  commandId: resourceIdSchema,
  campaignId: campaignIdSchema,
  npcId: npcIdSchema,
  principalId: principalIdSchema,
  kind: companionAdministrationCommandKindSchema,
  idempotencyKey: idempotencyKeySchema,
  expectedRevision: expectedRevisionSchema,
  resultingRevision: revisionSchema.min(1),
  payload: agentArgumentObjectSchema,
  payloadDigest: canonicalSha256DigestSchema,
  createdAt: utcIsoTimestampSchema,
}).strict().refine((command) => command.resultingRevision === command.expectedRevision + 1, {
  path: ["resultingRevision"], message: "companion commands advance revision exactly once",
});

export const companionAdministrationReceiptSchema = z.object({
  receiptId: resourceIdSchema,
  commandId: resourceIdSchema,
  campaignId: campaignIdSchema,
  npcId: npcIdSchema,
  idempotencyKey: idempotencyKeySchema,
  kind: companionAdministrationCommandKindSchema,
  resultingRevision: revisionSchema.min(1),
  commandPayloadDigest: canonicalSha256DigestSchema,
  outcome: agentResultObjectSchema,
  outcomeDigest: canonicalSha256DigestSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict();

export const companionGrantExerciseAvailabilitySchema = z.object({
  available: z.literal(false),
  reason: z.literal("requires-authenticated-principal-boundary-l5"),
}).strict();
export const COMPANION_GRANT_EXERCISE_UNAVAILABLE = Object.freeze({
  available: false, reason: "requires-authenticated-principal-boundary-l5",
} as const);

export const companionGrantManagementProjectionSchema = companionGrantSchema.extend({
  exercise: companionGrantExerciseAvailabilitySchema,
}).strict();
export const companionGrantPublicProjectionSchema = z.object({
  commandFamilies: z.array(companionCommandFamilySchema).min(1).max(MAX_COMPANION_GRANT_COMMAND_FAMILIES)
    .refine((families) => new Set(families).size === families.length, "public command families must be unique"),
  startsAt: utcIsoTimestampSchema,
  expiresAt: utcIsoTimestampSchema,
  revokedAt: utcIsoTimestampSchema.nullable(),
  exercise: companionGrantExerciseAvailabilitySchema,
}).strict();

export const companionManagementProjectionSchema = z.object({
  campaignId: campaignIdSchema,
  sessionId: campaignSessionAttachmentSchema.shape.sessionId,
  npcId: npcIdSchema,
  state: companionStateSchema,
  revision: revisionSchema.min(1),
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
  grants: z.array(companionGrantManagementProjectionSchema).max(1_000),
}).strict();
export const companionPublicProjectionSchema = z.object({
  npcId: npcIdSchema,
  state: companionStateSchema,
  grants: z.array(companionGrantPublicProjectionSchema).max(1_000),
}).strict();
export const companionProposalPublicProjectionSchema = z.object({
  commandFamily: companionCommandFamilySchema,
  confirmationState: companionProposalConfirmationStateSchema,
  policy: roleSafeConfirmationPolicySchema,
  proposedAt: utcIsoTimestampSchema,
}).strict();

/** Local administration inputs never accept caller identity or impersonation. */
export const createCompanionInputSchema = z.object({
  sessionId: campaignSessionAttachmentSchema.shape.sessionId,
  npcId: npcIdSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();
export const createCompanionGrantInputSchema = z.object({
  npcId: npcIdSchema,
  ...grantDefinitionFields,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine(refineGrantTime);
export const revokeCompanionGrantInputSchema = z.object({
  npcId: npcIdSchema,
  grantId: resourceIdSchema,
  reason: z.string().trim().min(1).max(500),
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export type CompanionCommandFamily = z.infer<typeof companionCommandFamilySchema>;
export type CompanionProposal = z.infer<typeof companionProposalSchema>;
export type CompanionDecision = z.infer<typeof companionDecisionSchema>;
export type CompanionGrant = z.infer<typeof companionGrantSchema>;
export type CompanionAdministrationCommand = z.infer<typeof companionAdministrationCommandSchema>;
export type CompanionAdministrationReceipt = z.infer<typeof companionAdministrationReceiptSchema>;
export type CompanionGrantManagementProjection = z.infer<typeof companionGrantManagementProjectionSchema>;
export type CompanionGrantPublicProjection = z.infer<typeof companionGrantPublicProjectionSchema>;
export type CompanionManagementProjection = z.infer<typeof companionManagementProjectionSchema>;
export type CompanionPublicProjection = z.infer<typeof companionPublicProjectionSchema>;
export type CreateCompanionInput = z.infer<typeof createCompanionInputSchema>;
export type CreateCompanionGrantInput = z.infer<typeof createCompanionGrantInputSchema>;
export type RevokeCompanionGrantInput = z.infer<typeof revokeCompanionGrantInputSchema>;
