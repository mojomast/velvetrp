import { z } from "zod";
import {
  campaignAdministrationEventSchema,
  campaignAdministrationEventTypeSchema,
  campaignCheckpointSchema,
  campaignRecapSchema,
  campaignTimelineHistorySchema,
  createCampaignCheckpointInputSchema,
  createCampaignRecapInputSchema,
  forkCampaignTimelineInputSchema,
} from "./campaign-administration.js";
import { resourceIdSchema } from "./domain-primitives.js";
import {
  actorAttributeSetEventSchema,
  actorDiceRolledEventSchema,
  actorResourceInitializedEventSchema,
  revisionSchema,
} from "./rpg-commands.js";

const MAX_CAMPAIGN_HISTORY_EVENTS_PAGE_SIZE = 100;

/** HTTP history projections omit the campaign ID owned by the route. */
export const campaignHistoryHttpTimelineSchema = campaignTimelineHistorySchema.omit({ campaignId: true });
export const campaignHistoryHttpTimelinesResponseSchema = z.object({
  activeTimelineId: resourceIdSchema,
  timelines: z.array(campaignHistoryHttpTimelineSchema).max(1_000),
}).strict();

export const campaignHistoryHttpEventSchema = z.discriminatedUnion("type", [
  actorAttributeSetEventSchema.omit({ campaignId: true }),
  actorResourceInitializedEventSchema.omit({ campaignId: true }),
  actorDiceRolledEventSchema.omit({ campaignId: true }),
]);
export const campaignHistoryHttpEventsQuerySchema = z.object({
  timelineId: resourceIdSchema,
  afterRevision: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.coerce.number().int().min(1).max(MAX_CAMPAIGN_HISTORY_EVENTS_PAGE_SIZE),
}).strict();
export const campaignHistoryHttpEventsResponseSchema = z.object({
  events: z.array(campaignHistoryHttpEventSchema).max(MAX_CAMPAIGN_HISTORY_EVENTS_PAGE_SIZE),
  nextAfterRevision: revisionSchema.nullable(),
}).strict();

/** Receipts publish command results without repeating the route-owned campaign ID. */
export const campaignHistoryHttpAdministrationEventSchema = campaignAdministrationEventSchema.omit({ campaignId: true });
export const campaignHistoryHttpCommandReceiptSchema = z.object({
  commandId: resourceIdSchema,
  type: campaignAdministrationEventTypeSchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: z.string().datetime({ offset: false, precision: 3 }),
  events: z.tuple([campaignHistoryHttpAdministrationEventSchema]),
}).strict().superRefine((receipt, context) => {
  if (receipt.revisionAfter !== receipt.revisionBefore + 1) {
    context.addIssue({ code: "custom", message: "revisionAfter must equal revisionBefore plus one", path: ["revisionAfter"] });
  }

  const [event] = receipt.events;
  if (event.revision !== receipt.revisionAfter) {
    context.addIssue({ code: "custom", message: "event revision must match revisionAfter", path: ["events", 0, "revision"] });
  }
  if (event.commandId !== receipt.commandId) {
    context.addIssue({ code: "custom", message: "event commandId must match receipt", path: ["events", 0, "commandId"] });
  }
});

/**
 * A receipt opened from the history log. Unlike mutation receipts, this
 * projection contains no command/event/campaign/actor/source-turn identities
 * and no generic administration payload. Only reviewed mechanic result data
 * or administration metadata crosses the read boundary.
 */
export const campaignHistoryHttpPublicMechanicEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("actor_attribute_set"), data: z.object({ valueBefore: z.number().int().min(-1_000).max(1_000), valueAfter: z.number().int().min(-1_000).max(1_000) }).strict() }).strict(),
  z.object({ type: z.literal("actor_resource_initialized"), data: z.object({ current: z.number().int().min(0), max: z.number().int().min(0) }).strict() }).strict(),
  actorDiceRolledEventSchema.pick({ type: true, data: true }),
]);
export const campaignHistoryHttpPublicReceiptSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mechanic"),
    revisionBefore: revisionSchema,
    revisionAfter: revisionSchema,
    occurredAt: z.string().datetime({ offset: false, precision: 3 }),
    event: campaignHistoryHttpPublicMechanicEventSchema,
  }).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1,
    "receipt revision must advance once"),
  z.object({
    kind: z.literal("administration"),
    type: campaignAdministrationEventTypeSchema,
    revisionBefore: revisionSchema,
    revisionAfter: revisionSchema,
    occurredAt: z.string().datetime({ offset: false, precision: 3 }),
  }).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1,
    "receipt revision must advance once"),
  z.object({kind:z.literal("combat"),revisionBefore:revisionSchema,revisionAfter:revisionSchema,
    occurredAt:z.string().datetime({offset:false,precision:3}),roundBefore:revisionSchema,roundAfter:revisionSchema}).strict()
    .refine((value)=>value.revisionAfter===value.revisionBefore+1,"receipt revision must advance once"),
]);
export const campaignHistoryHttpPublicReceiptResponseSchema = z.object({
  receipt: campaignHistoryHttpPublicReceiptSchema,
}).strict();

export const campaignHistoryHttpCheckpointSchema = campaignCheckpointSchema.omit({ campaignId: true });
export const campaignHistoryHttpCheckpointRequestSchema = createCampaignCheckpointInputSchema;
export const campaignHistoryHttpCheckpointResponseSchema = z.object({
  checkpoint: campaignHistoryHttpCheckpointSchema,
  receipt: campaignHistoryHttpCommandReceiptSchema,
}).strict();

export const campaignHistoryHttpForkRequestSchema = forkCampaignTimelineInputSchema;
export const campaignHistoryHttpForkResponseSchema = z.object({
  timeline: campaignHistoryHttpTimelineSchema,
  receipt: campaignHistoryHttpCommandReceiptSchema,
}).strict();

export const campaignHistoryHttpRecapSchema = campaignRecapSchema.omit({ campaignId: true });
export const campaignHistoryHttpRecapRequestSchema = createCampaignRecapInputSchema;
export const campaignHistoryHttpRecapResponseSchema = z.object({
  recap: campaignHistoryHttpRecapSchema,
  receipt: campaignHistoryHttpCommandReceiptSchema,
}).strict();

export type CampaignHistoryHttpTimeline = z.infer<typeof campaignHistoryHttpTimelineSchema>;
export type CampaignHistoryHttpTimelinesResponse = z.infer<typeof campaignHistoryHttpTimelinesResponseSchema>;
export type CampaignHistoryHttpEvent = z.infer<typeof campaignHistoryHttpEventSchema>;
export type CampaignHistoryHttpEventsQuery = z.infer<typeof campaignHistoryHttpEventsQuerySchema>;
export type CampaignHistoryHttpEventsResponse = z.infer<typeof campaignHistoryHttpEventsResponseSchema>;
export type CampaignHistoryHttpAdministrationEvent = z.infer<typeof campaignHistoryHttpAdministrationEventSchema>;
export type CampaignHistoryHttpCommandReceipt = z.infer<typeof campaignHistoryHttpCommandReceiptSchema>;
export type CampaignHistoryHttpPublicReceipt = z.infer<typeof campaignHistoryHttpPublicReceiptSchema>;
export type CampaignHistoryHttpPublicReceiptResponse = z.infer<typeof campaignHistoryHttpPublicReceiptResponseSchema>;
export type CampaignHistoryHttpCheckpoint = z.infer<typeof campaignHistoryHttpCheckpointSchema>;
export type CampaignHistoryHttpCheckpointRequest = z.infer<typeof campaignHistoryHttpCheckpointRequestSchema>;
export type CampaignHistoryHttpCheckpointResponse = z.infer<typeof campaignHistoryHttpCheckpointResponseSchema>;
export type CampaignHistoryHttpForkRequest = z.infer<typeof campaignHistoryHttpForkRequestSchema>;
export type CampaignHistoryHttpForkResponse = z.infer<typeof campaignHistoryHttpForkResponseSchema>;
export type CampaignHistoryHttpRecap = z.infer<typeof campaignHistoryHttpRecapSchema>;
export type CampaignHistoryHttpRecapRequest = z.infer<typeof campaignHistoryHttpRecapRequestSchema>;
export type CampaignHistoryHttpRecapResponse = z.infer<typeof campaignHistoryHttpRecapResponseSchema>;
