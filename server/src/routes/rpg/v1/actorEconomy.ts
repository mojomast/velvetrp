import {
  economyHttpCommandRequestSchema,
  economyHttpCommandResponseSchema,
  economyHttpShopGetResponseSchema,
  economyHttpWalletGetResponseSchema,
  resourceIdSchema,
  vendorSaleQuoteRequestSchema,
  vendorSaleQuoteResponseSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  ActorResourceAuthorizationError,
  ActorResourceConflictError,
  ActorResourceNegativeError,
  ActorResourceStaleError,
  EconomyAuthorizationError,
  EconomyConflictError,
  QuoteExpiredError,
  ShopStockExhaustedError,
  TradeStaleError,
  type AdventureCommerceRepository,
  type EconomyRepository,
} from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface ActorEconomyHttpOptions {
  economyRepositoryAccessor: () => Pick<EconomyRepository,
    "getActorEconomySnapshot" | "getShop" | "mutateEconomyForActor">
    & Pick<AdventureCommerceRepository, "requestVendorSaleQuote">;
}

function invalidQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0;
}

/** Projects the repository vendor-sale receipt to the public HTTP sale projection. */
function projectSale(sale: unknown) {
  const value = sale as { saleId: string; quoteId: string; disposition: string; quantity: number; total: unknown; soldAt: string };
  return { saleId: value.saleId, quoteId: value.quoteId, disposition: value.disposition, quantity: value.quantity, total: value.total, soldAt: value.soldAt };
}

function actorNotFound(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  // Authorization and absent actor state intentionally share one response.
  return sendApiProblem(request, reply, 404, "RPG_ACTOR_ECONOMY_NOT_FOUND", "Actor economy not found");
}

function shopNotFound(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) {
  // Campaign membership and absent shops intentionally share one response.
  return sendApiProblem(request, reply, 404, "RPG_SHOP_NOT_FOUND", "Shop not found");
}

function mapActorFailure(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof ActorResourceAuthorizationError || error instanceof EconomyAuthorizationError) return actorNotFound(request, reply);
  if (error instanceof ActorResourceStaleError || error instanceof TradeStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_ACTOR_ECONOMY_STALE", "Actor economy is stale; refresh before trying again");
  }
  if (error instanceof ActorResourceConflictError || error instanceof ActorResourceNegativeError
    || error instanceof EconomyConflictError || error instanceof QuoteExpiredError || error instanceof ShopStockExhaustedError) {
    return sendApiProblem(request, reply, 409, "RPG_ACTOR_ECONOMY_CONFLICT", "Actor economy command conflicts with current state");
  }
  request.log.error({ operation: "actor-economy", method: request.method, route: request.routeOptions.url, err: error }, "RPG actor economy operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Actor economy could not be loaded");
}

export const actorEconomyHttpRoutes: FastifyPluginAsync<ActorEconomyHttpOptions> = async (app, options) => {
  const guard = async (request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) => {
    reply.header("cache-control", "no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) {
      await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      return false;
    }
    if (invalidQuery(request)) {
      await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor economy does not accept query parameters");
      return false;
    }
    return true;
  };
  const shopGuard = async (request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) => {
    reply.header("cache-control", "no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) {
      await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      return false;
    }
    if (invalidQuery(request)) {
      await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Shop does not accept query parameters");
      return false;
    }
    return true;
  };

  app.get<{ Params: { campaignId: string; actorId: string }; Querystring: Record<string, unknown> }>(
    "/campaigns/:campaignId/actors/:actorId/wallet", { exposeHeadRoute: false }, async (request, reply) => {
      if (!(await guard(request, reply))) return;
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!campaignId.success || !actorId.success) return actorNotFound(request, reply);
      try {
        const snapshot = options.economyRepositoryAccessor().getActorEconomySnapshot(LOCAL_OWNER, campaignId.data, actorId.data);
        if (snapshot === null) return actorNotFound(request, reply);
        if (snapshot.campaignId !== campaignId.data || snapshot.actorId !== actorId.data) throw new Error("actor economy snapshot does not match request");
        return reply.code(200).send(economyHttpWalletGetResponseSchema.parse({ wallet: snapshot.wallet, revision: snapshot.revision }));
      } catch (error) {
        return mapActorFailure(request, reply, error);
      }
    },
  );

  app.get<{ Params: { campaignId: string; shopId: string }; Querystring: Record<string, unknown> }>(
    "/campaigns/:campaignId/shops/:shopId", { exposeHeadRoute: false }, async (request, reply) => {
      if (!(await shopGuard(request, reply))) return;
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const shopId = resourceIdSchema.safeParse(request.params.shopId);
      if (!campaignId.success || !shopId.success) return shopNotFound(request, reply);
      try {
        const shop = options.economyRepositoryAccessor().getShop(LOCAL_OWNER, campaignId.data, shopId.data);
        if (shop === null || shop.campaignId !== campaignId.data || shop.shopId !== shopId.data) return shopNotFound(request, reply);
        const currencies = [...new Map(shop.stock.map((line) => [
          `${line.unitPrice.currency.packId}\0${line.unitPrice.currency.packVersion}\0${line.unitPrice.currency.definitionId}`,
          line.unitPrice.currency,
        ])).values()];
        return reply.code(200).send(economyHttpShopGetResponseSchema.parse({
          shop: { name: shop.name }, stock: shop.stock, currencies,
        }));
      } catch (error) {
        request.log.error({ operation: "shop-read", method: request.method, route: request.routeOptions.url }, "RPG shop operation failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Shop could not be loaded");
      }
    },
  );

  app.post<{ Params: { campaignId: string; actorId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/actors/:actorId/economy-commands", {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!(await guard(request, reply))) return;
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Actor economy command requires application/json");
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor economy command request is invalid"),
    }, async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!campaignId.success || !actorId.success) return actorNotFound(request, reply);
      const body = economyHttpCommandRequestSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Actor economy command request is invalid");
      try {
        const command = body.data.type === "request_purchase_quote"
          ? { kind: body.data.type, shopId: body.data.shopId, item: body.data.item, quantity: body.data.quantity, expectedRevision: body.data.expectedRevision, idempotencyKey: body.data.idempotencyKey }
          : body.data.type === "purchase_from_shop"
            ? { kind: body.data.type, quoteId: body.data.quoteId, expectedRevision: body.data.expectedRevision, idempotencyKey: body.data.idempotencyKey }
            : body.data.type === "sell_to_shop"
              ? { kind: body.data.type, quoteId: body.data.quoteId, expectedRevision: body.data.expectedRevision, idempotencyKey: body.data.idempotencyKey }
              : body.data.type === "accept_bilateral_trade" || body.data.type === "cancel_bilateral_trade"
              ? { kind: body.data.type, tradeId: body.data.tradeId, expectedRevision: body.data.expectedRevision, idempotencyKey: body.data.idempotencyKey }
              : { kind: body.data.type, trade: { tradeId: body.data.tradeId, acceptedByActorId: body.data.recipientActorId, offeredItems: body.data.offered.items, offeredCurrency: body.data.offered.currency, requestedItems: body.data.requested.items, requestedCurrency: body.data.requested.currency }, expectedRevision: body.data.expectedRevision, idempotencyKey: body.data.idempotencyKey };
        const result = options.economyRepositoryAccessor().mutateEconomyForActor(LOCAL_OWNER, campaignId.data, actorId.data, command);
        const receipt = {
          type: body.data.type,
          idempotencyKey: result.receipt.idempotencyKey,
          revisionBefore: result.receipt.revisionBefore,
          revisionAfter: result.receipt.revisionAfter,
          occurredAt: result.receipt.occurredAt,
        };
        const response = body.data.type === "request_purchase_quote"
          ? { type: body.data.type, quote: result.quote, receipt }
          : body.data.type === "purchase_from_shop"
            ? { type: body.data.type, purchase: result.purchase, receipt }
            : body.data.type === "sell_to_shop"
              ? { type: body.data.type, sale: projectSale(result.sale), receipt }
              : { type: body.data.type, trade: result.trade, receipt };
        return reply.code(200).send(economyHttpCommandResponseSchema.parse(response));
      } catch (error) {
        return mapActorFailure(request, reply, error);
      }
    },
  );

  // Creates the exact vendor sale quote a player then sells against; the quote binds to the current inventory revision.
  app.post<{ Params: { campaignId: string; actorId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/actors/:actorId/vendor-sale-quotes", {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!(await guard(request, reply))) return;
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Vendor sale quote requires application/json");
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Vendor sale quote request is invalid"),
    }, async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const actorId = resourceIdSchema.safeParse(request.params.actorId);
      if (!campaignId.success || !actorId.success) return actorNotFound(request, reply);
      const body = vendorSaleQuoteRequestSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Vendor sale quote request is invalid");
      try {
        const quote = options.economyRepositoryAccessor().requestVendorSaleQuote(LOCAL_OWNER, campaignId.data, actorId.data, { entryId: body.data.entryId, quantity: body.data.quantity });
        if (!quote) return shopNotFound(request, reply);
        return reply.code(200).send(vendorSaleQuoteResponseSchema.parse({ quote }));
      } catch (error) {
        return mapActorFailure(request, reply, error);
      }
    },
  );
};
