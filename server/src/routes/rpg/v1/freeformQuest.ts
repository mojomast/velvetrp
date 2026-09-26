import { resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  MAX_FREEFORM_QUEST_LEAD_LENGTH,
  FreeformQuestAuthorizationError,
  FreeformQuestConflictError,
  FreeformQuestUnavailableError,
  type FreeformQuestNoneReason,
  type FreeformQuestRepository,
} from "../../../repo/freeform/freeformQuestRepo.js";

/**
 * Free-form quest HTTP lane.
 *
 * One bounded command materializes an ad-hoc public quest when a player asks for
 * work, a job or a lead the prepared campaign never defined:
 *
 *   POST /campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-quest-commands
 *   body: { text: string (1..2000); candidateId?: string }
 *
 * The server always classifies first. A declaration that asks for known work (or
 * carries no work intent) returns only the classification; only a
 * `materialize-quest` classification reaches `materializeFreeformQuest`, which
 * selects the exact server-authored candidate and commits the public quest with
 * its bounded public objectives plus a separate GM-only twist artifact
 * atomically. The route never invents candidate identities and never accepts
 * caller-authored content.
 */

// Trusted-local adapter, consistent with the other RPG routes. Headers do not confer identity.
const PRINCIPAL = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const MAX_TEXT_LENGTH = 2_000;
const MAX_ARTIFACT_KEY_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;
const MAX_NARRATIVE_LENGTH = 2_000;
const MAX_OBJECTIVES = 3;
const MAX_DEPENDENCIES = 4;
const MAX_CANDIDATES = 4;

type Params = { campaignId: string; sessionId: string; actorId: string };

const noneReasonSchema = z.enum([
  "no-quest-intent",
  "empty-lead",
  "lead-too-long",
  "known-quest",
  "no-current-location",
  "current-location-unmapped",
] satisfies [FreeformQuestNoneReason, ...FreeformQuestNoneReason[]]);

const boundingText = (max: number) => z.string().min(1).max(max);

const objectiveSchema = z.object({
  key: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  description: boundingText(MAX_NARRATIVE_LENGTH),
  targetProgress: z.number().int().min(1).max(1_000_000),
  dependencyObjectiveKeys: z.array(boundingText(MAX_ARTIFACT_KEY_LENGTH)).max(MAX_DEPENDENCIES),
  visibility: z.literal("public"),
}).strict();

const rewardSchema = z.object({
  key: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  label: boundingText(MAX_LABEL_LENGTH),
  kind: z.literal("custom"),
  amount: z.null(),
  visibility: z.literal("public"),
}).strict();

const candidateSchema = z.object({
  candidateId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  questKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  gmTwistKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  locationKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
  title: boundingText(MAX_TITLE_LENGTH),
  description: boundingText(MAX_NARRATIVE_LENGTH),
  objectives: z.array(objectiveSchema).min(1).max(MAX_OBJECTIVES),
  reward: rewardSchema,
  gmTwist: boundingText(MAX_NARRATIVE_LENGTH),
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
    intent: z.literal("materialize-quest"),
    lead: boundingText(MAX_FREEFORM_QUEST_LEAD_LENGTH),
    candidates: z.array(candidateSchema).min(1).max(MAX_CANDIDATES),
  }).strict(),
]);

const materializationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("declined"), reason: noneReasonSchema }).strict(),
  z.object({
    status: z.literal("materialized"),
    candidate: z.object({
      candidateId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
      questKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
      gmTwistKey: boundingText(MAX_ARTIFACT_KEY_LENGTH),
      title: boundingText(MAX_TITLE_LENGTH),
      visibility: z.literal("public"),
    }).strict(),
    questId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
    draftId: boundingText(MAX_ARTIFACT_KEY_LENGTH),
    contentReceiptId: boundingText(MAX_ARTIFACT_KEY_LENGTH).nullable(),
    gmTwistArtifactKey: boundingText(MAX_ARTIFACT_KEY_LENGTH).nullable(),
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

export interface FreeformQuestHttpOptions {
  repositoryAccessor: () => FreeformQuestRepository;
}

function rpgEnabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics;
}

function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendApiProblem(request, reply, 404, "RPG_FREEFORM_QUEST_NOT_FOUND", "Freeform quest resource unavailable");
}

function failure(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof Error && error.name === "ZodError") {
    return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform quest request is invalid");
  }
  if (error instanceof FreeformQuestAuthorizationError || error instanceof FreeformQuestUnavailableError) {
    return unavailable(request, reply);
  }
  if (error instanceof FreeformQuestConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_FREEFORM_QUEST_CONFLICT",
      "Freeform quest conflicts with current state; refresh before retrying");
  }
  request.log.error({ operation: "freeform-quest", method: request.method, route: request.routeOptions.url },
    "freeform quest command failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Freeform quest outcome may be unknown; reconcile before retrying");
}

export const freeformQuestHttpRoutes: FastifyPluginAsync<FreeformQuestHttpOptions> = async (app, options) => {
  app.post<{ Params: Params; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-quest-commands",
    {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        if (!rpgEnabled()) {
          await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
          return;
        }
        if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform quest does not accept query parameters");
          return;
        }
        if (Object.values(request.params).some((value) => !resourceIdSchema.safeParse(value).success)) {
          await unavailable(request, reply);
          return;
        }
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Freeform quest requires application/json");
        }
      },
      errorHandler: (_error, request, reply) =>
        sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform quest request is invalid"),
    },
    async (request, reply) => {
      const body = requestSchema.safeParse(request.body);
      if (!body.success) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform quest request is invalid");
      }
      try {
        const repository = options.repositoryAccessor();
        const { campaignId, sessionId, actorId } = request.params;
        const classification = repository.classifyFreeformQuestIntent(PRINCIPAL, campaignId, sessionId, actorId, body.data.text);
        if (classification.intent === "none") {
          return reply.code(200).send(responseSchema.parse({ classification }));
        }
        const materialization = repository.materializeFreeformQuest(PRINCIPAL, campaignId, sessionId, actorId, body.data.text,
          body.data.candidateId !== undefined ? { candidateId: body.data.candidateId } : {});
        return reply.code(200).send(responseSchema.parse({ classification, materialization }));
      } catch (error) {
        return failure(error, request, reply);
      }
    },
  );
};
