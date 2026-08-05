import { z } from "zod";
import { actorResourceDeltaSchema } from "./actor-resources.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";

export const restIdSchema = resourceIdSchema;
export const restKindSchema = z.enum(["short", "long"]);

export const recoveryDeltaSchema = actorResourceDeltaSchema;
export const restRecoverySchema = z.object({ resources: z.array(recoveryDeltaSchema).max(128) }).strict().superRefine((recovery, context) => {
  const ids = new Set<string>();
  recovery.resources.forEach((delta, index) => {
    if (ids.has(delta.resourceId)) context.addIssue({ code: "custom", message: "recovery resource IDs must be unique", path: ["resources", index, "resourceId"] });
    ids.add(delta.resourceId);
  });
});

const restCommandBase = { campaignId: campaignIdSchema, actorId: actorIdSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema };
export const takeShortRestCommandSchema = z.object({ ...restCommandBase, type: z.literal("take_short_rest") }).strict();
export const takeLongRestCommandSchema = z.object({ ...restCommandBase, type: z.literal("take_long_rest") }).strict();
export const restCommandSchema = z.discriminatedUnion("type", [takeShortRestCommandSchema, takeLongRestCommandSchema]);

export const restReceiptSchema = z.object({
  restId: restIdSchema,
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  kind: restKindSchema,
  recoveredAt: utcIsoTimestampSchema,
  recovery: restRecoverySchema,
  revisionBefore: expectedRevisionSchema,
  revisionAfter: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1, { message: "rest revision must advance exactly once", path: ["revisionAfter"] });

export type RecoveryDelta = z.infer<typeof recoveryDeltaSchema>;
export type RestRecovery = z.infer<typeof restRecoverySchema>;
export type TakeShortRestCommand = z.infer<typeof takeShortRestCommandSchema>;
export type TakeLongRestCommand = z.infer<typeof takeLongRestCommandSchema>;
export type RestCommand = z.infer<typeof restCommandSchema>;
export type RestReceipt = z.infer<typeof restReceiptSchema>;
