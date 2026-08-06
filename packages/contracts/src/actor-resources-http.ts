import { z } from "zod";
import { utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorResourceNameSchema, actorResourceStateSchema } from "./rpg-resources.js";

/** Route-owned actor resources never disclose campaign or actor identities. */
export const actorResourcesHttpResourcesSchema = z.array(actorResourceStateSchema).max(128).superRefine((resources, context) => {
  const names = new Set<string>();
  resources.forEach((resource, index) => {
    if (names.has(resource.name)) {
      context.addIssue({ code: "custom", message: "resource names must be unique", path: [index, "name"] });
    }
    names.add(resource.name);
  });
});

export const actorResourcesHttpGetResponseSchema = z.object({
  resources: actorResourcesHttpResourcesSchema,
  revision: revisionSchema,
}).strict();

/** A resource change is a signed non-zero adjustment, not a caller-supplied state replacement. */
export const actorResourcesHttpChangeCommandRequestSchema = z.object({
  kind: z.literal("change"),
  resourceName: actorResourceNameSchema,
  amount: z.number().int().min(-1_000_000).max(1_000_000).refine((amount) => amount !== 0),
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** Mutation receipts retain replay and revision proof without exposing route-owned identities. */
export const actorResourcesHttpChangeCommandReceiptSchema = z.object({
  kind: z.literal("change"),
  resourceName: actorResourceNameSchema,
  amount: actorResourcesHttpChangeCommandRequestSchema.shape.amount,
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1,
  "resource change advances exactly one revision");

export const actorResourcesHttpChangeCommandResponseSchema = z.object({
  resources: actorResourcesHttpResourcesSchema,
  receipt: actorResourcesHttpChangeCommandReceiptSchema,
}).strict();

export type ActorResourcesHttpResources = z.infer<typeof actorResourcesHttpResourcesSchema>;
export type ActorResourcesHttpGetResponse = z.infer<typeof actorResourcesHttpGetResponseSchema>;
export type ActorResourcesHttpChangeCommandRequest = z.infer<typeof actorResourcesHttpChangeCommandRequestSchema>;
export type ActorResourcesHttpChangeCommandReceipt = z.infer<typeof actorResourcesHttpChangeCommandReceiptSchema>;
export type ActorResourcesHttpChangeCommandResponse = z.infer<typeof actorResourcesHttpChangeCommandResponseSchema>;
