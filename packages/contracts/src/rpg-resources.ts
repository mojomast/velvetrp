import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";
import { actorResourceAmountSchema } from "./rpg-resource-primitives.js";

export { actorResourceAmountSchema } from "./rpg-resource-primitives.js";
export type { ActorResourceAmount } from "./rpg-resource-primitives.js";

/** Exact, case-sensitive technical name used to identify one actor resource. */
export const actorResourceNameSchema = resourceIdSchema;

const actorResourceStateShape = {
  name: actorResourceNameSchema,
  current: actorResourceAmountSchema,
  max: actorResourceAmountSchema,
};

const currentDoesNotExceedMax = ({ current, max }: { current: number; max: number }) => current <= max;

export const actorResourceStateSchema = z.object(actorResourceStateShape).strict().refine(
  currentDoesNotExceedMax,
  { message: "current must not exceed max", path: ["current"] },
);

export const actorResourceSchema = z.object({
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  ...actorResourceStateShape,
}).strict().refine(
  currentDoesNotExceedMax,
  { message: "current must not exceed max", path: ["current"] },
);

export type ActorResourceName = z.infer<typeof actorResourceNameSchema>;
export type ActorResourceState = z.infer<typeof actorResourceStateSchema>;
export type ActorResource = z.infer<typeof actorResourceSchema>;
