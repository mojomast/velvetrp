import type { ActorEffectCommandRequest, ActorEffectCommandResponse, ActorEffectsResponse, EffectDuration, EffectModifier, EffectRecovery } from "@velvet/contracts";
import { useState } from "react";

type EffectIntent = ActorEffectCommandRequest extends infer Command ? Command extends ActorEffectCommandRequest
  ? Omit<Command, "expectedRevision" | "idempotencyKey"> : never : never;
type ModifierKind = EffectModifier["kind"];

const MODIFIER_KINDS: ModifierKind[] = ["flat", "proficiency", "advantage", "resistance", "vulnerability", "immunity"];
const RECOVERIES: EffectRecovery[] = ["none", "short_rest", "long_rest"];
const DURATION_KINDS: EffectDuration["kind"][] = ["until_removed", "rounds", "until_timestamp"];

function displayDuration(effect: ActorEffectsResponse["effects"][number]) {
  return effect.duration.kind === "rounds" ? `${effect.duration.remaining} rounds` : effect.duration.kind === "until_timestamp" ? `until ${effect.duration.expiresAt}` : "until removed";
}

export interface ActorEffectsPanelProps {
  effects: ActorEffectsResponse | null;
  disabled?: boolean;
  result?: ActorEffectCommandResponse | null;
  onApply?: (intent: EffectIntent) => void;
  onRemove?: (effectId: string) => void;
  onAdvance?: (effectId: string, rounds: number) => void;
}

/** Applies, removes, and advances bounded effects on the actor. The server owns stacking and durations. */
export function ActorEffectsPanel({ effects, disabled = false, result = null, onApply, onRemove, onAdvance }: ActorEffectsPanelProps) {
  const [modifierKind, setModifierKind] = useState<ModifierKind>("flat");
  const [appliesToId, setAppliesToId] = useState("");
  const [amount, setAmount] = useState("1");
  const [durationKind, setDurationKind] = useState<EffectDuration["kind"]>("until_removed");
  const [remaining, setRemaining] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");
  const [recovery, setRecovery] = useState<EffectRecovery>("none");
  const [concentration, setConcentration] = useState(false);
  const [concentrationId, setConcentrationId] = useState("");
  const numeric = Number(amount);
  const valid = appliesToId.trim().length > 0 && (modifierKind === "flat" || modifierKind === "proficiency" ? Number.isSafeInteger(numeric) : true)
    && (durationKind !== "until_timestamp" || expiresAt.trim().length > 0) && (!concentration || concentrationId.trim().length > 0);
  const submit = () => {
    if (!valid || !onApply) return;
    const modifier: EffectModifier = modifierKind === "flat" ? { kind: "flat", amount: numeric, appliesToId: appliesToId.trim() }
      : modifierKind === "proficiency" ? { kind: "proficiency", bonus: numeric, appliesToId: appliesToId.trim() }
      : { kind: modifierKind, appliesToId: appliesToId.trim() } as EffectModifier;
    const duration: EffectDuration = durationKind === "rounds" ? { kind: "rounds", remaining: Math.max(1, Number(remaining)) }
      : durationKind === "until_timestamp" ? { kind: "until_timestamp", expiresAt: expiresAt.trim() } : { kind: "until_removed" };
    onApply({ kind: "apply", effect: { source: null, modifiers: [modifier], duration, recovery,
      stacking: concentration ? { kind: "concentration", concentrationId: concentrationId.trim() } : { kind: "coexists" } } });
  };
  return <section className="actor-section" aria-labelledby="actor-effects-heading">
    <div className="actor-section-heading"><h2 id="actor-effects-heading">Conditions &amp; effects</h2>{effects && <span className="count-badge">{effects.effects.length}</span>}</div>
    {effects && effects.effects.length > 0 ? <ul className="effects-list">{effects.effects.map((effect) => <li key={effect.effectId}>
      <strong>{effect.modifiers.map((modifier) => `${modifier.kind} ${modifier.appliesToId}`).join(", ")}</strong>
      <span>{displayDuration(effect)} · recovery {effect.recovery}{effect.stacking === "concentration" ? " · concentration bound" : ""}</span>
      {onAdvance && effect.duration.kind === "rounds" && <button className="ghost" type="button" disabled={disabled} onClick={() => onAdvance(effect.effectId, 1)}>Advance 1 round</button>}
      {onRemove && <button className="ghost" type="button" disabled={disabled} onClick={() => onRemove(effect.effectId)}>Remove {effect.effectId}</button>}
    </li>)}</ul> : <p className="actor-empty">No active effects.</p>}
    {onApply && <details className="effect-apply"><summary>Apply a new effect</summary>
      <p className="actor-help">One bounded modifier at a time. Flat and proficiency modifiers need an integer amount; duration, recovery, and concentration are server-validated.</p>
      <div className="effect-apply-form">
        <label className="field">Modifier kind<select value={modifierKind} disabled={disabled} onChange={(event) => setModifierKind(event.target.value as ModifierKind)}>{MODIFIER_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="field">Applies to ID<input value={appliesToId} disabled={disabled} autoComplete="off" onChange={(event) => setAppliesToId(event.target.value)} /></label>
        {(modifierKind === "flat" || modifierKind === "proficiency") && <label className="field">Amount<input type="number" value={amount} disabled={disabled} onChange={(event) => setAmount(event.target.value)} /></label>}
        <label className="field">Duration<select value={durationKind} disabled={disabled} onChange={(event) => setDurationKind(event.target.value as EffectDuration["kind"])}>{DURATION_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        {durationKind === "rounds" && <label className="field">Rounds<input type="number" min={1} value={remaining} disabled={disabled} onChange={(event) => setRemaining(event.target.value)} /></label>}
        {durationKind === "until_timestamp" && <label className="field">Expires at (ISO)<input value={expiresAt} disabled={disabled} autoComplete="off" onChange={(event) => setExpiresAt(event.target.value)} /></label>}
        <label className="field">Recovery<select value={recovery} disabled={disabled} onChange={(event) => setRecovery(event.target.value as EffectRecovery)}>{RECOVERIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="checkbox"><input type="checkbox" checked={concentration} disabled={disabled} onChange={(event) => setConcentration(event.target.checked)} /> Concentration</label>
        {concentration && <label className="field">Concentration ID<input value={concentrationId} disabled={disabled} autoComplete="off" onChange={(event) => setConcentrationId(event.target.value)} /></label>}
        <div className="button-row"><button className="primary" type="button" disabled={disabled || !valid} onClick={submit}>Apply effect</button></div>
      </div>
    </details>}
    {result && <details><summary>Complete strict server response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>}
  </section>;
}
