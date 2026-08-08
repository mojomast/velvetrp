import type { CombatLegalAction } from "@velvet/contracts";
import { useEffect, useMemo, useState } from "react";

export interface LegalActionTrayProps {
  legalActions: readonly CombatLegalAction[];
  combatantLabels?: ReadonlyMap<string, string>;
  disabled?: boolean;
  busy?: boolean;
  onSubmit: (action: CombatLegalAction, targetIds: string[]) => void;
}

type SupportedKind = "attack" | "flee" | "end-turn";
const supported = (action: CombatLegalAction): action is CombatLegalAction & { kind: SupportedKind } =>
  action.kind === "attack" || action.kind === "flee" || action.kind === "end-turn";
const actionLabel = (kind: SupportedKind) => kind === "end-turn" ? "End turn" : kind[0]!.toUpperCase() + kind.slice(1);

/**
 * Builds every control from the current server allowlist. Unsupported protocol
 * kinds are structurally absent until the action resolution contract supports them.
 */
export function LegalActionTray({ legalActions, combatantLabels = new Map(), disabled = false, busy = false, onSubmit }: LegalActionTrayProps) {
  const actions = useMemo(() => legalActions.filter(supported), [legalActions]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const selected = actions.find((action) => action.legalActionId === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !actions.some((action) => action.legalActionId === selectedId)) {
      setSelectedId(null); setTargetId(null); setReviewing(false);
    }
  }, [actions, selectedId]);

  const requiresTarget = selected?.kind === "attack";
  const validSelection = Boolean(selected) && (!requiresTarget || (targetId !== null && selected.targetIds.includes(targetId)));
  function choose(action: typeof actions[number]) {
    setSelectedId(action.legalActionId); setTargetId(null); setReviewing(false);
  }

  return <aside className="legal-action-tray" aria-labelledby="legal-actions-heading">
    <div className="legal-action-heading"><div><p className="eyebrow">CURRENT SERVER ALLOWLIST</p><h2 id="legal-actions-heading">Legal actions</h2></div>{busy && <span role="status">Resolving…</span>}</div>
    {actions.length === 0 ? <p className="combat-empty">No supported legal actions were returned for this turn.</p> : <>
      <div className="legal-action-buttons" role="group" aria-label="Choose a server-returned legal action">
        {actions.map((action) => <button key={action.legalActionId} type="button" className={action.legalActionId === selectedId ? "is-selected" : ""} aria-pressed={action.legalActionId === selectedId} disabled={disabled || busy} onClick={() => choose(action)}>{actionLabel(action.kind)}</button>)}
      </div>
      {selected && selected.kind === "attack" && <fieldset className="legal-targets"><legend>Valid targets returned for this action</legend>
        {selected.targetIds.length === 0 ? <p className="combat-restriction">The server returned no valid targets.</p> : selected.targetIds.map((id) => <label key={id}><input type="radio" name={`target-${selected.legalActionId}`} checked={targetId === id} disabled={disabled || busy} onChange={() => { setTargetId(id); setReviewing(false); }} /><span><bdi dir="auto">{combatantLabels.get(id) ?? id}</bdi></span></label>)}
      </fieldset>}
      {selected && selected.kind !== "attack" && selected.targetIds.length > 0 && <p className="combat-restriction" role="alert">This server action is incompatible with the current resolution contract and cannot be submitted.</p>}
      {!reviewing && <button type="button" className="primary legal-review-button" disabled={disabled || busy || !validSelection || Boolean(selected && selected.kind !== "attack" && selected.targetIds.length)} onClick={() => setReviewing(true)}>Review action</button>}
      {reviewing && selected && <section className="action-review" aria-labelledby="action-review-heading">
        <h3 id="action-review-heading">Review server-returned action</h3>
        <dl><div><dt>Action kind</dt><dd>{actionLabel(selected.kind)}</dd></div><div><dt>Target</dt><dd>{targetId ? <bdi dir="auto">{combatantLabels.get(targetId) ?? targetId}</bdi> : "No target returned or selected"}</dd></div><div><dt>Cost</dt><dd>Not supplied by this legal-action response</dd></div><div><dt>Consequences</dt><dd>Not supplied; the server resolves the outcome authoritatively</dd></div></dl>
        <div className="button-row"><button type="button" className="primary" disabled={disabled || busy || !validSelection} onClick={() => onSubmit(selected, targetId ? [targetId] : [])}>Submit once</button><button type="button" className="ghost" disabled={busy} onClick={() => setReviewing(false)}>Change selection</button></div>
      </section>}
    </>}
  </aside>;
}
