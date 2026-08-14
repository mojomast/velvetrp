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
import { campaignCharacterSchema, campaignCharacterSheetSchema } from "./rpg-characters.js";
import { actorResourceStateSchema } from "./rpg-resources.js";

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
export const rerollCharacterDraftHttpInputSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** Finalization uses the route's draft identity and does not expose progression policy yet. */
export const finalizeCharacterDraftHttpInputSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const characterDraftHttpReceiptSchema = z.object({
  draftId: resourceIdSchema, idempotencyKey: idempotencyKeySchema,
  type: z.enum(["create", "update"]), revisionBefore: revisionSchema,
  revisionAfter: revisionSchema, occurredAt: utcIsoTimestampSchema,
}).strict();
export const characterDraftHttpMutationResultSchema = z.object({
  draft: characterDraftHttpViewSchema, receipt: characterDraftHttpReceiptSchema,
}).strict();

/** Finalization returns playable public state without persona, actor, or audit identities. */
export const characterDraftHttpFinalizationCharacterSchema = campaignCharacterSchema.omit({
  campaignId: true,
  characterId: true,
});
export const characterDraftHttpFinalizationSheetSchema = z.object({
  id: campaignCharacterSheetSchema.shape.id,
  race: campaignCharacterSheetSchema.shape.race,
  background: campaignCharacterSheetSchema.shape.background,
  classes: campaignCharacterSheetSchema.shape.classes,
  attributes: campaignCharacterSheetSchema.shape.attributes,
  proficiencies: campaignCharacterSheetSchema.shape.proficiencies,
  choices: campaignCharacterSheetSchema.shape.choices,
  createdAt: campaignCharacterSheetSchema.shape.createdAt,
  updatedAt: campaignCharacterSheetSchema.shape.updatedAt,
}).strict();
export const characterDraftHttpFinalizationResourcesSchema = z.tuple([
  actorResourceStateSchema.safeExtend({ name: z.literal("health") }),
]);
export const characterDraftHttpFinalizationReceiptSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
  derived: characterDerivedStatsSchema,
  startingGrants: z.array(characterStartingGrantSchema).max(64),
}).strict().superRefine((receipt, context) => {
  if (receipt.revisionAfter !== receipt.revisionBefore + 1) {
    context.addIssue({ code: "custom", message: "finalization receipt revision must advance exactly once", path: ["revisionAfter"] });
  }
});
export const characterDraftHttpFinalizationResultSchema = z.object({
  character: characterDraftHttpFinalizationCharacterSchema,
  sheet: characterDraftHttpFinalizationSheetSchema,
  resources: characterDraftHttpFinalizationResourcesSchema,
  receipt: characterDraftHttpFinalizationReceiptSchema,
}).strict().superRefine((result, context) => {
  const [health] = result.resources;
  if (health.current !== result.receipt.derived.maxHp || health.max !== result.receipt.derived.maxHp) {
    context.addIssue({ code: "custom", message: "health must be initialized to derived max HP", path: ["resources", 0] });
  }
});

export type CharacterDraftHttpView = z.infer<typeof characterDraftHttpViewSchema>;
export type CreateCharacterDraftHttpInput = z.infer<typeof createCharacterDraftHttpInputSchema>;
export type UpdateCharacterDraftHttpInput = z.infer<typeof updateCharacterDraftHttpInputSchema>;
export type RerollCharacterDraftHttpInput = z.infer<typeof rerollCharacterDraftHttpInputSchema>;
export type FinalizeCharacterDraftHttpInput = z.infer<typeof finalizeCharacterDraftHttpInputSchema>;
export type CharacterDraftHttpFinalizationCharacter = z.infer<typeof characterDraftHttpFinalizationCharacterSchema>;
export type CharacterDraftHttpFinalizationSheet = z.infer<typeof characterDraftHttpFinalizationSheetSchema>;
export type CharacterDraftHttpFinalizationResources = z.infer<typeof characterDraftHttpFinalizationResourcesSchema>;
export type CharacterDraftHttpFinalizationReceipt = z.infer<typeof characterDraftHttpFinalizationReceiptSchema>;
export type CharacterDraftHttpFinalizationResult = z.infer<typeof characterDraftHttpFinalizationResultSchema>;
