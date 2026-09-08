import { actorGameplaySheetResponseSchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import type { ActorGameplaySheetReadRepository } from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";

export interface ActorGameplaySheetHttpOptions {
  actorGameplaySheetRepositoryAccessor: () => ActorGameplaySheetReadRepository;
}

function notFound(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request, reply, 404, "RPG_ACTOR_GAMEPLAY_SHEET_NOT_FOUND", "Actor gameplay sheet not found");
}

export const actorGameplaySheetHttpRoutes: FastifyPluginAsync<ActorGameplaySheetHttpOptions> = async (app, options) => {
  app.get<{ Params: { actorId: string }; Querystring: Record<string, unknown> }>(
    "/actors/:actorId/gameplay-sheet",
    {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        const flags = readRpgFeatureFlags();
        if (!flags.campaign || !flags.mechanics) {
          await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
          return;
        }
        if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor gameplay sheet does not accept query parameters");
        }
      },
    },
    async (request, reply) => {
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!actorId.success) return notFound(request, reply);
      try {
        const sheet = options.actorGameplaySheetRepositoryAccessor().getActorGameplaySheet(LOCAL_OWNER, actorId.data);
        if (sheet === null) return notFound(request, reply);
        const parsed = actorGameplaySheetResponseSchema.parse(sheet);
        if (parsed.identity.actorId !== actorId.data) throw new Error("actor gameplay sheet binding is invalid");
        return reply.code(200).send(parsed);
      } catch {
        request.log.error({ operation: "actor-gameplay-sheet-read", method: request.method, route: request.routeOptions.url }, "RPG actor gameplay sheet read failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Actor gameplay sheet could not be loaded");
      }
    },
  );
};
