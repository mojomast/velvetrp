import { actorTravelCommandRequestSchema } from "@velvet/contracts";
import type { ActorTravelCommandRequest, CampaignWorldHttpResponse } from "@velvet/contracts";
import { FormEvent, useMemo, useRef, useState } from "react";

export function TravelDialog({ world, revision, disabled, onTravel }: {
  world: CampaignWorldHttpResponse;
  revision: number;
  disabled?: boolean;
  onTravel: (actorId: string, command: ActorTravelCommandRequest) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [actorId, setActorId] = useState("");
  const [partyActorIds, setPartyActorIds] = useState<string[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [reviewCommand, setReviewCommand] = useState<ActorTravelCommandRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const names = useMemo(() => new Map(world.visibleLocations.map((item) => [item.locationId, item.name])), [world]);
  const actorLocations = useMemo(() => new Map(world.currentLocations.map((item) => [item.actorId, item.locationId])), [world]);
  const eligible = world.visibleConnections.filter((connection) => connection.fromLocationId === actorLocations.get(actorId));
  const selectedParty = partyActorIds.includes(actorId) ? partyActorIds : actorId ? [actorId, ...partyActorIds] : partyActorIds;
  const candidate = actorTravelCommandRequestSchema.safeParse({ connectionId, partyActorIds: selectedParty,
    expectedRevision: revision, idempotencyKey: `travel-ui-${crypto.randomUUID()}` });
  const route = eligible.find((item) => item.connectionId === reviewCommand?.connectionId);
  const open = () => { const node = dialog.current; if (!node) return; typeof node.showModal === "function" ? node.showModal() : node.setAttribute("open", ""); };
  const close = () => { const node = dialog.current; if (!node) return; typeof node.close === "function" ? node.close() : node.removeAttribute("open"); };
  function begin(event: FormEvent) { event.preventDefault(); if (!candidate.success || !eligible.some((item) => item.connectionId === candidate.data.connectionId)) return; setReviewCommand(candidate.data); }
  async function confirm() { if (!reviewCommand || busy) return; setBusy(true); try { await onTravel(actorId, reviewCommand); close(); setReviewCommand(null); } finally { setBusy(false); } }
  return <><button type="button" className="primary" disabled={disabled || world.currentLocations.length === 0} onClick={open}>Plan travel</button>
    <dialog ref={dialog} className="rpg-dialog" onClose={() => setReviewCommand(null)} aria-labelledby="travel-heading"><form onSubmit={begin}>
      <h2 id="travel-heading">{reviewCommand ? "Confirm travel" : "Plan travel"}</h2>
      {reviewCommand && route ? <div className="review-card"><p><strong>Route:</strong> {names.get(route.fromLocationId)} → {names.get(route.toLocationId)}</p><p><strong>Exact server-visible party:</strong> {reviewCommand.partyActorIds.join(", ")}</p><p>Expected world revision {reviewCommand.expectedRevision}. This command is sent once.</p></div> : <>
        <label>Acting actor<select required value={actorId} onChange={(event) => { setActorId(event.target.value); setConnectionId(""); setReviewCommand(null); }}><option value="">Choose a visible actor</option>{world.currentLocations.map((item) => <option key={item.actorId} value={item.actorId}>Actor at {names.get(item.locationId) ?? "known location"}</option>)}</select></label>
        <fieldset><legend>Travel party (server-visible actors only)</legend>{world.currentLocations.map((item) => <label key={item.actorId}><input type="checkbox" checked={selectedParty.includes(item.actorId)} disabled={item.actorId === actorId} onChange={(event) => setPartyActorIds((current) => event.target.checked ? [...new Set([...current, item.actorId])] : current.filter((id) => id !== item.actorId))} />Actor at {names.get(item.locationId) ?? "known location"}</label>)}</fieldset>
        <label>Eligible route<select required value={connectionId} onChange={(event) => setConnectionId(event.target.value)}><option value="">Choose a route from this actor's current location</option>{eligible.map((item) => <option key={item.connectionId} value={item.connectionId}>{names.get(item.fromLocationId)} → {names.get(item.toLocationId)}</option>)}</select></label>
      </>}
      <div className="button-row"><button type="button" className="ghost" disabled={busy} onClick={() => reviewCommand ? setReviewCommand(null) : close()}>{reviewCommand ? "Back" : "Cancel"}</button><button type={reviewCommand ? "button" : "submit"} className="primary" disabled={busy || (!reviewCommand && !candidate.success)} onClick={reviewCommand ? () => void confirm() : undefined}>{busy ? "Submitting once…" : reviewCommand ? "Confirm travel" : "Review"}</button></div>
    </form></dialog></>;
}
