import type DatabaseDriver from "better-sqlite3";
import {
  combatStateSchema,
  combatLogSchema,
  encounterPublicSchema,
  legalCombatActionAllowlistSchema,
  utcIsoTimestampSchema,
  type CombatState,
  type CombatLogEntry,
  type EncounterPublic,
  type LegalCombatActionAllowlist,
} from "@velvet/contracts";
import type { Clock } from "../../runtime.js";
import { projectCombatLogRows, type CombatLogRow } from "./encounterRowTypes.js";

/** Dependencies required by non-mutating encounter operations. */
export interface EncounterReadDependencies { clock: Clock; }

export type EncounterLifecycleSnapshot = EncounterPublic & { campaignId: string };
export type EncounterCombatSnapshot = CombatState & { campaignId: string; encounterId: string };
export type CombatLogPage = {
  campaignId: string;
  encounterId: string;
  entries: CombatLogEntry[];
  nextAfterSequence: number | null;
};

/** Actor-authorized, non-mutating encounter operations. */
export interface EncounterReadRepository {
  /** Returns lifecycle summaries for one visible campaign, or null when the campaign is concealed. */
  listEncounters(principal: string, campaignId: string): EncounterLifecycleSnapshot[] | null;
  /** Returns authoritative public combat state by its globally unique encounter-backed identity. */
  getCombatState(principal: string, combatId: string): EncounterCombatSnapshot | null;
  /** Returns a stable append-only page, or null when the combat is absent or concealed. */
  listCombatLogPage(principal: string, combatId: string, afterSequence: number, limit: number): CombatLogPage | null;
  /** Returns actions currently available to the principal's active combatant. */
  getLegalCombatActionAllowlist(principal: string, campaignId: string, encounterId: string): LegalCombatActionAllowlist | null;
  /** Returns validated public combat-log entries when the principal may view the encounter. */
  listCombatLog(principal: string, campaignId: string, encounterId: string): unknown[];
}

/** Creates the database-backed read repository for encounter state. */
export function createEncounterReadRepository(
  db: DatabaseDriver.Database,
  dependencies: EncounterReadDependencies,
): EncounterReadRepository {
  const member = (principal: string, campaignId: string): boolean => Boolean(
    db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principal),
  );
  const controls = (principal: string, campaignId: string, actorId: string): boolean => Boolean(
    db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?").get(campaignId, actorId, principal),
  );
  const gameMaster = (principal: string, campaignId: string): boolean => Boolean(
    db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')")
      .get(campaignId, principal),
  );

  const combatantRows = (encounterId: string): any[] => db.prepare(`SELECT c.*,
    provenance.pack_id provenance_pack_id,provenance.pack_version provenance_pack_version,
    provenance.definition_id provenance_definition_id
    FROM combatant c LEFT JOIN encounter_enemy_provenance_v31 provenance
      ON provenance.encounter_id=c.encounter_id AND provenance.combatant_id=c.combatant_id
    WHERE c.encounter_id=? ORDER BY c.combatant_id`).all(encounterId) as any[];

  const publicCombatant = (row: any) => row.combatant_kind === "actor"
    ? { combatantId: row.combatant_id, kind: "actor" as const, team: row.team, actorId: row.actor_id }
    : {
        combatantId: row.combatant_id,
        kind: "enemy" as const,
        team: row.team,
        template: row.provenance_pack_id === null
          ? null
          : {
              kind: "enemy-template" as const,
              packId: row.provenance_pack_id,
              packVersion: row.provenance_pack_version,
              definitionId: row.provenance_definition_id,
            },
      };

  const listEncounters = (principal: string, campaignId: string): EncounterLifecycleSnapshot[] | null => {
    if (!member(principal, campaignId)) return null;
    const rows = db.prepare(`SELECT e.*,metadata.name,root.revision
      FROM encounter e JOIN encounter_lifecycle_v31 metadata ON metadata.encounter_id=e.encounter_id
      JOIN combat_mutation_revisions_v27 root ON root.encounter_id=e.encounter_id
      WHERE e.campaign_id=? ORDER BY e.created_at,e.encounter_id`).all(campaignId) as any[];
    return rows.map((row) => ({
      campaignId,
      ...encounterPublicSchema.parse({
        encounterId: row.encounter_id,
        sessionId: row.session_id,
        name: row.name,
        status: row.status,
        combatId: row.status === "preparing" ? null : row.encounter_id,
        combatants: combatantRows(row.encounter_id).map(publicCombatant),
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    }));
  };

  const getCombatState = (principal: string, combatId: string): EncounterCombatSnapshot | null => {
    const encounter = db.prepare(`SELECT e.*,root.revision FROM encounter e
      JOIN combat_mutation_revisions_v27 root ON root.encounter_id=e.encounter_id
      WHERE e.encounter_id=? AND e.status<>'preparing'`).get(combatId) as any;
    if (!encounter || !member(principal, encounter.campaign_id)) return null;
    const rows = combatantRows(combatId);
    const active = rows.filter((row) => row.status === "active");
    const current = active.find((row) => row.combatant_id === encounter.current_turn_combatant_id) ?? null;
    const mayAct = current !== null && (gameMaster(principal, encounter.campaign_id)
      || (current.actor_id !== null && controls(principal, encounter.campaign_id, current.actor_id)));
    const targets = current === null ? [] : active
      .filter((row) => row.team !== current.team)
      .map((row) => row.combatant_id)
      .sort();
    const legalActions = mayAct ? [
      ...(targets.length > 0 ? [{ legalActionId: "attack:basic", kind: "attack" as const, targetIds: targets }] : []),
      { legalActionId: "defend", kind: "defend" as const, targetIds: [] },
      { legalActionId: "flee", kind: "flee" as const, targetIds: [] },
      { legalActionId: "end-turn", kind: "end-turn" as const, targetIds: [] },
    ] : [];
    const combat = combatStateSchema.parse({
      combatId,
      round: encounter.round_number,
      currentCombatant: encounter.current_turn_combatant_id,
      combatants: rows.map((row) => ({
        ...publicCombatant(row),
        hitPoints: row.hit_points,
        maximumHitPoints: row.maximum_hit_points,
        status: row.status,
      })),
      legalActions,
      revision: encounter.revision,
    });
    return { campaignId: encounter.campaign_id, encounterId: encounter.encounter_id, ...combat };
  };
  const listCombatLogPage = (principal: string, combatId: string, afterSequence: number, limit: number): CombatLogPage | null => {
    const encounter = db.prepare("SELECT campaign_id FROM encounter WHERE encounter_id=? AND status<>'preparing'").get(combatId) as any;
    if (!encounter || !member(principal, encounter.campaign_id)) return null;
    const rows = db.prepare(`SELECT log_id,log_json,occurred_at FROM combat_log WHERE encounter_id=?
      ORDER BY occurred_at,log_ordinal,log_id`).all(combatId) as CombatLogRow[];
    const remaining = projectCombatLogRows(rows, encounter.campaign_id, combatId)
      .filter((entry) => entry.sequence > afterSequence);
    const entries = remaining.slice(0, limit);
    return {
      campaignId: encounter.campaign_id,
      encounterId: combatId,
      entries,
      nextAfterSequence: remaining.length > entries.length ? entries.at(-1)!.sequence : null,
    };
  };
  /** Builds the authoritative action projection for a principal's current combatant. */
  const getLegalCombatActionAllowlist = (principal: string, campaignId: string, encounterId: string): LegalCombatActionAllowlist | null => {
    if (!member(principal, campaignId)) return null;
    const encounter = db.prepare("SELECT * FROM encounter WHERE encounter_id=? AND campaign_id=? AND status='active'").get(encounterId, campaignId) as any;
    const current = encounter?.current_turn_combatant_id && db.prepare("SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'").get(encounterId, encounter.current_turn_combatant_id) as any;
    if (!current?.actor_id || !controls(principal, campaignId, current.actor_id)) return null;
    const targets = (db.prepare("SELECT combatant_id FROM combatant WHERE encounter_id=? AND status='active' AND team<>? ORDER BY combatant_id").all(encounterId, current.team) as any[]).map((row) => row.combatant_id);
    const actions: any[] = [{ kind: "defend" }, { kind: "flee" }, { kind: "end-turn" }];
    if (targets.length) actions.unshift({ kind: "attack", attackId: "basic_attack", targetCombatantIds: targets });
    const revision = (db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(encounterId) as any)?.revision;
    return legalCombatActionAllowlistSchema.parse({ campaignId, encounterId, combatantId: current.combatant_id, revision: revision ?? 0, issuedAt: utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString()), actions });
  };
  /** Projects only schema-valid public entries from the immutable combat audit log. */
  const listCombatLog = (principal: string, campaignId: string, encounterId: string): unknown[] => {
    if (!member(principal, campaignId) || !db.prepare("SELECT 1 FROM encounter WHERE encounter_id=? AND campaign_id=?").get(encounterId, campaignId)) return [];
    const rows = db.prepare("SELECT log_id,log_json,occurred_at FROM combat_log WHERE encounter_id=? ORDER BY occurred_at,log_ordinal,log_id").all(encounterId) as CombatLogRow[];
    return combatLogSchema.parse(projectCombatLogRows(rows, campaignId, encounterId));
  };
  return { listEncounters, getCombatState, listCombatLogPage, getLegalCombatActionAllowlist, listCombatLog };
}
