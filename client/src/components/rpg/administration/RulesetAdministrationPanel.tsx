import { useEffect, useState } from "react";
import type { AdministrationMutationState, AdministrationRole } from "./types";

export interface RulesetCapability { capabilityId: string; label: string; supported: boolean; detail?: string }
export interface RulesetIdentity {
  rulesetId: string;
  name: string;
  version: string;
  digest: string;
  capabilities: RulesetCapability[];
  migration: "none" | "compatible" | "destructive" | "unknown";
  migrationSummary?: string;
}
export interface SelectRulesetInput { rulesetId: string; version: string; digest: string; expectedRevision: number }
export interface RulesetAdministrationApi {
  selectRuleset: (input: SelectRulesetInput) => void;
  reconcileSelection: () => void;
}
export interface RulesetAdministrationPanelProps {
  actorRole: AdministrationRole;
  current: RulesetIdentity;
  available: RulesetIdentity[];
  expectedRevision: number;
  mutation?: AdministrationMutationState;
  disabled?: boolean;
  selectionAllowed?: boolean;
  selectionWarning?: string;
  api: RulesetAdministrationApi;
}

const exactKey = (ruleset: RulesetIdentity): string => `${ruleset.rulesetId}\0${ruleset.version}\0${ruleset.digest}`;

export function RulesetAdministrationPanel({ actorRole, current, available, expectedRevision, mutation = { phase: "idle" }, disabled = false, selectionAllowed = true, selectionWarning, api }: RulesetAdministrationPanelProps) {
  const [selectedKey, setSelectedKey] = useState(exactKey(current));
  const [reviewing, setReviewing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const owner = actorRole === "owner";
  const selected = [current, ...available].find((ruleset) => exactKey(ruleset) === selectedKey) ?? current;
  const changed = exactKey(selected) !== exactKey(current);
  const migrationWarning = selected.migration !== "none";
  const locked = disabled || mutation.phase !== "idle";

  useEffect(() => { setSelectedKey(exactKey(current)); setReviewing(false); setConfirmed(false); setMigrationConfirmed(false); }, [current]);

  return <section className="admin-section" aria-labelledby="ruleset-administration-heading">
    <div className="admin-section-heading"><div><p className="eyebrow">SEALED RULESET IDENTITY</p><h2 id="ruleset-administration-heading">Ruleset and capabilities</h2></div><span className="status-pill">{actorRole} view</span></div>
    <article aria-labelledby="current-ruleset-heading"><h3 id="current-ruleset-heading">{current.name}</h3><p><code>{current.rulesetId} @ {current.version}</code></p><p>Digest <code>{current.digest}</code></p><ul aria-label="Current ruleset capabilities">{current.capabilities.map((capability) => <li key={capability.capabilityId}><strong>{capability.label}:</strong> {capability.supported ? "Supported" : "Not supported"}{capability.detail ? ` · ${capability.detail}` : ""}</li>)}</ul></article>
    {!owner && <p className="content-warning">Only the campaign owner can select a different ruleset. Identity and capabilities remain visible to all campaign roles.</p>}
    {owner && !selectionAllowed && <p className="content-warning">{selectionWarning ?? "Ruleset selection is locked because this campaign already contains mechanical state."}</p>}
    {owner && <fieldset disabled={locked || !selectionAllowed}><legend>Exact ruleset selection</legend>{[current, ...available.filter((candidate) => exactKey(candidate) !== exactKey(current))].map((candidate) => <label key={exactKey(candidate)} className="checkbox"><input type="radio" name="campaign-ruleset" checked={selectedKey === exactKey(candidate)} onChange={() => { setSelectedKey(exactKey(candidate)); setReviewing(false); setConfirmed(false); setMigrationConfirmed(false); }} /><span><strong>{candidate.name}</strong> · {candidate.version}<small>{candidate.rulesetId} · {candidate.digest}</small></span></label>)}<button type="button" disabled={!changed} onClick={() => setReviewing(true)}>Review ruleset change</button></fieldset>}
    {owner && reviewing && changed && <section className="command-review" aria-labelledby="ruleset-review-heading"><h3 id="ruleset-review-heading">Review exact ruleset change</h3><dl className="command-detail-list"><div><dt>From</dt><dd>{current.rulesetId} @ {current.version} · {current.digest}</dd></div><div><dt>To</dt><dd>{selected.rulesetId} @ {selected.version} · {selected.digest}</dd></div><div><dt>Expected revision</dt><dd>{expectedRevision}</dd></div></dl><h4>Selected capabilities</h4><ul>{selected.capabilities.map((capability) => <li key={capability.capabilityId}>{capability.label}: {capability.supported ? "Supported" : "Not supported"}</li>)}</ul>{migrationWarning && <div className="content-warning" role="alert"><strong>{selected.migration === "unknown" ? "Migration impact is unknown" : `${selected.migration} migration required`}</strong><p>{selected.migrationSummary ?? "Authoritative migration analysis is required before selection."}</p><label className="checkbox"><input type="checkbox" checked={migrationConfirmed} onChange={(event) => setMigrationConfirmed(event.target.checked)} /> I reviewed the migration warning and understand this is not an in-place cosmetic change</label></div>}<label className="checkbox"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm the exact target identity, digest, capabilities, and revision</label><button className="primary" type="button" disabled={locked || !confirmed || (migrationWarning && !migrationConfirmed)} onClick={() => api.selectRuleset({ rulesetId: selected.rulesetId, version: selected.version, digest: selected.digest, expectedRevision })}>Select ruleset once</button></section>}
    {mutation.phase === "uncertain" && <div className="content-warning" role="alert"><p>{mutation.message ?? "The ruleset selection outcome is uncertain. Further selection is locked."}</p><button type="button" disabled={disabled} onClick={api.reconcileSelection}>Reconcile authoritative ruleset</button></div>}
  </section>;
}
