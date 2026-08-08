import { useEffect, useMemo, useState } from "react";
import type { CampaignRole, ContentCatalogHttpCampaignContent, ContentCatalogHttpCampaignContentPutRequest, PublicationSummary } from "@velvet/contracts";

export interface CampaignContentPickerProps {
  actorRole: CampaignRole;
  current: ContentCatalogHttpCampaignContent;
  publications: PublicationSummary[];
  expectedRevision: number;
  busy?: boolean;
  mutationLocked?: boolean;
  onInspect: (packId: string, packVersion: string) => void;
  onApply: (input: ContentCatalogHttpCampaignContentPutRequest) => void;
  onRefresh: () => void;
}

type Pin = { packId: string; packVersion: string };
const keyFor = (pin: Pin) => `${pin.packId}\0${pin.packVersion}`;
const displayPin = (pin: Pin) => `${pin.packId} @ ${pin.packVersion}`;
const commandKey = () => `ui-content-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

function samePins(left: Pin[], right: Pin[]): boolean {
  return left.length === right.length && left.every((pin, index) => pin.packId === right[index]?.packId && pin.packVersion === right[index]?.packVersion);
}

/** Exact sealed-version selection. Role control is structural, not cosmetic. */
export function CampaignContentPicker({ actorRole, current, publications, expectedRevision, busy = false, mutationLocked = false, onInspect, onApply, onRefresh }: CampaignContentPickerProps) {
  const owner = actorRole === "owner";
  const compatible = useMemo(() => publications.filter((publication) => publication.compatibility.rulesProfileId === current.rulesProfileId), [current.rulesProfileId, publications]);
  const groups = useMemo(() => {
    const map = new Map<string, PublicationSummary[]>();
    for (const publication of compatible) map.set(publication.packId, [...(map.get(publication.packId) ?? []), publication]);
    for (const pin of current.contentPacks) if (!map.has(pin.packId)) map.set(pin.packId, []);
    return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [compatible, current.contentPacks]);
  const [selected, setSelected] = useState<Pin[]>(() => current.contentPacks.map(({ packId, packVersion }) => ({ packId, packVersion })));
  const [reviewing, setReviewing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const oldPins = current.contentPacks.map(({ packId, packVersion }) => ({ packId, packVersion }));
  const normalized = [...selected].sort((left, right) => left.packId.localeCompare(right.packId));
  const changed = !samePins([...oldPins].sort((left, right) => left.packId.localeCompare(right.packId)), normalized);

  useEffect(() => {
    setSelected(current.contentPacks.map(({ packId, packVersion }) => ({ packId, packVersion })));
    setReviewing(false); setConfirmed(false);
  }, [current]);

  const choose = (packId: string, packVersion: string) => {
    setSelected((pins) => [...pins.filter((pin) => pin.packId !== packId), { packId, packVersion }]);
    setReviewing(false); setConfirmed(false);
  };
  const include = (packId: string, enabled: boolean, versions: PublicationSummary[]) => {
    setSelected((pins) => enabled
      ? pins.some((pin) => pin.packId === packId) ? pins : [...pins, { packId, packVersion: versions[0]?.packVersion ?? "" }]
      : pins.filter((pin) => pin.packId !== packId));
    setReviewing(false); setConfirmed(false);
  };

  return <section className="campaign-content-picker" aria-labelledby="campaign-content-heading">
    <div className="content-studio-heading"><div><p className="eyebrow">EXACT CAMPAIGN PINS</p><h2 id="campaign-content-heading">Campaign content</h2></div><span className="status-pill">{actorRole} view</span></div>
    <p className="content-studio-help">Rules profile <code>{current.rulesProfileId}</code>. Only compatible, sealed publications can be compared here.</p>
    {!current.compatible && <div className="content-warning" role="alert">Current pins do not resolve compatibly. Refresh and inspect the listed issues before any change.</div>}
    {current.issues.length > 0 && <ul className="campaign-content-issues">{current.issues.map((issue, index) => <li key={`${issue.path}:${index}`}>{issue.message} <code>{issue.path}</code></li>)}</ul>}

    {!owner && <div className="pin-readonly"><h3>Active sealed versions</h3>{oldPins.length === 0 ? <p>No content pins.</p> : <ul>{oldPins.map((pin) => <li key={keyFor(pin)}><span>{displayPin(pin)}</span><button type="button" className="ghost" onClick={() => onInspect(pin.packId, pin.packVersion)}>Inspect</button></li>)}</ul>}<p>Only campaign owners can change exact pins.</p></div>}

    {owner && <>
      <div className="compatible-pack-groups" aria-label="Compatible sealed versions">
        {groups.length === 0 && <p className="content-empty">No compatible sealed versions are available.</p>}
        {groups.map(([packId, versions]) => {
          const active = selected.find((pin) => pin.packId === packId);
          const currentPin = oldPins.find((pin) => pin.packId === packId);
          const unavailableCurrent = currentPin && !versions.some((version) => version.packVersion === currentPin.packVersion);
          return <fieldset key={packId} disabled={busy || mutationLocked || versions.length === 0}>
            <legend><label className="pin-toggle"><input type="checkbox" checked={Boolean(active)} onChange={(event) => include(packId, event.target.checked, versions)} /> <span>{packId}</span></label></legend>
            {unavailableCurrent && <p className="content-warning">Current exact version {currentPin.packVersion} is not in the compatible publication page. It remains in the old pin review.</p>}
            {versions.map((version) => <label className="version-option" key={keyFor(version)}>
              <input type="radio" name={`pack-${packId}`} checked={active?.packVersion === version.packVersion} onChange={() => choose(packId, version.packVersion)} />
              <span><strong>{version.packVersion}</strong>{currentPin?.packVersion === version.packVersion && <small>Current exact version</small>}<small>{version.description}</small><code>{version.digest}</code></span>
              <button type="button" className="ghost" onClick={(event) => { event.preventDefault(); onInspect(packId, version.packVersion); }}>Inspect definitions</button>
            </label>)}
          </fieldset>;
        })}
      </div>
      <button type="button" className="primary" disabled={!changed || normalized.length === 0 || busy || mutationLocked} onClick={() => { setReviewing(true); setConfirmed(false); }}>Review all pin changes</button>
      {reviewing && <section className="pin-review" aria-labelledby="pin-review-heading">
        <h3 id="pin-review-heading">Complete old and new pin set</h3>
        <div className="pin-review-columns"><div><h4>Old pins</h4><ul>{oldPins.map((pin) => <li key={keyFor(pin)}>{displayPin(pin)}</li>)}</ul></div><div><h4>New pins</h4><ul>{normalized.map((pin) => <li key={keyFor(pin)}>{displayPin(pin)}</li>)}</ul></div></div>
        <label className="checkbox pin-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I reviewed every exact old and new pin. Applying creates one revision-bound campaign change.</span></label>
        <button type="button" className="primary" disabled={!confirmed || busy || mutationLocked} onClick={() => onApply({ rulesProfileId: current.rulesProfileId, contentPacks: normalized, expectedRevision, idempotencyKey: commandKey() })}>{busy ? "Applying…" : "Apply exact pin set"}</button>
      </section>}
      {mutationLocked && <div className="content-warning" role="alert"><p>Pin submission is locked because current state or the prior outcome is stale or uncertain. No write will be retried automatically.</p><button type="button" className="primary" disabled={busy} onClick={onRefresh}>Refresh authoritative content</button></div>}
    </>}
  </section>;
}
