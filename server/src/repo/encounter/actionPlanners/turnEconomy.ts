import type DatabaseDriver from "better-sqlite3";
import { deriveDnd5eExhaustionEffects, planDnd5eEncumbrance } from "../../../rulesets/index.js";
import { resolveSrdEquipment, srdEncumbrance } from "../../srdEquipmentRuntime.js";
import { resolveCampaignRuleset } from "../../../rulesets/campaignBinding.js";
import { EncounterConflictError } from "../encounterErrors.js";
import { conditionsFor, readActorExhaustion } from "../combatConditionRuntime.js";
import { clearHelpedFromSource } from "../combatMarkerRuntime.js";
import type { PersistedCombatTurnEconomy } from "./types.js";

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
    let allowance = base;
    if (row?.actor_id) {
      try {
        const load = srdEncumbrance(resolveSrdEquipment(db, campaignId, row.actor_id));
        allowance = Math.max(0, base - planDnd5eEncumbrance({ carriedWeight: load.carriedWeight, strengthScore: load.strengthScore }).speedReduction);
        allowance = Math.floor(allowance * deriveDnd5eExhaustionEffects(readActorExhaustion(db, campaignId, row.actor_id)).speedMultiplier);
      } catch { /* keep the persisted derived speed when the equipment snapshot is unavailable */ }
    }
    const encounter = db.prepare("SELECT encounter_id,round_number FROM encounter WHERE current_turn_combatant_id=? AND campaign_id=? AND status='active'")
      .get(combatantId, campaignId) as { encounter_id: string; round_number: number } | undefined;
    return encounter && (["grappled", "restrained", "stunned", "unconscious"].some((condition) =>
      conditionsFor(db, encounter.encounter_id, combatantId, encounter.round_number).has(condition))) ? 0 : allowance;
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
  // Help lasts until the start of the helper's next turn.
  clearHelpedFromSource(db, encounterId, combatantId);
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
