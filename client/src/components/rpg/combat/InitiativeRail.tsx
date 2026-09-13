import type { CombatReadResponse, CombatState } from "@velvet/contracts";

type Combatant = CombatReadResponse["combatants"][number] | CombatState["combatants"][number];

export interface InitiativeRailProps {
  combatants: readonly Combatant[];
  currentCombatant: string | null;
  selectedCombatant?: string | null;
  onInspect?: (combatantId: string) => void;
}

function combatantIdentity(combatant: Combatant, index: number): string {
  return combatant.displayName ?? (combatant.kind === "actor" ? `Ally ${index + 1}` : `Enemy ${index + 1}`);
}

function combatantLabel(combatant: Combatant, index: number): string {
  const identity = combatantIdentity(combatant, index);
  const saves = combatant.kind === "actor" && combatant.deathSaves ? `, ${combatant.deathSaves.successes} death save successes and ${combatant.deathSaves.failures} failures` : "";
  const temporaryHitPoints = combatant.temporaryHitPoints ?? 0;
  const conditions = combatant.conditions ?? [];
  const markers = combatant.markers ?? [];
  const temporary = temporaryHitPoints > 0 ? `, ${temporaryHitPoints} temporary hit points` : "";
  const conditionText = conditions.length ? `, conditions: ${conditions.map((condition) => condition.condition).join(", ")}` : "";
  const markerText = markers.length ? `, benefits: ${markers.join(", ")}` : "";
  return `${identity}, ${combatant.status}, ${combatant.hitPoints} of ${combatant.maximumHitPoints} hit points${temporary}${conditionText}${markerText}${saves}`;
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
            <span className="initiative-copy"><strong>{combatantIdentity(combatant, index)}</strong><small>{combatant.team} · {combatant.status}{(combatant.markers ?? []).length ? ` · ${(combatant.markers ?? []).join(", ")}` : ""}{combatant.kind === "actor" && combatant.deathSaves ? ` · saves ${combatant.deathSaves.successes}/${combatant.deathSaves.failures}` : ""}</small></span>
            <span className="initiative-hp"><strong>{combatant.hitPoints}</strong><small>/ {combatant.maximumHitPoints} HP{(combatant.temporaryHitPoints ?? 0) > 0 ? ` · +${combatant.temporaryHitPoints} temp` : ""}</small></span>
            {current && <span className="sr-only">Current turn</span>}
          </button>
        </li>;
      })}
    </ol>
  </nav>;
}
