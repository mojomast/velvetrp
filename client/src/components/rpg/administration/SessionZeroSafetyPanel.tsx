import { useEffect, useState } from "react";
import { canAdminister, type AdministrationMutationState, type AdministrationRole } from "./types";

export type SafetyPolicy = "disallowed" | "fade-to-black" | "explicit-consent" | "allowed";
export type LethalityPolicy = "nonlethal-default" | "consent-required" | "rules-as-written";
export interface SessionZeroSafetySettings {
  revision: number;
  hardLimits: string[];
  veils: string[];
  pvpPolicy: SafetyPolicy;
  romancePolicy: SafetyPolicy;
  lethalityPolicy: LethalityPolicy;
  paused: boolean;
}
export interface UpdateSessionZeroSafetyInput extends Omit<SessionZeroSafetySettings, "revision" | "paused"> { expectedRevision: number }
export interface SessionZeroSafetyApi {
  updateSettings: (input: UpdateSessionZeroSafetyInput) => void;
  reconcileSettings: () => void;
  pause: () => void;
  resume: () => void;
  skip: () => void;
  rewind: () => void;
}
export interface SessionZeroSafetyPanelProps {
  actorRole: AdministrationRole;
  settings: SessionZeroSafetySettings;
  mutation?: AdministrationMutationState;
  disabled?: boolean;
  safetyActionDisabled?: boolean;
  api: SessionZeroSafetyApi;
}

const policyOptions: Array<[SafetyPolicy, string]> = [["disallowed", "Disallowed"], ["fade-to-black", "Fade to black"], ["explicit-consent", "Explicit consent each time"], ["allowed", "Allowed"]];
const lethalityOptions: Array<[LethalityPolicy, string]> = [["nonlethal-default", "Nonlethal by default"], ["consent-required", "Character death requires consent"], ["rules-as-written", "Rules as written"]];
const splitBoundaries = (value: string): string[] => value.split("\n").map((line) => line.trim()).filter(Boolean);

export function SessionZeroSafetyPanel({ actorRole, settings, mutation = { phase: "idle" }, disabled = false, safetyActionDisabled = false, api }: SessionZeroSafetyPanelProps) {
  const [hardLimits, setHardLimits] = useState(settings.hardLimits.join("\n"));
  const [veils, setVeils] = useState(settings.veils.join("\n"));
  const [pvpPolicy, setPvpPolicy] = useState<SafetyPolicy>(settings.pvpPolicy);
  const [romancePolicy, setRomancePolicy] = useState<SafetyPolicy>(settings.romancePolicy);
  const [lethalityPolicy, setLethalityPolicy] = useState<LethalityPolicy>(settings.lethalityPolicy);
  const [reviewing, setReviewing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [action, setAction] = useState<"pause" | "resume" | "skip" | "rewind" | null>(null);
  const [actionConfirmed, setActionConfirmed] = useState(false);
  const mutable = canAdminister(actorRole);
  const locked = disabled || mutation.phase !== "idle";
  const limits = splitBoundaries(hardLimits);
  const veilList = splitBoundaries(veils);
  const boundariesValid = limits.length <= 32 && veilList.length <= 32 && [...limits, ...veilList].every((item) => item.length <= 200);
  const dirty = hardLimits !== settings.hardLimits.join("\n") || veils !== settings.veils.join("\n") || pvpPolicy !== settings.pvpPolicy || romancePolicy !== settings.romancePolicy || lethalityPolicy !== settings.lethalityPolicy;
  const edit = (change: () => void) => { change(); setReviewing(false); setConfirmed(false); };

  useEffect(() => { setHardLimits(settings.hardLimits.join("\n")); setVeils(settings.veils.join("\n")); setPvpPolicy(settings.pvpPolicy); setRomancePolicy(settings.romancePolicy); setLethalityPolicy(settings.lethalityPolicy); setReviewing(false); setConfirmed(false); }, [settings]);

  return <section className="admin-section" aria-labelledby="session-zero-heading">
    <div className="admin-section-heading"><div><p className="eyebrow">SESSION-ZERO AGREEMENT</p><h2 id="session-zero-heading">Safety controls</h2></div><span className="status-pill">revision {settings.revision}</span></div>
    <section aria-labelledby="in-session-safety-heading"><h3 id="in-session-safety-heading">In-session controls</h3><p>These controls are visible to every campaign role. No reason is required. Every durable request is reviewed before submission.</p><div className="button-row" role="group" aria-label="In-session safety controls"><button className="primary" type="button" disabled={safetyActionDisabled} onClick={() => { setAction(settings.paused ? "resume" : "pause"); setActionConfirmed(false); }}>{settings.paused ? "Review resume" : "Review pause"}</button><button type="button" disabled={safetyActionDisabled} onClick={() => { setAction("skip"); setActionConfirmed(false); }}>Review skip</button><button type="button" disabled={safetyActionDisabled} onClick={() => { setAction("rewind"); setActionConfirmed(false); }}>Review rewind</button></div>{action && <div className="command-review"><h4>Confirm {action} request</h4>{action === "rewind" && <p>Rewind records a durable request and directs the table to checkpoint/fork. It does not erase mechanics.</p>}<label className="checkbox"><input type="checkbox" checked={actionConfirmed} onChange={(event) => setActionConfirmed(event.target.checked)} /> Confirm this exact {action} request</label><button type="button" className="primary" disabled={safetyActionDisabled || !actionConfirmed} onClick={() => { api[action](); setAction(null); setActionConfirmed(false); }}>Submit {action} once</button></div>}</section>
    {!mutable && <p className="content-warning">Only campaign owners and GMs can edit the session-zero agreement.</p>}
    <fieldset disabled={!mutable || locked}><legend>Boundaries and table policies</legend><label className="field"><span>Hard limits, one per line</span><textarea rows={4} value={hardLimits} onChange={(event) => edit(() => setHardLimits(event.target.value))} aria-invalid={!boundariesValid} /><small>Never introduced or depicted. Maximum 32 entries of 200 characters.</small></label><label className="field"><span>Veils, one per line</span><textarea rows={4} value={veils} onChange={(event) => edit(() => setVeils(event.target.value))} aria-invalid={!boundariesValid} /><small>May exist but are not described on screen. Maximum 32 entries of 200 characters.</small></label>{!boundariesValid && <p className="field-error" role="alert">Use no more than 32 hard limits and 32 veils, each no longer than 200 characters.</p>}<label className="field"><span>Player-versus-player policy</span><select value={pvpPolicy} onChange={(event) => edit(() => setPvpPolicy(event.target.value as SafetyPolicy))}>{policyOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field"><span>Romance policy</span><select value={romancePolicy} onChange={(event) => edit(() => setRomancePolicy(event.target.value as SafetyPolicy))}>{policyOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field"><span>Character lethality policy</span><select value={lethalityPolicy} onChange={(event) => edit(() => setLethalityPolicy(event.target.value as LethalityPolicy))}>{lethalityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" disabled={!dirty || !boundariesValid} onClick={() => setReviewing(true)}>Review safety agreement</button></fieldset>
    {reviewing && <section className="command-review" aria-labelledby="safety-review-heading"><h3 id="safety-review-heading">Review complete safety agreement</h3><h4>Hard limits</h4>{limits.length ? <ul>{limits.map((limit, index) => <li key={`${index}:${limit}`}>{limit}</li>)}</ul> : <p>None recorded.</p>}<h4>Veils</h4>{veilList.length ? <ul>{veilList.map((veil, index) => <li key={`${index}:${veil}`}>{veil}</li>)}</ul> : <p>None recorded.</p>}<dl className="command-detail-list"><div><dt>PvP</dt><dd>{pvpPolicy}</dd></div><div><dt>Romance</dt><dd>{romancePolicy}</dd></div><div><dt>Lethality</dt><dd>{lethalityPolicy}</dd></div><div><dt>Expected revision</dt><dd>{settings.revision}</dd></div></dl><label className="checkbox"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm this complete revision-bound session-zero agreement</label><button className="primary" type="button" disabled={locked || !confirmed} onClick={() => api.updateSettings({ hardLimits: limits, veils: veilList, pvpPolicy, romancePolicy, lethalityPolicy, expectedRevision: settings.revision })}>Save safety agreement once</button></section>}
    {mutation.phase === "uncertain" && <div className="content-warning" role="alert"><p>{mutation.message ?? "The safety agreement outcome is uncertain. It will not be submitted again automatically."}</p><button type="button" disabled={disabled} onClick={api.reconcileSettings}>Reconcile safety agreement</button></div>}
  </section>;
}
