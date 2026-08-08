import type { ActorEffectsResponse } from "@velvet/contracts";

export interface EffectListProps {
  effects: ActorEffectsResponse | null;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
}

function durationText(effect: ActorEffectsResponse["effects"][number]): string {
  if (effect.duration.kind === "rounds") return `${effect.duration.remaining} rounds remaining`;
  if (effect.duration.kind === "until_timestamp") return `Until ${effect.duration.expiresAt}`;
  return "Until removed";
}

function modifierText(modifier: ActorEffectsResponse["effects"][number]["modifiers"][number]): string {
  if (modifier.kind === "flat") return `${modifier.kind} ${modifier.amount >= 0 ? "+" : ""}${modifier.amount} to ${modifier.appliesToId}`;
  if (modifier.kind === "proficiency") return `${modifier.kind} +${modifier.bonus} to ${modifier.appliesToId}`;
  return `${modifier.kind} · ${modifier.appliesToId}`;
}

/** Displays only the public effect and concentration projection returned by M2.8. */
export function EffectList({ effects, loading = false, error = "", onRefresh }: EffectListProps) {
  const concentration = new Map(effects?.concentration.map((binding) => [binding.effectId, binding.concentrationId]) ?? []);
  return <section className="combat-panel effect-panel" aria-labelledby="effect-list-heading" aria-busy={loading}>
    <div className="combat-panel-heading"><div><p className="eyebrow">ACTIVE MECHANICS</p><h2 id="effect-list-heading">Effects & concentration</h2></div>{effects && <span className="status-pill">Revision {effects.revision}</span>}</div>
    {loading && <p role="status">Loading authoritative effects…</p>}
    {error && <div className="combat-inline-error" role="alert"><p>{error}</p>{onRefresh && <button type="button" className="ghost" onClick={onRefresh}>Retry effects</button>}</div>}
    {!loading && !error && !effects && <p className="combat-empty">Connect an actor to load effects.</p>}
    {effects && (effects.effects.length === 0 ? <p className="combat-empty">No active effects returned.</p> : <ul className="combat-effect-list">
      {effects.effects.map((effect) => <li key={effect.effectId}>
        <div className="effect-title"><strong>{effect.source ? <bdi dir="auto">{effect.source.definitionId}</bdi> : "Unattributed effect"}</strong><span>{effect.stacking}</span></div>
        <ul aria-label="Effect modifiers">{effect.modifiers.map((modifier, index) => <li key={`${modifier.kind}-${modifier.appliesToId}-${index}`}>{modifierText(modifier)}</li>)}</ul>
        <p>{durationText(effect)} · recovery {effect.recovery.replaceAll("_", " ")} · applied {effect.appliedAt}</p>
        {concentration.has(effect.effectId) && <p className="concentration-binding"><strong>Concentration:</strong> server binding <bdi dir="auto">{concentration.get(effect.effectId)}</bdi></p>}
      </li>)}
    </ul>)}
  </section>;
}
