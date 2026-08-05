import { z } from "zod";

export const roleplayFeatureFlagsSchema = z.object({
  voice: z.boolean(),
  images: z.boolean(),
});

export const rpgFeatureFlagsSchema = z.object({
  campaign: z.boolean(),
  mechanics: z.boolean(),
  combat: z.boolean(),
  studio: z.boolean(),
  remoteAuthentication: z.boolean(),
});

export type RoleplayFeatureFlags = z.infer<typeof roleplayFeatureFlagsSchema>;
export type RpgFeatureFlags = z.infer<typeof rpgFeatureFlagsSchema>;
