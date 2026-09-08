import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { resolveSrdEquipment } from "../srdEquipmentRuntime.js";
import { resolveCampaignRuleset } from "../../rulesets/campaignBinding.js";
import { EncounterConflictError } from "./encounterErrors.js";
import { actionBlockingConditions, conditionsFor, mayAttackTarget } from "./combatConditionRuntime.js";

export type CombatActionPlan = {
  legalActionId: string;
  kind: "attack" | "flee" | "end-turn" | "stabilize" | "death-save";
  actingCombatantId: string;
  targetIds: string[];
  cost: "action" | null;
};

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
  if (ruleset.rulesetId === "dnd-5e" && current.actor_id) {
    try {
      const equipment = resolveSrdEquipment(db, campaignId, current.actor_id);
      attackSupported = equipment.weapon !== null;
      attackId = `attack:basic:${createHash("sha256").update(JSON.stringify({ actorId: current.actor_id,
        revision: equipment.revision, weapon: equipment.weapon })).digest("hex").slice(0, 48)}`;
    } catch { attackSupported = false; }
  }
  const attackTargets = !attackSupported ? [] : (current.combatant_kind === "enemy" ? targets.slice(0, 1) : targets)
    .filter((targetId) => mayAttackTarget(db, encounterId, current.combatant_id, targetId, economy?.round ?? 0));
  const stabilizeTargets = ruleset.rulesetId === "dnd-5e" && current.actor_id ? (db.prepare(`SELECT combatant_id FROM combatant WHERE encounter_id=?
    AND team=? AND combatant_kind='actor' AND status='unconscious' ORDER BY combatant_id`).all(encounterId, current.team) as Array<{combatant_id:string}>).map(row=>row.combatant_id) : [];
  return [
    ...(attackTargets.length > 0 && (economy === null || economy.action.available) ? [{ legalActionId: attackId, kind: "attack" as const,
      actingCombatantId: current.combatant_id, targetIds: attackTargets, cost: "action" as const }] : []),
    ...(stabilizeTargets.length && (economy === null || economy.action.available) ? [{ legalActionId: "stabilize", kind: "stabilize" as const,
      actingCombatantId: current.combatant_id, targetIds: stabilizeTargets, cost: "action" as const }] : []),
    { legalActionId: "flee", kind: "flee", actingCombatantId: current.combatant_id, targetIds: [], cost: null },
    { legalActionId: "end-turn", kind: "end-turn", actingCombatantId: current.combatant_id, targetIds: [], cost: null },
  ];
}
