// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { campaignMembershipReadSchema, resourceIdSchema } from "@velvet/contracts";
import type { CampaignMembershipRead } from "../../types.js";

interface CampaignMembershipReadRow {
  actor_campaign_id: string;
  actor_principal_id: string;
  actor_role: string;
  actor_created_at: string;
  campaign_id: string;
  principal_id: string;
  role: string;
  created_at: string;
  principal_presence: string | null;
}

function toCampaignMembershipRead(row: CampaignMembershipReadRow): CampaignMembershipRead {
  if (row.principal_presence === null || row.principal_presence !== row.principal_id) {
    throw new Error("campaign membership is malformed");
  }
  try {
    campaignMembershipReadSchema.parse({
      campaignId: row.actor_campaign_id,
      principalId: row.actor_principal_id,
      role: row.actor_role,
      createdAt: row.actor_created_at,
    });
    return campaignMembershipReadSchema.parse({
      campaignId: row.campaign_id,
      principalId: row.principal_id,
      role: row.role,
      createdAt: row.created_at,
    });
  } catch {
    throw new Error("campaign membership is malformed");
  }
}

const CAMPAIGN_MEMBERSHIP_READ_SELECT = `SELECT
  actor_membership.campaign_id AS actor_campaign_id,
  actor_membership.principal_id AS actor_principal_id,
  actor_membership.role AS actor_role,
  actor_membership.created_at AS actor_created_at,
  target_membership.campaign_id, target_membership.principal_id,
  target_membership.role, target_membership.created_at,
  target_principal.id AS principal_presence
FROM campaign_memberships actor_membership
JOIN principals actor_principal ON actor_principal.id = actor_membership.principal_id
JOIN campaigns campaign ON campaign.id = actor_membership.campaign_id
JOIN campaign_memberships target_membership ON target_membership.campaign_id = campaign.id
LEFT JOIN principals target_principal ON target_principal.id = target_membership.principal_id
WHERE actor_membership.principal_id = ? AND actor_membership.campaign_id = ?
  AND actor_membership.role = 'owner'
  AND campaign.owner_principal_id = actor_membership.principal_id
  AND (SELECT COUNT(*) FROM campaign_memberships owner_membership
    WHERE owner_membership.campaign_id = campaign.id AND owner_membership.role = 'owner') = 1`;

export interface CampaignMembershipReadRepository {
  listCampaignMemberships(actorPrincipalId: string, campaignId: string): CampaignMembershipRead[];
  getCampaignMembership(
    actorPrincipalId: string,
    campaignId: string,
    principalId: string,
  ): CampaignMembershipRead | null;
}

export function createCampaignMembershipReadRepository(
  db: DatabaseDriver.Database,
): CampaignMembershipReadRepository {
  return {
    listCampaignMemberships(actorPrincipalId, campaignId) {
      const actorId = resourceIdSchema.parse(actorPrincipalId);
      const id = resourceIdSchema.parse(campaignId);
      const rows = db.prepare(`${CAMPAIGN_MEMBERSHIP_READ_SELECT}
ORDER BY target_membership.created_at ASC,
  target_membership.principal_id COLLATE BINARY ASC`).all(actorId, id) as CampaignMembershipReadRow[];
      return rows.map(toCampaignMembershipRead);
    },
    getCampaignMembership(actorPrincipalId, campaignId, principalId) {
      const actorId = resourceIdSchema.parse(actorPrincipalId);
      const id = resourceIdSchema.parse(campaignId);
      const targetPrincipalId = resourceIdSchema.parse(principalId);
      const row = db.prepare(`${CAMPAIGN_MEMBERSHIP_READ_SELECT}
  AND target_membership.principal_id = ?`).get(actorId, id, targetPrincipalId) as
        | CampaignMembershipReadRow
        | undefined;
      return row ? toCampaignMembershipRead(row) : null;
    },
  };
}
