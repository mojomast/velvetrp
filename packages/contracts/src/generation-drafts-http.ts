import { z } from "zod";
import { generationDraftKindSchema, generationDraftStateSchema, generationValidationIssueSchema } from "./generation-drafts.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { campaignIdSchema } from "./rpg-characters.js";

/** Maximum number of deterministic review changes staged by the HTTP fallback lane. */
export const MAX_GENERATION_DRAFT_CHANGES = 64;
/** Bounded caller constraints used only as user-authored fallback provenance. */
export const generationDraftConstraintsSchema = z.array(z.string().trim().min(1).max(1_000)).max(64);

/** Exact roadmap create request. It does not claim provider generation. */
export const generationDraftCreateRequestSchema = z.object({
  campaignId: campaignIdSchema,
  kind: generationDraftKindSchema,
  brief: z.string().trim().min(1).max(8_000),
  constraints: generationDraftConstraintsSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** One deterministic, reviewable change derived solely from the caller brief. */
export const generationDraftHttpChangeSchema = z.object({
  changeId: resourceIdSchema,
  summary: z.string().trim().min(1).max(1_000),
  content: z.object({ brief: z.string().trim().min(1).max(8_000), constraints: generationDraftConstraintsSchema }).strict(),
}).strict();

/** Explicit provenance that cannot be mistaken for LLM-generated or applied campaign content. */
export const generationDraftHttpProvenanceSchema = z.object({
  source: z.literal("user-brief"),
  method: z.literal("deterministic-fallback"),
}).strict();

/** Role-safe durable draft metadata. */
export const generationDraftHttpProjectionSchema = z.object({
  draftId: resourceIdSchema,
  campaignId: campaignIdSchema,
  kind: generationDraftKindSchema,
  state: generationDraftStateSchema,
  revision: revisionSchema,
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict();

/** Exact staged draft read/create response. */
export const generationDraftGetResponseSchema = z.object({
  draft: generationDraftHttpProjectionSchema,
  provenance: generationDraftHttpProvenanceSchema,
  changes: z.array(generationDraftHttpChangeSchema).min(1).max(MAX_GENERATION_DRAFT_CHANGES),
  validationIssues: z.array(generationValidationIssueSchema).max(256),
}).strict();
export const generationDraftCreateResponseSchema = generationDraftGetResponseSchema;

/** Exact roadmap apply request selecting only known staged changes. */
export const generationDraftApplyRequestSchema = z.object({
  selectedChanges: z.array(resourceIdSchema).min(1).max(MAX_GENERATION_DRAFT_CHANGES)
    .refine((ids) => new Set(ids).size === ids.length, "selected changes must be unique"),
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** Draft-specific receipt proving the exact reviewed selection; it is not a campaign command receipt. */
export const generationDraftHttpReceiptSchema = z.object({
  receiptId: resourceIdSchema,
  reviewDecisionId: resourceIdSchema,
  selectedChanges: z.array(resourceIdSchema).min(1).max(MAX_GENERATION_DRAFT_CHANGES),
  appliedAt: utcIsoTimestampSchema,
}).strict();

/** Exact apply response with only draft-specific receipts. */
export const generationDraftApplyResponseSchema = z.object({
  draft: generationDraftHttpProjectionSchema,
  receipts: z.tuple([generationDraftHttpReceiptSchema]),
}).strict();

export type GenerationDraftCreateRequest = z.infer<typeof generationDraftCreateRequestSchema>;
export type GenerationDraftGetResponse = z.infer<typeof generationDraftGetResponseSchema>;
export type GenerationDraftApplyRequest = z.infer<typeof generationDraftApplyRequestSchema>;
export type GenerationDraftApplyResponse = z.infer<typeof generationDraftApplyResponseSchema>;
