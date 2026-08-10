import { z } from "zod";
import { campaignIdSchema } from "./rpg-characters.js";
import { idempotencyKeySchema } from "./rpg-commands.js";

const text = z.string().trim().min(1).max(4_000);
const name = z.string().trim().min(1).max(200);
/** Provider and public views contain prose only, never IDs, principals, or hidden state. */
export const campaignContentGenerationRequestSchema = z.object({
  campaignId: campaignIdSchema, brief: text.max(2_000), tone: z.string().trim().min(1).max(200),
  exclusions: z.array(z.string().trim().min(1).max(200)).max(16), idempotencyKey: idempotencyKeySchema,
}).strict();
export const generatedCampaignContentProviderSchema = z.object({
  opening: text, premise: text, locations: z.array(z.object({ name, description: text }).strict()).min(1).max(8),
  factions: z.array(z.object({ name, description: text }).strict()).max(8), quests: z.array(z.object({ title: name, description: text }).strict()).max(8),
  npcs: z.array(z.object({ name, archetype: name, goals: text }).strict()).max(8),
}).strict();
export const campaignContentGenerationPreviewSchema = generatedCampaignContentProviderSchema.omit({ npcs: true }).extend({ npcs: z.array(z.object({ name, archetype: name }).strict()).max(8), npcStats: z.object({ body: z.literal(10), mind: z.literal(10), presence: z.literal(10), source: z.literal("generated-deterministic-baseline") }).strict() }).strict();
export const stagedCampaignContentGenerationSchema = generatedCampaignContentProviderSchema.extend({ kind: z.literal("campaign-content"), requestDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const campaignContentDraftViewSchema = z.object({
  draft: z.object({ draftId: z.string(), campaignId: campaignIdSchema, kind: z.literal("campaign-content"), state: z.enum(["staged", "approved", "applied"]), revision: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string() }).strict(),
  preview: campaignContentGenerationPreviewSchema,
  validationIssues: z.array(z.string()),
}).strict();
export const campaignContentApplyRequestSchema = z.object({ expectedRevision: z.number().int().nonnegative(), idempotencyKey: idempotencyKeySchema }).strict();
export const campaignContentApplyResponseSchema = z.object({ draft: campaignContentDraftViewSchema.shape.draft, application: z.object({ scope: z.literal("campaign-content"), campaignDomainMutated: z.literal(true), appliedAt: z.string() }).strict(), receipts: z.array(z.object({ receiptId: z.string(), scope: z.literal("campaign-content"), appliedAt: z.string() }).strict()).min(1).max(1) }).strict();
export type CampaignContentGenerationRequest = z.infer<typeof campaignContentGenerationRequestSchema>;
