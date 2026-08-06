import {
  inventoryHttpCommandRequestSchema,
  inventoryHttpCommandResponseSchema,
  inventoryHttpGetResponseSchema,
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
  InventoryAuthorizationError,
  InventoryBindingError,
  InventoryCapacityError,
  InventorySlotConflictError,
  InventoryStaleError,
  type InventoryRepository,
} from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface ActorInventoryHttpOptions {
  inventoryRepositoryAccessor: () => Pick<InventoryRepository,
    "getActorInventorySnapshot" | "mutateInventoryForActor">;
}

function invalidQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0;
}

function notFound(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  // Authorization and absent actor state intentionally share one response.
  return sendApiProblem(request, reply, 404, "RPG_ACTOR_INVENTORY_NOT_FOUND", "Actor inventory not found");
}

function mapFailure(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof ActorResourceAuthorizationError || error instanceof InventoryAuthorizationError) return notFound(request, reply);
  if (error instanceof ActorResourceStaleError || error instanceof InventoryStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_ACTOR_INVENTORY_STALE", "Actor inventory is stale; refresh before trying again");
  }
  if (error instanceof ActorResourceConflictError || error instanceof ActorResourceNegativeError
    || error instanceof InventoryBindingError || error instanceof InventoryCapacityError || error instanceof InventorySlotConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_ACTOR_INVENTORY_CONFLICT", "Actor inventory command conflicts with current state");
  }
  request.log.error({ operation: "actor-inventory", method: request.method, route: request.routeOptions.url }, "RPG actor inventory operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Actor inventory could not be loaded");
}

export const actorInventoryHttpRoutes: FastifyPluginAsync<ActorInventoryHttpOptions> = async (app, options) => {
  const guard = async (request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) => {
    reply.header("cache-control", "no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) {
      await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      return false;
    }
    if (invalidQuery(request)) {
      await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor inventory does not accept query parameters");
      return false;
    }
    return true;
  };

  app.get<{ Params: { campaignId: string; actorId: string }; Querystring: Record<string, unknown> }>(
    "/campaigns/:campaignId/actors/:actorId/inventory", { exposeHeadRoute: false }, async (request, reply) => {
      if (!(await guard(request, reply))) return;
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!campaignId.success || !actorId.success) return notFound(request, reply);
      try {
        const snapshot = options.inventoryRepositoryAccessor().getActorInventorySnapshot(LOCAL_OWNER, campaignId.data, actorId.data);
        if (snapshot === null) return notFound(request, reply);
        if (snapshot.campaignId !== campaignId.data || snapshot.actorId !== actorId.data) throw new Error("actor inventory snapshot does not match request");
        return reply.code(200).send(inventoryHttpGetResponseSchema.parse({
          entries: snapshot.inventory.items,
          equipment: snapshot.equipment,
          capacity: snapshot.inventory.capacity,
          revision: snapshot.revision,
        }));
      } catch (error) {
        return mapFailure(request, reply, error);
      }
    },
  );

  app.post<{ Params: { campaignId: string; actorId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/actors/:actorId/inventory-commands", {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!(await guard(request, reply))) return;
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Actor inventory command requires application/json");
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor inventory command request is invalid"),
    }, async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!campaignId.success || !actorId.success) return notFound(request, reply);
      const body = inventoryHttpCommandRequestSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor inventory command request is invalid");
      try {
        const result = options.inventoryRepositoryAccessor().mutateInventoryForActor(LOCAL_OWNER, campaignId.data, actorId.data, body.data);
        const { expectedRevision: _expectedRevision, ...command } = body.data;
        return reply.code(200).send(inventoryHttpCommandResponseSchema.parse({
          inventory: {
            entries: result.inventory.inventory.items,
            equipment: result.inventory.equipment,
            capacity: result.inventory.inventory.capacity,
            revision: result.receipt.revisionAfter,
          },
          receipt: {
            ...command,
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
