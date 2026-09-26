import { resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  FreeformFactionAuthorizationError,
  FreeformFactionConflictError,
  FreeformFactionUnavailableError,
  type FreeformFactionNoneReason,
  type FreeformFactionRepository,
} from "../../../repo/freeform/freeformFactionRepo.js";

/**
 * Free-form faction HTTP lane.
 *
 * One bounded command materializes an ad-hoc faction/order/guild when a player
 * references one the prepared campaign never defined:
 *
 *   POST /campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-faction-commands
 *   body: { text: string (1..2000); candidateId?: string }
 *
 * The server always classifies first. A declaration that names a known faction
 * (or carries no faction intent) returns only the classification; only a
 * `materialize-faction` classification reaches `materializeFreeformFaction`, which
 * selects the exact server-authored candidate and commits the public faction plus
 * a separate GM-only agenda artifact atomically. The route never invents candidate
 * identities and never accepts caller-authored lore.
 */

// Trusted-local adapter, consistent with the other RPG routes. Headers do not confer identity.
const PRINCIPAL = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const MAX_TEXT_LENGTH = 2_000;
const MAX_NAME_LENGTH = 200;
const MAX_ARCHETYPE_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_AGENDA_LENGTH = 4_000;
const MAX_CANDIDATES = 4;

type Params = { campaignId: string; sessionId: string; actorId: string };

const noneReasonSchema = z.enum([
  "no-faction-intent",
  "empty-name",
  "name-too-long",
  "not-a-faction",
  "known-faction",
] satisfies [FreeformFactionNoneReason, ...FreeformFactionNoneReason[]]);

const boundingText = (max: number) => z.string().min(1).max(max);

const candidateSchema = z.object({
  candidateId: boundingText(128),
  factionKey: boundingText(128),
  gmAgendaKey: boundingText(128),
  name: boundingText(MAX_NAME_LENGTH),
  archetype: boundingText(MAX_ARCHETYPE_LENGTH),
  description: boundingText(MAX_DESCRIPTION_LENGTH),
  gmAgenda: boundingText(MAX_AGENDA_LENGTH),
  visibility: z.literal("public"),
}).strict();

const classificationSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("none"),
    reason: noneReasonSchema,
    factionName: boundingText(MAX_NAME_LENGTH).optional(),
  }).strict(),
  z.object({
    intent: z.literal("materialize-faction"),
    factionName: boundingText(MAX_NAME_LENGTH),
    candidates: z.array(candidateSchema).min(1).max(MAX_CANDIDATES),
  }).strict(),
]);

const materializationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("declined"), reason: noneReasonSchema }).strict(),
  z.object({
    status: z.literal("materialized"),
    candidate: z.object({
      candidateId: boundingText(128),
      factionKey: boundingText(128),
      gmAgendaKey: boundingText(128),
      name: boundingText(MAX_NAME_LENGTH),
      visibility: z.literal("public"),
    }).strict(),
    factionId: boundingText(128),
    draftId: boundingText(128),
    contentReceiptId: boundingText(128).nullable(),
    gmAgendaArtifactKey: boundingText(128).nullable(),
  }).strict(),
]);

const requestSchema = z.object({
  text: boundingText(MAX_TEXT_LENGTH),
  candidateId: boundingText(128).optional(),
}).strict();

const responseSchema = z.object({
  classification: classificationSchema,
  materialization: materializationSchema.optional(),
}).strict();

export interface FreeformFactionHttpOptions {
  repositoryAccessor: () => FreeformFactionRepository;
}

function rpgEnabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics;
}

function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendApiProblem(request, reply, 404, "RPG_FREEFORM_FACTION_NOT_FOUND", "Freeform faction resource unavailable");
}

function failure(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof Error && error.name === "ZodError") {
    return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform faction request is invalid");
  }
  if (error instanceof FreeformFactionAuthorizationError || error instanceof FreeformFactionUnavailableError) {
    return unavailable(request, reply);
  }
  if (error instanceof FreeformFactionConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_FREEFORM_FACTION_CONFLICT",
      "Freeform faction conflicts with current state; refresh before retrying");
  }
  request.log.error({ operation: "freeform-faction", method: request.method, route: request.routeOptions.url },
    "freeform faction command failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Freeform faction outcome may be unknown; reconcile before retrying");
}

export const freeformFactionHttpRoutes: FastifyPluginAsync<FreeformFactionHttpOptions> = async (app, options) => {
  app.post<{ Params: Params; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-faction-commands",
    {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        if (!rpgEnabled()) {
          await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
          return;
        }
        if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform faction does not accept query parameters");
          return;
        }
        if (Object.values(request.params).some((value) => !resourceIdSchema.safeParse(value).success)) {
          await unavailable(request, reply);
          return;
        }
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Freeform faction requires application/json");
        }
      },
      errorHandler: (_error, request, reply) =>
        sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform faction request is invalid"),
    },
    async (request, reply) => {
      const body = requestSchema.safeParse(request.body);
      if (!body.success) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform faction request is invalid");
      }
      try {
        const repository = options.repositoryAccessor();
        const { campaignId, sessionId, actorId } = request.params;
        const classification = repository.classifyFreeformFactionIntent(PRINCIPAL, campaignId, sessionId, actorId, body.data.text);
        if (classification.intent === "none") {
          return reply.code(200).send(responseSchema.parse({ classification }));
        }
        const materialization = repository.materializeFreeformFaction(PRINCIPAL, campaignId, sessionId, actorId, body.data.text,
          body.data.candidateId !== undefined ? { candidateId: body.data.candidateId } : {});
        return reply.code(200).send(responseSchema.parse({ classification, materialization }));
      } catch (error) {
        return failure(error, request, reply);
      }
    },
  );
};
