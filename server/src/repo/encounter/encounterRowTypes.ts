import { combatLogEntrySchema, type CombatLogEntry } from "@velvet/contracts";

/** Minimal `combat_log` projection used to build the public combat log. */
export interface CombatLogRow {
  log_id: string;
  log_json: string;
  occurred_at: string;
}

/**
 * Maps persisted combat-log rows to their validated public projections.
 *
 * Malformed internal audit records are deliberately omitted so they cannot
 * leak through the public combat-log read surface.
 */
export function projectCombatLogRows(
  rows: readonly CombatLogRow[],
  campaignId: string,
  encounterId: string,
): CombatLogEntry[] {
  return rows.flatMap((row, index) => {
    try {
      return [combatLogEntrySchema.parse({
        logEntryId: row.log_id,
        campaignId,
        encounterId,
        sequence: index + 1,
        occurredAt: row.occurred_at,
        event: JSON.parse(row.log_json),
      })];
    } catch {
      return [];
    }
  });
}
