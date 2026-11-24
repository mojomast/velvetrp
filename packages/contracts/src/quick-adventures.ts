import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";
import { idempotencyKeySchema } from "./rpg-commands.js";

/** The bundled, provider-free starter worlds a quick adventure can build, Sintermark first. */
export const QUICK_ADVENTURE_IDS = ["sintermark", "hermes-nous"] as const;

export const quickAdventureIdSchema = z.enum(QUICK_ADVENTURE_IDS);

export type QuickAdventureId = z.infer<typeof quickAdventureIdSchema>;

export const QUICK_ADVENTURE_OPTIONS: ReadonlyArray<{ id: QuickAdventureId; name: string }> = [
  { id: "sintermark", name: "The Sintermark · A Commons of Fire" },
  { id: "hermes-nous", name: "Hermes Agent Squad: We Never Surrender" },
];

/**
 * `POST /api/rpg/v1/quick-adventures` builds a bundled, provider-free starter world into the
 * owner's existing database as a brand-new campaign and returns where to play. Omitting
 * `adventureId` builds Sintermark. Existing campaigns, characters and catalogs are never modified.
 */
export const quickAdventureCreateRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    /** Which bundled world to build; defaults to Sintermark when omitted. */
    adventureId: quickAdventureIdSchema.optional(),
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
