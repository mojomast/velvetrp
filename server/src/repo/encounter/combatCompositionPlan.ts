import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema } from "@velvet/contracts";
import type { IdGenerator } from "../../runtime.js";
import { readActiveEffects } from "../effectRepo.js";
import { EncounterConflictError } from "./encounterErrors.js";

export type CombatantStateChange = Readonly<{
  combatantId: string;
  hitPointsBefore: number;
  hitPointsAfter: number;
  statusBefore: string;
  statusAfter: string;
  stateRevisionBefore: number;
}>;

type HealthMirror = Readonly<{
  actorId: string;
  combatantId: string;
  currentBefore: number;
  currentAfter: number;
  revisionBefore: number;
  revisionAfter: number;
  commandId: string;
  idempotencyKey: string;
  requestJson: string;
  requestDigest: string;
  resultJson: string;
  resultDigest: string;
}>;

export type CombatCompositionPlan = Readonly<{
  encounterId: string;
  campaignId: string;
  occurredAt: string;
  encounterState: Readonly<{
    status: string;
    round: number;
    currentCombatantId: string | null;
    stateRevision: number;
    combatRevision: number;
  }>;
  combatantChanges: readonly CombatantStateChange[];
  healthMirrors: readonly HealthMirror[];
  effectAdvances: readonly Readonly<{
    actorId: string;
    commandId: string;
    eventId: string;
    idempotencyKey: string;
    revisionBefore: number;
    revisionAfter: number;
    requestJson: string;
    requestDigest: string;
    resultJson: string;
    resultDigest: string;
    effects: readonly Readonly<{
      effectId: string;
      lifecycleEventId: string;
      remainingBefore: number;
      remainingAfter: number;
      stateRevisionBefore: number;
    }>[];
  }>[];
}>;

type PlanInput = Readonly<{
  encounterId: string;
  campaignId: string;
  roundBefore: number;
  roundAfter: number;
  occurredAt: string;
  combatantChanges: readonly CombatantStateChange[];
  /** Actor health is composed by another aggregate command in the same transaction. */
  externallyMirroredActorIds?: readonly string[];
}>;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested) =>
  nested && typeof nested === "object" && !Array.isArray(nested)
    ? Object.fromEntries(Object.keys(nested).sort().map((key) => [key, nested[key]]))
    : nested);
const digest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const nextId = (ids: IdGenerator): string => resourceIdSchema.parse(ids.nextId());

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

/** Builds a sealed cross-domain plan inside the encounter command transaction. */
export function buildCombatCompositionPlan(
  db: DatabaseDriver.Database,
  ids: IdGenerator,
  input: PlanInput,
): CombatCompositionPlan {
  if (!db.inTransaction) throw new Error("combat composition planning requires a caller-owned transaction");
  const encounter = db.prepare(`SELECT encounter.campaign_id,encounter.status,encounter.round_number,
    encounter.current_turn_combatant_id,encounter.state_revision,root.revision combat_revision
    FROM encounter JOIN combat_mutation_revisions_v27 root ON root.encounter_id=encounter.encounter_id
    WHERE encounter.encounter_id=?`).get(input.encounterId) as { campaign_id: string; status: string;
      round_number: number; current_turn_combatant_id: string | null; state_revision: number; combat_revision: number } | undefined;
  if (!encounter || encounter.campaign_id !== input.campaignId || encounter.status !== "active"
      || encounter.round_number !== input.roundBefore) {
    throw new EncounterConflictError("active encounter composition is unavailable");
  }
  if (input.roundAfter < input.roundBefore || input.roundAfter > input.roundBefore + 1) {
    throw new EncounterConflictError("combat round transition is invalid");
  }

  const seen = new Set<string>();
  const healthMirrors: HealthMirror[] = [];
  for (const change of input.combatantChanges) {
    if (seen.has(change.combatantId)) throw new EncounterConflictError("combatant state was planned more than once");
    seen.add(change.combatantId);
    const row = db.prepare(`SELECT actor_id,hit_points,status,state_revision FROM combatant
      WHERE encounter_id=? AND campaign_id=? AND combatant_id=?`).get(input.encounterId, input.campaignId,
        change.combatantId) as { actor_id: string | null; hit_points: number; status: string; state_revision: number } | undefined;
    if (!row || row.hit_points !== change.hitPointsBefore || row.status !== change.statusBefore
        || row.state_revision !== change.stateRevisionBefore) {
      throw new EncounterConflictError("combatant state changed before composition planning");
    }
    if (change.hitPointsAfter < 0) throw new EncounterConflictError("combatant hit points are invalid");
    if (row.actor_id === null || change.hitPointsAfter === change.hitPointsBefore) continue;
    const health = db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
      .get(input.campaignId, row.actor_id) as { current: number } | undefined;
    if (!health || health.current !== change.hitPointsBefore) {
      throw new EncounterConflictError("actor health is not synchronized with active combat");
    }
    if (input.externallyMirroredActorIds?.includes(row.actor_id)) continue;
    const revisionBefore = (db.prepare(`SELECT revision FROM rpg_m15_mutation_revisions_v25
      WHERE campaign_id=? AND actor_id=?`).get(input.campaignId, row.actor_id) as { revision: number } | undefined)?.revision ?? 0;
    const revisionAfter = revisionBefore + 1, commandId = nextId(ids);
    const request = { type: "encounter_health_mirror", encounterId: input.encounterId, combatantId: change.combatantId,
      hitPointsBefore: change.hitPointsBefore, hitPointsAfter: change.hitPointsAfter,
      combatantStateRevisionBefore: change.stateRevisionBefore };
    const idempotencyKey = `combat-health:${digest(request).slice(0, 62)}`;
    const receipt = { commandId, idempotencyKey, revisionBefore, revisionAfter, occurredAt: input.occurredAt,
      changedKeys: ["resource:health"] };
    const result = { resources: [{ resourceId: "health", current: change.hitPointsAfter }], receipt };
    const requestJson = canonical(request), resultJson = canonical(result);
    healthMirrors.push({ actorId: row.actor_id, combatantId: change.combatantId, currentBefore: health.current,
      currentAfter: change.hitPointsAfter, revisionBefore, revisionAfter, commandId, idempotencyKey,
      requestJson, requestDigest: digest(requestJson), resultJson, resultDigest: digest(resultJson) });
  }

  const effectAdvances: Array<CombatCompositionPlan["effectAdvances"][number]> = [];
  if (input.roundAfter === input.roundBefore + 1) {
    const rows = db.prepare(`SELECT effect.actor_id,effect.effect_id,effect.remaining_rounds,effect.state_revision
      FROM rpg_active_effects_v26 effect
      JOIN combatant ON combatant.campaign_id=effect.campaign_id AND combatant.actor_id=effect.actor_id
      WHERE combatant.encounter_id=? AND effect.campaign_id=? AND effect.status='active'
        AND effect.duration_kind='rounds' AND effect.remaining_rounds>0
      ORDER BY effect.actor_id,effect.effect_id`).all(input.encounterId, input.campaignId) as
      Array<{ actor_id: string; effect_id: string; remaining_rounds: number; state_revision: number }>;
    const byActor = new Map<string, typeof rows>();
    for (const row of rows) byActor.set(row.actor_id, [...(byActor.get(row.actor_id) ?? []), row]);
    for (const [actorId, effects] of byActor) {
      const revisionBefore = (db.prepare(`SELECT revision FROM rpg_m16_mutation_revisions_v26
        WHERE campaign_id=? AND actor_id=?`).get(input.campaignId, actorId) as { revision: number } | undefined)?.revision ?? 0;
      const revisionAfter = revisionBefore + 1, commandId = nextId(ids), eventId = nextId(ids);
      const plannedEffects = effects.map((effect) => ({ effectId: effect.effect_id, lifecycleEventId: nextId(ids),
        remainingBefore: effect.remaining_rounds, remainingAfter: effect.remaining_rounds - 1,
        stateRevisionBefore: effect.state_revision }));
      const request = { kind: "encounter-round-wrap", encounterId: input.encounterId, roundBefore: input.roundBefore,
        roundAfter: input.roundAfter, effectIds: plannedEffects.map((effect) => effect.effectId) };
      const idempotencyKey = `combat-round:${digest(request).slice(0, 64)}`;
      const receipt = { commandId, idempotencyKey, revisionBefore, revisionAfter, occurredAt: input.occurredAt };
      const remaining = new Map(plannedEffects.map((effect) => [effect.effectId, effect.remainingAfter]));
      const resultEffects = readActiveEffects(db, input.campaignId, actorId, input.occurredAt).flatMap((effect) => {
        const after = remaining.get(effect.effectId);
        if (after === undefined) return [effect];
        return after === 0 ? [] : [{ ...effect, duration: { kind: "rounds" as const, remaining: after } }];
      });
      const result = { effects: resultEffects, receipt };
      const requestJson = canonical(request), resultJson = canonical(result);
      effectAdvances.push({ actorId, commandId, eventId, idempotencyKey, revisionBefore, revisionAfter,
        requestJson, requestDigest: digest(requestJson), resultJson, resultDigest: digest(resultJson), effects: plannedEffects });
    }
  }

  return deepFreeze({ encounterId: input.encounterId, campaignId: input.campaignId, occurredAt: input.occurredAt,
    encounterState: { status: encounter.status, round: encounter.round_number,
      currentCombatantId: encounter.current_turn_combatant_id, stateRevision: encounter.state_revision,
      combatRevision: encounter.combat_revision }, combatantChanges: [...input.combatantChanges], healthMirrors,
    effectAdvances });
}
