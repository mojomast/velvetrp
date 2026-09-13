import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { resourceIdSchema } from "@velvet/contracts";
import type { IdGenerator, RandomNumberGenerator } from "../../runtime.js";

export const actionBlockingConditions = new Set(["incapacitated", "paralyzed", "petrified", "stunned", "unconscious"]);
/** Paralyzed, petrified, stunned, and unconscious creatures cannot move; grappled and restrained creatures have speed 0. */
export const movementDenialConditions = new Set(["grappled", "paralyzed", "petrified", "restrained", "stunned", "unconscious"]);
export const attackDisadvantageConditions = new Set(["blinded", "frightened", "poisoned", "prone", "restrained"]);
export const saveAutoFailConditions = new Set(["paralyzed", "petrified"]);
const conditionNames = new Set(["blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious"]);
/** The SRD 5.1 condition vocabulary persisted in combat_conditions_v62. */
export const combatConditionNames: ReadonlySet<string> = conditionNames;

/** This internal-only primitive requires the already-created encounter command that caused the condition. */
export function applyCombatCondition(
  db: DatabaseDriver.Database, encounterId: string, combatantId: string, condition: string, sourceCombatantId: string,
  sourceCommandId: string, expiresAtRound: number | null, at: string,
): void {
  if (!conditionNames.has(condition) || (expiresAtRound !== null && (!Number.isInteger(expiresAtRound) || expiresAtRound < 1)))
    throw new Error("combat condition is invalid");
  if (!db.prepare("SELECT 1 FROM combat_commands_v27 WHERE encounter_id=? AND command_id=?").get(encounterId, sourceCommandId))
    throw new Error("combat condition source command is unavailable");
  // The column CHECK rejects SQL NULL, so a no-expiry condition uses the
  // bounded persist sentinel; the reader treats any round at or below it as active.
  const expiry = expiresAtRound ?? 1_000_000;
  db.prepare(`INSERT INTO combat_conditions_v62(encounter_id,combatant_id,condition,source_combatant_id,source_command_id,expires_at_round,applied_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(encounter_id,combatant_id,condition,source_combatant_id) DO UPDATE SET
      source_command_id=excluded.source_command_id,expires_at_round=excluded.expires_at_round,applied_at=excluded.applied_at`)
    .run(encounterId, combatantId, condition, sourceCombatantId, sourceCommandId, expiry, at);
}

export function removeCombatCondition(
  db: DatabaseDriver.Database, encounterId: string, combatantId: string, condition: string,
): void {
  db.prepare("DELETE FROM combat_conditions_v62 WHERE encounter_id=? AND combatant_id=? AND condition=?")
    .run(encounterId, combatantId, condition);
}

/** Reads the clamped persisted exhaustion level for one actor (0 when absent). */
export function readActorExhaustion(db: DatabaseDriver.Database, campaignId: string, actorId: string): number {
  const value = (db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='exhaustion'")
    .get(campaignId, actorId) as { current: number } | undefined)?.current;
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6 ? value as number : 0;
}

/** Reads only non-expired closed combat conditions. Source identity remains private. */
export function conditionsFor(db: DatabaseDriver.Database, encounterId: string, combatantId: string, round: number): Set<string> {
  return new Set((db.prepare(`SELECT DISTINCT condition FROM combat_conditions_v62
    WHERE encounter_id=? AND combatant_id=? AND (expires_at_round IS NULL OR expires_at_round>=?)`)
    .all(encounterId, combatantId, round) as Array<{ condition: string }>).map((row) => row.condition));
}

export function mayAttackTarget(
  db: DatabaseDriver.Database, encounterId: string, attackerId: string, targetId: string, round: number,
): boolean {
  const charmed = db.prepare(`SELECT 1 FROM combat_conditions_v62 WHERE encounter_id=? AND combatant_id=?
    AND condition='charmed' AND source_combatant_id=? AND (expires_at_round IS NULL OR expires_at_round>=?)`)
    .get(encounterId, attackerId, targetId, round);
  return !charmed;
}

/** Temporary HP never stacks: a replacement keeps the larger current pool. */
export function grantTemporaryHitPoints(
  db: DatabaseDriver.Database, encounterId: string, combatantId: string, amount: number, sourceCommandId: string, at: string,
): number {
  if (!Number.isInteger(amount) || amount < 0 || amount > 1_000_000) throw new Error("temporary hit points are invalid");
  const current = (db.prepare("SELECT hit_points FROM combat_temporary_hit_points_v62 WHERE encounter_id=? AND combatant_id=?")
    .get(encounterId, combatantId) as { hit_points: number } | undefined)?.hit_points ?? 0;
  const next = Math.max(current, amount);
  if (current === 0) db.prepare("INSERT INTO combat_temporary_hit_points_v62 VALUES(?,?,?,?,?)")
    .run(encounterId, combatantId, next, sourceCommandId, at);
  else if (next !== current) db.prepare(`UPDATE combat_temporary_hit_points_v62 SET hit_points=?,source_command_id=?,updated_at=?
    WHERE encounter_id=? AND combatant_id=?`).run(next, sourceCommandId, at, encounterId, combatantId);
  return next;
}

export function absorbDamage(db: DatabaseDriver.Database, encounterId: string, combatantId: string, damage: number, at: string): {
  hitPointDamage: number; temporaryHitPointsBefore: number; temporaryHitPointsAfter: number;
} {
  if (!Number.isInteger(damage) || damage < 0) throw new Error("damage is invalid");
  const temporaryHitPointsBefore = (db.prepare("SELECT hit_points FROM combat_temporary_hit_points_v62 WHERE encounter_id=? AND combatant_id=?")
    .get(encounterId, combatantId) as { hit_points: number } | undefined)?.hit_points ?? 0;
  const temporaryHitPointsAfter = Math.max(0, temporaryHitPointsBefore - damage);
  if (temporaryHitPointsBefore > 0) db.prepare("UPDATE combat_temporary_hit_points_v62 SET hit_points=?,updated_at=? WHERE encounter_id=? AND combatant_id=?")
    .run(temporaryHitPointsAfter, at, encounterId, combatantId);
  return { hitPointDamage: Math.max(0, damage - temporaryHitPointsBefore), temporaryHitPointsBefore, temporaryHitPointsAfter };
}

/** Sums active flat defense modifiers (Shield and similar) for an actor-backed combatant. */
export function resolveCombatArmorClassBonus(
  db: DatabaseDriver.Database, campaignId: string, actorId: string, at: string,
): number {
  const row = db.prepare(`SELECT COALESCE(SUM(modifier.amount),0) bonus
    FROM rpg_active_effects_v26 effect JOIN rpg_effect_modifiers_v26 modifier USING(effect_id)
    WHERE effect.campaign_id=? AND effect.actor_id=? AND effect.status='active'
      AND (effect.duration_kind<>'rounds' OR effect.remaining_rounds>0)
      AND (effect.duration_kind<>'until_timestamp' OR effect.expires_at>?)
      AND modifier.modifier_kind='flat' AND modifier.applies_to_id IN ('defense','all')`)
    .get(campaignId, actorId, at) as { bonus: number } | undefined;
  return Number.isInteger(row?.bonus) ? row!.bonus : 0;
}

/** Ends only the exact, active concentration effect after a server-owned Constitution save. */
export function interruptConcentrationAfterDamage(
  db: DatabaseDriver.Database, ids: IdGenerator, rng: RandomNumberGenerator, campaignId: string, encounterId: string,
  combatantId: string, damage: number, statusAfter: string, at: string,
): { dc: number; roll: number; total: number; maintained: boolean } | null {
  const actor = db.prepare("SELECT actor_id FROM combatant WHERE encounter_id=? AND combatant_id=?").get(encounterId, combatantId) as { actor_id: string | null } | undefined;
  if (!actor?.actor_id) return null;
  const effect = db.prepare(`SELECT effect_id FROM rpg_active_effects_v26 WHERE campaign_id=? AND actor_id=?
    AND concentration_key='power-concentration' AND status='active'`).get(campaignId, actor.actor_id) as { effect_id: string } | undefined;
  if (!effect) return null;
  const forced = ["unconscious", "dead", "defeated"].includes(statusAfter);
  if (damage <= 0 && !forced) return null;
  const constitution = db.prepare(`SELECT attributes.value FROM campaign_actors actor
    JOIN rpg_character_attributes attributes ON attributes.campaign_id=actor.campaign_id AND attributes.sheet_id=actor.sheet_id
    WHERE actor.campaign_id=? AND actor.id=? AND attributes.attribute_id='constitution'`).get(campaignId, actor.actor_id) as { value: number } | undefined;
  const roll = damage > 0 ? rng.integer(1, 21) : 20;
  if (!Number.isInteger(roll) || roll < 1 || roll > 20) throw new Error("combat RNG returned an out-of-range concentration d20");
  const total = roll + Math.floor(((constitution?.value ?? 10) - 10) / 2), dc = Math.max(10, Math.floor(damage / 2));
  const maintained = !forced && total >= dc;
  if (maintained) return { dc, roll, total, maintained };
  const before = (db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?")
    .get(campaignId, actor.actor_id) as { revision: number } | undefined)?.revision ?? 0;
  if (before === 0 && !db.prepare("SELECT 1 FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(campaignId, actor.actor_id))
    db.prepare("INSERT INTO rpg_m16_mutation_revisions_v26 VALUES(?,?,0,?)").run(campaignId, actor.actor_id, at);
  const after = before + 1, commandId = resourceIdSchema.parse(ids.nextId()), lifecycleId = resourceIdSchema.parse(ids.nextId());
  const request = JSON.stringify({ kind: "combat-concentration-interrupt", encounterId, combatantId, effectId: effect.effect_id, damage, forced });
  const digest = createHash("sha256").update(request).digest("hex");
  db.prepare("INSERT INTO rpg_m16_commands_v26 VALUES(?,?,?,'effect','remove_effect',?,?,?,?,?,?)")
    .run(campaignId, actor.actor_id, commandId, `combat-concentration:${digest.slice(0, 40)}`, request, digest, before, after, at);
  db.prepare("INSERT INTO rpg_m16_receipts_v26 VALUES(?,?,?,?,?,?,?)").run(campaignId, actor.actor_id, commandId, after, request, digest, at);
  db.prepare("INSERT INTO rpg_effect_lifecycle_events_v26 VALUES(?,?,?,?,?,?,'removed',NULL,?)")
    .run(lifecycleId, effect.effect_id, campaignId, actor.actor_id, commandId, after, at);
  const changed = db.prepare(`UPDATE rpg_active_effects_v26 SET status='removed',state_revision=state_revision+1,
    last_lifecycle_event_id=?,updated_at=?,ended_at=? WHERE effect_id=? AND status='active'`).run(lifecycleId, at, at, effect.effect_id);
  if (changed.changes !== 1) throw new Error("concentration effect changed before interruption");
  db.prepare("UPDATE rpg_m16_mutation_revisions_v26 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=? AND revision=?")
    .run(after, at, campaignId, actor.actor_id, before);
  return { dc, roll, total, maintained: false };
}
