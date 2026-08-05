import type { FastifyPluginAsync } from "fastify";
import { getProviderSettings, getUsageSummary } from "../../repo.js";

export const roleplayUsageRoutes: FastifyPluginAsync = async (app) => {
  app.get("/usage", async () => {
    const provider = await getProviderSettings();
    return { usage: await getUsageSummary(provider.pricing) };
  });
};
