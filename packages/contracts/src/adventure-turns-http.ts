import { z } from "zod";
import { confirmationDecisionKindSchema, narrationStatusSchema, roleSafeToolProposalSchema } from "./adventure-turns.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";

/** Maximum number of validated events emitted by one adventure-turn stream. */
export const MAX_ADVENTURE_STREAM_SEQUENCE = 1_000_000;
/** Opaque, bounded token issued only after a durable confirmation decision. */
export const adventureTurnResumeTokenSchema = z.string().min(16).max(512).regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

/** Exact initial declaration accepted by the adventure stream. */
export const adventureTurnInitialStreamRequestSchema = z.object({
  campaignId: campaignIdSchema,
  sessionId: resourceIdSchema,
  actorId: actorIdSchema,
  declaration: z.string().trim().min(1).max(8_000),
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** Separately issued durable continuation accepted by the same stream route. */
export const adventureTurnResumeStreamRequestSchema = z.object({ resumeToken: adventureTurnResumeTokenSchema }).strict();
/** Initial declaration or durable continuation; the variants cannot overlap. */
export const adventureTurnStreamRequestSchema = z.union([
  adventureTurnInitialStreamRequestSchema,
  adventureTurnResumeStreamRequestSchema,
]);

/** Public turn metadata. Provider calls, tool arguments, and principal IDs are structurally absent. */
export const adventureTurnHttpProjectionSchema = z.object({
  turnId: resourceIdSchema,
  campaignId: campaignIdSchema,
  sessionId: resourceIdSchema,
  actorId: actorIdSchema,
  declaration: z.string().trim().min(1).max(8_000),
  state: z.enum(["declared", "proposed", "awaiting-confirmation", "confirmed", "mechanics-committed", "narrating", "completed", "cancelled", "failed"]),
  revision: revisionSchema,
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict();

/** Public projection of one exact proposal-bound mechanics receipt. */
export const adventureTurnPublicReceiptSchema = z.object({
  commandId: resourceIdSchema,
  proposalId: resourceIdSchema,
  linkedAt: utcIsoTimestampSchema,
}).strict();

/** Aggregate confirmation state without private tool arguments. */
export const adventureTurnHttpConfirmationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z.object({ state: z.literal("pending"), proposalIds: z.array(resourceIdSchema).min(1).max(32), expiresAt: utcIsoTimestampSchema }).strict(),
  z.object({ state: z.literal("decided"), decisions: z.array(z.object({ proposalId: resourceIdSchema,
    decision: confirmationDecisionKindSchema, decidedAt: utcIsoTimestampSchema }).strict()).min(1).max(32) }).strict(),
]);

/** Durable narration reconciliation state, including deterministic fallback text when available. */
export const adventureTurnHttpNarrationStatusSchema = z.object({
  status: narrationStatusSchema,
  text: z.string().min(1).max(8_000).nullable(),
}).strict();

/** Exact role-safe reconciliation response for an adventure turn. */
export const adventureTurnGetResponseSchema = z.object({
  turn: adventureTurnHttpProjectionSchema,
  proposals: z.array(roleSafeToolProposalSchema).max(32),
  confirmation: adventureTurnHttpConfirmationSchema,
  receipts: z.array(adventureTurnPublicReceiptSchema).max(32),
  narrationStatus: adventureTurnHttpNarrationStatusSchema,
}).strict();

/** Exact plural confirmation command bound to one observed turn revision. */
export const adventureTurnConfirmRequestSchema = z.object({
  proposalIds: z.array(resourceIdSchema).min(1).max(32).refine((ids) => new Set(ids).size === ids.length, "proposal IDs must be unique"),
  decision: z.enum(["approve", "reject"]),
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** Confirmation result; approved pending work receives a restart-safe continuation token. */
export const adventureTurnConfirmResponseSchema = z.object({
  turn: adventureTurnHttpProjectionSchema,
  resumeToken: adventureTurnResumeTokenSchema.optional(),
}).strict();

const streamSequenceSchema = z.number().int().min(0).max(MAX_ADVENTURE_STREAM_SEQUENCE);
const streamEnvelope = <K extends string, T extends z.ZodType>(type: K, payload: T) => z.object({
  type: z.literal(type), sequence: streamSequenceSchema, timestamp: utcIsoTimestampSchema, payload,
}).strict();

/** A stream has durably created or recovered its turn. */
export const adventureTurnStartedEventSchema = streamEnvelope("turn_started", z.object({ turn: adventureTurnHttpProjectionSchema }).strict());
/** Reviewed, non-sensitive coordination status. */
export const adventureTurnAgentStatusEventSchema = streamEnvelope("agent_status", z.object({
  status: z.enum(["planning", "awaiting-confirmation", "pending-mechanics", "narrating"]),
}).strict());
/** Public proposal event without arguments or provider internals. */
export const adventureTurnToolProposedEventSchema = streamEnvelope("tool_proposed", z.object({ proposal: roleSafeToolProposalSchema }).strict());
/** Durable confirmation boundary for one or more exact proposals. */
export const adventureTurnConfirmationRequiredEventSchema = streamEnvelope("confirmation_required", z.object({
  proposalIds: z.array(resourceIdSchema).min(1).max(32), expiresAt: utcIsoTimestampSchema,
}).strict());
/** Mechanics event containing only durable, proposal-linked public receipts. */
export const adventureTurnMechanicsCommittedEventSchema = streamEnvelope("mechanics_committed", z.object({
  receipts: z.array(adventureTurnPublicReceiptSchema).min(1).max(32),
}).strict());
/** One bounded piece of persisted or safely derived narration. */
export const adventureTurnNarrationDeltaEventSchema = streamEnvelope("narration_delta", z.object({ text: z.string().min(1).max(8_000) }).strict());
/** One explicit, non-executable next choice. */
export const adventureTurnChoiceEventSchema = streamEnvelope("choice", z.object({ choiceId: resourceIdSchema, label: z.string().trim().min(1).max(500) }).strict());
/** The single central terminal event for every opened stream. */
export const adventureTurnTerminalEventSchema = streamEnvelope("terminal", z.object({
  outcome: z.enum(["done", "aborted", "error"]),
  turn: adventureTurnHttpProjectionSchema,
  narrationStatus: adventureTurnHttpNarrationStatusSchema,
  receipts: z.array(adventureTurnPublicReceiptSchema).max(32),
}).strict());

/** Closed discriminated SSE vocabulary. Every envelope is parsed before framing. */
export const adventureTurnStreamEventSchema = z.discriminatedUnion("type", [
  adventureTurnStartedEventSchema, adventureTurnAgentStatusEventSchema, adventureTurnToolProposedEventSchema,
  adventureTurnConfirmationRequiredEventSchema, adventureTurnMechanicsCommittedEventSchema,
  adventureTurnNarrationDeltaEventSchema, adventureTurnChoiceEventSchema, adventureTurnTerminalEventSchema,
]);

export type AdventureTurnStreamRequest = z.infer<typeof adventureTurnStreamRequestSchema>;
export type AdventureTurnGetResponse = z.infer<typeof adventureTurnGetResponseSchema>;
export type AdventureTurnConfirmRequest = z.infer<typeof adventureTurnConfirmRequestSchema>;
export type AdventureTurnStreamEvent = z.infer<typeof adventureTurnStreamEventSchema>;
