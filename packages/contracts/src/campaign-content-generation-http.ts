import { z } from "zod";
import { campaignIdSchema } from "./rpg-characters.js";
import { idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";

const text = z.string().trim().min(1).max(4_000);
const name = z.string().trim().min(1).max(200);
const visibility = z.enum(["public", "gm"]);
const detailList = z.array(z.string().trim().min(1).max(500)).max(8).default([]);
export const generatedArtifactKeySchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/);

/** Independently generatable sections. None implicitly requires an opening or a location graph. */
export const campaignGenerationSectionSchema = z.enum([
  "outline", "arcs", "locations", "factions", "npcs", "quests", "encounters",
  "clues", "story", "handouts", "scene-prompts",
]);

const retryFailedAttemptSchema = z.object({ failedAttempt: z.number().int().min(1).max(32) }).strict();

/** Prose-only direction. retryFailedAttempt is an explicit acknowledgement of one known failed paid attempt. */
export const campaignContentGenerationRequestSchema = z.object({
  campaignId: campaignIdSchema,
  brief: text.max(2_000),
  tone: name,
  exclusions: z.array(name).max(16),
  idempotencyKey: idempotencyKeySchema,
  sections: z.array(campaignGenerationSectionSchema).min(1).max(11).default([
    "outline", "locations", "factions", "quests", "npcs",
  ]),
  expandArtifactKeys: z.array(generatedArtifactKeySchema).max(16).default([]),
  revisionFeedback: text.max(2_000).nullable().default(null),
  retryFailedAttempt: retryFailedAttemptSchema.nullable().default(null),
}).strict();

const outline = z.object({
  key: generatedArtifactKeySchema, opening: text, premise: text,
  startLocationKey: generatedArtifactKeySchema.optional(), visibility,
}).strict();
const arc = z.object({ key: generatedArtifactKeySchema, title: name, summary: text, visibility }).strict();
const location = z.object({
  key: generatedArtifactKeySchema, name, description: text, visibility,
  atmosphere: text.max(1_000).optional(), discoveries: detailList, hazards: detailList, hooks: detailList,
  factionKeys: z.array(generatedArtifactKeySchema).max(8).default([]),
}).strict();
const connection = z.object({
  key: generatedArtifactKeySchema, fromLocationKey: generatedArtifactKeySchema,
  toLocationKey: generatedArtifactKeySchema, description: text, visibility,
}).strict();
const faction = z.object({ key: generatedArtifactKeySchema, name, description: text, visibility, gmNotes: text.optional() }).strict();
const npc = z.object({
  key: generatedArtifactKeySchema, name, archetype: name, description: text, visibility,
  locationKey: generatedArtifactKeySchema.optional(), factionKeys: z.array(generatedArtifactKeySchema).max(8).default([]),
  privateGoals: text.optional(),
}).strict();
const quest = z.object({
  key: generatedArtifactKeySchema, title: name, description: text, visibility,
  arcKey: generatedArtifactKeySchema.optional(), locationKeys: z.array(generatedArtifactKeySchema).max(8).default([]),
}).strict();
const encounter = z.object({
  key: generatedArtifactKeySchema, title: name, description: text, visibility,
  locationKey: generatedArtifactKeySchema.optional(), participantNpcKeys: z.array(generatedArtifactKeySchema).max(16).default([]),
}).strict();
const clue = z.object({
  key: generatedArtifactKeySchema, title: name, description: text, visibility,
  locationKey: generatedArtifactKeySchema.optional(), revealsStoryNodeKey: generatedArtifactKeySchema.optional(),
}).strict();
const storyNode = z.object({ key: generatedArtifactKeySchema, title: name, description: text, visibility }).strict();
const storyRelationship = z.object({
  key: generatedArtifactKeySchema, fromStoryNodeKey: generatedArtifactKeySchema,
  toStoryNodeKey: generatedArtifactKeySchema, description: text, visibility,
}).strict();
const handout = z.object({ key: generatedArtifactKeySchema, title: name, content: text, visibility }).strict();
const scenePrompt = z.object({
  key: generatedArtifactKeySchema, title: name, prompt: text, visibility,
  locationKey: generatedArtifactKeySchema.optional(), npcKeys: z.array(generatedArtifactKeySchema).max(8).default([]),
}).strict();

/** Strict sparse provider output. Arrays outside the requested sections must be empty. */
export const generatedCampaignContentProviderSchema = z.object({
  outlines: z.array(outline).max(1).default([]),
  arcs: z.array(arc).max(8).default([]),
  locations: z.array(location).max(16).default([]),
  connections: z.array(connection).max(24).default([]),
  factions: z.array(faction).max(12).default([]),
  npcs: z.array(npc).max(16).default([]),
  quests: z.array(quest).max(16).default([]),
  encounters: z.array(encounter).max(16).default([]),
  clues: z.array(clue).max(24).default([]),
  storyNodes: z.array(storyNode).max(24).default([]),
  storyRelationships: z.array(storyRelationship).max(32).default([]),
  handouts: z.array(handout).max(12).default([]),
  scenePrompts: z.array(scenePrompt).max(16).default([]),
}).strict();

const publicFaction = faction.omit({ gmNotes: true });
const publicNpc = npc.omit({ privateGoals: true });
export const campaignContentGenerationPreviewSchema = generatedCampaignContentProviderSchema
  .omit({ factions: true, npcs: true })
  .extend({
    factions: z.array(publicFaction).max(12), npcs: z.array(publicNpc).max(16),
    npcStats: z.object({ body: z.literal(10), mind: z.literal(10), presence: z.literal(10), source: z.literal("generated-deterministic-baseline") }).strict(),
  }).strict();

export const stagedCampaignContentGenerationSchema = generatedCampaignContentProviderSchema.extend({
  kind: z.literal("campaign-content"), requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  baseContentRevision: revisionSchema,
  dependencyDigests: z.record(generatedArtifactKeySchema, z.string().regex(/^[0-9a-f]{64}$/)),
}).strict();

export const campaignContentDraftViewSchema = z.object({
  draft: z.object({
    draftId: resourceIdSchema, campaignId: campaignIdSchema, kind: z.literal("campaign-content"),
    state: z.enum(["staged", "approved", "applied"]), revision: revisionSchema,
    createdAt: utcIsoTimestampSchema, updatedAt: utcIsoTimestampSchema,
  }).strict(),
  preview: campaignContentGenerationPreviewSchema,
  validationIssues: z.array(z.string()),
}).strict();

export const campaignContentApplyRequestSchema = z.object({
  expectedRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
  /** Only these candidate keys are accepted. References must close over accepted canon or this set. */
  selectedArtifactKeys: z.array(generatedArtifactKeySchema).min(1).max(128),
}).strict();
export const campaignContentApplyResponseSchema = z.object({
  draft: campaignContentDraftViewSchema.shape.draft,
  application: z.object({ scope: z.literal("campaign-content"), campaignDomainMutated: z.literal(true), appliedAt: utcIsoTimestampSchema }).strict(),
  receipts: z.array(z.object({ receiptId: resourceIdSchema, scope: z.literal("campaign-content"), appliedAt: utcIsoTimestampSchema }).strict()).length(1),
}).strict();
export const campaignGeneratedFoundationSchema = z.object({
  campaignId: campaignIdSchema, revision: revisionSchema,
  opening: z.object({ opening: text, premise: text, startLocationKey: generatedArtifactKeySchema.optional(), sourceDraftId: resourceIdSchema }).strict().nullable(),
}).strict();

const generatedMaterialBase = z.object({
  artifactKey: generatedArtifactKeySchema,
  resourceId: resourceIdSchema,
  title: name,
  visibility,
  sourceDraftId: resourceIdSchema,
}).strict();

/** GM planning projection. Encounter concepts are inert plans, not combat encounters. */
export const campaignGeneratedPlanningSchema = z.object({
  campaignId: campaignIdSchema,
  deliveryRevision: revisionSchema,
  encounters: z.array(generatedMaterialBase.extend({
    description: text,
    locationId: resourceIdSchema.nullable(),
    participantNpcIds: z.array(resourceIdSchema).max(16),
  }).strict()).max(10_000),
  deliverables: z.array(generatedMaterialBase.extend({
    kind: z.enum(["handout", "scene-prompt"]),
    content: text,
    locationId: resourceIdSchema.nullable(),
    npcIds: z.array(resourceIdSchema).max(8),
    publishedAt: utcIsoTimestampSchema.nullable(),
  }).strict()).max(10_000),
}).strict();

/** Deliberately contains only explicitly published public artifacts. */
export const campaignPublishedMaterialsSchema = z.object({
  campaignId: campaignIdSchema,
  revision: revisionSchema,
  materials: z.array(z.object({
    artifactKey: generatedArtifactKeySchema,
    resourceId: resourceIdSchema,
    kind: z.enum(["handout", "scene-prompt"]),
    title: name,
    content: text,
    publishedAt: utcIsoTimestampSchema,
  }).strict()).max(10_000),
}).strict();

export const campaignMaterialPublishRequestSchema = z.object({
  artifactKey: generatedArtifactKeySchema,
  expectedRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();
export const campaignMaterialPublishResponseSchema = z.object({
  material: campaignPublishedMaterialsSchema.shape.materials.element,
  receipt: z.object({
    idempotencyKey: idempotencyKeySchema,
    revisionBefore: revisionSchema,
    revisionAfter: revisionSchema,
    occurredAt: utcIsoTimestampSchema,
  }).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1),
}).strict();

export type CampaignContentGenerationRequest = z.infer<typeof campaignContentGenerationRequestSchema>;
export type CampaignContentDraftView = z.infer<typeof campaignContentDraftViewSchema>;
export type GeneratedCampaignContentProvider = z.infer<typeof generatedCampaignContentProviderSchema>;
export type CampaignGeneratedPlanning = z.infer<typeof campaignGeneratedPlanningSchema>;
export type CampaignPublishedMaterials = z.infer<typeof campaignPublishedMaterialsSchema>;
