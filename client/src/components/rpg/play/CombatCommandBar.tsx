import { useState } from "react";
import type { CombatActionCommandResponse, CombatEndCommandResponse, CombatEnemyTurnCommandRequest } from "@velvet/contracts";
import { createClientId } from "../../../utils/clientId";
import { useActiveCombat, type ActiveCombatApi } from "./useActiveCombat";
import "./combatCommandBar.css";

/** Server statuses that still count as a living side when combat is resolved. */
const LIVING_STATUSES = new Set(["active", "unconscious", "stable"]);
const commandId = () => `combat-bar-${createClientId()}`;

/** Combat reads plus the encounter-level commands the bar can issue. */
export interface CombatCommandApi extends ActiveCombatApi {
  endCombat: (combatId: string, input: { expectedRevision: number; idempotencyKey: string }) => Promise<CombatEndCommandResponse>;
  resolveEnemyTurn?: (combatId: string, command: CombatEnemyTurnCommandRequest) => Promise<CombatActionCommandResponse>;
}

export interface CombatCommandBarProps {
  campaignId: string;
  sessionId: string;
  controlledActorId?: string;
  /** Owner or GM: may resolve enemy turns and complete a terminal encounter. */
  canManage: boolean;
  api?: CombatCommandApi;
  refreshKey?: number;
  /** Blocks declaration insertion while the room reference is not ready. */
  disabled?: boolean;
  onOpenCombat: () => void;
  onInsertDeclaration: (declaration: string) => void;
  onChanged: () => void;
}

/**
 * Front-and-center combat controls for the play surface. Combat does not end by
 * itself when the last enemy drops, so the terminal state surfaces the exact
 * completion command next to the round and turn indicator instead of burying it
 * inside the combat tool.
 */
export function CombatCommandBar({ campaignId, sessionId, controlledActorId, canManage, api, refreshKey = 0, disabled = false, onOpenCombat, onInsertDeclaration, onChanged }: CombatCommandBarProps) {
  const active = useActiveCombat(campaignId, sessionId, api, refreshKey);
  const [pending, setPending] = useState<"complete" | "enemy" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!active || !api) {
    // After a successful completion the next refresh clears the active combat.
    // Keep the confirmation visible until the player navigates or reloads.
    return notice === null ? null : <section className="combat-command-bar is-terminal" aria-label="Combat controls">
      <div className="combat-command-status"><p className="eyebrow">COMBAT COMPLETE</p><p className="combat-command-hint" role="status">{notice}</p></div>
      <div className="combat-command-actions"><button type="button" className="ghost" onClick={onOpenCombat}>Open combat</button></div>
    </section>;
  }
  const { combatId, combat } = active;
  const current = combat.combatants.find((combatant) => combatant.combatantId === combat.currentCombatant) ?? null;
  const ownTurn = Boolean(current && controlledActorId && current.kind === "actor" && current.actorId === controlledActorId);
  const enemyTurn = current?.kind === "enemy";
  const livingEnemies = combat.combatants.filter((combatant) => combatant.team === "enemies" && LIVING_STATUSES.has(combatant.status)).length;
  const livingAllies = combat.combatants.filter((combatant) => combatant.team === "allies" && LIVING_STATUSES.has(combatant.status)).length;
  const terminal = combat.currentCombatant === null && (livingEnemies === 0 || livingAllies === 0);
  const statusText = terminal ? "ALL ENEMIES DEFEATED"
    : ownTurn ? "YOUR TURN"
      : current ? `${current.displayName ?? (current.kind === "actor" ? current.actorId : "ENEMY")}'S TURN`
        : "COMBAT";
  const hint = terminal ? "Complete the encounter to mark it finished and settle rewards."
    : ownTurn ? "Choose an action from the options below, or end your turn."
      : enemyTurn ? (canManage ? "Resolve the enemy turn when you are ready." : "The enemy is taking its turn.")
        : "Waiting on the current turn.";

  async function runEnemyTurn(): Promise<void> {
    if (!api?.resolveEnemyTurn) return;
    setPending("enemy"); setNotice(null);
    try {
      await api.resolveEnemyTurn(combatId, { expectedRevision: combat.revision, idempotencyKey: commandId() });
      setNotice("Enemy turn resolved.");
      onChanged();
    } catch {
      setNotice("The enemy turn could not be resolved. Refresh combat state before retrying.");
    } finally {
      setPending(null);
    }
  }

  async function complete(): Promise<void> {
    setPending("complete"); setNotice(null);
    try {
      const result = await api!.endCombat(combatId, { expectedRevision: combat.revision, idempotencyKey: commandId() });
      setNotice(result.rewards.length > 0
        ? "Encounter completed. Reward bundles are ready for settlement under Combat & rewards."
        : "Encounter completed.");
      onChanged();
    } catch {
      setNotice("Combat could not be ended. Refresh and review the encounter state before retrying.");
    } finally {
      setPending(null);
    }
  }

  return <section className={`combat-command-bar${terminal ? " is-terminal" : ""}`} aria-label="Combat controls">
    <div className="combat-command-status">
      <p className="eyebrow">ROUND {combat.round} · {statusText}</p>
      <p className="combat-command-hint">{hint}</p>
    </div>
    <div className="combat-command-actions">
      {ownTurn && <button type="button" className="primary" disabled={disabled} onClick={() => onInsertDeclaration("I end my turn.")}>End turn</button>}
      {canManage && enemyTurn && api.resolveEnemyTurn && <button type="button" className="primary" disabled={pending !== null} onClick={() => void runEnemyTurn()}>Run enemy turn</button>}
      {canManage && terminal && <button type="button" className="primary" disabled={pending !== null} onClick={() => void complete()}>{pending === "complete" ? "Completing…" : "Complete encounter"}</button>}
      <button type="button" className="ghost" onClick={onOpenCombat}>Open combat</button>
    </div>
    {notice && <p className="combat-command-notice" role="status">{notice}</p>}
  </section>;
}
