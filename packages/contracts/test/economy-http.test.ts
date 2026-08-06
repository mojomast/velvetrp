import { describe, expect, it } from "vitest";
import {
  economyHttpCommandReceiptSchema,
  economyHttpCommandRequestSchema,
  economyHttpCommandResponseSchema,
  economyHttpShopGetResponseSchema,
  economyHttpWalletGetResponseSchema,
} from "../src/economy-http.js";

const currency = { kind: "currency", packId: "pack", packVersion: "1", definitionId: "gold" } as const;
const item = { kind: "item", packId: "pack", packVersion: "1", definitionId: "potion" } as const;
const base = { expectedRevision: 4, idempotencyKey: "economy-command-1" };

describe("economy HTTP contracts", () => {
  it("returns route-owned wallet and shop projections", () => {
    const wallet = { wallet: { balances: [{ currency, minorUnits: 10 }] }, revision: 4 };
    const shop = { shop: { name: "Lamplighter" }, stock: [{ item, quantity: 3, unitPrice: { currency, minorUnits: 5 } }], currencies: [currency] };
    expect(economyHttpWalletGetResponseSchema.parse(wallet)).toEqual(wallet);
    expect(economyHttpShopGetResponseSchema.parse(shop)).toEqual(shop);
    expect(economyHttpWalletGetResponseSchema.safeParse({ ...wallet, actorId: "private" }).success).toBe(false);
    expect(economyHttpShopGetResponseSchema.safeParse({ ...shop, campaignId: "private" }).success).toBe(false);
    expect(economyHttpShopGetResponseSchema.safeParse({ ...shop, currencies: [] }).success).toBe(false);
  });

  it("accepts only actor-bound canonical quote, purchase, and exact trade commands", () => {
    const requests = [
      { type: "request_purchase_quote", shopId: "shop", item, quantity: 1, ...base },
      { type: "purchase_from_shop", quoteId: "quote", ...base },
      { type: "propose_bilateral_trade", tradeId: "trade", recipientActorId: "recipient", offered: { items: [{ kind: "stackable", entryId: "potion-stack", item, quantity: 1 }], currency: [] }, requested: { items: [], currency: [{ currency, minorUnits: 2 }] }, ...base },
    ] as const;
    for (const request of requests) expect(economyHttpCommandRequestSchema.parse(request)).toEqual(request);
    expect(economyHttpCommandRequestSchema.safeParse({ ...requests[0], buyerActorId: "private" }).success).toBe(false);
    expect(economyHttpCommandRequestSchema.safeParse({ ...requests[2], offeredByActorId: "private" }).success).toBe(false);
    expect(economyHttpCommandRequestSchema.safeParse({ ...requests[2], offered: { items: [{ item, quantity: 1 }], currency: [] } }).success).toBe(false);
    expect(economyHttpCommandRequestSchema.safeParse({ ...base, type: "accept_bilateral_trade" }).success).toBe(false);
  });

  it("returns exactly one matching result and a redacted revision-advancing receipt", () => {
    const receipt = { type: "purchase_from_shop" as const, idempotencyKey: base.idempotencyKey, revisionBefore: 4, revisionAfter: 5, occurredAt: "2030-01-01T00:00:00.000Z" };
    const response = { type: "purchase_from_shop" as const, purchase: { purchaseId: "purchase", quoteId: "quote", quantity: 1, total: { currency, minorUnits: 5 }, purchasedAt: "2030-01-01T00:00:00.000Z" }, receipt };
    expect(economyHttpCommandReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(economyHttpCommandResponseSchema.parse(response)).toEqual(response);
    expect(economyHttpCommandResponseSchema.safeParse({ ...response, quote: {} }).success).toBe(false);
    expect(economyHttpCommandReceiptSchema.safeParse({ ...receipt, actorId: "private" }).success).toBe(false);
    expect(economyHttpCommandReceiptSchema.safeParse({ ...receipt, revisionAfter: 6 }).success).toBe(false);
  });
});
