import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema, principalIdSchema } from "./rpg-characters.js";

/** Maximum number of tool proposals or calls retained by one adventure turn. */
export const MAX_ADVENTURE_TURN_TOOLS = 32;
/** Maximum serialized tool-argument size represented by the domain contract. */
export const MAX_TOOL_ARGUMENT_JSON_LENGTH = 32_768;
/** Durable adventure-turn lifecycle states. */
export const adventureTurnStateSchema = z.enum(["declared", "proposed", "awaiting-confirmation", "mechanics-committed", "narrating", "completed", "cancelled", "failed"]);
/** Narration progress tracked independently from committed mechanics. */
export const narrationStatusSchema = z.enum(["none", "pending", "in-progress", "completed", "failed"]);
/** Identifies an original declaration or narration-only derivative. */
export const adventureTurnModeSchema = z.enum(["original", "narration-retry", "narration-swipe"]);
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

/** Participant-safe turn projection without declaration, arguments, or provider metadata. */
export const roleSafeAdventureTurnSchema = z.object({
  ...turnBase,
  proposals: z.array(roleSafeToolProposalSchema).max(MAX_ADVENTURE_TURN_TOOLS),
  receiptLinks: z.array(finalReceiptLinkSchema).max(MAX_ADVENTURE_TURN_TOOLS),
}).strict();

/** Authorized private turn projection used by the controller and owner/GM lanes. */
export const privateAdventureTurnSchema = z.object({
  ...turnBase,
  declaration: z.string().trim().min(1).max(8_000),
  toolCalls: z.array(toolCallSchema).max(MAX_ADVENTURE_TURN_TOOLS),
  providerCalls: z.array(providerCallMetadataSchema).max(64),
  receiptLinks: z.array(finalReceiptLinkSchema).max(MAX_ADVENTURE_TURN_TOOLS),
}).strict();

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
