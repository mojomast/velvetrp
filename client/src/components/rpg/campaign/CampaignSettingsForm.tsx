import { useEffect, useState, type FormEvent } from "react";
import type { CampaignAdministration, CampaignAdministrationPatch, CampaignLifecycleStatus } from "@velvet/contracts";

export interface CampaignSettingsFormProps {
  campaign: CampaignAdministration;
  campaignName: string | null;
  campaignNameLoading: boolean;
  busy: boolean;
  mutationLocked: boolean;
  onSave: (patch: Pick<CampaignAdministrationPatch, "settings">) => void;
  onStatusChange: (status: CampaignLifecycleStatus) => void;
  onArchive: (confirmationName: string) => void;
  onRetryCampaignName: () => void;
}

const STATUS_ACTIONS: Partial<Record<CampaignLifecycleStatus, Array<{ status: CampaignLifecycleStatus; label: string }>>> = {
  draft: [{ status: "published", label: "Publish campaign" }],
  published: [{ status: "paused", label: "Pause campaign" }, { status: "completed", label: "Complete campaign" }],
  paused: [{ status: "published", label: "Resume campaign" }, { status: "completed", label: "Complete campaign" }],
};

export function CampaignSettingsForm({ campaign, campaignName, campaignNameLoading, busy, mutationLocked, onSave, onStatusChange, onArchive, onRetryCampaignName }: CampaignSettingsFormProps) {
  const owner = campaign.actorRole === "owner";
  const privileged = campaign.actorRole === "owner" || campaign.actorRole === "gm";
  const [maxPlayers, setMaxPlayers] = useState(campaign.settings.maxPlayers);
  const [allowPlayerDice, setAllowPlayerDice] = useState(campaign.settings.allowPlayerDice);
  const [safetyMode, setSafetyMode] = useState(campaign.settings.safetyMode);
  const [recapVisibility, setRecapVisibility] = useState(campaign.settings.recapVisibility);
  const [gmNotes, setGmNotes] = useState(privileged ? campaign.settings.gmNotes : "");
  const [archiveName, setArchiveName] = useState("");
  const [settingsConfirmed, setSettingsConfirmed] = useState(false);

  useEffect(() => {
    setMaxPlayers(campaign.settings.maxPlayers);
    setAllowPlayerDice(campaign.settings.allowPlayerDice);
    setSafetyMode(campaign.settings.safetyMode);
    setRecapVisibility(campaign.settings.recapVisibility);
    setGmNotes(privileged ? campaign.settings.gmNotes : "");
    setArchiveName("");
    setSettingsConfirmed(false);
  }, [campaign, privileged]);

  function save(event: FormEvent) {
    event.preventDefault();
    if (!owner || busy || mutationLocked || !settingsConfirmed) return;
    onSave({ settings: { maxPlayers, allowPlayerDice, safetyMode, recapVisibility, gmNotes } });
    setSettingsConfirmed(false);
  }

  return <section className="admin-section" aria-labelledby="campaign-settings-heading">
    <div className="admin-section-heading">
      <div><p className="eyebrow">POLICY</p><h2 id="campaign-settings-heading">Campaign settings</h2></div>
      <span className="status-pill">{campaign.status}</span>
    </div>

    {owner ? <>
      <form className="admin-settings-form" onSubmit={save}>
        <fieldset disabled={busy || mutationLocked || campaign.status === "archived"}>
          <label className="field"><span>Maximum players</span><input type="number" min={1} max={20} required value={maxPlayers} onChange={(event) => { setMaxPlayers(Number(event.target.value)); setSettingsConfirmed(false); }} /></label>
          <label className="checkbox admin-checkbox"><input type="checkbox" checked={allowPlayerDice} onChange={(event) => { setAllowPlayerDice(event.target.checked); setSettingsConfirmed(false); }} /><span>Players may roll campaign dice</span></label>
          <label className="field"><span>Safety mode</span><select value={safetyMode} onChange={(event) => { setSafetyMode(event.target.value as typeof safetyMode); setSettingsConfirmed(false); }}><option value="standard">Standard</option><option value="strict">Strict</option></select></label>
          <label className="field"><span>Recap visibility</span><select value={recapVisibility} onChange={(event) => { setRecapVisibility(event.target.value as typeof recapVisibility); setSettingsConfirmed(false); }}><option value="members">All members</option><option value="gm-only">Owner and GMs only</option></select></label>
          <label className="field admin-wide"><span>GM notes</span><textarea rows={5} maxLength={4000} value={gmNotes} onChange={(event) => { setGmNotes(event.target.value); setSettingsConfirmed(false); }} /></label>
          <label className="checkbox admin-checkbox admin-wide"><input type="checkbox" checked={settingsConfirmed} onChange={(event) => setSettingsConfirmed(event.target.checked)} /><span>I reviewed these policy and visibility settings and confirm this change.</span></label>
          <button className="primary admin-wide" type="submit" disabled={!settingsConfirmed}>Save settings</button>
        </fieldset>
      </form>

      {campaign.status !== "archived" && <div className="admin-lifecycle" aria-labelledby="campaign-lifecycle-heading">
        <h3 id="campaign-lifecycle-heading">Lifecycle</h3>
        <p>Lifecycle changes affect when the campaign can be played. Each action requires confirmation.</p>
        <div className="button-row">{(STATUS_ACTIONS[campaign.status] ?? []).map((action) => <button className="ghost" disabled={busy || mutationLocked} key={action.status} onClick={() => {
          if (window.confirm(`${action.label}? This changes campaign availability.`)) onStatusChange(action.status);
        }}>{action.label}</button>)}</div>
      </div>}

      {campaign.status !== "archived" && campaignName !== null && <form className="archive-confirmation" onSubmit={(event) => { event.preventDefault(); if (!busy && !mutationLocked && archiveName === campaignName) onArchive(archiveName); }}>
        <h3>Archive campaign</h3>
        <p>Archiving is non-destructive, but this campaign cannot be made active again. Type the campaign name exactly to confirm.</p>
        <label className="field"><span>Campaign name</span><input autoComplete="off" value={archiveName} onChange={(event) => setArchiveName(event.target.value)} /></label>
        <button className="danger" type="submit" disabled={busy || mutationLocked || archiveName !== campaignName}>Archive campaign</button>
      </form>}
      {campaign.status !== "archived" && campaignName === null && <div className="archive-confirmation">
        <h3>Archive campaign unavailable</h3>
        <p>The authoritative campaign name could not be loaded. Archiving stays unavailable until it is refreshed.</p>
        <button className="ghost" disabled={busy || mutationLocked || campaignNameLoading} onClick={onRetryCampaignName}>{campaignNameLoading ? "Retrying campaign name…" : "Retry campaign name"}</button>
      </div>}
    </> : <dl className="admin-readonly-list">
      <div><dt>Maximum players</dt><dd>{campaign.settings.maxPlayers}</dd></div>
      <div><dt>Player dice</dt><dd>{campaign.settings.allowPlayerDice ? "Allowed" : "Not allowed"}</dd></div>
      <div><dt>Safety mode</dt><dd>{campaign.settings.safetyMode}</dd></div>
      <div><dt>Recaps</dt><dd>{campaign.settings.recapVisibility === "gm-only" ? "Owner and GMs" : "All members"}</dd></div>
      {privileged && <div><dt>GM notes</dt><dd>{campaign.settings.gmNotes || "No notes"}</dd></div>}
    </dl>}
  </section>;
}
