import { rpgFeatureFlagsSchema } from "@velvet/contracts";
import type { RpgFeatureFlags } from "@velvet/contracts";

export function readRpgFeatureFlags(env: NodeJS.ProcessEnv = process.env): RpgFeatureFlags {
  return rpgFeatureFlagsSchema.parse({
    campaign: env.FEATURE_RPG_CAMPAIGN === "true",
    mechanics: env.FEATURE_RPG_MECHANICS === "true",
    combat: env.FEATURE_RPG_COMBAT === "true",
    studio: env.FEATURE_RPG_STUDIO === "true",
    remoteAuthentication: env.FEATURE_REMOTE_AUTHENTICATION === "true",
  });
}
