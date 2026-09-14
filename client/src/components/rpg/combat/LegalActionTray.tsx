import type { CombatLegalAction, DirectCombatPowerCandidate, UseConsumableLegalAction } from "@velvet/contracts";
import { useEffect, useMemo, useState } from "react";

export interface LegalActionTrayProps {
  legalActions: readonly CombatLegalAction[];
  combatantLabels?: ReadonlyMap<string, string>;
  disabled?: boolean;
  busy?: boolean;
  onSubmit: (action: CombatLegalAction, targetIds: string[]) => void;
  consumableActions?:readonly UseConsumableLegalAction[];
  onUseConsumable?:(action:UseConsumableLegalAction)=>void;
  powerActions?:readonly DirectCombatPowerCandidate[];
  onUsePower?:(action:DirectCombatPowerCandidate)=>void;
}

const supportedKinds = ["attack", "flee", "end-turn", "stabilize", "death-save", "grapple", "escape-grapple", "shove", "stand-up", "dash", "disengage", "help", "hide", "ready"] as const;
type SupportedKind = typeof supportedKinds[number];
const supported = (action: CombatLegalAction): action is CombatLegalAction & { kind: SupportedKind } =>
  (supportedKinds as readonly string[]).includes(action.kind);
const actionLabel = (kind: SupportedKind) => ({ attack: "Attack", flee: "Flee", "end-turn": "End turn", stabilize: "Stabilize", "death-save": "Make death save",
  grapple: "Grapple", "escape-grapple": "Escape grapple", shove: "Shove", "stand-up": "Stand up", dash: "Dash", disengage: "Disengage", help: "Help", hide: "Hide", ready: "Ready" })[kind];
const actionExplanation = (kind: SupportedKind) => ({
  attack: "The server resolves the attack and its outcome.",
  flee: "The server decides whether leaving combat succeeds.",
  "end-turn": "Ends this turn without a client-side outcome.",
  stabilize: "Choose one unconscious ally from the server's allowlist. The server determines the stable outcome.",
  "death-save": "The server rolls and records this death save. No roll is made in the client.",
  grapple: "Contest Strength (Athletics) against the target. On success the server applies grappled.",
  "escape-grapple": "Contest your Athletics or Acrobatics against the grappler to end grappled.",
  shove: "Contest Strength (Athletics) to knock the target prone on success.",
  "stand-up": "Spends half your speed to end the prone condition without using your action.",
  dash: "Adds one speed of movement to this turn's allowance.",
  disengage: "Prevents opportunity attacks as you leave reach this turn.",
  help: "Grants an ally advantage on its next attack until the start of your next turn.",
  hide: "The server rolls Dexterity (Stealth) against opposing passive Perception and may hide you.",
  ready: "Holds a bounded response until your next turn; it fires through the reaction window when its trigger matches.",
})[kind];

/**
 * Builds every control from the current server allowlist. Unsupported protocol
 * kinds are structurally absent until the action resolution contract supports them.
 */
export function LegalActionTray({ legalActions, consumableActions=[],powerActions=[],combatantLabels = new Map(), disabled = false, busy = false, onSubmit,onUseConsumable,onUsePower }: LegalActionTrayProps) {
  const actions = useMemo(() => legalActions.filter(supported), [legalActions]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewingPower, setReviewingPower] = useState<DirectCombatPowerCandidate | null>(null);
  const selected = actions.find((action) => action.legalActionId === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !actions.some((action) => action.legalActionId === selectedId)) {
      setSelectedId(null); setTargetId(null); setReviewing(false);
    }
  }, [actions, selectedId]);
  useEffect(() => {
    if (reviewingPower && !powerActions.some((action) => action.legalActionId === reviewingPower.legalActionId)) setReviewingPower(null);
  }, [powerActions, reviewingPower]);
  const powerTargetLabel = (action: DirectCombatPowerCandidate) => combatantLabels.get(action.targetCombatantId) ?? action.target ?? action.targetCombatantId;

   const requiresTarget = selected?.kind === "attack" || selected?.kind === "stabilize" || selected?.kind === "grapple" || selected?.kind === "escape-grapple" || selected?.kind === "shove" || selected?.kind === "stand-up" || selected?.kind === "help";
  const validSelection = Boolean(selected) && (!requiresTarget || (targetId !== null && selected.targetIds.includes(targetId)));
  function choose(action: typeof actions[number]) {
    setSelectedId(action.legalActionId); setTargetId(null); setReviewing(false);
  }

  return <aside className="legal-action-tray" aria-labelledby="legal-actions-heading">
    <div className="legal-action-heading"><div><p className="eyebrow">AVAILABLE THIS TURN</p><h2 id="legal-actions-heading">Your actions</h2></div>{busy && <span role="status">Resolving…</span>}</div>
    {actions.length === 0&&consumableActions.length===0&&powerActions.length===0 ? <p className="combat-empty">No supported legal actions were returned for this turn.</p> : <>
      <div className="legal-action-buttons" role="group" aria-label="Choose a server-returned legal action">
        {actions.map((action) => <button key={action.legalActionId} type="button" className={action.legalActionId === selectedId ? "is-selected" : ""} aria-pressed={action.legalActionId === selectedId} disabled={disabled || busy} onClick={() => choose(action)}>{actionLabel(action.kind)}</button>)}
      </div>
      {consumableActions.length>0&&<section aria-labelledby="consumable-actions-heading"><h3 id="consumable-actions-heading">Consumables</h3><div className="legal-action-buttons">
        {consumableActions.map((action)=><button key={action.legalActionId} type="button" disabled={disabled||busy||!onUseConsumable}
          onClick={()=>onUseConsumable?.(action)}>Use {action.item.definitionId} on {combatantLabels.get(action.target.combatantId)??action.target.combatantId}</button>)}
      </div><p className="combat-restriction">Quantity 1 · Cost: {consumableActions[0]?.actionCost}. Each option has exactly one server-selected target.</p></section>}
      {powerActions.length>0&&<section aria-labelledby="power-actions-heading"><h3 id="power-actions-heading">Combat powers</h3><div className="legal-action-buttons">{powerActions.map(action=><button key={action.legalActionId} type="button" aria-pressed={reviewingPower?.legalActionId===action.legalActionId} className={reviewingPower?.legalActionId===action.legalActionId ? "is-selected" : ""} disabled={disabled||busy||!onUsePower} onClick={()=>setReviewingPower(action)}>Use {action.powerName} on {powerTargetLabel(action)}</button>)}</div><p className="combat-restriction">Each power and target is an exact server-issued option.</p></section>}
      {reviewingPower && <section className="action-review" aria-labelledby="power-review-heading">
        <h3 id="power-review-heading">Review combat power</h3>
        <dl><div><dt>Power</dt><dd>{reviewingPower.powerName}</dd></div><div><dt>Target</dt><dd><bdi dir="auto">{powerTargetLabel(reviewingPower)}</bdi></dd></div><div><dt>Cost</dt><dd>{reviewingPower.cost ?? "No resource cost reported"}</dd></div><div><dt>Consequences</dt><dd>The server resolves this power and records the exact outcome.</dd></div></dl>
        <div className="button-row"><button type="button" className="primary" disabled={disabled||busy||!onUsePower} onClick={()=>{onUsePower?.(reviewingPower);setReviewingPower(null);}}>Confirm power</button><button type="button" className="ghost" disabled={busy} onClick={()=>setReviewingPower(null)}>Change selection</button></div>
      </section>}
      {selected && requiresTarget && <fieldset className="legal-targets"><legend>{selected.kind === "stabilize" ? "Unconscious allies the server allows you to stabilize" : "Valid targets returned for this action"}</legend>
        {selected.targetIds.length === 0 ? <p className="combat-restriction">The server returned no valid targets, so this action cannot be submitted.</p> : selected.targetIds.map((id) => <label key={id}><input type="radio" name={`target-${selected.legalActionId}`} checked={targetId === id} disabled={disabled || busy} onChange={() => { setTargetId(id); setReviewing(false); }} /><span><bdi dir="auto">{combatantLabels.get(id) ?? "Combatant"}</bdi></span></label>)}
      </fieldset>}
      {selected && <p className="combat-restriction">{actionExplanation(selected.kind)}</p>}
      {selected && !requiresTarget && selected.targetIds.length > 0 && <p className="combat-restriction" role="alert">This server action has an unsupported target shape and cannot be submitted.</p>}
      {!reviewing && <button type="button" className="primary legal-review-button" disabled={disabled || busy || !validSelection || Boolean(selected && !requiresTarget && selected.targetIds.length)} onClick={() => setReviewing(true)}>Review action</button>}
      {reviewing && selected && <section className="action-review" aria-labelledby="action-review-heading">
        <h3 id="action-review-heading">Review this action</h3>
        <dl><div><dt>Action kind</dt><dd>{actionLabel(selected.kind)}</dd></div><div><dt>Target</dt><dd>{targetId ? <bdi dir="auto">{combatantLabels.get(targetId) ?? "Combatant"}</bdi> : "No target required"}</dd></div><div><dt>Cost</dt><dd>{selected.cost ?? "Not supplied by this legal-action response"}</dd></div><div><dt>Consequences</dt><dd>{actionExplanation(selected.kind)}</dd></div></dl>
        <div className="button-row"><button type="button" className="primary" disabled={disabled || busy || !validSelection} onClick={() => onSubmit(selected, targetId ? [targetId] : [])}>Submit once</button><button type="button" className="ghost" disabled={busy} onClick={() => setReviewing(false)}>Change selection</button></div>
      </section>}
    </>}
  </aside>;
}
