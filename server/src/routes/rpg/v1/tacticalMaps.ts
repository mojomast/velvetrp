import {
  campaignPlaySessionIdSchema,
  resourceIdSchema,
  tacticalMapGenerateRequestSchema,
  tacticalMapGenerateResponseSchema,
  tacticalMapModeSchema,
  tacticalMapMoveRequestSchema,
  tacticalMapMoveResponseSchema,
  tacticalMapPreviewRequestSchema,
  tacticalMapPreviewResponseSchema,
  tacticalMapSnapshotSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  TacticalMapAuthorizationError,
  TacticalMapConflictError,
  TacticalMapStaleError,
  TacticalMapUnavailableError,
  type TacticalMapRepository,
} from "../../../repo/tacticalMapRepo.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type Lane = TacticalMapRepository;
export interface TacticalMapHttpOptions { tacticalMapRepositoryAccessor: () => Lane }
type Params = { campaignId: string; sessionId: string; mode: string; actorId: string };

function enabled() { const flags = readRpgFeatureFlags(); return flags.campaign && flags.mechanics; }
function unavailable(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request, reply, 404, "RPG_TACTICAL_MAP_NOT_FOUND", "Tactical map not found");
}
function failure(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof TacticalMapAuthorizationError || error instanceof TacticalMapUnavailableError) return unavailable(request, reply);
  if (error instanceof TacticalMapStaleError) return sendApiProblem(request, reply, 409, "RPG_TACTICAL_MAP_STALE", "Tactical map revisions are stale; request a new preview");
  if (error instanceof TacticalMapConflictError) return sendApiProblem(request, reply, 409, "RPG_TACTICAL_MAP_CONFLICT", "Tactical map movement is not legal in the current state");
  request.log.error({ operation: "tactical-map", method: request.method, route: request.routeOptions.url }, "RPG tactical map operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Tactical map outcome is unknown; refresh authoritative state and never retry a command automatically");
}
function path(params: Partial<Params>) {
  const campaignId = resourceIdSchema.safeParse(params.campaignId); const sessionId = campaignPlaySessionIdSchema.safeParse(params.sessionId);
  const mode = params.mode === undefined ? null : tacticalMapModeSchema.safeParse(params.mode); const actorId = params.actorId === undefined ? null : resourceIdSchema.safeParse(params.actorId);
  return campaignId.success && sessionId.success && (!mode || mode.success) && (!actorId || actorId.success)
    ? { campaignId: campaignId.data, sessionId: sessionId.data, ...(mode ? { mode: mode.data } : {}), ...(actorId ? { actorId: actorId.data } : {}) } : null;
}
function setup(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], write: boolean) {
  reply.header("cache-control", "private, no-store");
  if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
  if ((request.raw.url ?? request.url).includes("?")) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Tactical map operations do not accept query parameters");
  if (write) { const contentType = request.headers["content-type"]; if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Tactical map writes require application/json"); }
}

export const tacticalMapHttpRoutes: FastifyPluginAsync<TacticalMapHttpOptions> = async (app, options) => {
  app.post<{ Params: Pick<Params, "campaignId" | "sessionId">; Querystring: Record<string, unknown>; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/tactical-maps", {
    onRequest: async (request, reply) => { await setup(request, reply, true); },
    errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Tactical map generation request is invalid"),
  }, async (request, reply) => {
    const ids = path(request.params); if (!ids) return unavailable(request, reply); const body = tacticalMapGenerateRequestSchema.safeParse(request.body);
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Tactical map generation request is invalid");
    try { const result = options.tacticalMapRepositoryAccessor().generateTacticalMapForSession(LOCAL_OWNER, ids.campaignId, ids.sessionId, body.data);
      if (result.campaignId !== ids.campaignId || result.sessionId !== ids.sessionId || result.mode !== body.data.mode || result.encounterId !== body.data.encounterId) throw new Error("generated map binding mismatch");
      return reply.code(200).send(tacticalMapGenerateResponseSchema.parse(result)); } catch (error) { return failure(request, reply, error); }
  });

  app.get<{ Params: Params; Querystring: Record<string, unknown> }>("/campaigns/:campaignId/rooms/:sessionId/tactical-maps/:mode/actors/:actorId", { exposeHeadRoute: false,
    onRequest: async (request, reply) => { await setup(request, reply, false); },
  }, async (request, reply) => {
    const ids = path(request.params); if (!ids || !ids.mode || !ids.actorId) return unavailable(request, reply); const mode = ids.mode;
    try { const result = options.tacticalMapRepositoryAccessor().getTacticalMap(LOCAL_OWNER, ids.campaignId, ids.sessionId, mode, ids.actorId); if (!result) return unavailable(request, reply);
      if (result.campaignId !== ids.campaignId || result.sessionId !== ids.sessionId || result.mode !== mode || result.controlledTokenId === null) throw new Error("map projection binding mismatch");
      return reply.code(200).send(tacticalMapSnapshotSchema.parse(result)); } catch (error) { return failure(request, reply, error); }
  });

  app.post<{ Params: Pick<Params, "campaignId" | "sessionId" | "mode">; Querystring: Record<string, unknown>; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/tactical-maps/:mode/previews", {
    onRequest: async (request, reply) => { await setup(request, reply, true); }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Tactical map preview request is invalid"),
  }, async (request, reply) => {
    const ids = path(request.params); const body = tacticalMapPreviewRequestSchema.safeParse(request.body); if (!ids || !ids.mode) return unavailable(request, reply); const mode = ids.mode;
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Tactical map preview request is invalid");
    try { const result = options.tacticalMapRepositoryAccessor().previewTacticalMapMove(LOCAL_OWNER, ids.campaignId, ids.sessionId, mode, body.data);
      if (result.campaignId !== ids.campaignId || result.sessionId !== ids.sessionId || result.mode !== mode || result.projection.authoritativePath?.at(-1)?.x !== body.data.destination.x || result.projection.authoritativePath?.at(-1)?.y !== body.data.destination.y) throw new Error("map preview binding mismatch");
      return reply.code(200).send(tacticalMapPreviewResponseSchema.parse(result)); } catch (error) { return failure(request, reply, error); }
  });

  app.post<{ Params: Pick<Params, "campaignId" | "sessionId" | "mode">; Querystring: Record<string, unknown>; Body: unknown }>("/campaigns/:campaignId/rooms/:sessionId/tactical-maps/:mode/move-commands", {
    onRequest: async (request, reply) => { await setup(request, reply, true); }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Tactical map move request is invalid"),
  }, async (request, reply) => {
    const ids = path(request.params); const body = tacticalMapMoveRequestSchema.safeParse(request.body); if (!ids || !ids.mode) return unavailable(request, reply); const mode = ids.mode;
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Tactical map move request is invalid");
    try { const result = options.tacticalMapRepositoryAccessor().moveTacticalMapToken(LOCAL_OWNER, ids.campaignId, ids.sessionId, mode, body.data);
      if (result.snapshot.campaignId !== ids.campaignId || result.snapshot.sessionId !== ids.sessionId || result.snapshot.mode !== mode || result.receipt.previewId !== body.data.previewId || result.receipt.idempotencyKey !== body.data.idempotencyKey || result.receipt.tokenRevisionBefore !== body.data.expectedTokenRevision) throw new Error("map move binding mismatch");
      return reply.code(200).send(tacticalMapMoveResponseSchema.parse(result)); } catch (error) { return failure(request, reply, error); }
  });
};
