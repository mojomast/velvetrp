import {
  campaignContextInspectionDispatchReferenceSourceSchema,
  campaignContextInspectionDispatchReferenceSelectorIdentitySchema,
  campaignContextInspectionDispatchReferenceSelectorSchema,
  campaignContextInspectionIdentitySchema,
  campaignContextInspectionResponseSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  CampaignContextInspectionUnavailableError,
  type CampaignContextInspectionReadRepository,
} from "../../../repo/campaign/campaignContextInspectionReadRepo.js";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";

const PRINCIPAL = "local-owner";
type InspectionParams = { campaignId: string; sessionId: string; lane: string; dispatchId: string };
type ReferenceParams = { campaignId: string; sessionId: string; sourceKind: string; sourceId: string };

const notFound = (request: FastifyRequest, reply: FastifyReply) =>
  sendApiProblem(request, reply, 404, "RPG_CONTEXT_INSPECTION_NOT_FOUND", "Campaign context inspection unavailable");

export const campaignContextInspectionHttpRoutes: FastifyPluginAsync<{
  repositoryAccessor: () => CampaignContextInspectionReadRepository;
}> = async (app, options) => {
  const gate = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "private, no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query as object).length > 0)
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign context inspection does not accept query parameters");
  };
  const hasBody = (request: FastifyRequest): boolean => request.body !== undefined || Number(request.headers["content-length"] ?? 0) > 0;

  app.get<{ Params: InspectionParams; Body: unknown }>(
    "/campaigns/:campaignId/rooms/:sessionId/context-inspection/:lane/:dispatchId",
    { exposeHeadRoute: false, onRequest: gate },
    async (request, reply) => {
      if (hasBody(request)) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "GET does not accept a body");
      const identity = campaignContextInspectionIdentitySchema.safeParse(request.params);
      if (!identity.success) return notFound(request, reply);
      try {
        const candidate = options.repositoryAccessor().inspectCampaignContext(PRINCIPAL, identity.data);
        const rawIdentity = (candidate as { identity?: Partial<typeof identity.data> }).identity;
        if (rawIdentity?.campaignId !== identity.data.campaignId || rawIdentity.sessionId !== identity.data.sessionId
          || rawIdentity.lane !== identity.data.lane || rawIdentity.dispatchId !== identity.data.dispatchId) return notFound(request, reply);
        const response = campaignContextInspectionResponseSchema.parse(candidate);
        if (response.availability === "unavailable" && response.reason === "access-revoked") return notFound(request, reply);
        return reply.send(response);
      } catch (error) {
        if (error instanceof CampaignContextInspectionUnavailableError) return notFound(request, reply);
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign context inspection could not be loaded");
      }
    },
  );

  app.get<{ Params: ReferenceParams; Body: unknown }>(
    "/campaigns/:campaignId/rooms/:sessionId/context-inspection/references/:sourceKind/:sourceId",
    { exposeHeadRoute: false, onRequest: gate },
    async (request, reply) => {
      if (hasBody(request)) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "GET does not accept a body");
      const source = campaignContextInspectionDispatchReferenceSourceSchema.safeParse({
        kind: request.params.sourceKind,
        sourceId: request.params.sourceId,
      });
      const pathIdentity = campaignContextInspectionDispatchReferenceSelectorIdentitySchema.safeParse({
        campaignId: request.params.campaignId,
        sessionId: request.params.sessionId,
        source: source.success ? source.data : { kind: request.params.sourceKind, sourceId: request.params.sourceId },
      });
      if (!source.success || !pathIdentity.success) return notFound(request, reply);
      const identity = pathIdentity.data;
      try {
        const candidate = options.repositoryAccessor().resolveCampaignContextInspectionDispatchReferences(PRINCIPAL, identity);
        const rawIdentity = (candidate as { identity?: { campaignId?: unknown; sessionId?: unknown; source?: { kind?: unknown; sourceId?: unknown } } }).identity;
        if (rawIdentity?.campaignId !== identity.campaignId || rawIdentity.sessionId !== identity.sessionId
          || rawIdentity.source?.kind !== identity.source.kind || rawIdentity.source.sourceId !== identity.source.sourceId) return notFound(request, reply);
        const response = campaignContextInspectionDispatchReferenceSelectorSchema.parse(candidate);
        return reply.send(response);
      } catch (error) {
        if (error instanceof CampaignContextInspectionUnavailableError) return notFound(request, reply);
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign context inspection references could not be loaded");
      }
    },
  );
};
