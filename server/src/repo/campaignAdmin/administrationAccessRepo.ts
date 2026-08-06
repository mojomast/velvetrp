// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import {
  campaignAdministrationSchema,
  campaignSettingsSchema,
  resourceIdSchema,
  utcIsoTimestampSchema,
  type CampaignAdministration,
  type CampaignSettings,
} from "@velvet/contracts";

type Role = "owner" | "gm" | "player" | "observer";

export interface AdministrationAuthority {
  role: Role;
  ownerId: string;
  revision: number;
  status: string;
  settings: CampaignSettings;
  activeTimelineId: string;
  updatedAt: string;
}

export function createAdministrationAccessRepo(db: DatabaseDriver.Database) {
  const getAuthority = (actor: string, campaignId: string): AdministrationAuthority | null => {
    const row = db.prepare(`SELECT m.role,c.owner_principal_id,c.administration_revision,c.lifecycle_status,
      c.settings,c.active_timeline_id,c.updated_at FROM campaigns c JOIN campaign_memberships m ON m.campaign_id=c.id
      JOIN principals p ON p.id=m.principal_id WHERE c.id=? AND m.principal_id=?`).get(campaignId, actor) as any;
    if (!row || !["owner", "gm", "player", "observer"].includes(row.role)) return null;
    if (row.role === "owner" && row.owner_principal_id !== actor) return null;
    return { role: row.role, ownerId: resourceIdSchema.parse(row.owner_principal_id), revision: row.administration_revision,
      status: row.lifecycle_status, settings: campaignSettingsSchema.parse(JSON.parse(row.settings)),
      activeTimelineId: resourceIdSchema.parse(row.active_timeline_id), updatedAt: utcIsoTimestampSchema.parse(row.updated_at) };
  };
  return {
    getAuthority,
    getCampaignAdministration(actorRaw: string, campaignRaw: string): CampaignAdministration | null {
      const actor = resourceIdSchema.parse(actorRaw), campaignId = resourceIdSchema.parse(campaignRaw);
      const auth = getAuthority(actor, campaignId);
      if (!auth) return null;
      const settings = auth.role === "owner" || auth.role === "gm" ? auth.settings : {
        maxPlayers: auth.settings.maxPlayers, allowPlayerDice: auth.settings.allowPlayerDice,
        safetyMode: auth.settings.safetyMode, recapVisibility: auth.settings.recapVisibility,
      };
      return campaignAdministrationSchema.parse({ id: campaignId, status: auth.status, settings,
        activeTimelineId: auth.activeTimelineId, revision: auth.revision, updatedAt: auth.updatedAt, actorRole: auth.role });
    },
  };
}
