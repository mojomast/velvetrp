import type DatabaseDriver from "better-sqlite3";
import {
  combatTurnClockResponseSchema,
  type CombatHandoffCommandRequest,
  type CombatSkipTurnCommandRequest,
  type CombatTurnClockResponse,
} from "@velvet/contracts";
import { systemRuntime, type RuntimeDependencies } from "../../runtime.js";
import {
  EncounterAuthorizationError,
  EncounterStaleError,
  EncounterTurnError,
  EncounterUnavailableError,
} from "./encounterErrors.js";
import { canonical, gm, id, member, now, type EncounterDependencies } from "./actionExecution/shared.js";
import { advance } from "./actionExecution/legacyCommands.js";

export type CombatHandoffEntry = NonNullable<CombatTurnClockResponse["playedByGmUntilReturn"]>[number];
export type CombatHandoffCommandResult = {
  playedByGmUntilReturn: CombatHandoffEntry[];
  revision: number;
};
export type CombatSkipTurnCommandResult = { currentCombatant: string | null; revision: number };

export interface CombatTurnClockRepository {
  getCombatTurnClock(principal: string, combatId: string): CombatTurnClockResponse | null;
  skipCurrentTurn(
    principal: string,
    combatId: string,
    input: CombatSkipTurnCommandRequest,
  ): CombatSkipTurnCommandResult;
  commandCombatHandoff(
    principal: string,
    combatId: string,
    input: CombatHandoffCommandRequest,
  ): CombatHandoffCommandResult;
}

type EncounterRow = {
  encounter_id: string;
  campaign_id: string;
  session_id: string;
  status: string;
  current_turn_combatant_id: string | null;
  revision: number;
};

function encounterRow(db: DatabaseDriver.Database, combatId: string): EncounterRow | null {
  const row = db
    .prepare(
      `SELECT e.encounter_id,e.campaign_id,e.session_id,e.status,e.current_turn_combatant_id,root.revision
      FROM encounter e
      JOIN combat_mutation_revisions_v27 root ON root.encounter_id=e.encounter_id
      WHERE e.encounter_id=? AND e.status NOT IN ('preparing','cancelled')`,
    )
    .get(combatId) as EncounterRow | undefined;
  return row ?? null;
}

function handoffRows(db: DatabaseDriver.Database, encounter: EncounterRow): CombatHandoffEntry[] {
  const rows = db
    .prepare(
      `SELECT handoff.actor_id,persona.name display_name
      FROM actor_handoff_v68 handoff
      JOIN campaign_actors actor ON actor.campaign_id=handoff.campaign_id AND actor.id=handoff.actor_id
      JOIN campaign_characters character ON character.campaign_id=actor.campaign_id
        AND character.id=actor.campaign_character_id
      JOIN characters persona ON persona.id=character.character_id
      WHERE handoff.campaign_id=? AND handoff.session_id=?
        AND EXISTS(SELECT 1 FROM combatant c WHERE c.encounter_id=? AND c.actor_id=handoff.actor_id)
      ORDER BY handoff.actor_id`,
    )
    .all(encounter.campaign_id, encounter.session_id, encounter.encounter_id) as Array<{
    actor_id: string;
    display_name: string | null;
  }>;
  return rows.map((row) => {
    const name = row.display_name?.trim();
    return name ? { actorId: row.actor_id, displayName: name } : { actorId: row.actor_id };
  });
}

function bumpRevision(db: DatabaseDriver.Database, encounterId: string, expectedRevision: number, at: string): number {
  const revision = expectedRevision + 1;
  const result = db
    .prepare("UPDATE combat_mutation_revisions_v27 SET revision=?,updated_at=? WHERE encounter_id=? AND revision=?")
    .run(revision, at, encounterId, expectedRevision);
  if (result.changes !== 1) throw new EncounterStaleError("combat state is stale");
  db.prepare("UPDATE encounter SET state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(
    at,
    encounterId,
  );
  return revision;
}

function staleIfNeeded(encounter: EncounterRow, expectedRevision: number): void {
  if (encounter.revision !== expectedRevision) throw new EncounterStaleError("combat state is stale");
}

/** Reads the visible turn clock and applies explicit GM skip/handoff commands. */
export function createCombatTurnClockRepository(
  db: DatabaseDriver.Database,
  deps: RuntimeDependencies = systemRuntime,
): CombatTurnClockRepository {
  const encounterDependencies: EncounterDependencies = deps;

  return {
    getCombatTurnClock(principal, combatId) {
      const encounter = encounterRow(db, combatId);
      if (!encounter || !member(db, principal, encounter.campaign_id)) return null;
      const openTurn = db
        .prepare("SELECT started_at FROM combat_turn_economy_v60 WHERE encounter_id=? AND ended_at IS NULL")
        .get(combatId) as { started_at: string } | undefined;
      const playedByGmUntilReturn = handoffRows(db, encounter);
      return combatTurnClockResponseSchema.parse({
        currentCombatant: encounter.current_turn_combatant_id,
        ...(openTurn ? { currentTurnStartedAt: openTurn.started_at } : {}),
        timeoutSeconds: 90,
        playedByGmUntilReturn,
      });
    },

    skipCurrentTurn(principal, combatId, input) {
      return db
        .transaction(() => {
          const encounter = encounterRow(db, combatId);
          if (!encounter) throw new EncounterUnavailableError("combat is unavailable");
          if (!gm(db, principal, encounter.campaign_id))
            throw new EncounterAuthorizationError("turn skipping requires GM authority");
          if (encounter.status !== "active") throw new EncounterUnavailableError("encounter is not active");
          staleIfNeeded(encounter, input.expectedRevision);
          const currentId = encounter.current_turn_combatant_id;
          if (!currentId) throw new EncounterTurnError("no current combatant");
          const current = db
            .prepare("SELECT combatant_kind FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'")
            .get(combatId, currentId) as { combatant_kind: string } | undefined;
          if (!current) throw new EncounterTurnError("no current combatant");
          if (current.combatant_kind !== "actor") throw new EncounterTurnError("enemy turns cannot be skipped");
          const at = now(encounterDependencies);
          advance(
            db,
            encounterDependencies,
            principal,
            {
              type: "advance_turn",
              campaignId: encounter.campaign_id,
              encounterId: combatId,
              idempotencyKey: input.idempotencyKey,
            },
            canonical({ expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey }),
            encounter,
            input.expectedRevision,
            input.expectedRevision + 1,
            at,
            id(encounterDependencies),
          );
          const next = db
            .prepare("SELECT current_turn_combatant_id FROM encounter WHERE encounter_id=?")
            .get(combatId) as { current_turn_combatant_id: string | null };
          return { currentCombatant: next.current_turn_combatant_id, revision: input.expectedRevision + 1 };
        })
        .immediate();
    },

    commandCombatHandoff(principal, combatId, input) {
      return db
        .transaction(() => {
          const encounter = encounterRow(db, combatId);
          if (!encounter) throw new EncounterUnavailableError("combat is unavailable");
          if (encounter.status !== "active") throw new EncounterUnavailableError("encounter is not active");
          const authorized = gm(db, principal, encounter.campaign_id);
          const at = now(encounterDependencies);
          const key = { campaignId: encounter.campaign_id, sessionId: encounter.session_id, actorId: input.actorId };
          if (input.action === "take-over") {
            if (!authorized) throw new EncounterAuthorizationError("actor take-over requires GM authority");
            staleIfNeeded(encounter, input.expectedRevision);
            const combatant = db
              .prepare("SELECT 1 FROM combatant WHERE encounter_id=? AND actor_id=? AND combatant_kind='actor'")
              .get(combatId, input.actorId);
            if (!combatant) throw new EncounterTurnError("actor is not part of this combat");
            const controller = db
              .prepare(
                "SELECT controller_principal_id FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=?",
              )
              .get(encounter.campaign_id, input.actorId) as { controller_principal_id: string } | undefined;
            if (!controller) throw new EncounterUnavailableError("actor controller is unavailable");
            db.prepare(
              `INSERT INTO actor_handoff_v68(
              campaign_id,session_id,actor_id,original_controller_principal_id,taken_over_at)
            VALUES(?,?,?,?,?)
            ON CONFLICT(campaign_id,session_id,actor_id)
            DO UPDATE SET taken_over_at=excluded.taken_over_at`,
            ).run(key.campaignId, key.sessionId, key.actorId, controller.controller_principal_id, at);
            return {
              playedByGmUntilReturn: handoffRows(db, encounter),
              revision: bumpRevision(db, combatId, input.expectedRevision, at),
            };
          }
          const handoff = db
            .prepare(
              `SELECT original_controller_principal_id FROM actor_handoff_v68
            WHERE campaign_id=? AND session_id=? AND actor_id=?`,
            )
            .get(key.campaignId, key.sessionId, key.actorId) as
            { original_controller_principal_id: string } | undefined;
          if (!handoff) {
            staleIfNeeded(encounter, input.expectedRevision);
            return { playedByGmUntilReturn: handoffRows(db, encounter), revision: input.expectedRevision };
          }
          if (!authorized && handoff.original_controller_principal_id !== principal)
            throw new EncounterAuthorizationError("only the original controller can reclaim this actor");
          staleIfNeeded(encounter, input.expectedRevision);
          db.prepare("DELETE FROM actor_handoff_v68 WHERE campaign_id=? AND session_id=? AND actor_id=?").run(
            key.campaignId,
            key.sessionId,
            key.actorId,
          );
          return {
            playedByGmUntilReturn: handoffRows(db, encounter),
            revision: bumpRevision(db, combatId, input.expectedRevision, at),
          };
        })
        .immediate();
    },
  };
}
