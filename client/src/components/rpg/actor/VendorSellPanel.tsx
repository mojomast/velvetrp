import type { InventoryHttpGetResponse, VendorSaleQuoteResponse } from "@velvet/contracts";
import { useState } from "react";

export interface VendorSellPanelProps {
  inventory: InventoryHttpGetResponse | null;
  disabled?: boolean;
  describeItem: (item: InventoryHttpGetResponse["entries"][number]["item"]) => { name: string };
  onRequestQuote: (entryId: string, quantity: number) => Promise<VendorSaleQuoteResponse | null>;
  onSell: (quoteId: string) => void;
}

/** Sells an exact inventory stack to a visible vendor that has a buy policy, using a server-issued quote. */
export function VendorSellPanel({ inventory, disabled = false, describeItem, onRequestQuote, onSell }: VendorSellPanelProps) {
  const [entryId, setEntryId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [quote, setQuote] = useState<VendorSaleQuoteResponse["quote"] | null>(null);
  const [requesting, setRequesting] = useState(false);
  const equipped = new Set((inventory?.equipment ?? []).map((item) => item.entryId));
  const sellable = (inventory?.entries ?? []).filter((entry) => !equipped.has(entry.entryId));
  const selected = sellable.find((entry) => entry.entryId === entryId) ?? null;
  const available = selected ? (selected.kind === "stackable" ? selected.quantity : 1) : 0;
  const parsed = Number(quantity);
  const valid = Boolean(selected) && Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= available;
  async function requestQuote() {
    if (!selected || !valid || requesting) return;
    setRequesting(true); setQuote(null);
    try { const value = await onRequestQuote(selected.entryId, parsed); if (value) setQuote(value.quote); }
    finally { setRequesting(false); }
  }
  return <section className="actor-section" aria-labelledby="vendor-sell-heading">
    <div className="actor-section-heading"><h2 id="vendor-sell-heading">Sell to a vendor</h2></div>
    <p className="actor-help">A vendor must be present at your location with a buy policy. The server issues an exact quote bound to the current inventory revision; selling then commits the sale.</p>
    {sellable.length === 0 ? <p className="actor-empty">Nothing sellable is in this actor's inventory.</p> : <div className="vendor-sell-form">
      <label className="field">Item<select value={entryId} disabled={disabled} onChange={(event) => { setEntryId(event.target.value); setQuote(null); }}><option value="">Choose an inventory entry</option>{sellable.map((entry) => <option key={entry.entryId} value={entry.entryId}>{describeItem(entry.item).name} ({entry.kind === "stackable" ? entry.quantity : 1}) — {entry.entryId}</option>)}</select></label>
      <label className="field">Quantity<input type="number" min={1} max={available || 1} value={quantity} disabled={disabled} onChange={(event) => { setQuantity(event.target.value); setQuote(null); }} /></label>
      <div className="button-row"><button className="ghost" type="button" disabled={disabled || !valid || requesting} onClick={() => void requestQuote()}>Request sale quote</button></div>
      {quote && <div className="vendor-sell-quote"><dl className="command-detail-list"><div><dt>Quote</dt><dd>{quote.quoteId}</dd></div><div><dt>Shop</dt><dd>{quote.shopId}</dd></div><div><dt>Quantity</dt><dd>{quote.quantity}</dd></div><div><dt>Payout</dt><dd>{quote.payout.minorUnits} {quote.payout.currency.definitionId}</dd></div><div><dt>Expires</dt><dd>{quote.expiresAt}</dd></div></dl><button className="primary" type="button" disabled={disabled} onClick={() => onSell(quote.quoteId)}>Sell once</button></div>}
    </div>}
  </section>;
}
