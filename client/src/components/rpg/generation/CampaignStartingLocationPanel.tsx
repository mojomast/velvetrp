import { campaignStartingLocationDesignationRequestSchema, type CampaignStartingLocationDesignationRequest, type CampaignStartingLocationReadResponse } from "@velvet/contracts";
import { useEffect, useState } from "react";
import { CampaignStartingLocationHttpError, campaignStartingLocationApi, type CampaignStartingLocationApi } from "./campaignStartingLocationApi";
import { createClientId } from "../../../utils/clientId";

export type StartingLocationCandidate = { locationId: string; name: string };

function operationKey(campaignId: string): string {
  return `velvet.starting-location.v1:${campaignId}`;
}

function createKey(): string {
  return `starting-location-${createClientId()}`;
}

function readIntent(campaignId: string): CampaignStartingLocationDesignationRequest | null {
  const raw = sessionStorage.getItem(operationKey(campaignId));
  if (!raw) return null;
  try { return campaignStartingLocationDesignationRequestSchema.parse(JSON.parse(raw)); }
  catch { return null; }
}

function persistIntent(campaignId: string, intent: CampaignStartingLocationDesignationRequest): void {
  const exact = JSON.stringify(campaignStartingLocationDesignationRequestSchema.parse(intent));
  sessionStorage.setItem(operationKey(campaignId), exact);
  if (sessionStorage.getItem(operationKey(campaignId)) !== exact) throw new Error("Starting-location intent was not durably retained");
}

export function CampaignStartingLocationPanel({ campaignId, candidates, canDesignate, api = campaignStartingLocationApi, onDesignation }: {
  campaignId: string;
  candidates: StartingLocationCandidate[];
  canDesignate: boolean;
  api?: CampaignStartingLocationApi;
  onDesignation?: (value: CampaignStartingLocationReadResponse) => void;
}) {
  const [read, setRead] = useState<CampaignStartingLocationReadResponse | null>(null);
  const [selected, setSelected] = useState("");
  const [intent, setIntent] = useState<CampaignStartingLocationDesignationRequest | null>(() => readIntent(campaignId));
  const [phase, setPhase] = useState<"loading" | "ready" | "sending" | "uncertain" | "retry" | "failed">("loading");
  const [message, setMessage] = useState("");

  async function refresh(showStatus = false): Promise<CampaignStartingLocationReadResponse | null> {
    try {
      const result = await api.getCampaignStartingLocation(campaignId);
      setRead(result);
      onDesignation?.(result);
      if (showStatus) setMessage("Authoritative designation refreshed.");
      return result;
    } catch {
      setMessage("The authoritative starting location could not be read.");
      setPhase("failed");
      return null;
    }
  }

  useEffect(() => {
    let current = true;
    void api.getCampaignStartingLocation(campaignId).then((result) => {
      if (!current) return;
      setRead(result);
      onDesignation?.(result);
      setPhase(readIntent(campaignId) ? "uncertain" : "ready");
      if (readIntent(campaignId)) setMessage("A retained designation command needs authoritative reconciliation. It has not been replayed.");
    }).catch(() => { if (current) { setPhase("failed"); setMessage("The authoritative starting location could not be read."); } });
    return () => { current = false; };
  }, [api, campaignId]);

  function clearIntent(): void {
    sessionStorage.removeItem(operationKey(campaignId));
    setIntent(null);
  }

  async function send(exact: CampaignStartingLocationDesignationRequest): Promise<void> {
    setPhase("sending"); setMessage("");
    try {
      const result = await api.designateCampaignStartingLocation(campaignId, exact);
      const next = { campaignId: result.campaignId, revision: result.revision, startingLocation: result.startingLocation };
      clearIntent(); setRead(next); setPhase("ready"); setMessage(`${result.startingLocation.name} is the authoritative campaign starting location.`);
      onDesignation?.(next);
    } catch (error) {
      if (error instanceof CampaignStartingLocationHttpError && error.code === "RPG_CAMPAIGN_STARTING_LOCATION_STALE") {
        clearIntent();
        const current = await refresh();
        setPhase(current ? "ready" : "failed");
        setMessage(current?.startingLocation ? `${current.startingLocation.name} is already locked as the starting location.` : "The campaign revision changed. Review the refreshed state before creating a new command.");
        return;
      }
      if (error instanceof CampaignStartingLocationHttpError && (error.code === "RPG_CAMPAIGN_STARTING_LOCATION_CONFLICT" || error.code === "RPG_CAMPAIGN_STARTING_LOCATION_NOT_FOUND")) {
        clearIntent();
        const current = await refresh();
        setPhase(current ? "ready" : "failed");
        setMessage(current?.startingLocation ? `${current.startingLocation.name} is already locked as the starting location; a different location cannot replace it.` : "That location is not an available public campaign location, or the campaign cannot accept a designation.");
        return;
      }
      setIntent(exact); setPhase("uncertain");
      setMessage("The designation response is uncertain. Reconcile the authoritative GET before retrying; no automatic retry occurred.");
    }
  }

  function designate(): void {
    if (!read || read.startingLocation || !selected || intent) return;
    const exact = campaignStartingLocationDesignationRequestSchema.parse({
      locationId: selected,
      expectedRevision: read.revision,
      idempotencyKey: createKey(),
    });
    try { persistIntent(campaignId, exact); }
    catch { setPhase("failed"); setMessage("Browser recovery storage is unavailable. No designation command was sent."); return; }
    setIntent(exact);
    void send(exact);
  }

  async function reconcile(): Promise<void> {
    if (!intent) return;
    setPhase("loading"); setMessage("");
    const current = await refresh();
    if (!current) return;
    if (current.startingLocation?.locationId === intent.locationId) {
      clearIntent(); setPhase("ready"); setMessage(`${current.startingLocation.name} is authoritatively designated. The retained command was not replayed.`); return;
    }
    if (current.startingLocation) {
      clearIntent(); setPhase("ready"); setMessage(`${current.startingLocation.name} is already locked as the starting location; the retained different location cannot be retried.`); return;
    }
    if (current.revision !== intent.expectedRevision) {
      clearIntent(); setPhase("ready"); setMessage("No designation exists, but the retained command is stale. It was not retried; review the current campaign state."); return;
    }
    setPhase("retry"); setMessage("No designation exists and the campaign revision still matches. You may retry only the exact retained command.");
  }

  const chosen = intent ? candidates.find((item) => item.locationId === intent.locationId)?.name ?? intent.locationId : "";
  return <section className="campaign-starting-location" aria-labelledby={`starting-location-${campaignId}`}>
    <h4 id={`starting-location-${campaignId}`}>Authoritative starting location</h4>
    {phase === "loading" && <p role="status">Reading authoritative designation...</p>}
    {read?.startingLocation ? <><strong>{read.startingLocation.name}</strong><p>This create-once designation is locked. It does not move any actor or start a room.</p></> : read && <p>No campaign starting location is designated. Generated foundation keys are not a designation.</p>}
    {message && <p role={phase === "uncertain" ? "alert" : "status"}>{message}</p>}
    {read && !read.startingLocation && canDesignate && !intent && candidates.length > 0 && <div className="campaign-starting-location-choice"><label><span>Public named location</span><select value={selected} disabled={phase === "sending" || phase === "loading"} onChange={(event) => setSelected(event.target.value)}><option value="">Choose once...</option>{candidates.map((item) => <option key={item.locationId} value={item.locationId}>{item.name}</option>)}</select></label><button type="button" disabled={!selected || phase === "sending" || phase === "loading"} onClick={designate}>{phase === "sending" ? "Designating..." : "Designate starting location once"}</button></div>}
    {read && !read.startingLocation && candidates.length === 0 && phase !== "loading" && <p>{canDesignate ? "Generate and apply at least one public named location in Create, then return here to choose the opening location." : "No authoritative starting location is available yet."}</p>}
    {intent && <div className="campaign-starting-location-recovery"><strong>Retained exact command: {chosen}</strong><p>Expected campaign revision {intent.expectedRevision}. This command is locked until its outcome is reconciled.</p>{phase === "retry" ? <button type="button" onClick={() => void send(intent)}>Retry exact retained designation</button> : <button type="button" disabled={phase === "loading" || phase === "sending"} onClick={() => void reconcile()}>Reconcile authoritative designation</button>}</div>}
    {!canDesignate && <p className="field-help">Read-only: only the campaign owner or GM can create the designation.</p>}
  </section>;
}
