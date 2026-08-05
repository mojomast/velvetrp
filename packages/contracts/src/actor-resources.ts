import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";
import { actorResourceAmountSchema } from "./rpg-resource-primitives.js";

/** A stable resource key; it is deliberately not a display label. */
export const actorResourceIdSchema = resourceIdSchema;
export const actorResourceCapacitySchema = actorResourceAmountSchema;

export const actorResourceSchema = z.object({
  resourceId: actorResourceIdSchema,
  current: actorResourceAmountSchema,
  capacity: actorResourceCapacitySchema,
}).strict().refine((resource) => resource.current <= resource.capacity, {
  message: "current must not exceed capacity", path: ["current"],
});

export const actorResourcesSchema = z.array(actorResourceSchema).max(128).superRefine((resources, context) => {
  const ids = new Set<string>();
  resources.forEach((resource, index) => {
    if (ids.has(resource.resourceId)) context.addIssue({ code: "custom", message: "resource IDs must be unique", path: [index, "resourceId"] });
    ids.add(resource.resourceId);
  });
});

export const actorResourceDeltaSchema = z.object({
  resourceId: actorResourceIdSchema,
  before: actorResourceAmountSchema,
  after: actorResourceAmountSchema,
}).strict().refine((delta) => delta.before !== delta.after, {
  message: "resource delta must change the amount", path: ["after"],
});

const resourceCurrentCapacityShape = {
  current: actorResourceAmountSchema,
  capacity: actorResourceCapacitySchema,
};

export const actorResourceChargesSchema = z.object(resourceCurrentCapacityShape).strict().refine(
  (charges) => charges.current <= charges.capacity,
  { message: "current charges must not exceed capacity", path: ["current"] },
);
export const actorResourceAmmunitionSchema = z.object(resourceCurrentCapacityShape).strict().refine(
  (ammunition) => ammunition.current <= ammunition.capacity,
  { message: "current ammunition must not exceed capacity", path: ["current"] },
);

/** Closed, descriptive resource bindings; no executable rules or arbitrary JSON are accepted. */
export const actorResourceBindingKindSchema = z.enum(["ability", "item", "spell", "ammunition"]);
export const actorResourceBindingRecoverySchema = z.enum(["none", "encounter", "short-rest", "long-rest"]);
export const actorResourceBindingSchema = z.object({
  kind: actorResourceBindingKindSchema,
  recovery: actorResourceBindingRecoverySchema,
}).strict();

export const actorResourceChargesProjectionSchema = z.object({
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  resourceId: actorResourceIdSchema,
  charges: actorResourceChargesSchema,
}).strict();
export const actorResourceAmmunitionProjectionSchema = z.object({
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  resourceId: actorResourceIdSchema,
  ammunition: actorResourceAmmunitionSchema,
}).strict();
export const actorResourceBindingProjectionSchema = z.object({
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  resourceId: actorResourceIdSchema,
  binding: actorResourceBindingSchema,
}).strict();

const resourceCommandBase = {
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
};

export const setActorResourceCommandSchema = z.object({
  ...resourceCommandBase,
  type: z.literal("set_actor_resource"),
  resourceId: actorResourceIdSchema,
  current: actorResourceAmountSchema,
}).strict();

export const changeActorResourceCommandSchema = z.object({
  ...resourceCommandBase,
  type: z.literal("change_actor_resource"),
  resourceId: actorResourceIdSchema,
  /** Signed minor change; zero is not a command. */
  amount: z.number().int().min(-1_000_000).max(1_000_000).refine((amount) => amount !== 0),
}).strict();

export const setActorResourceCapacityCommandSchema = z.object({
  ...resourceCommandBase,
  type: z.literal("set_actor_resource_capacity"),
  resourceId: actorResourceIdSchema,
  capacity: actorResourceCapacitySchema,
}).strict();

export const setActorResourceChargesCommandSchema = z.object({
  ...resourceCommandBase,
  type: z.literal("set_actor_resource_charges"),
  resourceId: actorResourceIdSchema,
  ...resourceCurrentCapacityShape,
}).strict().refine((command) => command.current <= command.capacity, {
  message: "current charges must not exceed capacity", path: ["current"],
});

export const setActorResourceAmmunitionCommandSchema = z.object({
  ...resourceCommandBase,
  type: z.literal("set_actor_resource_ammunition"),
  resourceId: actorResourceIdSchema,
  ...resourceCurrentCapacityShape,
}).strict().refine((command) => command.current <= command.capacity, {
  message: "current ammunition must not exceed capacity", path: ["current"],
});

export const setActorResourceBindingCommandSchema = z.object({
  ...resourceCommandBase,
  type: z.literal("set_actor_resource_binding"),
  resourceId: actorResourceIdSchema,
  binding: actorResourceBindingSchema,
}).strict();

/** Closed command boundary for actor-resource mutations. */
export const actorResourceCommandSchema = z.discriminatedUnion("type", [
  setActorResourceCommandSchema,
  changeActorResourceCommandSchema,
  setActorResourceCapacityCommandSchema,
  setActorResourceChargesCommandSchema,
  setActorResourceAmmunitionCommandSchema,
  setActorResourceBindingCommandSchema,
]);

export type ActorResource = z.infer<typeof actorResourceSchema>;
export type ActorResourceDelta = z.infer<typeof actorResourceDeltaSchema>;
export type ActorResourceCharges = z.infer<typeof actorResourceChargesSchema>;
export type ActorResourceAmmunition = z.infer<typeof actorResourceAmmunitionSchema>;
export type ActorResourceBinding = z.infer<typeof actorResourceBindingSchema>;
export type ActorResourceChargesProjection = z.infer<typeof actorResourceChargesProjectionSchema>;
export type ActorResourceAmmunitionProjection = z.infer<typeof actorResourceAmmunitionProjectionSchema>;
export type ActorResourceBindingProjection = z.infer<typeof actorResourceBindingProjectionSchema>;
export type SetActorResourceCommand = z.infer<typeof setActorResourceCommandSchema>;
export type ChangeActorResourceCommand = z.infer<typeof changeActorResourceCommandSchema>;
export type SetActorResourceCapacityCommand = z.infer<typeof setActorResourceCapacityCommandSchema>;
export type SetActorResourceChargesCommand = z.infer<typeof setActorResourceChargesCommandSchema>;
export type SetActorResourceAmmunitionCommand = z.infer<typeof setActorResourceAmmunitionCommandSchema>;
export type SetActorResourceBindingCommand = z.infer<typeof setActorResourceBindingCommandSchema>;
export type ActorResourceCommand = z.infer<typeof actorResourceCommandSchema>;
