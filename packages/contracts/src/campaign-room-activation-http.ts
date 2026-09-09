import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

export const campaignRoomActivationRequestSchema = z.object({
  expectedRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const campaignRoomActivationBlockerSchema = z.enum([
  "campaign-not-published", "safety-paused", "room-not-startable", "ambiguous-room",
  "participants-not-ready", "content-not-ready", "starting-location-required", "actor-in-other-room",
]);

/** Owner/GM readiness, not an authorization grant or a promise about future state. */
export const campaignRoomActivationReadinessSchema = z.object({
  campaignId: resourceIdSchema,
  sessionId: resourceIdSchema,
  expectedRevision: revisionSchema,
  active: z.boolean(),
  ready: z.boolean(),
  blockers: z.array(campaignRoomActivationBlockerSchema).max(8),
  actorIds: z.array(resourceIdSchema).max(12),
}).strict().refine(value => value.ready === (value.blockers.length === 0), "readiness must match blockers");

export const campaignRoomActivationResponseSchema = z.object({
  readiness: campaignRoomActivationReadinessSchema,
  receipt: z.object({
    commandId: resourceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    occurredAt: utcIsoTimestampSchema,
    activated: z.boolean(),
    placedActorIds: z.array(resourceIdSchema).max(12),
    reconciledNpcCount: z.number().int().min(0),
  }).strict(),
}).strict().refine(value => value.readiness.ready && value.readiness.active, "activation must establish readiness");

export type CampaignRoomActivationRequest = z.infer<typeof campaignRoomActivationRequestSchema>;
export type CampaignRoomActivationReadiness = z.infer<typeof campaignRoomActivationReadinessSchema>;
export type CampaignRoomActivationResponse = z.infer<typeof campaignRoomActivationResponseSchema>;
