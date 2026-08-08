import { useMemo } from "react";
import type { CampaignHistoryHttpCheckpoint, CampaignHistoryHttpTimeline } from "@velvet/contracts";

export interface CheckpointTimelineProps {
  timelines: CampaignHistoryHttpTimeline[];
  activeTimelineId: string;
  checkpoints: CampaignHistoryHttpCheckpoint[];
  canFork?: boolean;
  disabled?: boolean;
  onFork?: (checkpoint: CampaignHistoryHttpCheckpoint) => void;
}

/** Shared read model for administration and history; fork semantics live here once. */
export function CheckpointTimeline({ timelines, activeTimelineId, checkpoints, canFork = false, disabled = false, onFork }: CheckpointTimelineProps) {
  const ordered = useMemo(() => [...checkpoints].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [checkpoints]);
  const names = new Map(timelines.map((timeline, index) => [timeline.id, timeline.id === activeTimelineId ? "Current timeline" : `Earlier timeline ${index + 1}`]));
  return <div className="checkpoint-timeline">
    <p className="fork-explanation"><strong>Restore means create a new fork.</strong> The current and earlier timelines remain unchanged; restoring a checkpoint never erases history.</p>
    {ordered.length === 0 ? <p className="empty-state">No checkpoints yet. History is still retained on the current timeline.</p> : <ol className="checkpoint-list">
      {ordered.map((checkpoint) => <li key={checkpoint.id}>
        <div><strong>{checkpoint.label}</strong><small>{names.get(checkpoint.timelineId) ?? "Earlier timeline"} · revision {checkpoint.timelineRevision} · <time dateTime={checkpoint.createdAt}>{new Date(checkpoint.createdAt).toLocaleString()}</time></small></div>
        {canFork && onFork && <button type="button" className="ghost" disabled={disabled} onClick={() => {
          if (window.confirm(`Create a new fork from “${checkpoint.label}”? Nothing in current or earlier history will be erased.`)) onFork(checkpoint);
        }}>Restore as new fork</button>}
      </li>)}
    </ol>}
  </div>;
}
