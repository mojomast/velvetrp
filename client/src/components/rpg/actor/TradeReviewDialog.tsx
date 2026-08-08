import { resourceIdSchema } from "@velvet/contracts";
import type { EconomyHttpCommandRequest, EconomyHttpWalletGetResponse, InventoryHttpGetResponse } from "@velvet/contracts";
import { useEffect, useRef, useState } from "react";
import { catalogReferenceKey, formatMinorUnits, type CurrencyPresentations } from "./ShopBrowser";

export type TradeIntent = Omit<Extract<EconomyHttpCommandRequest, { type: "propose_bilateral_trade" }>, "expectedRevision" | "idempotencyKey">;

export interface TradeReviewDialogProps {
  open: boolean;
  inventory: InventoryHttpGetResponse;
  wallet: EconomyHttpWalletGetResponse;
  currencies: CurrencyPresentations;
  disabled?: boolean;
  itemLabel: (item: InventoryHttpGetResponse["entries"][number]["item"]) => string;
  onClose: () => void;
  onSubmit: (command: TradeIntent) => void;
}

export function TradeReviewDialog({ open, inventory, wallet, currencies, disabled = false, itemLabel, onClose, onSubmit }: TradeReviewDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [recipient, setRecipient] = useState("");
  const [tradeId, setTradeId] = useState("");
  const [entryId, setEntryId] = useState(inventory.entries[0]?.entryId ?? "");
  const [currencyKey, setCurrencyKey] = useState(wallet.wallet.balances[0] ? catalogReferenceKey(wallet.wallet.balances[0].currency) : "");
  const [itemQuantity, setItemQuantity] = useState("1");
  const [minorUnits, setMinorUnits] = useState("1");
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) { restoreRef.current = document.activeElement as HTMLElement | null; dialog.showModal(); }
    if (!open) { if (dialog.open) dialog.close(); queueMicrotask(() => restoreRef.current?.focus()); }
  }, [open]);
  const close = () => { onClose(); };
  const selectedEntry = inventory.entries.find((entry) => entry.entryId === entryId);
  const selectedBalance = wallet.wallet.balances.find((balance) => catalogReferenceKey(balance.currency) === currencyKey);
  const quantity = /^\d+$/.test(itemQuantity) ? Number(itemQuantity) : 0;
  const requestedMinor = /^\d+$/.test(minorUnits) ? Number(minorUnits) : 0;
  const valid = Boolean(selectedEntry && selectedBalance && resourceIdSchema.safeParse(recipient).success && resourceIdSchema.safeParse(tradeId).success
    && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 1_000_000
    && Number.isSafeInteger(requestedMinor) && requestedMinor >= 1);
  const exactIntent: TradeIntent | null = selectedEntry && selectedBalance ? {
    type: "propose_bilateral_trade" as const, tradeId, recipientActorId: recipient,
    offered: { items: [selectedEntry.kind === "stackable"
      ? { kind: "stackable" as const, entryId: selectedEntry.entryId, item: selectedEntry.item, quantity }
      : { kind: "instanced" as const, entryId: selectedEntry.entryId, item: selectedEntry.item }], currency: [] },
    requested: { items: [], currency: [{ currency: selectedBalance.currency, minorUnits: requestedMinor }] },
  } : null;
  const exactSnapshot = exactIntent ? JSON.stringify({ command: exactIntent, expectedWalletRevision: wallet.revision, inventoryRevision: inventory.revision }) : null;
  const edit = (change: () => void) => { change(); setConfirmedSnapshot(null); };
  function submit() {
    if (!valid || !exactIntent || confirmedSnapshot !== exactSnapshot) return;
    onSubmit(exactIntent);
  }
  return <dialog ref={dialogRef} className="actor-dialog" onKeyDown={(event) => { if (event.key === "Escape" && !disabled) { event.preventDefault(); close(); } }} onCancel={(event) => { event.preventDefault(); if (!disabled) close(); }} onClose={() => { if (open) close(); }}>
    <div className="dialog-heading"><div><p className="eyebrow">EXACT BILATERAL PROPOSAL</p><h2>Review trade</h2></div><button className="ghost" type="button" disabled={disabled} onClick={close} aria-label="Close trade dialog">Close</button></div>
    {inventory.entries.length === 0 || wallet.wallet.balances.length === 0 ? <p role="alert">A trade needs an offered inventory entry and a requested wallet currency. No eligible editor can be composed from the available server state.</p> : <form method="dialog" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <label className="field">Trade ID<input value={tradeId} onChange={(event) => edit(() => setTradeId(event.target.value))} /></label>
      <label className="field">Recipient actor ID<input value={recipient} onChange={(event) => edit(() => setRecipient(event.target.value))} /></label>
      <label className="field">Exact offered entry<select value={entryId} onChange={(event) => edit(() => setEntryId(event.target.value))}>{inventory.entries.map((entry) => <option key={entry.entryId} value={entry.entryId}>{itemLabel(entry.item)}</option>)}</select></label>
      {selectedEntry?.kind === "stackable" && <label className="field">Offered quantity<input inputMode="numeric" value={itemQuantity} onChange={(event) => edit(() => setItemQuantity(event.target.value))} /></label>}
      <label className="field">Requested currency<select value={currencyKey} onChange={(event) => edit(() => setCurrencyKey(event.target.value))}>{wallet.wallet.balances.map((balance) => <option key={catalogReferenceKey(balance.currency)} value={catalogReferenceKey(balance.currency)}>{currencies.get(catalogReferenceKey(balance.currency))?.name ?? balance.currency.definitionId}</option>)}</select></label>
      <label className="field">Requested integer minor units<input inputMode="numeric" value={minorUnits} onChange={(event) => edit(() => setMinorUnits(event.target.value))} />{selectedBalance && <small>Wallet display: {formatMinorUnits(selectedBalance.minorUnits, selectedBalance.currency, currencies.get(catalogReferenceKey(selectedBalance.currency)))}</small>}</label>
      {exactIntent && <section className="command-review"><h3>Exact proposal snapshot</h3><dl className="command-detail-list"><div><dt>Trade</dt><dd>{exactIntent.tradeId}</dd></div><div><dt>Recipient</dt><dd>{exactIntent.recipientActorId}</dd></div><div><dt>Expected wallet revision</dt><dd>{wallet.revision}</dd></div><div><dt>Reviewed inventory revision</dt><dd>{inventory.revision}</dd></div>{exactIntent.offered.items.map((line) => <div key={`offer-${line.entryId}`}><dt>Offered line</dt><dd>{line.entryId} · {line.item.packId} @ {line.item.packVersion} / {line.item.definitionId}{line.kind === "stackable" ? ` · quantity ${line.quantity}` : " · instance"}</dd></div>)}{exactIntent.offered.currency.map((amount) => <div key={`offer-${catalogReferenceKey(amount.currency)}`}><dt>Offered currency</dt><dd>{amount.minorUnits} minor units · {catalogReferenceKey(amount.currency)}</dd></div>)}{exactIntent.requested.items.map((line) => <div key={`request-${line.entryId}`}><dt>Requested line</dt><dd>{line.entryId} · {line.item.definitionId}{line.kind === "stackable" ? ` · quantity ${line.quantity}` : " · instance"}</dd></div>)}{exactIntent.requested.currency.map((amount) => <div key={`request-${catalogReferenceKey(amount.currency)}`}><dt>Requested currency</dt><dd>{formatMinorUnits(amount.minorUnits, amount.currency, currencies.get(catalogReferenceKey(amount.currency)))} · {catalogReferenceKey(amount.currency)}</dd></div>)}</dl><p>The server will decide ownership, funds, binding, recipient, and trade eligibility. This creates an open proposal; it does not transfer assets now.</p><label className="actor-confirm"><input type="checkbox" checked={exactSnapshot !== null && confirmedSnapshot === exactSnapshot} onChange={(event) => setConfirmedSnapshot(event.target.checked ? exactSnapshot : null)} /> Confirm every exact party, line, quantity, and currency above</label></section>}
      <div className="dialog-actions"><button className="ghost" type="button" disabled={disabled} onClick={close}>Cancel</button><button className="primary" type="submit" disabled={disabled || !valid || exactSnapshot === null || confirmedSnapshot !== exactSnapshot}>Propose once</button></div>
    </form>}
  </dialog>;
}
