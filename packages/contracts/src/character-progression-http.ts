import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";
import {
  applyCharacterProgressionInputSchema,
  progressionLevelChangeSchema,
  progressionPendingChoiceSchema,
  progressionProfileSchema,
  progressionSelectionSchema,
  progressionModeSchema,
  progressionReceiptSchema,
} from "./character-progression.js";
import { characterDerivedStatsSchema } from "./character-builder.js";

/** HTTP deliberately does not publish actor, sheet, controller, or command IDs. */
export const characterProgressionHttpStateSchema = z.object({
  campaignId: resourceIdSchema,
  campaignCharacterId: resourceIdSchema,
  profile: progressionProfileSchema,
  classRef: z.object({
    kind: z.literal("class"), packId: resourceIdSchema, packVersion: z.string().min(1), definitionId: resourceIdSchema,
  }).strict(),
  level: z.number().int().min(1).max(20),
  totalXp: z.number().int().min(0).max(9_007_199_254_740_991),
  milestoneCount: z.number().int().min(0).max(19),
  revision: z.number().int().min(0),
  pendingChoices: z.array(progressionPendingChoiceSchema).max(32),
  knownAbilities: z.array(z.object({ kind: z.literal("ability"), packId: resourceIdSchema, packVersion: z.string().min(1), definitionId: resourceIdSchema }).strict()).max(128),
  knownSpells: z.array(z.object({ kind: z.literal("spell"), packId: resourceIdSchema, packVersion: z.string().min(1), definitionId: resourceIdSchema }).strict()).max(128),
  derived: characterDerivedStatsSchema,
  updatedAt: z.string().datetime({ offset: false, precision: 3 }),
}).strict();

export const characterProgressionHttpStateResponseSchema = z.object({ progression: characterProgressionHttpStateSchema }).strict();

/** The opaque preview fields are required unchanged by the apply request. */
export const characterProgressionHttpPreviewSchema = z.object({
  campaignId: resourceIdSchema,
  campaignCharacterId: resourceIdSchema,
  previewRevision: applyCharacterProgressionInputSchema.shape.previewRevision,
  previewToken: applyCharacterProgressionInputSchema.shape.previewToken,
  mode: progressionModeSchema,
  currentLevel: z.number().int().min(1).max(20),
  eligibleLevel: z.number().int().min(1).max(20),
  totalXp: z.number().int().min(0).max(9_007_199_254_740_991),
  milestoneCount: z.number().int().min(0).max(19),
  pendingChoices: z.array(progressionPendingChoiceSchema).max(32),
  levels: z.array(progressionLevelChangeSchema).max(19),
}).strict();

export const characterProgressionHttpPreviewRequestSchema = z.object({
  selections: z.array(progressionSelectionSchema).max(32),
}).strict();
export const characterProgressionHttpPreviewResponseSchema = z.object({ preview: characterProgressionHttpPreviewSchema }).strict();

/** Apply accepts only the optimistic preview proof and caller selections. */
export const characterProgressionHttpApplyRequestSchema = applyCharacterProgressionInputSchema;

/** Apply receipts omit command and repository-state identities; the response carries public state. */
export const characterProgressionHttpApplyReceiptSchema = z.object({
  campaignCharacterId: progressionReceiptSchema.shape.campaignCharacterId,
  idempotencyKey: progressionReceiptSchema.shape.idempotencyKey,
  type: z.literal("apply-levels"),
  revisionBefore: progressionReceiptSchema.shape.revisionBefore,
  revisionAfter: progressionReceiptSchema.shape.revisionAfter,
  occurredAt: progressionReceiptSchema.shape.occurredAt,
  appliedLevels: progressionReceiptSchema.shape.appliedLevels,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1,
  "progression apply advances exactly one revision");
export const characterProgressionHttpApplyResponseSchema = z.object({
  progression: characterProgressionHttpStateSchema,
  receipt: characterProgressionHttpApplyReceiptSchema,
}).strict();

export type CharacterProgressionHttpState = z.infer<typeof characterProgressionHttpStateSchema>;
export type CharacterProgressionHttpPreview = z.infer<typeof characterProgressionHttpPreviewSchema>;
export type CharacterProgressionHttpPreviewRequest = z.infer<typeof characterProgressionHttpPreviewRequestSchema>;
export type CharacterProgressionHttpApplyRequest = z.infer<typeof characterProgressionHttpApplyRequestSchema>;
export type CharacterProgressionHttpApplyReceipt = z.infer<typeof characterProgressionHttpApplyReceiptSchema>;
export type CharacterProgressionHttpApplyResponse = z.infer<typeof characterProgressionHttpApplyResponseSchema>;
