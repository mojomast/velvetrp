import type DatabaseDriver from "better-sqlite3";
import {
  combatLogSchema,
  legalCombatActionAllowlistSchema,
  utcIsoTimestampSchema,
  type LegalCombatActionAllowlist,
} from "@velvet/contracts";
import type { Clock } from "../../runtime.js";
import { projectCombatLogRows, type CombatLogRow } from "./encounterRowTypes.js";

/** Dependencies required by non-mutating encounter operations. */
export interface EncounterReadDependencies { clock: Clock; }

/** Actor-authorized, non-mutating encounter operations. */
export interface EncounterReadRepository {
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
  return { getLegalCombatActionAllowlist, listCombatLog };
}
