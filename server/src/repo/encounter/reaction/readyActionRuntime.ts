import type DatabaseDriver from "better-sqlite3";
import type { MapPoint } from "@velvet/contracts";
import { gridDistanceFeet } from "../../../map/geometry.js";
import type { ReactionCandidate } from "./engine.js";
import type { ReactionEvent } from "./types.js";

/**
 * Durable persistence for player Ready actions. The pure `planDnd5eReadyAction`
 * engine owns the bounded trigger vocabulary; this module only stores the
 * resulting declaration, projects it, expires it, and feeds it into the shared
 * reaction window as a `ready` candidate.
 */

export type PersistedReadyAction = Readonly<{
  combatantId: string;
  readyId: string;
  responseKind: "spell" | "maneuver";
  responseId: string;
  triggerEvent: "hit" | "targeted" | "turn-start" | "leaves-reach";
  triggerSubject: "self" | "ally" | "enemy";
  maxDistanceFeet: number | null;
  requiresHit: boolean;
  expiresAtRound: number;
}>;

interface ReadyRow {
  combatant_id: string;
  ready_id: string;
  response_kind: "spell" | "maneuver";
  response_id: string;
  trigger_event: "hit" | "targeted" | "turn-start" | "leaves-reach";
  trigger_subject: "self" | "ally" | "enemy";
  max_distance_feet: number | null;
  requires_hit: number;
  expires_at_round: number;
}

function view(row: ReadyRow): PersistedReadyAction {
  return {
    combatantId: row.combatant_id,
    readyId: row.ready_id,
    responseKind: row.response_kind,
    responseId: row.response_id,
    triggerEvent: row.trigger_event,
    triggerSubject: row.trigger_subject,
    maxDistanceFeet: row.max_distance_feet,
    requiresHit: row.requires_hit === 1,
    expiresAtRound: row.expires_at_round,
  };
}

const SELECT = `SELECT combatant_id,ready_id,response_kind,response_id,trigger_event,trigger_subject,
  max_distance_feet,requires_hit,expires_at_round FROM combat_ready_actions_v66`;

/** Upserts the single ready action for a combatant, replacing any prior declaration. */
export function declareReadyAction(db: DatabaseDriver.Database, input: {
  encounterId: string; combatantId: string; readyId: string; responseKind: "spell" | "maneuver";
  responseId: string; triggerEvent: PersistedReadyAction["triggerEvent"]; triggerSubject: PersistedReadyAction["triggerSubject"];
  maxDistanceFeet: number | null; requiresHit: boolean; expiresAtRound: number; commandId: string; at: string;
}): void {
  db.prepare(`INSERT INTO combat_ready_actions_v66(encounter_id,combatant_id,ready_id,response_kind,response_id,
    trigger_event,trigger_subject,max_distance_feet,requires_hit,expires_at_round,command_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(encounter_id,combatant_id) DO UPDATE SET
      ready_id=excluded.ready_id,response_kind=excluded.response_kind,response_id=excluded.response_id,
      trigger_event=excluded.trigger_event,trigger_subject=excluded.trigger_subject,max_distance_feet=excluded.max_distance_feet,
      requires_hit=excluded.requires_hit,expires_at_round=excluded.expires_at_round,command_id=excluded.command_id,created_at=excluded.created_at`)
    .run(input.encounterId, input.combatantId, input.readyId, input.responseKind, input.responseId,
      input.triggerEvent, input.triggerSubject, input.maxDistanceFeet, input.requiresHit ? 1 : 0,
      input.expiresAtRound, input.commandId, input.at);
}

/** Every unexpired ready action in the encounter, in stable combatant order. */
export function readReadyActions(db: DatabaseDriver.Database, encounterId: string, round: number): PersistedReadyAction[] {
  return (db.prepare(`${SELECT} WHERE encounter_id=? AND expires_at_round>=? ORDER BY combatant_id`).all(encounterId, round) as ReadyRow[]).map(view);
}

/** Removes expired ready actions and returns the surviving set. */
export function expireReadyActions(db: DatabaseDriver.Database, encounterId: string, round: number): void {
  db.prepare("DELETE FROM combat_ready_actions_v66 WHERE encounter_id=? AND expires_at_round<?").run(encounterId, round);
}

/** Clears the ready action of a combatant whose turn is starting (it expires at your next turn). */
export function clearReadyActionForCombatant(db: DatabaseDriver.Database, encounterId: string, combatantId: string): void {
  db.prepare("DELETE FROM combat_ready_actions_v66 WHERE encounter_id=? AND combatant_id=?").run(encounterId, combatantId);
}

/** Consumes a fired ready action. Returns true when the exact declaration was still present. */
export function consumeReadyAction(db: DatabaseDriver.Database, encounterId: string, combatantId: string, readyId: string): boolean {
  return db.prepare("DELETE FROM combat_ready_actions_v66 WHERE encounter_id=? AND combatant_id=? AND ready_id=?")
    .run(encounterId, combatantId, readyId).changes === 1;
}

/**
 * Builds reaction candidates for every unexpired ready action whose bounded
 * trigger can match the event. Distance is measured from the reactor's token to
 * the event's subject position so a readied response can cover more reach than
 * the innate adjacent opportunity attack.
 */
export function buildReadyCandidates(
  db: DatabaseDriver.Database,
  event: ReactionEvent,
  subjectPosition: MapPoint,
): ReactionCandidate[] {
  const rows = db.prepare(`${SELECT} WHERE encounter_id=? AND expires_at_round>=? ORDER BY combatant_id`)
    .all(event.encounterId, event.round) as ReadyRow[];
  if (rows.length === 0) return [];
  const subjectTeam = (db.prepare("SELECT team FROM combatant WHERE encounter_id=? AND combatant_id=?")
    .get(event.encounterId, event.subjectCombatantId) as { team: string } | undefined)?.team;
  if (subjectTeam === undefined) return [];
  const mapId = (db.prepare("SELECT map_id FROM tactical_maps_v58 WHERE encounter_id=? AND active=1").get(event.encounterId) as { map_id: string } | undefined)?.map_id;
  const candidates: ReactionCandidate[] = [];
  for (const row of rows) {
    const reactor = db.prepare("SELECT team FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'")
      .get(event.encounterId, row.combatant_id) as { team: string } | undefined;
    if (!reactor) continue;
    // A self-subject trigger is always at distance zero; other subjects need an
    // authoritative token so the bounded reach cap can be evaluated.
    let distanceFeet = 0;
    if (row.combatant_id !== event.subjectCombatantId) {
      if (!mapId) continue;
      const token = db.prepare("SELECT x,y FROM tactical_map_tokens_v58 WHERE combatant_id=? AND map_id=?")
        .get(row.combatant_id, mapId) as { x: number; y: number } | undefined;
      if (!token) continue;
      distanceFeet = gridDistanceFeet({ x: token.x, y: token.y }, subjectPosition);
    }
    candidates.push({
      reactorCombatantId: row.combatant_id,
      reactorTeam: reactor.team,
      subjectTeam,
      distanceFeet,
      source: "ready",
      readyId: row.ready_id,
      responseKind: row.response_kind,
      responseId: row.response_id,
      trigger: {
        event: row.trigger_event,
        subject: row.trigger_subject,
        ...(row.max_distance_feet === null ? {} : { maxDistanceFeet: row.max_distance_feet }),
        ...(row.requires_hit ? { requiresHit: true } : {}),
      },
    });
  }
  return candidates;
}
