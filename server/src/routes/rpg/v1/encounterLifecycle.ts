import {
  encounterCreateRequestSchema,
  encounterCreateResponseSchema,
  encounterListResponseSchema,
  encounterStartCommandRequestSchema,
  encounterStartCommandResponseSchema,
  resourceIdSchema,
  type CombatState,
  type EncounterPublic,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  EncounterAuthorizationError,
  EncounterConflictError,
  EncounterStaleError,
  EncounterTurnError,
  EncounterUnavailableError,
  type EncounterRepository,
} from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

type EncounterLifecycleRepository = Pick<EncounterRepository,
  "listEncounters" | "createEncounter" | "startEncounter">;

export interface EncounterLifecycleHttpOptions {
  encounterRepositoryAccessor: () => EncounterLifecycleRepository;
}

function enabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics && flags.combat;
}

function campaignNotFound(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
}

function encounterNotFound(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request, reply, 404, "RPG_ENCOUNTER_NOT_FOUND", "Encounter not found");
}

function projectEncounter(value: NonNullable<ReturnType<EncounterLifecycleRepository["listEncounters"]>>[number]): EncounterPublic {
  const allowed = new Set([
    "campaignId", "encounterId", "sessionId", "name", "status", "combatId", "combatants", "revision", "createdAt", "updatedAt",
  ]);
  if (typeof value !== "object" || value === null || Object.keys(value).length !== allowed.size
      || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("encounter projection shape is invalid");
  }
  return {
    encounterId: value.encounterId,
    sessionId: value.sessionId,
    name: value.name,
    status: value.status,
    combatId: value.combatId,
    combatants: value.combatants,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function projectCombat(value: ReturnType<EncounterLifecycleRepository["startEncounter"]>["combat"]): CombatState {
  const allowed = new Set([
    "campaignId", "encounterId", "combatId", "round", "currentCombatant", "combatants", "legalActions", "revision",
  ]);
  if (typeof value !== "object" || value === null || Object.keys(value).length !== allowed.size
      || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("combat projection shape is invalid");
  }
  return {
    combatId: value.combatId,
    round: value.round,
    currentCombatant: value.currentCombatant,
    combatants: value.combatants,
    legalActions: value.legalActions,
    revision: value.revision,
  };
}

export const encounterLifecycleHttpRoutes: FastifyPluginAsync<EncounterLifecycleHttpOptions> = async (app, options) => {
  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>(
    "/campaigns/:campaignId/encounters",
    { exposeHeadRoute: false, onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
        return;
      }
      if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
        await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter list does not accept query parameters");
      }
    } },
    async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success) return campaignNotFound(request, reply);
      try {
        const encounters = options.encounterRepositoryAccessor().listEncounters(LOCAL_OWNER, campaignId.data);
        if (encounters === null) return campaignNotFound(request, reply);
        if (encounters.some((encounter) => encounter.campaignId !== campaignId.data)) {
          throw new Error("encounter list is not bound to the requested campaign");
        }
        return reply.code(200).send(encounterListResponseSchema.parse({
          encounters: encounters.map(projectEncounter),
        }));
      } catch (error) {
        if (error instanceof EncounterAuthorizationError) return campaignNotFound(request, reply);
        request.log.error({ operation: "encounter-list", method: request.method, route: request.routeOptions.url }, "RPG encounter list failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Encounters could not be loaded");
      }
    },
  );

  app.post<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/encounters",
    { onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
        return;
      }
      if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
        await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter creation does not accept query parameters");
        return;
      }
      if (!resourceIdSchema.safeParse(request.params.campaignId).success) {
        await campaignNotFound(request, reply);
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Encounter creation requires application/json");
      }
    }, errorHandler: (_error, request, reply) =>
      sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter creation request is invalid") },
    async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success) return campaignNotFound(request, reply);
      const body = encounterCreateRequestSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter creation request is invalid");
      try {
        const result = options.encounterRepositoryAccessor().createEncounter(LOCAL_OWNER, campaignId.data, body.data);
        if (result.campaignId !== campaignId.data || result.encounter.campaignId !== campaignId.data
            || result.receipt.idempotencyKey !== body.data.idempotencyKey
            || result.receipt.revisionBefore !== 0 || result.receipt.revisionAfter !== 1) {
          throw new Error("encounter creation result binding is invalid");
        }
        return reply.code(201).send(encounterCreateResponseSchema.parse({ encounter: projectEncounter(result.encounter) }));
      } catch (error) {
        if (error instanceof EncounterAuthorizationError) return campaignNotFound(request, reply);
        if (error instanceof EncounterStaleError || error instanceof EncounterConflictError
            || error instanceof EncounterUnavailableError || error instanceof EncounterTurnError) {
          return sendApiProblem(request, reply, 409, "RPG_ENCOUNTER_CONFLICT", "Encounter creation conflicts with current state");
        }
        request.log.error({ operation: "encounter-create", method: request.method, route: request.routeOptions.url }, "RPG encounter creation failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
          "Encounter creation outcome could not be confirmed; reconcile the encounter list before retrying and do not automatically retry");
      }
    },
  );

  app.post<{ Params: { encounterId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/encounters/:encounterId/start-commands",
    { onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
        return;
      }
      if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
        await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter start does not accept query parameters");
        return;
      }
      if (!resourceIdSchema.safeParse(request.params.encounterId).success) {
        await encounterNotFound(request, reply);
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Encounter start requires application/json");
      }
    }, errorHandler: (_error, request, reply) =>
      sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter start request is invalid") },
    async (request, reply) => {
      const encounterId = resourceIdSchema.safeParse(request.params.encounterId);
      if (!encounterId.success) return encounterNotFound(request, reply);
      const body = encounterStartCommandRequestSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter start request is invalid");
      try {
        const result = options.encounterRepositoryAccessor().startEncounter(LOCAL_OWNER, encounterId.data, body.data);
        if (result.encounterId !== encounterId.data || result.combat.encounterId !== encounterId.data
            || result.combat.combatId !== encounterId.data || result.combat.campaignId !== result.campaignId
            || result.receipt.idempotencyKey !== body.data.idempotencyKey
            || result.receipt.revisionBefore !== body.data.expectedRevision
            || result.receipt.revisionAfter !== body.data.expectedRevision + 1) {
          throw new Error("encounter start result binding is invalid");
        }
        return reply.code(200).send(encounterStartCommandResponseSchema.parse({
          combat: projectCombat(result.combat),
          receipt: {
            idempotencyKey: result.receipt.idempotencyKey,
            revisionBefore: result.receipt.revisionBefore,
            revisionAfter: result.receipt.revisionAfter,
            occurredAt: result.receipt.occurredAt,
          },
        }));
      } catch (error) {
        if (error instanceof EncounterAuthorizationError || error instanceof EncounterUnavailableError) {
          return encounterNotFound(request, reply);
        }
        if (error instanceof EncounterStaleError) {
          return sendApiProblem(request, reply, 409, "RPG_ENCOUNTER_STALE", "Encounter state is stale; refresh before trying again");
        }
        if (error instanceof EncounterConflictError || error instanceof EncounterTurnError) {
          return sendApiProblem(request, reply, 409, "RPG_ENCOUNTER_CONFLICT", "Encounter cannot be started in its current state");
        }
        request.log.error({ operation: "encounter-start", method: request.method, route: request.routeOptions.url }, "RPG encounter start failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
          "Encounter start outcome could not be confirmed; reconcile combat state before retrying and do not automatically retry");
      }
    },
  );
};
