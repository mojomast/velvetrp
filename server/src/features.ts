import { rpgFeatureFlagsSchema } from "@velvet/contracts";
import type { RpgFeatureFlags } from "@velvet/contracts";

export function applyDefaultRpgFlags(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  if (env.FEATURE_RPG_CAMPAIGN === undefined) env.FEATURE_RPG_CAMPAIGN = "true";
  if (env.FEATURE_RPG_MECHANICS === undefined) env.FEATURE_RPG_MECHANICS = "true";
  if (env.FEATURE_RPG_COMBAT === undefined) env.FEATURE_RPG_COMBAT = "true";
  if (env.FEATURE_RPG_STUDIO === undefined) env.FEATURE_RPG_STUDIO = "true";
}

export function readRpgFeatureFlags(env: NodeJS.ProcessEnv = process.env): RpgFeatureFlags {
  return rpgFeatureFlagsSchema.parse({
    campaign: env.FEATURE_RPG_CAMPAIGN === "true",
    mechanics: env.FEATURE_RPG_MECHANICS === "true",
    combat: env.FEATURE_RPG_COMBAT === "true",
    studio: env.FEATURE_RPG_STUDIO === "true",
    remoteAuthentication: env.FEATURE_REMOTE_AUTHENTICATION === "true",
    systemOne: env.FEATURE_SYSTEM_ONE === "true",
  });
}
