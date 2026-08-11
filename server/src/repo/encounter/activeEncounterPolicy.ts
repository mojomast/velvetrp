import type DatabaseDriver from "better-sqlite3";

/** Connection-scoped policy used by non-encounter health mutation lanes. */
export function actorHasActiveEncounter(
  db: DatabaseDriver.Database,
  campaignId: string,
  actorId: string,
): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM combatant JOIN encounter ON encounter.encounter_id=combatant.encounter_id
    WHERE combatant.campaign_id=? AND combatant.actor_id=? AND encounter.status='active' LIMIT 1`)
    .get(campaignId, actorId));
}
