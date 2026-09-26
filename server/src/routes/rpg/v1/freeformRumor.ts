import { resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  MAX_FREEFORM_RUMOR_SUBJECT_LENGTH,
  FreeformRumorAuthorizationError,
  FreeformRumorConflictError,
  FreeformRumorUnavailableError,
  type FreeformRumorNoneReason,
  type FreeformRumorRepository,
} from "../../../repo/freeform/freeformRumorRepo.js";

/**
 * Free-form rumor HTTP lane.
 *
 * One bounded command materializes public hearsay when a player listens for
 * gossip or asks what people are saying about a subject the prepared campaign
 * never defined:
 *
 *   POST /campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-rumor-commands
 *   body: { text: string (1..2000); candidateId?: string }
 *
 * The server always classifies first. A declaration that names known canon (or
 * carries no listening intent) returns only the classification; only a
 * `materialize-rumor` classification reaches `materializeFreeformRumor`, which
 * selects the exact server-authored candidate and commits one public hearsay
 * `lore` artifact plus a separate GM-only truth artifact atomically. The route
 * never invents candidate identities and never accepts caller-authored rumor
 * text.
 */

// Trusted-local adapter, consistent with the other RPG routes. Headers do not confer identity.
const PRINCIPAL = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const MAX_TEXT_LENGTH = 2_000;
const MAX_ARTIFACT_KEY_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_NARRATIVE_LENGTH = 2_000;
const MAX_CANDIDATES = 4;

type Params = { campaignId: string; sessionId: string; actorId: string };

const noneReasonSchema = z.enum([
  "no-rumor-intent",
  "empty-subject",
  "subject-too-long",
  "known-rumor",
  "no-current-location",
  "current-location-unmapped",
] satisfies [FreeformRumorNoneReason, ...FreeformRumorNoneReason[]]);

const boundingText = (max: number) => z.string().min(1).max(max);

const candidateSchema = z.object({
  candidateId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  hearsayKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  truthKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  locationKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  subject: boundingText(MAX_FREEFORM_RUMOR_SUBJECT_LENGTH),
  source: boundingText(MAX_NARRATIVE_LENGTH),
  publicText: boundingText(MAX_NARRATIVE_LENGTH),
  gmTruth: boundingText(MAX_NARRATIVE_LENGTH),
  templateId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  visibility: z.literal("public"),
}).strict();

const classificationSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("none"),
    reason: noneReasonSchema,
    title: boundingText(MAX_TITLE_LENGTH).optional(),
  }).strict(),
  z.object({
    intent: z.literal("materialize-rumor"),
    subject: boundingText(MAX_FREEFORM_RUMOR_SUBJECT_LENGTH),
    candidates: z.array(candidateSchema).min(1).max(MAX_CANDIDATES),
  }).strict(),
]);

const materializationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("declined"), reason: noneReasonSchema }).strict(),
  z.object({
    status: z.literal("materialized"),
    candidate: z.object({
      candidateId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
      hearsayKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
      truthKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
      subject: boundingText(MAX_FREEFORM_RUMOR_SUBJECT_LENGTH),
      source: boundingText(MAX_NARRATIVE_LENGTH),
      publicText: boundingText(MAX_NARRATIVE_LENGTH),
      visibility: z.literal("public"),
    }).strict(),
    rumorId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
    draftId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
    contentReceiptId: boundingText(MAX_ARTIFACT_KEY_LENGTH).nullable(),
    gmTruthArtifactKey: boundingText(MAX_ARTIFACT_KEY_LENGTH).nullable(),
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

export interface FreeformRumorHttpOptions {
  repositoryAccessor: () => FreeformRumorRepository;
}

function rpgEnabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics;
}

function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendApiProblem(request, reply, 404, "RPG_FREEFORM_RUMOR_NOT_FOUND", "Freeform rumor resource unavailable");
}

function failure(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof Error && error.name === "ZodError") {
    return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform rumor request is invalid");
  }
  if (error instanceof FreeformRumorAuthorizationError || error instanceof FreeformRumorUnavailableError) {
    return unavailable(request, reply);
  }
  if (error instanceof FreeformRumorConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_FREEFORM_RUMOR_CONFLICT",
      "Freeform rumor conflicts with current state; refresh before retrying");
  }
  request.log.error({ operation: "freeform-rumor", method: request.method, route: request.routeOptions.url },
    "freeform rumor command failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Freeform rumor outcome may be unknown; reconcile before retrying");
}

export const freeformRumorHttpRoutes: FastifyPluginAsync<FreeformRumorHttpOptions> = async (app, options) => {
  app.post<{ Params: Params; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-rumor-commands",
    {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        if (!rpgEnabled()) {
          await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
          return;
        }
        if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform rumor does not accept query parameters");
          return;
        }
        if (Object.values(request.params).some((value) => !resourceIdSchema.safeParse(value).success)) {
          await unavailable(request, reply);
          return;
        }
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Freeform rumor requires application/json");
        }
      },
      errorHandler: (_error, request, reply) =>
        sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform rumor request is invalid"),
    },
    async (request, reply) => {
      const body = requestSchema.safeParse(request.body);
      if (!body.success) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform rumor request is invalid");
      }
      try {
        const repository = options.repositoryAccessor();
        const { campaignId, sessionId, actorId } = request.params;
        const classification = repository.classifyFreeformRumorIntent(PRINCIPAL, campaignId, sessionId, actorId, body.data.text);
        if (classification.intent === "none") {
          return reply.code(200).send(responseSchema.parse({ classification }));
        }
        const materialization = repository.materializeFreeformRumor(PRINCIPAL, campaignId, sessionId, actorId, body.data.text,
          body.data.candidateId !== undefined ? { candidateId: body.data.candidateId } : {});
        return reply.code(200).send(responseSchema.parse({ classification, materialization }));
      } catch (error) {
        return failure(error, request, reply);
      }
    },
  );
};
