import { campaignRoomParticipantRequestSchema, campaignRoomParticipantResponseSchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import { CampaignRoomParticipantConflictError, CampaignRoomParticipantUnavailableError,
  type CampaignRoomParticipantRepository } from "../../../repo/campaignRoomParticipantRepo.js";

// This is the trusted-local API, not an authenticated multiplayer endpoint.
const PRINCIPAL = "local-owner";
const json = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type Params = { campaignId: string; sessionId: string };

export const campaignRoomParticipantHttpRoutes: FastifyPluginAsync<{
  participantRepositoryAccessor: () => CampaignRoomParticipantRepository;
}> = async (app, options) => {
  function gate(request: FastifyRequest, reply: FastifyReply, write: boolean) {
    reply.header("cache-control", "private, no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    if ((request.raw.url ?? request.url).includes("?")) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Participant commands do not accept query parameters");
    if (write && !json.test(request.headers["content-type"] ?? "")) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Participant commands require application/json");
  }
  function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
    if (error instanceof CampaignRoomParticipantUnavailableError) return sendApiProblem(request, reply, 404, "RPG_ROOM_PARTICIPANT_NOT_FOUND", "Campaign room not found");
    if (error instanceof CampaignRoomParticipantConflictError) return sendApiProblem(request, reply, 409, "RPG_ROOM_PARTICIPANT_CONFLICT", "Participant change conflicts with current room state");
    request.log.error({ operation: "campaign-room-participant" }, "Campaign room participant command failed");
    return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Participant outcome is unknown; reconcile using the identical request");
  }
  app.post<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/participant-commands", {
    exposeHeadRoute: false,
    onRequest: async (request, reply) => { await gate(request, reply, true); },
    errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Participant request is invalid"),
  }, async (request, reply) => {
    const campaign = resourceIdSchema.safeParse(request.params.campaignId), session = resourceIdSchema.safeParse(request.params.sessionId);
    if (!campaign.success || !session.success) return failure(request, reply, new CampaignRoomParticipantUnavailableError());
    const body = campaignRoomParticipantRequestSchema.safeParse(request.body);
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Participant request is invalid");
    try {
      const result = campaignRoomParticipantResponseSchema.parse(options.participantRepositoryAccessor()
        .addCampaignRoomParticipant(PRINCIPAL, campaign.data, session.data, body.data));
      if (result.campaignId !== campaign.data || result.sessionId !== session.data
        || result.receipt.idempotencyKey !== body.data.idempotencyKey) throw new Error("participant binding mismatch");
      return reply.send(result);
    } catch (error) { return failure(request, reply, error); }
  });
};
