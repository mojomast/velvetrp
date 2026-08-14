import { useEffect, useMemo, useRef, useState } from "react";
import type { CampaignHistoryHttpPublicReceiptResponse } from "@velvet/contracts";

/** Public mechanics link retained by an adventure turn. */
export interface MechanicReceiptLink {
  commandId: string;
  proposalId: string | null;
  linkedAt: string;
}

/** Narrow role-safe receipt reader used by mechanic receipt cards. */
export interface MechanicReceiptApi {
  getCampaignCommandReceipt: (campaignId: string, commandId: string) => Promise<CampaignHistoryHttpPublicReceiptResponse>;
}

/** Props for durable, deduplicated mechanic receipt rendering. */
export interface MechanicReceiptCardProps {
  campaignId: string;
  links: readonly MechanicReceiptLink[];
  api: MechanicReceiptApi;
}

type Receipt = CampaignHistoryHttpPublicReceiptResponse["receipt"];
type LoadIdentity = { campaignId: string; api: MechanicReceiptApi; commandId: string };
type Load = LoadIdentity & (
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; receipt: Receipt }
);

type CombatReceipt = Extract<Receipt, { kind: "combat" }>;

function combatActionLabel(action: CombatReceipt["action"]): string {
  switch (action) {
    case "attack": return "Attack";
    case "flee": return "Flee";
    case "end-turn": return "End turn";
  }
}

function CombatOutcome({ outcome }: { outcome: CombatReceipt["outcome"] }) {
  switch (outcome.kind) {
    case "damage":
      return <>
        <div><dt>Outcome</dt><dd>{outcome.applied} {outcome.damageType} damage</dd></div>
        <div><dt>Target condition</dt><dd>{outcome.hitPointsAfter} HP, {outcome.statusAfter}</dd></div>
      </>;
    case "status":
      return <div><dt>Outcome</dt><dd>Fled</dd></div>;
    case "none":
      return <div><dt>Outcome</dt><dd>No direct target outcome</dd></div>;
  }
}

function ReceiptBody({ receipt }: { receipt: Receipt }) {
  if (receipt.kind === "travel") return <dl>
    <div><dt>Travel completed</dt><dd>{receipt.destination}</dd></div>
    <div><dt>World travel revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div>
    <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if (receipt.kind === "combat") return <dl>
    <div><dt>Combat update</dt><dd>{combatActionLabel(receipt.action)}</dd></div>
    <CombatOutcome outcome={receipt.outcome} />
    <div><dt>Round</dt><dd>{receipt.roundBefore} → {receipt.roundAfter}</dd></div>
    <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if (receipt.kind === "administration") return <p>This receipt contains campaign administration metadata, not a mechanic.</p>;

  // The top-level receipt discriminator is narrowed before mechanic-only event data is read.
  const event = receipt.event;
  return <>
    {event.type === "actor_dice_rolled" && <dl>
      <div><dt>Expression</dt><dd>{event.data.expression}</dd></div>
      <div><dt>Physical terms</dt><dd>{event.data.terms.map((term, index) => <span className={term.kept ? "kept-term" : "discarded-term"} key={index}>{term.value} — {term.kept ? "kept" : "discarded"}</span>)}</dd></div>
      <div><dt>Selection</dt><dd>{event.data.normalized.selection.type}</dd></div>
      <div><dt>Modifier</dt><dd>{event.data.modifier >= 0 ? "+" : ""}{event.data.modifier}</dd></div>
      <div><dt>Total</dt><dd><strong>{event.data.total}</strong></dd></div>
    </dl>}
    {event.type === "actor_attribute_set" && <dl>
      <div><dt>Attribute</dt><dd>Updated</dd></div>
      <div><dt>Authoritative delta</dt><dd>{event.data.valueBefore} → {event.data.valueAfter}</dd></div>
    </dl>}
    {event.type === "actor_resource_initialized" && <dl>
      <div><dt>Resource initialized</dt><dd>Recorded</dd></div>
      <div><dt>Current / maximum</dt><dd>{event.data.current} / {event.data.max}</dd></div>
    </dl>}
    <dl><div><dt>Target / outcome</dt><dd>Not recorded for this mechanic</dd></div>
      <div><dt>Modifier source</dt><dd>Not recorded for this mechanic</dd></div>
      <div><dt>Campaign revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div>
      <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div></dl>
  </>;
}

/** Loads and renders authoritative role-safe receipts, deduplicated by command and proposal identity. */
export function MechanicReceiptCard({ campaignId, links, api }: MechanicReceiptCardProps) {
  const unique = useMemo(() => [...new Map(links.map((link) => [`${link.commandId}\0${link.proposalId}`, link])).values()], [links]);
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const requestScope = useRef<{campaignId:string;api:MechanicReceiptApi;
    requests:Map<string,Promise<CampaignHistoryHttpPublicReceiptResponse>>}>({campaignId,api,requests:new Map()});
  if(requestScope.current.campaignId!==campaignId||requestScope.current.api!==api){
    requestScope.current={campaignId,api,requests:new Map()};
  }
  useEffect(() => {
    let current = true;
    const scope=requestScope.current;
    setLoads({});
    const pending=unique.filter((link)=>!scope.requests.has(link.commandId));
    if(pending.length)setLoads((value)=>({...value,...Object.fromEntries(pending.map((link)=>[link.commandId,
      {campaignId,api,commandId:link.commandId,state:"loading" as const}]))}));
    for (const link of unique) {let request=scope.requests.get(link.commandId);if(!request){request=scope.api.getCampaignCommandReceipt(campaignId,link.commandId);scope.requests.set(link.commandId,request);}
      void request.then(({ receipt }) => {
      if (current) setLoads((value) => ({ ...value, [link.commandId]: {campaignId,api,commandId:link.commandId,state:"ready",receipt} }));
    }).catch(() => {if(scope.requests.get(link.commandId)===request)scope.requests.delete(link.commandId);
      if (current) setLoads((value) => ({ ...value, [link.commandId]: {campaignId,api,commandId:link.commandId,state:"error"} })); });}
    return () => { current = false; };
  }, [api, campaignId, unique]);
  if (unique.length === 0) return null;
  return <section className="mechanic-receipts" aria-label="Committed mechanics">
    <h2><span aria-hidden="true">✓ </span>Committed mechanics</h2>
    {unique.map((link) => { const stored=loads[link.commandId],load=stored?.campaignId===campaignId&&stored.api===api&&stored.commandId===link.commandId?stored:undefined;
      return <article className="mechanic-receipt-card" key={`${link.commandId}:${link.proposalId}`}>
      {!load || load.state === "loading" ? <p role="status">Loading committed mechanic…</p>
        : load.state === "error" ? <p role="alert">Committed mechanic could not be displayed. The durable turn remains authoritative.</p>
          : <ReceiptBody receipt={load.receipt} />}
    </article>; })}
  </section>;
}
