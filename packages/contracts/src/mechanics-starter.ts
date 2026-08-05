import { z } from "zod";

/**
 * Fixed public identity of the reviewed built-in mechanics catalog. Keeping
 * these literals in contracts prevents the HTTP client, route, and catalog
 * factory from drifting into three independent identities.
 */
export const MECHANICS_STARTER_PACK_ID = "velvet:mechanics-starter" as const;
export const MECHANICS_STARTER_PACK_VERSION = "1.1.0+2f9199b5696d" as const;
export const MECHANICS_STARTER_RULES_PROFILE_ID = "velvet:rules:starter-v1" as const;
export const MECHANICS_STARTER_ID = `${MECHANICS_STARTER_PACK_ID}@${MECHANICS_STARTER_PACK_VERSION}` as const;

export const mechanicsStarterIdentitySchema = z.object({
  starterId: z.literal(MECHANICS_STARTER_ID),
  rulesProfileId: z.literal(MECHANICS_STARTER_RULES_PROFILE_ID),
  packId: z.literal(MECHANICS_STARTER_PACK_ID),
  packVersion: z.literal(MECHANICS_STARTER_PACK_VERSION),
}).strict();

export const MECHANICS_STARTER_IDENTITY = Object.freeze(mechanicsStarterIdentitySchema.parse({
  starterId: MECHANICS_STARTER_ID,
  rulesProfileId: MECHANICS_STARTER_RULES_PROFILE_ID,
  packId: MECHANICS_STARTER_PACK_ID,
  packVersion: MECHANICS_STARTER_PACK_VERSION,
}));

export type MechanicsStarterIdentity = z.infer<typeof mechanicsStarterIdentitySchema>;
