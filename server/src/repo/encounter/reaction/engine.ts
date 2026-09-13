import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema } from "@velvet/contracts";
import type { IdGenerator } from "../../../runtime.js";
import type {
  BoundedReactionTrigger, DeclaredReaction, ReactionEvent, ReactionEventKind, ReactionMatchContext, ReactionReceipt,
  ReactionWindowEntry,
} from "./types.js";

const relationOf = (context: ReactionMatchContext, event: ReactionEvent): "self" | "ally" | "enemy" =>
  context.reactorCombatantId === event.subjectCombatantId ? "self"
    : context.reactorTeam === context.subjectTeam ? "ally" : "enemy";

/**
 * The single bounded-trigger predicate. A trigger matches only when the event
 * kind, subject relation, optional reach cap, and optional hit guard all hold.
 */
export function boundedTriggerMatches(
  trigger: BoundedReactionTrigger,
  event: ReactionEvent,
  context: ReactionMatchContext,
): boolean {
  if (trigger.event !== event.kind) return false;
  if (trigger.subject !== relationOf(context, event)) return false;
  if (trigger.requiresHit === true && event.hit !== true) return false;
  if (trigger.maxDistanceFeet !== undefined) {
    if (!Number.isInteger(trigger.maxDistanceFeet) || trigger.maxDistanceFeet < 0) return false;
    if (context.distanceFeet === undefined || context.distanceFeet > trigger.maxDistanceFeet) return false;
  }
  return true;
}

/** One declared or readied response, paired with the context needed to test its trigger. */
export type ReactionCandidate = Readonly<{
  reactorCombatantId: string;
  reactorTeam: string;
  subjectTeam: string;
  distanceFeet?: number;
  source: "declared" | "ready" | "innate";
  readyId?: string;
  responseKind: ReactionWindowEntry["responseKind"];
  responseId: string;
  trigger: BoundedReactionTrigger;
}>;

/** Opens a window: every candidate whose bounded trigger fires for the event, in stable order. */
export function selectReactionWindow(event: ReactionEvent, candidates: readonly ReactionCandidate[]): ReactionWindowEntry[] {
  const entries: ReactionWindowEntry[] = [];
  for (const candidate of candidates) {
    const context: ReactionMatchContext = {
      reactorCombatantId: candidate.reactorCombatantId,
      reactorTeam: candidate.reactorTeam,
      subjectTeam: candidate.subjectTeam,
      round: event.round,
      ...(candidate.distanceFeet === undefined ? {} : { distanceFeet: candidate.distanceFeet }),
    };
    if (!boundedTriggerMatches(candidate.trigger, event, context)) continue;
    entries.push({
      reactorCombatantId: candidate.reactorCombatantId,
      source: candidate.source,
      readyId: candidate.readyId ?? null,
      responseKind: candidate.responseKind,
      responseId: candidate.responseId,
      trigger: candidate.trigger,
    });
  }
  return entries;
}

/** Declares a standing reaction response. Pure and frozen; persistence is the caller's concern. */
export function declareReaction(input: DeclaredReaction): DeclaredReaction {
  if (!input.responseId) throw new Error("declared reaction response is required");
  return Object.freeze({ ...input, trigger: Object.freeze({ ...input.trigger }) });
}

export type ReactionBudget = Readonly<{ used: boolean; available: boolean; usedAt: string | null }>;

/** Reads the separate per-round reaction marker without consuming it. */
export function readReactionBudget(
  db: DatabaseDriver.Database, encounterId: string, combatantId: string, round: number,
): ReactionBudget {
  const row = db.prepare(`SELECT used,used_at FROM combat_reaction_usage_v63
    WHERE encounter_id=? AND combatant_id=? AND round_number=?`).get(encounterId, combatantId, round) as
    { used: number; used_at: string | null } | undefined;
  const used = row?.used === 1;
  return { used, available: !used, usedAt: row?.used_at ?? null };
}

/**
 * Atomically claims the single per-round reaction. This is the same marker
 * opportunity attacks have always used, so a reactor can only react once per
 * round across every trigger kind.
 */
export function claimReactionBudget(
  db: DatabaseDriver.Database, encounterId: string, combatantId: string, round: number, at: string,
): boolean {
  const result = db.prepare(`INSERT INTO combat_reaction_usage_v63(encounter_id,combatant_id,round_number,used,used_at) VALUES(?,?,?,1,?)
    ON CONFLICT(encounter_id,combatant_id,round_number) DO UPDATE SET used=1,used_at=excluded.used_at WHERE combat_reaction_usage_v63.used=0`)
    .run(encounterId, combatantId, round, at);
  return result.changes === 1;
}

/** Releases a claimed reaction (used only for rollback inside a failed transaction). */
export function releaseReactionBudget(
  db: DatabaseDriver.Database, encounterId: string, combatantId: string, round: number,
): void {
  db.prepare("UPDATE combat_reaction_usage_v63 SET used=0,used_at=NULL WHERE encounter_id=? AND combatant_id=? AND round_number=? AND used=1")
    .run(encounterId, combatantId, round);
}

/** Builds the deterministic response receipt for one spent reaction. */
export function buildReactionReceipt<TOutcome extends Record<string, unknown>>(
  ids: IdGenerator, input: {
    event: ReactionEventKind;
    reactorCombatantId: string;
    sourceCombatantId: string | null;
    round: number;
    responseKind: ReactionReceipt["responseKind"];
    responseId: string;
    readiness: ReactionReceipt["readiness"];
    outcome: TOutcome;
  },
): ReactionReceipt<TOutcome> {
  return {
    reactionId: resourceIdSchema.parse(ids.nextId()),
    event: input.event,
    reactorCombatantId: input.reactorCombatantId,
    sourceCombatantId: input.sourceCombatantId,
    round: input.round,
    responseKind: input.responseKind,
    responseId: input.responseId,
    readiness: input.readiness,
    outcome: input.outcome,
  };
}
