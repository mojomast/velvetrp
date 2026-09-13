import type DatabaseDriver from "better-sqlite3";
import type { RangedTargetEvidence } from "./types.js";

/** D&D 5e cover raises the target AC; full cover is handled as an illegal target. */
export function coverArmorClassBonus(cover: RangedTargetEvidence["cover"]): number {
  return cover === "half" ? 2 : cover === "three-quarters" ? 5 : 0;
}

/** True when an opposing active combatant stands within 5 feet on the active tactical map. */
export function hostileWithinFiveFeet(db: DatabaseDriver.Database, encounterId: string, combatantId: string, team: string): boolean {
  const map = db.prepare("SELECT map_id FROM tactical_maps_v58 WHERE encounter_id=? AND active=1").get(encounterId) as { map_id: string } | undefined;
  if (!map) return false;
  const self = db.prepare("SELECT x,y FROM tactical_map_tokens_v58 WHERE map_id=? AND combatant_id=?").get(map.map_id, combatantId) as { x: number; y: number } | undefined;
  if (!self) return false;
  const hostiles = db.prepare(`SELECT token.x x,token.y y FROM tactical_map_tokens_v58 token
    JOIN combatant ON combatant.encounter_id=? AND combatant.combatant_id=token.combatant_id
    WHERE token.map_id=? AND combatant.team<>? AND combatant.status='active'`).all(encounterId, map.map_id, team) as Array<{ x: number; y: number }>;
  return hostiles.some((hostile) => Math.max(Math.abs(hostile.x - self.x), Math.abs(hostile.y - self.y)) <= 1);
}
