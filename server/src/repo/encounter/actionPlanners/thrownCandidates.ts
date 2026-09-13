import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { resolveSrdEquipment } from "../../srdEquipmentRuntime.js";
import { authoritativeTacticalMapSchema } from "@velvet/contracts";
import { lineOfEffectBetween } from "../../../map/geometry.js";
import { pointKey } from "../../../map/types.js";
import type { ThrownCombatCandidate } from "./types.js";

/** Thrown weapons use their melee profile and a carried matching item, never an ammo resource. */
export function buildThrownCombatCandidate(db: DatabaseDriver.Database, campaignId: string, encounterId: string,
  attackerId: string, targetIds: string[]): ThrownCombatCandidate | null {
  let equipment: ReturnType<typeof resolveSrdEquipment>;
  try { equipment = resolveSrdEquipment(db, campaignId, attackerId); } catch { return null; }
  const weapon = equipment.weapon;
  const thrown = weapon?.properties.find((value) => value.property === "thrown");
  if (!weapon || weapon.properties.some((value) => value.property === "ammunition" || value.property === "loading")
    || weapon.properties.filter((value) => value.property === "thrown").length !== 1 || !thrown || weapon.grip !== "one-handed") return null;
  const throwable = db.prepare(`SELECT entry_id,quantity FROM rpg_inventory_entries_v25
    WHERE campaign_id=? AND actor_id=? AND item_pack_id=? AND item_pack_version=? AND item_definition_id=?
      AND equipped=0 AND quantity>0 ORDER BY created_at,entry_id LIMIT 1`)
    .get(campaignId, attackerId, weapon.reference.packId, weapon.reference.packVersion, weapon.reference.definitionId) as
    { entry_id: string; quantity: number } | undefined;
  if (!throwable) return null;
  const map = db.prepare("SELECT tiles_json,width,height FROM tactical_maps_v58 WHERE campaign_id=? AND encounter_id=? AND mode='combat' AND active=1")
    .get(campaignId, encounterId) as { tiles_json: string; width: number; height: number } | undefined;
  if (!map) return null;
  let tiles: ReturnType<typeof authoritativeTacticalMapSchema.parse>["tiles"];
  try { tiles = authoritativeTacticalMapSchema.parse({ mapId: "combat", width: map.width, height: map.height,
    grid: { kind: "square", feetPerCell: 5 }, tiles: JSON.parse(map.tiles_json), tokens: [], provenance: null }).tiles; } catch { return null; }
  const tokens = db.prepare("SELECT combatant_id,x,y,width,height FROM tactical_map_tokens_v58 WHERE map_id=(SELECT map_id FROM tactical_maps_v58 WHERE campaign_id=? AND encounter_id=? AND mode='combat' AND active=1) AND combatant_id IN (" + targetIds.map(() => "?").concat("?").join(",") + ")")
    .all(campaignId, encounterId, ...targetIds, attackerId) as Array<{ combatant_id: string; x: number; y: number; width: number; height: number }>;
  const byId = new Map(tokens.map((token) => [token.combatant_id, token]));
  const source = byId.get(attackerId);
  if (!source || targetIds.some((id) => !byId.has(id))) return null;
  if ([source, ...targetIds.map((id) => byId.get(id)!)].some((token) => token.width !== 1 || token.height !== 1)) return null;
  const tile = new Map(tiles.map((value) => [pointKey(value.position), value]));
  const rangeFeetByTarget: Record<string, number> = {};
  const targetEvidence = targetIds.map((id) => { const target = byId.get(id)!; const feet = Math.max(Math.abs(target.x - source.x), Math.abs(target.y - source.y)) * 5;
    rangeFeetByTarget[id] = feet; const ray = lineOfEffectBetween(source, target, tile);
    return { targetCombatantId: id, lineOfEffect: ray.lineOfEffect, cover: ray.cover, blockedBy: ray.blockedBy,
      ...(ray.supported ? {} : { reason: "unsupported-geometry" as const }), ...(ray.cover === "full" ? { reason: "full-cover" as const } : {}) }; });
  const legal = targetEvidence.filter((evidence) => rangeFeetByTarget[evidence.targetCombatantId]! <= thrown.range.longFeet && evidence.cover !== "full")
    .map((evidence) => evidence.targetCombatantId);
  const attackId = `attack:thrown:${createHash("sha256").update(JSON.stringify({ actorId: attackerId, revision: equipment.revision, weapon, throwable: throwable.entry_id, targetEvidence })).digest("hex").slice(0, 48)}`;
  return { attackId, weaponEntryId: weapon.entryId, throwableItemEntryId: throwable.entry_id, attackAbility: weapon.attackAbility,
    normalRangeFeet: thrown.range.normalFeet, longRangeFeet: thrown.range.longFeet, targetIds: legal, rangeFeetByTarget, targetEvidence };
}
