import {
  campaignSessionAttachmentSchema,
  npcCastHttpSchema,
  npcIdSchema,
  npcPresenceMutationHttpRequestSchema,
  npcPresenceMutationHttpResponseSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  WorldAuthorizationError,
  WorldConflictError,
  WorldStaleError,
  WorldUnavailableError,
  type WorldRepository,
} from "../../../repo/worldRepo.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const sessionIdSchema = campaignSessionAttachmentSchema.shape.sessionId;
const PRESENT_CAST_INSTANCE = "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/present-cast";
const PRESENCE_COMMAND_INSTANCE = "/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/npcs/:npcId/presence-commands";

type NpcPresenceHttpRepository = Pick<WorldRepository, "getNpcCast" | "mutateNpcPresence">;

export interface NpcPresenceHttpOptions {
  npcPresenceRepositoryAccessor: () => NpcPresenceHttpRepository;
}

function enabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics;
}

function hasQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?")
    || Object.keys(request.query as Record<string, unknown>).length > 0;
}

function missing(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request, reply, 404, "RPG_NPC_PRESENCE_NOT_FOUND", "NPC presence not found", {
    instance: request.method === "GET" ? PRESENT_CAST_INSTANCE : PRESENCE_COMMAND_INSTANCE,
  });
}

function pathMismatch(value: unknown, campaignId: string, sessionId: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ("campaignId" in candidate && candidate.campaignId !== campaignId)
    || ("sessionId" in candidate && candidate.sessionId !== sessionId);
}

function failure(
  request: FastifyRequest,
  reply: Parameters<typeof sendApiProblem>[1],
  error: unknown,
  operation: "npc-present-cast" | "npc-presence-command",
) {
  if (error instanceof WorldAuthorizationError || error instanceof WorldUnavailableError) {
    return missing(request, reply);
  }
  if (error instanceof WorldStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_NPC_PRESENCE_STALE",
      "NPC presence is stale; refresh the authoritative present cast before trying again",
      { instance: PRESENCE_COMMAND_INSTANCE });
  }
  if (error instanceof WorldConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_NPC_PRESENCE_CONFLICT",
      "NPC presence command conflicts with the current state", { instance: PRESENCE_COMMAND_INSTANCE });
  }
  request.log.error({ operation, method: request.method, route: request.routeOptions.url },
    "RPG NPC presence operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "NPC presence outcome could not be confirmed; reconcile with the authoritative present-cast GET and do not automatically retry",
    { instance: operation === "npc-present-cast" ? PRESENT_CAST_INSTANCE : PRESENCE_COMMAND_INSTANCE });
}

/** Registers fixed-local-principal session NPC-presence reads and commands. */
export const npcPresenceHttpRoutes: FastifyPluginAsync<NpcPresenceHttpOptions> = async (app, options) => {
  app.get<{
    Params: { campaignId: string; sessionId: string };
    Querystring: Record<string, unknown>;
  }>("/campaigns/:campaignId/rooms/:sessionId/present-cast", { exposeHeadRoute: false }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found",
      { instance: PRESENT_CAST_INSTANCE });
    if (hasQuery(request)) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "NPC present cast does not accept query parameters",
        { instance: PRESENT_CAST_INSTANCE });
    }
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    const sessionId = sessionIdSchema.safeParse(request.params.sessionId);
    if (!campaignId.success || !sessionId.success) return missing(request, reply);

    try {
      const result = options.npcPresenceRepositoryAccessor().getNpcCast(
        LOCAL_OWNER, campaignId.data, sessionId.data,
      );
      if (result === null || pathMismatch(result, campaignId.data, sessionId.data)) return missing(request, reply);
      const cast = npcCastHttpSchema.parse(result);
      reply.header("x-npc-presence-revision", String(cast.sessionRevision));
      return reply.code(200).send(cast);
    } catch (error) {
      return failure(request, reply, error, "npc-present-cast");
    }
  });

  app.post<{
    Params: { campaignId: string; sessionId: string; npcId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>("/campaigns/:campaignId/rooms/:sessionId/npcs/:npcId/presence-commands", {
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found",
          { instance: PRESENCE_COMMAND_INSTANCE });
        return;
      }
      if (hasQuery(request)) {
        await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
          "NPC presence commands do not accept query parameters", { instance: PRESENCE_COMMAND_INSTANCE });
        return;
      }
      if (!resourceIdSchema.safeParse(request.params.campaignId).success
        || !sessionIdSchema.safeParse(request.params.sessionId).success
        || !npcIdSchema.safeParse(request.params.npcId).success) {
        await missing(request, reply);
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE",
          "NPC presence commands require application/json", { instance: PRESENCE_COMMAND_INSTANCE });
      }
    },
    errorHandler: (_error, request, reply) => sendApiProblem(
      request, reply, 400, "RPG_INVALID_REQUEST", "NPC presence command request is invalid",
      { instance: PRESENCE_COMMAND_INSTANCE },
    ),
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    const sessionId = sessionIdSchema.safeParse(request.params.sessionId);
    const npcId = npcIdSchema.safeParse(request.params.npcId);
    if (!campaignId.success || !sessionId.success || !npcId.success) return missing(request, reply);
    const body = npcPresenceMutationHttpRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "NPC presence command request is invalid",
        { instance: PRESENCE_COMMAND_INSTANCE });
    }

    try {
      const result = options.npcPresenceRepositoryAccessor().mutateNpcPresence(LOCAL_OWNER, {
        campaignId: campaignId.data,
        sessionId: sessionId.data,
        npcId: npcId.data,
        expectedRevision: body.data.expectedRevision,
        idempotencyKey: body.data.idempotencyKey,
        mutation: body.data.mutation,
      });
      if (pathMismatch(result, campaignId.data, sessionId.data)) return missing(request, reply);
      const parsed = npcPresenceMutationHttpResponseSchema.parse(result);
      if (parsed.receipt.kind !== body.data.mutation.kind
        || parsed.receipt.revisionBefore !== body.data.expectedRevision
        || parsed.receipt.revisionAfter !== body.data.expectedRevision + 1) {
        throw new Error("NPC presence receipt binding is invalid");
      }
      return reply.code(200).send({ receipt: {
        kind: parsed.receipt.kind,
        revisionBefore: parsed.receipt.revisionBefore,
        revisionAfter: parsed.receipt.revisionAfter,
        occurredAt: parsed.receipt.occurredAt,
      } });
    } catch (error) {
      return failure(request, reply, error, "npc-presence-command");
    }
  });
};
