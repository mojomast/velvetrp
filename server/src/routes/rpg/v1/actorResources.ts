import {
  actorResourcesHttpChangeCommandRequestSchema,
  actorResourcesHttpChangeCommandResponseSchema,
  actorResourcesHttpGetResponseSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  ActorResourceAuthorizationError,
  ActorResourceConflictError,
  ActorResourceNegativeError,
  ActorResourceStaleError,
  type ActorResourceRepository,
} from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface ActorResourcesHttpOptions {
  actorResourceRepositoryAccessor: () => Pick<ActorResourceRepository,
    "getActorResourceSnapshot" | "changeActorResourceForActor">;
}

function invalidQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0;
}

function notFound(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  // Authorization and absent actor state intentionally share one response.
  return sendApiProblem(request, reply, 404, "RPG_ACTOR_RESOURCE_NOT_FOUND", "Actor resources not found");
}

function mapFailure(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof ActorResourceAuthorizationError) return notFound(request, reply);
  if (error instanceof ActorResourceStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_ACTOR_RESOURCE_STALE", "Actor resources are stale; refresh before trying again");
  }
  if (error instanceof ActorResourceConflictError || error instanceof ActorResourceNegativeError) {
    return sendApiProblem(request, reply, 409, "RPG_ACTOR_RESOURCE_CONFLICT", "Actor resource command conflicts with current state");
  }
  request.log.error({ operation: "actor-resources", method: request.method, route: request.routeOptions.url }, "RPG actor resource operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Actor resources could not be loaded");
}

export const actorResourcesHttpRoutes: FastifyPluginAsync<ActorResourcesHttpOptions> = async (app, options) => {
  const guard = async (request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) => {
    reply.header("cache-control", "no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) {
      await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      return false;
    }
    if (invalidQuery(request)) {
      await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor resources do not accept query parameters");
      return false;
    }
    return true;
  };

  app.get<{ Params: { campaignId: string; actorId: string }; Querystring: Record<string, unknown> }>(
    "/campaigns/:campaignId/actors/:actorId/resources", { exposeHeadRoute: false }, async (request, reply) => {
      if (!(await guard(request, reply))) return;
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!campaignId.success || !actorId.success) return notFound(request, reply);
      try {
        const snapshot = options.actorResourceRepositoryAccessor().getActorResourceSnapshot(
          LOCAL_OWNER, campaignId.data, actorId.data,
        );
        if (snapshot === null) return notFound(request, reply);
        if (snapshot.campaignId !== campaignId.data || snapshot.actorId !== actorId.data) throw new Error("actor resource snapshot does not match request");
        return reply.code(200).send(actorResourcesHttpGetResponseSchema.parse({
          resources: snapshot.resources.map(({ resourceId, current, capacity }) => ({ name: resourceId, current, max: capacity })),
          revision: snapshot.revision,
        }));
      } catch (error) {
        return mapFailure(request, reply, error);
      }
    },
  );

  app.post<{ Params: { campaignId: string; actorId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/actors/:actorId/resource-commands", {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!(await guard(request, reply))) return;
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Actor resource command requires application/json");
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor resource command request is invalid"),
    }, async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!campaignId.success || !actorId.success) return notFound(request, reply);
      const body = actorResourcesHttpChangeCommandRequestSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor resource command request is invalid");
      try {
        const result = options.actorResourceRepositoryAccessor().changeActorResourceForActor(
          LOCAL_OWNER, campaignId.data, actorId.data, body.data,
        );
        return reply.code(200).send(actorResourcesHttpChangeCommandResponseSchema.parse({
          resources: result.resources.map(({ resourceId, current, capacity }) => ({ name: resourceId, current, max: capacity })),
          receipt: {
            kind: body.data.kind,
            resourceName: body.data.resourceName,
            amount: body.data.amount,
            idempotencyKey: result.receipt.idempotencyKey,
            revisionBefore: result.receipt.revisionBefore,
            revisionAfter: result.receipt.revisionAfter,
            occurredAt: result.receipt.occurredAt,
          },
        }));
      } catch (error) {
        return mapFailure(request, reply, error);
      }
    },
  );
};
