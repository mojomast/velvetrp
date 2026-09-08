import type { FastifyPluginAsync } from "fastify";
import {
  administrationIntegrationCommandResponseSchema, campaignAdministrationIntegrationsSchema, resourceIdSchema,
  rulesetSelectionCommandSchema, safetyActionCommandSchema, sessionZeroSafetyUpdateCommandSchema,
  shopBuyPolicyCommandSchema, vendorAssociationCommandSchema,
} from "@velvet/contracts";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  CampaignIntegrationConflictError, CampaignIntegrationForbiddenError, CampaignIntegrationStaleError,
  CampaignIntegrationUnavailableError, type CampaignAdministrationIntegrationRepository,
} from "../../../repo/campaignAdministrationIntegrationRepo.js";

const OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;.*)?$/i;
type Repo = CampaignAdministrationIntegrationRepository;
export interface CampaignAdministrationIntegrationsHttpOptions { repositoryAccessor: () => Repo }

function failure(request: any, reply: any, error: unknown) {
  if (error instanceof CampaignIntegrationForbiddenError || error instanceof CampaignIntegrationUnavailableError)
    return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign administration integration is unavailable");
  if (error instanceof CampaignIntegrationStaleError)
    return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_ADMINISTRATION_STALE", "Campaign administration is stale; reconcile by GET before another command");
  if (error instanceof CampaignIntegrationConflictError)
    return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_ADMINISTRATION_CONFLICT", error.message);
  request.log.error({ operation: "campaign-administration-integrations" }, "campaign integration operation failed");
  return sendApiProblem(request, reply, 503, "RPG_ADMINISTRATION_OUTCOME_UNKNOWN", "The command outcome is unknown; reconcile by GET and never retry automatically");
}

export const campaignAdministrationIntegrationsHttpRoutes: FastifyPluginAsync<CampaignAdministrationIntegrationsHttpOptions> = async (app, options) => {
  const gate = (request: any, reply: any, body: boolean) => {
    reply.header("cache-control", "no-store");
    if (!readRpgFeatureFlags().campaign) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query ?? {}).length) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign administration integrations do not accept query parameters");
    if (body && (typeof request.headers["content-type"] !== "string" || !JSON_TYPE.test(request.headers["content-type"]))) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign administration commands require application/json");
  };
  const campaignId = (request: any) => resourceIdSchema.safeParse(request.params.campaignId);
  app.get("/campaigns/:campaignId/administration-integrations", { exposeHeadRoute: false, onRequest: async (r, p) => gate(r, p, false) }, async (request: any, reply) => {
    const id = campaignId(request); if (!id.success) return failure(request, reply, new CampaignIntegrationUnavailableError());
    try { const value = options.repositoryAccessor().getCampaignAdministrationIntegrations(OWNER, id.data); if (!value) throw new CampaignIntegrationUnavailableError(); return reply.send(campaignAdministrationIntegrationsSchema.parse(value)); }
    catch (error) { return failure(request, reply, error); }
  });
  const command = (path: string, schema: any, execute: (repo: Repo, campaignId: string, body: any) => unknown) => app.post(path,
    { onRequest: async (r, p) => gate(r, p, true) }, async (request: any, reply) => {
      const id = campaignId(request), body = schema.safeParse(request.body);
      if (!id.success || !body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign administration command is invalid");
      try { const result = administrationIntegrationCommandResponseSchema.parse(execute(options.repositoryAccessor(), id.data, body.data));
        if (result.receipt.campaignId !== id.data || result.receipt.idempotencyKey !== body.data.idempotencyKey || result.receipt.revisionBefore !== body.data.expectedRevision) throw new Error("campaign integration response binding mismatch");
        return reply.send(result); } catch (error) { return failure(request, reply, error); }
    });
  command("/campaigns/:campaignId/vendor-association-commands", vendorAssociationCommandSchema, (repo, id, body) => repo.associateCampaignVendor(OWNER, id, body));
  command("/campaigns/:campaignId/buy-policy-commands", shopBuyPolicyCommandSchema, (repo, id, body) => repo.configureCampaignBuyPolicy(OWNER, id, body));
  command("/campaigns/:campaignId/ruleset-selection-commands", rulesetSelectionCommandSchema, (repo, id, body) => repo.selectCampaignRuleset(OWNER, id, body));
  command("/campaigns/:campaignId/session-zero-safety-commands", sessionZeroSafetyUpdateCommandSchema, (repo, id, body) => repo.updateSessionZeroSafetyPolicy(OWNER, id, body));
  command("/campaigns/:campaignId/safety-action-commands", safetyActionCommandSchema, (repo, id, body) => repo.requestCampaignSafetyAction(OWNER, id, body));
};
