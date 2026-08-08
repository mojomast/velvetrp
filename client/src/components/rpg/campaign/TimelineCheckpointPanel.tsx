import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { CampaignHistoryHttpCheckpoint, CampaignHistoryHttpTimeline } from "@velvet/contracts";

export interface TimelineCheckpointPanelProps {
  timelines: CampaignHistoryHttpTimeline[];
  activeTimelineId: string;
  checkpoints: CampaignHistoryHttpCheckpoint[];
  canMutate: boolean;
  busy: boolean;
  mutationLocked: boolean;
  onCreateCheckpoint: (label: string, timelineId: string, timelineRevision: number) => void;
  onFork: (checkpoint: CampaignHistoryHttpCheckpoint) => void;
}

export function TimelineCheckpointPanel({ timelines, activeTimelineId, checkpoints, canMutate, busy, mutationLocked, onCreateCheckpoint, onFork }: TimelineCheckpointPanelProps) {
  const active = timelines.find((timeline) => timeline.id === activeTimelineId) ?? null;
  const [label, setLabel] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setLabel(""); setConfirmed(false); }, [activeTimelineId, active?.revision]);
  const ordered = useMemo(() => [...checkpoints].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [checkpoints]);

  function create(event: FormEvent) {
    event.preventDefault();
    if (!active || !confirmed || !label.trim() || busy || mutationLocked) return;
    onCreateCheckpoint(label.trim(), active.id, active.revision);
    setLabel(""); setConfirmed(false);
  }

  return <section className="admin-section" aria-labelledby="timeline-heading">
    <div className="admin-section-heading"><div><p className="eyebrow">CANON</p><h2 id="timeline-heading">Timeline checkpoints</h2></div><span className="status-pill">Revision {active?.revision ?? "—"}</span></div>
    <p className="admin-help">Checkpoints preserve canonical state. Restoring one creates a new timeline fork and never erases history.</p>
    {canMutate && active && <form className="checkpoint-create" onSubmit={create}>
      <label className="field"><span>Checkpoint label</span><input required maxLength={200} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label className="checkbox admin-checkbox"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I understand this captures active revision {active.revision}.</span></label>
      <button className="primary" type="submit" disabled={busy || mutationLocked || !confirmed || !label.trim()}>Create checkpoint</button>
    </form>}
    {ordered.length === 0 ? <p className="empty-state">No checkpoints yet.</p> : <ol className="checkpoint-list">
      {ordered.map((checkpoint) => <li key={checkpoint.id}>
        <div><strong>{checkpoint.label}</strong><small>Timeline revision {checkpoint.timelineRevision} · {new Date(checkpoint.createdAt).toLocaleString()}</small></div>
        {canMutate && <button className="ghost" disabled={busy || mutationLocked} onClick={() => {
          if (window.confirm(`Fork from “${checkpoint.label}”? Current history remains unchanged.`)) onFork(checkpoint);
        }}>Fork from checkpoint</button>}
      </li>)}
    </ol>}
  </section>;
}
