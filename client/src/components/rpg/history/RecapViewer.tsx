import { useMemo, useState, type FormEvent } from "react";
import type { CampaignAdministration, CampaignHistoryHttpRecap, CampaignHistoryHttpTimeline } from "@velvet/contracts";

type CampaignRecapVisibility = "members" | "gm-only";

export interface RecapViewerProps {
  recaps: CampaignHistoryHttpRecap[];
  timelines: CampaignHistoryHttpTimeline[];
  activeTimelineId: string;
  role: CampaignAdministration["actorRole"];
  revision: number;
  busy?: boolean;
  onCreate?: (value: { timelineId: string; throughRevision: number; selectedSessionIds: string[]; visibility: CampaignRecapVisibility; text: string }) => void;
}

export function RecapViewer({ recaps, timelines, activeTimelineId, role, revision, busy = false, onCreate }: RecapViewerProps) {
  // Fail closed if an upstream projection ever includes GM-only material.
  const visible = useMemo(() => recaps.filter((recap) => recap.visibility === "members" || role === "owner" || role === "gm")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [recaps, role]);
  const [selected, setSelected] = useState(visible[0]?.id ?? "");
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<CampaignRecapVisibility>("members");
  const active = visible.find((recap) => recap.id === selected) ?? visible[0] ?? null;
  const canCreate = (role === "owner" || role === "gm") && onCreate !== undefined;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate || busy || !text.trim()) return;
    const timeline = timelines.find((entry) => entry.id === activeTimelineId);
    onCreate({ timelineId: activeTimelineId, throughRevision: timeline?.revision ?? 0, selectedSessionIds: [], visibility, text: text.trim() });
  }
  return <section className="history-panel" aria-labelledby="recaps-heading">
    <div className="admin-section-heading"><div><p className="eyebrow">ROLE-SAFE SUMMARY</p><h2 id="recaps-heading">Campaign recaps</h2></div></div>
    {visible.length === 0 ? <p className="empty-state">No recaps are available for your role.</p> : <div className="recap-layout">
      <label className="field"><span>Recap</span><select value={active?.id ?? ""} onChange={(event) => setSelected(event.target.value)}>{visible.map((recap) => <option value={recap.id} key={recap.id}>{new Date(recap.createdAt).toLocaleDateString()} · through revision {recap.throughRevision}</option>)}</select></label>
      {active && <article className="recap-copy" tabIndex={0}><p className="meta-text">{active.visibility === "gm-only" ? "GM-only recap" : "Campaign member recap"} · <time dateTime={active.createdAt}>{new Date(active.createdAt).toLocaleString()}</time></p><p>{active.text}</p></article>}
    </div>}
    {canCreate && <form className="studio-form recap-create" onSubmit={submit}>
      <h3>Create a recap</h3><p className="admin-help">The recap is attached to the current timeline at campaign revision {revision}. No private data is added automatically.</p>
      <label>Audience<select value={visibility} onChange={(event) => setVisibility(event.target.value as CampaignRecapVisibility)}><option value="members">All campaign members</option><option value="gm-only">Owners and GMs only</option></select></label>
      <label>Exact recap text<textarea required maxLength={50_000} rows={7} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <button className="primary" disabled={busy || !text.trim()}>Create recap</button>
    </form>}
  </section>;
}
