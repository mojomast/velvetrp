import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { resourceIdSchema } from "@velvet/contracts";
import type { IdGenerator, RandomNumberGenerator } from "../../../runtime.js";
import { planDnd5eConcentrationEnd, planDnd5eConcentrationEnvironment } from "../../../rulesets/dnd5e/conditions.js";
import type { ConditionId } from "../../../rulesets/types.js";
import { conditionsFor } from "../combatConditionRuntime.js";

function activeConcentration(db: DatabaseDriver.Database, campaignId: string, actorId: string): { effect_id: string } | undefined {
  return db.prepare(`SELECT effect_id FROM rpg_active_effects_v26 WHERE campaign_id=? AND actor_id=?
    AND concentration_key='power-concentration' AND status='active'`).get(campaignId, actorId) as { effect_id: string } | undefined;
}

/**
 * Ends the exact active concentration effect for an actor and records a
 * fully-provenanced `remove_effect` lifecycle. Shared by condition, death,
 * dropped, and failed-save endings.
 */
export function endConcentration(
  db: DatabaseDriver.Database, ids: IdGenerator,
  input: Readonly<{ campaignId: string; actorId: string; at: string; reason: string;
    encounterId?: string; combatantId?: string; detail?: Readonly<Record<string, unknown>> }>,
): { effectId: string; reason: string } | null {
  const effect = activeConcentration(db, input.campaignId, input.actorId);
  if (!effect) return null;
  const before = (db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?")
    .get(input.campaignId, input.actorId) as { revision: number } | undefined)?.revision ?? 0;
  if (before === 0 && !db.prepare("SELECT 1 FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(input.campaignId, input.actorId))
    db.prepare("INSERT INTO rpg_m16_mutation_revisions_v26 VALUES(?,?,0,?)").run(input.campaignId, input.actorId, input.at);
  const after = before + 1, commandId = resourceIdSchema.parse(ids.nextId()), lifecycleId = resourceIdSchema.parse(ids.nextId());
  const request = JSON.stringify({ kind: `combat-concentration-${input.reason}`, effectId: effect.effect_id,
    ...(input.encounterId ? { encounterId: input.encounterId } : {}), ...(input.combatantId ? { combatantId: input.combatantId } : {}),
    ...(input.detail ?? {}) });
  const digest = createHash("sha256").update(request).digest("hex");
  db.prepare("INSERT INTO rpg_m16_commands_v26 VALUES(?,?,?,'effect','remove_effect',?,?,?,?,?,?)")
    .run(input.campaignId, input.actorId, commandId, `combat-concentration:${digest.slice(0, 40)}`, request, digest, before, after, input.at);
  db.prepare("INSERT INTO rpg_m16_receipts_v26 VALUES(?,?,?,?,?,?,?)").run(input.campaignId, input.actorId, commandId, after, request, digest, input.at);
  db.prepare("INSERT INTO rpg_effect_lifecycle_events_v26 VALUES(?,?,?,?,?,?,'removed',NULL,?)")
    .run(lifecycleId, effect.effect_id, input.campaignId, input.actorId, commandId, after, input.at);
  const changed = db.prepare(`UPDATE rpg_active_effects_v26 SET status='removed',state_revision=state_revision+1,
    last_lifecycle_event_id=?,updated_at=?,ended_at=? WHERE effect_id=? AND status='active'`).run(lifecycleId, input.at, input.at, effect.effect_id);
  if (changed.changes !== 1) throw new Error("concentration effect changed before ending");
  db.prepare("UPDATE rpg_m16_mutation_revisions_v26 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=? AND revision=?")
    .run(after, input.at, input.campaignId, input.actorId, before);
  return Object.freeze({ effectId: effect.effect_id, reason: input.reason });
}

/** Caster-controlled free action: deliberately drop concentration. */
export function dropConcentration(
  db: DatabaseDriver.Database, ids: IdGenerator,
  input: Readonly<{ campaignId: string; actorId: string; at: string; encounterId?: string; combatantId?: string }>,
): { effectId: string; reason: string } | null {
  return endConcentration(db, ids, { ...input, reason: "dropped" });
}

/** Ends concentration when the creature is incapacitated, dead, or at 0 hit points. */
export function endConcentrationOnCondition(
  db: DatabaseDriver.Database, ids: IdGenerator,
  input: Readonly<{ campaignId: string; actorId: string; encounterId: string; combatantId: string; round: number; at: string }>,
): { effectId: string; reason: string; condition?: string } | null {
  if (!activeConcentration(db, input.campaignId, input.actorId)) return null;
  const combatant = db.prepare("SELECT hit_points,status FROM combatant WHERE encounter_id=? AND combatant_id=?")
    .get(input.encounterId, input.combatantId) as { hit_points: number; status: string } | undefined;
  if (!combatant) return null;
  const plan = planDnd5eConcentrationEnd({ conditions: [...conditionsFor(db, input.encounterId, input.combatantId, input.round)] as ConditionId[],
    status: combatant.status, hitPoints: combatant.hit_points });
  if (!plan.ends) return null;
  const ended = endConcentration(db, ids, { campaignId: input.campaignId, actorId: input.actorId, encounterId: input.encounterId,
    combatantId: input.combatantId, at: input.at, reason: plan.reason! });
  return ended ? Object.freeze({ ...ended, ...(plan.condition ? { condition: plan.condition } : {}) }) : null;
}

/** Constitution save against an explicit environmental or spell DC. */
export function resolveConcentrationEnvironmentSave(
  db: DatabaseDriver.Database, ids: IdGenerator, rng: RandomNumberGenerator,
  input: Readonly<{ campaignId: string; actorId: string; at: string; dc: number; encounterId?: string; combatantId?: string }>,
): { dc: number; roll: number; total: number | null; maintained: boolean; broken: boolean; effectId: string | null } {
  const roll = rng.integer(1, 21);
  if (!Number.isInteger(roll) || roll < 1 || roll > 20) throw new Error("combat RNG returned an out-of-range concentration d20");
  const constitution = (db.prepare(`SELECT attributes.value FROM campaign_actors actor
    JOIN rpg_character_attributes attributes ON attributes.campaign_id=actor.campaign_id AND attributes.sheet_id=actor.sheet_id
    WHERE actor.campaign_id=? AND actor.id=? AND attributes.attribute_id='constitution'`).get(input.campaignId, input.actorId) as { value: number } | undefined)?.value;
  const check = planDnd5eConcentrationEnvironment(input.dc, true, { rolls: [roll], constitutionScore: constitution ?? 10 });
  const ended = check.broken
    ? endConcentration(db, ids, { campaignId: input.campaignId, actorId: input.actorId, at: input.at, reason: "save-failed",
      ...(input.encounterId ? { encounterId: input.encounterId } : {}), ...(input.combatantId ? { combatantId: input.combatantId } : {}),
      detail: { dc: input.dc, roll, total: check.check?.total ?? null } })
    : null;
  return Object.freeze({ dc: input.dc, roll, total: check.check?.total ?? null, maintained: !check.broken, broken: check.broken,
    effectId: ended?.effectId ?? null });
}
