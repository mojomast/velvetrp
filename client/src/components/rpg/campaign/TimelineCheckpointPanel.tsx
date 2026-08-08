import { useEffect, useState, type FormEvent } from "react";
import type { CampaignHistoryHttpCheckpoint, CampaignHistoryHttpTimeline } from "@velvet/contracts";
import { CheckpointTimeline } from "../history/CheckpointTimeline";

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

  function create(event: FormEvent) {
    event.preventDefault();
    if (!active || !confirmed || !label.trim() || busy || mutationLocked) return;
    onCreateCheckpoint(label.trim(), active.id, active.revision);
    setLabel(""); setConfirmed(false);
  }

  return <section className="admin-section" aria-labelledby="timeline-heading">
    <div className="admin-section-heading"><div><p className="eyebrow">CANON</p><h2 id="timeline-heading">Timeline checkpoints</h2></div><span className="status-pill">Revision {active?.revision ?? "—"}</span></div>
    <p className="admin-help">Checkpoints preserve canonical state.</p>
    {canMutate && active && <form className="checkpoint-create" onSubmit={create}>
      <label className="field"><span>Checkpoint label</span><input required maxLength={200} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label className="checkbox admin-checkbox"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I understand this captures active revision {active.revision}.</span></label>
      <button className="primary" type="submit" disabled={busy || mutationLocked || !confirmed || !label.trim()}>Create checkpoint</button>
    </form>}
    <CheckpointTimeline timelines={timelines} activeTimelineId={activeTimelineId} checkpoints={checkpoints} canFork={canMutate} disabled={busy || mutationLocked} onFork={onFork} />
  </section>;
}
