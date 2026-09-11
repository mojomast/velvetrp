import type { ActorPowersResponse, CastSpellCommandRequest, CastSpellCommandResponse, PowerReference } from "@velvet/contracts";
import { useEffect, useState } from "react";

type SpellIntent = Omit<CastSpellCommandRequest, "expectedRevision" | "idempotencyKey">;
type LegalCommand = ActorPowersResponse["legalCommands"][number];
type SpellCommand = LegalCommand & { powerRef: Extract<PowerReference, { kind: "spell" }> };
const referenceKey = (power: PowerReference) => `${power.kind}\0${power.packId}\0${power.packVersion}\0${power.definitionId}`;
const costText = (cost: LegalCommand["costs"][number]) => cost.kind === "slot" ? `1 × ${cost.slotId}` : "1 finite use";

export interface SpellcastingPanelProps {
  powers: ActorPowersResponse | null;
  disabled?: boolean;
  result?: CastSpellCommandResponse | null;
  onCast?: (intent: SpellIntent) => void;
}

/** Casts prepared spells through the dedicated spell lane. Components default on and are server-validated. */
export function SpellcastingPanel({ powers, disabled = false, result = null, onCast }: SpellcastingPanelProps) {
  const [selectedKey, setSelectedKey] = useState("");
  const [targets, setTargets] = useState<string[]>([]);
  const [verbal, setVerbal] = useState(true), [somatic, setSomatic] = useState(true), [material, setMaterial] = useState(true);
  const spells = (powers?.legalCommands ?? []).filter((command): command is SpellCommand => command.powerRef.kind === "spell");
  const selected = spells.find((command) => referenceKey(command.powerRef) === selectedKey) ?? null;
  useEffect(() => { if (selectedKey && !selected) { setSelectedKey(""); setTargets([]); } }, [selected, selectedKey]);
  const selectionValid = selected?.targeting === "self" || selected?.targeting === "single" && targets.length === 1
    || selected?.targeting === "area" && targets.length > 0 && targets.length <= selected.maxTargets;
  return <section className="actor-section" aria-labelledby="spellcasting-heading">
    <div className="actor-section-heading"><h2 id="spellcasting-heading">Spellcasting</h2><span className="status-pill">Prepared only</span></div>
    {!powers && <p className="actor-empty">Connect an actor to load prepared spells.</p>}
    {powers && spells.length === 0 && <p className="actor-empty">No prepared spells are castable right now.</p>}
    {powers && spells.length > 0 && <ul className="power-list">{spells.map((command) => { const key = referenceKey(command.powerRef);
      return <li key={key}><div className="power-title"><strong><bdi dir="auto">{command.powerRef.definitionId}</bdi></strong><span>spell</span></div>
        <dl><div><dt>Targeting</dt><dd>{command.targeting}</dd></div><div><dt>Costs</dt><dd>{command.costs.map(costText).join(", ") || "None"}</dd></div><div><dt>Concentration</dt><dd>{command.concentration ? "Required" : "No"}</dd></div></dl>
        {onCast && <button type="button" className="ghost" disabled={disabled} aria-pressed={selectedKey === key} onClick={() => { setSelectedKey(key); setTargets([]); }}>Prepare cast</button>}
      </li>; })}</ul>}
    {selected && onCast && <div className="power-command-review"><h3>Cast {selected.powerRef.definitionId}</h3>
      {selected.targeting !== "self" && <fieldset><legend>Valid server targets</legend>{selected.validTargets.map((target) => { const checked = targets.includes(target.actorId); return <label key={target.actorId}><input type={selected.targeting === "single" ? "radio" : "checkbox"} name="spell-target" checked={checked} disabled={disabled || (!checked && targets.length >= selected.maxTargets)} onChange={() => setTargets((current) => selected.targeting === "single" ? [target.actorId] : current.includes(target.actorId) ? current.filter((id) => id !== target.actorId) : current.length < selected.maxTargets ? [...current, target.actorId] : current)} />{target.label ?? target.actorId}</label>; })}</fieldset>}
      <fieldset><legend>Components</legend><label><input type="checkbox" checked={verbal} disabled={disabled} onChange={(event) => setVerbal(event.target.checked)} /> Verbal</label><label><input type="checkbox" checked={somatic} disabled={disabled} onChange={(event) => setSomatic(event.target.checked)} /> Somatic</label><label><input type="checkbox" checked={material} disabled={disabled} onChange={(event) => setMaterial(event.target.checked)} /> Material</label></fieldset>
      <button className="primary" type="button" disabled={disabled || !selectionValid} onClick={() => onCast({ powerRef: selected.powerRef, targetIds: selected.targeting === "self" ? [] : targets, choices: [], components: { verbal, somatic, material } })}>Cast once</button>
    </div>}
    {result && <details><summary>Complete strict server response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>}
  </section>;
}
