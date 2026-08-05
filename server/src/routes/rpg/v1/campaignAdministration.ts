import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  campaignAdministrationHttpArchiveRequestSchema,
  campaignAdministrationHttpArchiveResponseSchema,
  campaignAdministrationHttpGetResponseSchema,
  campaignAdministrationHttpPatchRequestSchema,
  campaignAdministrationHttpPatchResponseSchema,
  campaignAdministrationSchema,
  resourceIdSchema,
} from "@velvet/contracts";
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
const PATH = "/campaigns/:campaignId/administration";

export interface CampaignAdministrationHttpOptions {
  campaignAdministrationRepositoryAccessor: () => Pick<CampaignAdministrationRepository,
    "getCampaignAdministration" | "updateCampaignAdministration" | "archiveCampaignWithConfirmation">;
}

function noStore(reply: FastifyReply): void { reply.header("cache-control", "no-store"); }

function invalid(request: FastifyRequest, reply: FastifyReply, detail = "Campaign administration request is invalid") {
  return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", detail);
}

function safeProjection(value: unknown): unknown {
  if (value === null) throw new CampaignAdministrationForbiddenError();
  const parsed = campaignAdministrationSchema.parse(value);
  if (parsed.actorRole === "owner" || parsed.actorRole === "gm") return parsed;
  // This branch is defensive for alternate repository implementations. Never
  // let a public role accidentally receive the privileged gmNotes field.
  return { ...parsed, settings: { ...parsed.settings } };
}

function mapFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CampaignAdministrationForbiddenError) {
    return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
  }
  if (error instanceof CampaignAdministrationStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_ADMINISTRATION_STALE", "Campaign administration is stale; refresh before editing");
  }
  if (error instanceof CampaignAdministrationConflictError) {
    const transition = error.message === "illegal lifecycle transition";
    return sendApiProblem(request, reply, 409,
      transition ? "RPG_CAMPAIGN_ADMINISTRATION_TRANSITION_CONFLICT" : "RPG_CAMPAIGN_ADMINISTRATION_CONFLICT",
      transition ? "Campaign lifecycle transition is not allowed" : "Campaign administration conflicts with current state");
  }
  // A write may have committed even when its response was lost. Explicitly do
  // not invite an automatic retry, and never serialize repository details.
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Campaign administration status is unknown; refresh before trying again; never retry automatically");
}

export const campaignAdministrationHttpRoutes: FastifyPluginAsync<CampaignAdministrationHttpOptions> = async (app, options) => {
  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);

    // Keep this order deliberate: feature state and request shape are checked
    // before any caller-controlled identifier reaches the repository.
    if (!readRpgFeatureFlags().campaign) {
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    }
    if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0) {
      return invalid(request, reply, "Campaign administration does not accept query parameters");
    }
    const campaignId = resourceIdSchema.safeParse((request.params as { campaignId?: unknown }).campaignId);
    if (!campaignId.success) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");

    if (request.method === "PATCH") {
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !JSON_MEDIA_TYPE.test(contentType)) {
        return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign administration requires application/json");
      }
      const body = campaignAdministrationHttpPatchRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(request, reply);
      try {
        const repository = options.campaignAdministrationRepositoryAccessor();
        const result = repository.updateCampaignAdministration(LOCAL_OWNER, campaignId.data, body.data);
        const value = safeProjection(result.value);
        const bound = campaignAdministrationSchema.parse(value);
        if (bound.id !== campaignId.data) throw new Error("response campaign does not match request");
        if (result.receipt.campaignId !== campaignId.data) throw new Error("response receipt does not match request");
        const response = { campaign: bound, receipt: result.receipt };
        return reply.code(200).send(campaignAdministrationHttpPatchResponseSchema.parse(response));
      } catch (error) {
        return mapFailure(request, reply, error);
      }
    }
    if (request.method === "DELETE") {
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !JSON_MEDIA_TYPE.test(contentType)) {
        return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign administration requires application/json");
      }
      const body = campaignAdministrationHttpArchiveRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(request, reply);
      try {
        const result = options.campaignAdministrationRepositoryAccessor()
          .archiveCampaignWithConfirmation(LOCAL_OWNER, campaignId.data, body.data);
        const value = safeProjection(result.value);
        const bound = campaignAdministrationSchema.parse(value);
        if (bound.id !== campaignId.data) throw new Error("response campaign does not match request");
        if (result.receipt.campaignId !== campaignId.data) throw new Error("response receipt does not match request");
        return reply.code(200).send(campaignAdministrationHttpArchiveResponseSchema.parse({
          campaign: bound,
          receipt: result.receipt,
        }));
      } catch (error) {
        return mapFailure(request, reply, error);
      }
    }
    try {
      const value = safeProjection(options.campaignAdministrationRepositoryAccessor()
        .getCampaignAdministration(LOCAL_OWNER, campaignId.data));
      const bound = campaignAdministrationSchema.parse(value);
      if (bound.id !== campaignId.data) throw new Error("response campaign does not match request");
      return reply.code(200).send(campaignAdministrationHttpGetResponseSchema.parse({ campaign: bound }));
    } catch (error) {
      return mapFailure(request, reply, error);
    }
  };

  app.get<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>(PATH, { exposeHeadRoute: false }, handle);
  app.patch<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>(PATH, { exposeHeadRoute: false, errorHandler: (_error, request, reply) =>
    invalid(request, reply) }, handle);
  app.delete<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>(PATH, { exposeHeadRoute: false, errorHandler: (_error, request, reply) => {
    noStore(reply);
    return invalid(request, reply);
  } }, handle);
};
