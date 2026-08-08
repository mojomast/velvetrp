import type { ActorTravelCommandRequest, ActorTravelCommandResponse, CampaignWorldHttpResponse } from "@velvet/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { isDefiniteNarrativeRejection, NarrativeMutationStatus, receiptFrom } from "../NarrativeMutationStatus";
import { beginNarrativeMutation, blocksNarrativeMutation, clearNarrativeMutation, consumeNarrativeConfirmed, markNarrativeAmbiguous, markNarrativeConfirmed, markNarrativePartial, useNarrativeMutation } from "../narrativeMutationRegistry";
import type { StudioAuthorization } from "../StudioAuthorization";
import { LocationTree } from "./LocationTree";
import { TravelDialog } from "./TravelDialog";

export interface WorldExplorerApi { getWorld: (campaignId: string) => Promise<{ data: CampaignWorldHttpResponse; revision: number }>; travel: (actorId: string, input: ActorTravelCommandRequest) => Promise<ActorTravelCommandResponse> }
export function WorldExplorerPage({ campaignId, authorization, api, onBack, focusHeadingRequest }: { campaignId: string; authorization: StudioAuthorization; api: WorldExplorerApi; onBack: () => void; focusHeadingRequest?: number }) {
  const mutation = useNarrativeMutation(campaignId, "travel");
  const [world, setWorld] = useState<CampaignWorldHttpResponse | null>(null), [revision, setRevision] = useState(0), [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading"), [status, setStatus] = useState("");
  const generation = useRef(0), mounted = useRef(true), heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async (focus = false) => { const token = ++generation.current; setPhase("loading"); try { const next = await api.getWorld(campaignId); if (!mounted.current || token !== generation.current) return false; setWorld(next.data); setRevision(next.revision); setPhase("ready"); if (focus) queueMicrotask(() => heading.current?.focus()); return true; } catch { if (mounted.current && token === generation.current) setPhase("failed"); return false; } }, [api, campaignId]);
  useEffect(() => { mounted.current = true; void load().then((fresh) => { if (fresh && mutation?.phase === "confirmed") consumeNarrativeConfirmed(mutation); }); return () => { mounted.current = false; generation.current += 1; }; }, [load]);
  useEffect(() => { if (focusHeadingRequest !== undefined && phase !== "loading") queueMicrotask(() => heading.current?.focus()); }, [focusHeadingRequest, phase]);
  async function authorizeAndRefresh() { try { await authorization.reauthorize(); } catch { /* gate renders the authorized fallback */ } }
  async function travel(actorId: string, command: ActorTravelCommandRequest) {
    let freshAuthorization; try { freshAuthorization = await authorization.reauthorize(); } catch { return; }
    if (freshAuthorization.role === "observer") { setStatus("Observers cannot issue travel commands."); return; }
    const pending = beginNarrativeMutation(campaignId, "travel", "Travel", { resourceId:actorId,idempotencyKey:command.idempotencyKey,expectedRevision:command.expectedRevision }); if (!pending) return;
    try { const result = await api.travel(actorId, command); const receipt=receiptFrom(result);markNarrativeConfirmed(pending, result, receipt); const refreshed = await api.getWorld(campaignId).then((next) => { if (mounted.current) { setWorld(next.data); setRevision(next.revision); setPhase("ready"); } return true; }).catch(() => false); const confirmed={...pending,phase:"confirmed" as const,memoryResult:result,receipt,resultingRevision:receipt?.revisionAfter,refresh:"required" as const};if (refreshed) consumeNarrativeConfirmed(confirmed); else markNarrativePartial(confirmed); }
    catch (error) { if (isDefiniteNarrativeRejection(error)) { clearNarrativeMutation(campaignId, "travel"); setStatus("Travel was definitely rejected as stale or conflicting. Refresh before creating a new command."); } else markNarrativeAmbiguous(pending); }
  }
  const names = new Map(world?.visibleLocations.map((item) => [item.locationId, item.name]) ?? []), currentIds = world?.currentLocations.map((item) => item.locationId) ?? [];
  return <main className="studio-page" aria-labelledby="world-heading"><div className="studio-shell"><header className="studio-header"><div><button className="back-link" onClick={onBack}>← Campaign</button><p className="eyebrow">KNOWN WORLD</p><h1 ref={heading} tabIndex={-1} id="world-heading">World explorer</h1></div>{world && <TravelDialog world={world} revision={revision} disabled={blocksNarrativeMutation(mutation) || authorization.role === "observer"} onTravel={travel} />}</header>
    <NarrativeMutationStatus mutation={mutation} onRefresh={() => void authorizeAndRefresh()} />{status && <p role="status">{status}</p>}
    {phase === "loading" && !world && <p role="status">Loading known world…</p>}{phase === "failed" && !world && <section role="alert"><p>Known world could not be loaded.</p><button className="ghost" onClick={() => void authorizeAndRefresh()}>Reauthorize & retry</button></section>}
    {world && <div className="studio-grid"><section className="studio-panel"><h2>Known locations</h2><LocationTree locations={world.visibleLocations} currentLocationIds={currentIds} /></section><section className="studio-panel"><h2>Visible exits</h2>{world.visibleConnections.length ? <ul className="plain-list">{world.visibleConnections.map((item) => <li key={item.connectionId}><strong>{names.get(item.fromLocationId)}</strong> → {names.get(item.toLocationId)}</li>)}</ul> : <p>No visible exits.</p>}<h2>Current locations</h2><ul>{world.currentLocations.map((item) => <li key={item.actorId}>{names.get(item.locationId) ?? "Known location"}</li>)}</ul></section></div>}
  </div></main>;
}
