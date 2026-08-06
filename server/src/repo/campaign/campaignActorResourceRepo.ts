// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { actorResourceNameSchema, actorResourceSchema } from "@velvet/contracts";
import type { ActorResource } from "../../types.js";
import { resourceIdSchema } from "@velvet/contracts";

interface ActorResourceReadRow {
  actor_presence: string | null;
  campaign_character_presence: string | null;
  sheet_presence: string | null;
  resource_presence: string | null;
  campaign_id: string | null;
  actor_id: string | null;
  name: string | null;
  current: unknown;
  max: unknown;
}

const ACTOR_RESOURCE_READ_SELECT = `SELECT
    actor.id AS actor_presence,
    campaign_character.id AS campaign_character_presence,
    sheet.id AS sheet_presence,
    resource.name AS resource_presence,
    resource.campaign_id, resource.actor_id, resource.name, resource.current, resource.max
  FROM campaign_memberships membership
  JOIN principals principal ON principal.id = membership.principal_id
  JOIN campaigns campaign ON campaign.id = membership.campaign_id
  JOIN (
    SELECT campaign_id, id AS actor_id FROM campaign_actors WHERE campaign_id = ? AND id = ?
    UNION
    SELECT resource.campaign_id, resource.actor_id
    FROM rpg_actor_resources resource
    WHERE resource.campaign_id = ? AND resource.actor_id = ?
      AND NOT EXISTS (SELECT 1 FROM campaign_actors known_actor WHERE known_actor.id = resource.actor_id)
  ) actor_identity ON actor_identity.campaign_id = membership.campaign_id
  LEFT JOIN campaign_actors actor
    ON actor.campaign_id = actor_identity.campaign_id AND actor.id = actor_identity.actor_id
  LEFT JOIN campaign_characters campaign_character
    ON campaign_character.campaign_id = actor.campaign_id
      AND campaign_character.id = actor.campaign_character_id
  LEFT JOIN rpg_campaign_sheets sheet
    ON sheet.campaign_id = actor.campaign_id AND sheet.id = actor.sheet_id
      AND sheet.campaign_character_id = campaign_character.id
  LEFT JOIN rpg_actor_resources resource
    ON resource.actor_id = actor_identity.actor_id`;

export function createCampaignActorResourceRepository(db: DatabaseDriver.Database) {
  const actorResourceFromReadRow = (row: ActorResourceReadRow, campaignId: string, actorId: string): ActorResource | null => {
    if (
      row.actor_presence === null || row.campaign_character_presence === null
      || row.sheet_presence === null
    ) {
      throw new Error("actor resource root is incomplete");
    }
    if (row.resource_presence === null) return null;
    const resource = actorResourceSchema.parse({
      campaignId: row.campaign_id,
      actorId: row.actor_id,
      name: row.name,
      current: row.current,
      max: row.max,
    });
    if (resource.campaignId !== campaignId || resource.actorId !== actorId) {
      throw new Error("actor resource record is invalid");
    }
    return resource;
  };
  return {
    listActorResources(actorPrincipalId: string, campaignId: string, actorId: string): ActorResource[] {
      const principalId = resourceIdSchema.parse(actorPrincipalId);
      const normalizedCampaignId = resourceIdSchema.parse(campaignId);
      const normalizedActorId = resourceIdSchema.parse(actorId);
      const rows = db.prepare(`${ACTOR_RESOURCE_READ_SELECT}
        WHERE membership.principal_id = ? AND membership.campaign_id = ?
          AND (membership.role IN ('gm', 'player', 'observer') OR (
            membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
          ))
        ORDER BY resource.name COLLATE BINARY ASC`)
        .all(normalizedCampaignId, normalizedActorId, normalizedCampaignId, normalizedActorId,
          principalId, normalizedCampaignId) as ActorResourceReadRow[];
      const resources: ActorResource[] = [];
      for (const row of rows) {
        const resource = actorResourceFromReadRow(row, normalizedCampaignId, normalizedActorId);
        if (resource) resources.push(resource);
      }
      return resources;
    },
    getActorResource(actorPrincipalId: string, campaignId: string, actorId: string, name: string): ActorResource | null {
      const principalId = resourceIdSchema.parse(actorPrincipalId);
      const normalizedCampaignId = resourceIdSchema.parse(campaignId);
      const normalizedActorId = resourceIdSchema.parse(actorId);
      const normalizedName = actorResourceNameSchema.parse(name);
      const row = db.prepare(`${ACTOR_RESOURCE_READ_SELECT}
          AND resource.name = ? COLLATE BINARY
        WHERE membership.principal_id = ? AND membership.campaign_id = ?
          AND (membership.role IN ('gm', 'player', 'observer') OR (
            membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
          ))`)
        .get(normalizedCampaignId, normalizedActorId, normalizedCampaignId, normalizedActorId,
          normalizedName, principalId, normalizedCampaignId) as ActorResourceReadRow | undefined;
      return row ? actorResourceFromReadRow(row, normalizedCampaignId, normalizedActorId) : null;
    },
  };
}
