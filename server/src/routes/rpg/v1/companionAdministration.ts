import { createHash } from "node:crypto";
import {
  canonicalAgentJson,
  companionAdministrationHttpCommandSchema,
  companionAdministrationHttpGetResponseSchema,
  companionAdministrationHttpCommandResponseSchema,
  companionAdministrationReceiptSchema,
  companionAdministrationRepositoryPayload,
  npcIdSchema,
  resourceIdSchema,
  type CompanionAdministrationHttpCommand,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  CompanionAuthorizationError,
  CompanionConflictError,
  CompanionStaleError,
  CompanionUnavailableError,
  type CompanionRepository,
} from "../../../repo/companionRepo.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const ADMINISTRATION_INSTANCE = "/api/rpg/v1/campaigns/:campaignId/npcs/:npcId/companion-administration";
const COMMAND_INSTANCE = `${ADMINISTRATION_INSTANCE}/commands`;

type CompanionAdministrationHttpRepository = Pick<CompanionRepository,
  "getCompanionManagement" | "createCompanion" | "createCompanionGrant" | "revokeCompanionGrant">;

export interface CompanionAdministrationHttpOptions {
  companionRepositoryAccessor: () => CompanionAdministrationHttpRepository;
}

function enabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics;
}

function hasQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?")
    || Object.keys(request.query as Record<string, unknown>).length > 0;
}

function instance(request: FastifyRequest): string {
  return request.method === "GET" ? ADMINISTRATION_INSTANCE : COMMAND_INSTANCE;
}

function missing(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  return sendApiProblem(request, reply, 404, "RPG_COMPANION_ADMINISTRATION_NOT_FOUND",
    "Companion administration not found", { instance: instance(request) });
}

function failure(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof CompanionAuthorizationError || error instanceof CompanionUnavailableError) {
    return missing(request, reply);
  }
  if (error instanceof CompanionStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_COMPANION_ADMINISTRATION_STALE",
      "Companion administration is stale; reconcile with the authoritative administration GET before trying again",
      { instance: COMMAND_INSTANCE });
  }
  if (error instanceof CompanionConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_COMPANION_ADMINISTRATION_CONFLICT",
      "Companion administration command conflicts with the current state", { instance: COMMAND_INSTANCE });
  }
  request.log.error({ operation: "companion-administration", method: request.method, route: request.routeOptions.url },
    "RPG companion administration operation failed");
  if (request.method === "GET") {
    return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
      "Companion administration could not be read; retry the authoritative administration GET",
      { instance: ADMINISTRATION_INSTANCE });
  }
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Companion administration outcome could not be confirmed; reconcile with the authoritative administration GET and do not automatically retry",
    { instance: instance(request) });
}

function executeCommand(repository: CompanionAdministrationHttpRepository, campaignId: string, npcId: string,
  command: CompanionAdministrationHttpCommand) {
  if (command.kind === "companion-create") {
    return repository.createCompanion(LOCAL_OWNER, campaignId, {
      sessionId: command.sessionId, npcId, expectedRevision: command.expectedRevision,
      idempotencyKey: command.idempotencyKey,
    });
  }
  if (command.kind === "grant-create") {
    const { kind: _, ...input } = command;
    return repository.createCompanionGrant(LOCAL_OWNER, campaignId, { ...input, npcId });
  }
  return repository.revokeCompanionGrant(LOCAL_OWNER, campaignId, {
    npcId, grantId: command.grantId, reason: command.reason,
    expectedRevision: command.expectedRevision, idempotencyKey: command.idempotencyKey,
  });
}

/** Registers the narrow fixed-local-owner companion management read and command lane. */
export const companionAdministrationHttpRoutes: FastifyPluginAsync<CompanionAdministrationHttpOptions> = async (app, options) => {
  app.get<{ Params: { campaignId: string; npcId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/npcs/:npcId/companion-administration", {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!enabled()) {
          await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found",
            { instance: ADMINISTRATION_INSTANCE });
          return;
        }
        if (hasQuery(request)) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
            "Companion administration does not accept query parameters", { instance: ADMINISTRATION_INSTANCE });
          return;
        }
        if (!resourceIdSchema.safeParse(request.params.campaignId).success
          || !npcIdSchema.safeParse(request.params.npcId).success) {
          await missing(request, reply);
          return;
        }
        if (request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
            "Companion administration does not accept a request body", { instance: ADMINISTRATION_INSTANCE });
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
        "Companion administration does not accept a request body", { instance: ADMINISTRATION_INSTANCE }),
    }, async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const npcId = npcIdSchema.safeParse(request.params.npcId);
      if (!campaignId.success || !npcId.success) return missing(request, reply);
      if (request.body !== undefined) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
        "Companion administration does not accept a request body", { instance: ADMINISTRATION_INSTANCE });
      try {
        const companion = options.companionRepositoryAccessor().getCompanionManagement(
          LOCAL_OWNER, campaignId.data, npcId.data,
        );
        if (companion === null || companion.campaignId !== campaignId.data || companion.npcId !== npcId.data) {
          return missing(request, reply);
        }
        const response = companionAdministrationHttpGetResponseSchema.parse({ companion });
        return reply.code(200).send(response);
      } catch (error) {
        return failure(request, reply, error);
      }
    });

  app.post<{ Params: { campaignId: string; npcId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/npcs/:npcId/companion-administration/commands", {
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!enabled()) {
          await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found",
            { instance: COMMAND_INSTANCE });
          return;
        }
        if (hasQuery(request)) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
            "Companion administration commands do not accept query parameters", { instance: COMMAND_INSTANCE });
          return;
        }
        if (!resourceIdSchema.safeParse(request.params.campaignId).success
          || !npcIdSchema.safeParse(request.params.npcId).success) {
          await missing(request, reply);
          return;
        }
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE",
            "Companion administration commands require application/json", { instance: COMMAND_INSTANCE });
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
        "Companion administration command request is invalid", { instance: COMMAND_INSTANCE }),
    }, async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const npcId = npcIdSchema.safeParse(request.params.npcId);
      if (!campaignId.success || !npcId.success) return missing(request, reply);
      const command = companionAdministrationHttpCommandSchema.safeParse(request.body);
      if (!command.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST",
        "Companion administration command request is invalid", { instance: COMMAND_INSTANCE });
      try {
        const expectedPayloadDigest = createHash("sha256").update(canonicalAgentJson(
          companionAdministrationRepositoryPayload(npcId.data, command.data),
        )).digest("hex");
        const fullReceipt = companionAdministrationReceiptSchema.parse(executeCommand(
          options.companionRepositoryAccessor(), campaignId.data, npcId.data, command.data,
        ));
        if (fullReceipt.campaignId !== campaignId.data || fullReceipt.npcId !== npcId.data
          || fullReceipt.kind !== command.data.kind || fullReceipt.idempotencyKey !== command.data.idempotencyKey
          || fullReceipt.commandPayloadDigest !== expectedPayloadDigest
          || fullReceipt.resultingRevision !== command.data.expectedRevision + 1) {
          throw new Error("companion administration receipt binding is invalid");
        }
        const response = companionAdministrationHttpCommandResponseSchema.parse({ receipt: {
          kind: fullReceipt.kind,
          revisionBefore: command.data.expectedRevision,
          revisionAfter: fullReceipt.resultingRevision,
          occurredAt: fullReceipt.occurredAt,
        } });
        return reply.code(200).send(response);
      } catch (error) {
        return failure(request, reply, error);
      }
    });
};
