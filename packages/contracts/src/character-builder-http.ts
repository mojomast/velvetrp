import { z } from "zod";
import {
  characterBuilderAllocationRequestSchema,
  characterBuilderSelectionPatchSchema,
  characterBuilderAllocationSchema,
  characterBuilderSelectionsSchema,
  characterBuilderChoiceGroupSchema,
  characterBuilderCompletionSchema,
  characterDerivedStatsSchema,
  characterDraftDurabilitySchema,
  characterDraftStatusSchema,
  characterDraftPinSchema,
  characterStartingGrantSchema,
} from "./character-builder.js";
import { contentPackIdSchema, contentPackVersionSchema, rulesProfileIdSchema } from "./rpg-content.js";
import { contentDigestSchema } from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

/** The HTTP draft deliberately excludes controller identity, role, and audit command ids. */
export const characterDraftHttpViewSchema = z.object({
  id: resourceIdSchema, campaignId: resourceIdSchema, personaId: resourceIdSchema,
  status: characterDraftStatusSchema, durability: characterDraftDurabilitySchema,
  expiresAt: utcIsoTimestampSchema.nullable(), effectivelyExpired: z.boolean(), revision: revisionSchema,
  rulesProfileId: rulesProfileIdSchema,
  pins: z.array(z.object({ packId: contentPackIdSchema, packVersion: contentPackVersionSchema, publicationDigest: contentDigestSchema }).strict()).min(1).max(32),
  allocation: characterBuilderAllocationSchema, selections: characterBuilderSelectionsSchema,
  choiceGroups: z.array(characterBuilderChoiceGroupSchema).length(4), completion: characterBuilderCompletionSchema,
  derivedPreview: characterDerivedStatsSchema.nullable(), startingGrants: z.array(characterStartingGrantSchema).max(64),
  createdAt: utcIsoTimestampSchema, updatedAt: utcIsoTimestampSchema,
}).strict();

export const createCharacterDraftHttpInputSchema = z.object({
  personaId: resourceIdSchema, durability: characterDraftDurabilitySchema,
  allocation: characterBuilderAllocationRequestSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
export const updateCharacterDraftHttpInputSchema = z.object({
  expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
  selections: characterBuilderSelectionPatchSchema,
}).strict();

export const characterDraftHttpReceiptSchema = z.object({
  draftId: resourceIdSchema, idempotencyKey: idempotencyKeySchema,
  type: z.enum(["create", "update"]), revisionBefore: revisionSchema,
  revisionAfter: revisionSchema, occurredAt: utcIsoTimestampSchema,
}).strict();
export const characterDraftHttpMutationResultSchema = z.object({
  draft: characterDraftHttpViewSchema, receipt: characterDraftHttpReceiptSchema,
}).strict();

export type CharacterDraftHttpView = z.infer<typeof characterDraftHttpViewSchema>;
export type CreateCharacterDraftHttpInput = z.infer<typeof createCharacterDraftHttpInputSchema>;
export type UpdateCharacterDraftHttpInput = z.infer<typeof updateCharacterDraftHttpInputSchema>;
