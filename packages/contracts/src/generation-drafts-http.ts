import { z } from "zod";
import { generationDraftStateSchema, generationValidationIssueSchema } from "./generation-drafts.js";
import { encounterNameSchema } from "./encounters-http.js";
import { combatTeamSchema } from "./encounters.js";
import { enemyTemplateCatalogReferenceSchema } from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { campaignIdSchema } from "./rpg-characters.js";

/** Maximum enemy instances in a generated encounter. */
export const MAX_GENERATED_ENCOUNTER_COMBATANTS = 32;
/** Closed difficulty guidance. It never authorizes new mechanics. */
export const encounterDifficultyPolicySchema = z.enum(["easy", "standard", "hard"]);

/** The only caller input accepted for typed encounter generation. */
export const generationDraftCreateRequestSchema = z.object({
  campaignId: campaignIdSchema,
  sessionId: resourceIdSchema,
  brief: z.string().trim().min(1).max(2_000),
  visibleLocation: z.string().trim().min(1).max(500),
  tone: z.string().trim().min(1).max(200),
  difficulty: encounterDifficultyPolicySchema,
  partyActorIds: z.array(resourceIdSchema).min(1).max(16).refine((ids) => new Set(ids).size === ids.length, "party actors must be unique"),
  pinnedEnemyTemplates: z.array(enemyTemplateCatalogReferenceSchema).min(1).max(16)
    .refine((values) => new Set(values.map((value) => `${value.packId}\0${value.packVersion}\0${value.definitionId}`)).size === values.length, "pinned enemy templates must be unique"),
  exclusions: z.array(z.string().trim().min(1).max(200)).max(16),
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** A provider may select only an ordinal from the request's pinned definitions. */
export const generatedEncounterEnemySchema = z.object({
  pinnedEnemyIndex: z.number().int().min(0).max(15),
  count: z.number().int().min(1).max(MAX_GENERATED_ENCOUNTER_COMBATANTS),
}).strict();

/** Strict, reviewable encounter content. Runtime statistics and rewards stay server-owned. */
export const generatedEncounterDraftSchema = z.object({
  name: encounterNameSchema,
  combatants: z.array(generatedEncounterEnemySchema).min(1).max(16),
  terrain: z.string().trim().min(1).max(1_000),
  motives: z.string().trim().min(1).max(1_000),
  rewardNarrative: z.string().trim().min(1).max(1_000),
}).strict().superRefine((value, context) => {
  if (value.combatants.reduce((total, entry) => total + entry.count, 0) > MAX_GENERATED_ENCOUNTER_COMBATANTS) {
    context.addIssue({ code: "custom", path: ["combatants"], message: "generated combatants exceed the encounter limit" });
  }
});

/** Provider-facing response is deliberately identity-free and validates before mapping pins. */
export const generatedEncounterProviderResponseSchema = generatedEncounterDraftSchema;

/** Stored draft maps ordinal provider choices back to exact pinned references. */
export const stagedEncounterGenerationSchema = z.object({
  kind: z.literal("encounter"),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  sessionId: resourceIdSchema,
  partyActorIds: z.array(resourceIdSchema).min(1).max(16),
  encounter: z.object({
    name: encounterNameSchema,
    combatants: z.array(z.object({ kind: z.literal("enemy"), template: enemyTemplateCatalogReferenceSchema, team: combatTeamSchema }).strict()).min(1).max(MAX_GENERATED_ENCOUNTER_COMBATANTS),
    terrain: z.string().trim().min(1).max(1_000),
    motives: z.string().trim().min(1).max(1_000),
    rewardNarrative: z.string().trim().min(1).max(1_000),
  }).strict(),
}).strict();

/** HTTP preview deliberately omits pinned catalog and actor identities. */
export const generatedEncounterPreviewSchema = z.object({
  name: encounterNameSchema,
  enemyCount: z.number().int().min(1).max(MAX_GENERATED_ENCOUNTER_COMBATANTS),
  terrain: z.string().trim().min(1).max(1_000),
  motives: z.string().trim().min(1).max(1_000),
  rewardNarrative: z.string().trim().min(1).max(1_000),
}).strict();

/** Role-safe durable draft metadata; `applied` seals review selection only and never proves a campaign mutation. */
export const generationDraftHttpProjectionSchema = z.object({
  draftId: resourceIdSchema,
  campaignId: campaignIdSchema,
  kind: z.literal("encounter"),
  state: generationDraftStateSchema,
  revision: revisionSchema,
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict();

/** Exact staged draft read/create response. */
export const generationDraftGetResponseSchema = z.object({
  draft: generationDraftHttpProjectionSchema,
  encounter: generatedEncounterPreviewSchema,
  validationIssues: z.array(generationValidationIssueSchema).max(256),
}).strict();
export const generationDraftCreateResponseSchema = generationDraftGetResponseSchema;

/** GM confirmation applies the exact reviewed draft at the named session. */
export const generationDraftApplyRequestSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** Draft-specific receipt proving the exact reviewed selection; it is not a campaign command receipt. */
export const generationDraftHttpReceiptSchema = z.object({
  receiptId: resourceIdSchema,
  reviewDecisionId: resourceIdSchema,
  scope: z.literal("encounter"),
  encounterId: resourceIdSchema,
  appliedAt: utcIsoTimestampSchema,
}).strict();

/** Exact apply response with only draft-specific receipts. */
export const generationDraftApplyResponseSchema = z.object({
  draft: generationDraftHttpProjectionSchema,
  application: z.object({ scope: z.literal("encounter"), campaignDomainMutated: z.literal(true), encounterId: resourceIdSchema }).strict(),
  receipts: z.tuple([generationDraftHttpReceiptSchema]),
}).strict();

export type GenerationDraftCreateRequest = z.infer<typeof generationDraftCreateRequestSchema>;
export type GenerationDraftGetResponse = z.infer<typeof generationDraftGetResponseSchema>;
export type GenerationDraftApplyRequest = z.infer<typeof generationDraftApplyRequestSchema>;
export type GenerationDraftApplyResponse = z.infer<typeof generationDraftApplyResponseSchema>;
