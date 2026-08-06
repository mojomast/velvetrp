import { z } from "zod";
import { currencyCatalogReferenceSchema, itemCatalogReferenceSchema } from "./content-catalog.js";
import { utcIsoTimestampSchema } from "./domain-primitives.js";
import {
  currencyAmountSchema,
  exactTradeLineSchema,
  nonZeroCurrencyMinorUnitSchema,
  purchaseQuoteSchema,
  quoteIdSchema,
  shopIdSchema,
  shopStockSchema,
  tradeIdSchema,
  walletSchema,
} from "./economy.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema } from "./rpg-characters.js";

/** Actor and campaign identity come from the wallet route. */
export const economyHttpWalletGetResponseSchema = z.object({
  wallet: walletSchema,
  revision: revisionSchema,
}).strict();

const currencyKey = (currency: z.infer<typeof currencyCatalogReferenceSchema>) =>
  `${currency.packId}\0${currency.packVersion}\0${currency.definitionId}`;

/** Campaign and shop identity come from the shop route. */
export const economyHttpShopGetResponseSchema = z.object({
  shop: z.object({ name: z.string().trim().min(1).max(200) }).strict(),
  stock: z.array(shopStockSchema).max(1_000),
  currencies: z.array(currencyCatalogReferenceSchema).max(64),
}).strict().superRefine((shop, context) => {
  const currencies = new Set<string>();
  shop.currencies.forEach((currency, index) => {
    const key = currencyKey(currency);
    if (currencies.has(key)) context.addIssue({ code: "custom", message: "shop currencies must be unique", path: ["currencies", index] });
    currencies.add(key);
  });
  const stockItems = new Set<string>();
  shop.stock.forEach((line, index) => {
    const item = `${line.item.packId}\0${line.item.packVersion}\0${line.item.definitionId}`;
    if (stockItems.has(item)) context.addIssue({ code: "custom", message: "shop stock items must be unique", path: ["stock", index, "item"] });
    stockItems.add(item);
    if (!currencies.has(currencyKey(line.unitPrice.currency))) {
      context.addIssue({ code: "custom", message: "shop stock currency must be listed", path: ["stock", index, "unitPrice", "currency"] });
    }
  });
});

const commandBase = {
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
};

export const economyHttpQuoteCommandRequestSchema = z.object({
  type: z.literal("request_purchase_quote"),
  shopId: shopIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: purchaseQuoteSchema.shape.quantity,
  ...commandBase,
}).strict();

export const economyHttpPurchaseCommandRequestSchema = z.object({
  type: z.literal("purchase_from_shop"),
  quoteId: quoteIdSchema,
  ...commandBase,
}).strict();

const tradeCurrencySchema = z.object({
  currency: currencyCatalogReferenceSchema,
  minorUnits: nonZeroCurrencyMinorUnitSchema,
}).strict();
const tradeSideSchema = z.object({
  items: z.array(exactTradeLineSchema).max(128),
  currency: z.array(tradeCurrencySchema).max(64),
}).strict().superRefine((side, context) => {
  if (side.items.length === 0 && side.currency.length === 0) {
    context.addIssue({ code: "custom", message: "trade side must contain an asset" });
  }
  const entries = new Set<string>();
  side.items.forEach((line, index) => {
    if (entries.has(line.entryId)) context.addIssue({ code: "custom", message: "trade inventory entries must be unique", path: ["items", index, "entryId"] });
    entries.add(line.entryId);
  });
  const currencies = new Set<string>();
  side.currency.forEach((amount, index) => {
    const key = currencyKey(amount.currency);
    if (currencies.has(key)) context.addIssue({ code: "custom", message: "trade currencies must be unique", path: ["currency", index, "currency"] });
    currencies.add(key);
  });
});

/** A trade is always initiated by the actor named in the route and uses exact inventory selections. */
export const economyHttpTradeCommandRequestSchema = z.object({
  type: z.literal("propose_bilateral_trade"),
  tradeId: tradeIdSchema,
  recipientActorId: actorIdSchema,
  offered: tradeSideSchema,
  requested: tradeSideSchema,
  ...commandBase,
}).strict();

/** The HTTP vocabulary intentionally has one canonical quote, purchase, and trade command each. */
export const economyHttpCommandRequestSchema = z.discriminatedUnion("type", [
  economyHttpQuoteCommandRequestSchema,
  economyHttpPurchaseCommandRequestSchema,
  economyHttpTradeCommandRequestSchema,
]);

export const economyHttpQuoteResultSchema = z.object({
  quoteId: quoteIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: purchaseQuoteSchema.shape.quantity,
  total: currencyAmountSchema,
  expiresAt: utcIsoTimestampSchema,
}).strict();
export const economyHttpPurchaseResultSchema = z.object({
  purchaseId: z.string().min(1).max(128),
  quoteId: quoteIdSchema,
  quantity: purchaseQuoteSchema.shape.quantity,
  total: currencyAmountSchema,
  purchasedAt: utcIsoTimestampSchema,
}).strict();
export const economyHttpTradeResultSchema = z.object({
  tradeId: tradeIdSchema,
  status: z.literal("open"),
}).strict();

const receiptBase = {
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
};
const receiptRevision = (receipt: { revisionBefore: number; revisionAfter: number }) => receipt.revisionAfter === receipt.revisionBefore + 1;
export const economyHttpQuoteCommandReceiptSchema = z.object({ type: z.literal("request_purchase_quote"), ...receiptBase }).strict().refine(receiptRevision, "economy command advances exactly one revision");
export const economyHttpPurchaseCommandReceiptSchema = z.object({ type: z.literal("purchase_from_shop"), ...receiptBase }).strict().refine(receiptRevision, "economy command advances exactly one revision");
export const economyHttpTradeCommandReceiptSchema = z.object({ type: z.literal("propose_bilateral_trade"), ...receiptBase }).strict().refine(receiptRevision, "economy command advances exactly one revision");
export const economyHttpCommandReceiptSchema = z.discriminatedUnion("type", [
  economyHttpQuoteCommandReceiptSchema,
  economyHttpPurchaseCommandReceiptSchema,
  economyHttpTradeCommandReceiptSchema,
]);

/** Each envelope has one canonical result and its matching receipt, never optional result fields. */
export const economyHttpCommandResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("request_purchase_quote"), quote: economyHttpQuoteResultSchema, receipt: economyHttpQuoteCommandReceiptSchema }).strict(),
  z.object({ type: z.literal("purchase_from_shop"), purchase: economyHttpPurchaseResultSchema, receipt: economyHttpPurchaseCommandReceiptSchema }).strict(),
  z.object({ type: z.literal("propose_bilateral_trade"), trade: economyHttpTradeResultSchema, receipt: economyHttpTradeCommandReceiptSchema }).strict(),
]);

export type EconomyHttpWalletGetResponse = z.infer<typeof economyHttpWalletGetResponseSchema>;
export type EconomyHttpShopGetResponse = z.infer<typeof economyHttpShopGetResponseSchema>;
export type EconomyHttpCommandRequest = z.infer<typeof economyHttpCommandRequestSchema>;
export type EconomyHttpCommandReceipt = z.infer<typeof economyHttpCommandReceiptSchema>;
export type EconomyHttpCommandResponse = z.infer<typeof economyHttpCommandResponseSchema>;
