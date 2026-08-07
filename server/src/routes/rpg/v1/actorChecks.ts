import {
  actorCheckCommandRequestSchema,
  actorCheckCommandResponseSchema,
  checkDifficultyRefSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  ActorCheckNotFoundError,
  CheckUnavailableError,
  M16AuthorizationError,
  M16ConflictError,
  M16StaleError,
  type CheckRepository,
} from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface ActorChecksHttpOptions {
  checkRepositoryAccessor: () => Pick<CheckRepository, "resolveActorCheck">;
}

function invalidQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?")
    || Object.keys(request.query as Record<string, unknown>).length > 0;
}

function notFound(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request, reply, 404, "RPG_ACTOR_CHECK_NOT_FOUND", "Actor check state not found");
}

function conflict(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request, reply, 409, "RPG_ACTOR_CHECK_CONFLICT", "Actor check command conflicts with current state");
}

function mapFailure(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof ActorCheckNotFoundError || error instanceof M16AuthorizationError) return notFound(request, reply);
  if (error instanceof M16StaleError) {
    return sendApiProblem(request, reply, 409, "RPG_ACTOR_CHECK_STALE", "Actor check state is stale; refresh before trying again");
  }
  if (error instanceof CheckUnavailableError || error instanceof M16ConflictError) return conflict(request, reply);
  request.log.error({ operation: "actor-check", method: request.method, route: request.routeOptions.url }, "RPG actor check operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Actor check outcome could not be confirmed; reconcile actor state before retrying and do not automatically retry");
}

export const actorChecksHttpRoutes: FastifyPluginAsync<ActorChecksHttpOptions> = async (app, options) => {
  app.post<{ Params: { actorId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/actors/:actorId/check-commands",
    {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        const flags = readRpgFeatureFlags();
        if (!flags.campaign || !flags.mechanics) {
          await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
          return;
        }
        if (invalidQuery(request)) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor checks do not accept query parameters");
          return;
        }
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Actor check command requires application/json");
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(
        request, reply, 400, "RPG_INVALID_REQUEST", "Actor check command request is invalid",
      ),
    },
    async (request, reply) => {
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!actorId.success) return notFound(request, reply);

      // Unknown but syntactically valid names are availability conflicts, not
      // caller-selected numeric difficulty classes or malformed JSON.
      if (request.body && typeof request.body === "object" && "difficultyRef" in request.body) {
        const difficulty = (request.body as { difficultyRef?: unknown }).difficultyRef;
        if (typeof difficulty === "string" && !checkDifficultyRefSchema.safeParse(difficulty).success) return conflict(request, reply);
      }
      const body = actorCheckCommandRequestSchema.safeParse(request.body);
      if (!body.success) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor check command request is invalid");
      }
      try {
        const result = options.checkRepositoryAccessor().resolveActorCheck(LOCAL_OWNER, actorId.data, body.data);
        const modifier = result.resolution.terms.reduce(
          (sum, term) => sum + (term.kind === "roll" ? 0 : term.value), 0,
        );
        return reply.code(200).send(actorCheckCommandResponseSchema.parse({
          check: { ...result.resolution, modifier },
          receipt: {
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
