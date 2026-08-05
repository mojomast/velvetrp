import { z } from "zod";
import { currencyCatalogReferenceSchema, itemCatalogReferenceSchema } from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";
import { inventoryEntryIdSchema, inventoryQuantitySchema } from "./inventory.js";

export const currencyMinorUnitSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const nonZeroCurrencyMinorUnitSchema = currencyMinorUnitSchema.min(1);
export const shopIdSchema = resourceIdSchema;
export const quoteIdSchema = resourceIdSchema;
export const tradeIdSchema = resourceIdSchema;
export const ledgerEntryIdSchema = resourceIdSchema;

export const currencyAmountSchema = z.object({ currency: currencyCatalogReferenceSchema, minorUnits: currencyMinorUnitSchema }).strict();
export const walletBalanceSchema = z.object({ currency: currencyCatalogReferenceSchema, minorUnits: currencyMinorUnitSchema }).strict();
export const walletSchema = z.object({ balances: z.array(walletBalanceSchema).max(64) }).strict().superRefine((wallet, context) => {
  const keys = new Set<string>();
  wallet.balances.forEach((balance, index) => {
    const key = `${balance.currency.packId}\0${balance.currency.packVersion}\0${balance.currency.definitionId}`;
    if (keys.has(key)) context.addIssue({ code: "custom", message: "wallet currencies must be unique", path: ["balances", index, "currency"] });
    keys.add(key);
  });
});

/** A signed immutable accounting movement, always expressed in integer minor units. */
export const currencyLedgerEntrySchema = z.object({
  ledgerEntryId: ledgerEntryIdSchema,
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  currency: currencyCatalogReferenceSchema,
  deltaMinorUnits: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine((value) => value !== 0),
  occurredAt: utcIsoTimestampSchema,
  revision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const shopStockSchema = z.object({ item: itemCatalogReferenceSchema, quantity: z.number().int().min(0).max(1_000_000), unitPrice: currencyAmountSchema }).strict();
export const shopSchema = z.object({ shopId: shopIdSchema, campaignId: campaignIdSchema, name: z.string().trim().min(1).max(200), stock: z.array(shopStockSchema).max(1_000) }).strict().superRefine((shop, context) => {
  const keys = new Set<string>();
  shop.stock.forEach((stock, index) => {
    const key = `${stock.item.packId}\0${stock.item.packVersion}\0${stock.item.definitionId}`;
    if (keys.has(key)) context.addIssue({ code: "custom", message: "shop stock items must be unique", path: ["stock", index, "item"] });
    keys.add(key);
  });
});

export const purchaseQuoteSchema = z.object({
  quoteId: quoteIdSchema,
  campaignId: campaignIdSchema,
  shopId: shopIdSchema,
  buyerActorId: actorIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: z.number().int().min(1).max(1_000_000),
  total: currencyAmountSchema,
  expiresAt: utcIsoTimestampSchema,
}).strict();

export const purchaseReceiptSchema = z.object({
  purchaseId: resourceIdSchema,
  quoteId: quoteIdSchema,
  campaignId: campaignIdSchema,
  shopId: shopIdSchema,
  buyerActorId: actorIdSchema,
  quantity: z.number().int().min(1).max(1_000_000),
  total: currencyAmountSchema,
  purchasedAt: utcIsoTimestampSchema,
  revisionBefore: expectedRevisionSchema,
  revisionAfter: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1, { message: "purchase revision must advance exactly once", path: ["revisionAfter"] });

/**
 * An exact stack selection.  `entryId` makes the source stack unambiguous,
 * while `quantity` retains normal partial-stack transfer semantics.
 */
export const stackableTradeLineSchema = z.object({
  kind: z.literal("stackable"),
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
}).strict();

/** An instanced item is selected by its durable inventory-entry identity. */
export const instancedTradeLineSchema = z.object({
  kind: z.literal("instanced"),
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
}).strict();

/** Strict, exact inventory selections for new trade proposals. */
export const exactTradeLineSchema = z.discriminatedUnion("kind", [stackableTradeLineSchema, instancedTradeLineSchema]);

/**
 * M1.5's already-written repository temporarily consumes catalog-only stack
 * lines. Keep that narrow wire shape readable until that repository adopts
 * exact selections; new callers should use `exactTradeLineSchema`.
 */
export const legacyStackTradeLineSchema = z.object({
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
}).strict();

/**
 * Compatibility accepts only the old, untagged stack line. All tagged lines
 * are exact and discriminated, so an instance can never be mistaken for a
 * fungible quantity.
 */
export const tradeLineSchema = z.union([exactTradeLineSchema, legacyStackTradeLineSchema]);
export const tradeCurrencyAmountSchema = z.object({
  currency: currencyCatalogReferenceSchema,
  minorUnits: nonZeroCurrencyMinorUnitSchema,
}).strict();

const catalogItemKey = (item: z.infer<typeof itemCatalogReferenceSchema>) => `${item.packId}\0${item.packVersion}\0${item.definitionId}`;
const currencyKey = (currency: z.infer<typeof currencyCatalogReferenceSchema>) => `${currency.packId}\0${currency.packVersion}\0${currency.definitionId}`;

function addTradeSideIssues(
  lines: z.infer<typeof tradeLineSchema>[],
  currency: z.infer<typeof tradeCurrencyAmountSchema>[],
  side: "offered" | "requested",
  context: z.RefinementCtx,
): void {
  if (lines.length === 0 && currency.length === 0) {
    context.addIssue({ code: "custom", message: `${side} side must contain an asset`, path: [`${side}Items`] });
  }

  const entryIds = new Set<string>();
  const legacyItemKeys = new Set<string>();
  const exactItemKeys = new Set<string>();
  lines.forEach((line, index) => {
    const itemKey = catalogItemKey(line.item);
    if ("kind" in line) {
      if (entryIds.has(line.entryId)) context.addIssue({ code: "custom", message: `${side} inventory entries must be unique`, path: [`${side}Items`, index, "entryId"] });
      entryIds.add(line.entryId);
      exactItemKeys.add(itemKey);
    } else {
      if (legacyItemKeys.has(itemKey)) context.addIssue({ code: "custom", message: `${side} legacy stack items must be unique`, path: [`${side}Items`, index, "item"] });
      legacyItemKeys.add(itemKey);
    }
  });
  legacyItemKeys.forEach((itemKey) => {
    if (exactItemKeys.has(itemKey)) context.addIssue({ code: "custom", message: `${side} legacy and exact selections cannot target the same item`, path: [`${side}Items`] });
  });

  const currencies = new Set<string>();
  currency.forEach((amount, index) => {
    const key = currencyKey(amount.currency);
    if (currencies.has(key)) context.addIssue({ code: "custom", message: `${side} currencies must be unique`, path: [`${side}Currency`, index, "currency"] });
    currencies.add(key);
  });
}

export const bilateralTradeSchema = z.object({
  tradeId: tradeIdSchema, campaignId: campaignIdSchema, offeredByActorId: actorIdSchema, acceptedByActorId: actorIdSchema,
  offeredItems: z.array(tradeLineSchema).max(128), offeredCurrency: z.array(tradeCurrencyAmountSchema).max(64),
  requestedItems: z.array(tradeLineSchema).max(128), requestedCurrency: z.array(tradeCurrencyAmountSchema).max(64),
}).strict().superRefine((trade, context) => {
  if (trade.offeredByActorId === trade.acceptedByActorId) context.addIssue({ code: "custom", message: "trade parties must differ", path: ["acceptedByActorId"] });
  addTradeSideIssues(trade.offeredItems, trade.offeredCurrency, "offered", context);
  addTradeSideIssues(trade.requestedItems, trade.requestedCurrency, "requested", context);
});

const economyCommandBase = { campaignId: campaignIdSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema };
export const requestPurchaseQuoteCommandSchema = z.object({ ...economyCommandBase, type: z.literal("request_purchase_quote"), shopId: shopIdSchema, buyerActorId: actorIdSchema, item: itemCatalogReferenceSchema, quantity: z.number().int().min(1).max(1_000_000) }).strict();
export const purchaseFromShopCommandSchema = z.object({ ...economyCommandBase, type: z.literal("purchase_from_shop"), quoteId: quoteIdSchema, buyerActorId: actorIdSchema }).strict();
export const proposeBilateralTradeCommandSchema = z.object({ ...economyCommandBase, type: z.literal("propose_bilateral_trade"), trade: bilateralTradeSchema }).strict();
export const acceptBilateralTradeCommandSchema = z.object({ ...economyCommandBase, type: z.literal("accept_bilateral_trade"), tradeId: tradeIdSchema, acceptedByActorId: actorIdSchema }).strict();
export const cancelBilateralTradeCommandSchema = z.object({ ...economyCommandBase, type: z.literal("cancel_bilateral_trade"), tradeId: tradeIdSchema, cancelledByActorId: actorIdSchema }).strict();
export const economyCommandSchema = z.discriminatedUnion("type", [requestPurchaseQuoteCommandSchema, purchaseFromShopCommandSchema, proposeBilateralTradeCommandSchema, acceptBilateralTradeCommandSchema, cancelBilateralTradeCommandSchema]);

export type Wallet = z.infer<typeof walletSchema>;
export type CurrencyLedgerEntry = z.infer<typeof currencyLedgerEntrySchema>;
export type Shop = z.infer<typeof shopSchema>;
export type PurchaseQuote = z.infer<typeof purchaseQuoteSchema>;
export type PurchaseReceipt = z.infer<typeof purchaseReceiptSchema>;
export type StackableTradeLine = z.infer<typeof stackableTradeLineSchema>;
export type InstancedTradeLine = z.infer<typeof instancedTradeLineSchema>;
export type ExactTradeLine = z.infer<typeof exactTradeLineSchema>;
export type LegacyStackTradeLine = z.infer<typeof legacyStackTradeLineSchema>;
export type TradeLine = z.infer<typeof tradeLineSchema>;
export type BilateralTrade = z.infer<typeof bilateralTradeSchema>;
export type CancelBilateralTradeCommand = z.infer<typeof cancelBilateralTradeCommandSchema>;
export type EconomyCommand = z.infer<typeof economyCommandSchema>;
