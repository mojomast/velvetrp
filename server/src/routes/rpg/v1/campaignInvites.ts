import {
  campaignInviteCreateRequestSchema,
  campaignInviteCreateResponseSchema,
  campaignInviteRedeemRequestSchema,
  campaignInviteRedeemResponseSchema,
  resourceIdSchema,
  type CampaignInviteCreateRequest,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import { createSessionCookie, getRequestPrincipal, resolveCampaignActorRole } from "../../../http/requestPrincipal.js";
import {
  CampaignInviteConflictError,
  CampaignInviteForbiddenError,
  CampaignInviteInvalidError,
  CampaignInviteNotFoundError,
  CampaignInviteStaleError,
} from "../../../repo/campaignInviteRepo.js";

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

/** Narrow invite lane required by the campaign invite routes. */
export interface CampaignInviteLaneRepository {
  createCampaignInvite(
    principalId: string,
    campaignId: string,
    input: CampaignInviteCreateRequest,
  ): { inviteId: string; role: string; expiresAt: string; token: string };
  redeemCampaignInvite(token: string): { principalId: string; role: string };
  listCampaignMemberships?(principalId: string, campaignId: string): unknown[];
}

export interface CampaignInviteHttpOptions {
  campaignInviteRepositoryAccessor: () => CampaignInviteLaneRepository;
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

function hasNoQuery(request: FastifyRequest): boolean {
  return (
    !(request.raw.url ?? request.url).includes("?") &&
    Object.keys(request.query as Record<string, unknown>).length === 0
  );
}

function invalid(request: FastifyRequest, reply: FastifyReply, detail: string) {
  return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", detail);
}

function requireJson(request: FastifyRequest, reply: FastifyReply) {
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string" && JSON_MEDIA_TYPE.test(contentType)) return null;
  return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign invites require application/json");
}

function mapInviteFailure(request: FastifyRequest, reply: FastifyReply, error: unknown, redeem: boolean) {
  if (error instanceof CampaignInviteForbiddenError) {
    return sendApiProblem(request, reply, 403, "RPG_FORBIDDEN", "Campaign invite is not permitted");
  }
  if (error instanceof CampaignInviteNotFoundError) {
    return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
  }
  if (error instanceof CampaignInviteStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_STALE", "Campaign is stale; refresh before editing");
  }
  if (error instanceof CampaignInviteConflictError) {
    return sendApiProblem(
      request,
      reply,
      409,
      "RPG_INVITE_CONFLICT",
      "Campaign invite conflicts with an earlier request",
    );
  }
  if (error instanceof CampaignInviteInvalidError) {
    return sendApiProblem(request, reply, 400, "RPG_INVITE_INVALID", "Campaign invite is invalid or expired");
  }
  request.log.error(
    { operation: redeem ? "campaign-invite-redeem" : "campaign-invite-create", method: request.method },
    "campaign invite operation failed",
  );
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign invite operation failed");
}

/** Registers authenticated campaign invite creation and token redemption. */
export const campaignInviteHttpRoutes: FastifyPluginAsync<CampaignInviteHttpOptions> = async (app, options) => {
  app.post<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>(
    "/campaigns/:campaignId/invites",
    { exposeHeadRoute: false },
    async (request, reply) => {
      noStore(reply);
      if (!readRpgFeatureFlags().campaign)
        return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      if (!hasNoQuery(request)) return invalid(request, reply, "Campaign invites do not accept query parameters");
      const mediaTypeFailure = requireJson(request, reply);
      if (mediaTypeFailure !== null) return mediaTypeFailure;
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success)
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      const principalId = getRequestPrincipal(request);
      if (principalId === null)
        return sendApiProblem(request, reply, 401, "RPG_AUTHENTICATION_REQUIRED", "Authentication required");
      const body = campaignInviteCreateRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(request, reply, "Campaign invite request is invalid");
      try {
        const repository = options.campaignInviteRepositoryAccessor();
        const role = resolveCampaignActorRole(
          principalId,
          campaignId.data,
          repository.listCampaignMemberships?.bind(repository),
        );
        if (role !== "owner" && role !== "gm")
          return sendApiProblem(request, reply, 403, "RPG_FORBIDDEN", "Campaign invite is not permitted");
        const response = campaignInviteCreateResponseSchema.parse(
          repository.createCampaignInvite(principalId, campaignId.data, body.data),
        );
        return reply.code(200).send(response);
      } catch (error) {
        return mapInviteFailure(request, reply, error, false);
      }
    },
  );

  app.post<{ Querystring: Record<string, unknown> }>(
    "/invites/redeem",
    { exposeHeadRoute: false },
    async (request, reply) => {
      noStore(reply);
      if (!readRpgFeatureFlags().campaign)
        return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      if (!hasNoQuery(request)) return invalid(request, reply, "Campaign invites do not accept query parameters");
      const mediaTypeFailure = requireJson(request, reply);
      if (mediaTypeFailure !== null) return mediaTypeFailure;
      const body = campaignInviteRedeemRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(request, reply, "Campaign invite redemption request is invalid");
      try {
        const response = campaignInviteRedeemResponseSchema.parse(
          options.campaignInviteRepositoryAccessor().redeemCampaignInvite(body.data.token),
        );
        reply.header("set-cookie", createSessionCookie(response.principalId));
        return reply.code(200).send(response);
      } catch (error) {
        return mapInviteFailure(request, reply, error, true);
      }
    },
  );
};
