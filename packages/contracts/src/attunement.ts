import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";

/**
 * Trusted-local magic-item attunement surface. Reads the actor's durable
 * attunement set and drives the pure SRD attunement engine (maximum of three
 * attuned items plus prerequisite rules) over pinned campaign catalog items.
 */

export const magicRestKindSchema = z.enum(["short-rest", "long-rest"]);

export const attunementCommandSchema = z.discriminatedUnion("command", [
  z.object({
    command: z.literal("attune"),
    key: resourceIdSchema,
    definitionId: resourceIdSchema,
    satisfiedRest: magicRestKindSchema.nullable(),
  }).strict(),
  z.object({
    command: z.literal("drop"),
    key: resourceIdSchema,
  }).strict(),
]);

export const attunementDefinitionReferenceSchema = z.object({
  packId: resourceIdSchema,
  packVersion: z.string().trim().min(1).max(64),
  definitionId: resourceIdSchema,
}).strict();

export const attunementEntrySchema = z.object({
  key: resourceIdSchema,
  definition: attunementDefinitionReferenceSchema,
  attunedAt: z.string().trim().min(1).max(64),
}).strict();

export const attunementSnapshotSchema = z.object({
  campaignId: resourceIdSchema,
  actorId: resourceIdSchema,
  limit: z.number().int().min(1).max(10),
  attunements: z.array(attunementEntrySchema).max(10),
}).strict();

export const attunementResponseSchema = z.object({
  ok: z.boolean(),
  code: z.string().trim().min(1).max(64).nullable(),
  snapshot: attunementSnapshotSchema,
}).strict();

export type MagicRestKindContract = z.infer<typeof magicRestKindSchema>;
export type AttunementCommand = z.infer<typeof attunementCommandSchema>;
export type AttunementEntry = z.infer<typeof attunementEntrySchema>;
export type AttunementSnapshot = z.infer<typeof attunementSnapshotSchema>;
export type AttunementResponse = z.infer<typeof attunementResponseSchema>;
