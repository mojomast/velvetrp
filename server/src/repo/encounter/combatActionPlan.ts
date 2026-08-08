import type DatabaseDriver from "better-sqlite3";

export type CombatActionPlan = {
  legalActionId: "attack:basic" | "flee" | "end-turn";
  kind: "attack" | "flee" | "end-turn";
  actingCombatantId: string;
  targetIds: string[];
};

/** One authoritative action planner shared by combat reads and writes. */
export function buildCombatActionPlans(
  db: DatabaseDriver.Database,
  principal: string,
  campaignId: string,
  encounterId: string,
  currentCombatantId: string | null,
): CombatActionPlan[] {
  if (currentCombatantId === null) return [];
  const current = db.prepare(`SELECT combatant_id,combatant_kind,actor_id,team FROM combatant
    WHERE encounter_id=? AND combatant_id=? AND status='active'`).get(encounterId, currentCombatantId) as any;
  if (!current) return [];
  const gm = Boolean(db.prepare(`SELECT 1 FROM campaign_memberships
    WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')`).get(campaignId, principal));
  const controls = current.actor_id !== null && Boolean(db.prepare(`SELECT 1 FROM campaign_actor_private_state
    WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`).get(campaignId, current.actor_id, principal));
  if (!gm && !controls) return [];
  const targets = (db.prepare(`SELECT combatant_id FROM combatant WHERE encounter_id=? AND status='active' AND team<>?
    ORDER BY combatant_id`).all(encounterId, current.team) as Array<{ combatant_id: string }>).map((row) => row.combatant_id);
  const attackTargets = current.combatant_kind === "enemy" ? targets.slice(0, 1) : targets;
  return [
    ...(attackTargets.length > 0 ? [{ legalActionId: "attack:basic" as const, kind: "attack" as const,
      actingCombatantId: current.combatant_id, targetIds: attackTargets }] : []),
    { legalActionId: "flee", kind: "flee", actingCombatantId: current.combatant_id, targetIds: [] },
    { legalActionId: "end-turn", kind: "end-turn", actingCombatantId: current.combatant_id, targetIds: [] },
  ];
}
