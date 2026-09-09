import {
  campaignStartingLocationDesignationRequestSchema,
  campaignStartingLocationDesignationResponseSchema,
  campaignStartingLocationReadResponseSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  CampaignStartingLocationAuthorizationError,
  CampaignStartingLocationConflictError,
  CampaignStartingLocationStaleError,
  CampaignStartingLocationUnavailableError,
  type CampaignStartingLocationRepository,
} from "../../../repo/campaignStartingLocationRepo.js";

const PRINCIPAL = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export const campaignStartingLocationHttpRoutes: FastifyPluginAsync<{
  startingLocationRepositoryAccessor: () => CampaignStartingLocationRepository;
}> = async (app, options) => {
  const unavailable = (request: FastifyRequest, reply: FastifyReply) =>
    sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_STARTING_LOCATION_NOT_FOUND", "Campaign or public location not found");
  const failure = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    if (error instanceof CampaignStartingLocationAuthorizationError || error instanceof CampaignStartingLocationUnavailableError) return unavailable(request, reply);
    if (error instanceof CampaignStartingLocationStaleError) return sendApiProblem(request, reply, 409,
      "RPG_CAMPAIGN_STARTING_LOCATION_STALE", "Campaign revision is stale; read the starting location before retrying");
    if (error instanceof CampaignStartingLocationConflictError) return sendApiProblem(request, reply, 409,
      "RPG_CAMPAIGN_STARTING_LOCATION_CONFLICT", "Starting-location designation conflicts with current campaign state or request identity");
    request.log.error({ operation: "campaign-starting-location" }, "Campaign starting-location operation failed");
    return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
      "Starting-location outcome could not be confirmed; reconcile with GET and do not automatically retry");
  };
  const gate = (request: FastifyRequest, reply: FastifyReply, write: boolean) => {
    reply.header("cache-control", "private, no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    if ((request.raw.url ?? request.url).includes("?")) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Starting location does not accept query parameters");
    if (write && !APPLICATION_JSON.test(request.headers["content-type"] ?? "")) return sendApiProblem(request, reply, 415,
      "RPG_UNSUPPORTED_MEDIA_TYPE", "Starting-location designation requires application/json");
  };
  app.get<{ Params: { campaignId: string } }>("/campaigns/:campaignId/starting-location", {
    exposeHeadRoute: false, onRequest: async (request, reply) => { await gate(request, reply, false); },
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) return unavailable(request, reply);
    if (request.body !== undefined) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Starting-location read does not accept a body");
    try {
      const result = options.startingLocationRepositoryAccessor().getCampaignStartingLocation(PRINCIPAL, campaignId.data);
      if (!result) return unavailable(request, reply);
      if (result.campaignId !== campaignId.data) throw new Error("starting-location read binding mismatch");
      return reply.code(200).send(campaignStartingLocationReadResponseSchema.parse(result));
    } catch (error) { return failure(request, reply, error); }
  });
  app.post<{ Params: { campaignId: string }; Body: unknown }>("/campaigns/:campaignId/starting-location-commands", {
    onRequest: async (request, reply) => { await gate(request, reply, true); },
    errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Starting-location designation request is invalid"),
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) return unavailable(request, reply);
    const body = campaignStartingLocationDesignationRequestSchema.safeParse(request.body);
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Starting-location designation request is invalid");
    try {
      const result = options.startingLocationRepositoryAccessor().designateCampaignStartingLocation(PRINCIPAL, campaignId.data, body.data);
      if (result.campaignId !== campaignId.data || result.startingLocation.locationId !== body.data.locationId
        || result.receipt.idempotencyKey !== body.data.idempotencyKey || result.receipt.revisionBefore !== body.data.expectedRevision) {
        throw new Error("starting-location write binding mismatch");
      }
      return reply.code(200).send(campaignStartingLocationDesignationResponseSchema.parse(result));
    } catch (error) { return failure(request, reply, error); }
  });
};
