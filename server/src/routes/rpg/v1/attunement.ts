import {
  attunementCommandSchema,
  attunementResponseSchema,
  attunementSnapshotSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import type { AttunementRepository } from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface AttunementHttpOptions {
  attunementRepositoryAccessor: () => Pick<AttunementRepository, "listActorAttunements" | "attuneActorItem" | "dropActorAttunement">;
}

function enabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics;
}

function hasQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0;
}

function notFound(request: FastifyRequest, reply: FastifyReply) {
  // Authorization, absent actor state, and campaign mismatch share one response.
  return sendApiProblem(request, reply, 404, "RPG_ATTUNEMENT_NOT_FOUND", "Actor attunement state not found");
}

export const attunementHttpRoutes: FastifyPluginAsync<AttunementHttpOptions> = async (app, options) => {
  app.get<{ Params: { campaignId: string; actorId: string }; Querystring: Record<string, unknown> }>(
    "/campaigns/:campaignId/actors/:actorId/attunements",
    { exposeHeadRoute: false },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      if (hasQuery(request)) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Attunement reads do not accept query parameters");
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!campaignId.success || !actorId.success) return notFound(request, reply);
      try {
        const snapshot = options.attunementRepositoryAccessor().listActorAttunements(LOCAL_OWNER, actorId.data);
        if (snapshot === null || snapshot.campaignId !== campaignId.data) return notFound(request, reply);
        return reply.send(attunementSnapshotSchema.parse(snapshot));
      } catch (error) {
        request.log.error({ err: error instanceof Error ? error.name : "unknown" }, "attunement read failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Actor attunement state could not be loaded");
      }
    },
  );

  app.post<{ Params: { campaignId: string; actorId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/actors/:actorId/attunements",
    { exposeHeadRoute: false },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      if (hasQuery(request)) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Attunement commands do not accept query parameters");
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!campaignId.success || !actorId.success) return notFound(request, reply);
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Attunement command requires application/json");
      }
      const body = attunementCommandSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Attunement command request is invalid");
      try {
        const repository = options.attunementRepositoryAccessor();
        const outcome = body.data.command === "attune"
          ? repository.attuneActorItem(LOCAL_OWNER, actorId.data, {
              definitionId: body.data.definitionId, key: body.data.key, satisfiedRest: body.data.satisfiedRest,
            })
          : repository.dropActorAttunement(LOCAL_OWNER, actorId.data, body.data.key);
        if (outcome === null || outcome.snapshot.campaignId !== campaignId.data) return notFound(request, reply);
        return reply.send(attunementResponseSchema.parse({
          ok: outcome.ok, code: outcome.ok ? null : outcome.code, snapshot: outcome.snapshot,
        }));
      } catch (error) {
        request.log.error({ err: error instanceof Error ? error.name : "unknown" }, "attunement command failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Attunement command could not be completed");
      }
    },
  );
};
