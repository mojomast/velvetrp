import { resourceIdSchema } from "@velvet/contracts";
import type { EconomyHttpCommandResponse, EconomyHttpShopGetResponse, EconomyHttpWalletGetResponse } from "@velvet/contracts";
import { useState } from "react";

type CurrencyReference = EconomyHttpWalletGetResponse["wallet"]["balances"][number]["currency"];
export interface CurrencyPresentation { name: string; symbol: string; minorPerMajor: number }
export type CurrencyPresentations = Map<string, CurrencyPresentation>;

export const catalogReferenceKey = (reference: { packId: string; packVersion: string; definitionId: string }) =>
  `${reference.packId}\0${reference.packVersion}\0${reference.definitionId}`;

/** Integer-only, lossless currency presentation. Non-decimal scales stay explicit. */
export function formatMinorUnits(minorUnits: number, currency: CurrencyReference, metadata?: CurrencyPresentation): string {
  if (!metadata) return `${minorUnits.toLocaleString("en-US", { useGrouping: true, maximumFractionDigits: 0 })} minor units (${currency.definitionId})`;
  const scale = BigInt(metadata.minorPerMajor);
  const amount = BigInt(minorUnits);
  let decimalPlaces = 0;
  let decimalScale = 1n;
  while (decimalScale < scale) { decimalScale *= 10n; decimalPlaces += 1; }
  if (decimalScale === scale) {
    const major = amount / scale;
    const remainder = (amount % scale).toString().padStart(decimalPlaces, "0");
    return `${metadata.symbol}${major.toString()}${decimalPlaces ? `.${remainder}` : ""} ${metadata.name}`;
  }
  return `${metadata.symbol}${(amount / scale).toString()} + ${(amount % scale).toString()}/${scale.toString()} ${metadata.name} (exact)`;
}

export interface ShopBrowserProps {
  wallet: EconomyHttpWalletGetResponse;
  shop: EconomyHttpShopGetResponse | null;
  shopId: string;
  quote: Extract<EconomyHttpCommandResponse, { type: "request_purchase_quote" }>["quote"] | null;
  currencies: CurrencyPresentations;
  disabled?: boolean;
  itemLabel: (item: EconomyHttpShopGetResponse["stock"][number]["item"]) => string;
  onLoadShop: (shopId: string) => void;
  onQuote: (shopId: string, item: EconomyHttpShopGetResponse["stock"][number]["item"], quantity: number) => void;
  onPurchase: (quoteId: string) => void;
}

export function ShopBrowser({ wallet, shop, shopId, quote, currencies, disabled = false, itemLabel, onLoadShop, onQuote, onPurchase }: ShopBrowserProps) {
  const [knownId, setKnownId] = useState(shopId);
  const [quantity, setQuantity] = useState("1");
  const [confirmed, setConfirmed] = useState(false);
  const parsedQuantity = /^\d+$/.test(quantity) ? Number(quantity) : 0;
  const legalQuantity = Number.isSafeInteger(parsedQuantity) && parsedQuantity >= 1 && parsedQuantity <= 1_000_000;
  return <section className="actor-section shop-browser" aria-labelledby="shop-heading">
    <div className="actor-section-heading"><h2 id="shop-heading">Wallet & shop</h2></div>
    {wallet.wallet.balances.length === 0 ? <p className="actor-empty">Wallet has no balances.</p> : <dl className="wallet-list">{wallet.wallet.balances.map((balance) => <div key={catalogReferenceKey(balance.currency)}><dt><bdi dir="auto">{currencies.get(catalogReferenceKey(balance.currency))?.name ?? balance.currency.definitionId}</bdi></dt><dd>{formatMinorUnits(balance.minorUnits, balance.currency, currencies.get(catalogReferenceKey(balance.currency)))}</dd></div>)}</dl>}
    <form className="known-shop-form" onSubmit={(event) => { event.preventDefault(); if (knownId) onLoadShop(knownId); }}>
      <label className="field">Known shop ID<input value={knownId} onChange={(event) => setKnownId(event.target.value)} autoComplete="off" /></label>
      <button className="ghost" type="submit" disabled={disabled || !resourceIdSchema.safeParse(knownId).success}>Open known shop</button>
      <p className="actor-help">There is no shop discovery endpoint. Enter an ID supplied by your campaign.</p>
    </form>
    {shop && <div className="shop-stock"><h3><bdi dir="auto">{shop.shop.name}</bdi></h3>
      <label className="field compact-quantity">Purchase quantity<input inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
      <ul>{shop.stock.map((line) => <li key={catalogReferenceKey(line.item)}>
        <div><strong><bdi dir="auto">{itemLabel(line.item)}</bdi></strong><span>{formatMinorUnits(line.unitPrice.minorUnits, line.unitPrice.currency, currencies.get(catalogReferenceKey(line.unitPrice.currency)))} each</span><span className="scarcity-notice" role="status" aria-live="polite">Server stock: {line.quantity} remaining</span></div>
        <button className="ghost" type="button" disabled={disabled || !legalQuantity} onClick={() => onQuote(shopId, line.item, parsedQuantity)}>Request server quote</button>
      </li>)}</ul>
    </div>}
    {quote && <section className="command-review" aria-labelledby="purchase-review-heading">
      <h3 id="purchase-review-heading">Server purchase quote</h3>
      <p><strong>{quote.quantity}</strong> × <bdi dir="auto">{itemLabel(quote.item)}</bdi></p>
      <p className="quote-total">Exact total: {formatMinorUnits(quote.total.minorUnits, quote.total.currency, currencies.get(catalogReferenceKey(quote.total.currency)))}</p>
      <p>Expires <time dateTime={quote.expiresAt}>{quote.expiresAt}</time>. The server will re-check funds, stock, expiry, and capacity.</p>
      <label className="actor-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm this exact server quote</label>
      <button className="primary" type="button" disabled={disabled || !confirmed} onClick={() => onPurchase(quote.quoteId)}>Purchase once</button>
    </section>}
  </section>;
}
