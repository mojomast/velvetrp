import {
  campaignReadyCheckCommandResponseSchema,
  campaignReadyCheckCommandSchema,
  campaignReadyCheckStateSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  CampaignReadyCheckConflictError,
  CampaignReadyCheckUnavailableError,
  type CampaignReadyCheckRepository,
} from "../../../repo/campaignReadyCheckRepo.js";

// This is the trusted-local API, not an authenticated multiplayer endpoint.
const PRINCIPAL = "local-owner";
const json = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type Params = { campaignId: string; sessionId: string };

type ReadyCheckRepositoryLike = {
  getReadyCheck: (...args: Parameters<CampaignReadyCheckRepository["getReadyCheck"]>) => unknown;
  commandReadyCheck: (...args: Parameters<CampaignReadyCheckRepository["commandReadyCheck"]>) => unknown;
};

export const campaignReadyCheckHttpRoutes: FastifyPluginAsync<{
  readyCheckRepositoryAccessor: () => ReadyCheckRepositoryLike;
}> = async (app, options) => {
  // The production plugin is mounted under /api/rpg/v1; direct route tests mount
  // this plugin at the root and address the same public paths.
  const base = app.prefix ? "" : "/api/rpg/v1";
  const readyCheckPath = `${base}/campaigns/:campaignId/rooms/:sessionId/ready-check`;
  function gate(request: FastifyRequest, reply: FastifyReply, write: boolean) {
    reply.header("cache-control", "private, no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics)
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    if ((request.raw.url ?? request.url).includes("?"))
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Ready-check commands do not accept queries");
    if (write && !json.test(request.headers["content-type"] ?? ""))
      return sendApiProblem(
        request,
        reply,
        415,
        "RPG_UNSUPPORTED_MEDIA_TYPE",
        "Ready-check commands require application/json",
      );
  }
  function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
    if (error instanceof CampaignReadyCheckUnavailableError)
      return sendApiProblem(request, reply, 404, "RPG_READY_CHECK_NOT_FOUND", "Campaign room not found");
    if (error instanceof CampaignReadyCheckConflictError)
      return sendApiProblem(
        request,
        reply,
        409,
        "RPG_READY_CHECK_CONFLICT",
        "Ready-check command conflicts with current room state",
      );
    request.log.error({ operation: "campaign-ready-check" }, "Campaign ready-check command failed");
    return sendApiProblem(
      request,
      reply,
      500,
      "RPG_INTERNAL_ERROR",
      "Ready-check outcome is unknown; reconcile using the identical request",
    );
  }
  app.get<{ Params: Params }>(
    readyCheckPath,
    {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        await gate(request, reply, false);
      },
    },
    async (request, reply) => {
      const campaign = resourceIdSchema.safeParse(request.params.campaignId),
        session = resourceIdSchema.safeParse(request.params.sessionId);
      if (!campaign.success || !session.success)
        return failure(request, reply, new CampaignReadyCheckUnavailableError());
      if (request.body !== undefined)
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Ready-check reads do not accept a body");
      try {
        const result = campaignReadyCheckStateSchema.parse(
          options.readyCheckRepositoryAccessor().getReadyCheck(PRINCIPAL, campaign.data, session.data),
        );
        if (result.campaignId !== campaign.data || result.sessionId !== session.data)
          throw new Error("ready-check binding mismatch");
        return reply.send(result);
      } catch (error) {
        return failure(request, reply, error);
      }
    },
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${readyCheckPath}/commands`,
    {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        await gate(request, reply, true);
      },
      errorHandler: (_error, request, reply) =>
        sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Ready-check command is invalid"),
    },
    async (request, reply) => {
      const campaign = resourceIdSchema.safeParse(request.params.campaignId),
        session = resourceIdSchema.safeParse(request.params.sessionId);
      if (!campaign.success || !session.success)
        return failure(request, reply, new CampaignReadyCheckUnavailableError());
      const body = campaignReadyCheckCommandSchema.safeParse(request.body);
      if (!body.success)
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Ready-check command is invalid");
      try {
        const result = campaignReadyCheckCommandResponseSchema.parse(
          options.readyCheckRepositoryAccessor().commandReadyCheck(PRINCIPAL, campaign.data, session.data, body.data),
        );
        if (
          result.campaignId !== campaign.data ||
          result.sessionId !== session.data ||
          result.receipt.idempotencyKey !== body.data.idempotencyKey
        )
          throw new Error("ready-check binding mismatch");
        return reply.send(result);
      } catch (error) {
        return failure(request, reply, error);
      }
    },
  );
};
