import type { ActorCampCommandRequest, ActorCampCommandResponse, ActorPlacementCommandRequest, ActorPlacementCommandResponse, ActorTravelCommandRequest, ActorTravelCommandResponse, CampaignWorldHttpResponse } from "@velvet/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../../api";
import { isDefiniteNarrativeRejection, NarrativeMutationStatus, receiptFrom } from "../NarrativeMutationStatus";
import { beginNarrativeMutation, blocksNarrativeMutation, clearNarrativeMutation, consumeNarrativeConfirmed, markNarrativeAmbiguous, markNarrativeConfirmed, markNarrativePartial, useNarrativeMutation } from "../narrativeMutationRegistry";
import type { StudioAuthorization } from "../StudioAuthorization";
import { LocationTree } from "./LocationTree";
import { TravelDialog } from "./TravelDialog";
import { WorldExpeditionPanel } from "./WorldExpeditionPanel";
import { WorldbuildingNavigation } from "./WorldbuildingNavigation";
import { LocationRelationships } from "./LocationRelationships";
import { CampaignStartingLocationPanel } from "../generation/CampaignStartingLocationPanel";
import { campaignStartingLocationApi, type CampaignStartingLocationApi } from "../generation/campaignStartingLocationApi";

export interface WorldExplorerApi {
  getWorld: (campaignId: string) => Promise<{ data: CampaignWorldHttpResponse; revision: number }>;
  travel: (actorId: string, input: ActorTravelCommandRequest) => Promise<ActorTravelCommandResponse>;
  place: (actorId: string, input: ActorPlacementCommandRequest) => Promise<ActorPlacementCommandResponse>;
  camp: (actorId: string, input: ActorCampCommandRequest) => Promise<ActorCampCommandResponse>;
}
export function WorldExplorerPage(props: React.ComponentProps<typeof WorldExplorerWorkspace>) {
  return <WorldExplorerWorkspace key={`${props.campaignId}:${props.authorization.role}:${props.authorization.audience}:${props.authorization.generation}`} {...props} />;
}
function WorldExplorerWorkspace({ campaignId, authorization, api, startingLocationApi = campaignStartingLocationApi, onBack, focusHeadingRequest, embedded = false, blocked = false, actors, onLockChange, onStateChange }: { campaignId: string; authorization: StudioAuthorization; api: WorldExplorerApi; startingLocationApi?: CampaignStartingLocationApi; onBack: () => void; focusHeadingRequest?: number; embedded?: boolean; blocked?: boolean; actors?: readonly { actorId: string; name: string }[]; onLockChange?: (locked: boolean) => void; onStateChange?: () => void }) {
  const mutation = useNarrativeMutation(campaignId, "travel");
  const [world, setWorld] = useState<CampaignWorldHttpResponse | null>(null), [revision, setRevision] = useState(0), [phase, setPhase] = useState<"loading" | "ready" | "empty" | "failed">("loading"), [status, setStatus] = useState("");
  const generation = useRef(0), mounted = useRef(true), heading = useRef<HTMLHeadingElement>(null);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [checking, setChecking] = useState(false), [reviewing, setReviewing] = useState(false);
  const busy = useRef(false), blockedRef = useRef(blocked); blockedRef.current = blocked;
  const changedRef = useRef(onStateChange); changedRef.current = onStateChange;
  useEffect(() => { onLockChange?.(checking || reviewing || blocksNarrativeMutation(mutation)); }, [checking, reviewing, mutation, onLockChange]);
  useEffect(() => () => onLockChange?.(false), [onLockChange]);
  const load = useCallback(async (focus = false) => { const token = ++generation.current; setPhase("loading"); try { const next = await api.getWorld(campaignId); if (!mounted.current || token !== generation.current) return false; setWorld(next.data); setRevision(next.revision); setPhase("ready"); if (focus) queueMicrotask(() => heading.current?.focus()); return next.revision; } catch (error) { if (mounted.current && token === generation.current) setPhase(error instanceof ApiError && error.code === "RPG_WORLD_NOT_FOUND" ? "empty" : "failed"); return false; } }, [api, campaignId]);
  useEffect(() => { mounted.current = true; void load().then((fresh) => { if (fresh !== false && mutation?.phase === "confirmed") { fresh === mutation.resultingRevision ? consumeNarrativeConfirmed(mutation) : markNarrativePartial(mutation); } }); return () => { mounted.current = false; generation.current += 1; }; }, [load]);
  useEffect(() => { if (focusHeadingRequest !== undefined && phase !== "loading") queueMicrotask(() => heading.current?.focus()); }, [focusHeadingRequest, phase]);
  async function authorizeAndRefresh() { try { const auth = await authorization.reauthorize(); if (!mounted.current || auth.audience !== authorization.audience || auth.role !== authorization.role) return; const fresh = await load(); if (fresh !== false && mutation?.phase === "confirmed") { fresh === mutation.resultingRevision ? consumeNarrativeConfirmed(mutation) : markNarrativePartial(mutation); } } catch { /* gate renders the authorized fallback */ } }
  async function travel(actorId: string, command: ActorTravelCommandRequest) {
    if (blockedRef.current || busy.current || (actors && !actors.some((actor) => actor.actorId === actorId))) return;
    busy.current = true; setChecking(true);
    try {
    let freshAuthorization; try { freshAuthorization = await authorization.reauthorize(); } catch { return; }
    if (!mounted.current || blockedRef.current || freshAuthorization.role !== authorization.role || freshAuthorization.audience !== authorization.audience) return;
    if (freshAuthorization.role === "observer") { setStatus("Observers cannot issue travel commands."); return; }
    const pending = beginNarrativeMutation(campaignId, "travel", "Travel", { resourceId:actorId,idempotencyKey:command.idempotencyKey,expectedRevision:command.expectedRevision }); if (!pending) return;
    try { const result = await api.travel(actorId, command); const receipt=receiptFrom(result);markNarrativeConfirmed(pending, result, receipt); const refreshed = await api.getWorld(campaignId).then((next) => { if (mounted.current) { setWorld(next.data); setRevision(next.revision); setPhase("ready"); } return next.revision; }).catch(() => false); const confirmed={...pending,phase:"confirmed" as const,memoryResult:result,receipt,resultingRevision:receipt?.revisionAfter,refresh:"required" as const};if (refreshed !== false && receipt && refreshed === receipt.revisionAfter) consumeNarrativeConfirmed(confirmed); else markNarrativePartial(confirmed); }
    catch (error) { if (isDefiniteNarrativeRejection(error)) { clearNarrativeMutation(campaignId, "travel"); setStatus("Travel was definitely rejected as stale or conflicting. Refresh before creating a new command."); } else markNarrativeAmbiguous(pending); }
    if (mounted.current) changedRef.current?.();
    } finally { busy.current = false; if (mounted.current) setChecking(false); }
  }
  async function expedition<T extends { receipt: { revisionAfter: number } }>(actorId: string, operation: string, identity: { expectedRevision: number; idempotencyKey: string }, issue: () => Promise<T>) {
    if (blockedRef.current || busy.current || (actors && !actors.some((actor) => actor.actorId === actorId))) return;
    busy.current = true; setChecking(true);
    try {
    let freshAuthorization; try { freshAuthorization = await authorization.reauthorize(); } catch { return; }
    if (!mounted.current || blockedRef.current || freshAuthorization.role !== authorization.role || freshAuthorization.audience !== authorization.audience) return;
    if (freshAuthorization.role === "observer") { setStatus(`${operation} requires a GM.`); return; }
    const pending = beginNarrativeMutation(campaignId, "travel", operation, { resourceId:actorId,idempotencyKey:identity.idempotencyKey,expectedRevision:identity.expectedRevision }); if (!pending) return;
    try { const result = await issue(); const receipt=receiptFrom(result);markNarrativeConfirmed(pending, result, receipt); const refreshed = await api.getWorld(campaignId).then((next) => { if (mounted.current) { setWorld(next.data); setRevision(next.revision); setPhase("ready"); } return next.revision; }).catch(() => false); const confirmed={...pending,phase:"confirmed" as const,memoryResult:result,receipt,resultingRevision:receipt?.revisionAfter,refresh:"required" as const};if (refreshed !== false && receipt && refreshed === receipt.revisionAfter) consumeNarrativeConfirmed(confirmed); else markNarrativePartial(confirmed); }
    catch (error) { if (isDefiniteNarrativeRejection(error)) { clearNarrativeMutation(campaignId, "travel"); setStatus(`${operation} was definitely rejected as stale or conflicting. Refresh before creating a new command.`); } else markNarrativeAmbiguous(pending); }
    if (mounted.current) changedRef.current?.();
    } finally { busy.current = false; if (mounted.current) setChecking(false); }
  }
  const place = (actorId: string, command: ActorPlacementCommandRequest) => expedition(actorId, "Place actor", command, () => api.place(actorId, command));
  const camp = (actorId: string, command: ActorCampCommandRequest) => expedition(actorId, "Make camp", command, () => api.camp(actorId, command));
  const names = new Map(world?.visibleLocations.map((item) => [item.locationId, item.name]) ?? []), currentIds = world?.currentLocations.map((item) => item.locationId) ?? [];
  const location = world?.visibleLocations.find(item => item.locationId === selectedLocation) ?? world?.visibleLocations[0];
  const Container = embedded ? "section" : "main", Heading = embedded ? "h3" : "h1";
  const travelPlan = world && <TravelDialog inline={embedded} actors={actors} onReviewChange={setReviewing} world={world} revision={revision} disabled={blocked || checking || phase !== "ready" || blocksNarrativeMutation(mutation) || authorization.role === "observer"} onTravel={travel} />;
  const expeditionPlan = world && actors && actors.length > 0 && <WorldExpeditionPanel campaignId={campaignId} revision={revision} world={world} actors={actors} canCommand={authorization.role === "owner" || authorization.role === "gm"} disabled={blocked || checking || phase !== "ready" || blocksNarrativeMutation(mutation)} api={{ place, camp }} />;
  return <Container className={embedded ? "atlas-world-tools" : "studio-page"} aria-labelledby="world-heading"><div className={embedded ? "atlas-world-body" : "studio-shell"}><header className={embedded ? "atlas-domain-heading" : "studio-header"}><div>{!embedded && <button className="back-link" onClick={onBack}>← Campaign</button>}<p className="eyebrow">KNOWN WORLD</p><Heading ref={heading} tabIndex={-1} id="world-heading">World explorer</Heading></div>{!embedded && travelPlan}</header>
    {embedded && travelPlan}
    <NarrativeMutationStatus mutation={mutation} onRefresh={() => void authorizeAndRefresh()} />{status && <p role="status">{status}</p>}
    {expeditionPlan}
    {!embedded && <><WorldbuildingNavigation current="world" authorization={authorization} />
    <CampaignStartingLocationPanel campaignId={campaignId} candidates={(world?.visibleLocations ?? []).map(({ locationId, name }) => ({ locationId, name }))} canDesignate={authorization.role === "owner" || authorization.role === "gm"} api={startingLocationApi} /></>}
    <button className="ghost" onClick={() => void authorizeAndRefresh()}>Reauthorize & refresh</button>
    {phase === "loading" && !world && <p role="status">Loading known world…</p>}{phase === "empty" && !world && <section className="studio-panel"><h2>No campaign world yet</h2><p>Attach exactly one room to this campaign before opening its locations and routes.</p><button className="ghost" onClick={() => void authorizeAndRefresh()}>Reauthorize & refresh</button></section>}{phase === "failed" && !world && <section role="alert"><p>Known world could not be loaded.</p><button className="ghost" onClick={() => void authorizeAndRefresh()}>Reauthorize & retry</button></section>}
    {world && <div className={embedded ? "atlas-world-locations" : "studio-grid"}><section className="studio-panel"><h2>Known locations</h2><p>Select a named location to review its exits and linked preparation. Locations and routes cannot be manually edited here.</p><LocationTree locations={world.visibleLocations} currentLocationIds={currentIds} selectedLocationId={location?.locationId} onSelect={setSelectedLocation} /></section><section className="studio-panel" aria-label="Selected location">{location && <><h2>{location.name}</h2><p>{location.description}</p><h3>Visible exits</h3>{world.visibleConnections.some(item => item.fromLocationId === location.locationId) ? <ul className="plain-list">{world.visibleConnections.filter(item => item.fromLocationId === location.locationId).map(item => <li key={item.connectionId}><button onClick={() => setSelectedLocation(item.toLocationId)}>{names.get(item.toLocationId) ?? "Undisclosed destination"}</button></li>)}</ul> : <p>No visible exits from this location.</p>}<p>{world.currentLocations.filter(item => item.locationId === location.locationId).length} server-visible actors currently here.</p></>}{!embedded && <LocationRelationships campaignId={campaignId} authorization={authorization} locationId={location?.locationId ?? ""} />}</section></div>}
   </div></Container>;
}
