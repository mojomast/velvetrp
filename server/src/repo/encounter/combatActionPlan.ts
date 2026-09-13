import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { resolveSrdEquipment } from "../srdEquipmentRuntime.js";
import { resolveCampaignRuleset } from "../../rulesets/campaignBinding.js";
import { EncounterConflictError } from "./encounterErrors.js";
import { actionBlockingConditions, conditionsFor, mayAttackTarget } from "./combatConditionRuntime.js";
import { authoritativeTacticalMapSchema } from "@velvet/contracts";
import { lineOfEffectBetween } from "../../map/geometry.js";
import { pointKey } from "../../map/types.js";

export type CombatActionPlan = {
  legalActionId: string;
  kind: "attack" | "grapple" | "escape-grapple" | "dash" | "disengage" | "help" | "hide" | "flee" | "end-turn" | "stabilize" | "death-save";
  actingCombatantId: string;
  targetIds: string[];
  cost: "action" | null;
  attackType?: "melee" | "ranged" | "thrown";
  targetEvidence?: RangedTargetEvidence[];
};

export type RangedTargetEvidence = Readonly<{
  targetCombatantId: string;
  lineOfEffect: "clear" | "blocked";
  cover: "none" | "half" | "three-quarters" | "full";
  blockedBy: Array<{ x: number; y: number }>;
  reason?: "full-cover" | "unsupported-geometry";
}>;

/** D&D 5e cover raises the target AC; full cover is handled as an illegal target. */
export function coverArmorClassBonus(cover: RangedTargetEvidence["cover"]): number {
  return cover === "half" ? 2 : cover === "three-quarters" ? 5 : 0;
}

export type RangedCombatCandidate = Readonly<{
  attackId: string;
  weaponEntryId: string;
  attackAbility: "strength" | "dexterity";
  normalRangeFeet: number;
  longRangeFeet: number;
  ammunitionResourceId: string | null;
  targetIds: string[];
  rangeFeetByTarget: Record<string, number>;
  targetEvidence: RangedTargetEvidence[];
}>;

export type ThrownCombatCandidate = Readonly<{
  attackId: string;
  weaponEntryId: string;
  throwableItemEntryId: string;
  attackAbility: "strength" | "dexterity";
  normalRangeFeet: number;
  longRangeFeet: number;
  targetIds: string[];
  rangeFeetByTarget: Record<string, number>;
  targetEvidence: RangedTargetEvidence[];
}>;

/** Contract-only seam for a future spell runtime; this module never resolves spells. */
export type CombatSpellRangedCandidate = Readonly<{
  kind: "spell";
  spellId: string;
  attackAbility: "strength" | "dexterity";
  attackModifier: number;
  rangeFeet: number;
  targetIds: string[];
}>;
export interface CombatSpellCandidateProvider {
  getCombatRangedCandidates(campaignId: string, encounterId: string, combatantId: string): readonly CombatSpellRangedCandidate[];
}

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

export type PersistedCombatTurnEconomy = {
  turnId: string;
  combatantId: string;
  round: number;
  action: { available: boolean; used: boolean };
  bonusAction: { available: boolean; used: boolean };
  reaction: { available: boolean; used: boolean };
  movement: { allowanceFeet: number; usedFeet: number; remainingFeet: number };
};

export function isDndCombat(db: DatabaseDriver.Database, campaignId: string): boolean {
  try { return resolveCampaignRuleset(db, campaignId).rulesetId === "dnd-5e"; } catch { return false; }
}

export function readCombatTurnEconomy(
  db: DatabaseDriver.Database,
  encounterId: string,
): PersistedCombatTurnEconomy | null {
  const row = db.prepare(`SELECT turn_id,combatant_id,round_number,action_used,bonus_action_used,reaction_used,
    movement_allowance_feet,movement_used_feet FROM combat_turn_economy_v60
    WHERE encounter_id=? AND ended_at IS NULL`).get(encounterId) as any;
  if (!row) return null;
  const resource = (used: number) => ({ available: used === 0, used: used === 1 });
  return { turnId: row.turn_id, combatantId: row.combatant_id, round: row.round_number,
    action: resource(row.action_used), bonusAction: resource(row.bonus_action_used), reaction: resource(row.reaction_used),
    movement: { allowanceFeet: row.movement_allowance_feet, usedFeet: row.movement_used_feet,
      remainingFeet: row.movement_allowance_feet - row.movement_used_feet } };
}

function movementAllowance(db: DatabaseDriver.Database, campaignId: string, combatantId: string): number {
  const row = db.prepare(`SELECT combatant.actor_id,progression.derived_json,definition.definition_json
    FROM combatant LEFT JOIN character_progression_v23 progression
      ON progression.campaign_id=combatant.campaign_id AND progression.actor_id=combatant.actor_id
    LEFT JOIN encounter_enemy_provenance_v31 provenance ON provenance.combatant_id=combatant.combatant_id
    LEFT JOIN rpg_catalog_definitions definition ON definition.pack_id=provenance.pack_id
      AND definition.pack_version=provenance.pack_version AND definition.kind=provenance.kind
      AND definition.definition_id=provenance.definition_id
    WHERE combatant.campaign_id=? AND combatant.combatant_id=?`).get(campaignId, combatantId) as any;
  try {
    const value = row?.actor_id ? JSON.parse(row.derived_json).speed : JSON.parse(row?.definition_json ?? "{}").mechanics?.speed;
    const base = Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
    const encounter = db.prepare("SELECT encounter_id,round_number FROM encounter WHERE current_turn_combatant_id=? AND campaign_id=? AND status='active'")
      .get(combatantId, campaignId) as { encounter_id: string; round_number: number } | undefined;
    return encounter && (["grappled", "restrained", "stunned", "unconscious"].some((condition) =>
      conditionsFor(db, encounter.encounter_id, combatantId, encounter.round_number).has(condition))) ? 0 : base;
  } catch { return 0; }
}

export function beginDndCombatTurn(
  db: DatabaseDriver.Database,
  campaignId: string,
  encounterId: string,
  combatantId: string,
  round: number,
  turnId: string,
  at: string,
): void {
  if (!isDndCombat(db, campaignId)) return;
  if (readCombatTurnEconomy(db, encounterId)) throw new Error("combat already has a current turn economy");
  db.prepare(`INSERT INTO combat_turn_economy_v60(turn_id,encounter_id,combatant_id,round_number,
    movement_allowance_feet,started_at) VALUES(?,?,?,?,?,?)`)
    .run(turnId, encounterId, combatantId, round, movementAllowance(db, campaignId, combatantId), at);
}

export function endDndCombatTurn(db: DatabaseDriver.Database, encounterId: string, at: string): void {
  const economy = readCombatTurnEconomy(db, encounterId);
  if (economy) db.prepare("UPDATE combat_turn_economy_v60 SET ended_at=? WHERE turn_id=? AND ended_at IS NULL")
    .run(at, economy.turnId);
}

export function consumeDndTurnCost(
  db: DatabaseDriver.Database,
  encounterId: string,
  combatantId: string,
  cost: "action" | "bonus-action" | "reaction",
): void {
  const column = cost === "bonus-action" ? "bonus_action_used" : `${cost}_used`;
  const result = db.prepare(`UPDATE combat_turn_economy_v60 SET ${column}=1
    WHERE encounter_id=? AND combatant_id=? AND ended_at IS NULL AND ${column}=0`).run(encounterId, combatantId);
  if (result.changes !== 1) throw new EncounterConflictError(`combat turn ${cost} is unavailable`);
}

/** One authoritative action planner shared by combat reads and writes. */
export function buildCombatActionPlans(
  db: DatabaseDriver.Database,
  principal: string,
  campaignId: string,
  encounterId: string,
  currentCombatantId: string | null,
): CombatActionPlan[] {
  if (currentCombatantId === null) return [];
  const current = db.prepare(`SELECT combatant_id,combatant_kind,actor_id,team,status FROM combatant
    WHERE encounter_id=? AND combatant_id=? AND status IN ('active','unconscious')`).get(encounterId, currentCombatantId) as any;
  if (!current) return [];
  // Enemy turns are intentionally not caller-planned in D&D combat.
  if (current.combatant_kind === "enemy" && isDndCombat(db, campaignId)) return [];
  const gm = Boolean(db.prepare(`SELECT 1 FROM campaign_memberships
    WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')`).get(campaignId, principal));
  const controls = current.actor_id !== null && Boolean(db.prepare(`SELECT 1 FROM campaign_actor_private_state
    WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`).get(campaignId, current.actor_id, principal));
  if (!gm && !controls) return [];
  let ruleset: ReturnType<typeof resolveCampaignRuleset>;
  try { ruleset = resolveCampaignRuleset(db, campaignId); } catch { return []; }
  const economy = ruleset.rulesetId === "dnd-5e" ? readCombatTurnEconomy(db, encounterId) : null;
  if (ruleset.rulesetId === "dnd-5e" && (!economy || economy.combatantId !== current.combatant_id)) return [];
  if (ruleset.rulesetId === "dnd-5e" && current.status === "unconscious") return [{ legalActionId: "death-save", kind: "death-save" as const,
    actingCombatantId: current.combatant_id, targetIds: [], cost: null }];
  const conditions = conditionsFor(db, encounterId, current.combatant_id, economy?.round ?? 0);
  if (ruleset.rulesetId === "dnd-5e" && [...actionBlockingConditions].some((condition) => conditions.has(condition))) {
    return [{ legalActionId: "end-turn", kind: "end-turn" as const, actingCombatantId: current.combatant_id, targetIds: [], cost: null }];
  }
  const targets = (db.prepare(`SELECT combatant_id FROM combatant WHERE encounter_id=? AND status ${ruleset.rulesetId === "dnd-5e" ? "IN ('active','unconscious','stable')" : "='active'"} AND team<>?
    ORDER BY combatant_id`).all(encounterId, current.team) as Array<{ combatant_id: string }>).map((row) => row.combatant_id);
  let attackSupported = ruleset.rulesetId !== "dnd-5e";
  let attackId = "attack:basic";
  let attackType: "melee" | "ranged" | "thrown" = "melee";
  let targetEvidence: RangedTargetEvidence[] | undefined;
  if (ruleset.rulesetId === "dnd-5e" && current.actor_id) {
    try {
      const equipment = resolveSrdEquipment(db, campaignId, current.actor_id);
      const weapon = equipment.weapon;
      // SRD 5.1: every creature is proficient with unarmed strikes and always
      // has one, so a missing equipped weapon no longer removes the attack.
      attackSupported = true;
      if (weapon?.properties.some((value) => value.property === "thrown")) {
        const thrown = buildThrownCombatCandidate(db, campaignId, encounterId, current.actor_id, targets);
        attackSupported = thrown !== null;
        if (thrown) { attackId = thrown.attackId; attackType = "thrown"; targetEvidence = thrown.targetEvidence; }
      } else if (weapon?.properties.some((value) => value.property === "ammunition")) {
        const ranged = buildRangedCombatCandidate(db, campaignId, encounterId, current.actor_id, targets);
        attackSupported = ranged !== null;
        if (ranged) { attackId = ranged.attackId; attackType = "ranged"; targetEvidence = ranged.targetEvidence; }
      }
      if (attackType === "melee") attackId = weapon
        ? `attack:basic:${createHash("sha256").update(JSON.stringify({ actorId: current.actor_id, revision: equipment.revision, weapon })).digest("hex").slice(0, 48)}`
        : "attack:unarmed";
    } catch { attackSupported = false; }
  }
  const attackTargets = !attackSupported ? [] : (current.combatant_kind === "enemy" ? targets.slice(0, 1) : targets)
    .filter((targetId) => mayAttackTarget(db, encounterId, current.combatant_id, targetId, economy?.round ?? 0));
  const grappleTargets = ruleset.rulesetId === "dnd-5e" && current.actor_id && economy?.action.available
    ? targets.filter((targetId) => mayAttackTarget(db, encounterId, current.combatant_id, targetId, economy.round)
      && ![...actionBlockingConditions].some(condition => conditionsFor(db, encounterId, targetId, economy.round).has(condition))) : [];
  const grappled = conditions.has("grappled");
  const utility = ruleset.rulesetId === "dnd-5e" && current.actor_id && economy?.action.available;
  const helpTargets = utility ? (db.prepare(`SELECT combatant_id FROM combatant WHERE encounter_id=? AND team=? AND combatant_kind='actor'
    AND status='active' AND combatant_id<>? ORDER BY combatant_id`).all(encounterId, current.team, current.combatant_id) as Array<{ combatant_id: string }>).map(row => row.combatant_id) : [];
  const stabilizeTargets = ruleset.rulesetId === "dnd-5e" && current.actor_id ? (db.prepare(`SELECT combatant_id FROM combatant WHERE encounter_id=?
    AND team=? AND combatant_kind='actor' AND status='unconscious' ORDER BY combatant_id`).all(encounterId, current.team) as Array<{combatant_id:string}>).map(row=>row.combatant_id) : [];
  return [
    ...(attackTargets.length > 0 && (economy === null || economy.action.available) ? [{ legalActionId: attackId, kind: "attack" as const,
      actingCombatantId: current.combatant_id, targetIds: attackTargets, cost: "action" as const, attackType,
      ...(targetEvidence ? { targetEvidence } : {}) }] : []),
    ...(stabilizeTargets.length && (economy === null || economy.action.available) ? [{ legalActionId: "stabilize", kind: "stabilize" as const,
      actingCombatantId: current.combatant_id, targetIds: stabilizeTargets, cost: "action" as const }] : []),
    ...grappleTargets.map((targetId) => ({ legalActionId: `grapple:${targetId}`, kind: "grapple" as const,
      actingCombatantId: current.combatant_id, targetIds: [targetId], cost: "action" as const })),
    ...(grappled && (economy === null || economy.action.available) ? [{ legalActionId: "escape-grapple", kind: "escape-grapple" as const,
      actingCombatantId: current.combatant_id, targetIds: [current.combatant_id], cost: "action" as const }] : []),
    ...(utility ? [{ legalActionId: "dash", kind: "dash" as const, actingCombatantId: current.combatant_id, targetIds: [], cost: "action" as const },
      { legalActionId: "disengage", kind: "disengage" as const, actingCombatantId: current.combatant_id, targetIds: [], cost: "action" as const },
      ...helpTargets.map(targetId => ({ legalActionId: `help:${targetId}`, kind: "help" as const, actingCombatantId: current.combatant_id, targetIds: [targetId], cost: "action" as const })),
      { legalActionId: "hide", kind: "hide" as const, actingCombatantId: current.combatant_id, targetIds: [], cost: "action" as const }] : []),
    { legalActionId: "flee", kind: "flee", actingCombatantId: current.combatant_id, targetIds: [], cost: null },
    { legalActionId: "end-turn", kind: "end-turn", actingCombatantId: current.combatant_id, targetIds: [], cost: null },
  ];
}
