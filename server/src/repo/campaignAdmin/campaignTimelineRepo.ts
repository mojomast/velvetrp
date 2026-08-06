// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema, type CampaignTimelineHistory } from "@velvet/contracts";

interface Authority { activeTimelineId: string }

export interface CampaignTimelineRepoDependencies {
  db: DatabaseDriver.Database;
  getAuthority: (actor: string, campaignId: string) => Authority | null;
  timeline: (row: any, activeId: string) => CampaignTimelineHistory;
}

export function createCampaignTimelineRepo(deps: CampaignTimelineRepoDependencies) {
  const { db, getAuthority, timeline } = deps;
  return {
    listCampaignTimelineHistory: (actor: string, campaignId: string) => {
      const auth = getAuthority(resourceIdSchema.parse(actor), resourceIdSchema.parse(campaignId)); if (!auth) return [];
      return (db.prepare(`SELECT t.*,h.parent_timeline_id,h.forked_from_revision FROM campaign_timelines t
        JOIN campaign_timeline_history h ON h.campaign_id=t.campaign_id AND h.timeline_id=t.id
        WHERE t.campaign_id=? ORDER BY t.created_at,t.id`).all(campaignId) as any[]).map((row) => timeline(row, auth.activeTimelineId));
    },
  };
}
