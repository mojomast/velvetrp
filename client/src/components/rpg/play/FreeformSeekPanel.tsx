import { useState } from "react";
import {
  ApiError,
  type FreeformFactionHttpRequest,
  type FreeformFactionHttpResponse,
  type FreeformFactionNoneReason,
  type FreeformQuestHttpRequest,
  type FreeformQuestHttpResponse,
  type FreeformQuestNoneReason,
  type FreeformRumorHttpRequest,
  type FreeformRumorHttpResponse,
  type FreeformRumorNoneReason,
} from "../../../api";

/** The three bounded free-form lanes an authorized GM may seek once. */
export type FreeformSeekKind = "faction" | "quest" | "rumor";

/** Narrow transport surface the panel needs; every method is one strict API wrapper. */
export interface FreeformSeekApi {
  seekFaction: (campaignId: string, sessionId: string, actorId: string, input: FreeformFactionHttpRequest) => Promise<FreeformFactionHttpResponse>;
  seekQuest: (campaignId: string, sessionId: string, actorId: string, input: FreeformQuestHttpRequest) => Promise<FreeformQuestHttpResponse>;
  seekRumor: (campaignId: string, sessionId: string, actorId: string, input: FreeformRumorHttpRequest) => Promise<FreeformRumorHttpResponse>;
}

export interface FreeformSeekPanelProps {
  campaignId: string;
  sessionId: string;
  /** The actor the seek command is bound to: the GM's selected actor. */
  actorId: string | null;
  /** GM only; any other audience renders nothing. */
  audience: "gm" | "player";
  disabled?: boolean;
  api: FreeformSeekApi;
}

type Notice = { kind: "status" | "error"; text: string };

const factionDecline: Record<FreeformFactionNoneReason, string> = {
  "no-faction-intent": "The declaration did not name a faction, order, or guild. No faction was materialized.",
  "empty-name": "The named faction had no usable name. No faction was materialized.",
  "name-too-long": "The faction name was too long. No faction was materialized.",
  "not-a-faction": "The declaration did not describe a faction, order, or guild. No faction was materialized.",
  "known-faction": "That faction is already known canon. Nothing new was materialized.",
};

const questDecline: Record<FreeformQuestNoneReason, string> = {
  "no-quest-intent": "The declaration did not ask for work, a job, or a lead. No quest was materialized.",
  "empty-lead": "The lead was empty. No quest was materialized.",
  "lead-too-long": "The lead was too long. No quest was materialized.",
  "known-quest": "That work is already known canon. Nothing new was materialized.",
  "no-current-location": "No current public location grounds a new quest. No quest was materialized.",
  "current-location-unmapped": "The current location has no public mapping, so no quest could be placed. No quest was materialized.",
};

const rumorDecline: Record<FreeformRumorNoneReason, string> = {
  "no-rumor-intent": "The declaration was not a request to listen or gather gossip. No rumor was materialized.",
  "empty-subject": "The rumor subject was empty. No rumor was materialized.",
  "subject-too-long": "The rumor subject was too long. No rumor was materialized.",
  "known-rumor": "That subject is already known canon. Nothing new was materialized.",
  "no-current-location": "No current public location grounds new hearsay. No rumor was materialized.",
  "current-location-unmapped": "The current location has no public mapping, so no rumor could be placed. No rumor was materialized.",
};

function factionOutcome(response: FreeformFactionHttpResponse): string {
  if (response.classification.intent === "none") return factionDecline[response.classification.reason];
  const materialization = response.materialization;
  if (materialization?.status === "materialized") return `Materialized faction "${materialization.candidate.name}". The server owns its public state and separate GM agenda.`;
  if (materialization?.status === "declined") return factionDecline[materialization.reason];
  return "The server classified a faction to materialize but returned no materialization. Nothing was retried.";
}

function questOutcome(response: FreeformQuestHttpResponse): string {
  if (response.classification.intent === "none") return questDecline[response.classification.reason];
  const materialization = response.materialization;
  if (materialization?.status === "materialized") return `Materialized quest "${materialization.candidate.title}". The server owns its public objectives and separate GM twist.`;
  if (materialization?.status === "declined") return questDecline[materialization.reason];
  return "The server classified a quest to materialize but returned no materialization. Nothing was retried.";
}

function rumorOutcome(response: FreeformRumorHttpResponse): string {
  if (response.classification.intent === "none") return rumorDecline[response.classification.reason];
  const materialization = response.materialization;
  if (materialization?.status === "materialized") return `Materialized rumor "${materialization.candidate.subject}". The server owns the public hearsay and separate GM truth.`;
  if (materialization?.status === "declined") return rumorDecline[materialization.reason];
  return "The server classified a rumor to materialize but returned no materialization. Nothing was retried.";
}

function failureNotice(error: unknown, operation: string): Notice {
  if (error instanceof ApiError) {
    if (error.status >= 500) return { kind: "error", text: `The ${operation} outcome may be unknown. It will not be retried; reconcile authoritative state before continuing.` };
    if (error.status === 409) return { kind: "error", text: `The ${operation} conflicts with current campaign state. Nothing was retried; refresh before trying again.` };
    if (error.status === 400) return { kind: "error", text: `The ${operation} was rejected before dispatch. Nothing was changed.` };
    if (error.status === 403 || error.status === 404) return { kind: "error", text: `The ${operation} is unavailable with your current access or exact identifiers. Nothing was changed.` };
  }
  return { kind: "error", text: `The ${operation} could not be completed. Nothing was retried.` };
}

/**
 * Explicit GM action that asks the server to materialize one bounded faction,
 * quest, or rumor it does not already know. Submitting calls exactly one of the
 * three free-form routes once with the entered `text` and surfaces the
 * classification and materialization (including decline reasons and blockers).
 * Nothing here fires on mount or navigation, and no command is ever retried.
 */
export function FreeformSeekPanel({ campaignId, sessionId, actorId, audience, disabled = false, api }: FreeformSeekPanelProps) {
  const [kind, setKind] = useState<FreeformSeekKind>("faction");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (audience !== "gm") return null;
  const blocked = disabled || !actorId || busy;

  async function submit() {
    if (blocked || !actorId) return;
    const phrase = text.trim();
    if (phrase.length === 0) return;
    setBusy(true); setNotice(null);
    try {
      const outcome = kind === "faction"
        ? factionOutcome(await api.seekFaction(campaignId, sessionId, actorId, { text: phrase }))
        : kind === "quest"
          ? questOutcome(await api.seekQuest(campaignId, sessionId, actorId, { text: phrase }))
          : rumorOutcome(await api.seekRumor(campaignId, sessionId, actorId, { text: phrase }));
      setNotice({ kind: "status", text: outcome });
    } catch (error) {
      setNotice(failureNotice(error, `seek ${kind}`));
    } finally {
      setBusy(false);
    }
  }

  return <section className="freeform-seek" aria-labelledby="freeform-seek-heading">
    <div className="actor-section-heading"><h2 id="freeform-seek-heading">Seek new mechanics</h2></div>
    <p className="actor-help">Ask the server to materialize one faction, quest, or rumor it does not already know. Submitting issues one command; it is never retried automatically.</p>
    <label className="field">Mechanic to seek
      <select aria-label="Mechanic to seek" value={kind} onChange={(event) => { setKind(event.target.value as FreeformSeekKind); setNotice(null); }}>
        <option value="faction">Faction</option>
        <option value="quest">Quest</option>
        <option value="rumor">Rumor</option>
      </select>
    </label>
    <label className="field">What to seek
      <input aria-label="What to seek" value={text} maxLength={2_000}
        onChange={(event) => { setText(event.target.value); setNotice(null); }} />
    </label>
    <button type="button" className="primary" disabled={blocked || text.trim().length === 0} onClick={() => void submit()}>
      {busy ? `Seeking ${kind}...` : `Seek ${kind}`}
    </button>
    {!actorId && <p className="actor-help">Select an acting character before seeking a mechanic.</p>}
    {notice && <p role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>}
  </section>;
}
