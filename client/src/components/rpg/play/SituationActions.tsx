import { useEffect, useMemo, useState } from "react";
import type { CombatLegalAction, CombatReadResponse, EncounterPublic } from "@velvet/contracts";
import "./situationActions.css";

/** Narrow reader needed to discover the active encounter and its legal actions. */
export interface SituationActionsApi {
  listEncounters: (campaignId: string) => Promise<{ encounters: EncounterPublic[] }>;
  getCombat: (combatId: string) => Promise<CombatReadResponse>;
}

export interface SituationActionsProps {
  campaignId: string;
  sessionId: string;
  controlledActorId?: string;
  api?: SituationActionsApi;
  refreshKey?: number;
  disabled?: boolean;
  onInsert: (declaration: string) => void;
}

const supportedKinds = ["attack", "flee", "end-turn", "stabilize", "death-save", "grapple", "escape-grapple", "shove", "stand-up", "dash", "disengage", "help", "hide", "ready"] as const;
type SupportedKind = (typeof supportedKinds)[number];
const isSupported = (action: CombatLegalAction): action is CombatLegalAction & { kind: SupportedKind } =>
  (supportedKinds as readonly string[]).includes(action.kind);

const actionLabel: Record<SupportedKind, string> = {
  attack: "Attack", flee: "Flee", "end-turn": "End turn", stabilize: "Stabilize", "death-save": "Make death save",
  grapple: "Grapple", "escape-grapple": "Escape grapple", shove: "Shove", "stand-up": "Stand up",
  dash: "Dash", disengage: "Disengage", help: "Help", hide: "Hide", ready: "Ready",
};
const targeted = new Set<SupportedKind>(["attack", "stabilize", "grapple", "escape-grapple", "shove", "stand-up", "help"]);

function declarationFor(kind: SupportedKind, target: string | null): string {
  switch (kind) {
    case "attack": return `I attack ${target ?? "the nearest enemy"} with my weapon.`;
    case "death-save": return "I fight through the dark and roll a death saving throw.";
    case "end-turn": return "I end my turn.";
    case "dash": return "I dash to gain extra movement this turn.";
    case "disengage": return "I disengage so I can leave reach safely.";
    case "hide": return "I hide from the enemies.";
    case "ready": return "I ready an action for when the moment turns.";
    case "flee": return "I flee the encounter.";
    case "grapple": return `I grapple ${target ?? "the nearest enemy"}.`;
    case "escape-grapple": return "I break free of the grapple.";
    case "shove": return `I shove ${target ?? "the nearest enemy"} prone.`;
    case "stand-up": return "I stand up from prone.";
    case "stabilize": return `I stabilize ${target ?? "my fallen ally"}.`;
    case "help": return `I help ${target ?? "my ally"}.`;
  }
}

/** Situation-aware mechanics for the controlled actor's turn, inserted as exact action context. */
export function SituationActions({ campaignId, sessionId, controlledActorId, api, refreshKey = 0, disabled = false, onInsert }: SituationActionsProps) {
  const [combat, setCombat] = useState<CombatReadResponse | null>(null);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (!api) { setCombat(null); return; }
    let alive = true;
    (async () => {
      try {
        const { encounters } = await api.listEncounters(campaignId);
        const active = encounters.find((encounter) => encounter.sessionId === sessionId && encounter.status === "active" && encounter.combatId);
        if (!active?.combatId) { if (alive) setCombat(null); return; }
        const state = await api.getCombat(active.combatId);
        if (alive) setCombat(state);
      } catch { if (alive) setCombat(null); }
    })();
    return () => { alive = false; };
  }, [api, campaignId, refreshKey, sessionId]);

  const labels = useMemo(() => new Map((combat?.combatants ?? []).map((combatant) => [combatant.combatantId,
    combatant.displayName ?? (combatant.kind === "actor" ? combatant.actorId : combatant.combatantId)])), [combat]);
  const current = combat?.combatants.find((combatant) => combatant.combatantId === combat?.currentCombatant) ?? null;
  const currentActorId = current?.kind === "actor" ? current.actorId : null;
  const ownTurn = Boolean(combat && controlledActorId && currentActorId === controlledActorId);
  const actions = (combat?.legalActions ?? []).filter(isSupported);
  const actionButtons = actions.flatMap((action) => {
    const kind = action.kind as SupportedKind;
    if (targeted.has(kind)) {
      return action.targetIds.map((targetId) => {
        const target = labels.get(targetId) ?? null;
        return <button type="button" className="ghost" key={`${action.legalActionId}:${targetId}`} disabled={disabled}
          onClick={() => onInsert(declarationFor(kind, target))}>{actionLabel[kind]}{target ? `: ${target}` : ""}</button>;
      });
    }
    return [<button type="button" className="ghost" key={action.legalActionId} disabled={disabled}
      onClick={() => onInsert(declarationFor(kind, null))}>{actionLabel[kind]}</button>];
  });
  const offer = ownTurn && actionButtons.length > 0;

  if (!combat) return null;

  return <section className="situation-actions" aria-label="Situation actions">
    <div className="situation-actions-heading">
      <p className="eyebrow">ROUND {combat.round} · {current ? (currentActorId === controlledActorId ? "YOUR TURN" : `${labels.get(current.combatantId) ?? "Another combatant"}'S TURN`) : "COMBAT"}</p>
      <div className="situation-heading-end">
        <h3>What can I do?</h3>
        {offer && <span className="situation-count" aria-hidden="true">{actionButtons.length}</span>}
        {offer && <button type="button" className="ghost situation-toggle" aria-expanded={expanded} aria-controls="situation-action-buttons"
          onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide options" : "Show options"}</button>}
      </div>
    </div>
    {!ownTurn && <p className="situation-note" role="status">It is not this character&apos;s turn. Options appear when the initiative order reaches them.</p>}
    {ownTurn && actionButtons.length === 0 && <p className="situation-note" role="status">No supported action can be taken right now.</p>}
    {offer && expanded && <>
      <div id="situation-action-buttons" className="situation-action-buttons" role="group" aria-label="Insert a situation action into your declaration">{actionButtons}</div>
      <p className="situation-note">Each button writes an exact declaration. Add context from your character sheet, then declare it; the DM accepts or rejects the attempt and resolves it against the rules.</p>
    </>}
  </section>;
}
