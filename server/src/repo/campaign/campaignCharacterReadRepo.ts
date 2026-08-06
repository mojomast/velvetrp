// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { campaignCharacterReadSchema, campaignMembershipReadSchema, resourceIdSchema } from "@velvet/contracts";
import type { CampaignCharacterRead } from "../../types.js";

interface CampaignCharacterReadRow {
  requesting_campaign_id: string;
  requesting_principal_id: string;
  requesting_role: string;
  requesting_created_at: string;
  access: "public" | "privileged";
  campaign_character_id: string | null;
  campaign_id: string | null;
  character_id: string | null;
  campaign_character_created_at: string | null;
  campaign_character_updated_at: string | null;
  legacy_character_presence: string | null;
  sheet_presence: string | null;
  sheet_id: string | null;
  race_pack_id: string | null;
  race_pack_version: string | null;
  race_kind: string | null;
  race_definition_id: string | null;
  background_pack_id: string | null;
  background_pack_version: string | null;
  background_kind: string | null;
  background_definition_id: string | null;
  sheet_created_at: string | null;
  sheet_updated_at: string | null;
  classes: string;
  attributes: string;
  proficiencies: string;
  choices: string;
  actor_presence: string | null;
  actor_id: string | null;
  actor_sheet_id: string | null;
  actor_kind: string | null;
  actor_control: string | null;
  actor_created_at: string | null;
  actor_updated_at: string | null;
  private_state_presence: string | null;
  controller_principal_id: string | null;
  private_notes: string | null;
  integrity_error_count: number;
}

const CAMPAIGN_CHARACTER_READ_COLUMNS = `
  cm.campaign_id AS requesting_campaign_id,
  cm.principal_id AS requesting_principal_id,
  cm.role AS requesting_role,
  cm.created_at AS requesting_created_at,
  CASE
    WHEN cm.role IN ('owner', 'gm') THEN 'privileged'
    WHEN cm.role = 'player' AND ps.controller_principal_id = ? THEN 'privileged'
    ELSE 'public'
  END AS access,
  cc.id AS campaign_character_id, cc.campaign_id, cc.character_id,
  cc.created_at AS campaign_character_created_at, cc.updated_at AS campaign_character_updated_at,
  legacy_character.id AS legacy_character_presence,
  s.id AS sheet_presence, s.id AS sheet_id,
  s.race_pack_id, s.race_pack_version, s.race_kind, s.race_definition_id,
  s.background_pack_id, s.background_pack_version, s.background_kind, s.background_definition_id,
  s.created_at AS sheet_created_at, s.updated_at AS sheet_updated_at,
  COALESCE((SELECT json_group_array(json(entry)) FROM (
    SELECT json_object(
      'class', json_object('packId', cl.pack_id, 'packVersion', cl.pack_version,
        'kind', cl.kind, 'definitionId', cl.definition_id),
      'level', cl.level
    ) AS entry
    FROM rpg_character_classes cl
    WHERE cl.campaign_id = cc.campaign_id AND cl.sheet_id = s.id
    ORDER BY cl.position ASC
  )), '[]') AS classes,
  COALESCE((SELECT json_group_array(json(entry)) FROM (
    SELECT json_object('attributeId', at.attribute_id, 'value', at.value) AS entry
    FROM rpg_character_attributes at
    WHERE at.campaign_id = cc.campaign_id AND at.sheet_id = s.id
    ORDER BY at.position ASC
  )), '[]') AS attributes,
  COALESCE((SELECT json_group_array(json(entry)) FROM (
    SELECT json_object('category', pr.category, 'proficiencyId', pr.proficiency_id) AS entry
    FROM rpg_character_proficiencies pr
    WHERE pr.campaign_id = cc.campaign_id AND pr.sheet_id = s.id
    ORDER BY pr.position ASC
  )), '[]') AS proficiencies,
  COALESCE((SELECT json_group_array(json(entry)) FROM (
    SELECT json_object(
      'choiceId', ch.choice_id,
      'selection', json_object('packId', ch.pack_id, 'packVersion', ch.pack_version,
        'kind', ch.kind, 'definitionId', ch.definition_id)
    ) AS entry
    FROM rpg_character_choices ch
    WHERE ch.campaign_id = cc.campaign_id AND ch.sheet_id = s.id
    ORDER BY ch.position ASC
  )), '[]') AS choices,
  a.id AS actor_presence, a.id AS actor_id, a.sheet_id AS actor_sheet_id,
  a.kind AS actor_kind, a.control AS actor_control,
  a.created_at AS actor_created_at, a.updated_at AS actor_updated_at,
  ps.actor_id AS private_state_presence,
  CASE
    WHEN cm.role IN ('owner', 'gm') OR (cm.role = 'player' AND ps.controller_principal_id = ?)
      THEN ps.controller_principal_id
    ELSE NULL
  END AS controller_principal_id,
  CASE
    WHEN cm.role IN ('owner', 'gm') OR (cm.role = 'player' AND ps.controller_principal_id = ?)
      THEN ps.private_notes
    ELSE NULL
  END AS private_notes,
  ((cc.id IS NOT NULL AND legacy_character.id IS NULL)
    + (cc.id IS NOT NULL AND (s.id IS NULL OR s.campaign_id IS NOT cc.campaign_id
      OR s.campaign_character_id IS NOT cc.id))
    + (cc.id IS NOT NULL AND (a.id IS NULL OR a.campaign_id IS NOT cc.campaign_id
      OR a.campaign_character_id IS NOT cc.id OR a.sheet_id IS NOT s.id))
    + (a.id IS NOT NULL AND (ps.actor_id IS NULL OR ps.campaign_id IS NOT a.campaign_id))
    + (ps.actor_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM principals controller_principal
      JOIN campaign_memberships controller_membership
        ON controller_membership.principal_id = controller_principal.id
       AND controller_membership.campaign_id = ps.campaign_id
      WHERE controller_principal.id = ps.controller_principal_id
        AND (controller_membership.role IN ('gm', 'player') OR
          (controller_membership.role = 'owner'
            AND campaign.owner_principal_id = controller_membership.principal_id))))
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
    + (SELECT COUNT(*) FROM rpg_character_classes child WHERE child.campaign_id = campaign.id
      AND NOT EXISTS (SELECT 1 FROM rpg_campaign_sheets parent
        WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
    + (SELECT COUNT(*) FROM rpg_character_attributes child WHERE child.campaign_id = campaign.id
      AND NOT EXISTS (SELECT 1 FROM rpg_campaign_sheets parent
        WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
    + (SELECT COUNT(*) FROM rpg_character_proficiencies child WHERE child.campaign_id = campaign.id
      AND NOT EXISTS (SELECT 1 FROM rpg_campaign_sheets parent
        WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
    + (SELECT COUNT(*) FROM rpg_character_choices child WHERE child.campaign_id = campaign.id
      AND NOT EXISTS (SELECT 1 FROM rpg_campaign_sheets parent
        WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
    + (SELECT COUNT(*) FROM campaign_actor_private_state child WHERE child.campaign_id = campaign.id
      AND NOT EXISTS (SELECT 1 FROM campaign_actors parent
        WHERE parent.campaign_id = child.campaign_id AND parent.id = child.actor_id))
    + (SELECT COUNT(*) FROM campaign_characters child WHERE child.campaign_id = campaign.id
      AND NOT EXISTS (SELECT 1 FROM characters parent WHERE parent.id = child.character_id))
    + (SELECT COUNT(*) FROM rpg_campaign_sheets child WHERE child.campaign_id = campaign.id
      AND NOT EXISTS (SELECT 1 FROM campaign_characters parent
        WHERE parent.campaign_id = child.campaign_id AND parent.id = child.campaign_character_id))
    + (SELECT COUNT(*) FROM campaign_actors child WHERE child.campaign_id = campaign.id
      AND (NOT EXISTS (SELECT 1 FROM campaign_characters parent
          WHERE parent.campaign_id = child.campaign_id AND parent.id = child.campaign_character_id)
        OR NOT EXISTS (SELECT 1 FROM rpg_campaign_sheets parent
          WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id
            AND parent.campaign_character_id = child.campaign_character_id)))) AS integrity_error_count`;

const CAMPAIGN_CHARACTER_AUTHORIZATION = `
FROM campaign_memberships cm
JOIN principals requesting_principal ON requesting_principal.id = cm.principal_id
JOIN campaigns campaign ON campaign.id = cm.campaign_id`;

const CAMPAIGN_CHARACTER_AGGREGATE_JOINS = `
LEFT JOIN characters legacy_character ON legacy_character.id = cc.character_id
LEFT JOIN rpg_campaign_sheets s
  ON s.campaign_character_id = cc.id AND s.campaign_id = cc.campaign_id
LEFT JOIN campaign_actors a
  ON a.campaign_id = cc.campaign_id
    AND (a.campaign_character_id = cc.id OR a.sheet_id = s.id)
LEFT JOIN campaign_actor_private_state ps
  ON ps.actor_id = a.id AND ps.campaign_id = a.campaign_id
    AND ps.campaign_id = cc.campaign_id`;

const CAMPAIGN_CHARACTER_AUTHORIZATION_WHERE = `
WHERE cm.principal_id = ? AND cm.campaign_id = ?
  AND (cm.role IN ('gm', 'player', 'observer') OR
    (cm.role = 'owner' AND campaign.owner_principal_id = cm.principal_id))`;

const CAMPAIGN_CHARACTER_READ_SELECT = `SELECT${CAMPAIGN_CHARACTER_READ_COLUMNS}
${CAMPAIGN_CHARACTER_AUTHORIZATION}
JOIN campaign_characters cc ON cc.campaign_id = campaign.id
${CAMPAIGN_CHARACTER_AGGREGATE_JOINS}
${CAMPAIGN_CHARACTER_AUTHORIZATION_WHERE}`;

// The target identity includes a same-campaign actor or private state that is
// orphaned from its same-campaign actor. This keeps genuine absence nullable,
// while making private-state corruption attributable to authorized members.
const CAMPAIGN_CHARACTER_BY_ACTOR_READ_SELECT = `SELECT${CAMPAIGN_CHARACTER_READ_COLUMNS}
${CAMPAIGN_CHARACTER_AUTHORIZATION}
LEFT JOIN (
  SELECT actor.campaign_id, actor.id AS actor_id
    FROM campaign_actors actor WHERE actor.campaign_id = ? AND actor.id = ?
  UNION
  SELECT private_state.campaign_id, private_state.actor_id
    FROM campaign_actor_private_state private_state
    WHERE private_state.campaign_id = ? AND private_state.actor_id = ?
      AND NOT EXISTS (SELECT 1 FROM campaign_actors known_actor
        WHERE known_actor.campaign_id = private_state.campaign_id
          AND known_actor.id = private_state.actor_id)
) actor_identity ON actor_identity.campaign_id = campaign.id
LEFT JOIN campaign_actors a
  ON a.id = actor_identity.actor_id AND a.campaign_id = actor_identity.campaign_id
LEFT JOIN campaign_characters cc
  ON cc.id = a.campaign_character_id AND cc.campaign_id = a.campaign_id
LEFT JOIN characters legacy_character ON legacy_character.id = cc.character_id
LEFT JOIN rpg_campaign_sheets s ON s.id = a.sheet_id AND s.campaign_id = a.campaign_id
LEFT JOIN campaign_actor_private_state ps
  ON ps.actor_id = actor_identity.actor_id AND ps.campaign_id = actor_identity.campaign_id
    AND ps.campaign_id = campaign.id
${CAMPAIGN_CHARACTER_AUTHORIZATION_WHERE}`;

function toCampaignCharacterRead(row: CampaignCharacterReadRow): CampaignCharacterRead {
  campaignMembershipReadSchema.parse({
    campaignId: row.requesting_campaign_id,
    principalId: row.requesting_principal_id,
    role: row.requesting_role,
    createdAt: row.requesting_created_at,
  });
  if (!row.campaign_character_id || !row.legacy_character_presence || !row.sheet_presence
      || !row.actor_presence || !row.private_state_presence || row.integrity_error_count !== 0) {
    throw new Error("campaign character aggregate is incomplete");
  }
  const actor = {
    id: row.actor_id,
    campaignId: row.campaign_id,
    campaignCharacterId: row.campaign_character_id,
    sheetId: row.actor_sheet_id,
    kind: row.actor_kind,
    control: row.actor_control,
    createdAt: row.actor_created_at,
    updatedAt: row.actor_updated_at,
    ...(row.access === "privileged" ? {
      controllerPrincipalId: row.controller_principal_id,
      privateNotes: row.private_notes,
    } : {}),
  };
  return campaignCharacterReadSchema.parse({
    access: row.access,
    projection: {
      campaignCharacter: {
        id: row.campaign_character_id,
        campaignId: row.campaign_id,
        characterId: row.character_id,
        createdAt: row.campaign_character_created_at,
        updatedAt: row.campaign_character_updated_at,
      },
      sheet: {
        id: row.sheet_id,
        campaignId: row.campaign_id,
        campaignCharacterId: row.campaign_character_id,
        race: {
          packId: row.race_pack_id, packVersion: row.race_pack_version,
          kind: row.race_kind, definitionId: row.race_definition_id,
        },
        background: {
          packId: row.background_pack_id, packVersion: row.background_pack_version,
          kind: row.background_kind, definitionId: row.background_definition_id,
        },
        classes: JSON.parse(row.classes) as unknown,
        attributes: JSON.parse(row.attributes) as unknown,
        proficiencies: JSON.parse(row.proficiencies) as unknown,
        choices: JSON.parse(row.choices) as unknown,
        createdAt: row.sheet_created_at,
        updatedAt: row.sheet_updated_at,
      },
      actor,
    },
  });
}

function listCampaignCharactersSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignCharacterRead[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const rows = db.prepare(`${CAMPAIGN_CHARACTER_READ_SELECT}
    ORDER BY cc.created_at ASC, cc.id ASC`).all(actorId, actorId, actorId, actorId, id) as CampaignCharacterReadRow[];
  return rows.map(toCampaignCharacterRead);
}

function getCampaignCharacterSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  campaignCharacterId: string,
): CampaignCharacterRead | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const characterId = resourceIdSchema.parse(campaignCharacterId);
  const row = db.prepare(`${CAMPAIGN_CHARACTER_READ_SELECT}
    AND cc.id = ?`).get(actorId, actorId, actorId, actorId, id, characterId) as CampaignCharacterReadRow | undefined;
  return row ? toCampaignCharacterRead(row) : null;
}

function getCampaignCharacterByActorIdSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  actorId: string,
): CampaignCharacterRead | null {
  const requestingId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const targetActorId = resourceIdSchema.parse(actorId);
  const row = db.prepare(CAMPAIGN_CHARACTER_BY_ACTOR_READ_SELECT).get(
    requestingId,
    requestingId,
    requestingId,
    id,
    targetActorId,
    id,
    targetActorId,
    requestingId,
    id,
  ) as CampaignCharacterReadRow | undefined;
  if (!row || (row.actor_presence === null && row.private_state_presence === null)) return null;
  return toCampaignCharacterRead(row);
}

export function createCampaignCharacterReadOperations(db: DatabaseDriver.Database) {
  return {
    listCampaignCharacters: (actor: string, campaignId: string) => listCampaignCharactersSyncInternal(db, actor, campaignId),
    getCampaignCharacter: (actor: string, campaignId: string, campaignCharacterId: string) =>
      getCampaignCharacterSyncInternal(db, actor, campaignId, campaignCharacterId),
    getCampaignCharacterByActorId: (actor: string, campaignId: string, actorId: string) =>
      getCampaignCharacterByActorIdSyncInternal(db, actor, campaignId, actorId),
  };
}
