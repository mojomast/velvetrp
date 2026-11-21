import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

/** The complete closed command set for optional out-of-combat ready checks. */
export const campaignReadyCheckActionSchema = z.enum(["enable", "disable", "start", "ready", "dismiss"]);

export const campaignReadyCheckWaitingActorSchema = z
  .object({
    actorId: resourceIdSchema,
    name: z.string().min(1).max(200),
  })
  .strict();

export const campaignReadyCheckActiveCheckSchema = z
  .object({
    startedAt: utcIsoTimestampSchema,
    readyActorIds: z.array(resourceIdSchema).max(12),
    waiting: z.array(campaignReadyCheckWaitingActorSchema).max(12),
  })
  .strict();

/** Coordination-only room state; a ready check never locks or blocks adventure turns. */
export const campaignReadyCheckStateSchema = z
  .object({
    campaignId: resourceIdSchema,
    sessionId: resourceIdSchema,
    enabled: z.boolean(),
    expectedRevision: revisionSchema,
    check: campaignReadyCheckActiveCheckSchema.nullable(),
  })
  .strict();

export const campaignReadyCheckCommandSchema = z
  .object({
    action: campaignReadyCheckActionSchema,
    expectedRevision: revisionSchema,
    idempotencyKey: idempotencyKeySchema,
    actorId: resourceIdSchema.optional(),
  })
  .strict();

export const campaignReadyCheckReceiptSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    occurredAt: utcIsoTimestampSchema,
  })
  .strict();

export const campaignReadyCheckCommandResponseSchema = z
  .object({
    campaignId: resourceIdSchema,
    sessionId: resourceIdSchema,
    enabled: z.boolean(),
    expectedRevision: revisionSchema,
    check: campaignReadyCheckActiveCheckSchema.nullable(),
    receipt: campaignReadyCheckReceiptSchema,
  })
  .strict();

export type CampaignReadyCheckAction = z.infer<typeof campaignReadyCheckActionSchema>;
export type CampaignReadyCheckWaitingActor = z.infer<typeof campaignReadyCheckWaitingActorSchema>;
export type CampaignReadyCheckActiveCheck = z.infer<typeof campaignReadyCheckActiveCheckSchema>;
export type CampaignReadyCheckState = z.infer<typeof campaignReadyCheckStateSchema>;
export type CampaignReadyCheckCommand = z.infer<typeof campaignReadyCheckCommandSchema>;
export type CampaignReadyCheckReceipt = z.infer<typeof campaignReadyCheckReceiptSchema>;
export type CampaignReadyCheckCommandResponse = z.infer<typeof campaignReadyCheckCommandResponseSchema>;
