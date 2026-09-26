import { resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  FreeformTravelAuthorizationError,
  FreeformTravelConflictError,
  FreeformTravelUnavailableError,
  type FreeformTravelNoneReason,
  type FreeformTravelRepository,
} from "../../../repo/freeform/freeformTravelRepo.js";

/**
 * Free-form travel HTTP lane.
 *
 * One bounded command materializes an unmapped location when a player declares
 * travel to a place the prepared campaign never defined:
 *
 *   POST /campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-travel-commands
 *   body: { text: string (1..2000); candidateId?: string }
 *
 * The server always classifies first. A declaration that names an existing
 * location (or carries no travel intent) returns only the classification; only a
 * `materialize-location` classification reaches
 * `materializeFreeformTravel`, which selects the exact server-authored candidate
 * and commits the location, connection and actor movement atomically. The route
 * never invents candidate identities and never accepts caller-authored lore.
 */

// Trusted-local adapter, consistent with the other RPG routes. Headers do not confer identity.
const PRINCIPAL = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const MAX_TEXT_LENGTH = 2_000;
const MAX_DESTINATION_LENGTH = 200;
const MAX_LOCATION_LABEL_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_CANDIDATES = 4;
const MAX_DISCOVERIES = 64;

type Params = { campaignId: string; sessionId: string; actorId: string };

const noneReasonSchema = z.enum([
  "no-travel-intent",
  "empty-destination",
  "destination-too-long",
  "known-location",
  "no-current-location",
  "current-location-unmapped",
] satisfies [FreeformTravelNoneReason, ...FreeformTravelNoneReason[]]);

const boundingText = (max: number) => z.string().min(1).max(max);

const candidateSchema = z.object({
  candidateId: boundingText(128),
  locationKey: boundingText(128),
  connectionKey: boundingText(128),
  fromLocationKey: boundingText(128),
  fromLocationId: boundingText(128),
  fromLocationName: boundingText(MAX_LOCATION_LABEL_LENGTH),
  name: boundingText(MAX_DESTINATION_LENGTH),
  description: boundingText(MAX_DESCRIPTION_LENGTH),
  visibility: z.literal("public"),
}).strict();

const classificationSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("none"),
    reason: noneReasonSchema,
    locationId: boundingText(128).optional(),
  }).strict(),
  z.object({
    intent: z.literal("materialize-location"),
    destinationName: boundingText(MAX_DESTINATION_LENGTH),
    candidates: z.array(candidateSchema).min(1).max(MAX_CANDIDATES),
  }).strict(),
]);

const materializationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("declined"), reason: noneReasonSchema }).strict(),
  z.object({
    status: z.literal("materialized"),
    candidate: z.object({
      candidateId: boundingText(128),
      locationKey: boundingText(128),
      connectionKey: boundingText(128),
      name: boundingText(MAX_DESTINATION_LENGTH),
      visibility: z.literal("public"),
    }).strict(),
    locationId: boundingText(128),
    connectionId: boundingText(128),
    draftId: boundingText(128),
    contentReceiptId: boundingText(128).nullable(),
    world: z.object({
      commandId: boundingText(128),
      revisionBefore: z.number().int().min(0),
      revisionAfter: z.number().int().min(0),
      occurredAt: boundingText(64),
    }).strict(),
    discoveries: z.array(z.object({
      actorId: boundingText(128),
      locationId: boundingText(128),
      discoveredAt: boundingText(64),
    }).strict()).max(MAX_DISCOVERIES),
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

export interface FreeformTravelHttpOptions {
  repositoryAccessor: () => FreeformTravelRepository;
}

function rpgEnabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics;
}

function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendApiProblem(request, reply, 404, "RPG_FREEFORM_TRAVEL_NOT_FOUND", "Freeform travel resource unavailable");
}

function failure(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof Error && error.name === "ZodError") {
    return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform travel request is invalid");
  }
  if (error instanceof FreeformTravelAuthorizationError || error instanceof FreeformTravelUnavailableError) {
    return unavailable(request, reply);
  }
  if (error instanceof FreeformTravelConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_FREEFORM_TRAVEL_CONFLICT",
      "Freeform travel conflicts with current state; refresh before retrying");
  }
  request.log.error({ operation: "freeform-travel", method: request.method, route: request.routeOptions.url },
    "freeform travel command failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Freeform travel outcome may be unknown; reconcile before retrying");
}

export const freeformTravelHttpRoutes: FastifyPluginAsync<FreeformTravelHttpOptions> = async (app, options) => {
  app.post<{ Params: Params; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-travel-commands",
    {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        if (!rpgEnabled()) {
          await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
          return;
        }
        if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform travel does not accept query parameters");
          return;
        }
        if (Object.values(request.params).some((value) => !resourceIdSchema.safeParse(value).success)) {
          await unavailable(request, reply);
          return;
        }
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Freeform travel requires application/json");
        }
      },
      errorHandler: (_error, request, reply) =>
        sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform travel request is invalid"),
    },
    async (request, reply) => {
      const body = requestSchema.safeParse(request.body);
      if (!body.success) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform travel request is invalid");
      }
      try {
        const repository = options.repositoryAccessor();
        const { campaignId, sessionId, actorId } = request.params;
        const classification = repository.classifyFreeformTravelIntent(PRINCIPAL, campaignId, sessionId, actorId, body.data.text);
        if (classification.intent === "none") {
          return reply.code(200).send(responseSchema.parse({ classification }));
        }
        const materialization = repository.materializeFreeformTravel(PRINCIPAL, campaignId, sessionId, actorId, body.data.text,
          body.data.candidateId !== undefined ? { candidateId: body.data.candidateId } : {});
        return reply.code(200).send(responseSchema.parse({ classification, materialization }));
      } catch (error) {
        return failure(error, request, reply);
      }
    },
  );
};
