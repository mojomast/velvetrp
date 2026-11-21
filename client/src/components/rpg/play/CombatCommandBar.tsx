import { useEffect, useState } from "react";
import type {
  CombatActionCommandResponse,
  CombatEndCommandResponse,
  CombatEnemyTurnCommandRequest,
  CombatHandoffCommandRequest,
  CombatSkipTurnCommandRequest,
  CombatTurnClockResponse,
} from "@velvet/contracts";
import { createClientId } from "../../../utils/clientId";
import { useActiveCombat, type ActiveCombatApi } from "./useActiveCombat";
import "./combatCommandBar.css";

/** Server statuses that still count as a living side when combat is resolved. */
const LIVING_STATUSES = new Set(["active", "unconscious", "stable"]);
const commandId = () => `combat-bar-${createClientId()}`;

type CombatHandoffResult = {
  playedByGmUntilReturn?: CombatTurnClockResponse["playedByGmUntilReturn"];
  revision?: number;
};

/** Combat reads plus the encounter-level commands the bar can issue. */
export interface CombatCommandApi extends ActiveCombatApi {
  endCombat: (
    combatId: string,
    input: { expectedRevision: number; idempotencyKey: string },
  ) => Promise<CombatEndCommandResponse>;
  resolveEnemyTurn?: (combatId: string, command: CombatEnemyTurnCommandRequest) => Promise<CombatActionCommandResponse>;
  getTurnClock?: (combatId: string) => Promise<CombatTurnClockResponse>;
  skipCurrentTurn?: (combatId: string, command: CombatSkipTurnCommandRequest) => Promise<unknown>;
  takeOverActor?: (
    combatId: string,
    command: Omit<CombatHandoffCommandRequest, "action">,
  ) => Promise<CombatHandoffResult>;
  reclaimActor?: (
    combatId: string,
    command: Omit<CombatHandoffCommandRequest, "action">,
  ) => Promise<CombatHandoffResult>;
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
  /** The story-first table uses the shared durable combat review/recovery controller. */
  reviewInTool?: boolean;
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
export function CombatCommandBar({
  campaignId,
  sessionId,
  controlledActorId,
  canManage,
  api,
  refreshKey = 0,
  disabled = false,
  reviewInTool = false,
  onOpenCombat,
  onInsertDeclaration,
  onChanged,
}: CombatCommandBarProps) {
  const active = useActiveCombat(campaignId, sessionId, api, refreshKey);
  const [pending, setPending] = useState<"complete" | "enemy" | "skip" | "takeover" | "reclaim" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clock, setClock] = useState<CombatTurnClockResponse | null>(null);
  const [clockRefresh, setClockRefresh] = useState(0);
  const [, setClockTick] = useState(0);
  const combatIdForClock = active?.combatId;

  useEffect(() => {
    if (!api?.getTurnClock || !combatIdForClock) {
      setClock(null);
      return;
    }
    let alive = true;
    void api.getTurnClock(combatIdForClock).then(
      (next) => {
        if (alive) setClock(next);
      },
      () => {
        if (alive) setClock(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, combatIdForClock, clockRefresh, refreshKey]);

  useEffect(() => {
    if (!clock?.currentTurnStartedAt) return;
    const timer = setInterval(() => setClockTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [clock?.currentTurnStartedAt]);

  if (!active || !api) {
    // After a successful completion the next refresh clears the active combat.
    // Keep the confirmation visible until the player navigates or reloads.
    return notice === null ? null : (
      <section className="combat-command-bar is-terminal" aria-label="Combat controls">
        <div className="combat-command-status">
          <p className="eyebrow">COMBAT COMPLETE</p>
          <p className="combat-command-hint" role="status">
            {notice}
          </p>
        </div>
        <div className="combat-command-actions">
          <button type="button" className="ghost" onClick={onOpenCombat}>
            Open combat
          </button>
        </div>
      </section>
    );
  }
  const { combatId, combat } = active;
  const current = combat.combatants.find((combatant) => combatant.combatantId === combat.currentCombatant) ?? null;
  const ownTurn = Boolean(
    current && controlledActorId && current.kind === "actor" && current.actorId === controlledActorId,
  );
  const enemyTurn = current?.kind === "enemy";
  const livingEnemies = combat.combatants.filter(
    (combatant) => combatant.team === "enemies" && LIVING_STATUSES.has(combatant.status),
  ).length;
  const livingAllies = combat.combatants.filter(
    (combatant) => combatant.team === "allies" && LIVING_STATUSES.has(combatant.status),
  ).length;
  const terminal = combat.currentCombatant === null && (livingEnemies === 0 || livingAllies === 0);
  const statusText = terminal
    ? livingEnemies === 0
      ? "ALL ENEMIES DEFEATED"
      : "PARTY DEFEATED"
    : ownTurn
      ? "YOUR TURN"
      : current
        ? `${current.displayName ?? (current.kind === "actor" ? current.actorId : "ENEMY")}'S TURN`
        : "COMBAT";
  const hint = terminal
    ? "Complete the encounter to mark it finished and settle rewards."
    : ownTurn
      ? "Choose an action from the options below, or end your turn."
      : enemyTurn
        ? canManage
          ? "Resolve the enemy turn when you are ready."
          : "The enemy is taking its turn."
        : current
          ? `Waiting on ${current.displayName ?? (current.kind === "actor" ? current.actorId : "ENEMY")}.`
          : "Waiting on the current turn.";
  const timeoutSeconds = clock?.timeoutSeconds ?? 90;
  const remainingSeconds = clock?.currentTurnStartedAt
    ? Math.max(0, Math.ceil((Date.parse(clock.currentTurnStartedAt) + timeoutSeconds * 1000 - Date.now()) / 1000))
    : null;
  const remainingLabel =
    remainingSeconds === null
      ? null
      : `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")} remaining`;
  const playedByGm = Boolean(
    current?.kind === "actor" && clock?.playedByGmUntilReturn?.some((handoff) => handoff.actorId === current.actorId),
  );
  const controlledHandoff = Boolean(
    controlledActorId && clock?.playedByGmUntilReturn?.some((handoff) => handoff.actorId === controlledActorId),
  );

  async function runEnemyTurn(): Promise<void> {
    if (!api?.resolveEnemyTurn || disabled || reviewInTool || pending) return;
    setPending("enemy");
    setNotice(null);
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

  async function skipTurn(): Promise<void> {
    if (!api?.skipCurrentTurn || disabled || reviewInTool || pending) return;
    setPending("skip");
    setNotice(null);
    try {
      await api.skipCurrentTurn(combatId, { expectedRevision: combat.revision, idempotencyKey: commandId() });
      setNotice("Turn skipped.");
      setClockRefresh((value) => value + 1);
      onChanged();
    } catch {
      setNotice("The turn could not be skipped. Refresh combat state before retrying.");
    } finally {
      setPending(null);
    }
  }

  async function playAs(): Promise<void> {
    if (!api?.takeOverActor || !current || current.kind !== "actor" || disabled || reviewInTool || pending) return;
    setPending("takeover");
    setNotice(null);
    try {
      await api.takeOverActor(combatId, {
        actorId: current.actorId,
        expectedRevision: combat.revision,
        idempotencyKey: commandId(),
      });
      setNotice(`The GM has taken over ${current.displayName ?? current.actorId}.`);
      setClockRefresh((value) => value + 1);
      onChanged();
    } catch {
      setNotice("The actor could not be handed to the GM. Refresh combat state before retrying.");
    } finally {
      setPending(null);
    }
  }

  async function resumePlay(): Promise<void> {
    if (!api?.reclaimActor || !controlledActorId || disabled || reviewInTool || pending) return;
    setPending("reclaim");
    setNotice(null);
    try {
      await api.reclaimActor(combatId, {
        actorId: controlledActorId,
        expectedRevision: combat.revision,
        idempotencyKey: commandId(),
      });
      setNotice("You have resumed play.");
      setClockRefresh((value) => value + 1);
      onChanged();
    } catch {
      setNotice("Play could not be resumed. Refresh combat state before retrying.");
    } finally {
      setPending(null);
    }
  }

  async function complete(): Promise<void> {
    if (disabled || reviewInTool || pending) return;
    setPending("complete");
    setNotice(null);
    try {
      const result = await api!.endCombat(combatId, { expectedRevision: combat.revision, idempotencyKey: commandId() });
      setNotice(
        result.rewards.length > 0
          ? "Encounter completed. Reward bundles are ready for settlement under Combat & rewards."
          : "Encounter completed.",
      );
      onChanged();
    } catch {
      setNotice("Combat could not be ended. Refresh and review the encounter state before retrying.");
    } finally {
      setPending(null);
    }
  }

  return (
    <section className={`combat-command-bar${terminal ? " is-terminal" : ""}`} aria-label="Combat controls">
      <div className="combat-command-status">
        <p className="eyebrow">
          ROUND {combat.round} · {statusText}
        </p>
        <p className="combat-command-hint">{hint}</p>
        {remainingLabel && (
          <p className="combat-command-hint" role="status">
            {remainingLabel}
          </p>
        )}
        {(playedByGm || controlledHandoff) && <p className="combat-command-hint">played by GM until they return</p>}
      </div>
      <div className="combat-command-actions">
        {ownTurn && (
          <button
            type="button"
            className="primary"
            disabled={disabled}
            onClick={() => onInsertDeclaration("I end my turn.")}
          >
            End turn
          </button>
        )}
        {canManage && current?.kind === "actor" && !ownTurn && !enemyTurn && !playedByGm && api.takeOverActor && (
          <button type="button" className="ghost" disabled={disabled || pending !== null} onClick={() => void playAs()}>
            Play as {current.displayName ?? current.actorId}
          </button>
        )}
        {canManage && current?.kind === "actor" && !ownTurn && !enemyTurn && api.skipCurrentTurn && (
          <button
            type="button"
            className="ghost"
            disabled={disabled || pending !== null}
            onClick={() => void skipTurn()}
          >
            Skip turn
          </button>
        )}
        {controlledHandoff && api.reclaimActor && (
          <button
            type="button"
            className="primary"
            disabled={disabled || pending !== null}
            onClick={() => void resumePlay()}
          >
            Resume play
          </button>
        )}
        {canManage && enemyTurn && api.resolveEnemyTurn && !reviewInTool && (
          <button
            type="button"
            className="primary"
            disabled={disabled || pending !== null}
            onClick={() => void runEnemyTurn()}
          >
            Run enemy turn
          </button>
        )}
        {canManage && terminal && (
          <button
            type="button"
            className="primary"
            disabled={disabled || pending !== null}
            onClick={() => (reviewInTool ? onOpenCombat() : void complete())}
          >
            {pending === "complete"
              ? "Completing…"
              : reviewInTool
                ? "Review encounter completion"
                : "Complete encounter"}
          </button>
        )}
        <button type="button" className="ghost" onClick={onOpenCombat}>
          Open combat
        </button>
      </div>
      {notice && (
        <p className="combat-command-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
