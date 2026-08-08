import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignAdministration, CampaignHistoryHttpCheckpoint, CampaignHistoryHttpCommandReceipt, CampaignHistoryHttpEvent, CampaignHistoryHttpEventsQuery, CampaignHistoryHttpEventsResponse, CampaignHistoryHttpRecap, CampaignHistoryHttpRecapRequest, CampaignHistoryHttpRecapResponse, CampaignHistoryHttpTimeline, CampaignHistoryHttpTimelinesResponse } from "@velvet/contracts";
import { CheckpointTimeline } from "./CheckpointTimeline";
import { RecapViewer } from "./RecapViewer";

const PAGE_SIZE = 25;
function eventName(type: CampaignHistoryHttpEvent["type"]): string {
  return type === "actor_attribute_set" ? "Attribute changed" : type === "actor_resource_initialized" ? "Resource initialized" : "Dice rolled";
}
function eventSummary(event: CampaignHistoryHttpEvent): string {
  if (event.type === "actor_attribute_set") return `Changed ${event.data.attributeId} from ${event.data.valueBefore} to ${event.data.valueAfter}.`;
  if (event.type === "actor_resource_initialized") return `Initialized ${event.data.name} at ${event.data.current} of ${event.data.max}.`;
  return `Rolled ${event.data.expression}; total ${event.data.total}.`;
}

export interface CampaignHistoryApi {
  administration: (campaignId: string) => Promise<{ campaign: CampaignAdministration }>;
  timelines: (campaignId: string) => Promise<CampaignHistoryHttpTimelinesResponse>;
  checkpoints: (campaignId: string) => Promise<{ checkpoints: CampaignHistoryHttpCheckpoint[] }>;
  events: (campaignId: string, query: CampaignHistoryHttpEventsQuery) => Promise<CampaignHistoryHttpEventsResponse>;
  recaps: (campaignId: string) => Promise<{ recaps: CampaignHistoryHttpRecap[] }>;
  receipt: (campaignId: string, commandId: string) => Promise<{ receipt: CampaignHistoryHttpCommandReceipt }>;
  createRecap: (campaignId: string, input: CampaignHistoryHttpRecapRequest) => Promise<CampaignHistoryHttpRecapResponse>;
}
export interface CampaignEventLogPageProps { campaignId: string; api: CampaignHistoryApi; onBack: () => void; onUnavailable: () => void; focusHeadingRequest?: number }
export function CampaignEventLogPage({ campaignId, api, onBack, onUnavailable, focusHeadingRequest }: CampaignEventLogPageProps) {
  const [role, setRole] = useState<CampaignAdministration["actorRole"] | null>(null), [revision, setRevision] = useState(0);
  const [timelines, setTimelines] = useState<CampaignHistoryHttpTimeline[]>([]), [timelineId, setTimelineId] = useState("");
  const [checkpoints, setCheckpoints] = useState<CampaignHistoryHttpCheckpoint[]>([]), [recaps, setRecaps] = useState<CampaignHistoryHttpRecap[]>([]);
  const [events, setEvents] = useState<CampaignHistoryHttpEvent[]>([]), [cursor, setCursor] = useState<number | null>(0);
  const [loading, setLoading] = useState(true), [paging, setPaging] = useState(false), [partial, setPartial] = useState(""), [error, setError] = useState("");
  const [receipt, setReceipt] = useState<CampaignHistoryHttpCommandReceipt | null>(null), [receiptError, setReceiptError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null), retryRef = useRef<HTMLButtonElement>(null), moreRef = useRef<HTMLButtonElement>(null), mounted = useRef(true), generation = useRef(0);

  const loadPage = useCallback(async (selectedTimeline: string, after: number, replace: boolean) => {
    const request = ++generation.current; replace ? setLoading(true) : setPaging(true); setError("");
    try { const page = await api.events(campaignId, { timelineId: selectedTimeline, afterRevision: after, limit: PAGE_SIZE });
      if (!mounted.current || request !== generation.current) return;
      setEvents((current) => replace ? page.events : [...current, ...page.events]); setCursor(page.nextAfterRevision); setLoading(false); setPaging(false);
      if (!replace) queueMicrotask(() => moreRef.current?.focus());
    } catch { if (!mounted.current || request !== generation.current) return; setLoading(false); setPaging(false); setError("Event history could not be loaded."); queueMicrotask(() => retryRef.current?.focus()); }
  }, [api, campaignId]);

  const load = useCallback(async () => {
    const request = ++generation.current; setLoading(true); setError(""); setPartial("");
    try {
      const [administration, timelineData] = await Promise.all([api.administration(campaignId), api.timelines(campaignId)]);
      const active = timelineData.activeTimelineId;
      const [checkpointResult, recapResult, eventResult] = await Promise.allSettled([api.checkpoints(campaignId), api.recaps(campaignId), api.events(campaignId, { timelineId: active, afterRevision: 0, limit: PAGE_SIZE })]);
      if (!mounted.current || request !== generation.current) return;
      setRole(administration.campaign.actorRole); setRevision(administration.campaign.revision); setTimelines(timelineData.timelines); setTimelineId(active);
      setCheckpoints(checkpointResult.status === "fulfilled" ? checkpointResult.value.checkpoints : []);
      const roleSafeRecaps = recapResult.status === "fulfilled" ? recapResult.value.recaps.filter((item) => item.visibility === "members" || administration.campaign.actorRole === "owner" || administration.campaign.actorRole === "gm") : [];
      setRecaps(roleSafeRecaps); setEvents(eventResult.status === "fulfilled" ? eventResult.value.events : []); setCursor(eventResult.status === "fulfilled" ? eventResult.value.nextAfterRevision : 0);
      const missing = [checkpointResult.status === "rejected" && "checkpoints", recapResult.status === "rejected" && "recaps", eventResult.status === "rejected" && "events"].filter(Boolean);
      setPartial(missing.length ? `Some history is temporarily unavailable: ${missing.join(", ")}. Retry to complete this view.` : ""); setLoading(false);
      queueMicrotask(() => headingRef.current?.focus());
    } catch (cause) { if (!mounted.current || request !== generation.current) return; setLoading(false); if (typeof cause === "object" && cause !== null && "status" in cause && cause.status === 404) onUnavailable(); else { setError("Campaign history could not be opened."); queueMicrotask(() => retryRef.current?.focus()); } }
  }, [api, campaignId, onUnavailable]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current += 1; }; }, [load]);
  useEffect(() => { if (!loading && focusHeadingRequest !== undefined) queueMicrotask(() => headingRef.current?.focus()); }, [focusHeadingRequest, loading]);

  async function openReceipt(commandId: string) { setReceipt(null); setReceiptError(""); try { setReceipt((await api.receipt(campaignId, commandId)).receipt); } catch { setReceiptError("No public receipt is available for this event."); } }
  async function createRecap(input: Parameters<NonNullable<React.ComponentProps<typeof RecapViewer>["onCreate"]>>[0]) {
    try { const response = await api.createRecap(campaignId, { ...input, expectedRevision: revision, idempotencyKey: `recap-ui-${crypto.randomUUID()}` }); setRecaps((current) => [response.recap, ...current]); setRevision(response.receipt.revisionAfter); }
    catch { setPartial("The recap outcome could not be safely confirmed. It was not repeated; refresh authoritative history before trying again."); }
  }
  return <main className="page library-page campaign-page history-page"><section className="campaign-shell" aria-labelledby="history-heading">
    <header className="library-header"><div><button className="back-link" onClick={onBack}>← Campaign</button><p className="eyebrow">ROLE-SAFE CAMPAIGN HISTORY</p><h1 ref={headingRef} tabIndex={-1} className="title" id="history-heading">Event log and recaps</h1></div><button className="ghost" onClick={() => void load()}>Refresh all</button></header>
    {error && <div role="alert" className="admin-status is-error"><p>{error}</p><button ref={retryRef} className="primary" onClick={() => void load()}>Retry history</button></div>}
    {partial && <div role="alert" className="admin-status is-error"><p>{partial}</p><button className="ghost" onClick={() => void load()}>Retry missing history</button></div>}
    {loading ? <section className="history-panel" aria-busy="true"><p>Loading role-safe history…</p></section> : role && <div className="history-grid">
      <section className="history-panel" aria-labelledby="events-heading"><div className="admin-section-heading"><div><p className="eyebrow">STRUCTURED EVENTS</p><h2 id="events-heading">Event log</h2></div></div>
        <label className="field"><span>Timeline</span><select value={timelineId} onChange={(event) => { const next = event.target.value; setTimelineId(next); setReceipt(null); void loadPage(next, 0, true); }}>{timelines.map((timeline) => <option key={timeline.id} value={timeline.id}>{timeline.active ? "Current timeline" : `Fork created ${new Date(timeline.createdAt).toLocaleDateString()}`}</option>)}</select></label>
        {!events.length && !error ? <p className="empty-state">No public events on this timeline.</p> : <ol className="event-list">{events.map((event) => <li key={event.eventId}><div><strong>{eventName(event.type)}</strong><small>Revision {event.revision} · <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time></small><p>{eventSummary(event)}</p></div><button className="ghost" onClick={() => void openReceipt(event.commandId)}>Open public receipt</button></li>)}</ol>}
        {cursor !== null && <button ref={moreRef} className="ghost" disabled={paging} onClick={() => void loadPage(timelineId, cursor, false)}>{paging ? "Loading next events…" : "Load next events"}</button>}
        {receiptError && <p role="status">{receiptError}</p>}{receipt && <article className="receipt-card" tabIndex={-1}><h3>Public command receipt</h3><p>{receipt.type.replaceAll("_", " ")} committed revision {receipt.revisionAfter}.</p><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></article>}
      </section>
      <RecapViewer recaps={recaps} timelines={timelines} activeTimelineId={timelineId} role={role} revision={revision} onCreate={role === "owner" || role === "gm" ? (value) => void createRecap(value) : undefined} />
      <section className="history-panel" aria-labelledby="checkpoint-history-heading"><div className="admin-section-heading"><div><p className="eyebrow">FORK HISTORY</p><h2 id="checkpoint-history-heading">Checkpoints and timelines</h2></div></div><CheckpointTimeline timelines={timelines} activeTimelineId={timelineId} checkpoints={checkpoints} /></section>
    </div>}
  </section></main>;
}
