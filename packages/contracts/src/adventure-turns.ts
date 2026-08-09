import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema, principalIdSchema } from "./rpg-characters.js";

/** Maximum number of tool proposals or calls retained by one adventure turn. */
export const MAX_ADVENTURE_TURN_TOOLS = 32;
/** Maximum serialized tool-argument size represented by the domain contract. */
export const MAX_TOOL_ARGUMENT_JSON_LENGTH = 32_768;
/** Durable adventure-turn lifecycle states. */
export const adventureTurnStateSchema = z.enum(["declared", "proposed", "awaiting-confirmation", "confirmed", "mechanics-committed", "narrating", "completed", "cancelled", "failed"]);
/** Narration progress tracked independently from committed mechanics. */
export const narrationStatusSchema = z.enum(["none", "pending", "in-progress", "completed", "failed"]);
/** Identifies an original declaration or narration-only derivative. */
export const adventureTurnModeSchema = z.enum(["original", "narration-retry", "narration-swipe", "narration-fallback"]);
/** Closed confirmation decision vocabulary. */
export const confirmationDecisionKindSchema = z.enum(["approved", "rejected", "expired"]);
/** Closed tool-call progress vocabulary. */
export const toolCallStatusSchema = z.enum(["proposed", "waiting-confirmation", "approved", "rejected", "expired", "committed", "cancelled"]);
/** Closed provider-call append record phases. */
export const providerCallPhaseSchema = z.enum(["started", "succeeded", "failed", "cancelled"]);

/** Immutable link from a turn or draft to one committed mechanics receipt. */
export const finalReceiptLinkSchema = z.object({
  linkId: resourceIdSchema,
  campaignId: campaignIdSchema,
  commandId: resourceIdSchema,
  proposalId: resourceIdSchema.nullable(),
  sourceTurnId: resourceIdSchema.nullable(),
  linkedAt: utcIsoTimestampSchema,
}).strict();

/** Immutable human decision for one exact confirmation-required proposal. */
export const confirmationDecisionSchema = z.object({
  decisionId: resourceIdSchema,
  proposalId: resourceIdSchema,
  principalId: principalIdSchema,
  decision: confirmationDecisionKindSchema,
  expectedTurnRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
  expiresAt: utcIsoTimestampSchema,
  decidedAt: utcIsoTimestampSchema,
}).strict().superRefine((value, context) => {
  const expired = value.decidedAt >= value.expiresAt;
  if ((value.decision === "expired") !== expired) context.addIssue({ code: "custom", path: ["decidedAt"], message: "decision must respect confirmation expiry" });
});

/** Explicit confirmation state, including the durable expiry boundary. */
export const confirmationStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not-required") }).strict(),
  z.object({ state: z.literal("pending"), expiresAt: utcIsoTimestampSchema }).strict(),
  z.object({ state: z.literal("decided"), decision: confirmationDecisionSchema }).strict(),
]);

/** Full private proposal including provider-bound tool arguments. */
export const toolProposalSchema = z.object({
  proposalId: resourceIdSchema,
  position: z.number().int().min(0).max(MAX_ADVENTURE_TURN_TOOLS - 1),
  toolName: resourceIdSchema,
  argumentsJson: z.string().min(2).max(MAX_TOOL_ARGUMENT_JSON_LENGTH).refine((value) => {
    try { return typeof JSON.parse(value) === "object" && JSON.parse(value) !== null && !Array.isArray(JSON.parse(value)); }
    catch { return false; }
  }, "tool arguments must be a JSON object"),
  proposedAt: utcIsoTimestampSchema,
  confirmation: confirmationStateSchema,
}).strict();

/** Role-safe proposal projection that structurally excludes tool arguments. */
export const roleSafeToolProposalSchema = toolProposalSchema.omit({ argumentsJson: true });

/** Durable bounded tool-call projection and its immutable mechanics links. */
export const toolCallSchema = z.object({
  proposal: toolProposalSchema,
  status: toolCallStatusSchema,
  receiptLinks: z.array(finalReceiptLinkSchema).max(MAX_ADVENTURE_TURN_TOOLS),
}).strict();

/** Append-only metadata record for a provider call start or terminal outcome. */
export const providerCallMetadataSchema = z.object({
  recordId: resourceIdSchema,
  callId: resourceIdSchema,
  phase: providerCallPhaseSchema,
  provider: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  attempt: z.number().int().min(1).max(32),
  promptTokens: z.number().int().min(0).max(1_000_000_000).nullable(),
  completionTokens: z.number().int().min(0).max(1_000_000_000).nullable(),
  outcomeCode: z.string().trim().min(1).max(128).nullable(),
  recordedAt: utcIsoTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.phase === "started" && (value.promptTokens !== null || value.completionTokens !== null || value.outcomeCode !== null)) {
    context.addIssue({ code: "custom", message: "provider start records cannot contain an outcome" });
  }
  if (value.phase !== "started" && value.outcomeCode === null) context.addIssue({ code: "custom", path: ["outcomeCode"], message: "provider outcomes require a code" });
});

const turnBase = {
  turnId: resourceIdSchema, campaignId: campaignIdSchema, timelineId: resourceIdSchema, sessionId: resourceIdSchema,
  actorId: actorIdSchema, principalId: principalIdSchema, mode: adventureTurnModeSchema, priorTurnId: resourceIdSchema.nullable(),
  state: adventureTurnStateSchema, narrationStatus: narrationStatusSchema, revision: revisionSchema,
  campaignRevision: revisionSchema, createdAt: utcIsoTimestampSchema, updatedAt: utcIsoTimestampSchema,
};

const turnStateRefinement = (value: { state: z.infer<typeof adventureTurnStateSchema>; narrationStatus: z.infer<typeof narrationStatusSchema>;
  mode: z.infer<typeof adventureTurnModeSchema>; priorTurnId: string | null; receiptLinks: z.infer<typeof finalReceiptLinkSchema>[] }, context: z.RefinementCtx) => {
  const legalNarration = (value.state === "declared" || value.state === "proposed" || value.state === "awaiting-confirmation" || value.state === "confirmed")
    ? value.narrationStatus === "none"
    : value.state === "mechanics-committed" ? value.narrationStatus === "pending"
      : value.state === "narrating" ? value.narrationStatus === "in-progress" || value.narrationStatus === "failed"
        : value.state === "completed" ? value.narrationStatus === "completed"
          : true;
  if (!legalNarration) context.addIssue({ code: "custom", path: ["narrationStatus"], message: "narration status is inconsistent with turn state" });
  if ((value.mode === "original") !== (value.priorTurnId === null)) context.addIssue({ code: "custom", path: ["priorTurnId"], message: "turn mode and ancestry must agree" });
  if (["mechanics-committed", "narrating", "completed"].includes(value.state) && value.receiptLinks.length === 0
      && !(value.mode === "original" && "proposals" in value && Array.isArray(value.proposals) && value.proposals.length === 0)
      && !(value.mode === "original" && "toolCalls" in value && Array.isArray(value.toolCalls) && value.toolCalls.length === 0)) {
    context.addIssue({ code: "custom", path: ["receiptLinks"], message: "post-proposal narration requires a receipt" });
  }
  if (["declared", "proposed", "awaiting-confirmation"].includes(value.state) && value.receiptLinks.length > 0) {
    context.addIssue({ code: "custom", path: ["receiptLinks"], message: "pre-confirmation turns cannot contain mechanics receipts" });
  }
};

/** Participant-safe turn projection without declaration, arguments, or provider metadata. */
export const roleSafeAdventureTurnSchema = z.object({
  ...turnBase,
  proposals: z.array(roleSafeToolProposalSchema).max(MAX_ADVENTURE_TURN_TOOLS),
  receiptLinks: z.array(finalReceiptLinkSchema).max(MAX_ADVENTURE_TURN_TOOLS),
}).strict().superRefine(turnStateRefinement);

/** Authorized private turn projection used by the controller and owner/GM lanes. */
export const privateAdventureTurnSchema = z.object({
  ...turnBase,
  declaration: z.string().trim().min(1).max(8_000),
  toolCalls: z.array(toolCallSchema).max(MAX_ADVENTURE_TURN_TOOLS),
  providerCalls: z.array(providerCallMetadataSchema).max(64),
  receiptLinks: z.array(finalReceiptLinkSchema).max(MAX_ADVENTURE_TURN_TOOLS),
}).strict().superRefine((value, context) => {
  turnStateRefinement(value, context);
  const pending = value.toolCalls.some((call) => call.proposal.confirmation.state === "pending");
  if (value.state === "awaiting-confirmation" && !pending) context.addIssue({ code: "custom", path: ["state"], message: "waiting state requires a pending confirmation" });
  const committed = value.toolCalls.filter((call) => call.status === "committed");
  const approved = value.toolCalls.filter((call) => call.status === "approved");
  const callLinks = value.toolCalls.flatMap((call) => call.receiptLinks);
  const aggregateLinkIds = [...value.receiptLinks.map((link) => link.linkId)].sort();
  const callLinkIds = [...callLinks.map((link) => link.linkId)].sort();
  if (value.mode === "original" && (JSON.stringify(aggregateLinkIds) !== JSON.stringify(callLinkIds)
      || value.toolCalls.some((call) => call.receiptLinks.some((link) => link.proposalId !== call.proposal.proposalId)))) {
    context.addIssue({ code: "custom", path: ["receiptLinks"], message: "aggregate receipts must be bound to their exact proposal calls" });
  }
  if (["declared", "proposed", "awaiting-confirmation"].includes(value.state) && committed.length > 0) {
    context.addIssue({ code: "custom", path: ["receiptLinks"], message: "pre-confirmation turns cannot contain mechanics receipts" });
  }
  if (value.state === "confirmed" && value.toolCalls.some((call) => !["approved", "committed", "rejected", "expired"].includes(call.status))) {
    context.addIssue({ code: "custom", path: ["toolCalls"], message: "confirmed turns require terminal confirmation decisions" });
  }
  if (value.state === "confirmed" && (approved.length === 0 || committed.length !== value.receiptLinks.length)) {
    context.addIssue({ code: "custom", path: ["toolCalls"], message: "confirmed turns require a strict subset of approved mechanics to remain uncommitted" });
  }
  if (value.mode === "original" && value.state === "mechanics-committed"
      && (approved.length > 0 || committed.length === 0 || committed.length !== value.receiptLinks.length)) {
    context.addIssue({ code: "custom", path: ["toolCalls"], message: "mechanics-committed turns require every approved proposal receipt" });
  }
});

/** Strict optimistic envelope accepted by every turn mutation. */
export const turnMutationInputSchema = z.object({ turnId: resourceIdSchema, expectedTurnRevision: expectedRevisionSchema,
  expectedCampaignRevision: revisionSchema, idempotencyKey: idempotencyKeySchema }).strict();
/** Strict input for an original declaration or narration-only derivative. */
export const createAdventureTurnInputSchema = z.object({ campaignId: campaignIdSchema, timelineId: resourceIdSchema,
  sessionId: resourceIdSchema, actorId: actorIdSchema, declaration: z.string().trim().min(1).max(8_000),
  mode: adventureTurnModeSchema.optional(), priorTurnId: resourceIdSchema.nullable().optional(),
  expectedCampaignRevision: revisionSchema, idempotencyKey: idempotencyKeySchema }).strict().superRefine((value, context) => {
    const mode = value.mode ?? "original";
    if ((mode === "original") !== ((value.priorTurnId ?? null) === null)) context.addIssue({ code: "custom", path: ["priorTurnId"], message: "narration derivatives require priorTurnId" });
  });
/** Strict input for appending one bounded proposal. */
export const appendToolProposalInputSchema = turnMutationInputSchema.extend({ toolName: resourceIdSchema,
  arguments: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= MAX_TOOL_ARGUMENT_JSON_LENGTH, "tool arguments are too large"),
  requiresConfirmation: z.boolean(), confirmationExpiresAt: utcIsoTimestampSchema.nullable().optional() }).strict().superRefine((value, context) => {
    if (value.requiresConfirmation !== (value.confirmationExpiresAt != null)) context.addIssue({ code: "custom", path: ["confirmationExpiresAt"], message: "confirmation expiry is required exactly when confirmation is required" });
  });
/** Strict input for one proposal decision. */
export const decideToolProposalInputSchema = turnMutationInputSchema.extend({ proposalId: resourceIdSchema,
  decision: z.enum(["approved", "rejected"]), expiresAt: utcIsoTimestampSchema }).strict();
/** Strict provider-call start input. */
export const providerCallStartInputSchema = turnMutationInputSchema.extend({ callId: resourceIdSchema,
  provider: z.string().trim().min(1).max(128), model: z.string().trim().min(1).max(256), attempt: z.number().int().min(1).max(32) }).strict();
/** Strict provider-call terminal outcome input. */
export const providerCallOutcomeInputSchema = providerCallStartInputSchema.extend({ outcome: z.enum(["succeeded", "failed", "cancelled"]),
  outcomeCode: z.string().trim().min(1).max(128), promptTokens: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  completionTokens: z.number().int().min(0).max(1_000_000_000).nullable().optional() }).strict();
/** Strict input for linking one exact proposal command receipt. */
export const linkTurnReceiptInputSchema = turnMutationInputSchema.extend({ proposalId: resourceIdSchema, commandId: resourceIdSchema }).strict();
/** Strict input for narration progress and terminal cancellation/failure. */
export const updateTurnNarrationInputSchema = turnMutationInputSchema.extend({ narrationStatus: narrationStatusSchema,
  terminalState: z.enum(["completed", "cancelled", "failed"]).optional(),
  fallbackNarration: z.string().trim().min(1).max(8_000).optional() }).strict().superRefine((value, context) => {
    if (value.terminalState === "completed" && value.narrationStatus !== "completed") context.addIssue({ code: "custom", path: ["narrationStatus"], message: "completed turns require completed narration" });
    if (value.fallbackNarration !== undefined && value.terminalState !== "completed") context.addIssue({ code: "custom", path: ["fallbackNarration"], message: "fallback narration belongs only to terminal completion" });
  });

/** Durable adventure-turn lifecycle state. */
export type AdventureTurnState = z.infer<typeof adventureTurnStateSchema>;
/** Durable narration progress state. */
export type NarrationStatus = z.infer<typeof narrationStatusSchema>;
/** Original or narration-only turn ancestry mode. */
export type AdventureTurnMode = z.infer<typeof adventureTurnModeSchema>;
/** Human confirmation outcome. */
export type ConfirmationDecisionKind = z.infer<typeof confirmationDecisionKindSchema>;
/** Immutable confirmation decision. */
export type ConfirmationDecision = z.infer<typeof confirmationDecisionSchema>;
/** Proposal confirmation state and expiry. */
export type ConfirmationState = z.infer<typeof confirmationStateSchema>;
/** Private tool proposal. */
export type ToolProposal = z.infer<typeof toolProposalSchema>;
/** Role-safe tool proposal. */
export type RoleSafeToolProposal = z.infer<typeof roleSafeToolProposalSchema>;
/** Durable tool call. */
export type ToolCall = z.infer<typeof toolCallSchema>;
/** Append-only provider metadata record. */
export type ProviderCallMetadata = z.infer<typeof providerCallMetadataSchema>;
/** Immutable final receipt link. */
export type FinalReceiptLink = z.infer<typeof finalReceiptLinkSchema>;
/** Participant-safe adventure turn. */
export type RoleSafeAdventureTurn = z.infer<typeof roleSafeAdventureTurnSchema>;
/** Authorized private adventure turn. */
export type PrivateAdventureTurn = z.infer<typeof privateAdventureTurnSchema>;
/** Strict optimistic envelope for turn mutations. */
export type TurnMutationInput = z.infer<typeof turnMutationInputSchema>;
/** Strict turn creation input. */
export type CreateAdventureTurnInput = z.infer<typeof createAdventureTurnInputSchema>;
/** Strict proposal append input. */
export type AppendToolProposalInput = z.infer<typeof appendToolProposalInputSchema>;
/** Strict proposal decision input. */
export type DecideToolProposalInput = z.infer<typeof decideToolProposalInputSchema>;
/** Strict provider start input. */
export type ProviderCallStartInput = z.infer<typeof providerCallStartInputSchema>;
/** Strict provider outcome input. */
export type ProviderCallOutcomeInput = z.infer<typeof providerCallOutcomeInputSchema>;
/** Strict mechanics receipt-link input. */
export type LinkTurnReceiptInput = z.infer<typeof linkTurnReceiptInputSchema>;
/** Strict narration mutation input. */
export type UpdateTurnNarrationInput = z.infer<typeof updateTurnNarrationInputSchema>;
