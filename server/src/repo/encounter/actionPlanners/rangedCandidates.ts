import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { resolveSrdEquipment } from "../../srdEquipmentRuntime.js";
import { authoritativeTacticalMapSchema } from "@velvet/contracts";
import { lineOfEffectBetween } from "../../../map/geometry.js";
import { pointKey } from "../../../map/types.js";
import type { RangedCombatCandidate } from "./types.js";

function rangedProfileRange(weapon: NonNullable<ReturnType<typeof resolveSrdEquipment>["weapon"]>) {
  const property = weapon.properties.find((value) => value.property === "ammunition" || value.property === "thrown");
  return property?.range ?? null;
}

/** Reads tactical state only when the combat map and both exact tokens are authoritative. */
export function buildRangedCombatCandidate(db: DatabaseDriver.Database, campaignId: string, encounterId: string,
  attackerId: string, targetIds: string[]): RangedCombatCandidate | null {
  let equipment: ReturnType<typeof resolveSrdEquipment>;
  try { equipment = resolveSrdEquipment(db, campaignId, attackerId); } catch { return null; }
  const weapon = equipment.weapon;
  if (!weapon || weapon.properties.every((value) => value.property !== "ammunition" && value.property !== "thrown")
    || weapon.properties.some((value) => value.property === "thrown")) return null;
  const range = rangedProfileRange(weapon);
  if (!range) return null;
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
  const targetEvidence = targetIds.map((id) => { const target = byId.get(id)!; const dx = Math.abs(target.x - source.x), dy = Math.abs(target.y - source.y);
    const feet = Math.max(dx, dy) * 5; rangeFeetByTarget[id] = feet; const ray = lineOfEffectBetween(source, target, tile);
    return { targetCombatantId: id, lineOfEffect: ray.lineOfEffect, cover: ray.cover, blockedBy: ray.blockedBy,
      ...(ray.supported ? {} : { reason: "unsupported-geometry" as const }), ...(ray.cover === "full" ? { reason: "full-cover" as const } : {}) }; });
  const legal = targetEvidence.filter((evidence) => rangeFeetByTarget[evidence.targetCombatantId]! <= range.longFeet && evidence.cover !== "full")
    .map((evidence) => evidence.targetCombatantId);
  const ammunition = db.prepare(`SELECT ammo.resource_name FROM rpg_actor_resource_ammunition_v25 ammo
    JOIN rpg_actor_resource_bindings_v25 binding ON binding.campaign_id=ammo.campaign_id AND binding.actor_id=ammo.actor_id AND binding.resource_name=ammo.resource_name
    WHERE ammo.campaign_id=? AND ammo.actor_id=? AND ammo.current_ammunition>0
      AND json_extract(binding.binding_json,'$.kind')='ammunition' ORDER BY ammo.resource_name`).all(campaignId, attackerId) as Array<{ resource_name: string }>;
  if (ammunition.length !== 1) return null;
  const attackId = `attack:ranged:${createHash("sha256").update(JSON.stringify({ actorId: attackerId, revision: equipment.revision, weapon, targetEvidence })).digest("hex").slice(0, 48)}`;
  return { attackId, weaponEntryId: weapon.entryId, attackAbility: weapon.attackAbility, normalRangeFeet: range.normalFeet,
    longRangeFeet: range.longFeet, ammunitionResourceId: ammunition[0]!.resource_name, targetIds: legal, rangeFeetByTarget, targetEvidence };
}
