import type DatabaseDriver from "better-sqlite3";
import { applyCombatCondition } from "../combatConditionRuntime.js";
import type { AttackRiderResolution } from "./types.js";

/**
 * Applies every resolved rider condition to the attack target. Attribution
 * always points at the attacking combatant and the exact resolving command so
 * the persisted condition has a verifiable source.
 */
export function applyAttackRiderConditions(
  db: DatabaseDriver.Database,
  encounterId: string,
  targetCombatantId: string,
  sourceCombatantId: string,
  commandId: string,
  at: string,
  riders: readonly AttackRiderResolution[],
): void {
  for (const rider of riders) {
    if (!rider.condition) continue;
    applyCombatCondition(db, encounterId, targetCombatantId, rider.condition.condition,
      sourceCombatantId, commandId, rider.condition.durationRounds ?? null, at);
  }
}
