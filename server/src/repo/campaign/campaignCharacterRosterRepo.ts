// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import {
  MAX_CAMPAIGN_CHARACTER_ROSTER,
  campaignMembershipReadSchema,
  publicCampaignCharacterSummarySchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type { CampaignCharacterRosterSnapshot } from "../campaignRepo.js";

interface CampaignCharacterRosterRow {
  requesting_campaign_id: string;
  requesting_principal_id: string;
  requesting_role: string;
  requesting_created_at: string;
  campaign_owner_principal_id: string;
  campaign_owner_role: string;
  owner_role_count: number;
  exact_owner_count: number;
  owner_membership_campaign_id: string | null;
  owner_membership_principal_id: string | null;
  owner_membership_role: string | null;
  owner_membership_created_at: string | null;
  owner_parent_id: string | null;
  campaign_character_id: string | null;
  character_id: string | null;
  persona_name: string | null;
  roster_count: number;
  integrity_error_count: number;
}

function malformedCampaignCharacterRoster(): never {
  throw new Error("campaign character roster is malformed");
}

/** One-statement safe roster snapshot with no private or aggregate payload fields. */
export function createCampaignCharacterRosterOperations(
  db: DatabaseDriver.Database,
  projectLegacyPersonaDisplayName: (value: unknown) => string,
) {
  return {
    getCampaignCharacterRoster: (
      actorPrincipalId: string,
      campaignId: string,
    ): CampaignCharacterRosterSnapshot | null => {
      const actorId = resourceIdSchema.parse(actorPrincipalId);
      const id = resourceIdSchema.parse(campaignId);
      const rows = db.prepare(`WITH authorized AS (
      SELECT membership.campaign_id, membership.principal_id, membership.role, membership.created_at,
        campaign.owner_principal_id, campaign.owner_role
      FROM campaign_memberships membership
      JOIN principals requesting_principal ON requesting_principal.id = membership.principal_id
      JOIN campaigns campaign ON campaign.id = membership.campaign_id
      WHERE membership.principal_id = $actorId AND membership.campaign_id = $campaignId
        AND (membership.role IN ('gm', 'player', 'observer') OR
          (membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id))
    )
    SELECT authorized.campaign_id AS requesting_campaign_id,
      authorized.principal_id AS requesting_principal_id,
      authorized.role AS requesting_role,
      authorized.created_at AS requesting_created_at,
      authorized.owner_principal_id AS campaign_owner_principal_id,
      authorized.owner_role AS campaign_owner_role,
      (SELECT COUNT(*) FROM campaign_memberships owner_membership
        WHERE owner_membership.campaign_id = authorized.campaign_id
          AND owner_membership.role = 'owner') AS owner_role_count,
      (SELECT COUNT(*) FROM campaign_memberships owner_membership
        JOIN principals owner_parent ON owner_parent.id = owner_membership.principal_id
        WHERE owner_membership.campaign_id = authorized.campaign_id
          AND owner_membership.role = 'owner'
          AND owner_membership.principal_id = authorized.owner_principal_id) AS exact_owner_count,
      owner_membership.campaign_id AS owner_membership_campaign_id,
      owner_membership.principal_id AS owner_membership_principal_id,
      owner_membership.role AS owner_membership_role,
      owner_membership.created_at AS owner_membership_created_at,
      owner_parent.id AS owner_parent_id,
      cc.id AS campaign_character_id,
      cc.character_id,
      persona.name AS persona_name,
      (SELECT COUNT(*) FROM campaign_characters roster
        WHERE roster.campaign_id = authorized.campaign_id) AS roster_count,
      CASE WHEN cc.id IS NULL THEN 0 ELSE
        (persona.id IS NULL)
        + (s.id IS NULL OR s.campaign_id IS NOT cc.campaign_id OR s.campaign_character_id IS NOT cc.id)
        + (a.id IS NULL OR a.campaign_id IS NOT cc.campaign_id
          OR a.campaign_character_id IS NOT cc.id OR a.sheet_id IS NOT s.id)
        + (a.id IS NOT NULL AND (ps.actor_id IS NULL OR ps.campaign_id IS NOT a.campaign_id))
        + (ps.actor_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM principals controller_principal
          JOIN campaign_memberships controller_membership
            ON controller_membership.principal_id = controller_principal.id
           AND controller_membership.campaign_id = ps.campaign_id
          JOIN campaigns controller_campaign ON controller_campaign.id = controller_membership.campaign_id
          WHERE controller_principal.id = ps.controller_principal_id
            AND (controller_membership.role IN ('gm', 'player') OR
              (controller_membership.role = 'owner'
                AND controller_campaign.owner_principal_id = controller_membership.principal_id))))
        + (s.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM campaign_content_packs pin
          JOIN rpg_content_packs pack ON pack.pack_id = pin.pack_id AND pack.pack_version = pin.pack_version
            AND pack.rules_profile_id = pin.rules_profile_id AND pack.sealed = 1
          JOIN campaign_rules_profiles selection ON selection.campaign_id = pin.campaign_id
            AND selection.rules_profile_id = pin.rules_profile_id
          JOIN rpg_rules_profiles profile ON profile.rules_profile_id = selection.rules_profile_id
          WHERE pin.campaign_id = s.campaign_id AND pin.pack_id = s.race_pack_id
            AND pin.pack_version = s.race_pack_version))
        + (s.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rpg_definitions definition
          WHERE definition.pack_id = s.race_pack_id AND definition.pack_version = s.race_pack_version
            AND definition.kind = s.race_kind AND definition.definition_id = s.race_definition_id))
        + (s.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM campaign_content_packs pin
          JOIN rpg_content_packs pack ON pack.pack_id = pin.pack_id AND pack.pack_version = pin.pack_version
            AND pack.rules_profile_id = pin.rules_profile_id AND pack.sealed = 1
          JOIN campaign_rules_profiles selection ON selection.campaign_id = pin.campaign_id
            AND selection.rules_profile_id = pin.rules_profile_id
          JOIN rpg_rules_profiles profile ON profile.rules_profile_id = selection.rules_profile_id
          WHERE pin.campaign_id = s.campaign_id AND pin.pack_id = s.background_pack_id
            AND pin.pack_version = s.background_pack_version))
        + (s.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rpg_definitions definition
          WHERE definition.pack_id = s.background_pack_id AND definition.pack_version = s.background_pack_version
            AND definition.kind = s.background_kind AND definition.definition_id = s.background_definition_id))
        + (SELECT COUNT(*) FROM rpg_character_classes child
          WHERE child.sheet_id = s.id AND (child.campaign_id IS NOT s.campaign_id
            OR NOT EXISTS (SELECT 1 FROM campaign_content_packs pin
              JOIN rpg_content_packs pack ON pack.pack_id = pin.pack_id AND pack.pack_version = pin.pack_version
                AND pack.rules_profile_id = pin.rules_profile_id AND pack.sealed = 1
              JOIN campaign_rules_profiles selection ON selection.campaign_id = pin.campaign_id
                AND selection.rules_profile_id = pin.rules_profile_id
              JOIN rpg_rules_profiles profile ON profile.rules_profile_id = selection.rules_profile_id
              WHERE pin.campaign_id = child.campaign_id AND pin.pack_id = child.pack_id
                AND pin.pack_version = child.pack_version)
            OR NOT EXISTS (SELECT 1 FROM rpg_definitions definition WHERE definition.pack_id = child.pack_id
              AND definition.pack_version = child.pack_version AND definition.kind = child.kind
              AND definition.definition_id = child.definition_id)))
        + (SELECT COUNT(*) FROM rpg_character_attributes child
          WHERE child.sheet_id = s.id AND child.campaign_id IS NOT s.campaign_id)
        + (SELECT COUNT(*) FROM rpg_character_proficiencies child
          WHERE child.sheet_id = s.id AND child.campaign_id IS NOT s.campaign_id)
        + (SELECT COUNT(*) FROM rpg_character_choices child
          WHERE child.sheet_id = s.id AND (child.campaign_id IS NOT s.campaign_id
            OR NOT EXISTS (SELECT 1 FROM campaign_content_packs pin
              JOIN rpg_content_packs pack ON pack.pack_id = pin.pack_id AND pack.pack_version = pin.pack_version
                AND pack.rules_profile_id = pin.rules_profile_id AND pack.sealed = 1
              JOIN campaign_rules_profiles selection ON selection.campaign_id = pin.campaign_id
                AND selection.rules_profile_id = pin.rules_profile_id
              JOIN rpg_rules_profiles profile ON profile.rules_profile_id = selection.rules_profile_id
              WHERE pin.campaign_id = child.campaign_id AND pin.pack_id = child.pack_id
                AND pin.pack_version = child.pack_version)
            OR NOT EXISTS (SELECT 1 FROM rpg_definitions definition WHERE definition.pack_id = child.pack_id
              AND definition.pack_version = child.pack_version AND definition.kind = child.kind
              AND definition.definition_id = child.definition_id)))
      END
        -- Campaign-attributable orphan evidence is independent of the roster
        -- root join. In particular, an authorized empty roster must not erase
        -- descendants left behind after a campaign-character row is deleted
        -- or moved to another campaign.
        + (SELECT COUNT(*) FROM rpg_character_classes child WHERE child.campaign_id = authorized.campaign_id
          AND NOT EXISTS (SELECT 1 FROM rpg_campaign_sheets parent
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
        + (SELECT COUNT(*) FROM rpg_character_attributes child WHERE child.campaign_id = authorized.campaign_id
          AND NOT EXISTS (SELECT 1 FROM rpg_campaign_sheets parent
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
        + (SELECT COUNT(*) FROM rpg_character_proficiencies child WHERE child.campaign_id = authorized.campaign_id
          AND NOT EXISTS (SELECT 1 FROM rpg_campaign_sheets parent
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
        + (SELECT COUNT(*) FROM rpg_character_choices child WHERE child.campaign_id = authorized.campaign_id
          AND NOT EXISTS (SELECT 1 FROM rpg_campaign_sheets parent
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
        + (SELECT COUNT(*) FROM campaign_actor_private_state child WHERE child.campaign_id = authorized.campaign_id
          AND NOT EXISTS (SELECT 1 FROM campaign_actors parent
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.actor_id))
        + (SELECT COUNT(*) FROM rpg_actor_resources child WHERE child.campaign_id = authorized.campaign_id
          AND NOT EXISTS (SELECT 1 FROM campaign_actors actor
            JOIN campaign_characters campaign_character
              ON campaign_character.campaign_id = actor.campaign_id
             AND campaign_character.id = actor.campaign_character_id
            WHERE actor.campaign_id = child.campaign_id AND actor.id = child.actor_id))
        + (SELECT COUNT(*) FROM campaign_characters child WHERE child.campaign_id = authorized.campaign_id
          AND NOT EXISTS (SELECT 1 FROM characters parent WHERE parent.id = child.character_id))
        + (SELECT COUNT(*) FROM rpg_campaign_sheets child WHERE child.campaign_id = authorized.campaign_id
          AND NOT EXISTS (SELECT 1 FROM campaign_characters parent
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.campaign_character_id))
        + (SELECT COUNT(*) FROM campaign_actors child WHERE child.campaign_id = authorized.campaign_id
          AND (NOT EXISTS (SELECT 1 FROM campaign_characters parent
              WHERE parent.campaign_id = child.campaign_id AND parent.id = child.campaign_character_id)
            OR NOT EXISTS (SELECT 1 FROM rpg_campaign_sheets parent
              WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id
                AND parent.campaign_character_id = child.campaign_character_id))) AS integrity_error_count
    FROM authorized
    LEFT JOIN campaign_memberships owner_membership
      ON owner_membership.campaign_id = authorized.campaign_id
     AND owner_membership.principal_id = authorized.owner_principal_id
     AND owner_membership.role = 'owner'
    LEFT JOIN principals owner_parent ON owner_parent.id = owner_membership.principal_id
    LEFT JOIN campaign_characters cc ON cc.campaign_id = authorized.campaign_id
    LEFT JOIN characters persona ON persona.id = cc.character_id
    LEFT JOIN rpg_campaign_sheets s
      ON s.campaign_character_id = cc.id AND s.campaign_id = cc.campaign_id
    LEFT JOIN campaign_actors a ON a.campaign_id = cc.campaign_id
      AND (a.campaign_character_id = cc.id OR a.sheet_id = s.id)
    LEFT JOIN campaign_actor_private_state ps
      ON ps.actor_id = a.id AND ps.campaign_id = a.campaign_id AND ps.campaign_id = cc.campaign_id
    ORDER BY cc.created_at ASC, cc.id COLLATE BINARY ASC
    LIMIT ${MAX_CAMPAIGN_CHARACTER_ROSTER + 1}`).all({ actorId, campaignId: id }) as CampaignCharacterRosterRow[];
      if (rows.length === 0) return null;

      try {
        const first = rows[0]!;
        const authorization = campaignMembershipReadSchema.parse({
          campaignId: first.requesting_campaign_id,
          principalId: first.requesting_principal_id,
          role: first.requesting_role,
          createdAt: first.requesting_created_at,
        });
        const owner = campaignMembershipReadSchema.parse({
          campaignId: first.owner_membership_campaign_id,
          principalId: first.owner_membership_principal_id,
          role: first.owner_membership_role,
          createdAt: first.owner_membership_created_at,
        });
        if (authorization.campaignId !== id || authorization.principalId !== actorId
          || !["owner", "gm", "player", "observer"].includes(authorization.role)
          || first.campaign_owner_role !== "owner" || first.owner_role_count !== 1
          || first.exact_owner_count !== 1 || first.owner_parent_id !== owner.principalId
          || owner.campaignId !== id || owner.principalId !== first.campaign_owner_principal_id
          || owner.role !== "owner"
          || !Number.isSafeInteger(first.roster_count) || first.roster_count < 0
          || first.roster_count > MAX_CAMPAIGN_CHARACTER_ROSTER) malformedCampaignCharacterRoster();

        if (first.roster_count === 0) {
          if (rows.length !== 1 || first.campaign_character_id !== null
            || first.character_id !== null || first.persona_name !== null
            || first.integrity_error_count !== 0) malformedCampaignCharacterRoster();
          return { campaignId: id, characters: [] };
        }
        if (rows.length !== first.roster_count) malformedCampaignCharacterRoster();

        const ids = new Set<string>();
        const personaIds = new Set<string>();
        const characters = rows.map((row) => {
          if (row.requesting_campaign_id !== first.requesting_campaign_id
            || row.requesting_principal_id !== first.requesting_principal_id
            || row.requesting_role !== first.requesting_role
            || row.requesting_created_at !== first.requesting_created_at
            || row.campaign_owner_principal_id !== first.campaign_owner_principal_id
            || row.campaign_owner_role !== first.campaign_owner_role
            || row.owner_role_count !== first.owner_role_count
            || row.exact_owner_count !== first.exact_owner_count
            || row.owner_membership_campaign_id !== first.owner_membership_campaign_id
            || row.owner_membership_principal_id !== first.owner_membership_principal_id
            || row.owner_membership_role !== first.owner_membership_role
            || row.owner_membership_created_at !== first.owner_membership_created_at
            || row.owner_parent_id !== first.owner_parent_id
            || row.roster_count !== first.roster_count || row.integrity_error_count !== 0
            || row.campaign_character_id === null || row.character_id === null || row.persona_name === null
            || ids.has(row.campaign_character_id) || personaIds.has(row.character_id)) {
            return malformedCampaignCharacterRoster();
          }
          ids.add(row.campaign_character_id);
          personaIds.add(row.character_id);
          return publicCampaignCharacterSummarySchema.parse({
            id: row.campaign_character_id,
            characterId: row.character_id,
            name: projectLegacyPersonaDisplayName(row.persona_name),
          });
        });
        return { campaignId: id, characters };
      } catch (error) {
        if (error instanceof Error && error.message === "campaign character roster is malformed") throw error;
        return malformedCampaignCharacterRoster();
      }
    },
  };
}
