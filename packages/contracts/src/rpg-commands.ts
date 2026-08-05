import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";
import { diceExpressionSchema, diceRollResultSchema } from "./rpg-dice.js";
import { actorResourceStateSchema } from "./rpg-resources.js";

export const commandIdSchema = resourceIdSchema;
export const eventIdSchema = resourceIdSchema;
export const idempotencyKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const expectedRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER - 1);

export const setActorAttributePayloadSchema = z.object({
  attributeId: resourceIdSchema,
  value: z.number().int().min(-1_000).max(1_000),
}).strict();

export const setActorAttributeCommandSchema = z.object({
  type: z.literal("set_actor_attribute"),
  payload: setActorAttributePayloadSchema,
}).strict();

export const initializeActorResourcePayloadSchema = actorResourceStateSchema;

export const initializeActorResourceCommandSchema = z.object({
  type: z.literal("initialize_actor_resource"),
  payload: initializeActorResourcePayloadSchema,
}).strict();

export const rollActorDicePayloadSchema = z.object({
  expression: diceExpressionSchema,
}).strict();

export const rollActorDiceCommandSchema = z.object({
  type: z.literal("roll_actor_dice"),
  payload: rollActorDicePayloadSchema,
}).strict();

// Keep this union as the explicit expansion point for reviewed commands.
export const rpgCommandSchema = z.discriminatedUnion("type", [
  setActorAttributeCommandSchema,
  initializeActorResourceCommandSchema,
  rollActorDiceCommandSchema,
]);

export const commandEnvelopeSchema = z.object({
  commandId: commandIdSchema,
  idempotencyKey: idempotencyKeySchema,
  campaignId: campaignIdSchema,
  timelineId: resourceIdSchema,
  actorId: actorIdSchema,
  expectedRevision: expectedRevisionSchema,
  sourceTurnId: resourceIdSchema.nullable(),
  command: rpgCommandSchema,
}).strict();

export const actorAttributeSetEventDataSchema = z.object({
  attributeId: resourceIdSchema,
  valueBefore: z.number().int().min(-1_000).max(1_000),
  valueAfter: z.number().int().min(-1_000).max(1_000),
}).strict().refine(
  ({ valueBefore, valueAfter }) => valueBefore !== valueAfter,
  { message: "valueAfter must differ from valueBefore", path: ["valueAfter"] },
);

export const actorAttributeSetEventSchema = z.object({
  eventId: eventIdSchema,
  commandId: commandIdSchema,
  campaignId: campaignIdSchema,
  timelineId: resourceIdSchema,
  actorId: actorIdSchema,
  sourceTurnId: resourceIdSchema.nullable(),
  type: z.literal("actor_attribute_set"),
  revision: revisionSchema.min(1),
  occurredAt: utcIsoTimestampSchema,
  data: actorAttributeSetEventDataSchema,
}).strict();

export const actorResourceInitializedEventDataSchema = actorResourceStateSchema;

export const actorResourceInitializedEventSchema = z.object({
  eventId: eventIdSchema,
  commandId: commandIdSchema,
  campaignId: campaignIdSchema,
  timelineId: resourceIdSchema,
  actorId: actorIdSchema,
  sourceTurnId: resourceIdSchema.nullable(),
  type: z.literal("actor_resource_initialized"),
  revision: revisionSchema.min(1),
  occurredAt: utcIsoTimestampSchema,
  data: actorResourceInitializedEventDataSchema,
}).strict();

export const actorDiceRolledEventDataSchema = diceRollResultSchema;

export const actorDiceRolledEventSchema = z.object({
  eventId: eventIdSchema,
  commandId: commandIdSchema,
  campaignId: campaignIdSchema,
  timelineId: resourceIdSchema,
  actorId: actorIdSchema,
  sourceTurnId: resourceIdSchema.nullable(),
  type: z.literal("actor_dice_rolled"),
  revision: revisionSchema.min(1),
  occurredAt: utcIsoTimestampSchema,
  data: actorDiceRolledEventDataSchema,
}).strict();

// Keep this union as the explicit expansion point for reviewed events.
export const rpgEventSchema = z.discriminatedUnion("type", [
  actorAttributeSetEventSchema,
  actorResourceInitializedEventSchema,
  actorDiceRolledEventSchema,
]);

export const commandReceiptSchema = z.object({
  commandId: commandIdSchema,
  campaignId: campaignIdSchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  events: z.tuple([rpgEventSchema]),
}).strict().superRefine((receipt, context) => {
  if (receipt.revisionAfter !== receipt.revisionBefore + 1) {
    context.addIssue({
      code: "custom",
      message: "revisionAfter must equal revisionBefore plus one",
      path: ["revisionAfter"],
    });
  }

  const [event] = receipt.events;
  if (event.revision !== receipt.revisionAfter) {
    context.addIssue({ code: "custom", message: "event revision must match revisionAfter", path: ["events", 0, "revision"] });
  }
  if (event.commandId !== receipt.commandId) {
    context.addIssue({ code: "custom", message: "event commandId must match receipt", path: ["events", 0, "commandId"] });
  }
  if (event.campaignId !== receipt.campaignId) {
    context.addIssue({ code: "custom", message: "event campaignId must match receipt", path: ["events", 0, "campaignId"] });
  }
});

export type CommandId = z.infer<typeof commandIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type ExpectedRevision = z.infer<typeof expectedRevisionSchema>;
export type SetActorAttributePayload = z.infer<typeof setActorAttributePayloadSchema>;
export type SetActorAttributeCommand = z.infer<typeof setActorAttributeCommandSchema>;
export type InitializeActorResourcePayload = z.infer<typeof initializeActorResourcePayloadSchema>;
export type InitializeActorResourceCommand = z.infer<typeof initializeActorResourceCommandSchema>;
export type RollActorDicePayload = z.infer<typeof rollActorDicePayloadSchema>;
export type RollActorDiceCommand = z.infer<typeof rollActorDiceCommandSchema>;
export type RpgCommand = z.infer<typeof rpgCommandSchema>;
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type ActorAttributeSetEventData = z.infer<typeof actorAttributeSetEventDataSchema>;
export type ActorAttributeSetEvent = z.infer<typeof actorAttributeSetEventSchema>;
export type ActorResourceInitializedEventData = z.infer<typeof actorResourceInitializedEventDataSchema>;
export type ActorResourceInitializedEvent = z.infer<typeof actorResourceInitializedEventSchema>;
export type ActorDiceRolledEventData = z.infer<typeof actorDiceRolledEventDataSchema>;
export type ActorDiceRolledEvent = z.infer<typeof actorDiceRolledEventSchema>;
export type RpgEvent = z.infer<typeof rpgEventSchema>;
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
