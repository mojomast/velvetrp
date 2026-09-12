import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignAdministrationIntegrations } from "@velvet/contracts";
import { ApiError, getCampaignAdministrationIntegrations, requestCampaignSafetyAction, selectCampaignRuleset, updateCampaignSessionZeroSafety } from "../../../api";
import { createClientId } from "../../../utils/clientId";
import { RulesetAdministrationPanel } from "./RulesetAdministrationPanel";
import { SessionZeroSafetyPanel } from "./SessionZeroSafetyPanel";

export interface CampaignSecurityPanelsProps {
  campaignId: string;
  /** Called after an authoritative write and read reconciliation; use it to refresh play state. */
  onMutated?: () => void | Promise<void>;
}

const commandId = (kind: string) => `security-ui-${kind}-${createClientId()}`;

/** Rules profile and session-zero safety, mounted anywhere without a page shell. */
export function CampaignSecurityPanels({ campaignId, onMutated }: CampaignSecurityPanelsProps) {
  const [integrations, setIntegrations] = useState<CampaignAdministrationIntegrations | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const value = await getCampaignAdministrationIntegrations(campaignId);
      if (!mounted.current) return false;
      setIntegrations(value);
      return true;
    } catch (failure) {
      if (mounted.current) setError(failure instanceof ApiError && failure.status === 404
        ? "Campaign administration is unavailable for your current role."
        : "Rules and safety settings could not be loaded. Refresh before editing.");
      return false;
    }
  }, [campaignId]);

  useEffect(() => { mounted.current = true; setIntegrations(null); setError(""); setNotice(""); void load(); return () => { mounted.current = false; }; }, [load]);

  async function mutate(kind: string, write: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await write();
      if (!mounted.current) return;
      setNotice(`${kind} confirmed. Authoritative settings are being reconciled.`);
      const reconciled = await load();
      if (reconciled) await onMutated?.();
      else setError(`${kind} was confirmed, but fresh settings could not be read. Refresh before another write.`);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof ApiError && failure.status === 409
        ? `${kind} was rejected as stale or conflicting. Reconcile settings before retrying.`
        : `${kind} outcome is uncertain. Refresh authoritative settings before another write; it will not be retried.`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (!integrations) return <div className="admin-security-panels">{error ? <p role="alert">{error}</p> : <p role="status">Loading rules profile and safety settings…</p>}</div>;
  const role = integrations.actorRole === "observer" ? "player" : integrations.actorRole;
  return <div className="admin-security-panels">
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <RulesetAdministrationPanel actorRole={role} current={integrations.rulesets.current} available={integrations.rulesets.available}
      expectedRevision={integrations.revision} selectionAllowed={integrations.rulesets.mechanicallyEmpty}
      selectionWarning={integrations.rulesets.selectionWarning} disabled={busy}
      api={{ selectRuleset: (input) => void mutate("Rules profile selection", () => selectCampaignRuleset(campaignId, { ...input, migrationConfirmed: true, idempotencyKey: commandId("ruleset") })), reconcileSelection: () => void load() }} />
    <SessionZeroSafetyPanel actorRole={role} settings={integrations.safety} disabled={busy} safetyActionDisabled={busy}
      api={{ updateSettings: (input) => void mutate("Safety settings", () => updateCampaignSessionZeroSafety(campaignId, { ...input, idempotencyKey: commandId("safety") })),
        reconcileSettings: () => void load(),
        pause: () => void mutate("Safety pause", () => requestCampaignSafetyAction(campaignId, { action: "pause", confirmed: true, expectedRevision: integrations.revision, idempotencyKey: commandId("pause") })),
        resume: () => void mutate("Safety resume", () => requestCampaignSafetyAction(campaignId, { action: "resume", confirmed: true, expectedRevision: integrations.revision, idempotencyKey: commandId("resume") })),
        skip: () => void mutate("Safety skip", () => requestCampaignSafetyAction(campaignId, { action: "skip", confirmed: true, expectedRevision: integrations.revision, idempotencyKey: commandId("skip") })),
        rewind: () => void mutate("Safety rewind", () => requestCampaignSafetyAction(campaignId, { action: "rewind", confirmed: true, expectedRevision: integrations.revision, idempotencyKey: commandId("rewind") })) }} />
  </div>;
}
