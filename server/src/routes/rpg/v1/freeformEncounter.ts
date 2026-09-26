import { enemyTemplateCatalogReferenceSchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  MAX_FREEFORM_ENCOUNTER_ENEMIES,
  MIN_FREEFORM_ENCOUNTER_ENEMIES,
  FreeformEncounterAuthorizationError,
  FreeformEncounterConflictError,
  FreeformEncounterUnavailableError,
  type FreeformEncounterNoneReason,
  type FreeformEncounterRepository,
} from "../../../repo/freeform/freeformEncounterRepo.js";

/**
 * Free-form encounter HTTP lane.
 *
 * One bounded command materializes an ad-hoc hostile encounter when a player
 * provokes a fight the prepared campaign never defined:
 *
 *   POST /campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-encounter-commands
 *   body: { text: string (1..2000); candidateId?: string }
 *
 * The server always classifies first. A declaration that carries no hostile
 * intent (or has no compatible pinned enemy) returns only the classification;
 * only a `materialize-encounter` classification reaches
 * `materializeFreeformEncounter`, which selects the exact server-authored
 * candidate, creates and starts the encounter atomically, and generates the
 * deterministic tactical map inside the same transaction. The route never
 * invents a stat block and never accepts caller-authored enemies.
 */

// Trusted-local adapter, consistent with the other RPG routes. Headers do not confer identity.
const PRINCIPAL = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const MAX_TEXT_LENGTH = 2_000;
const MAX_ARTIFACT_KEY_LENGTH = 128;
const MAX_NAME_LENGTH = 200;
const MAX_CANDIDATES = 1;

type Params = { campaignId: string; sessionId: string; actorId: string };

const noneReasonSchema = z.enum([
  "no-hostile-intent",
  "no-compatible-enemy",
] satisfies [FreeformEncounterNoneReason, ...FreeformEncounterNoneReason[]]);

const boundingText = (max: number) => z.string().min(1).max(max);

const candidateSchema = z.object({
  candidateId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  encounterName: boundingText(MAX_NAME_LENGTH),
  actorId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  enemies: z.array(enemyTemplateCatalogReferenceSchema).min(MIN_FREEFORM_ENCOUNTER_ENEMIES).max(MAX_FREEFORM_ENCOUNTER_ENEMIES),
  visibility: z.literal("public"),
}).strict();

const receiptSchema = z.object({
  commandId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  idempotencyKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  revisionBefore: z.number().int().min(0),
  revisionAfter: z.number().int().min(0),
  occurredAt: boundingText(64),
}).strict();

const classificationSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("none"),
    reason: noneReasonSchema,
  }).strict(),
  z.object({
    intent: z.literal("materialize-encounter"),
    candidates: z.array(candidateSchema).min(1).max(MAX_CANDIDATES),
  }).strict(),
]);

const materializationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("declined"), reason: noneReasonSchema }).strict(),
  z.object({
    status: z.literal("materialized"),
    candidate: candidateSchema,
    encounterId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
    combatId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
    tacticalMapId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
    createReceipt: receiptSchema,
    startReceipt: receiptSchema,
  }).strict(),
]);

const requestSchema = z.object({
  text: boundingText(MAX_TEXT_LENGTH),
  candidateId: boundingText(MAX_ARTIFACT_KEY_LENGTH).optional(),
}).strict();

const responseSchema = z.object({
  classification: classificationSchema,
  materialization: materializationSchema.optional(),
}).strict();

export interface FreeformEncounterHttpOptions {
  repositoryAccessor: () => FreeformEncounterRepository;
}

function rpgEnabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics;
}

function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendApiProblem(request, reply, 404, "RPG_FREEFORM_ENCOUNTER_NOT_FOUND", "Freeform encounter resource unavailable");
}

function failure(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof Error && error.name === "ZodError") {
    return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform encounter request is invalid");
  }
  if (error instanceof FreeformEncounterAuthorizationError || error instanceof FreeformEncounterUnavailableError) {
    return unavailable(request, reply);
  }
  if (error instanceof FreeformEncounterConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_FREEFORM_ENCOUNTER_CONFLICT",
      "Freeform encounter conflicts with current state; refresh before retrying");
  }
  request.log.error({ operation: "freeform-encounter", method: request.method, route: request.routeOptions.url },
    "freeform encounter command failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Freeform encounter outcome may be unknown; reconcile before retrying");
}

export const freeformEncounterHttpRoutes: FastifyPluginAsync<FreeformEncounterHttpOptions> = async (app, options) => {
  app.post<{ Params: Params; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-encounter-commands",
    {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        if (!rpgEnabled()) {
          await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
          return;
        }
        if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform encounter does not accept query parameters");
          return;
        }
        if (Object.values(request.params).some((value) => !resourceIdSchema.safeParse(value).success)) {
          await unavailable(request, reply);
          return;
        }
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Freeform encounter requires application/json");
        }
      },
      errorHandler: (_error, request, reply) =>
        sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform encounter request is invalid"),
    },
    async (request, reply) => {
      const body = requestSchema.safeParse(request.body);
      if (!body.success) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform encounter request is invalid");
      }
      try {
        const repository = options.repositoryAccessor();
        const { campaignId, sessionId, actorId } = request.params;
        const classification = repository.classifyFreeformEncounterIntent(PRINCIPAL, campaignId, sessionId, actorId, body.data.text);
        if (classification.intent === "none") {
          return reply.code(200).send(responseSchema.parse({ classification }));
        }
        const materialization = repository.materializeFreeformEncounter(PRINCIPAL, campaignId, sessionId, actorId, body.data.text,
          body.data.candidateId !== undefined ? { candidateId: body.data.candidateId } : {});
        return reply.code(200).send(responseSchema.parse({ classification, materialization }));
      } catch (error) {
        return failure(error, request, reply);
      }
    },
  );
};
