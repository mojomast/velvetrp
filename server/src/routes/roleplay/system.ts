import { roleplayFeatureFlagsSchema } from "@velvet/contracts";
import type { FastifyPluginAsync } from "fastify";

export const roleplaySystemRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({ ok: true }));

  app.get("/features", async () => roleplayFeatureFlagsSchema.parse({
    voice: process.env.FEATURE_VOICE === "true",
    images: process.env.FEATURE_IMAGES === "true",
  }));
};
