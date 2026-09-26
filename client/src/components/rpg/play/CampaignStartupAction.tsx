import { useState } from "react";
import { campaignStartup, type CampaignStartupResponse } from "../../../api";
import type { CampaignPlayBootstrap } from "@velvet/contracts";

type CampaignRole = CampaignPlayBootstrap["principal"]["role"];

/**
 * Deliberate, owner/GM-only "Start campaign" control.
 *
 * It is the only place the idempotent `campaignStartup` command is invoked from
 * the UI. It never fires on mount or navigation: only an explicit click runs it,
 * exactly once, and a rejection is surfaced without an automatic retry.
 *
 * The command reports a blocked opening in `blockers` rather than throwing, so
 * callers must show that summary without treating it as a hard failure.
 */
export function CampaignStartupAction({ campaignId, sessionId, role, canAct, unstarted, loaded, onStarted }: {
  campaignId: string; sessionId: string; role: CampaignRole; canAct: boolean; unstarted: boolean; loaded: boolean;
  onStarted?: (result: CampaignStartupResponse) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [blockers, setBlockers] = useState<string[]>([]);
  if (!canAct || (role !== "owner" && role !== "gm")) return null;
  async function start() {
    if (busy || !unstarted) return;
    setBusy(true); setNotice(""); setBlockers([]);
    try {
      const result = await campaignStartup(campaignId, sessionId);
      setBlockers(result.blockers);
      setNotice(result.blockers.length === 0
        ? "Campaign startup confirmed. The Director is delegated and the opening beat is committed."
        : "Campaign startup ran but did not open the campaign. Resolve the blockers and start it again explicitly; nothing was retried automatically.");
      onStarted?.(result);
    } catch {
      // A rejected or unreachable command is never replayed here. The user must
      // review campaign state and start it again deliberately.
      setNotice("Campaign startup could not be confirmed. No retry was made; review campaign state before starting again.");
    } finally { setBusy(false); }
  }
  return <div className="campaign-startup-action" role="group" aria-label="Start campaign">
    <button type="button" disabled={busy || !unstarted} onClick={() => void start()}>{busy ? "Starting campaign…" : "Start campaign"}</button>
    {loaded && !unstarted && <p className="atlas-notice" role="status">This campaign already has a completed opening scene.</p>}
    {!loaded && <p className="atlas-notice" role="status">Reading director history…</p>}
    {notice && <p className="atlas-notice" role="status">{notice}</p>}
    {blockers.length > 0 && <ul className="atlas-notice" aria-label="Campaign startup blockers">{blockers.map((blocker, index) => <li key={`${blocker}:${index}`}>{blocker}</li>)}</ul>}
  </div>;
}
