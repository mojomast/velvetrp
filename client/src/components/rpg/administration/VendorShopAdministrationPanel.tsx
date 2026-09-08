import { useEffect, useState } from "react";
import { canAdminister, type AdministrationMutationState, type AdministrationRole } from "./types";

export interface VendorNpcOption { npcId: string; name: string }
export interface VendorShopOption {
  shopId: string;
  name: string;
  stock: Array<{ stockId: string; label: string }>;
}
export interface VendorShopAssociation { npcId: string; shopId: string; revision: number }
export interface VendorBuyPolicy { shopId: string; stockId: string; payoutUnitMinor: number; revision: number }
export interface AssociateVendorInput { npcId: string; shopId: string; expectedRevision: number }
export interface ConfigureBuyPolicyInput { shopId: string; stockId: string; payoutUnitMinor: number; expectedRevision: number }

export interface VendorShopAdministrationApi {
  associateVendor: (input: AssociateVendorInput) => void;
  configureBuyPolicy: (input: ConfigureBuyPolicyInput) => void;
  reconcileAssociation: (npcId: string) => void;
  reconcileBuyPolicy: (shopId: string, stockId: string) => void;
}

export interface VendorShopAdministrationPanelProps {
  actorRole: AdministrationRole;
  campaignRevision: number;
  npcs: VendorNpcOption[];
  shops: VendorShopOption[];
  associations: VendorShopAssociation[];
  buyPolicies: VendorBuyPolicy[];
  associationMutation?: AdministrationMutationState;
  policyMutation?: AdministrationMutationState;
  disabled?: boolean;
  api: VendorShopAdministrationApi;
}

export function VendorShopAdministrationPanel({ actorRole, campaignRevision, npcs, shops, associations, buyPolicies, associationMutation = { phase: "idle" }, policyMutation = { phase: "idle" }, disabled = false, api }: VendorShopAdministrationPanelProps) {
  const [npcId, setNpcId] = useState(npcs[0]?.npcId ?? "");
  const [shopId, setShopId] = useState(shops[0]?.shopId ?? "");
  const [stockId, setStockId] = useState(shops[0]?.stock[0]?.stockId ?? "");
  const [payout, setPayout] = useState("0");
  const [associationReview, setAssociationReview] = useState(false);
  const [policyReview, setPolicyReview] = useState(false);
  const [associationConfirmed, setAssociationConfirmed] = useState(false);
  const [policyConfirmed, setPolicyConfirmed] = useState(false);
  const mutable = canAdminister(actorRole);
  const locked = disabled || associationMutation.phase !== "idle" || policyMutation.phase !== "idle";
  const selectedNpc = npcs.find((npc) => npc.npcId === npcId);
  const selectedShop = shops.find((shop) => shop.shopId === shopId);
  const selectedStock = selectedShop?.stock.find((stock) => stock.stockId === stockId);
  const currentAssociation = associations.find((association) => association.npcId === npcId);
  const currentPolicy = buyPolicies.find((policy) => policy.shopId === shopId && policy.stockId === stockId);
  const payoutMinor = /^\d+$/.test(payout) ? Number(payout) : -1;
  const validPayout = Number.isSafeInteger(payoutMinor) && payoutMinor >= 0;

  useEffect(() => {
    const nextShop = shops.find((shop) => shop.shopId === shopId) ?? shops[0];
    if (nextShop && !nextShop.stock.some((stock) => stock.stockId === stockId)) setStockId(nextShop.stock[0]?.stockId ?? "");
  }, [shopId, shops, stockId]);

  const resetAssociationReview = () => { setAssociationReview(false); setAssociationConfirmed(false); };
  const resetPolicyReview = () => { setPolicyReview(false); setPolicyConfirmed(false); };

  return <section className="admin-section" aria-labelledby="vendor-shop-heading">
    <div className="admin-section-heading"><div><p className="eyebrow">EXACT CAMPAIGN ASSOCIATIONS</p><h2 id="vendor-shop-heading">Vendors and shop buy policies</h2></div><span className="status-pill">{actorRole} view</span></div>
    <p className="builder-help">Associate existing campaign records and review the exact stock payout policy. No inventory, vendor, or pricing record is created automatically.</p>
    {!mutable && <p className="content-warning">Only campaign owners and GMs can change vendor administration.</p>}

    <fieldset disabled={!mutable || locked || npcs.length === 0 || shops.length === 0}>
      <legend>Vendor association</legend>
      <label className="field"><span>NPC</span><select value={npcId} onChange={(event) => { setNpcId(event.target.value); resetAssociationReview(); }}>{npcs.map((npc) => <option key={npc.npcId} value={npc.npcId}>{npc.name}</option>)}</select></label>
      <label className="field"><span>Shop</span><select value={shopId} onChange={(event) => { setShopId(event.target.value); resetAssociationReview(); resetPolicyReview(); }}>{shops.map((shop) => <option key={shop.shopId} value={shop.shopId}>{shop.name}</option>)}</select></label>
      {currentAssociation && <p>Current association: <code>{currentAssociation.shopId}</code> at revision {currentAssociation.revision}.</p>}
      <button type="button" disabled={!npcId || !shopId || currentAssociation?.shopId === shopId} onClick={() => { setAssociationReview(true); setAssociationConfirmed(false); }}>Review association</button>
    </fieldset>
    {associationReview && selectedNpc && selectedShop && <section className="command-review" aria-labelledby="vendor-association-review-heading"><h3 id="vendor-association-review-heading">Review vendor association</h3><dl className="command-detail-list"><div><dt>NPC</dt><dd>{selectedNpc.name} · {selectedNpc.npcId}</dd></div><div><dt>Shop</dt><dd>{selectedShop.name} · {selectedShop.shopId}</dd></div><div><dt>Expected campaign revision</dt><dd>{campaignRevision}</dd></div>{currentAssociation && <div><dt>Replaces shop</dt><dd>{currentAssociation.shopId}</dd></div>}</dl>{currentAssociation && currentAssociation.shopId !== shopId && <p className="content-warning" role="alert">This NPC is already associated with another shop. The server must reject or explicitly reconcile a conflicting reassociation.</p>}<label className="checkbox"><input type="checkbox" checked={associationConfirmed} onChange={(event) => setAssociationConfirmed(event.target.checked)} /> Confirm this exact NPC-to-shop association</label><button className="primary" type="button" disabled={locked || !associationConfirmed} onClick={() => api.associateVendor({ npcId, shopId, expectedRevision: campaignRevision })}>Associate vendor once</button></section>}

    <fieldset disabled={!mutable || locked || shops.length === 0}>
      <legend>Shop purchase policy</legend>
      <label className="field"><span>Stock item</span><select value={stockId} onChange={(event) => { setStockId(event.target.value); resetPolicyReview(); }}>{selectedShop?.stock.map((stock) => <option key={stock.stockId} value={stock.stockId}>{stock.label}</option>)}</select></label>
      <label className="field"><span>Payout per unit in integer minor units</span><input inputMode="numeric" value={payout} aria-invalid={!validPayout} onChange={(event) => { setPayout(event.target.value); resetPolicyReview(); }} />{!validPayout && <small className="field-error">Enter zero or a positive safe integer.</small>}</label>
      {currentPolicy && <p>Current payout: {currentPolicy.payoutUnitMinor} minor units at revision {currentPolicy.revision}.</p>}
      <button type="button" disabled={!stockId || !validPayout || currentPolicy?.payoutUnitMinor === payoutMinor} onClick={() => { setPolicyReview(true); setPolicyConfirmed(false); }}>Review buy policy</button>
    </fieldset>
    {policyReview && selectedShop && selectedStock && <section className="command-review" aria-labelledby="buy-policy-review-heading"><h3 id="buy-policy-review-heading">Review buy policy</h3><dl className="command-detail-list"><div><dt>Shop</dt><dd>{selectedShop.name} · {shopId}</dd></div><div><dt>Stock</dt><dd>{selectedStock.label} · {stockId}</dd></div><div><dt>Payout</dt><dd>{payoutMinor} minor units per unit</dd></div><div><dt>Expected campaign revision</dt><dd>{campaignRevision}</dd></div></dl><p>A zero payout permits gifts. A positive payout permits paid sales subject to authoritative stock, wallet, and eligibility checks.</p><label className="checkbox"><input type="checkbox" checked={policyConfirmed} onChange={(event) => setPolicyConfirmed(event.target.checked)} /> Confirm this exact stock payout policy</label><button className="primary" type="button" disabled={locked || !policyConfirmed} onClick={() => api.configureBuyPolicy({ shopId, stockId, payoutUnitMinor: payoutMinor, expectedRevision: campaignRevision })}>Set buy policy once</button></section>}

    {associationMutation.phase === "uncertain" && <div className="content-warning" role="alert"><p>{associationMutation.message ?? "The association outcome is uncertain. Do not submit it again before reconciliation."}</p><button type="button" disabled={disabled} onClick={() => api.reconcileAssociation(npcId)}>Reconcile association</button></div>}
    {policyMutation.phase === "uncertain" && <div className="content-warning" role="alert"><p>{policyMutation.message ?? "The buy policy outcome is uncertain. Do not submit it again before reconciliation."}</p><button type="button" disabled={disabled} onClick={() => api.reconcileBuyPolicy(shopId, stockId)}>Reconcile buy policy</button></div>}
  </section>;
}
