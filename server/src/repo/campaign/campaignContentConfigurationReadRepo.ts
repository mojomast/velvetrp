// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import {
  campaignContentConfigurationSchema,
  campaignMembershipReadSchema,
  contentPackSchema,
  resourceIdSchema,
  rulesProfileSchema,
} from "@velvet/contracts";
import type { CampaignContentConfiguration, ContentPackIdentifier } from "../../types.js";

interface CampaignContentConfigurationReadRow {
  actor_campaign_id: string;
  actor_principal_id: string;
  actor_role: string;
  actor_created_at: string;
  campaign_id: string;
  selected_campaign_id: string | null;
  selected_rules_profile_id: string | null;
  profile_rules_profile_id: string | null;
  profile_name: string | null;
  profile_description: string | null;
  profile_tags: string | null;
  pin_campaign_id: string | null;
  pin_pack_id: string | null;
  pin_pack_version: string | null;
  pin_rules_profile_id: string | null;
  pack_id: string | null;
  pack_version: string | null;
  pack_rules_profile_id: string | null;
  pack_name: string | null;
  pack_description: string | null;
  pack_tags: string | null;
  pack_sealed: number | null;
}

function malformedCampaignContentConfiguration(): never {
  throw new Error("campaign content configuration is malformed");
}

function getCampaignContentConfigurationSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignContentConfiguration | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const rows = db.prepare(`SELECT
      membership.campaign_id AS actor_campaign_id,
      membership.principal_id AS actor_principal_id,
      membership.role AS actor_role,
      membership.created_at AS actor_created_at,
      campaign.id AS campaign_id,
      selected.campaign_id AS selected_campaign_id,
      selected.rules_profile_id AS selected_rules_profile_id,
      profile.rules_profile_id AS profile_rules_profile_id,
      profile.name AS profile_name,
      profile.description AS profile_description,
      profile.tags AS profile_tags,
      pin.campaign_id AS pin_campaign_id,
      pin.pack_id AS pin_pack_id,
      pin.pack_version AS pin_pack_version,
      pin.rules_profile_id AS pin_rules_profile_id,
      pack.pack_id,
      pack.pack_version,
      pack.rules_profile_id AS pack_rules_profile_id,
      pack.name AS pack_name,
      pack.description AS pack_description,
      pack.tags AS pack_tags,
      pack.sealed AS pack_sealed
    FROM campaign_memberships membership
    JOIN principals principal ON principal.id = membership.principal_id
    JOIN campaigns campaign ON campaign.id = membership.campaign_id
    LEFT JOIN campaign_rules_profiles selected ON selected.campaign_id = campaign.id
    LEFT JOIN rpg_rules_profiles profile ON profile.rules_profile_id = selected.rules_profile_id
    LEFT JOIN campaign_content_packs pin ON pin.campaign_id = campaign.id
    LEFT JOIN rpg_content_packs pack
      ON pack.pack_id = pin.pack_id AND pack.pack_version = pin.pack_version
    WHERE membership.principal_id = ? AND membership.campaign_id = ?
      AND (membership.role IN ('gm', 'player', 'observer') OR (
        membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
      ))
    ORDER BY pin.pack_id COLLATE BINARY ASC, pin.pack_version COLLATE BINARY ASC`)
    .all(actorId, id) as CampaignContentConfigurationReadRow[];
  if (rows.length === 0) return null;

  try {
    const first = rows[0]!;
    const authorization = campaignMembershipReadSchema.parse({
      campaignId: first.actor_campaign_id,
      principalId: first.actor_principal_id,
      role: first.actor_role,
      createdAt: first.actor_created_at,
    });
    if (authorization.campaignId !== id || authorization.principalId !== actorId
      || rows.some((row) => row.campaign_id !== id
        || row.actor_campaign_id !== first.actor_campaign_id
        || row.actor_principal_id !== first.actor_principal_id
        || row.actor_role !== first.actor_role
        || row.actor_created_at !== first.actor_created_at)) {
      malformedCampaignContentConfiguration();
    }

    const selectedFields = [
      first.selected_campaign_id,
      first.selected_rules_profile_id,
      first.profile_rules_profile_id,
      first.profile_name,
      first.profile_description,
      first.profile_tags,
    ];
    if (selectedFields.every((value) => value === null)) {
      const hasAnyContent = rows.some((row) => row.pin_campaign_id !== null || row.pin_pack_id !== null
        || row.pin_pack_version !== null || row.pin_rules_profile_id !== null || row.pack_id !== null
        || row.pack_version !== null || row.pack_rules_profile_id !== null || row.pack_name !== null
        || row.pack_description !== null || row.pack_tags !== null || row.pack_sealed !== null);
      if (hasAnyContent || rows.length !== 1) malformedCampaignContentConfiguration();
      return null;
    }
    if (selectedFields.some((value) => value === null)
      || first.selected_campaign_id !== id
      || first.selected_rules_profile_id !== first.profile_rules_profile_id) {
      malformedCampaignContentConfiguration();
    }
    rulesProfileSchema.parse({
      rulesProfileId: first.profile_rules_profile_id!,
      name: first.profile_name!,
      description: first.profile_description!,
      tags: JSON.parse(first.profile_tags!) as unknown,
    });

    const contentPacks: ContentPackIdentifier[] = [];
    for (const row of rows) {
      if (row.selected_campaign_id !== first.selected_campaign_id
        || row.selected_rules_profile_id !== first.selected_rules_profile_id
        || row.profile_rules_profile_id !== first.profile_rules_profile_id
        || row.profile_name !== first.profile_name
        || row.profile_description !== first.profile_description
        || row.profile_tags !== first.profile_tags) {
        malformedCampaignContentConfiguration();
      }
      const pinFields = [row.pin_campaign_id, row.pin_pack_id, row.pin_pack_version, row.pin_rules_profile_id];
      const packFields = [row.pack_id, row.pack_version, row.pack_rules_profile_id, row.pack_name,
        row.pack_description, row.pack_tags, row.pack_sealed];
      if (pinFields.every((value) => value === null)) {
        if (packFields.some((value) => value !== null) || rows.length !== 1) malformedCampaignContentConfiguration();
        continue;
      }
      if (pinFields.some((value) => value === null) || packFields.some((value) => value === null)
        || row.pin_campaign_id !== id
        || row.pin_rules_profile_id !== first.selected_rules_profile_id
        || row.pack_id !== row.pin_pack_id
        || row.pack_version !== row.pin_pack_version
        || row.pack_rules_profile_id !== first.selected_rules_profile_id
        || row.pack_sealed !== 1) {
        malformedCampaignContentConfiguration();
      }
      const pack = contentPackSchema.parse({
        packId: row.pack_id!,
        packVersion: row.pack_version!,
        rulesProfileId: row.pack_rules_profile_id!,
        name: row.pack_name!,
        description: row.pack_description!,
        tags: JSON.parse(row.pack_tags!) as unknown,
      });
      contentPacks.push({ packId: pack.packId, packVersion: pack.packVersion });
    }
    return campaignContentConfigurationSchema.parse({
      campaignId: id,
      rulesProfileId: first.selected_rules_profile_id,
      contentPacks,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "campaign content configuration is malformed") throw error;
    return malformedCampaignContentConfiguration();
  }
}

export interface CampaignContentConfigurationReadRepository {
  getCampaignContentConfiguration(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignContentConfiguration | null;
}

export function createCampaignContentConfigurationReadRepository(
  db: DatabaseDriver.Database,
): CampaignContentConfigurationReadRepository {
  return {
    getCampaignContentConfiguration(actorPrincipalId, campaignId) {
      return getCampaignContentConfigurationSync(db, actorPrincipalId, campaignId);
    },
  };
}

export function getCampaignContentConfigurationReadSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignContentConfiguration | null {
  return getCampaignContentConfigurationSync(db, actorPrincipalId, campaignId);
}
