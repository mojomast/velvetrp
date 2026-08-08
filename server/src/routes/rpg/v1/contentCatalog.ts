import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { contentCatalogHttpCampaignContentGetResponseSchema, contentCatalogHttpCampaignContentPutRequestSchema, contentCatalogHttpCampaignContentPutResponseSchema, contentCatalogHttpCampaignPackDetailResponseSchema, contentCatalogHttpOwnerDetailResponseSchema, contentCatalogHttpPublicationRequestSchema, contentCatalogHttpPublicationResponseSchema, contentCatalogHttpPublicationsQuerySchema, contentCatalogHttpPublicationsResponseSchema, contentCatalogHttpValidationRequestSchema, contentCatalogHttpValidationResponseSchema, contentPackVersionSchema, resourceIdSchema } from "@velvet/contracts";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import { ContentCatalogConflictError, ContentCatalogStaleError, ContentCatalogValidationError, type ContentCatalogRepository } from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
export interface ContentCatalogHttpOptions { contentCatalogRepositoryAccessor: () => Pick<ContentCatalogRepository, "validateContentCatalog" | "publishContentCatalog" | "listContentCatalogPublicationPage" | "getContentCatalogForOwner" | "getCampaignContentCatalog" | "configureCampaignCatalog" | "resolveCampaignCatalog">; }
function noStore(reply: FastifyReply): void { reply.header("cache-control", "no-store"); }
function enabled(): boolean { const flags = readRpgFeatureFlags(); return flags.campaign && flags.mechanics; }
function invalid(request: FastifyRequest, reply: FastifyReply, detail = "Content catalog request is invalid") { return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", detail); }
function withoutCampaignId(content: { campaignId: string } & Record<string, unknown>) { const { campaignId: _campaignId, ...safe } = content; return safe; }
function failure(request: FastifyRequest, reply: FastifyReply, error: unknown, write = false) {
  if (error instanceof ContentCatalogValidationError) return sendApiProblem(request, reply, 422, "RPG_CONTENT_CATALOG_INVALID", "Content catalog validation failed");
  if (error instanceof ContentCatalogStaleError) return sendApiProblem(request, reply, 409, "RPG_CONTENT_CATALOG_STALE", "Campaign content is stale; refresh before editing");
  if (error instanceof ContentCatalogConflictError) return sendApiProblem(request, reply, 409, "RPG_CONTENT_CATALOG_CONFLICT", "Content catalog conflicts with current state");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", write ? "Content catalog status is unknown; refresh before trying again; never retry automatically" : "Content catalog could not be loaded");
}
function gate(request: FastifyRequest, reply: FastifyReply) { return enabled() ? null : sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); }
function hasQuery(request: FastifyRequest): boolean { return (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0; }
function json(request: FastifyRequest): boolean { return typeof request.headers["content-type"] === "string" && JSON_MEDIA_TYPE.test(request.headers["content-type"]); }
function bodyError(_error: Error & { code?: string }, request: FastifyRequest, reply: FastifyReply) {
  noStore(reply);
  const blocked = gate(request, reply); if (blocked) return blocked;
  if (_error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Content catalog requires application/json");
  return invalid(request, reply);
}

export const contentCatalogHttpRoutes: FastifyPluginAsync<ContentCatalogHttpOptions> = async (app, options) => {
  app.get<{ Querystring: Record<string, unknown> }>("/content-packs", { exposeHeadRoute: false }, async (request, reply) => {
    noStore(reply); const blocked = gate(request, reply); if (blocked) return blocked;
    const query = contentCatalogHttpPublicationsQuerySchema.safeParse(request.query); if (!query.success) return invalid(request, reply, "Content pack list request is invalid");
    try {
      const input = { status: "validated" as const, ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }), ...(query.data.limit === undefined ? {} : { limit: query.data.limit }) };
      return reply.send(contentCatalogHttpPublicationsResponseSchema.parse(options.contentCatalogRepositoryAccessor().listContentCatalogPublicationPage(LOCAL_OWNER, input)));
    } catch (error) { return failure(request, reply, error); }
  });
  app.get<{ Params: { packId: string; packVersion: string }; Querystring: Record<string, unknown> }>("/content-packs/:packId/versions/:packVersion", { exposeHeadRoute: false }, async (request, reply) => {
    noStore(reply); const blocked = gate(request, reply); if (blocked) return blocked;
    if (hasQuery(request)) return invalid(request, reply, "Content pack detail does not accept query parameters");
    const packId = resourceIdSchema.safeParse(request.params.packId), packVersion = contentPackVersionSchema.safeParse(request.params.packVersion); if (!packId.success || !packVersion.success) return sendApiProblem(request, reply, 404, "RPG_CONTENT_PACK_NOT_FOUND", "Content pack not found");
    try { const catalog = options.contentCatalogRepositoryAccessor().getContentCatalogForOwner(LOCAL_OWNER, packId.data, packVersion.data); return catalog === null ? sendApiProblem(request, reply, 404, "RPG_CONTENT_PACK_NOT_FOUND", "Content pack not found") : reply.send(contentCatalogHttpOwnerDetailResponseSchema.parse({ catalog })); } catch (error) { return failure(request, reply, error); }
  });
  app.post<{ Querystring: Record<string, unknown>; Body: unknown }>("/content-packs/validate", { exposeHeadRoute: false, errorHandler: bodyError }, async (request, reply) => {
    noStore(reply); const blocked = gate(request, reply); if (blocked) return blocked;
    if (hasQuery(request)) return invalid(request, reply, "Content catalog validation does not accept query parameters"); if (!json(request)) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Content catalog validation requires application/json");
    const body = contentCatalogHttpValidationRequestSchema.safeParse(request.body); if (!body.success) return invalid(request, reply);
    // The pure validator consumes the publication contract. Supply a fixed,
    // route-owned key so browser-memory validation never needs a mutation key.
    try { return reply.send(contentCatalogHttpValidationResponseSchema.parse({ report: options.contentCatalogRepositoryAccessor().validateContentCatalog({ ...body.data, idempotencyKey: "http-validation-only" }) })); } catch (error) { return failure(request, reply, error); }
  });
  app.post<{ Querystring: Record<string, unknown>; Body: unknown }>("/content-packs", { exposeHeadRoute: false, errorHandler: bodyError }, async (request, reply) => {
    noStore(reply); const blocked = gate(request, reply); if (blocked) return blocked;
    if (hasQuery(request)) return invalid(request, reply, "Content publication does not accept query parameters"); if (!json(request)) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Content publication requires application/json");
    const body = contentCatalogHttpPublicationRequestSchema.safeParse(request.body); if (!body.success) return invalid(request, reply);
    try { return reply.code(201).send(contentCatalogHttpPublicationResponseSchema.parse({ catalog: options.contentCatalogRepositoryAccessor().publishContentCatalog(LOCAL_OWNER, body.data) })); } catch (error) { return failure(request, reply, error, true); }
  });
  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>("/campaigns/:campaignId/content", { exposeHeadRoute: false }, async (request, reply) => {
    noStore(reply); const blocked = gate(request, reply); if (blocked) return blocked;
    if (hasQuery(request)) return invalid(request, reply, "Campaign content does not accept query parameters"); const campaignId = resourceIdSchema.safeParse(request.params.campaignId); if (!campaignId.success) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    try { const content = options.contentCatalogRepositoryAccessor().resolveCampaignCatalog(LOCAL_OWNER, campaignId.data); return content === null ? sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found") : reply.send(contentCatalogHttpCampaignContentGetResponseSchema.parse({ content: withoutCampaignId(content) })); } catch (error) { return failure(request, reply, error); }
  });
  app.put<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/campaigns/:campaignId/content", { exposeHeadRoute: false, errorHandler: bodyError }, async (request, reply) => {
    noStore(reply); const blocked = gate(request, reply); if (blocked) return blocked;
    if (hasQuery(request)) return invalid(request, reply, "Campaign content does not accept query parameters"); if (!json(request)) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign content requires application/json");
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId), body = contentCatalogHttpCampaignContentPutRequestSchema.safeParse(request.body); if (!campaignId.success) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found"); if (!body.success) return invalid(request, reply);
    try { const result = options.contentCatalogRepositoryAccessor().configureCampaignCatalog(LOCAL_OWNER, campaignId.data, body.data); if (result.content.campaignId !== campaignId.data || result.receipt.campaignId !== campaignId.data) throw new Error("campaign content response does not match request"); const { campaignId: _receiptCampaignId, ...receipt } = result.receipt; return reply.send(contentCatalogHttpCampaignContentPutResponseSchema.parse({ content: withoutCampaignId(result.content), receipt: { ...receipt, content: withoutCampaignId(result.receipt.content) } })); } catch (error) { return failure(request, reply, error, true); }
  });
  app.get<{ Params: { campaignId: string; packId: string; packVersion: string }; Querystring: Record<string, unknown> }>("/campaigns/:campaignId/content-packs/:packId/versions/:packVersion", { exposeHeadRoute: false }, async (request, reply) => {
    noStore(reply); const blocked = gate(request, reply); if (blocked) return blocked;
    if (hasQuery(request)) return invalid(request, reply, "Campaign content pack detail does not accept query parameters"); const campaignId = resourceIdSchema.safeParse(request.params.campaignId), packId = resourceIdSchema.safeParse(request.params.packId), packVersion = contentPackVersionSchema.safeParse(request.params.packVersion); if (!campaignId.success || !packId.success || !packVersion.success) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_CONTENT_PACK_NOT_FOUND", "Campaign content pack not found");
    try { const catalog = options.contentCatalogRepositoryAccessor().getCampaignContentCatalog(LOCAL_OWNER, campaignId.data, packId.data, packVersion.data); return catalog === null ? sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_CONTENT_PACK_NOT_FOUND", "Campaign content pack not found") : reply.send(contentCatalogHttpCampaignPackDetailResponseSchema.parse({ catalog })); } catch (error) { return failure(request, reply, error); }
  });
};
