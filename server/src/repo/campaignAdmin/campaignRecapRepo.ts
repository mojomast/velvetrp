// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import {
  campaignRecapSchema,
  createCampaignRecapInputSchema,
  resourceIdSchema,
  type CampaignAdministrationReceipt,
  type CampaignRecap,
} from "@velvet/contracts";

type MutationResult<T> = { value: T; receipt: CampaignAdministrationReceipt };
interface MutationContext { commandId: string; at: string }

export interface CampaignRecapRepoDependencies {
  db: DatabaseDriver.Database;
  nextId: () => string;
  runMutation: <T>(actor: string, campaignId: string, expectedRevision: number, key: string,
    type: CampaignAdministrationReceipt["type"], payload: object, apply: (context: MutationContext) => T,
    retry: (commandId: string, stored: unknown) => T) => MutationResult<T>;
  conflict: (message: string) => Error;
  recap: (row: any) => CampaignRecap;
  getAuthority: (actor: string, campaignId: string) => { role: "owner" | "gm" | "player" | "observer" } | null;
}

export function createCampaignRecapRepo(deps: CampaignRecapRepoDependencies) {
  const { db, nextId, runMutation, conflict, recap, getAuthority } = deps;
  return {
    createCampaignRecap: (actor: string, campaignId: string, raw: unknown) => {
      const input = createCampaignRecapInputSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "recap_created",
        { timelineId: input.timelineId, throughRevision: input.throughRevision, selectedSessionIds: input.selectedSessionIds, visibility: input.visibility, text: input.text }, ({ commandId, at }) => {
          const t = db.prepare("SELECT revision FROM campaign_timelines WHERE campaign_id=? AND id=?").get(campaignId, input.timelineId) as any;
          if (!t || input.throughRevision > t.revision) throw conflict("recap revision is unavailable");
          for (const id of input.selectedSessionIds) if (!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(campaignId, id)) throw conflict("recap session is not attached");
          const id = resourceIdSchema.parse(nextId());
          db.prepare(`INSERT INTO campaign_recaps (id,campaign_id,timeline_id,through_revision,selected_session_ids,visibility,text,created_at,command_id)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(id, campaignId, input.timelineId, input.throughRevision, JSON.stringify(input.selectedSessionIds), input.visibility, input.text, at, commandId);
          return recap({ id, campaign_id: campaignId, timeline_id: input.timelineId, through_revision: input.throughRevision,
            selected_session_ids: JSON.stringify(input.selectedSessionIds), visibility: input.visibility, text: input.text, created_at: at });
      }, (_commandId, stored) => campaignRecapSchema.parse(stored));
    },
    listCampaignRecaps: (actor: string, campaignId: string) => {
      const auth = getAuthority(resourceIdSchema.parse(actor), resourceIdSchema.parse(campaignId)); if (!auth) return [];
      const roleFilter = auth.role === "player" || auth.role === "observer" ? " AND visibility='members'" : "";
      return (db.prepare(`SELECT * FROM campaign_recaps WHERE campaign_id=?${roleFilter} ORDER BY created_at,id`).all(campaignId) as any[]).map(recap);
    },
  };
}
