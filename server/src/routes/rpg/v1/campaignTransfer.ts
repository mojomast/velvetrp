import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  campaignTransferHttpApplyRequestSchema,
  campaignTransferHttpApplyResponseSchema,
  campaignTransferHttpDryRunRequestSchema,
  campaignTransferHttpDryRunResponseSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import type { CampaignAdministrationRepository } from "../../../repo/campaignAdministrationRepo.js";
import {
  CampaignAdministrationConflictError,
  CampaignAdministrationForbiddenError,
  CampaignAdministrationStaleError,
} from "../../../repo/campaignAdministrationRepo.js";

const LOCAL_OWNER = "local-owner";
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface CampaignTransferHttpOptions {
  campaignTransferRepositoryAccessor: () => Pick<CampaignAdministrationRepository,
    "dryRunCampaignImport" | "applyCampaignImportById">;
}

function noStore(reply: FastifyReply): void { reply.header("cache-control", "no-store"); }

function invalid(request: FastifyRequest, reply: FastifyReply, detail = "Campaign import request is invalid") {
  return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", detail);
}

export const campaignTransferHttpRoutes: FastifyPluginAsync<CampaignTransferHttpOptions> = async (app, options) => {
  app.post<{ Querystring: Record<string, unknown>; Body: unknown }>("/campaign-imports", {
    exposeHeadRoute: false,
    errorHandler: (error, request, reply) => {
      noStore(reply);
      if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
        return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign import requires application/json");
      }
      return invalid(request, reply);
    },
  }, async (request, reply) => {
    noStore(reply);
    if (!readRpgFeatureFlags().campaign) {
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    }
    if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
      return invalid(request, reply, "Campaign import does not accept query parameters");
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !JSON_MEDIA_TYPE.test(contentType)) {
      return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign import requires application/json");
    }
    const body = campaignTransferHttpDryRunRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    try {
      const { packageHash: _packageHash, ...dryRun } = options.campaignTransferRepositoryAccessor()
        .dryRunCampaignImport(LOCAL_OWNER, body.data.package);
      return reply.code(200).send(campaignTransferHttpDryRunResponseSchema.parse(dryRun));
    } catch {
      return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
        "Campaign import status is unknown; refresh before trying again; never retry automatically");
    }
  });

  app.post<{ Params: { importId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaign-imports/:importId/apply",
    {
      exposeHeadRoute: false,
      errorHandler: (error, request, reply) => {
        noStore(reply);
        if (!readRpgFeatureFlags().campaign) {
          return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found",
            { instance: "/api/rpg/v1/campaign-imports/:importId/apply" });
        }
        if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
          return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE",
            "Campaign import apply requires application/json",
            { instance: "/api/rpg/v1/campaign-imports/:importId/apply" });
        }
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign import apply request is invalid",
          { instance: "/api/rpg/v1/campaign-imports/:importId/apply" });
      },
    },
    async (request, reply) => {
      noStore(reply);
      const instance = "/api/rpg/v1/campaign-imports/:importId/apply";
      if (!readRpgFeatureFlags().campaign) {
        return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found", { instance });
      }
      if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
          "Campaign import apply does not accept query parameters", { instance });
      }
      const importId = resourceIdSchema.safeParse(request.params.importId);
      if (!importId.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
        "Campaign import apply request is invalid", { instance });
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !JSON_MEDIA_TYPE.test(contentType)) {
        return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE",
          "Campaign import apply requires application/json", { instance });
      }
      const body = campaignTransferHttpApplyRequestSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
        "Campaign import apply request is invalid", { instance });
      try {
        const result = options.campaignTransferRepositoryAccessor()
          .applyCampaignImportById(LOCAL_OWNER, importId.data, body.data);
        const response = campaignTransferHttpApplyResponseSchema.parse({ campaign: result.value, receipt: result.receipt });
        const bound = response.campaign.actorRole === "owner"
          && response.receipt.type === "import_applied"
          && response.receipt.campaignId === response.campaign.id
          && response.receipt.events.every((event) => event.campaignId === response.campaign.id
            && event.commandId === response.receipt.commandId && event.type === "import_applied"
            && event.revision === response.receipt.revisionAfter
            && event.occurredAt === response.receipt.occurredAt);
        if (!bound) throw new Error("invalid repository output binding");
        return reply.code(200).send(response);
      } catch (error) {
        if (error instanceof CampaignAdministrationForbiddenError) {
          return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_IMPORT_NOT_FOUND",
            "Campaign import was not found", { instance });
        }
        if (error instanceof CampaignAdministrationConflictError || error instanceof CampaignAdministrationStaleError) {
          return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_IMPORT_CONFLICT",
            "Campaign import dry-run is invalid, stale, or conflicts with the requested identity", { instance });
        }
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
          "Campaign import outcome is unknown; reconcile with the campaign list before trying again; never retry automatically",
          { instance });
      }
    },
  );
};
