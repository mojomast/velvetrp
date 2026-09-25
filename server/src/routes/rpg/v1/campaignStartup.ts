import { resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { orchestrateCampaignDmBeat } from "../../../agent/campaignDmOrchestrator.js";
import type { AdventureAgentDependencies } from "../../../agent/adventureOrchestrator.js";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import { CampaignDmConflictError, CampaignDmUnavailableError, type CampaignDmRepository } from "../../../repo/campaignDmRepo.js";
import type { CampaignGenerationRepository } from "../../../repo/campaignGenerationRepo.js";
import type { CampaignStartupRepository } from "../../../repo/campaignStartupRepo.js";
import {
  AdventureTurnConflictError,
  AdventureTurnStaleError,
  AdventureTurnUnavailableError,
} from "../../../repo/index.js";
import {
  CampaignStartupConflictError,
  CampaignStartupUnavailableError,
  runCampaignStartup,
} from "../../../startup/campaignStartup.js";
import type { SceneImageRouteService } from "./sceneImages.js";

/**
 * Campaign startup command.
 *
 * `POST /api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/startup-commands`
 * is the single owner/GM command that sets AI delegation, publishes eligible
 * public materials, runs the opening beat, and enqueues one scene image per
 * public location. It is idempotent: the request carries no caller-controlled
 * command body, so replaying the identical request reconciles against the
 * durable state and the deterministic per-step keys.
 *
 * The trusted-local principal is the only caller identity, consistent with the
 * other RPG routes. The route never selects candidates or writes domain canon;
 * it delegates every step to the owning repos/services.
 */

const PRINCIPAL = "local-owner";
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const emptyBodySchema = z.object({}).strict();

type Params = { campaignId: string; sessionId: string };

export type CampaignStartupRepositoryPort = CampaignDmRepository
  & Pick<CampaignGenerationRepository, "getCampaignGeneratedPlanning" | "publishCampaignMaterial">
  & Pick<CampaignStartupRepository, "getCampaignStartupRead">;

export interface CampaignStartupHttpOptions {
  repositoryAccessor: () => CampaignStartupRepositoryPort;
  sceneImageServiceAccessor: () => SceneImageRouteService | null;
  sceneImageInstallationEnabled: () => boolean;
  agentDependencies?: AdventureAgentDependencies;
}

const startupBeatStateSchema = z.enum(["completed", "blocked", "planning", "awaiting-approval", "cancelled", "unknown", "none"]);
const campaignStartupResponseSchema = z.object({
  campaignId: resourceIdSchema,
  sessionId: resourceIdSchema,
  dmMode: z.enum(["human", "ai"]),
  dmModeRevision: z.number().int().min(0),
  published: z.array(z.string().min(1).max(200)).max(64),
  beat: z.object({ runId: resourceIdSchema.nullable(), state: startupBeatStateSchema }).strict(),
  imagesEnqueued: z.array(z.object({
    locationId: resourceIdSchema,
    jobId: resourceIdSchema.nullable(),
    deduped: z.boolean(),
    skipped: z.string().max(64).nullable(),
  }).strict()).max(64),
  blockers: z.array(z.string().max(200)).max(16),
}).strict();

export const campaignStartupHttpRoutes: FastifyPluginAsync<CampaignStartupHttpOptions> = async (app, options) => {
  const gate = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    reply.header("cache-control", "private, no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) {
      sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      return false;
    }
    if ((request.raw.url ?? request.url).includes("?")) {
      sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign startup does not accept query parameters");
      return false;
    }
    if (request.method === "POST" && !JSON_MEDIA_TYPE.test(request.headers["content-type"] ?? "")) {
      sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign startup requires application/json");
      return false;
    }
    return true;
  };

  const failure = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof CampaignStartupUnavailableError || error instanceof CampaignDmUnavailableError
      || error instanceof AdventureTurnUnavailableError) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_STARTUP_NOT_FOUND", "Campaign startup resource is unavailable");
    }
    if (error instanceof CampaignStartupConflictError || error instanceof CampaignDmConflictError
      || error instanceof AdventureTurnConflictError || error instanceof AdventureTurnStaleError) {
      return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_STARTUP_CONFLICT",
        "Campaign startup conflicts with current durable state; read campaign state before retrying");
    }
    request.log.error({ operation: "campaign-startup", method: request.method, route: request.routeOptions.url },
      "campaign startup failed");
    return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
      "Campaign startup outcome is unknown; reconcile the identical request before retrying");
  };

  app.post<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/startup-commands",
    { onRequest: async (request, reply) => { await gate(request, reply); } },
    async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const sessionId = resourceIdSchema.safeParse(request.params.sessionId);
      if (!campaignId.success || !sessionId.success) {
        return failure(request, reply, new CampaignStartupUnavailableError());
      }
      if (request.body !== undefined && !emptyBodySchema.safeParse(request.body).success) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign startup request is invalid");
      }
      try {
        const repository = options.repositoryAccessor();
        const summary = await runCampaignStartup(
          { principalId: PRINCIPAL, campaignId: campaignId.data, sessionId: sessionId.data },
          {
            dm: repository,
            generation: repository,
            startup: repository,
            orchestrate: (principalId, runId) => orchestrateCampaignDmBeat(repository, principalId, runId, options.agentDependencies),
            sceneImages: {
              installationEnabled: options.sceneImageInstallationEnabled,
              service: options.sceneImageServiceAccessor,
            },
          },
        );
        return reply.send(campaignStartupResponseSchema.parse(summary));
      } catch (error) {
        if (error instanceof Error && error.name === "ZodError") {
          return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
            "Campaign startup produced an invalid summary; reconcile the identical request");
        }
        return failure(request, reply, error);
      }
    });
};
