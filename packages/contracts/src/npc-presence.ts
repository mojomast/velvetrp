import { z } from "zod";
import { campaignSessionAttachmentSchema } from "./campaigns.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { campaignIdSchema, principalIdSchema } from "./rpg-characters.js";
import { locationIdSchema, npcIdSchema } from "./world.js";

/** Durable presence state. Public running casts expose only present NPCs. */
export const npcPresenceStatusSchema = z.enum(["present", "left"]);

/** Authoritative per-NPC session state. Its revision is informational, not a concurrency root. */
export const npcPresenceSchema = z.object({
  campaignId: campaignIdSchema,
  sessionId: campaignSessionAttachmentSchema.shape.sessionId,
  npcId: npcIdSchema,
  personaId: resourceIdSchema,
  status: npcPresenceStatusSchema,
  locationId: locationIdSchema.nullable(),
  principals: z.array(principalIdSchema).max(1_000)
    .refine((ids) => new Set(ids).size === ids.length, "presence principals must be unique"),
  revision: revisionSchema.min(1),
  presentAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
  leftAt: utcIsoTimestampSchema.nullable(),
}).strict().superRefine((presence, context) => {
  if ((presence.status === "left") !== (presence.leftAt !== null)) {
    context.addIssue({ code: "custom", path: ["leftAt"], message: "leftAt must be set exactly when the NPC has left" });
  }
  if (presence.updatedAt < presence.presentAt) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "presence timestamps must not precede presentAt" });
  }
  if (presence.leftAt !== null && (presence.leftAt < presence.presentAt || presence.leftAt < presence.updatedAt)) {
    context.addIssue({ code: "custom", path: ["leftAt"], message: "leftAt must not precede presence timestamps" });
  }
});

/** Caller intent for initially placing an NPC. A null location means present at an undisclosed or unknown place. */
export const placeNpcPresenceMutationSchema = z.object({
  kind: z.literal("place"),
  locationId: locationIdSchema.nullable(),
}).strict();

/** Caller intent for moving a currently present NPC. Location authority remains server-owned. */
export const moveNpcPresenceMutationSchema = z.object({
  kind: z.literal("move"),
  locationId: locationIdSchema.nullable(),
}).strict();

/** Caller intent for removing an NPC from the present cast. */
export const removeNpcPresenceMutationSchema = z.object({ kind: z.literal("remove") }).strict();

/** Closed NPC-presence mutation vocabulary. */
export const npcPresenceMutationSchema = z.discriminatedUnion("kind", [
  placeNpcPresenceMutationSchema,
  moveNpcPresenceMutationSchema,
  removeNpcPresenceMutationSchema,
]);

/** Internal command after campaign, session, and NPC identities have been taken from the route. */
export const npcPresenceCommandSchema = z.object({
  campaignId: campaignIdSchema,
  sessionId: campaignSessionAttachmentSchema.shape.sessionId,
  npcId: npcIdSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  mutation: npcPresenceMutationSchema,
}).strict();

export type NpcPresenceStatus = z.infer<typeof npcPresenceStatusSchema>;
export type NpcPresence = z.infer<typeof npcPresenceSchema>;
export type PlaceNpcPresenceMutation = z.infer<typeof placeNpcPresenceMutationSchema>;
export type MoveNpcPresenceMutation = z.infer<typeof moveNpcPresenceMutationSchema>;
export type RemoveNpcPresenceMutation = z.infer<typeof removeNpcPresenceMutationSchema>;
export type NpcPresenceMutation = z.infer<typeof npcPresenceMutationSchema>;
export type NpcPresenceCommand = z.infer<typeof npcPresenceCommandSchema>;
