import type DatabaseDriver from "better-sqlite3";
import { dnd5eProficiencyBonus } from "../../rulesets/index.js";

export type CombatMarker = "helped" | "hidden";

/** Upserts one combat marker tied to the resolving command. */
export function grantCombatMarker(db: DatabaseDriver.Database, encounterId: string, combatantId: string, marker: CombatMarker,
  sourceCombatantId: string, commandId: string, round: number, at: string,
): void {
  db.prepare(`INSERT INTO combat_markers_v64(encounter_id,combatant_id,marker,source_combatant_id,command_id,round_number,created_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(encounter_id,combatant_id,marker) DO UPDATE SET
      source_combatant_id=excluded.source_combatant_id,command_id=excluded.command_id,round_number=excluded.round_number,created_at=excluded.created_at`)
    .run(encounterId, combatantId, marker, sourceCombatantId, commandId, round, at);
}

export function hasCombatMarker(db: DatabaseDriver.Database, encounterId: string, combatantId: string, marker: CombatMarker): boolean {
  return Boolean(db.prepare("SELECT 1 FROM combat_markers_v64 WHERE encounter_id=? AND combatant_id=? AND marker=?").get(encounterId, combatantId, marker));
}

export function consumeCombatMarker(db: DatabaseDriver.Database, encounterId: string, combatantId: string, marker: CombatMarker): void {
  db.prepare("DELETE FROM combat_markers_v64 WHERE encounter_id=? AND combatant_id=? AND marker=?").run(encounterId, combatantId, marker);
}

/** Help expires at the start of the helper's next turn. */
export function clearHelpedFromSource(db: DatabaseDriver.Database, encounterId: string, sourceCombatantId: string): void {
  db.prepare("DELETE FROM combat_markers_v64 WHERE encounter_id=? AND marker='helped' AND source_combatant_id=?").run(encounterId, sourceCombatantId);
}

function abilityModifier(db: DatabaseDriver.Database, campaignId: string, actorId: string, ability: string): number | null {
  const value = (db.prepare(`SELECT attributes.value FROM campaign_actors actor
    JOIN rpg_character_attributes attributes ON attributes.campaign_id=actor.campaign_id AND attributes.sheet_id=actor.sheet_id
    WHERE actor.campaign_id=? AND actor.id=? AND attributes.attribute_id=?`).get(campaignId, actorId, ability) as { value: number } | undefined)?.value;
  return Number.isInteger(value) ? Math.floor(((value as number) - 10) / 2) : null;
}

function proficientSkill(db: DatabaseDriver.Database, campaignId: string, sheetId: string, skill: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM rpg_character_proficiencies WHERE campaign_id=? AND sheet_id=? AND category='skill' AND proficiency_id=?")
    .get(campaignId, sheetId, skill));
}

function actorLevelBonus(db: DatabaseDriver.Database, campaignId: string, actorId: string): number {
  const level = (db.prepare(`SELECT progression.level FROM campaign_actors actor
    JOIN character_progression_v23 progression ON progression.campaign_id=actor.campaign_id AND progression.actor_id=actor.id
    WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId, actorId) as { level: number } | undefined)?.level;
  return dnd5eProficiencyBonus(Number.isInteger(level) ? (level as number) : 1);
}

/** Dexterity (Stealth) modifier, including proficiency. */
export function actorStealthModifier(db: DatabaseDriver.Database, campaignId: string, actorId: string): number | null {
  const dexterity = abilityModifier(db, campaignId, actorId, "dexterity");
  if (dexterity === null) return null;
  const sheetId = (db.prepare("SELECT sheet_id FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaignId, actorId) as { sheet_id: string } | undefined)?.sheet_id;
  const proficiency = sheetId && proficientSkill(db, campaignId, sheetId, "stealth") ? actorLevelBonus(db, campaignId, actorId) : 0;
  return dexterity + proficiency;
}

/** Highest passive Perception among the opposing active actor combatants (10 when none). */
export function opposingPassivePerception(db: DatabaseDriver.Database, campaignId: string, encounterId: string, team: string): number {
  const rows = db.prepare(`SELECT actor.id actor_id,actor.sheet_id FROM combatant
    JOIN campaign_actors actor ON actor.id=combatant.actor_id
    WHERE combatant.encounter_id=? AND combatant.team<>? AND combatant.status='active'`).all(encounterId, team) as Array<{ actor_id: string; sheet_id: string }>;
  let best = 0;
  for (const row of rows) {
    const wisdom = abilityModifier(db, campaignId, row.actor_id, "wisdom");
    if (wisdom === null) continue;
    const proficiency = proficientSkill(db, campaignId, row.sheet_id, "perception") ? actorLevelBonus(db, campaignId, row.actor_id) : 0;
    best = Math.max(best, 10 + wisdom + proficiency);
  }
  return best || 10;
}
