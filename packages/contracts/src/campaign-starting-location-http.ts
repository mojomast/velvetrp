import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

export const campaignStartingLocationDesignationSchema = z.object({
  locationId: resourceIdSchema,
  name: z.string().trim().min(1).max(200),
  designatedAt: utcIsoTimestampSchema,
}).strict();

/** `revision` is the authoritative campaign administration revision. */
export const campaignStartingLocationReadResponseSchema = z.object({
  campaignId: resourceIdSchema,
  revision: revisionSchema,
  startingLocation: campaignStartingLocationDesignationSchema.nullable(),
}).strict();

export const campaignStartingLocationDesignationRequestSchema = z.object({
  locationId: resourceIdSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const campaignStartingLocationDesignationResponseSchema = z.object({
  campaignId: resourceIdSchema,
  revision: revisionSchema,
  startingLocation: campaignStartingLocationDesignationSchema,
  receipt: z.object({
    commandId: resourceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    revisionBefore: revisionSchema,
    revisionAfter: revisionSchema,
    occurredAt: utcIsoTimestampSchema,
  }).strict().refine(value => value.revisionAfter === value.revisionBefore + 1,
    "designation receipt revision must advance once"),
}).strict().refine(value => value.revision === value.receipt.revisionAfter,
  "designation response revision must match its receipt");

export type CampaignStartingLocationDesignation = z.infer<typeof campaignStartingLocationDesignationSchema>;
export type CampaignStartingLocationReadResponse = z.infer<typeof campaignStartingLocationReadResponseSchema>;
export type CampaignStartingLocationDesignationRequest = z.infer<typeof campaignStartingLocationDesignationRequestSchema>;
export type CampaignStartingLocationDesignationResponse = z.infer<typeof campaignStartingLocationDesignationResponseSchema>;
