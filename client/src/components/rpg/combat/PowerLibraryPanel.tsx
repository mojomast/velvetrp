import type { ActorPowerCommandResponse, ActorPowersResponse, PowerReference } from "@velvet/contracts";
import { useEffect, useState } from "react";

type LegalCommand = ActorPowersResponse["legalCommands"][number];
export interface PowerLibraryPanelProps {
  powers: ActorPowersResponse | null;
  loading?: boolean;
  error?: string;
  disabled?: boolean;
  commandStatus?: string;
  result?: ActorPowerCommandResponse | null;
  onRefresh?: () => void;
  onUse?: (command: LegalCommand, targetIds: string[]) => void;
}

const referenceKey = (power: PowerReference) => `${power.kind}\0${power.packId}\0${power.packVersion}\0${power.definitionId}`;
function availabilityText(reason: ActorPowersResponse["legalNow"][number]["reasons"][number]): string {
  if (reason === "execution-pin-unavailable") return "execution pin unavailable";
  if (reason === "finite-uses-exhausted") return "finite uses exhausted";
  return "spell slot unavailable";
}
function costText(cost: LegalCommand["costs"][number]) { return cost.kind === "slot" ? `1 × ${cost.slotId}` : "1 finite ability use"; }

function PowerResult({ value }: { value: ActorPowerCommandResponse }) {
  return <section className="power-result" aria-labelledby="power-result-heading"><h3 id="power-result-heading">Confirmed power response</h3>
    <dl><div><dt>Power</dt><dd>{value.resolution.powerRef.definitionId}</dd></div><div><dt>Revision</dt><dd>{value.receipt.revisionBefore} → {value.receipt.revisionAfter}</dd></div><div><dt>Costs</dt><dd>{value.resolution.costs.map(costText).join(", ") || "None"}</dd></div><div><dt>Targets</dt><dd>{value.resolution.targetIds.join(", ")}</dd></div></dl>
    {value.resolution.outcomes.length > 0 && <ul>{value.resolution.outcomes.map((outcome, index) => <li key={`${outcome.kind}-${outcome.targetId}-${index}`}><strong>{outcome.kind}</strong> · target {outcome.targetId}{outcome.kind === "damage" ? ` · roll ${outcome.roll.expression} = ${outcome.roll.total} · ${outcome.applied} ${outcome.damageType} applied (${outcome.adjustment})` : outcome.kind === "healing" ? ` · roll ${outcome.roll.expression} = ${outcome.roll.total} · ${outcome.applied} applied` : outcome.kind === "resource" ? ` · ${outcome.resourceId} ${outcome.applied}` : outcome.kind === "condition" ? ` · ${outcome.condition} for ${outcome.durationRounds} rounds · effect ${outcome.effectId}` : ` · ${outcome.statistic} ${outcome.amount} · ${outcome.duration}${outcome.effectId ? ` · effect ${outcome.effectId}` : ""}`}</li>)}</ul>}
    {value.resolution.stateDeltas.length > 0 && <ul aria-label="Power state deltas">{value.resolution.stateDeltas.map((delta, index) => <li key={`${delta.kind}-${index}`}><strong>{delta.kind}</strong> · actor {delta.actorId}{delta.kind === "resource" ? ` · ${delta.resourceId} ${delta.before} → ${delta.after}` : ` · effect ${delta.effectId}`}</li>)}</ul>}
    <details><summary>Complete strict server response</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
  </section>;
}

export function PowerLibraryPanel({ powers, loading = false, error = "", disabled = false, commandStatus = "", result = null, onRefresh, onUse }: PowerLibraryPanelProps) {
  const [selectedKey, setSelectedKey] = useState("");
  const [targets, setTargets] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const legalByPower = new Map(powers?.legalCommands.map((entry) => [referenceKey(entry.powerRef), entry]) ?? []);
  const legalNow = new Map(powers?.legalNow.map((entry) => [referenceKey(entry.powerRef), entry]) ?? []);
  const uses = new Map(powers?.uses.map((entry) => [referenceKey(entry.powerRef), entry]) ?? []);
  const selected = legalByPower.get(selectedKey) ?? null;
  useEffect(() => { if (selectedKey && !legalByPower.has(selectedKey)) { setSelectedKey(""); setTargets([]); setReviewing(false); } }, [legalByPower, selectedKey]);
  const selectionValid = selected?.targeting === "self" || selected?.targeting === "single" && targets.length === 1
    || selected?.targeting === "area" && targets.length > 0;

  return <section className="combat-panel power-library" aria-labelledby="power-library-heading" aria-busy={loading}>
    <div className="combat-panel-heading"><div><p className="eyebrow">SEPARATE ACTOR POWER LANE</p><h2 id="power-library-heading">Powers</h2></div>{powers && <span className="status-pill">Revision {powers.revision}</span>}</div>
    {loading && <p role="status">Loading authoritative powers…</p>}{error && <div className="combat-inline-error" role="alert"><p>{error}</p>{onRefresh && <button type="button" className="ghost" onClick={onRefresh}>Retry powers</button>}</div>}
    {commandStatus && <p className="combat-command-status" role="status">{commandStatus}</p>}{result && <PowerResult value={result} />}
    {!loading && !error && !powers && <p className="combat-empty">Connect an actor to load powers.</p>}
    {powers && <><dl className="power-slot-list" aria-label="Server-returned spell slots">{powers.slots.map((slot) => <div key={slot.slotId}><dt>Level {slot.level} slot</dt><dd>{slot.current} / {slot.max}</dd></div>)}</dl>
      {powers.known.length === 0 ? <p className="combat-empty">No known powers returned.</p> : <ul className="power-list">{powers.known.map((power) => {
        const key = referenceKey(power), availability = legalNow.get(key), use = uses.get(key), command = legalByPower.get(key);
        return <li key={key}><div className="power-title"><strong><bdi dir="auto">{power.definitionId}</bdi></strong><span>{power.kind}</span></div><dl><div><dt>Available now</dt><dd>{availability?.legal ? "Yes" : "No"}</dd></div>{use && <div><dt>Uses</dt><dd>{use.current} / {use.max}</dd></div>}{command && <><div><dt>Targeting</dt><dd>{command.targeting}</dd></div><div><dt>Effects</dt><dd>{command.effectKinds.join(", ")}</dd></div><div><dt>Concentration</dt><dd>{command.concentration ? "Required" : "No"}</dd></div></>}</dl>
          {availability && !availability.legal && <p className="combat-restriction">{availability.reasons.map(availabilityText).join("; ")}</p>}
          {command && onUse && <button type="button" className="ghost" disabled={disabled} aria-pressed={selectedKey === key} onClick={() => { setSelectedKey(key); setTargets([]); setReviewing(false); }}>Choose server-planned power</button>}
        </li>;
      })}</ul>}
      {selected && <section className="power-command-review"><h3>Server-planned command</h3>{selected.targeting !== "self" && <fieldset><legend>Valid server targets</legend>{selected.validTargets.map((target) => <label key={target.actorId}><input type={selected.targeting === "single" ? "radio" : "checkbox"} name="power-target" checked={targets.includes(target.actorId)} disabled={disabled} onChange={() => { setTargets((current) => selected.targeting === "single" ? [target.actorId] : current.includes(target.actorId) ? current.filter((id) => id !== target.actorId) : [...current, target.actorId]); setReviewing(false); }} />{target.label ?? target.actorId}</label>)}</fieldset>}
        {!reviewing ? <button type="button" className="primary" disabled={disabled || !selectionValid} onClick={() => setReviewing(true)}>Review power command</button> : <div className="action-review"><dl><div><dt>Power</dt><dd>{selected.powerRef.definitionId}</dd></div><div><dt>Submitted targets</dt><dd>{selected.targeting === "self" ? "None (server resolves self)" : targets.join(", ")}</dd></div><div><dt>Server costs</dt><dd>{selected.costs.map(costText).join(", ") || "None"}</dd></div><div><dt>Effect kinds</dt><dd>{selected.effectKinds.join(", ")}</dd></div><div><dt>Concentration</dt><dd>{selected.concentration ? "Required" : "No"}</dd></div></dl><button type="button" className="primary" disabled={disabled} onClick={() => onUse?.(selected, selected.targeting === "self" ? [] : targets)}>Execute once</button></div>}
      </section>}
      <p className="combat-authority-note">Only complete server-planned actor commands are executable here. Power use does not advance combat turns or mutate combat HP/log state.</p></>}
  </section>;
}
