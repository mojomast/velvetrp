import {
  encounterPlanningRequestSchema,
  encounterPlanResponseSchema,
  encounterRewardPreviewRequestSchema,
  encounterRewardPreviewResponseSchema,
  npcSelectionRequestSchema,
  npcSelectionResponseSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import type { EncounterPlanningService } from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface EncounterPlanningHttpOptions {
  encounterPlanningAccessor: () => EncounterPlanningService;
}

function enabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics;
}

function invalid(request: FastifyRequest, reply: FastifyReply, detail: string) {
  return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", detail);
}

function campaignNotFound(request: FastifyRequest, reply: FastifyReply) {
  return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
}

function hasQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0;
}

function json(request: FastifyRequest): boolean {
  return typeof request.headers["content-type"] === "string" && JSON_MEDIA_TYPE.test(request.headers["content-type"]);
}

export const encounterPlanningHttpRoutes: FastifyPluginAsync<EncounterPlanningHttpOptions> = async (app, options) => {
  app.post<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/encounter-plans",
    { exposeHeadRoute: false },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      if (hasQuery(request)) return invalid(request, reply, "Encounter planning does not accept query parameters");
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success) return campaignNotFound(request, reply);
      if (!json(request)) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Encounter planning requires application/json");
      const body = encounterPlanningRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(request, reply, "Encounter planning request is invalid");
      const service = options.encounterPlanningAccessor();
      if (!service.hasCampaignCatalog(LOCAL_OWNER, campaignId.data)) return campaignNotFound(request, reply);
      try {
        const result = service.planEncounter(LOCAL_OWNER, campaignId.data, body.data);
        return reply.send(encounterPlanResponseSchema.parse(result));
      } catch (error) {
        request.log.error({ err: error instanceof Error ? error.name : "unknown" }, "encounter planning failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Encounter planning could not be completed");
      }
    },
  );

  app.post<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/encounter-reward-previews",
    { exposeHeadRoute: false },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      if (hasQuery(request)) return invalid(request, reply, "Encounter reward preview does not accept query parameters");
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success) return campaignNotFound(request, reply);
      if (!json(request)) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Encounter reward preview requires application/json");
      const body = encounterRewardPreviewRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(request, reply, "Encounter reward preview request is invalid");
      const service = options.encounterPlanningAccessor();
      if (!service.hasCampaignCatalog(LOCAL_OWNER, campaignId.data)) return campaignNotFound(request, reply);
      try {
        const { plan } = service.previewEncounterRewards(LOCAL_OWNER, campaignId.data, body.data);
        return reply.send(encounterRewardPreviewResponseSchema.parse(plan));
      } catch (error) {
        request.log.error({ err: error instanceof Error ? error.name : "unknown" }, "encounter reward preview failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Encounter reward preview could not be completed");
      }
    },
  );

  app.post<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/npc-selections",
    { exposeHeadRoute: false },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      if (hasQuery(request)) return invalid(request, reply, "NPC selection does not accept query parameters");
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success) return campaignNotFound(request, reply);
      if (!json(request)) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "NPC selection requires application/json");
      const body = npcSelectionRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(request, reply, "NPC selection request is invalid");
      const service = options.encounterPlanningAccessor();
      if (!service.hasCampaignCatalog(LOCAL_OWNER, campaignId.data)) return campaignNotFound(request, reply);
      try {
        return reply.send(npcSelectionResponseSchema.parse(service.selectNpcs(LOCAL_OWNER, campaignId.data, body.data)));
      } catch (error) {
        request.log.error({ err: error instanceof Error ? error.name : "unknown" }, "NPC selection failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "NPC selection could not be completed");
      }
    },
  );
};
