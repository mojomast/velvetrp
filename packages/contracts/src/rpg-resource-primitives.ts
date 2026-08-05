import { z } from "zod";

/** Shared integer bounds for current and maximum actor-resource amounts. */
export const actorResourceAmountSchema = z.number().int().min(0).max(1_000_000);

export type ActorResourceAmount = z.infer<typeof actorResourceAmountSchema>;
