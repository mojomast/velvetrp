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
  if(receipt.kind==="progression")return <dl>
    <div><dt>Character progression</dt><dd>{receipt.className}</dd></div><div><dt>Level</dt><dd>{receipt.levelBefore} → {receipt.levelAfter}</dd></div>
    {receipt.features.length>0&&<div><dt>Features gained</dt><dd>{receipt.features.join(", ")}</dd></div>}
    {receipt.resources.map((resource,index)=><div key={index}><dt>{resource.label}</dt><dd>{resource.before} → {resource.after}</dd></div>)}
    <div><dt>Progression revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div><div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if(receipt.kind==="quest-lifecycle")return <dl>
    <div><dt>Quest action</dt><dd>{receipt.action}</dd></div><div><dt>Quest</dt><dd>{receipt.questTitle}</dd></div><div><dt>Status</dt><dd>{receipt.statusBefore} → {receipt.statusAfter}</dd></div>
    {receipt.reward&&<><div><dt>Reward</dt><dd>{receipt.reward.amount===null?receipt.reward.label:`${receipt.reward.amount} ${receipt.reward.kind} (${receipt.reward.label})`}</dd></div><div><dt>Recipient</dt><dd>{receipt.reward.recipient}</dd></div></>}
    <div><dt>Quest revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div><div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if(receipt.kind==="combat-power")return <dl>
    <div><dt>Combat power</dt><dd>{receipt.powerName}</dd></div><div><dt>Target</dt><dd>{receipt.target}</dd></div><div><dt>Cost</dt><dd>One {receipt.actionCost}</dd></div>
    {receipt.costs.map((cost,index)=><div key={`cost-${index}`}><dt>{cost.label}</dt><dd>{cost.before} → {cost.after}</dd></div>)}
    {receipt.outcomes.map((outcome,index)=><div key={index}><dt>{outcome.kind}</dt><dd>{outcome.kind==="damage"?`${outcome.roll.total} rolled, ${outcome.applied} ${outcome.damageType} damage (${outcome.adjustment})`:outcome.kind==="healing"?`${outcome.roll.total} rolled, ${outcome.applied} healing`:`${outcome.effect}${outcome.replacedConcentration?"; concentration replaced":""}`}</dd></div>)}
    {receipt.concentration&&<div><dt>Concentration</dt><dd>Active</dd></div>}<div><dt>Round</dt><dd>{receipt.roundBefore} → {receipt.roundAfter}</dd></div><div><dt>Combat revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div>
    <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if(receipt.kind==="combat-consumable")return <dl>
    <div><dt>Combat item</dt><dd>{receipt.quantity} {receipt.itemName}</dd></div><div><dt>Target</dt><dd>{receipt.target}</dd></div>
    <div><dt>Cost</dt><dd>One {receipt.actionCost}</dd></div>
    {receipt.outcomes.map((outcome,index)=><div key={index}><dt>{outcome.kind}</dt><dd>{outcome.kind==="damage"?`${outcome.roll && typeof outcome.roll==="object"&&"total" in outcome.roll?outcome.roll.total:"Server"} rolled, ${outcome.applied} ${outcome.damageType} damage (${outcome.adjustment})`:outcome.kind==="healing"?`${outcome.roll && typeof outcome.roll==="object"&&"total" in outcome.roll?outcome.roll.total:"Server"} rolled, ${outcome.applied} healing`:`${outcome.resource}: ${outcome.before??"unknown"} → ${outcome.after??"unknown"}`}</dd></div>)}
    <div><dt>Round</dt><dd>{receipt.roundBefore} → {receipt.roundAfter}</dd></div><div><dt>Combat revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div>
    <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if(receipt.kind==="commerce")return <dl>
    <div><dt>Vendor commerce</dt><dd>{receipt.action}</dd></div><div><dt>Vendor</dt><dd>{receipt.vendorLabel} at {receipt.shopLabel}</dd></div>
    <div><dt>Item</dt><dd>{receipt.quantity} {receipt.itemLabel}</dd></div><div><dt>Price</dt><dd>{receipt.priceMinorUnits} {receipt.currencyLabel}</dd></div>
    <div><dt>Wallet</dt><dd>{receipt.balanceBefore} → {receipt.balanceAfter}</dd></div><div><dt>Commerce revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div>
    <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if(receipt.kind==="power")return <dl>
    <div><dt>Power used</dt><dd>{receipt.powerName}</dd></div><div><dt>Targets</dt><dd>{receipt.targets.join(", ")}</dd></div>
    {receipt.costs.map((cost,index)=><div key={`cost-${index}`}><dt>{cost.label}</dt><dd>{cost.before} → {cost.after}</dd></div>)}
    {receipt.stateDeltas.map((delta,index)=><div key={`delta-${index}`}><dt>{delta.actor}</dt><dd>{delta.before===null?delta.change:`${delta.change}: ${delta.before} → ${delta.after}`}</dd></div>)}
    {receipt.concentration&&<div><dt>Concentration</dt><dd>Active</dd></div>}
    <div><dt>Power revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div>
    <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if(receipt.kind==="rest")return <dl>
    <div><dt>Rest completed</dt><dd>{receipt.restName}</dd></div>
    {receipt.recovery.map((delta,index)=><div key={index}><dt>{delta.label}</dt><dd>{delta.before} → {delta.after}</dd></div>)}
    <div><dt>Rest revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div>
    <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if(receipt.kind==="inventory")return <dl>
    <div><dt>Inventory action</dt><dd>{receipt.action}</dd></div>
    <div><dt>Item</dt><dd>{receipt.quantity} {receipt.itemLabel}</dd></div>
    {receipt.slot&&<div><dt>Slot</dt><dd>{receipt.slot}</dd></div>}
    {receipt.recipient&&<div><dt>Recipient</dt><dd>{receipt.recipient}</dd></div>}
    <div><dt>Inventory revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div>
    <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if(receipt.kind==="check")return <dl>
    <div><dt>{receipt.checkKind === "skill" ? "Skill check" : "Ability check"}</dt><dd>{receipt.skill ?? receipt.ability} ({receipt.ability})</dd></div>
    <div><dt>Roll</dt><dd>{receipt.rolls.map((roll,index)=><span className={roll.kept?"kept-term":"discarded-term"} key={index}>{roll.value} — {roll.kept?"kept":"discarded"}</span>)}</dd></div>
    <div><dt>Mode</dt><dd>{receipt.mode}</dd></div>
    <div><dt>Ability modifier</dt><dd>{receipt.abilityModifier>=0?"+":""}{receipt.abilityModifier}</dd></div>
    <div><dt>Proficiency bonus</dt><dd>{receipt.proficiencyBonus?`+${receipt.proficiencyBonus}`:"Not proficient"}</dd></div>
    <div><dt>Total</dt><dd><strong>{receipt.total}</strong></dd></div>
    <div><dt>Difficulty</dt><dd>{receipt.difficulty} (DC {receipt.dc})</dd></div>
    <div><dt>Outcome</dt><dd>{receipt.outcome === "success" ? "Success" : "Failure"}</dd></div>
    <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
  if (receipt.kind === "quest") return <dl>
    <div><dt>Quest progress</dt><dd>{receipt.title}</dd></div>
    <div><dt>Objective</dt><dd>{receipt.objectiveDescription}</dd></div>
    <div><dt>Progress</dt><dd>{receipt.progressBefore} → {receipt.progressAfter} / {receipt.target}</dd></div>
    <div><dt>Objective status</dt><dd>{receipt.objectiveCompleted ? "Completed" : "In progress"}</dd></div>
    <div><dt>Quest status</dt><dd>{receipt.questCompleted ? "Completed" : "In progress"}</dd></div>
    <div><dt>Quest revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div>
    <div><dt>Committed at</dt><dd><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></dd></div>
  </dl>;
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
