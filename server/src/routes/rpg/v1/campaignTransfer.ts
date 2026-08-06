import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  campaignTransferHttpDryRunRequestSchema,
  campaignTransferHttpDryRunResponseSchema,
} from "@velvet/contracts";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import type { CampaignAdministrationRepository } from "../../../repo/campaignAdministrationRepo.js";

const LOCAL_OWNER = "local-owner";
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface CampaignTransferHttpOptions {
  campaignTransferRepositoryAccessor: () => Pick<CampaignAdministrationRepository, "dryRunCampaignImport">;
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
};
