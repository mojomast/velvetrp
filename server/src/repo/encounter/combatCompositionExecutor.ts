import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import type { CombatCompositionPlan } from "./combatCompositionPlan.js";
import { EncounterConflictError } from "./encounterErrors.js";

export type CombatCompositionBoundary = "preflight" | "health" | "effects" | "combatant";
const requireOne=(result:{changes:number},message:string):void=>{if(result.changes!==1)throw new EncounterConflictError(message);};

/** Executes a sealed plan on the caller's connection and transaction only. */
export function executeCombatCompositionPlan(
  db: DatabaseDriver.Database,
  plan: CombatCompositionPlan,
  failpoint?: (boundary: CombatCompositionBoundary) => void,
): void {
  if (!db.inTransaction) throw new Error("combat composition requires a caller-owned transaction");
  const encounter = db.prepare(`SELECT encounter.status,encounter.round_number,encounter.current_turn_combatant_id,
    encounter.state_revision,root.revision combat_revision FROM encounter
    JOIN combat_mutation_revisions_v27 root ON root.encounter_id=encounter.encounter_id
    WHERE encounter.encounter_id=? AND encounter.campaign_id=?`).get(plan.encounterId, plan.campaignId) as
    { status: string; round_number: number; current_turn_combatant_id: string | null;
      state_revision: number; combat_revision: number } | undefined;
  if (!encounter || encounter.status !== plan.encounterState.status || encounter.status !== "active"
      || encounter.round_number !== plan.encounterState.round
      || encounter.current_turn_combatant_id !== plan.encounterState.currentCombatantId
      || encounter.state_revision !== plan.encounterState.stateRevision
      || encounter.combat_revision !== plan.encounterState.combatRevision) {
    throw new EncounterConflictError("sealed encounter state changed before execution");
  }
  for (const change of plan.combatantChanges) {
    const row = db.prepare(`SELECT hit_points,status,state_revision FROM combatant
      WHERE encounter_id=? AND campaign_id=? AND combatant_id=?`).get(plan.encounterId, plan.campaignId,
        change.combatantId) as { hit_points: number; status: string; state_revision: number } | undefined;
    if (!row || row.hit_points !== change.hitPointsBefore || row.status !== change.statusBefore
        || row.state_revision !== change.stateRevisionBefore) {
      throw new EncounterConflictError("sealed combatant state changed before execution");
    }
  }
  failpoint?.("preflight");

  for (const mirror of plan.healthMirrors) {
    const root = db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?")
      .get(plan.campaignId, mirror.actorId) as { revision: number } | undefined;
    if ((root?.revision ?? 0) !== mirror.revisionBefore) throw new EncounterConflictError("actor resource state changed before commit");
    if (!root) requireOne(db.prepare("INSERT INTO rpg_m15_mutation_revisions_v25(campaign_id,actor_id,revision,updated_at) VALUES(?,?,0,?)")
      .run(plan.campaignId, mirror.actorId, plan.occurredAt),"actor resource revision root was not created");
    const health = db.prepare(`UPDATE rpg_actor_resources SET current=? WHERE campaign_id=? AND actor_id=?
      AND name='health' AND current=?`).run(mirror.currentAfter, plan.campaignId, mirror.actorId, mirror.currentBefore);
    if (health.changes !== 1) throw new EncounterConflictError("actor health changed before commit");
    const revision = db.prepare(`UPDATE rpg_m15_mutation_revisions_v25 SET revision=?,updated_at=?
      WHERE campaign_id=? AND actor_id=? AND revision=?`).run(mirror.revisionAfter, plan.occurredAt,
        plan.campaignId, mirror.actorId, mirror.revisionBefore);
    if (revision.changes !== 1) throw new EncounterConflictError("actor resource revision changed before commit");
    requireOne(db.prepare(`INSERT INTO rpg_m15_commands_v25(command_id,campaign_id,actor_id,command_family,command_type,
      idempotency_key,canonical_request_json,request_digest,expected_revision,resulting_revision,created_at)
      VALUES(?,?,?,'resource','encounter_health_mirror',?,?,?,?,?,?)`).run(mirror.commandId, plan.campaignId,
        mirror.actorId, mirror.idempotencyKey, mirror.requestJson, mirror.requestDigest, mirror.revisionBefore,
         mirror.revisionAfter, plan.occurredAt),"health mirror command was not created");
    const keys = '["resource:health"]', keysDigest = createHash("sha256").update(keys).digest("hex");
    requireOne(db.prepare("INSERT INTO rpg_m15_receipts_v25 VALUES(?,?,?,?,?,?,?,?,?)").run(plan.campaignId, mirror.actorId,
      mirror.commandId, mirror.revisionAfter, mirror.resultJson, mirror.resultDigest, keys, keysDigest,
      plan.occurredAt),"health mirror receipt was not created");
    requireOne(db.prepare("INSERT INTO rpg_m15_receipt_changed_keys_v25 VALUES(?,?,?,?,?)").run(plan.campaignId,
      mirror.actorId, mirror.commandId, "resource:health", mirror.revisionAfter),"health mirror changed key was not created");
  }
  failpoint?.("health");

  for (const advance of plan.effectAdvances) {
    const root = db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?")
      .get(plan.campaignId, advance.actorId) as { revision: number } | undefined;
    if ((root?.revision ?? 0) !== advance.revisionBefore) throw new EncounterConflictError("actor effect state changed before commit");
    if (!root) requireOne(db.prepare("INSERT INTO rpg_m16_mutation_revisions_v26 VALUES(?,?,0,?)")
      .run(plan.campaignId, advance.actorId, plan.occurredAt),"effect revision root was not created");
    requireOne(db.prepare("INSERT INTO rpg_m16_commands_v26 VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(plan.campaignId, advance.actorId, advance.commandId, "effect", "advance_effect_duration",
        advance.idempotencyKey, advance.requestJson, advance.requestDigest, advance.revisionBefore,
        advance.revisionAfter, plan.occurredAt),"effect command was not created");
    requireOne(db.prepare("INSERT INTO rpg_m16_receipts_v26 VALUES(?,?,?,?,?,?,?)")
      .run(plan.campaignId, advance.actorId, advance.commandId, advance.revisionAfter,
        advance.resultJson, advance.resultDigest, plan.occurredAt),"effect receipt was not created");
    for (const effect of advance.effects) {
      requireOne(db.prepare(`INSERT INTO rpg_effect_lifecycle_events_v26
        (lifecycle_event_id,effect_id,campaign_id,actor_id,command_id,resulting_revision,lifecycle_kind,remaining_rounds,occurred_at)
        VALUES(?,?,?,?,?,?,'duration_advanced',?,?)`).run(effect.lifecycleEventId, effect.effectId,
          plan.campaignId, advance.actorId, advance.commandId, advance.revisionAfter, effect.remainingAfter,
          plan.occurredAt),"effect lifecycle event was not created");
      const update = db.prepare(`UPDATE rpg_active_effects_v26 SET remaining_rounds=?,state_revision=state_revision+1,
        last_lifecycle_event_id=?,updated_at=?,status=CASE WHEN ?=0 THEN 'expired' ELSE status END,
        ended_at=CASE WHEN ?=0 THEN ? ELSE ended_at END
        WHERE effect_id=? AND campaign_id=? AND actor_id=? AND status='active' AND duration_kind='rounds'
          AND remaining_rounds=? AND state_revision=?`).run(effect.remainingAfter, effect.lifecycleEventId,
          plan.occurredAt, effect.remainingAfter, effect.remainingAfter, plan.occurredAt, effect.effectId,
          plan.campaignId, advance.actorId, effect.remainingBefore, effect.stateRevisionBefore);
      if (update.changes !== 1) throw new EncounterConflictError("round effect changed before commit");
    }
    requireOne(db.prepare("INSERT INTO rpg_m16_events_v26 VALUES(?,?,?,?,?,?,?,?)")
      .run(advance.eventId, plan.campaignId, advance.actorId, advance.commandId, advance.revisionAfter,
        "effect_duration_advanced", advance.resultJson, plan.occurredAt),"effect event was not created");
    const revision = db.prepare(`UPDATE rpg_m16_mutation_revisions_v26 SET revision=?,updated_at=?
      WHERE campaign_id=? AND actor_id=? AND revision=?`).run(advance.revisionAfter, plan.occurredAt,
        plan.campaignId, advance.actorId, advance.revisionBefore);
    if (revision.changes !== 1) throw new EncounterConflictError("actor effect revision changed before commit");
  }
  failpoint?.("effects");
  failpoint?.("combatant");
  for (const change of plan.combatantChanges) {
    const update = db.prepare(`UPDATE combatant SET hit_points=?,status=?,state_revision=state_revision+1,updated_at=?
      WHERE encounter_id=? AND campaign_id=? AND combatant_id=? AND hit_points=? AND status=? AND state_revision=?`)
      .run(change.hitPointsAfter, change.statusAfter, plan.occurredAt, plan.encounterId, plan.campaignId,
        change.combatantId, change.hitPointsBefore, change.statusBefore, change.stateRevisionBefore);
    if (update.changes !== 1) throw new EncounterConflictError("combatant state changed before commit");
  }
}
