import type { CombatReadResponse, CombatState } from "@velvet/contracts";

type Combatant = CombatReadResponse["combatants"][number] | CombatState["combatants"][number];

export interface InitiativeRailProps {
  combatants: readonly Combatant[];
  currentCombatant: string | null;
  selectedCombatant?: string | null;
  onInspect?: (combatantId: string) => void;
}

function combatantLabel(combatant: Combatant, index: number): string {
  const identity = combatant.kind === "actor" ? `Actor ${combatant.actorId}` : `Enemy ${combatant.template?.definitionId ?? index + 1}`;
  return `${identity}, ${combatant.status}, ${combatant.hitPoints} of ${combatant.maximumHitPoints} hit points`;
}

/** The visual rail is itself a native, keyboard-operable ordered-list equivalent. */
export function InitiativeRail({ combatants, currentCombatant, selectedCombatant = null, onInspect }: InitiativeRailProps) {
  return <nav className="initiative-rail" aria-labelledby="initiative-heading">
    <div className="combat-panel-heading"><h2 id="initiative-heading">Turn order</h2><span>{combatants.length}</span></div>
    <ol aria-label="Combat turn order">
      {combatants.map((combatant, index) => {
        const current = combatant.combatantId === currentCombatant;
        const selected = combatant.combatantId === selectedCombatant;
        const label = combatantLabel(combatant, index);
        return <li key={combatant.combatantId} className={`${current ? "is-current" : ""} ${selected ? "is-selected" : ""}`}>
          <button type="button" aria-current={current ? "step" : undefined} aria-pressed={selected} aria-label={`Inspect ${label}`} onClick={() => onInspect?.(combatant.combatantId)}>
            <span className="initiative-position" aria-hidden="true">{index + 1}</span>
            <span className="initiative-copy"><strong>{combatant.kind === "actor" ? <bdi dir="auto">{combatant.actorId}</bdi> : <bdi dir="auto">{combatant.template?.definitionId ?? "Enemy"}</bdi>}</strong><small>{combatant.team} · {combatant.status}</small></span>
            <span className="initiative-hp"><strong>{combatant.hitPoints}</strong><small>/ {combatant.maximumHitPoints} HP</small></span>
            {current && <span className="sr-only">Current turn</span>}
          </button>
        </li>;
      })}
    </ol>
  </nav>;
}
