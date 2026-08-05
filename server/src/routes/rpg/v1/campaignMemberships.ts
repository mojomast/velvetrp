import {
  campaignAdministrationHttpMembershipCreateRequestSchema,
  campaignAdministrationHttpMembershipDeleteRequestSchema,
  campaignAdministrationHttpMembershipListResponseSchema,
  campaignAdministrationHttpMembershipMutationResponseSchema,
  campaignAdministrationHttpMembershipUpdateRequestSchema,
  campaignAdministrationHttpRoomDetachRequestSchema,
  campaignAdministrationHttpRoomDetachResponseSchema,
  campaignMembershipReadSchema,
  campaignRoomMutationSchema,
  campaignSessionAttachmentSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  CampaignAdministrationConflictError,
  CampaignAdministrationForbiddenError,
  CampaignAdministrationStaleError,
  type CampaignAdministrationRepository,
} from "../../../repo/campaignAdministrationRepo.js";

const LOCAL_OWNER = "local-owner";
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

type MembershipRepository = Pick<CampaignAdministrationRepository,
  "addAuditedCampaignMembership" | "changeAuditedCampaignMembershipRole" | "removeAuditedCampaignMembership"
  | "detachAuditedCampaignRoom"> & {
  listCampaignMemberships(actorPrincipalId: string, campaignId: string): unknown[];
};

export interface CampaignMembershipHttpOptions {
  campaignMembershipRepositoryAccessor: () => MembershipRepository;
}

function noStore(reply: FastifyReply): void { reply.header("cache-control", "no-store"); }
function invalid(request: FastifyRequest, reply: FastifyReply, detail: string) {
  return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", detail);
}
function hasNoQuery(request: FastifyRequest): boolean {
  return !(request.raw.url ?? request.url).includes("?")
    && Object.keys(request.query as Record<string, unknown>).length === 0;
}
function campaignId(request: FastifyRequest): string | null {
  const parsed = resourceIdSchema.safeParse((request.params as { campaignId?: unknown }).campaignId);
  return parsed.success ? parsed.data : null;
}
function principalId(request: FastifyRequest): string | null {
  const parsed = resourceIdSchema.safeParse((request.params as { principalId?: unknown }).principalId);
  return parsed.success ? parsed.data : null;
}
function sessionId(request: FastifyRequest): string | null {
  // Room IDs predate resource IDs and intentionally retain their opaque form.
  const value = (request.params as { sessionId?: unknown }).sessionId;
  return typeof value === "string" && value.length > 0 ? value : null;
}
function mapFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CampaignAdministrationForbiddenError) {
    return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
  }
  if (error instanceof CampaignAdministrationStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_ADMINISTRATION_STALE", "Campaign administration is stale; refresh before editing");
  }
  if (error instanceof CampaignAdministrationConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_MEMBERSHIP_CONFLICT", "Campaign membership conflicts with current state");
  }
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Campaign membership status is unknown; refresh before trying again; never retry automatically");
}

export const campaignMembershipHttpRoutes: FastifyPluginAsync<CampaignMembershipHttpOptions> = async (app, options) => {
  const membershipPath = "/campaigns/:campaignId/memberships";
  const memberPath = `${membershipPath}/:principalId`;

  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>(membershipPath,
    { exposeHeadRoute: false }, async (request, reply) => {
      noStore(reply);
      if (!readRpgFeatureFlags().campaign) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      if (!hasNoQuery(request)) return invalid(request, reply, "Campaign memberships do not accept query parameters");
      const id = campaignId(request);
      if (id === null) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      try {
        const memberships = options.campaignMembershipRepositoryAccessor().listCampaignMemberships(LOCAL_OWNER, id)
          .map((membership) => campaignMembershipReadSchema.parse(membership));
        if (memberships.length === 0 || memberships.some((membership) => membership.campaignId !== id)) {
          throw new CampaignAdministrationForbiddenError();
        }
        return reply.code(200).send(campaignAdministrationHttpMembershipListResponseSchema.parse({
          memberships: memberships.map(({ campaignId: _campaignId, ...membership }) => membership),
        }));
      } catch (error) { return mapFailure(request, reply, error); }
    });

  const mutate = async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    if (!readRpgFeatureFlags().campaign) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    if (!hasNoQuery(request)) return invalid(request, reply, "Campaign membership requests do not accept query parameters");
    const id = campaignId(request);
    if (id === null) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !JSON_MEDIA_TYPE.test(contentType)) {
      return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign membership requires application/json");
    }
    try {
      const repository = options.campaignMembershipRepositoryAccessor();
      if (request.method === "POST") {
        const body = campaignAdministrationHttpMembershipCreateRequestSchema.safeParse(request.body);
        if (!body.success) return invalid(request, reply, "Campaign membership request is invalid");
        const result = repository.addAuditedCampaignMembership(LOCAL_OWNER, id, body.data);
        const membership = campaignMembershipReadSchema.parse(result.value);
        if (membership.campaignId !== id || membership.principalId !== body.data.principalId || result.receipt.campaignId !== id) throw new Error("membership response does not match request");
        const { campaignId: _campaignId, ...projection } = membership;
        return reply.code(200).send(campaignAdministrationHttpMembershipMutationResponseSchema.parse({ membership: projection, receipt: result.receipt }));
      }
      const target = principalId(request);
      if (target === null) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_MEMBERSHIP_NOT_FOUND", "Campaign membership not found");
      if (request.method === "PATCH") {
        const body = campaignAdministrationHttpMembershipUpdateRequestSchema.safeParse(request.body);
        if (!body.success) return invalid(request, reply, "Campaign membership request is invalid");
        const result = repository.changeAuditedCampaignMembershipRole(LOCAL_OWNER, id, target, body.data);
        const membership = campaignMembershipReadSchema.parse(result.value);
        if (membership.campaignId !== id || membership.principalId !== target || result.receipt.campaignId !== id) throw new Error("membership response does not match request");
        const { campaignId: _campaignId, ...projection } = membership;
        return reply.code(200).send(campaignAdministrationHttpMembershipMutationResponseSchema.parse({ membership: projection, receipt: result.receipt }));
      }
      const body = campaignAdministrationHttpMembershipDeleteRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(request, reply, "Campaign membership request is invalid");
      const result = repository.removeAuditedCampaignMembership(LOCAL_OWNER, id, target, body.data);
      const membership = campaignMembershipReadSchema.parse(result.value);
      if (membership.campaignId !== id || membership.principalId !== target || result.receipt.campaignId !== id) throw new Error("membership response does not match request");
      const { campaignId: _campaignId, ...projection } = membership;
      return reply.code(200).send(campaignAdministrationHttpMembershipMutationResponseSchema.parse({ membership: projection, receipt: result.receipt }));
    } catch (error) { return mapFailure(request, reply, error); }
  };
  const mutationOptions = { exposeHeadRoute: false, errorHandler: (_error: Error, request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply); return invalid(request, reply, "Campaign membership request is invalid");
  } };
  app.post(membershipPath, mutationOptions, mutate);
  app.patch(memberPath, mutationOptions, mutate);
  app.delete(memberPath, mutationOptions, mutate);

  app.delete<{ Params: { campaignId: string; sessionId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/rooms/:sessionId", mutationOptions, async (request, reply) => {
      noStore(reply);
      if (!readRpgFeatureFlags().campaign) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      if (!hasNoQuery(request)) return invalid(request, reply, "Campaign room detachment does not accept query parameters");
      const id = campaignId(request), room = sessionId(request);
      if (id === null) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      if (room === null) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_ROOM_NOT_FOUND", "Room not found");
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !JSON_MEDIA_TYPE.test(contentType)) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign room detachment requires application/json");
      const body = campaignAdministrationHttpRoomDetachRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(request, reply, "Campaign room detachment request is invalid");
      try {
        const result = options.campaignMembershipRepositoryAccessor().detachAuditedCampaignRoom(LOCAL_OWNER, id,
          campaignRoomMutationSchema.parse({ ...body.data, sessionId: room }));
        const attachment = campaignSessionAttachmentSchema.parse(result.value);
        if (attachment.campaignId !== id || attachment.sessionId !== room || result.receipt.campaignId !== id) throw new Error("room response does not match request");
        const { campaignId: _campaignId, ...projection } = attachment;
        return reply.code(200).send(campaignAdministrationHttpRoomDetachResponseSchema.parse({ attachment: projection, receipt: result.receipt }));
      } catch (error) { return mapFailure(request, reply, error); }
    });
};
