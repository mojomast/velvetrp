import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignAdministration, CampaignHistoryHttpCheckpoint, CampaignHistoryHttpEvent, CampaignHistoryHttpEventsQuery, CampaignHistoryHttpEventsResponse, CampaignHistoryHttpPublicReceipt, CampaignHistoryHttpRecap, CampaignHistoryHttpRecapRequest, CampaignHistoryHttpRecapResponse, CampaignHistoryHttpTimeline, CampaignHistoryHttpTimelinesResponse } from "@velvet/contracts";
import { CheckpointTimeline } from "./CheckpointTimeline";
import { RecapViewer } from "./RecapViewer";

const PAGE_SIZE = 25;
function eventName(type: CampaignHistoryHttpEvent["type"]): string {
  return type === "actor_attribute_set" ? "Attribute changed" : type === "actor_resource_initialized" ? "Resource initialized" : "Dice rolled";
}
const REVIEWED_ATTRIBUTE_LABELS: Readonly<Record<string, string>> = {
  might: "Might", agility: "Agility", resolve: "Resolve", insight: "Insight", presence: "Presence", craft: "Craft",
  strength: "Strength", dexterity: "Dexterity", constitution: "Constitution", intelligence: "Intelligence", wisdom: "Wisdom", charisma: "Charisma",
};
const REVIEWED_RESOURCE_LABELS: Readonly<Record<string, string>> = { health: "Hit points", hp: "Hit points", focus: "Focus", stamina: "Stamina", mana: "Mana" };
function neutralLabel(identifier: string): string {
  const words = identifier.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[-_:._\s]+/u).filter(Boolean);
  return words.length ? words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ") : "Campaign value";
}
function presentation(identifier: string, kind: "attribute" | "resource"): { label: string; identifier: string } {
  return { label: (kind === "attribute" ? REVIEWED_ATTRIBUTE_LABELS : REVIEWED_RESOURCE_LABELS)[identifier] ?? neutralLabel(identifier), identifier };
}
function eventSummary(event: CampaignHistoryHttpEvent): { text: string; technicalId?: string } {
  if (event.type === "actor_attribute_set") { const value = presentation(event.data.attributeId, "attribute"); return { text: `${value.label} changed from ${event.data.valueBefore} to ${event.data.valueAfter}.`, technicalId: value.identifier }; }
  if (event.type === "actor_resource_initialized") { const value = presentation(event.data.name, "resource"); return { text: `${value.label} initialized at ${event.data.current} of ${event.data.max}.`, technicalId: value.identifier }; }
  return { text: `Rolled ${event.data.expression}; total ${event.data.total}.` };
}
function receiptDetail(receipt: CampaignHistoryHttpPublicReceipt): string {
  if (receipt.kind === "administration") return `${receipt.type.replaceAll("_", " ")} committed revision ${receipt.revisionAfter}.`;
  const event = receipt.event;
  if (event.type === "actor_attribute_set") { const value = presentation(event.data.attributeId, "attribute"); return `${value.label}: ${event.data.valueBefore} → ${event.data.valueAfter}.`; }
  if (event.type === "actor_resource_initialized") { const value = presentation(event.data.name, "resource"); return `${value.label}: ${event.data.current} of ${event.data.max}.`; }
  return `${event.data.expression} rolled ${event.data.terms.map((term) => term.value).join(", ")} for a total of ${event.data.total}.`;
}

export interface CampaignHistoryApi {
  administration: (campaignId: string) => Promise<{ campaign: CampaignAdministration }>;
  timelines: (campaignId: string) => Promise<CampaignHistoryHttpTimelinesResponse>;
  checkpoints: (campaignId: string) => Promise<{ checkpoints: CampaignHistoryHttpCheckpoint[] }>;
  events: (campaignId: string, query: CampaignHistoryHttpEventsQuery) => Promise<CampaignHistoryHttpEventsResponse>;
  recaps: (campaignId: string) => Promise<{ recaps: CampaignHistoryHttpRecap[] }>;
  receipt: (campaignId: string, commandId: string) => Promise<{ receipt: CampaignHistoryHttpPublicReceipt }>;
  createRecap: (campaignId: string, input: CampaignHistoryHttpRecapRequest) => Promise<CampaignHistoryHttpRecapResponse>;
}
export interface CampaignEventLogPageProps { campaignId: string; api: CampaignHistoryApi; onBack: () => void; onUnavailable: () => void; focusHeadingRequest?: number }
export function CampaignEventLogPage({ campaignId, api, onBack, onUnavailable, focusHeadingRequest }: CampaignEventLogPageProps) {
  const [role, setRole] = useState<CampaignAdministration["actorRole"] | null>(null), [revision, setRevision] = useState(0);
  const [timelines, setTimelines] = useState<CampaignHistoryHttpTimeline[]>([]), [timelineId, setTimelineId] = useState("");
  const [checkpoints, setCheckpoints] = useState<CampaignHistoryHttpCheckpoint[]>([]), [recaps, setRecaps] = useState<CampaignHistoryHttpRecap[]>([]);
  const [events, setEvents] = useState<CampaignHistoryHttpEvent[]>([]), [cursor, setCursor] = useState<number | null>(0);
  const [loading, setLoading] = useState(true), [paging, setPaging] = useState(false), [partial, setPartial] = useState(""), [error, setError] = useState("");
  const [laneStatus, setLaneStatus] = useState<{ events: "loading" | "ready" | "failed"; recaps: "loading" | "ready" | "failed"; checkpoints: "loading" | "ready" | "failed" }>({ events: "loading", recaps: "loading", checkpoints: "loading" });
  const [receipt, setReceipt] = useState<CampaignHistoryHttpPublicReceipt | null>(null), [receiptError, setReceiptError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null), eventsHeadingRef = useRef<HTMLHeadingElement>(null), retryRef = useRef<HTMLButtonElement>(null), moreRef = useRef<HTMLButtonElement>(null), mounted = useRef(true), generation = useRef(0);

  const loadPage = useCallback(async (selectedTimeline: string, after: number, replace: boolean) => {
    const request = ++generation.current; if (replace) setLaneStatus((current) => ({ ...current, events: "loading" })); else setPaging(true); setError("");
    try { const page = await api.events(campaignId, { timelineId: selectedTimeline, afterRevision: after, limit: PAGE_SIZE });
      if (!mounted.current || request !== generation.current) return;
      setEvents((current) => replace ? page.events : [...current, ...page.events]); setCursor(page.nextAfterRevision); setLaneStatus((current) => ({ ...current, events: "ready" })); setPaging(false);
      if (!replace) queueMicrotask(() => (page.nextAfterRevision === null ? eventsHeadingRef.current : moreRef.current)?.focus());
    } catch { if (!mounted.current || request !== generation.current) return; setPaging(false); setCursor(null); setLaneStatus((current) => ({ ...current, events: "failed" })); setPartial("Event history is temporarily unavailable. Retry to load an authoritative page."); queueMicrotask(() => eventsHeadingRef.current?.focus()); }
  }, [api, campaignId]);

  const load = useCallback(async () => {
    const request = ++generation.current; setLoading(true); setError(""); setPartial(""); setLaneStatus({ events: "loading", recaps: "loading", checkpoints: "loading" });
    try {
      const [administration, timelineData] = await Promise.all([api.administration(campaignId), api.timelines(campaignId)]);
      const active = timelineData.activeTimelineId;
      const [checkpointResult, recapResult, eventResult] = await Promise.allSettled([api.checkpoints(campaignId), api.recaps(campaignId), api.events(campaignId, { timelineId: active, afterRevision: 0, limit: PAGE_SIZE })]);
      if (!mounted.current || request !== generation.current) return;
      setRole(administration.campaign.actorRole); setRevision(administration.campaign.revision); setTimelines(timelineData.timelines); setTimelineId(active);
      setCheckpoints(checkpointResult.status === "fulfilled" ? checkpointResult.value.checkpoints : []);
      const roleSafeRecaps = recapResult.status === "fulfilled" ? recapResult.value.recaps.filter((item) => item.visibility === "members" || administration.campaign.actorRole === "owner" || administration.campaign.actorRole === "gm") : [];
      setRecaps(roleSafeRecaps); setEvents(eventResult.status === "fulfilled" ? eventResult.value.events : []); setCursor(eventResult.status === "fulfilled" ? eventResult.value.nextAfterRevision : 0);
      setLaneStatus({ events: eventResult.status === "fulfilled" ? "ready" : "failed", recaps: recapResult.status === "fulfilled" ? "ready" : "failed", checkpoints: checkpointResult.status === "fulfilled" ? "ready" : "failed" });
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
      <section className="history-panel" aria-labelledby="events-heading"><div className="admin-section-heading"><div><p className="eyebrow">STRUCTURED EVENTS</p><h2 ref={eventsHeadingRef} tabIndex={-1} id="events-heading">Event log</h2></div></div>
        <label className="field"><span>Timeline</span><select value={timelineId} onChange={(event) => { const next = event.target.value; setTimelineId(next); setEvents([]); setCursor(null); setReceipt(null); setReceiptError(""); setPartial(""); setLaneStatus((current) => ({ ...current, events: "loading" })); void loadPage(next, 0, true); }}>{timelines.map((timeline) => <option key={timeline.id} value={timeline.id}>{timeline.active ? "Current timeline" : `Fork created ${new Date(timeline.createdAt).toLocaleDateString()}`}</option>)}</select></label>
        {laneStatus.events === "loading" && <p role="status">Loading events for the selected timeline…</p>}
        {laneStatus.events === "failed" && <p role="alert">Events for this timeline are unavailable; no empty history is being inferred.</p>}
        {laneStatus.events === "ready" && !events.length ? <p className="empty-state">No public events on this timeline.</p> : events.length > 0 && <ol className="event-list">{events.map((event) => { const summary = eventSummary(event); return <li key={event.eventId}><div><strong>{eventName(event.type)}</strong><small>Revision {event.revision} · <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time></small><p>{summary.text}</p>{summary.technicalId && <small>Technical identifier: <code>{summary.technicalId}</code></small>}</div><button className="ghost" onClick={() => void openReceipt(event.commandId)}>Open public receipt</button></li>})}</ol>}
        {laneStatus.events === "ready" && cursor !== null && <button ref={moreRef} className="ghost" disabled={paging} onClick={() => void loadPage(timelineId, cursor, false)}>{paging ? "Loading next events…" : "Load next events"}</button>}
        {receiptError && <p role="status">{receiptError}</p>}{receipt && <article className="receipt-card" tabIndex={-1}><h3>Public command receipt</h3><p>{receiptDetail(receipt)}</p><p>Committed revision {receipt.revisionAfter}.</p><time dateTime={receipt.occurredAt}>{new Date(receipt.occurredAt).toLocaleString()}</time></article>}
      </section>
      {laneStatus.recaps === "ready" ? <RecapViewer recaps={recaps} timelines={timelines} activeTimelineId={timelineId} role={role} revision={revision} onCreate={role === "owner" || role === "gm" ? (value) => void createRecap(value) : undefined} /> : <section className="history-panel" aria-labelledby="recaps-unavailable-heading"><h2 id="recaps-unavailable-heading">Campaign recaps</h2><p role={laneStatus.recaps === "failed" ? "alert" : "status"}>{laneStatus.recaps === "failed" ? "Recaps are unavailable; no empty recap list is being inferred." : "Loading recaps…"}</p></section>}
      <section className="history-panel" aria-labelledby="checkpoint-history-heading"><div className="admin-section-heading"><div><p className="eyebrow">FORK HISTORY</p><h2 id="checkpoint-history-heading">Checkpoints and timelines</h2></div></div>{laneStatus.checkpoints === "ready" ? <CheckpointTimeline timelines={timelines} activeTimelineId={timelineId} checkpoints={checkpoints} /> : <p role={laneStatus.checkpoints === "failed" ? "alert" : "status"}>{laneStatus.checkpoints === "failed" ? "Checkpoints are unavailable; no empty checkpoint history is being inferred." : "Loading checkpoints…"}</p>}</section>
    </div>}
  </section></main>;
}
