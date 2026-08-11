import type DatabaseDriver from "better-sqlite3";
import { createCampaignRoomSessionLifecycleRepository } from "../campaign/campaignRoomSessionLifecycleRepo.js";
import type { WorldDependencies } from "./worldWriteRepo.js";
import { createNpcPresenceReadRepository, type NpcPresenceReadRepository } from "./npcPresenceReadRepo.js";
import { createNpcPresenceWriteRepository, type NpcPresenceWriteRepository } from "./npcPresenceWriteRepo.js";

export interface NpcPresenceRepository extends NpcPresenceReadRepository, NpcPresenceWriteRepository {}

/** Reports whether an attached, running session currently has any present NPC. */
export function hasAttachedRunningNpcPresence(
  db: DatabaseDriver.Database,
  campaignId: string,
  sessionId: string,
): boolean {
  const lifecycle = createCampaignRoomSessionLifecycleRepository(db).getCampaignRoomSessionLifecycle(sessionId);
  if (lifecycle !== "running") return false;
  return db.prepare(`SELECT 1 FROM campaign_sessions attachment
    JOIN campaign_npc_presence_v43 presence ON presence.campaign_id=attachment.campaign_id
      AND presence.session_id=attachment.session_id AND presence.state='present'
    WHERE attachment.campaign_id=? AND attachment.session_id=?
    LIMIT 1`).get(campaignId, sessionId) !== undefined;
}

/** Composes NPC-presence operations over the enclosing repository's owned database. */
export function createNpcPresenceRepository(
  db: DatabaseDriver.Database,
  dependencies: WorldDependencies,
  guard: () => void,
): NpcPresenceRepository {
  const reads = createNpcPresenceReadRepository(db, { guard });
  const writes = createNpcPresenceWriteRepository(db, { ...dependencies, guard }, reads);
  return { getNpcCast: reads.getNpcCast, mutateNpcPresence: writes.mutateNpcPresence };
}
