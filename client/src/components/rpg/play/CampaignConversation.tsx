import type { AdventureTurnGetResponse, AdventureTurnStreamEvent, AdventureTurnTranscriptEntry, CampaignDmHistory } from "@velvet/contracts";
import type { ChatMessage } from "../../../api";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConversationText, SpeakerName } from "./ConversationText";
import { SentSheetContext } from "./SheetContextList";

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
  /** Public Director narration joins the main story; private proposals never enter this feed. */
  directorHistory?: CampaignDmHistory | null;
  emptyState?: ReactNode;
  storyMode?: boolean;
  visible?: boolean;
}

const statusLabel = (status: string) => status.replaceAll("-", " ");

/** One chronological, read-only rendering of legacy history, durable turns, and live delivery. */
export function CampaignConversation({ transcript, transcriptState, legacyMessages, legacyParticipants, current, liveEvents,
  actorNames, onPrefillChoice, canPrefill, directorHistory, emptyState, storyMode = false, visible = true }: CampaignConversationProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const liveTurn = [...liveEvents].reverse().find((event) => event.type === "turn_started");
  const activeTurn = liveTurn?.type === "turn_started" ? liveTurn.payload.turn : current?.turn ?? null;
  const represented = activeTurn && transcript.some((entry) => entry.turnId === activeTurn.turnId || entry.turnId === activeTurn.priorTurnId);
  const narration = liveEvents.filter((event) => event.type === "narration_delta").map((event) => event.payload.text).join("")
    || (!represented ? current?.narrationStatus.text ?? "" : "");
  const proposals = liveEvents.filter((event) => event.type === "tool_proposed");
  const receipts = liveEvents.filter((event) => event.type === "mechanics_committed").flatMap((event) => event.payload.receipts);
  const choices = liveEvents.filter((event) => event.type === "choice").flatMap((event) => event.payload.choices);
  const confirmation = [...liveEvents].reverse().find((event) => event.type === "confirmation_required");
  const terminal = [...liveEvents].reverse().find((event) => event.type === "terminal");
  const latestStatus = [...liveEvents].reverse().find((event) => event.type === "agent_status");
  const legacySpeaker = (message: ChatMessage) => message.role === "user" ? "Player" : message.role === "system" ? "System"
    : legacyParticipants.find((participant) => participant.id === message.speakerCharacterId)?.name ?? "Character";
  const story = [
    ...transcript.map((entry) => ({ key: `turn:${entry.turnId}`, at: entry.completedAt, content: <article className="conversation-turn"><div className="conversation-exchange declaration"><SpeakerName identity={entry.actorId} name={actorNames.get(entry.actorId) ?? "Adventurer"} /><ConversationText text={entry.declaration} kind="action" /><SentSheetContext entries={entry.sheetContext} /></div><div className="conversation-exchange dm"><SpeakerName identity="dungeon-master" name="Dungeon Master" /><ConversationText text={entry.narration} kind="narration" /><time dateTime={entry.completedAt}>{new Date(entry.completedAt).toLocaleString()}</time></div></article> })),
    ...(directorHistory?.runs ?? []).filter((run) => run.narration).map((run) => ({ key: `dm:${run.runId}`, at: run.createdAt, content: <article className="conversation-exchange dm director-story-entry"><SpeakerName identity="dungeon-master" name={run.intent === "open" ? "Dungeon Master · Opening scene" : "Dungeon Master · Scene continuation"} /><ConversationText text={run.narration!} kind="narration" />{run.receipts.length > 0 && <details className="sent-sheet-context"><summary>Scene results · {run.receipts.length}</summary><ul>{run.receipts.map((receipt, index) => <li key={index}>{receipt.summary}</li>)}</ul></details>}</article> })),
  // Stable ties preserve the transcript's server-provided order.
  ].sort((a, b) => a.at.localeCompare(b.at));
  useEffect(() => { const log = logRef.current; if (visible && log && log.clientHeight > 0 && followLatestRef.current) log.scrollTop = log.scrollHeight; }, [liveEvents.length, transcript, directorHistory, visible]);

  return <section className="campaign-conversation" aria-labelledby="campaign-conversation-heading">
    <header><div>{!storyMode && <p className="eyebrow">AUTHORITATIVE ADVENTURE</p>}<h2 id="campaign-conversation-heading">{storyMode ? "The story so far" : "Campaign conversation"}</h2></div>
      {transcriptState === "loading" && <span role="status">Loading transcript...</span>}
      {transcriptState === "error" && <span role="alert">Transcript unavailable.</span>}</header>
    <div ref={logRef} className="campaign-conversation-log" role="log" aria-live="polite" aria-busy={transcriptState === "loading"}
      tabIndex={0} aria-label="Adventure history" onScroll={(event) => { const log = event.currentTarget; followLatestRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48; setFollowing(followLatestRef.current); }}>
      {legacyMessages.length > 0 && <section className="legacy-campaign-history" aria-labelledby="legacy-campaign-history-heading"><h3 id="legacy-campaign-history-heading">Read-only pre-campaign history</h3><p>These legacy room messages are historical context only. Continue play with the action composer below.</p>
        {legacyMessages.map((message) => <article className="conversation-exchange legacy" key={message.id}><SpeakerName identity={message.speakerCharacterId ?? message.role} name={legacySpeaker(message)} /><ConversationText text={message.content} kind={message.role === "system" ? "system" : "dialogue"} /></article>)}</section>}
      {story.map((entry) => <div className="story-entry" key={entry.key}>{entry.content}</div>)}
      {transcriptState === "ready" && transcript.length === 0 && legacyMessages.length === 0 && !activeTurn && (emptyState ?? <p className="quick-empty">The adventure is ready for its first declaration.</p>)}
      {activeTurn && !represented && <article className="conversation-turn is-current"><div className="conversation-exchange declaration"><SpeakerName identity={activeTurn.actorId} name={actorNames.get(activeTurn.actorId) ?? "Adventurer"} /><ConversationText text={activeTurn.declaration} kind="action" /><SentSheetContext entries={activeTurn.sheetContext} /></div>
        <div className="conversation-exchange dm"><SpeakerName identity="dungeon-master" name="Dungeon Master" />{latestStatus?.type === "agent_status" && <p className="live-agent-status">{statusLabel(latestStatus.payload.status)}...</p>}
          {proposals.map((event) => <p className="live-proposal" key={event.payload.proposal.proposalId}>Proposed mechanic: {statusLabel(event.payload.proposal.toolName)}</p>)}
          {confirmation?.type === "confirmation_required" && <p className="live-confirmation">Waiting for confirmation of {confirmation.payload.proposalIds.length} proposed {confirmation.payload.proposalIds.length === 1 ? "action" : "actions"}.</p>}
          {receipts.length > 0 && <p className="live-receipts">{receipts.length} mechanic {receipts.length === 1 ? "receipt" : "receipts"} committed.</p>}
          {narration ? <ConversationText text={narration} kind="narration" /> : <p className="live-narration-placeholder">Awaiting narration...</p>}
          {choices.length > 0 && <div className="conversation-choices" aria-label="Suggested next actions">{choices.map((choice, index) => <button type="button" className="ghost" key={`${choice.family}:${choice.label}:${index}`} aria-label={`Suggested action: ${choice.label}`} disabled={!canPrefill} onClick={() => onPrefillChoice(choice.label)}>{choice.label}</button>)}</div>}
          {terminal?.type === "terminal" && <p className="live-terminal">Turn {terminal.payload.outcome}.</p>}
        </div></article>}
      {represented && choices.length > 0 && <div className="conversation-choices durable-choices" aria-label="Suggested next actions">{choices.map((choice, index) => <button type="button" className="ghost" key={`${choice.family}:${choice.label}:${index}`} aria-label={`Suggested action: ${choice.label}`} disabled={!canPrefill} onClick={() => onPrefillChoice(choice.label)}>{choice.label}</button>)}</div>}
    </div>
    {!following && <button type="button" className="ghost conversation-jump" onClick={() => { const log = logRef.current; if (log) log.scrollTop = log.scrollHeight; followLatestRef.current = true; setFollowing(true); }}>Jump to latest</button>}
  </section>;
}
