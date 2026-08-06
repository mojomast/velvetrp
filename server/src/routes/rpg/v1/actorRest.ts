import {
  resourceIdSchema,
  restHttpRequestSchema,
  restHttpResponseSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  ActorResourceAuthorizationError,
  ActorResourceConflictError,
  ActorResourceStaleError,
  RestAuthorizationError,
  RestIllegalStateError,
  RestStaleError,
  type RestRepository,
} from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface ActorRestHttpOptions {
  restRepositoryAccessor: () => Pick<RestRepository, "takeRest">;
}

function invalidQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0;
}

function notFound(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  // Authorization and absent actor state intentionally share one response.
  return sendApiProblem(request, reply, 404, "RPG_ACTOR_REST_NOT_FOUND", "Actor rest state not found");
}

function mapFailure(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof ActorResourceAuthorizationError || error instanceof RestAuthorizationError) return notFound(request, reply);
  if (error instanceof ActorResourceStaleError || error instanceof RestStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_ACTOR_REST_STALE", "Actor rest state is stale; refresh before trying again");
  }
  if (error instanceof ActorResourceConflictError || error instanceof RestIllegalStateError) {
    return sendApiProblem(request, reply, 409, "RPG_ACTOR_REST_CONFLICT", "Actor rest command conflicts with current state");
  }
  request.log.error({ operation: "actor-rest", method: request.method, route: request.routeOptions.url }, "RPG actor rest operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Actor rest state could not be loaded");
}

export const actorRestHttpRoutes: FastifyPluginAsync<ActorRestHttpOptions> = async (app, options) => {
  const guard = async (request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) => {
    reply.header("cache-control", "no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) {
      await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      return false;
    }
    if (invalidQuery(request)) {
      await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor rest does not accept query parameters");
      return false;
    }
    return true;
  };

  app.post<{ Params: { campaignId: string; actorId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/actors/:actorId/rest-commands", {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!(await guard(request, reply))) return;
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Actor rest command requires application/json");
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor rest command request is invalid"),
    }, async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!campaignId.success || !actorId.success) return notFound(request, reply);
      const body = restHttpRequestSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor rest command request is invalid");
      try {
        const result = options.restRepositoryAccessor().takeRest(LOCAL_OWNER, {
          ...body.data,
          campaignId: campaignId.data,
          actorId: actorId.data,
        });
        return reply.code(200).send(restHttpResponseSchema.parse({
          actorState: result.actorState,
          receipt: result.rest,
        }));
      } catch (error) {
        return mapFailure(request, reply, error);
      }
    },
  );
};
