import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";
import { idempotencyKeySchema } from "./rpg-commands.js";

/**
 * `POST /api/rpg/v1/quick-adventures` builds the bundled, provider-free Sintermark starter
 * world into the owner's existing database as a brand-new campaign and returns where to play.
 * Existing campaigns, characters and catalogs are never modified.
 */
export const quickAdventureCreateRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const quickAdventureCreateResponseSchema = z
  .object({
    campaignId: resourceIdSchema,
    campaignName: z.string().min(1).max(200),
    /** The active play room. */
    sessionId: resourceIdSchema,
    /** A party actor the owner controls in that room. */
    actorId: resourceIdSchema,
    /** True when this response replays an earlier success for the same idempotency key. */
    replayed: z.boolean(),
  })
  .strict();

export type QuickAdventureCreateRequest = z.infer<typeof quickAdventureCreateRequestSchema>;
export type QuickAdventureCreateResponse = z.infer<typeof quickAdventureCreateResponseSchema>;
