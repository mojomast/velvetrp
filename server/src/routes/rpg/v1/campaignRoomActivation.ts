import { campaignRoomActivationReadinessSchema, campaignRoomActivationRequestSchema,
  campaignRoomActivationResponseSchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import { CampaignRoomActivationConflictError, CampaignRoomActivationUnavailableError,
  type CampaignRoomActivationRepository } from "../../../repo/campaignRoomActivationRepo.js";

// This is the trusted-local API, not an authenticated multiplayer endpoint.
const PRINCIPAL = "local-owner";
const json = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type Params = { campaignId: string; sessionId: string };

export const campaignRoomActivationHttpRoutes: FastifyPluginAsync<{
  activationRepositoryAccessor: () => CampaignRoomActivationRepository;
}> = async (app, options) => {
  function gate(request: FastifyRequest, reply: FastifyReply, write: boolean) {
    reply.header("cache-control", "private, no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    if ((request.raw.url ?? request.url).includes("?")) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Activation does not accept query parameters");
    if (write && !json.test(request.headers["content-type"] ?? "")) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Activation requires application/json");
  }
  function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
    if (error instanceof CampaignRoomActivationUnavailableError) return sendApiProblem(request, reply, 404, "RPG_ROOM_ACTIVATION_NOT_FOUND", "Campaign room not found");
    if (error instanceof CampaignRoomActivationConflictError) return sendApiProblem(request, reply, 409, "RPG_ROOM_ACTIVATION_CONFLICT", "Activation conflicts with current state or request identity; read activation-readiness");
    request.log.error({ operation: "campaign-room-activation" }, "Campaign room activation failed");
    return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Activation outcome is unknown; reconcile using the identical activation request");
  }
  app.get<{ Params: Params }>("/campaigns/:campaignId/rooms/:sessionId/activation-readiness", {
    exposeHeadRoute: false, onRequest: async (request, reply) => { await gate(request, reply, false); },
  }, async (request, reply) => {
    const campaign = resourceIdSchema.safeParse(request.params.campaignId), session = resourceIdSchema.safeParse(request.params.sessionId);
    if (!campaign.success || !session.success) return failure(request, reply, new CampaignRoomActivationUnavailableError());
    if (request.body !== undefined) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Readiness does not accept a body");
    try {
      const result = campaignRoomActivationReadinessSchema.parse(options.activationRepositoryAccessor()
        .getCampaignRoomActivationReadiness(PRINCIPAL, campaign.data, session.data));
      if (result.campaignId !== campaign.data || result.sessionId !== session.data) throw new Error("readiness binding mismatch");
      return reply.send(result);
    } catch (error) { return failure(request, reply, error); }
  });
  app.post<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/activation-commands", {
    onRequest: async (request, reply) => { await gate(request, reply, true); },
    errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Activation request is invalid"),
  }, async (request, reply) => {
    const campaign = resourceIdSchema.safeParse(request.params.campaignId), session = resourceIdSchema.safeParse(request.params.sessionId);
    if (!campaign.success || !session.success) return failure(request, reply, new CampaignRoomActivationUnavailableError());
    const body = campaignRoomActivationRequestSchema.safeParse(request.body);
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Activation request is invalid");
    try {
      const result = campaignRoomActivationResponseSchema.parse(options.activationRepositoryAccessor()
        .activateCampaignRoom(PRINCIPAL, campaign.data, session.data, body.data));
      if (result.readiness.campaignId !== campaign.data || result.readiness.sessionId !== session.data
        || result.readiness.expectedRevision !== body.data.expectedRevision || result.receipt.idempotencyKey !== body.data.idempotencyKey) throw new Error("activation binding mismatch");
      return reply.send(result);
    } catch (error) { return failure(request, reply, error); }
  });
};
