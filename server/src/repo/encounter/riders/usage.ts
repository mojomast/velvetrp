import type DatabaseDriver from "better-sqlite3";

/**
 * Reads the rider ids already resolved by one combatant during its current
 * turn. The active turn economy's start timestamp bounds the scan and the
 * acting combatant is read back from the sealed receipt, so a new turn
 * naturally forgets the previous turn's once-per-turn riders.
 */
export function readRiderUsageThisTurn(db: DatabaseDriver.Database, encounterId: string, combatantId: string): ReadonlySet<string> {
  const used = new Set<string>();
  const economy = db.prepare("SELECT started_at FROM combat_turn_economy_v60 WHERE encounter_id=? AND ended_at IS NULL")
    .get(encounterId) as { started_at: string } | undefined;
  if (!economy) return used;
  const rows = db.prepare(`SELECT receipt.canonical_result_json json
    FROM combat_receipts_v27 receipt JOIN combat_commands_v27 command
      ON command.encounter_id=receipt.encounter_id AND command.command_id=receipt.command_id
    WHERE receipt.encounter_id=? AND receipt.occurred_at>=?
      AND json_extract(receipt.canonical_result_json,'$.resolution.actingCombatantId')=?`)
    .all(encounterId, economy.started_at, combatantId) as Array<{ json: string }>;
  for (const row of rows) {
    try {
      const result = JSON.parse(row.json) as { riders?: Array<{ riderId?: unknown }> };
      for (const rider of result.riders ?? []) if (typeof rider.riderId === "string") used.add(rider.riderId);
    } catch {
      // Malformed historical audit rows cannot grant a once-per-turn rider.
    }
  }
  return used;
}
