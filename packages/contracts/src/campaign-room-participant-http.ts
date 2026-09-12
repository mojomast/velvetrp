import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

/** Adds one already-finalized campaign character to an existing attached room. */
export const campaignRoomParticipantRequestSchema = z.object({
  campaignCharacterId: resourceIdSchema,
  expectedRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const campaignRoomParticipantResponseSchema = z.object({
  campaignId: resourceIdSchema,
  sessionId: resourceIdSchema,
  campaignCharacterId: resourceIdSchema,
  characterId: resourceIdSchema,
  actorId: resourceIdSchema,
  position: z.number().int().min(0).max(11),
  revision: revisionSchema,
  receipt: z.object({
    commandId: resourceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    occurredAt: utcIsoTimestampSchema,
  }).strict(),
}).strict();

export type CampaignRoomParticipantRequest = z.infer<typeof campaignRoomParticipantRequestSchema>;
export type CampaignRoomParticipantResponse = z.infer<typeof campaignRoomParticipantResponseSchema>;
