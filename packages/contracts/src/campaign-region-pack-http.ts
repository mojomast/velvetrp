import { z } from "zod";
import { campaignIdSchema } from "./rpg-characters.js";
import { idempotencyKeySchema } from "./rpg-commands.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import {
  campaignContentDraftViewSchema,
  generatedArtifactKeySchema,
} from "./campaign-content-generation-http.js";

/** Hard upper bounds mirrored by the region-pack validator. */
export const MAX_REGION_PACK_LOCATIONS = 16;
export const MIN_REGION_PACK_LOCATIONS = 4;
export const MAX_REGION_PACK_CONNECTIONS = 24;
export const MAX_REGION_PACK_SELECTED_KEYS = 128;
export const MAX_REGION_PACK_EXCLUSIONS = 16;
export const MAX_REGION_PACK_BRIEF = 2_000;
export const MAX_REGION_PACK_TONE = 200;

const brief = z.string().trim().min(1).max(MAX_REGION_PACK_BRIEF);
const tone = z.string().trim().min(1).max(MAX_REGION_PACK_TONE);
const label = z.string().trim().min(1).max(200);

/**
 * Optional linkage hints. Every hint defaults to on so a bare region pack still
 * asks for a coherent opening area with NPCs, factions, quests, clues, and
 * story. `encounters` is the only hint that adds a section: the fixed region
 * pack sections deliberately exclude prepared encounter plans.
 */
export const campaignRegionPackLinkedSchema = z.object({
  npcs: z.boolean().optional(),
  quests: z.boolean().optional(),
  clues: z.boolean().optional(),
  storyNodes: z.boolean().optional(),
  factions: z.boolean().optional(),
  encounters: z.boolean().optional(),
}).strict();

/**
 * Strict body for `POST /api/rpg/v1/campaigns/:campaignId/region-packs`. The
 * campaign id travels in the path; the body never restates it. `anchorLocationKey`
 * is an already-accepted public location artifact key and is required only when
 * the campaign already designates an immutable starting location.
 */
export const campaignRegionPackRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  brief,
  tone: tone.optional(),
  exclusions: z.array(label).max(MAX_REGION_PACK_EXCLUSIONS).optional(),
  anchorLocationKey: generatedArtifactKeySchema.optional(),
  locationCount: z.number().int().min(MIN_REGION_PACK_LOCATIONS).max(MAX_REGION_PACK_LOCATIONS),
  linked: campaignRegionPackLinkedSchema.optional(),
}).strict();

/** The designated starting location after one atomic region-pack application. */
export const campaignRegionPackStartLocationSchema = z.object({
  artifactKey: generatedArtifactKeySchema.nullable(),
  locationId: resourceIdSchema,
  name: label,
}).strict();

/**
 * One-request region-pack result: the generation draft projection plus the
 * applied summary. It never exposes provider prompts or GM-only candidate text.
 */
export const campaignRegionPackResponseSchema = z.object({
  campaignId: campaignIdSchema,
  draft: campaignContentDraftViewSchema.shape.draft,
  appliedArtifactKeys: z.array(generatedArtifactKeySchema).min(1).max(MAX_REGION_PACK_SELECTED_KEYS),
  receipt: z.object({
    receiptId: resourceIdSchema,
    appliedAt: utcIsoTimestampSchema,
  }).strict(),
  startLocation: campaignRegionPackStartLocationSchema.nullable(),
}).strict();

export type CampaignRegionPackLinked = z.infer<typeof campaignRegionPackLinkedSchema>;
export type CampaignRegionPackRequest = z.infer<typeof campaignRegionPackRequestSchema>;
export type CampaignRegionPackResponse = z.infer<typeof campaignRegionPackResponseSchema>;
export type CampaignRegionPackStartLocation = z.infer<typeof campaignRegionPackStartLocationSchema>;
