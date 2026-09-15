import { useEffect, useMemo, useRef, useState } from "react";
import type { AdventureTurnGetResponse, AdventureTurnTranscriptEntry, CampaignDmHistory } from "@velvet/contracts";
import type { AdventureTurnClientBinding } from "../../../api";
import { MechanicReceiptCard, type MechanicReceiptApi } from "./MechanicReceiptCard";
import "./campaignReplay.css";

/** One ordered, player-facing moment reconstructed from durable session history. */
export type ReplayBeat =
  | { kind: "turn"; id: string; at: string; actorId: string; declaration: string; narration: string }
  | { kind: "dm"; id: string; at: string; intent: "open" | "continue"; state: string; narration: string;
    receipts: ReadonlyArray<{ action: string; summary: string }>; blockers: readonly string[] };

/** Merges durable adventure turns and director runs into one chronological session timeline. */
export function buildReplayTimeline(
  dmHistory: CampaignDmHistory | null,
  transcript: readonly AdventureTurnTranscriptEntry[],
): ReplayBeat[] {
  const beats: ReplayBeat[] = transcript.map((entry) => ({ kind: "turn", id: `turn:${entry.turnId}`, at: entry.completedAt,
    actorId: entry.actorId, declaration: entry.declaration, narration: entry.narration }));
  for (const run of dmHistory?.runs ?? []) {
    if (!run.narration && run.receipts.length === 0) continue;
    beats.push({ kind: "dm", id: `dm:${run.runId}`, at: run.createdAt, intent: run.intent, state: run.state,
      narration: run.narration ?? "", receipts: run.receipts, blockers: run.blockers });
  }
  return beats.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}

/** Read-only mechanics reader used to attach authoritative receipts to replayed turns. */
export interface ReplayTraceApi {
  getAdventureTurn: (turnId: string, expected: AdventureTurnClientBinding) => Promise<AdventureTurnGetResponse>;
  getCampaignCommandReceipt: MechanicReceiptApi["getCampaignCommandReceipt"];
}

const REPLAY_STEP_MS = 2600;

export interface CampaignReplayProps {
  campaignId: string;
  sessionId: string;
  dmHistory: CampaignDmHistory | null;
  transcript: readonly AdventureTurnTranscriptEntry[];
  actorNames: ReadonlyMap<string, string>;
  trace?: ReplayTraceApi;
  onExit: () => void;
}

/** Loads and renders one replayed turn's committed mechanics from the authoritative receipt chain. */
function ReplayTurnMechanics({ campaignId, sessionId, actorId, turnId, trace }: {
  campaignId: string; sessionId: string; actorId: string; turnId: string; trace: ReplayTraceApi;
}) {
  const [links, setLinks] = useState<AdventureTurnGetResponse["receipts"] | null>(null);
  useEffect(() => {
    let alive = true;
    trace.getAdventureTurn(turnId, { campaignId, sessionId, actorId, turnId })
      .then((result) => { if (alive) setLinks(result.receipts); })
      .catch(() => { if (alive) setLinks([]); });
    return () => { alive = false; };
  }, [actorId, campaignId, sessionId, trace, turnId]);
  if (!links || links.length === 0) return null;
  return <div className="replay-mechanics"><MechanicReceiptCard campaignId={campaignId} links={links} api={trace} /></div>;
}

/** Steps through a finished or in-progress session as a continuous, natural-game transcript. */
export function CampaignReplay({ campaignId, sessionId, dmHistory, transcript, actorNames, trace, onExit }: CampaignReplayProps) {
  const beats = useMemo(() => buildReplayTimeline(dmHistory, transcript), [dmHistory, transcript]);
  const total = beats.length;
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const seeded = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!seeded.current && total > 0) { seeded.current = true; setPosition(total); return; }
    if (position > total) setPosition(total);
  }, [position, total]);
  useEffect(() => { const log = logRef.current; if (log && position > 0) log.scrollTop = log.scrollHeight; }, [position]);
  useEffect(() => {
    if (!playing) return;
    if (position >= total) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setPosition((value) => Math.min(value + 1, total)), REPLAY_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, position, total]);

  const seek = (next: number) => { setPlaying(false); setPosition(Math.max(0, Math.min(total, next))); };
  const togglePlay = () => setPlaying((value) => { if (!value && position >= total) setPosition(Math.min(1, total)); return !value; });
  const visible = beats.slice(0, position);

  return <section className="campaign-replay" aria-label="Session replay">
    <header className="campaign-replay-controls" role="group" aria-label="Session replay controls">
      <div className="button-row">
        <button type="button" className="ghost" onClick={() => seek(1)} disabled={position <= 1} aria-label="Skip to the first beat">First</button>
        <button type="button" className="ghost" onClick={() => seek(position - 1)} disabled={position <= 0} aria-label="Previous beat">Back</button>
        <button type="button" className="primary" aria-pressed={playing} onClick={togglePlay} disabled={total === 0} aria-label={playing ? "Pause replay" : "Play replay"}>{playing ? "Pause" : "Play"}</button>
        <button type="button" className="ghost" onClick={() => seek(position + 1)} disabled={position >= total} aria-label="Next beat">Forward</button>
        <button type="button" className="ghost" onClick={() => seek(total)} disabled={position >= total} aria-label="Skip to the latest beat">Latest</button>
        <button type="button" className="ghost" onClick={onExit}>Exit replay</button>
      </div>
      <label className="campaign-replay-seek">Beat
        <input type="range" min={0} max={Math.max(total, 1)} value={position} disabled={total === 0}
          onChange={(event) => seek(Number(event.target.value))} aria-label="Replay position" />
        <span aria-live="polite">{position} / {total}</span>
      </label>
    </header>
    <div ref={logRef} className="campaign-conversation-log campaign-replay-log" role="log" aria-label="Replayed session">
      {total === 0 && <p className="quick-empty">No replayable history yet. Open scenes and record adventure turns, then return to replay them.</p>}
      {visible.map((beat) => beat.kind === "turn"
        ? <article className="conversation-turn" key={beat.id}>
            <div className="conversation-exchange declaration"><strong>{actorNames.get(beat.actorId) ?? "Adventurer"}</strong><p>{beat.declaration}</p></div>
            <div className="conversation-exchange dm"><strong>Dungeon Master</strong><p>{beat.narration}</p>
              <time dateTime={beat.at}>{new Date(beat.at).toLocaleString()}</time></div>
            {trace && <ReplayTurnMechanics campaignId={campaignId} sessionId={sessionId} actorId={beat.actorId} turnId={beat.id.slice("turn:".length)} trace={trace} />}
          </article>
        : <article className="conversation-turn" key={beat.id}>
            <div className="conversation-exchange dm"><strong>Dungeon Master</strong>
              <p className="replay-kicker">{beat.intent === "open" ? "Opening scene" : "Scene continuation"}</p>
              {beat.narration && <p>{beat.narration}</p>}
              {beat.receipts.map((receipt, index) => <small className="replay-receipt" key={index}>Committed: {receipt.summary}</small>)}
              {beat.blockers.length > 0 && <small className="replay-blocker">Table note: {beat.blockers.join(" · ")}</small>}
              <time dateTime={beat.at}>{new Date(beat.at).toLocaleString()}</time></div>
          </article>)}
    </div>
  </section>;
}
