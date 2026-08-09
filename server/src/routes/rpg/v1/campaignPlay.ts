import {
  campaignPlayBootstrapSchema,
  campaignPlaySessionIdSchema,
  resourceIdSchema,
  type CampaignPlayBootstrap,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";

const LOCAL_OWNER = "local-owner";

type CampaignPlayRepository = {
  getCampaignPlayBootstrap(
    principalId: string,
    campaignId: string,
    sessionId: string,
  ): CampaignPlayBootstrap | null;
};

/** Narrow repository lane required by the campaign play bootstrap route. */
export interface CampaignPlayHttpOptions {
  campaignPlayRepositoryAccessor: () => CampaignPlayRepository;
}

const hasQuery = (request: FastifyRequest): boolean => (request.raw.url ?? request.url).includes("?")
  || Object.keys(request.query as Record<string, unknown>).length > 0;

/** Registers the fixed-local-principal campaign play bootstrap read. */
export const campaignPlayHttpRoutes: FastifyPluginAsync<CampaignPlayHttpOptions> = async (app, options) => {
  app.get<{
    Params: { campaignId: string; sessionId: string };
    Querystring: Record<string, unknown>;
  }>("/campaigns/:campaignId/rooms/:sessionId/play-bootstrap", { exposeHeadRoute: false }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) {
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    }
    if (hasQuery(request)) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign play bootstrap does not accept query parameters");
    }
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_PLAY_NOT_FOUND", "Campaign play room not found");
    }
    const sessionId = campaignPlaySessionIdSchema.safeParse(request.params.sessionId);
    if (!sessionId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_PLAY_NOT_FOUND", "Campaign play room not found");
    }
    try {
      const bootstrap = options.campaignPlayRepositoryAccessor().getCampaignPlayBootstrap(
        LOCAL_OWNER, campaignId.data, sessionId.data,
      );
      if (bootstrap === null) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_PLAY_NOT_FOUND", "Campaign play room not found");
      }
      const response = campaignPlayBootstrapSchema.parse(bootstrap);
      if (response.campaignId !== campaignId.data || response.sessionId !== sessionId.data) {
        throw new Error("campaign play bootstrap does not match the request");
      }
      return reply.send(response);
    } catch {
      request.log.error({ operation: "campaign-play-bootstrap", method: request.method,
        route: request.routeOptions.url }, "RPG campaign play bootstrap failed");
      return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign play bootstrap could not be loaded");
    }
  });
};
