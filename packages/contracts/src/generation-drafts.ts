import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { finalReceiptLinkSchema } from "./adventure-turns.js";
import { idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { campaignIdSchema, principalIdSchema } from "./rpg-characters.js";

/** Maximum validation issues retained for one generated draft. */
export const MAX_GENERATION_VALIDATION_ISSUES = 256;
/** Closed kinds of content that may be staged for human review. */
export const generationDraftKindSchema = z.enum(["encounter", "location", "npc", "faction", "quest", "storyline", "content-pack"]);
/** Guarded generation-draft lifecycle. */
export const generationDraftStateSchema = z.enum(["staged", "in-review", "approved", "rejected", "applied", "cancelled"]);
/** Review status exposed independently from mutable staged content. */
export const generationDraftReviewStateSchema = z.enum(["pending", "approved", "rejected"]);
/** Apply status proving that approval and command application are distinct. */
export const generationDraftApplyStateSchema = z.enum(["not-ready", "ready", "applied"]);
/** Closed human review decisions. */
export const reviewDecisionKindSchema = z.enum(["approved", "rejected"]);
/** Closed validation issue severity. */
export const generationValidationSeveritySchema = z.enum(["error", "warning"]);

/** One bounded validation issue for staged generated content. */
export const generationValidationIssueSchema = z.object({
  path: z.array(z.union([z.string().max(128), z.number().int().min(0).max(1_000_000)])).max(32),
  code: resourceIdSchema,
  severity: generationValidationSeveritySchema,
  message: z.string().trim().min(1).max(1_000),
}).strict();

/** Validation result stored alongside the exact staged revision. */
export const generationDraftValidationSchema = z.object({
  valid: z.boolean(),
  issues: z.array(generationValidationIssueSchema).max(MAX_GENERATION_VALIDATION_ISSUES),
  validatedAt: utcIsoTimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  const hasError = value.issues.some((issue) => issue.severity === "error");
  if (value.valid === hasError) context.addIssue({ code: "custom", path: ["valid"], message: "valid must be the inverse of validation errors" });
});

/** Staged generated content is an object, never an executable command. */
export const stagedGenerationContentSchema = z.record(z.string().min(1).max(128), z.unknown());

/** Immutable owner/GM review decision for one exact draft revision. */
export const generationReviewDecisionSchema = z.object({
  decisionId: resourceIdSchema,
  principalId: principalIdSchema,
  decision: reviewDecisionKindSchema,
  notes: z.string().max(4_000).nullable(),
  expectedDraftRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
  decidedAt: utcIsoTimestampSchema,
}).strict();

const draftBase = {
  draftId: resourceIdSchema, campaignId: campaignIdSchema, timelineId: resourceIdSchema, sessionId: resourceIdSchema.nullable(),
  kind: generationDraftKindSchema, state: generationDraftStateSchema, reviewState: generationDraftReviewStateSchema,
  applyState: generationDraftApplyStateSchema, revision: revisionSchema, campaignRevision: revisionSchema,
  createdAt: utcIsoTimestampSchema, updatedAt: utcIsoTimestampSchema,
};

/** Role-safe draft projection that structurally excludes generated content and review notes. */
export const roleSafeGenerationDraftSchema = z.object({
  ...draftBase,
  validationSummary: z.object({ valid: z.boolean(), errorCount: z.number().int().min(0).max(MAX_GENERATION_VALIDATION_ISSUES),
    warningCount: z.number().int().min(0).max(MAX_GENERATION_VALIDATION_ISSUES) }).strict(),
  receiptLinks: z.array(finalReceiptLinkSchema).max(256),
}).strict();

/** Authorized owner/GM projection with staged content, validation, review, and apply receipts. */
export const privateGenerationDraftSchema = z.object({
  ...draftBase,
  principalId: principalIdSchema,
  stagedContent: stagedGenerationContentSchema,
  validation: generationDraftValidationSchema,
  reviewDecision: generationReviewDecisionSchema.nullable(),
  receiptLinks: z.array(finalReceiptLinkSchema).max(256),
}).strict();

/** Generated draft content kind. */
export type GenerationDraftKind = z.infer<typeof generationDraftKindSchema>;
/** Guarded draft lifecycle state. */
export type GenerationDraftState = z.infer<typeof generationDraftStateSchema>;
/** Human review state. */
export type GenerationDraftReviewState = z.infer<typeof generationDraftReviewStateSchema>;
/** Deterministic apply state. */
export type GenerationDraftApplyState = z.infer<typeof generationDraftApplyStateSchema>;
/** Validation issue. */
export type GenerationValidationIssue = z.infer<typeof generationValidationIssueSchema>;
/** Exact staged-revision validation result. */
export type GenerationDraftValidation = z.infer<typeof generationDraftValidationSchema>;
/** Non-executable staged generated object. */
export type StagedGenerationContent = z.infer<typeof stagedGenerationContentSchema>;
/** Immutable owner/GM review decision. */
export type GenerationReviewDecision = z.infer<typeof generationReviewDecisionSchema>;
/** Role-safe generation draft. */
export type RoleSafeGenerationDraft = z.infer<typeof roleSafeGenerationDraftSchema>;
/** Authorized private generation draft. */
export type PrivateGenerationDraft = z.infer<typeof privateGenerationDraftSchema>;
