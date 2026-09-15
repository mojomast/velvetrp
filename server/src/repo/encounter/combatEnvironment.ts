import type DatabaseDriver from "better-sqlite3";
import { pointKey, type MapTile } from "../../map/types.js";
import { dnd5eUnderwaterDamageAdjustment } from "../../rulesets/index.js";

/**
 * Reads the active combat tactical map so the durable attack paths can apply
 * the pure SRD vision and underwater rules to persisted terrain. Maps are
 * optional: a combat without an authoritative map yields null terrain and the
 * shared attack-condition planner keeps its previous behavior.
 */

type ActiveMapRow = { map_id: string; tiles_json: string };

function activeCombatMapRow(db: DatabaseDriver.Database, encounterId: string): ActiveMapRow | null {
  const row = db.prepare("SELECT map_id,tiles_json FROM tactical_maps_v58 WHERE encounter_id=? AND mode='combat' AND active=1")
    .get(encounterId) as ActiveMapRow | undefined;
  return row ?? null;
}

/** Tile index for the active combat map, or null when no authoritative map exists. */
export function activeCombatMapTiles(db: DatabaseDriver.Database, encounterId: string): ReadonlyMap<string, MapTile> | null {
  const row = activeCombatMapRow(db, encounterId);
  if (!row) return null;
  const tiles = JSON.parse(row.tiles_json) as MapTile[];
  return new Map(tiles.map((tile) => [pointKey(tile.position), tile]));
}

/** Terrain under each combatant's token, or null when the map, tile, or token is absent. */
export function combatantTerrains(db: DatabaseDriver.Database, encounterId: string, combatantIds: readonly string[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const id of combatantIds) result.set(id, null);
  if (combatantIds.length === 0) return result;
  const row = activeCombatMapRow(db, encounterId);
  if (!row) return result;
  const tiles = activeCombatMapTiles(db, encounterId)!;
  const placeholders = combatantIds.map(() => "?").join(",");
  const tokens = db.prepare(`SELECT combatant_id,x,y FROM tactical_map_tokens_v58 WHERE map_id=? AND combatant_id IN (${placeholders})`)
    .all(row.map_id, ...combatantIds) as Array<{ combatant_id: string; x: number; y: number }>;
  for (const token of tokens) result.set(token.combatant_id, tiles.get(pointKey({ x: token.x, y: token.y }))?.terrain ?? null);
  return result;
}

/** True when persisted terrain places a creature fully immersed for the SRD underwater rules. */
export function underwaterTerrain(terrain: string | null | undefined): boolean {
  return terrain === "water";
}

export type CombatDamageAdjustmentValue = "none" | "resistance" | "vulnerability" | "immunity";

/**
 * Folds the SRD underwater fire resistance into an already-resolved damage
 * adjustment. An explicit immunity or vulnerability is never downgraded.
 */
export function underwaterDamageAdjustment(base: CombatDamageAdjustmentValue, damageType: string, terrain: string | null | undefined): CombatDamageAdjustmentValue {
  return base === "none" && dnd5eUnderwaterDamageAdjustment(damageType, underwaterTerrain(terrain)) === "resistance" ? "resistance" : base;
}
