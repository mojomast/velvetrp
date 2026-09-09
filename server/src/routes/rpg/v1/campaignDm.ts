import { campaignDmBeatRequestSchema, campaignDmDecisionRequestSchema, campaignDmHistorySchema,
  campaignDmReadinessResponseSchema,
  campaignDmModeRequestSchema, campaignDmPrivateRunSchema, campaignDmRunSchema, campaignDmResumeRequestSchema, campaignDmSceneBindingRequestSchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { CampaignDmConflictError, CampaignDmUnavailableError, type CampaignDmRepository } from "../../../repo/campaignDmRepo.js";
import { CampaignDmReadinessUnavailableError, type CampaignDmReadinessRepository } from "../../../repo/campaignDmReadinessRepo.js";
import { orchestrateCampaignDmBeat } from "../../../agent/campaignDmOrchestrator.js";
import type { AdventureAgentDependencies } from "../../../agent/adventureOrchestrator.js";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";

// Trusted-local adapter, consistent with the other RPG routes. Headers do not confer identity.
const PRINCIPAL = "local-owner";
type Params = { campaignId: string; sessionId: string; runId: string };
export const campaignDmHttpRoutes: FastifyPluginAsync<{
  repositoryAccessor: () => CampaignDmRepository & CampaignDmReadinessRepository; agentDependencies?: AdventureAgentDependencies;
}> = async (app, options) => {
  const gate = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "private, no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    if ((request.raw.url ?? request.url).includes("?")) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "DM routes do not accept query parameters");
    if (request.method === "POST" && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? ""))
      return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "DM commands require application/json");
  };
  const failure = (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof CampaignDmUnavailableError || error instanceof CampaignDmReadinessUnavailableError)
      return sendApiProblem(request, reply, 404, "RPG_DM_NOT_FOUND", "DM resource unavailable");
    if (error instanceof CampaignDmConflictError) return sendApiProblem(request, reply, 409, "RPG_DM_CONFLICT", "DM command conflicts with current state; read history before continuing");
    return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "DM outcome unavailable; reconcile the identical request");
  };
   const handle = (action: (repo: CampaignDmRepository, params: Params, body: unknown) => unknown | Promise<unknown>) =>
       async (request: FastifyRequest<{ Params: Params; Body: unknown }>, reply: FastifyReply) => {
        if (Object.values(request.params).some(value => !resourceIdSchema.safeParse(value).success)) return failure(new CampaignDmUnavailableError(), request, reply);
         if (request.method === "GET" && request.body !== undefined) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "GET does not accept a body");
        try { return reply.send(await action(options.repositoryAccessor(), request.params, request.body)); }
        catch (error) {
          if (error instanceof Error && error.name === "ZodError") return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Invalid DM command");
          return failure(error, request, reply);
        }
       };
   app.get<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/dm", { exposeHeadRoute: false, onRequest: gate },
     handle((repo, p) => repo.getDmControl(PRINCIPAL, p.campaignId)));
   app.post<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/dm/mode-commands", { onRequest: gate },
     handle((repo,p,body) => repo.setDmControl(PRINCIPAL,p.campaignId,campaignDmModeRequestSchema.parse(body))));
   app.post<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/dm/scene-binding-commands", { onRequest: gate },
     handle((repo,p,body) => repo.bindDmSceneEvidence(PRINCIPAL,p.campaignId,campaignDmSceneBindingRequestSchema.parse(body))));
    app.get<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/dm", { exposeHeadRoute: false, onRequest: gate },
      handle((repo,p) => campaignDmHistorySchema.parse(repo.getDmHistory(PRINCIPAL,p.campaignId,p.sessionId))));
    app.get<{ Params: Pick<Params, "campaignId" | "sessionId">; Body: unknown }>(
      "/campaigns/:campaignId/rooms/:sessionId/dm/preparation-readiness",
      { exposeHeadRoute: false, onRequest: gate },
      async (request, reply) => {
        if (Object.values(request.params).some(value => !resourceIdSchema.safeParse(value).success))
          return failure(new CampaignDmReadinessUnavailableError(), request, reply);
        if (request.body !== undefined || Number(request.headers["content-length"] ?? 0) > 0)
          return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "GET does not accept a body");
        try {
           const report = options.repositoryAccessor().getCampaignDmPreparationReadiness(
             PRINCIPAL, request.params.campaignId, request.params.sessionId,
           );
           const identity = (report as { identity?: { campaignId?: unknown; sessionId?: unknown } }).identity;
           if (identity && (identity.campaignId !== request.params.campaignId || identity.sessionId !== request.params.sessionId))
             throw new CampaignDmReadinessUnavailableError();
           const parsed = campaignDmReadinessResponseSchema.parse(report);
           if (parsed.identity.campaignId !== request.params.campaignId || parsed.identity.sessionId !== request.params.sessionId)
             throw new CampaignDmReadinessUnavailableError();
           return reply.send(parsed);
        } catch (error) {
          return failure(error, request, reply);
        }
      },
    );
   app.get<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/dm/runs/:runId", { exposeHeadRoute: false, onRequest: gate },
     handle((repo,p) => campaignDmRunSchema.parse(repo.getDmRun(PRINCIPAL,p.campaignId,p.sessionId,p.runId))));
   app.get<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/dm/runs/:runId/proposal", { exposeHeadRoute: false, onRequest: gate },
     handle((repo,p) => campaignDmPrivateRunSchema.parse(repo.getDmProposal(PRINCIPAL,p.campaignId,p.sessionId,p.runId))));
   app.post<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/dm/beat-commands", { onRequest: gate }, handle(async (repo,p,body) => {
    const run=repo.openDmBeat(PRINCIPAL,p.campaignId,p.sessionId,campaignDmBeatRequestSchema.parse(body));
    await orchestrateCampaignDmBeat(repo,PRINCIPAL,run.runId,options.agentDependencies);
    return campaignDmRunSchema.parse(repo.getDmRun(PRINCIPAL,p.campaignId,p.sessionId,run.runId));
   }));
   app.post<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/dm/runs/:runId/decision-commands", { onRequest: gate }, handle(async (repo,p,body) => {
    repo.decideDmBeat(PRINCIPAL,p.campaignId,p.sessionId,p.runId,campaignDmDecisionRequestSchema.parse(body));
    await orchestrateCampaignDmBeat(repo,PRINCIPAL,p.runId,options.agentDependencies);
    return campaignDmRunSchema.parse(repo.getDmRun(PRINCIPAL,p.campaignId,p.sessionId,p.runId));
   }));
   app.post<{ Params: Params; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/dm/runs/:runId/resume-commands", { onRequest: gate }, handle(async (repo,p,body) => {
    campaignDmResumeRequestSchema.parse(body);
    repo.getDmRun(PRINCIPAL,p.campaignId,p.sessionId,p.runId);
    await orchestrateCampaignDmBeat(repo,PRINCIPAL,p.runId,options.agentDependencies);
    return campaignDmRunSchema.parse(repo.getDmRun(PRINCIPAL,p.campaignId,p.sessionId,p.runId));
   }));
};
