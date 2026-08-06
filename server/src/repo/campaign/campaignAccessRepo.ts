// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { campaignAccessSchema, campaignMembershipReadSchema, resourceIdSchema } from "@velvet/contracts";
import type { CampaignAccess } from "../../types.js";

interface CampaignAccessRow {
  id: string;
  name: string;
  active_timeline_id: string;
  owner_principal_id: string;
  created_at: string;
  updated_at: string;
  actor_role: string;
  actor_campaign_id: string;
  actor_principal_id: string;
  actor_created_at: string;
  owner_role_count: unknown;
  owner_campaign_id: string | null;
  owner_membership_principal_id: string | null;
  owner_role: string | null;
  owner_created_at: string | null;
  owner_parent_id: string | null;
}

function toCampaignAccess(row: CampaignAccessRow): CampaignAccess {
  return campaignAccessSchema.parse({
    id: row.id,
    name: row.name,
    activeTimelineId: row.active_timeline_id,
    ownerPrincipalId: row.owner_principal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    actorRole: row.actor_role,
  });
}

const CAMPAIGN_ACCESS_PROJECTION = `c.id, c.name, c.active_timeline_id, c.owner_principal_id,
  c.created_at, c.updated_at, cm.role AS actor_role, cm.campaign_id AS actor_campaign_id,
  cm.principal_id AS actor_principal_id, cm.created_at AS actor_created_at,
  (SELECT COUNT(*) FROM campaign_memberships owner_membership
    WHERE owner_membership.campaign_id = c.id AND owner_membership.role = 'owner') AS owner_role_count,
  owner_membership.campaign_id AS owner_campaign_id,
  owner_membership.principal_id AS owner_membership_principal_id,
  owner_membership.role AS owner_role,
  owner_membership.created_at AS owner_created_at,
  owner_principal.id AS owner_parent_id`;

function authorizedCampaignAccess(row: CampaignAccessRow, actorId: string): CampaignAccess | null {
  // Unknown roles and stale purported owners are authorization failures, not
  // corruption oracles. Only after a current membership authorizes may owner
  // integrity become attributable to the caller and therefore fail loudly.
  if (!(["owner", "gm", "player", "observer"] as string[]).includes(row.actor_role)) return null;
  if (row.actor_role === "owner" && row.owner_principal_id !== actorId) return null;

  campaignMembershipReadSchema.parse({
    campaignId: row.actor_campaign_id,
    principalId: row.actor_principal_id,
    role: row.actor_role,
    createdAt: row.actor_created_at,
  });
  if (row.actor_campaign_id !== row.id || row.actor_principal_id !== actorId) {
    throw new Error("campaign access authorization is malformed");
  }

  try {
    if (row.owner_role_count !== 1
      || row.owner_campaign_id === null
      || row.owner_membership_principal_id === null
      || row.owner_role === null
      || row.owner_created_at === null
      || row.owner_parent_id === null) {
      throw new Error("missing or non-sole campaign owner");
    }
    const owner = campaignMembershipReadSchema.parse({
      campaignId: row.owner_campaign_id,
      principalId: row.owner_membership_principal_id,
      role: row.owner_role,
      createdAt: row.owner_created_at,
    });
    if (owner.role !== "owner"
      || owner.campaignId !== row.id
      || owner.principalId !== row.owner_principal_id
      || row.owner_parent_id !== owner.principalId) {
      throw new Error("campaign owner identities do not agree");
    }
  } catch {
    throw new Error("campaign owner authorization is malformed");
  }
  return toCampaignAccess(row);
}

export interface CampaignAccessRepository {
  listCampaigns(actorPrincipalId: string): CampaignAccess[];
  getCampaign(actorPrincipalId: string, campaignId: string): CampaignAccess | null;
}

export function createCampaignAccessRepository(db: DatabaseDriver.Database): CampaignAccessRepository {
  return {
    listCampaigns(actorPrincipalId) {
      const actorId = resourceIdSchema.parse(actorPrincipalId);
      const rows = db.prepare(`SELECT ${CAMPAIGN_ACCESS_PROJECTION}
    FROM campaign_memberships cm
    JOIN principals actor_principal ON actor_principal.id = cm.principal_id
    JOIN campaigns c ON c.id = cm.campaign_id
    LEFT JOIN campaign_memberships owner_membership
      ON owner_membership.campaign_id = c.id
      AND owner_membership.principal_id = c.owner_principal_id
      AND owner_membership.role = 'owner'
    LEFT JOIN principals owner_principal ON owner_principal.id = owner_membership.principal_id
    WHERE cm.principal_id = ?
    ORDER BY c.created_at ASC, c.id ASC`).all(actorId) as CampaignAccessRow[];
      return rows.flatMap((row) => {
        const campaign = authorizedCampaignAccess(row, actorId);
        return campaign ? [campaign] : [];
      });
    },
    getCampaign(actorPrincipalId, campaignId) {
      const actorId = resourceIdSchema.parse(actorPrincipalId);
      const id = resourceIdSchema.parse(campaignId);
      const row = db.prepare(`SELECT ${CAMPAIGN_ACCESS_PROJECTION}
    FROM campaign_memberships cm
    JOIN principals actor_principal ON actor_principal.id = cm.principal_id
    JOIN campaigns c ON c.id = cm.campaign_id
    LEFT JOIN campaign_memberships owner_membership
      ON owner_membership.campaign_id = c.id
      AND owner_membership.principal_id = c.owner_principal_id
      AND owner_membership.role = 'owner'
    LEFT JOIN principals owner_principal ON owner_principal.id = owner_membership.principal_id
    WHERE cm.principal_id = ? AND c.id = ?`).get(actorId, id) as CampaignAccessRow | undefined;
      return row ? authorizedCampaignAccess(row, actorId) : null;
    },
  };
}
