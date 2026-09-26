import { resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  FreeformShopAuthorizationError,
  FreeformShopConflictError,
  FreeformShopUnavailableError,
  MAX_FREEFORM_SHOP_ITEMS,
  MAX_FREEFORM_SHOP_QUANTITY,
  MIN_FREEFORM_SHOP_QUANTITY,
  type FreeformShopNoneReason,
  type FreeformShopRepository,
} from "../../../repo/freeform/freeformShopRepo.js";

/**
 * Free-form shop HTTP lane.
 *
 * One bounded command materializes catalog-bound shop stock for an ad-hoc
 * merchant when a player wants to buy from a shopkeeper the prepared campaign
 * never defined:
 *
 *   POST /campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-shop-commands
 *   body: { merchantNpcId: string; candidateId?: string }
 *
 * The server always classifies first. A merchant that is unknown, non-public, or
 * already stocked returns only the classification; only a `materialize-shop`
 * classification reaches `materializeFreeformShop`, which selects the exact
 * server-authored candidate and commits the public shop notice plus the shop,
 * stock and merchant binding atomically. The route never invents an item, a
 * quantity, a price or a currency and never accepts caller-authored stock.
 */

// Trusted-local adapter, consistent with the other RPG routes. Headers do not confer identity.
const PRINCIPAL = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const MAX_NAME_LENGTH = 200;
const MAX_SHOP_NAME_LENGTH = 200;
const MAX_PACK_VERSION_LENGTH = 64;
const MAX_DEFINITION_ID_LENGTH = 256;
const MAX_CURRENCY_CODE_LENGTH = 64;
const MAX_CANDIDATES = 1;

type Params = { campaignId: string; sessionId: string; actorId: string };

const noneReasonSchema = z.enum([
  "no-merchant",
  "merchant-not-public",
  "shop-already-exists",
  "no-compatible-item",
] satisfies [FreeformShopNoneReason, ...FreeformShopNoneReason[]]);

const boundingText = (max: number) => z.string().min(1).max(max);

const itemReferenceSchema = z.object({
  kind: z.literal("item"),
  packId: boundingText(128),
  packVersion: boundingText(MAX_PACK_VERSION_LENGTH),
  definitionId: boundingText(MAX_DEFINITION_ID_LENGTH),
}).strict();

const stockLineSchema = z.object({
  stockId: boundingText(128),
  item: itemReferenceSchema,
  quantity: z.number().int().min(MIN_FREEFORM_SHOP_QUANTITY).max(MAX_FREEFORM_SHOP_QUANTITY),
  unitPriceMinor: z.number().int().min(0),
  currencyCode: boundingText(MAX_CURRENCY_CODE_LENGTH),
}).strict();

const candidateSchema = z.object({
  candidateId: boundingText(128),
  shopId: boundingText(128),
  shopName: boundingText(MAX_SHOP_NAME_LENGTH),
  npcId: boundingText(128),
  items: z.array(stockLineSchema).min(1).max(MAX_FREEFORM_SHOP_ITEMS),
}).strict();

const classificationSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("none"),
    reason: noneReasonSchema,
  }).strict(),
  z.object({
    intent: z.literal("materialize-shop"),
    merchantName: boundingText(MAX_NAME_LENGTH),
    candidates: z.array(candidateSchema).min(1).max(MAX_CANDIDATES),
  }).strict(),
]);

const materializationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("declined"), reason: noneReasonSchema }).strict(),
  z.object({
    status: z.literal("materialized"),
    candidate: candidateSchema,
    shopId: boundingText(128),
    npcId: boundingText(128),
    draftId: boundingText(128),
    contentReceiptId: boundingText(128).nullable(),
    bindingCreated: z.boolean(),
    stock: z.array(stockLineSchema).min(1).max(MAX_FREEFORM_SHOP_ITEMS),
  }).strict(),
]);

const requestSchema = z.object({
  merchantNpcId: boundingText(128),
  candidateId: boundingText(128).optional(),
}).strict();

const responseSchema = z.object({
  classification: classificationSchema,
  materialization: materializationSchema.optional(),
}).strict();

export interface FreeformShopHttpOptions {
  repositoryAccessor: () => FreeformShopRepository;
}

function rpgEnabled(): boolean {
  const flags = readRpgFeatureFlags();
  return flags.campaign && flags.mechanics;
}

function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendApiProblem(request, reply, 404, "RPG_FREEFORM_SHOP_NOT_FOUND", "Freeform shop resource unavailable");
}

function failure(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof Error && error.name === "ZodError") {
    return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform shop request is invalid");
  }
  if (error instanceof FreeformShopAuthorizationError || error instanceof FreeformShopUnavailableError) {
    return unavailable(request, reply);
  }
  if (error instanceof FreeformShopConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_FREEFORM_SHOP_CONFLICT",
      "Freeform shop conflicts with current state; refresh before retrying");
  }
  request.log.error({ operation: "freeform-shop", method: request.method, route: request.routeOptions.url },
    "freeform shop command failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Freeform shop outcome may be unknown; reconcile before retrying");
}

export const freeformShopHttpRoutes: FastifyPluginAsync<FreeformShopHttpOptions> = async (app, options) => {
  app.post<{ Params: Params; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-shop-commands",
    {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "private, no-store");
        if (!rpgEnabled()) {
          await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
          return;
        }
        if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0) {
          await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform shop does not accept query parameters");
          return;
        }
        if (Object.values(request.params).some((value) => !resourceIdSchema.safeParse(value).success)) {
          await unavailable(request, reply);
          return;
        }
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Freeform shop requires application/json");
        }
      },
      errorHandler: (_error, request, reply) =>
        sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform shop request is invalid"),
    },
    async (request, reply) => {
      const body = requestSchema.safeParse(request.body);
      if (!body.success) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Freeform shop request is invalid");
      }
      try {
        const repository = options.repositoryAccessor();
        const { campaignId, sessionId, actorId } = request.params;
        const classification = repository.classifyFreeformShopIntent(PRINCIPAL, campaignId, sessionId, actorId, body.data.merchantNpcId);
        if (classification.intent === "none") {
          return reply.code(200).send(responseSchema.parse({ classification }));
        }
        const materialization = repository.materializeFreeformShop(PRINCIPAL, campaignId, sessionId, actorId, body.data.merchantNpcId,
          body.data.candidateId !== undefined ? { candidateId: body.data.candidateId } : {});
        return reply.code(200).send(responseSchema.parse({ classification, materialization }));
      } catch (error) {
        return failure(error, request, reply);
      }
    },
  );
};
