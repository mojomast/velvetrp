import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

export const campaignDmControlSchema = z.object({
  campaignId: resourceIdSchema, mode: z.enum(["human", "ai"]), revision: revisionSchema,
}).strict();
export const campaignDmModeRequestSchema = z.object({
  mode: z.enum(["human", "ai"]), expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
export const campaignDmBeatRequestSchema = z.object({
  intent: z.enum(["open", "continue"]), expectedModeRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema, evidenceTurnId: resourceIdSchema.optional(),
}).strict();
export const campaignDmSelectionSchema = z.object({
  candidateId: resourceIdSchema, digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
/** Ordered beat composition. Candidates are exact and unique; order is the execution order. */
export const campaignDmCompositionSchema = z.array(campaignDmSelectionSchema).min(1).max(3)
  .refine(items => new Set(items.map(item => item.candidateId)).size === items.length, { message: "composition candidates must be unique" })
  .refine(items => new Set(items.map(item => item.digest)).size === items.length, { message: "composition digests must be unique" });
export const campaignDmDecisionRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]), expectedRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();
export const campaignDmResumeRequestSchema = z.object({}).strict();
/** Explicit GM-authored semantic binding; providers and players cannot author these relationships. */
export const campaignDmSceneBindingRequestSchema = z.object({
  nodeId: resourceIdSchema,
  evidence: z.object({ kind: z.enum(["check-turn", "quest-objective", "encounter"]), targetId: resourceIdSchema }).strict(),
  expectedStoryRevision: revisionSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
export type CampaignDmSceneBindingRequest = z.infer<typeof campaignDmSceneBindingRequestSchema>;
export const campaignDmActionSchema = z.enum([
  "encounter-start", "encounter-materialize", "enemy-turn", "encounter-complete",
  "reveal-node", "resolve-node", "reveal-clue",
  // Transition beats: server-authored time advance (a receipt, never LLM-authored) and pure ambiance (no state change).
  "advance-time", "ambient-beat",
  // Free-form travel: the server authors one bounded location+connection candidate from the
  // player's declaration; the model may only select it and the apply carries a durable receipt.
  "materialize-location",
  // Free-form materialization: the server authors one bounded candidate from the player's
  // declaration (a person, a clue, an encounter) or from an explicit merchant context; the model
  // may only select it and the apply carries a durable receipt. Shop candidates are admitted by
  // the gate but not currently advertised from a declaration (see campaignDmRepo).
  "materialize-npc", "materialize-lore", "materialize-shop", "materialize-encounter",
]);
export const campaignDmCandidateSchema = campaignDmSelectionSchema.extend({
  action: campaignDmActionSchema, label: z.string().min(1).max(500),
}).strict();
export const campaignDmRunSchema = z.object({
  runId: resourceIdSchema, campaignId: resourceIdSchema, sessionId: resourceIdSchema,
  intent: z.enum(["open", "continue"]), mode: z.enum(["human", "ai"]), modeRevision: revisionSchema,
  revision: revisionSchema,
  state: z.enum(["planning", "awaiting-approval", "completed", "blocked", "cancelled", "unknown"]),
  narration: z.string().max(8000).nullable(),
  receipts: z.array(z.object({ action: campaignDmActionSchema, summary: z.string().max(4000) }).strict()).max(3),
  blockers: z.array(z.string().max(200)).max(16),
  createdAt: utcIsoTimestampSchema,
}).strict();
// Only the GM endpoint returns this schema; player history never contains proposals.
export const campaignDmPrivateRunSchema = z.object({
  run: campaignDmRunSchema, proposal: campaignDmCandidateSchema.nullable(),
  composition: z.array(campaignDmCandidateSchema).max(3).default([]),
}).strict();
export const campaignDmHistorySchema = z.object({
  control: campaignDmControlSchema, runs: z.array(campaignDmRunSchema).max(50),
}).strict();
export type CampaignDmControl = z.infer<typeof campaignDmControlSchema>;
export type CampaignDmModeRequest = z.infer<typeof campaignDmModeRequestSchema>;
export type CampaignDmBeatRequest = z.infer<typeof campaignDmBeatRequestSchema>;
export type CampaignDmDecisionRequest = z.infer<typeof campaignDmDecisionRequestSchema>;
export type CampaignDmSelection = z.infer<typeof campaignDmSelectionSchema>;
export type CampaignDmComposition = z.infer<typeof campaignDmCompositionSchema>;
export type CampaignDmCandidate = z.infer<typeof campaignDmCandidateSchema>;
export type CampaignDmRun = z.infer<typeof campaignDmRunSchema>;
export type CampaignDmHistory = z.infer<typeof campaignDmHistorySchema>;
export type CampaignDmPrivateRun = z.infer<typeof campaignDmPrivateRunSchema>;
