import type { AdventureTurnGetResponse, AdventureTurnStreamEvent, AdventureTurnTranscriptEntry } from "@velvet/contracts";
import type { ChatMessage } from "../../../api";
import { useEffect, useRef } from "react";

export interface CampaignConversationProps {
  transcript: readonly AdventureTurnTranscriptEntry[];
  transcriptState: "loading" | "ready" | "error";
  legacyMessages: readonly ChatMessage[];
  legacyParticipants: readonly { id: string; name: string }[];
  current: AdventureTurnGetResponse | null;
  liveEvents: readonly AdventureTurnStreamEvent[];
  actorNames: ReadonlyMap<string, string>;
  onPrefillChoice: (choice: string) => void;
  canPrefill: boolean;
}

const statusLabel = (status: string) => status.replaceAll("-", " ");

/** One chronological, read-only rendering of legacy history, durable turns, and live delivery. */
export function CampaignConversation({ transcript, transcriptState, legacyMessages, legacyParticipants, current, liveEvents,
  actorNames, onPrefillChoice, canPrefill }: CampaignConversationProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const liveTurn = [...liveEvents].reverse().find((event) => event.type === "turn_started");
  const activeTurn = liveTurn?.type === "turn_started" ? liveTurn.payload.turn : current?.turn ?? null;
  const represented = activeTurn && transcript.some((entry) => entry.turnId === activeTurn.turnId || entry.turnId === activeTurn.priorTurnId);
  const narration = liveEvents.filter((event) => event.type === "narration_delta").map((event) => event.payload.text).join("")
    || (!represented ? current?.narrationStatus.text ?? "" : "");
  const proposals = liveEvents.filter((event) => event.type === "tool_proposed");
  const receipts = liveEvents.filter((event) => event.type === "mechanics_committed").flatMap((event) => event.payload.receipts);
  const choices = liveEvents.filter((event) => event.type === "choice");
  const confirmation = [...liveEvents].reverse().find((event) => event.type === "confirmation_required");
  const terminal = [...liveEvents].reverse().find((event) => event.type === "terminal");
  const latestStatus = [...liveEvents].reverse().find((event) => event.type === "agent_status");
  const legacySpeaker = (message: ChatMessage) => message.role === "user" ? "Player" : message.role === "system" ? "System"
    : legacyParticipants.find((participant) => participant.id === message.speakerCharacterId)?.name ?? "Character";
  useEffect(() => { const log = logRef.current; if (log) log.scrollTop = log.scrollHeight; }, [liveEvents.length, transcript.length]);

  return <section className="campaign-conversation" aria-labelledby="campaign-conversation-heading">
    <header><div><p className="eyebrow">AUTHORITATIVE ADVENTURE</p><h2 id="campaign-conversation-heading">Campaign conversation</h2></div>
      {transcriptState === "loading" && <span role="status">Loading transcript...</span>}
      {transcriptState === "error" && <span role="alert">Transcript unavailable.</span>}</header>
    <div ref={logRef} className="campaign-conversation-log" role="log" aria-live="polite" aria-busy={transcriptState === "loading"}>
      {legacyMessages.length > 0 && <section className="legacy-campaign-history" aria-labelledby="legacy-campaign-history-heading"><h3 id="legacy-campaign-history-heading">Read-only pre-campaign history</h3><p>These legacy room messages are historical context only. Continue play with the action composer below.</p>
        {legacyMessages.map((message) => <article className="conversation-exchange legacy" key={message.id}><strong>{legacySpeaker(message)}</strong><p>{message.content}</p></article>)}</section>}
      {transcript.map((entry) => <article className="conversation-turn" key={entry.turnId}><div className="conversation-exchange declaration"><strong>{actorNames.get(entry.actorId) ?? "Adventurer"}</strong><p>{entry.declaration}</p></div><div className="conversation-exchange dm"><strong>Dungeon Master</strong><p>{entry.narration}</p><time dateTime={entry.completedAt}>{new Date(entry.completedAt).toLocaleString()}</time></div></article>)}
      {transcriptState === "ready" && transcript.length === 0 && legacyMessages.length === 0 && !activeTurn && <p className="quick-empty">The adventure is ready for its first declaration.</p>}
      {activeTurn && !represented && <article className="conversation-turn is-current"><div className="conversation-exchange declaration"><strong>{actorNames.get(activeTurn.actorId) ?? "Adventurer"}</strong><p>{activeTurn.declaration}</p></div>
        <div className="conversation-exchange dm"><strong>Dungeon Master</strong>{latestStatus?.type === "agent_status" && <p className="live-agent-status">{statusLabel(latestStatus.payload.status)}...</p>}
          {proposals.map((event) => <p className="live-proposal" key={event.payload.proposal.proposalId}>Proposed mechanic: {statusLabel(event.payload.proposal.toolName)}</p>)}
          {confirmation?.type === "confirmation_required" && <p className="live-confirmation">Waiting for confirmation of {confirmation.payload.proposalIds.length} proposed {confirmation.payload.proposalIds.length === 1 ? "action" : "actions"}.</p>}
          {receipts.length > 0 && <p className="live-receipts">{receipts.length} mechanic {receipts.length === 1 ? "receipt" : "receipts"} committed.</p>}
          {narration ? <p>{narration}</p> : <p className="live-narration-placeholder">Awaiting narration...</p>}
          {choices.length > 0 && <div className="conversation-choices" aria-label="Suggested next actions">{choices.map((event) => <button type="button" className="ghost" key={event.payload.choiceId} disabled={!canPrefill} onClick={() => onPrefillChoice(event.payload.label)}>{event.payload.label}</button>)}</div>}
          {terminal?.type === "terminal" && <p className="live-terminal">Turn {terminal.payload.outcome}.</p>}
        </div></article>}
      {represented && choices.length > 0 && <div className="conversation-choices durable-choices" aria-label="Suggested next actions">{choices.map((event) => <button type="button" className="ghost" key={event.payload.choiceId} disabled={!canPrefill} onClick={() => onPrefillChoice(event.payload.label)}>{event.payload.label}</button>)}</div>}
    </div>
  </section>;
}
