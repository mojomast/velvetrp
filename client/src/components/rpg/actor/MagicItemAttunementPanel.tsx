import { useCallback, useEffect, useState } from "react";
import type { AttunementCommand, AttunementResponse, AttunementSnapshot } from "@velvet/contracts";
import { commandActorAttunement, getActorAttunements } from "../../../api";

export interface AttunementCandidate {
  definitionId: string;
  name: string;
  prerequisite: "short-rest" | "long-rest";
}

export interface AttunementPanelApi {
  getActorAttunements: (campaignId: string, actorId: string) => Promise<AttunementSnapshot>;
  commandActorAttunement: (campaignId: string, actorId: string, command: AttunementCommand) => Promise<AttunementResponse>;
}

export interface MagicItemAttunementPanelProps {
  campaignId: string;
  actorId: string;
  disabled?: boolean;
  candidates?: readonly AttunementCandidate[];
  api?: AttunementPanelApi;
}

const REST_OPTIONS = [
  { value: "none", label: "No rest completed" },
  { value: "short-rest", label: "Short rest" },
  { value: "long-rest", label: "Long rest" },
] as const;

type CompletedRest = (typeof REST_OPTIONS)[number]["value"];

const DEFAULT_API: AttunementPanelApi = { getActorAttunements, commandActorAttunement };

/** Reads and edits the SRD-attunable magic items of one actor (maximum of three). */
export function MagicItemAttunementPanel({ campaignId, actorId, disabled = false, candidates = [], api = DEFAULT_API }: MagicItemAttunementPanelProps) {
  const [snapshot, setSnapshot] = useState<AttunementSnapshot | null>(null);
  const [completedRest, setCompletedRest] = useState<CompletedRest>("none");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    setMessage("");
    api.getActorAttunements(campaignId, actorId)
      .then((value) => { if (active) setSnapshot(value); })
      .catch(() => { if (active) { setSnapshot(null); setMessage("Attunements could not be loaded."); } });
    return () => { active = false; };
  }, [api, campaignId, actorId]);

  const apply = useCallback(async (command: AttunementCommand) => {
    setPending(true);
    setMessage("");
    try {
      const response = await api.commandActorAttunement(campaignId, actorId, command);
      setSnapshot(response.snapshot);
      if (!response.ok) setMessage(`Attunement rejected: ${response.code ?? "unknown"}.`);
    } catch {
      setMessage("The attunement command could not be completed.");
    } finally {
      setPending(false);
    }
  }, [api, campaignId, actorId]);

  const attuned = new Set((snapshot?.attunements ?? []).map((entry) => entry.definition.definitionId));
  const busy = disabled || pending;
  const satisfiedRest = completedRest === "none" ? null : completedRest;

  return (
    <section className="actor-section" aria-labelledby="attunement-heading">
      <div className="actor-section-heading">
        <h2 id="attunement-heading">Magic-item attunement</h2>
        <span className="status-pill">{snapshot ? `${snapshot.attunements.length} / ${snapshot.limit}` : "…"}</span>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {snapshot ? (
        snapshot.attunements.length ? (
          <ul className="compact-server-list">
            {snapshot.attunements.map((entry) => (
              <li key={entry.key}>
                <span>{entry.definition.definitionId}</span>
                <button className="ghost" type="button" disabled={busy} onClick={() => void apply({ command: "drop", key: entry.key })}>
                  Drop attunement
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="actor-empty">No items are attuned.</p>
      ) : <p className="actor-empty" role="status">Loading attunements…</p>}
      {candidates.length ? (
        <div className="attunement-candidates">
          <label htmlFor="attunement-rest">Completed rest</label>
          <select id="attunement-rest" value={completedRest} disabled={busy} onChange={(event) => setCompletedRest(event.target.value as CompletedRest)}>
            {REST_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <ul className="compact-server-list">
            {candidates.map((candidate) => (
              <li key={candidate.definitionId}>
                <span>{candidate.name} <span className="status-pill">{candidate.prerequisite}</span></span>
                <button className="ghost" type="button" disabled={busy || attuned.has(candidate.definitionId)}
                  onClick={() => void apply({ command: "attune", key: candidate.definitionId, definitionId: candidate.definitionId, satisfiedRest })}>
                  {attuned.has(candidate.definitionId) ? "Attuned" : "Attune"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
