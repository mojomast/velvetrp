import { useState } from "react";
import type { EconomyHttpCommandRequest, EconomyHttpCommandResponse, EconomyHttpShopGetResponse, EconomyHttpWalletGetResponse } from "@velvet/contracts";
import { ApiError, type FreeformShopHttpRequest, type FreeformShopHttpResponse, type FreeformShopNoneReason } from "../../../api";
import { ShopBrowser } from "../actor/ShopBrowser";
import { createClientId } from "../../../utils/clientId";

/** Narrow transport surface the panel needs; every method is the strict API wrapper. */
export interface MerchantVisitApi {
  visitMerchant: (campaignId: string, sessionId: string, actorId: string, input: FreeformShopHttpRequest) => Promise<FreeformShopHttpResponse>;
  getShop: (campaignId: string, shopId: string) => Promise<EconomyHttpShopGetResponse>;
  getWallet: (campaignId: string, actorId: string) => Promise<EconomyHttpWalletGetResponse>;
  economyCommand: (campaignId: string, actorId: string, input: EconomyHttpCommandRequest) => Promise<EconomyHttpCommandResponse>;
}

export interface MerchantVisitPanelProps {
  campaignId: string;
  sessionId: string;
  /** The actor the visit is bound to: the GM's selected actor, or a controller's own actor. */
  actorId: string | null;
  /** Present cast members; the server decides which are merchants. */
  merchants: readonly { npcId: string; name: string }[];
  disabled?: boolean;
  api: MerchantVisitApi;
}

type Phase = "idle" | "visiting" | "ready" | "declined";
type Notice = { kind: "status" | "error"; text: string };

const economyKey = (kind: string) => `ui-merchant-${kind}-${createClientId()}`;

const declineText: Record<FreeformShopNoneReason, string> = {
  "no-merchant": "That present NPC is not a known merchant in this campaign. No shop was created.",
  "merchant-not-public": "That merchant has no public identity, so no public shop can be stocked. No shop was created.",
  "shop-already-exists": "A closed shop already exists for that merchant. There is no new stock to materialize; nothing was changed.",
  "no-compatible-item": "The campaign's pinned catalog offers no publicly reachable, priceable item for that merchant. No shop was created.",
};

function failureNotice(error: unknown, operation: "visit" | "quote" | "purchase"): Notice {
  if (error instanceof ApiError) {
    if (error.status >= 500) return { kind: "error", text: `The ${operation} outcome may be unknown. It will not be retried; reconcile authoritative state before continuing.` };
    if (error.status === 409) return { kind: "error", text: `The ${operation} conflicts with current campaign state (stock, funds, revision, or expiry). Nothing was retried; refresh before trying again.` };
    if (error.status === 400) return { kind: "error", text: `The ${operation} was rejected before dispatch. Nothing was changed.` };
    if (error.status === 403 || error.status === 404) return { kind: "error", text: `The ${operation} is unavailable with your current access or exact identifiers. Nothing was changed.` };
  }
  return { kind: "error", text: `The ${operation} could not be completed. Nothing was retried.` };
}

/**
 * Explicit GM/controller action that asks the server to build or bind one closed,
 * catalog-bound shop for a chosen present NPC. It calls the free-form shop command
 * exactly once per click, then reads back the canonical shop projection so the
 * existing `ShopBrowser` can surface stock and prices and route a purchase through
 * the existing economy command. Nothing here fires on mount or navigation, and no
 * write is ever retried automatically.
 */
export function MerchantVisitPanel({ campaignId, sessionId, actorId, merchants, disabled = false, api }: MerchantVisitPanelProps) {
  const [selected, setSelected] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [shopId, setShopId] = useState("");
  const [shop, setShop] = useState<EconomyHttpShopGetResponse | null>(null);
  const [wallet, setWallet] = useState<EconomyHttpWalletGetResponse | null>(null);
  const [quote, setQuote] = useState<Extract<EconomyHttpCommandResponse, { type: "request_purchase_quote" }>["quote"] | null>(null);

  const blocked = disabled || !actorId || busy;

  async function visit() {
    if (blocked || !actorId || !selected) return;
    setBusy(true); setNotice(null); setShop(null); setWallet(null); setQuote(null); setShopId(""); setPhase("visiting");
    try {
      const response = await api.visitMerchant(campaignId, sessionId, actorId, { merchantNpcId: selected });
      const materialization = response.materialization;
      if (materialization?.status !== "materialized") {
        const reason = materialization?.reason ?? (response.classification.intent === "none" ? response.classification.reason : "no-compatible-item");
        setPhase("declined"); setNotice({ kind: "status", text: declineText[reason] });
        return;
      }
      // Read the canonical shop projection: stock, quantities and exact pinned
      // price currencies all come from the server, never from this client.
      const [nextWallet, nextShop] = await Promise.all([
        api.getWallet(campaignId, actorId),
        api.getShop(campaignId, materialization.shopId),
      ]);
      setWallet(nextWallet); setShop(nextShop); setShopId(materialization.shopId); setPhase("ready");
      setNotice({ kind: "status", text: `${nextShop.shop.name} stocked from the server. Prices and quantities are authoritative; request a server quote before purchasing.` });
    } catch (error) {
      setPhase("declined"); setNotice(failureNotice(error, "visit"));
    } finally {
      setBusy(false);
    }
  }

  async function quoteItem(id: string, item: EconomyHttpShopGetResponse["stock"][number]["item"], quantity: number) {
    if (blocked || !actorId || !wallet) return;
    setBusy(true); setNotice(null);
    try {
      const response = await api.economyCommand(campaignId, actorId, {
        type: "request_purchase_quote", shopId: id, item, quantity,
        expectedRevision: wallet.revision, idempotencyKey: economyKey("quote"),
      });
      if (response.type !== "request_purchase_quote") throw new Error("Unexpected economy response");
      setQuote(response.quote);
      setNotice({ kind: "status", text: "Server quote received. Confirm the exact total to purchase it once." });
      // A quote advances the actor revision; refresh it before a follow-up purchase.
      try { setWallet(await api.getWallet(campaignId, actorId)); } catch { /* the purchase re-reads state server-side */ }
    } catch (error) {
      setNotice(failureNotice(error, "quote"));
    } finally {
      setBusy(false);
    }
  }

  async function purchase(quoteId: string) {
    if (blocked || !actorId || !wallet) return;
    setBusy(true); setNotice(null);
    try {
      const response = await api.economyCommand(campaignId, actorId, {
        type: "purchase_from_shop", quoteId,
        expectedRevision: wallet.revision, idempotencyKey: economyKey("purchase"),
      });
      if (response.type !== "purchase_from_shop") throw new Error("Unexpected economy response");
      setQuote(null);
      setNotice({ kind: "status", text: "Purchase confirmed by the server. Authoritative stock and wallet are refreshing." });
      try {
        const [nextWallet, nextShop] = await Promise.all([api.getWallet(campaignId, actorId), api.getShop(campaignId, shopId)]);
        setWallet(nextWallet); setShop(nextShop);
      } catch { /* the confirmed response already settled the purchase */ }
    } catch (error) {
      setNotice(failureNotice(error, "purchase"));
    } finally {
      setBusy(false);
    }
  }

  const hasMerchants = merchants.length > 0;
  return <section className="actor-section merchant-visit" aria-labelledby="merchant-visit-heading">
    <div className="actor-section-heading"><h2 id="merchant-visit-heading">Visit a merchant</h2></div>
    <p className="actor-help">Choose a present NPC. The server decides whether that NPC is a public merchant and owns the closed stock, quantities, and prices.</p>
    <label className="field">Present NPC
      <select aria-label="Present NPC to visit" value={selected} onChange={(event) => { setSelected(event.target.value); setNotice(null); }}>
        <option value="">Choose a present NPC</option>
        {merchants.map((npc) => <option key={npc.npcId} value={npc.npcId}>{npc.name}</option>)}
      </select>
    </label>
    <button type="button" className="primary" disabled={blocked || !hasMerchants || !selected} onClick={() => void visit()}>
      {phase === "visiting" ? "Visiting merchant..." : "Visit merchant"}
    </button>
    {!hasMerchants && <p className="actor-help">No NPCs are present in this room to visit.</p>}
    {notice && <p role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>}
    {phase === "ready" && wallet && shop && <ShopBrowser
      wallet={wallet} shop={shop} shopId={shopId} quote={quote} currencies={new Map()} disabled={blocked} showKnownShopForm={false}
      itemLabel={(item) => item.definitionId}
      onLoadShop={() => undefined}
      onQuote={(id, item, quantity) => void quoteItem(id, item, quantity)}
      onPurchase={(id) => void purchase(id)} />}
  </section>;
}
