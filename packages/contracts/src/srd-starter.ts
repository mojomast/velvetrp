import { z } from "zod";

export const SRD_5_1_STARTER_RULES_PROFILE_ID = "srd-5.1:rules:starter-v1" as const;
export const SRD_5_1_STARTER_PACK_ID = "srd-5.1:starter" as const;
export const SRD_5_1_STARTER_PACK_VERSION = "1.6.0+d1c1c53cfd62" as const;
export const SRD_5_1_STARTER_ID = `${SRD_5_1_STARTER_PACK_ID}@${SRD_5_1_STARTER_PACK_VERSION}` as const;

export const srdStarterIdentitySchema = z.object({
  starterId: z.literal(SRD_5_1_STARTER_ID),
  rulesProfileId: z.literal(SRD_5_1_STARTER_RULES_PROFILE_ID),
  packId: z.literal(SRD_5_1_STARTER_PACK_ID),
  packVersion: z.literal(SRD_5_1_STARTER_PACK_VERSION),
  rulesetId: z.literal("dnd-5e"),
  rulesetVersion: z.literal("1.0.0"),
}).strict();

export const SRD_5_1_STARTER_IDENTITY = Object.freeze(srdStarterIdentitySchema.parse({
  starterId: SRD_5_1_STARTER_ID,
  rulesProfileId: SRD_5_1_STARTER_RULES_PROFILE_ID,
  packId: SRD_5_1_STARTER_PACK_ID,
  packVersion: SRD_5_1_STARTER_PACK_VERSION,
  rulesetId: "dnd-5e",
  rulesetVersion: "1.0.0",
}));
