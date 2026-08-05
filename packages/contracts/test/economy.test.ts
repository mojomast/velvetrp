import { describe, expect, it } from "vitest";
import { bilateralTradeSchema, currencyLedgerEntrySchema, economyCommandSchema, exactTradeLineSchema, shopSchema, walletSchema } from "../src/economy.js";

const currency = { packId: "pack", packVersion: "1", definitionId: "gold", kind: "currency" } as const;
const item = { packId: "pack", packVersion: "1", definitionId: "potion", kind: "item" } as const;

describe("M1.5 economy contracts", () => {
  it("uses non-negative integer minor-unit wallet balances", () => {
    expect(walletSchema.safeParse({ balances: [{ currency, minorUnits: 123 }] }).success).toBe(true);
    expect(walletSchema.safeParse({ balances: [{ currency, minorUnits: 1.5 }] }).success).toBe(false);
    expect(walletSchema.safeParse({ balances: [{ currency, minorUnits: 1 }, { currency, minorUnits: 2 }] }).success).toBe(false);
  });

  it("models finite shop stock and signed ledger movements", () => {
    expect(shopSchema.safeParse({ shopId: "shop", campaignId: "campaign", name: "Shop", stock: [{ item, quantity: 0, unitPrice: { currency, minorUnits: 5 } }] }).success).toBe(true);
    expect(currencyLedgerEntrySchema.safeParse({ ledgerEntryId: "ledger", campaignId: "campaign", actorId: "actor", currency, deltaMinorUnits: -5, occurredAt: "2030-01-01T00:00:00.000Z", revision: 1, idempotencyKey: "ledger-1" }).success).toBe(true);
  });

  it("requires optimistic concurrency and idempotency for purchases", () => {
    const command = { type: "request_purchase_quote", campaignId: "campaign", expectedRevision: 1, idempotencyKey: "quote-1", shopId: "shop", buyerActorId: "actor", item, quantity: 1 };
    expect(economyCommandSchema.safeParse(command).success).toBe(true);
    expect(economyCommandSchema.safeParse({ ...command, expectedRevision: undefined }).success).toBe(false);
  });

  it("supports strict bilateral-trade cancellation", () => {
    const command = { type: "cancel_bilateral_trade", campaignId: "campaign", expectedRevision: 2, idempotencyKey: "trade-cancel-1", tradeId: "trade", cancelledByActorId: "actor" };
    expect(economyCommandSchema.parse(command)).toEqual(command);
    expect(economyCommandSchema.safeParse({ ...command, extra: true }).success).toBe(false);
    expect(economyCommandSchema.safeParse({ ...command, idempotencyKey: undefined }).success).toBe(false);
  });

  it("selects instanced items by entry identity and stacks by entry quantity", () => {
    const instance = { kind: "instanced", entryId: "sword-1", item } as const;
    const stack = { kind: "stackable", entryId: "potion-stack", item, quantity: 2 } as const;
    expect(exactTradeLineSchema.parse(instance)).toEqual(instance);
    expect(exactTradeLineSchema.parse(stack)).toEqual(stack);
    expect(exactTradeLineSchema.safeParse({ ...instance, quantity: 1 }).success).toBe(false);
    expect(exactTradeLineSchema.safeParse({ ...stack, quantity: 0 }).success).toBe(false);
  });

  it("rejects ambiguous and malformed bilateral trade selections", () => {
    const trade = {
      tradeId: "trade", campaignId: "campaign", offeredByActorId: "actor", acceptedByActorId: "recipient",
      offeredItems: [{ kind: "instanced", entryId: "sword-1", item }], offeredCurrency: [],
      requestedItems: [], requestedCurrency: [{ currency, minorUnits: 2 }],
    } as const;
    expect(bilateralTradeSchema.parse(trade)).toEqual(trade);
    expect(bilateralTradeSchema.safeParse({ ...trade, offeredItems: [{ kind: "stackable", entryId: "stack", item, quantity: 1 }, { kind: "instanced", entryId: "stack", item }] }).success).toBe(false);
    expect(bilateralTradeSchema.safeParse({ ...trade, offeredItems: [{ item, quantity: 1 }, { kind: "stackable", entryId: "stack", item, quantity: 1 }] }).success).toBe(false);
    expect(bilateralTradeSchema.safeParse({ ...trade, requestedCurrency: [{ currency, minorUnits: 0 }] }).success).toBe(false);
    expect(bilateralTradeSchema.safeParse({ ...trade, offeredItems: [], offeredCurrency: [] }).success).toBe(false);
  });

  it("keeps only the required legacy catalog-stack trade line compatible", () => {
    const legacyTrade = {
      tradeId: "legacy-trade", campaignId: "campaign", offeredByActorId: "actor", acceptedByActorId: "recipient",
      offeredItems: [{ item, quantity: 1 }], offeredCurrency: [],
      requestedItems: [], requestedCurrency: [{ currency, minorUnits: 1 }],
    } as const;
    expect(bilateralTradeSchema.parse(legacyTrade)).toEqual(legacyTrade);
    expect(bilateralTradeSchema.safeParse({ ...legacyTrade, offeredItems: [{ entryId: "untyped-entry", item, quantity: 1 }] }).success).toBe(false);
    expect(bilateralTradeSchema.safeParse({ ...legacyTrade, offeredItems: [{ kind: "instanced", entryId: "sword-1", item, extra: true }] }).success).toBe(false);
  });

  it("rejects unknown economy command variants", () => {
    expect(economyCommandSchema.safeParse({ type: "settle_bilateral_trade", campaignId: "campaign", expectedRevision: 2, idempotencyKey: "trade-1" }).success).toBe(false);
  });
});
