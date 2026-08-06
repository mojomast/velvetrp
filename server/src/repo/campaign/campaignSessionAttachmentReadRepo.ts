// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { attachCampaignSessionInputSchema, campaignMembershipReadSchema, campaignSessionAttachmentSchema, resourceIdSchema } from "@velvet/contracts";
import type { CampaignSessionAttachment } from "../../types.js";

interface CampaignSessionAttachmentReadRow {
  actor_campaign_id: string;
  actor_principal_id: string;
  actor_role: string;
  actor_created_at: string;
  campaign_id: string;
  session_id: string;
  attached_at: string;
  session_presence: string | null;
}

function toCampaignSessionAttachmentRead(
  row: CampaignSessionAttachmentReadRow,
): CampaignSessionAttachment {
  if (row.session_presence === null || row.session_presence !== row.session_id) {
    throw new Error("campaign session attachment is malformed");
  }
  try {
    campaignMembershipReadSchema.parse({
      campaignId: row.actor_campaign_id,
      principalId: row.actor_principal_id,
      role: row.actor_role,
      createdAt: row.actor_created_at,
    });
    return campaignSessionAttachmentSchema.parse({
      campaignId: row.campaign_id,
      sessionId: row.session_id,
      attachedAt: row.attached_at,
    });
  } catch {
    throw new Error("campaign session attachment is malformed");
  }
}

const CAMPAIGN_SESSION_ATTACHMENT_READ_SELECT = `SELECT
  actor_membership.campaign_id AS actor_campaign_id,
  actor_membership.principal_id AS actor_principal_id,
  actor_membership.role AS actor_role,
  actor_membership.created_at AS actor_created_at,
  attachment.campaign_id, attachment.session_id, attachment.attached_at,
  target_session.id AS session_presence
FROM campaign_memberships actor_membership
JOIN principals actor_principal ON actor_principal.id = actor_membership.principal_id
JOIN campaigns campaign ON campaign.id = actor_membership.campaign_id
JOIN campaign_sessions attachment ON attachment.campaign_id = campaign.id
LEFT JOIN sessions target_session ON target_session.id = attachment.session_id
WHERE actor_membership.principal_id = ? AND actor_membership.campaign_id = ?
  AND actor_membership.role = 'owner'
  AND campaign.owner_principal_id = actor_membership.principal_id
  AND (SELECT COUNT(*) FROM campaign_memberships owner_membership
    WHERE owner_membership.campaign_id = campaign.id AND owner_membership.role = 'owner') = 1`;

export interface CampaignSessionAttachmentReadRepository {
  listCampaignSessionAttachments(actorPrincipalId: string, campaignId: string): CampaignSessionAttachment[];
  getCampaignSessionAttachment(
    actorPrincipalId: string,
    campaignId: string,
    sessionId: string,
  ): CampaignSessionAttachment | null;
}

export function createCampaignSessionAttachmentReadRepository(
  db: DatabaseDriver.Database,
): CampaignSessionAttachmentReadRepository {
  return {
    listCampaignSessionAttachments(actorPrincipalId, campaignId) {
      const actorId = resourceIdSchema.parse(actorPrincipalId);
      const id = resourceIdSchema.parse(campaignId);
      const rows = db.prepare(`${CAMPAIGN_SESSION_ATTACHMENT_READ_SELECT}
ORDER BY attachment.attached_at ASC,
  attachment.session_id COLLATE BINARY ASC`).all(actorId, id) as CampaignSessionAttachmentReadRow[];
      return rows.map(toCampaignSessionAttachmentRead);
    },
    getCampaignSessionAttachment(actorPrincipalId, campaignId, sessionId) {
      const actorId = resourceIdSchema.parse(actorPrincipalId);
      const id = resourceIdSchema.parse(campaignId);
      // Legacy session identifiers are deliberately opaque and are not resource IDs.
      const targetSessionId = attachCampaignSessionInputSchema.shape.sessionId.parse(sessionId);
      const row = db.prepare(`${CAMPAIGN_SESSION_ATTACHMENT_READ_SELECT}
  AND attachment.session_id = ?`).get(actorId, id, targetSessionId) as
        | CampaignSessionAttachmentReadRow
        | undefined;
      return row ? toCampaignSessionAttachmentRead(row) : null;
    },
  };
}
