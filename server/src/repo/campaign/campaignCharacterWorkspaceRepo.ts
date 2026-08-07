// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import {
  actorResourceSchema,
  campaignCharacterAttributeSchema,
  campaignCharacterClassSchema,
  campaignCharacterProficiencySchema,
  campaignCharacterWorkspaceDescriptionSchema,
  campaignCharacterWorkspaceNameSchema,
  campaignCharacterWorkspaceResponseSchema,
  campaignCharacterSchema,
  campaignMembershipReadSchema,
  definitionReferenceSchema,
  MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES,
  MAX_CHARACTER_ATTRIBUTES,
  MAX_CHARACTER_CHOICES,
  MAX_CHARACTER_CLASSES,
  MAX_CHARACTER_PROFICIENCIES,
  publicCampaignActorSchema,
  resourceIdSchema,
  resolvedCharacterChoiceSchema,
  utcIsoTimestampSchema,
} from "@velvet/contracts";
import type { CampaignCharacterWorkspaceSnapshot } from "../campaignRepo.js";

interface CampaignCharacterWorkspaceRow {
  requesting_campaign_id: string;
  requesting_principal_id: string;
  requesting_role: string;
  requesting_created_at: string;
  campaign_owner_principal_id: string;
  campaign_owner_role: string;
  owner_role_count: unknown;
  exact_owner_count: unknown;
  owner_membership_campaign_id: string | null;
  owner_membership_principal_id: string | null;
  owner_membership_role: string | null;
  owner_membership_created_at: string | null;
  owner_parent_id: string | null;
  campaign_character_id: string | null;
  character_id: string | null;
  character_name: string | null;
  campaign_character_created_at: string | null;
  campaign_character_updated_at: string | null;
  sheet_id: string | null;
  sheet_campaign_id: string | null;
  sheet_campaign_character_id: string | null;
  sheet_created_at: string | null;
  sheet_updated_at: string | null;
  race_pack_id: string | null;
  race_pack_version: string | null;
  race_kind: string | null;
  race_definition_id: string | null;
  background_pack_id: string | null;
  background_pack_version: string | null;
  background_kind: string | null;
  background_definition_id: string | null;
  actor_id: string | null;
  actor_campaign_id: string | null;
  actor_campaign_character_id: string | null;
  actor_sheet_id: string | null;
  actor_kind: string | null;
  actor_control: string | null;
  actor_created_at: string | null;
  actor_updated_at: string | null;
  persona_count: unknown;
  sheet_count: unknown;
  actor_count: unknown;
  private_state_count: unknown;
  integrity_error_count: unknown;
  race_pin_count: unknown;
  background_pin_count: unknown;
  race_definition_count: unknown;
  background_definition_count: unknown;
  race_name: string | null;
  race_description: string | null;
  background_name: string | null;
  background_description: string | null;
  classes: string | null;
  attributes: string | null;
  proficiencies: string | null;
  choices: string | null;
  resources: string | null;
}

function malformedCampaignCharacterWorkspace(): never {
  throw new Error("campaign character workspace is malformed");
}

function parseWorkspaceJson(value: string | null): unknown[] {
  if (typeof value !== "string") return malformedCampaignCharacterWorkspace();
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return malformedCampaignCharacterWorkspace();
  return parsed;
}

const WORKSPACE_PROFICIENCY_PREFIX = {
  skill: "Skill proficiency",
  "saving-throw": "Saving throw proficiency",
  tool: "Tool proficiency",
  weapon: "Weapon proficiency",
  armor: "Armor proficiency",
  language: "Language proficiency",
} as const;

/**
 * One explicit-column statement owns authorization, ancestry evidence, content
 * resolution and every ordered workspace collection. Technical identities are
 * validated below but are replaced only with contract-defined positions.
 */
function getCampaignCharacterWorkspaceSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  campaignCharacterId: string,
): CampaignCharacterWorkspaceSnapshot | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const targetId = resourceIdSchema.parse(campaignCharacterId);
  let row: CampaignCharacterWorkspaceRow | undefined;
  try {
    row = db.prepare(`WITH authorized AS (
      SELECT membership.campaign_id, membership.principal_id, membership.role, membership.created_at,
        campaign.owner_principal_id, campaign.owner_role
      FROM campaign_memberships membership
      JOIN principals requesting_principal ON requesting_principal.id = membership.principal_id
      JOIN campaigns campaign ON campaign.id = membership.campaign_id
      WHERE membership.principal_id = $actorId AND membership.campaign_id = $campaignId
        AND (membership.role IN ('gm', 'player', 'observer') OR
          (membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id))
    ), target AS (
      SELECT cc.id, cc.campaign_id, cc.character_id, cc.created_at, cc.updated_at
      FROM campaign_characters cc
      WHERE cc.campaign_id = $campaignId AND cc.id = $campaignCharacterId
    )
    SELECT authorized.campaign_id AS requesting_campaign_id,
      authorized.principal_id AS requesting_principal_id,
      authorized.role AS requesting_role,
      authorized.created_at AS requesting_created_at,
      authorized.owner_principal_id AS campaign_owner_principal_id,
      authorized.owner_role AS campaign_owner_role,
      (SELECT COUNT(*) FROM campaign_memberships owner
        WHERE owner.campaign_id = authorized.campaign_id AND owner.role = 'owner') AS owner_role_count,
      (SELECT COUNT(*) FROM campaign_memberships owner
        JOIN principals parent ON parent.id = owner.principal_id
        WHERE owner.campaign_id = authorized.campaign_id AND owner.role = 'owner'
          AND owner.principal_id = authorized.owner_principal_id) AS exact_owner_count,
      owner_membership.campaign_id AS owner_membership_campaign_id,
      owner_membership.principal_id AS owner_membership_principal_id,
      owner_membership.role AS owner_membership_role,
      owner_membership.created_at AS owner_membership_created_at,
      owner_parent.id AS owner_parent_id,
      target.id AS campaign_character_id, target.character_id,
      persona.name AS character_name,
      target.created_at AS campaign_character_created_at,
      target.updated_at AS campaign_character_updated_at,
      sheet.id AS sheet_id, sheet.campaign_id AS sheet_campaign_id,
      sheet.campaign_character_id AS sheet_campaign_character_id,
      sheet.created_at AS sheet_created_at, sheet.updated_at AS sheet_updated_at,
      sheet.race_pack_id, sheet.race_pack_version, sheet.race_kind, sheet.race_definition_id,
      sheet.background_pack_id, sheet.background_pack_version, sheet.background_kind,
      sheet.background_definition_id,
      actor.id AS actor_id, actor.campaign_id AS actor_campaign_id,
      actor.campaign_character_id AS actor_campaign_character_id,
      actor.sheet_id AS actor_sheet_id, actor.kind AS actor_kind, actor.control AS actor_control,
      actor.created_at AS actor_created_at, actor.updated_at AS actor_updated_at,
      (SELECT COUNT(*) FROM characters candidate
        WHERE candidate.id = target.character_id) AS persona_count,
      (SELECT COUNT(*) FROM rpg_campaign_sheets candidate
        WHERE candidate.campaign_character_id = target.id) AS sheet_count,
      (SELECT COUNT(*) FROM campaign_actors candidate
        WHERE candidate.campaign_character_id = target.id OR candidate.sheet_id = sheet.id) AS actor_count,
      -- Private state contributes ancestry evidence only. No controller or note
      -- payload is selected by this workspace statement.
      (SELECT COUNT(*) FROM campaign_actor_private_state candidate
        WHERE candidate.actor_id = actor.id AND candidate.campaign_id = actor.campaign_id) AS private_state_count,
      (
        -- Campaign-attributable descendants must retain their complete root
        -- chain even when they are detached from the selected, otherwise-valid
        -- aggregate. Evidence in another campaign is intentionally irrelevant.
        (SELECT COUNT(*) FROM campaign_characters child
          WHERE child.campaign_id = authorized.campaign_id
            AND NOT EXISTS (SELECT 1 FROM characters parent WHERE parent.id = child.character_id))
        + (SELECT COUNT(*) FROM rpg_campaign_sheets child
          WHERE child.campaign_id = authorized.campaign_id
            AND NOT EXISTS (SELECT 1 FROM campaign_characters root
              WHERE root.campaign_id = child.campaign_id AND root.id = child.campaign_character_id))
        + (SELECT COUNT(*) FROM campaign_actors child
          WHERE child.campaign_id = authorized.campaign_id AND NOT EXISTS (
            SELECT 1 FROM campaign_characters root
            JOIN rpg_campaign_sheets parent
              ON parent.campaign_id = root.campaign_id AND parent.id = child.sheet_id
             AND parent.campaign_character_id = root.id
            WHERE root.campaign_id = child.campaign_id AND root.id = child.campaign_character_id))
        + (SELECT COUNT(*) FROM campaign_actor_private_state child
          WHERE child.campaign_id = authorized.campaign_id AND (
            NOT EXISTS (
              SELECT 1 FROM campaign_actors parent
              JOIN campaign_characters root
                ON root.campaign_id = parent.campaign_id AND root.id = parent.campaign_character_id
              JOIN rpg_campaign_sheets sheet_parent
                ON sheet_parent.campaign_id = parent.campaign_id AND sheet_parent.id = parent.sheet_id
               AND sheet_parent.campaign_character_id = root.id
              WHERE parent.campaign_id = child.campaign_id AND parent.id = child.actor_id)
            OR (SELECT COUNT(*) FROM campaign_memberships controller_membership
              JOIN principals controller_parent
                ON controller_parent.id = controller_membership.principal_id
              WHERE controller_membership.campaign_id = child.campaign_id
                AND controller_membership.principal_id = child.controller_principal_id
                AND typeof(controller_membership.role) = 'text'
                AND controller_membership.role IN ('owner', 'gm', 'player')
                AND typeof(controller_membership.created_at) = 'text'
                AND strftime('%Y-%m-%dT%H:%M:%fZ', controller_membership.created_at) IS NOT NULL
                AND controller_membership.created_at =
                  strftime('%Y-%m-%dT%H:%M:%fZ', controller_membership.created_at)
                AND substr(controller_membership.created_at, 12, 2) BETWEEN '00' AND '23') <> 1))
        + (SELECT COUNT(*) FROM rpg_character_classes child
          WHERE child.campaign_id = authorized.campaign_id AND NOT EXISTS (
            SELECT 1 FROM rpg_campaign_sheets parent
            JOIN campaign_characters root
              ON root.campaign_id = parent.campaign_id AND root.id = parent.campaign_character_id
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
        + (SELECT COUNT(*) FROM rpg_character_attributes child
          WHERE child.campaign_id = authorized.campaign_id AND NOT EXISTS (
            SELECT 1 FROM rpg_campaign_sheets parent
            JOIN campaign_characters root
              ON root.campaign_id = parent.campaign_id AND root.id = parent.campaign_character_id
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
        + (SELECT COUNT(*) FROM rpg_character_proficiencies child
          WHERE child.campaign_id = authorized.campaign_id AND NOT EXISTS (
            SELECT 1 FROM rpg_campaign_sheets parent
            JOIN campaign_characters root
              ON root.campaign_id = parent.campaign_id AND root.id = parent.campaign_character_id
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
        + (SELECT COUNT(*) FROM rpg_character_choices child
          WHERE child.campaign_id = authorized.campaign_id AND NOT EXISTS (
            SELECT 1 FROM rpg_campaign_sheets parent
            JOIN campaign_characters root
              ON root.campaign_id = parent.campaign_id AND root.id = parent.campaign_character_id
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.sheet_id))
        + (SELECT COUNT(*) FROM rpg_actor_resources child
          WHERE child.campaign_id = authorized.campaign_id AND NOT EXISTS (
            SELECT 1 FROM campaign_actors parent
            JOIN campaign_characters root
              ON root.campaign_id = parent.campaign_id AND root.id = parent.campaign_character_id
            JOIN rpg_campaign_sheets sheet_parent
              ON sheet_parent.campaign_id = parent.campaign_id AND sheet_parent.id = parent.sheet_id
             AND sheet_parent.campaign_character_id = root.id
            WHERE parent.campaign_id = child.campaign_id AND parent.id = child.actor_id))
      ) AS integrity_error_count,
      (SELECT COUNT(*) FROM campaign_content_packs pin
        JOIN rpg_content_packs pack ON pack.pack_id = pin.pack_id AND pack.pack_version = pin.pack_version
          AND pack.rules_profile_id = pin.rules_profile_id AND pack.sealed IS 1
        JOIN campaign_rules_profiles selection ON selection.campaign_id = pin.campaign_id
          AND selection.rules_profile_id = pin.rules_profile_id
        JOIN rpg_rules_profiles profile ON profile.rules_profile_id = selection.rules_profile_id
        WHERE pin.campaign_id = sheet.campaign_id AND pin.pack_id = sheet.race_pack_id
          AND pin.pack_version = sheet.race_pack_version) AS race_pin_count,
      (SELECT COUNT(*) FROM campaign_content_packs pin
        JOIN rpg_content_packs pack ON pack.pack_id = pin.pack_id AND pack.pack_version = pin.pack_version
          AND pack.rules_profile_id = pin.rules_profile_id AND pack.sealed IS 1
        JOIN campaign_rules_profiles selection ON selection.campaign_id = pin.campaign_id
          AND selection.rules_profile_id = pin.rules_profile_id
        JOIN rpg_rules_profiles profile ON profile.rules_profile_id = selection.rules_profile_id
        WHERE pin.campaign_id = sheet.campaign_id AND pin.pack_id = sheet.background_pack_id
          AND pin.pack_version = sheet.background_pack_version) AS background_pin_count,
      (SELECT COUNT(*) FROM rpg_definitions definition
        WHERE definition.pack_id = sheet.race_pack_id AND definition.pack_version = sheet.race_pack_version
          AND definition.kind = sheet.race_kind AND definition.definition_id = sheet.race_definition_id
          AND definition.kind = 'race'
          AND typeof(definition.name) = 'text' AND definition.name = trim(definition.name)
          AND length(definition.name) BETWEEN 1 AND 200
          AND typeof(definition.description) = 'text'
          AND definition.description = trim(definition.description)
          AND length(definition.description) BETWEEN 1 AND 4000
          AND json_valid(definition.tags) AND json_type(definition.tags) = 'array'
          AND json_array_length(definition.tags) <= 32
          AND NOT EXISTS (SELECT 1 FROM json_each(
            CASE WHEN json_valid(definition.tags) THEN definition.tags ELSE '[]' END) tag
            WHERE tag.type <> 'text' OR tag.value <> trim(tag.value)
              OR length(tag.value) NOT BETWEEN 1 AND 64
              OR tag.value GLOB '*[^A-Za-z0-9._:-]*')) AS race_definition_count,
      (SELECT COUNT(*) FROM rpg_definitions definition
        WHERE definition.pack_id = sheet.background_pack_id
          AND definition.pack_version = sheet.background_pack_version
          AND definition.kind = sheet.background_kind
          AND definition.definition_id = sheet.background_definition_id
          AND definition.kind = 'background'
          AND typeof(definition.name) = 'text' AND definition.name = trim(definition.name)
          AND length(definition.name) BETWEEN 1 AND 200
          AND typeof(definition.description) = 'text'
          AND definition.description = trim(definition.description)
          AND length(definition.description) BETWEEN 1 AND 4000
          AND json_valid(definition.tags) AND json_type(definition.tags) = 'array'
          AND json_array_length(definition.tags) <= 32
          AND NOT EXISTS (SELECT 1 FROM json_each(
            CASE WHEN json_valid(definition.tags) THEN definition.tags ELSE '[]' END) tag
            WHERE tag.type <> 'text' OR tag.value <> trim(tag.value)
              OR length(tag.value) NOT BETWEEN 1 AND 64
              OR tag.value GLOB '*[^A-Za-z0-9._:-]*')) AS background_definition_count,
      race_definition.name AS race_name, race_definition.description AS race_description,
      background_definition.name AS background_name,
      background_definition.description AS background_description,
      (SELECT json_group_array(json_object(
          'campaignId', item.campaign_id, 'sheetId', item.sheet_id, 'position', item.position,
          'packId', item.pack_id, 'packVersion', item.pack_version, 'kind', item.kind,
          'definitionId', item.definition_id, 'level', item.level,
          'name', item.name, 'description', item.description,
          'pinCount', item.pin_count, 'definitionCount', item.definition_count))
        FROM (SELECT child.campaign_id, child.sheet_id, child.position, child.pack_id,
            child.pack_version, child.kind, child.definition_id, child.level,
            definition.name, definition.description,
            (SELECT COUNT(*) FROM campaign_content_packs pin
              JOIN rpg_content_packs pack ON pack.pack_id = pin.pack_id
                AND pack.pack_version = pin.pack_version
                AND pack.rules_profile_id = pin.rules_profile_id AND pack.sealed IS 1
              JOIN campaign_rules_profiles selection ON selection.campaign_id = pin.campaign_id
                AND selection.rules_profile_id = pin.rules_profile_id
              JOIN rpg_rules_profiles profile ON profile.rules_profile_id = selection.rules_profile_id
              WHERE pin.campaign_id = child.campaign_id AND pin.pack_id = child.pack_id
                AND pin.pack_version = child.pack_version) AS pin_count,
            (SELECT COUNT(*) FROM rpg_definitions exact_definition
              WHERE exact_definition.pack_id = child.pack_id
                AND exact_definition.pack_version = child.pack_version
                AND exact_definition.kind = child.kind
                AND exact_definition.definition_id = child.definition_id
                AND exact_definition.kind = 'class'
                AND typeof(exact_definition.name) = 'text'
                AND exact_definition.name = trim(exact_definition.name)
                AND length(exact_definition.name) BETWEEN 1 AND 200
                AND typeof(exact_definition.description) = 'text'
                AND exact_definition.description = trim(exact_definition.description)
                AND length(exact_definition.description) BETWEEN 1 AND 4000
                AND json_valid(exact_definition.tags) AND json_type(exact_definition.tags) = 'array'
                AND json_array_length(exact_definition.tags) <= 32
                AND NOT EXISTS (SELECT 1 FROM json_each(
                  CASE WHEN json_valid(exact_definition.tags) THEN exact_definition.tags ELSE '[]' END) tag
                  WHERE tag.type <> 'text' OR tag.value <> trim(tag.value)
                    OR length(tag.value) NOT BETWEEN 1 AND 64
                    OR tag.value GLOB '*[^A-Za-z0-9._:-]*')) AS definition_count
          FROM rpg_character_classes child
          LEFT JOIN rpg_definitions definition ON definition.pack_id = child.pack_id
            AND definition.pack_version = child.pack_version AND definition.kind = child.kind
            AND definition.definition_id = child.definition_id
          WHERE child.sheet_id = sheet.id
          ORDER BY child.position ASC LIMIT ${MAX_CHARACTER_CLASSES + 1}) item) AS classes,
      (SELECT json_group_array(json_object('campaignId', item.campaign_id, 'sheetId', item.sheet_id,
          'position', item.position, 'attributeId', item.attribute_id, 'value', item.value))
        FROM (SELECT child.campaign_id, child.sheet_id, child.position, child.attribute_id, child.value
          FROM rpg_character_attributes child WHERE child.sheet_id = sheet.id
          ORDER BY child.position ASC LIMIT ${MAX_CHARACTER_ATTRIBUTES + 1}) item) AS attributes,
      (SELECT json_group_array(json_object('campaignId', item.campaign_id, 'sheetId', item.sheet_id,
          'position', item.position, 'category', item.category, 'proficiencyId', item.proficiency_id))
        FROM (SELECT child.campaign_id, child.sheet_id, child.position, child.category, child.proficiency_id
          FROM rpg_character_proficiencies child WHERE child.sheet_id = sheet.id
          ORDER BY child.position ASC LIMIT ${MAX_CHARACTER_PROFICIENCIES + 1}) item) AS proficiencies,
      (SELECT json_group_array(json_object('campaignId', item.campaign_id, 'sheetId', item.sheet_id,
          'position', item.position, 'choiceId', item.choice_id, 'packId', item.pack_id,
          'packVersion', item.pack_version, 'kind', item.kind, 'definitionId', item.definition_id,
          'name', item.name, 'description', item.description,
          'pinCount', item.pin_count, 'definitionCount', item.definition_count))
        FROM (SELECT child.campaign_id, child.sheet_id, child.position, child.choice_id,
            child.pack_id, child.pack_version, child.kind, child.definition_id,
            definition.name, definition.description,
            (SELECT COUNT(*) FROM campaign_content_packs pin
              JOIN rpg_content_packs pack ON pack.pack_id = pin.pack_id
                AND pack.pack_version = pin.pack_version
                AND pack.rules_profile_id = pin.rules_profile_id AND pack.sealed IS 1
              JOIN campaign_rules_profiles selection ON selection.campaign_id = pin.campaign_id
                AND selection.rules_profile_id = pin.rules_profile_id
              JOIN rpg_rules_profiles profile ON profile.rules_profile_id = selection.rules_profile_id
              WHERE pin.campaign_id = child.campaign_id AND pin.pack_id = child.pack_id
                AND pin.pack_version = child.pack_version) AS pin_count,
            (SELECT COUNT(*) FROM rpg_definitions exact_definition
              WHERE exact_definition.pack_id = child.pack_id
                AND exact_definition.pack_version = child.pack_version
                AND exact_definition.kind = child.kind
                AND exact_definition.definition_id = child.definition_id
                AND typeof(exact_definition.name) = 'text'
                AND exact_definition.name = trim(exact_definition.name)
                AND length(exact_definition.name) BETWEEN 1 AND 200
                AND typeof(exact_definition.description) = 'text'
                AND exact_definition.description = trim(exact_definition.description)
                AND length(exact_definition.description) BETWEEN 1 AND 4000
                AND json_valid(exact_definition.tags) AND json_type(exact_definition.tags) = 'array'
                AND json_array_length(exact_definition.tags) <= 32
                AND NOT EXISTS (SELECT 1 FROM json_each(
                  CASE WHEN json_valid(exact_definition.tags) THEN exact_definition.tags ELSE '[]' END) tag
                  WHERE tag.type <> 'text' OR tag.value <> trim(tag.value)
                    OR length(tag.value) NOT BETWEEN 1 AND 64
                    OR tag.value GLOB '*[^A-Za-z0-9._:-]*')) AS definition_count
          FROM rpg_character_choices child
          LEFT JOIN rpg_definitions definition ON definition.pack_id = child.pack_id
            AND definition.pack_version = child.pack_version AND definition.kind = child.kind
            AND definition.definition_id = child.definition_id
          WHERE child.sheet_id = sheet.id
          ORDER BY child.position ASC LIMIT ${MAX_CHARACTER_CHOICES + 1}) item) AS choices,
      (SELECT json_group_array(json_object('campaignId', item.campaign_id, 'actorId', item.actor_id,
          'name', item.name, 'current', item.current, 'max', item.max))
        FROM (SELECT resource.campaign_id, resource.actor_id, resource.name, resource.current, resource.max
          FROM rpg_actor_resources resource WHERE resource.actor_id = actor.id
          ORDER BY resource.name COLLATE BINARY ASC
          LIMIT ${MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES + 1}) item) AS resources
    FROM authorized
    LEFT JOIN campaign_memberships owner_membership
      ON owner_membership.campaign_id = authorized.campaign_id
      AND owner_membership.principal_id = authorized.owner_principal_id
      AND owner_membership.role = 'owner'
    LEFT JOIN principals owner_parent ON owner_parent.id = owner_membership.principal_id
    LEFT JOIN target ON target.campaign_id = authorized.campaign_id
    LEFT JOIN characters persona ON persona.id = target.character_id
    LEFT JOIN rpg_campaign_sheets sheet
      ON sheet.campaign_id = target.campaign_id AND sheet.campaign_character_id = target.id
    LEFT JOIN campaign_actors actor ON actor.campaign_id = target.campaign_id
      AND actor.campaign_character_id = target.id AND actor.sheet_id = sheet.id
    LEFT JOIN rpg_definitions race_definition
      ON race_definition.pack_id = sheet.race_pack_id
      AND race_definition.pack_version = sheet.race_pack_version
      AND race_definition.kind = sheet.race_kind
      AND race_definition.definition_id = sheet.race_definition_id
    LEFT JOIN rpg_definitions background_definition
      ON background_definition.pack_id = sheet.background_pack_id
      AND background_definition.pack_version = sheet.background_pack_version
      AND background_definition.kind = sheet.background_kind
      AND background_definition.definition_id = sheet.background_definition_id`).get({
      actorId,
      campaignId: id,
      campaignCharacterId: targetId,
    }) as CampaignCharacterWorkspaceRow | undefined;
  } catch {
    return malformedCampaignCharacterWorkspace();
  }

  if (!row) return null;
  try {
    const authorization = campaignMembershipReadSchema.parse({
      campaignId: row.requesting_campaign_id,
      principalId: row.requesting_principal_id,
      role: row.requesting_role,
      createdAt: row.requesting_created_at,
    });
    const owner = campaignMembershipReadSchema.parse({
      campaignId: row.owner_membership_campaign_id,
      principalId: row.owner_membership_principal_id,
      role: row.owner_membership_role,
      createdAt: row.owner_membership_created_at,
    });
    if (authorization.campaignId !== id || authorization.principalId !== actorId
      || row.campaign_owner_role !== "owner" || row.owner_role_count !== 1
      || row.exact_owner_count !== 1 || row.owner_parent_id !== owner.principalId
      || owner.campaignId !== id || owner.principalId !== row.campaign_owner_principal_id
      || owner.role !== "owner") malformedCampaignCharacterWorkspace();

    // Authorization and its exact-owner invariant are validated before target
    // absence, while a missing or other-campaign target remains non-disclosing.
    if (row.campaign_character_id === null) return null;
    if (row.campaign_character_id !== targetId || row.persona_count !== 1
      || row.sheet_count !== 1 || row.actor_count !== 1 || row.private_state_count !== 1
      || row.integrity_error_count !== 0
      || row.race_pin_count !== 1 || row.background_pin_count !== 1
      || row.race_definition_count !== 1 || row.background_definition_count !== 1) {
      return malformedCampaignCharacterWorkspace();
    }

    const campaignCharacter = campaignCharacterSchema.parse({
      id: row.campaign_character_id, campaignId: row.requesting_campaign_id,
      characterId: row.character_id, createdAt: row.campaign_character_created_at,
      updatedAt: row.campaign_character_updated_at,
    });
    const sheetId = resourceIdSchema.parse(row.sheet_id);
    const raceReference = definitionReferenceSchema.parse({
      packId: row.race_pack_id, packVersion: row.race_pack_version,
      kind: row.race_kind, definitionId: row.race_definition_id,
    });
    const backgroundReference = definitionReferenceSchema.parse({
      packId: row.background_pack_id, packVersion: row.background_pack_version,
      kind: row.background_kind, definitionId: row.background_definition_id,
    });
    const actorRecord = publicCampaignActorSchema.parse({
      id: row.actor_id, campaignId: row.actor_campaign_id,
      campaignCharacterId: row.actor_campaign_character_id, sheetId: row.actor_sheet_id,
      kind: row.actor_kind, control: row.actor_control,
      createdAt: row.actor_created_at, updatedAt: row.actor_updated_at,
    });
    if (row.sheet_campaign_id !== id || row.sheet_campaign_character_id !== targetId
      || actorRecord.campaignId !== id || actorRecord.campaignCharacterId !== targetId
      || actorRecord.sheetId !== sheetId) malformedCampaignCharacterWorkspace();
    const sheetCreatedAt = utcIsoTimestampSchema.parse(row.sheet_created_at);
    const sheetUpdatedAt = utcIsoTimestampSchema.parse(row.sheet_updated_at);
    if (raceReference.kind !== "race" || backgroundReference.kind !== "background"
      || campaignCharacter.updatedAt < campaignCharacter.createdAt
      || sheetUpdatedAt < sheetCreatedAt || actorRecord.updatedAt < actorRecord.createdAt) {
      return malformedCampaignCharacterWorkspace();
    }

    const classesRaw = parseWorkspaceJson(row.classes);
    const attributesRaw = parseWorkspaceJson(row.attributes);
    const proficienciesRaw = parseWorkspaceJson(row.proficiencies);
    const choicesRaw = parseWorkspaceJson(row.choices);
    const resourcesRaw = parseWorkspaceJson(row.resources);
    if (classesRaw.length < 1 || classesRaw.length > MAX_CHARACTER_CLASSES
      || attributesRaw.length > MAX_CHARACTER_ATTRIBUTES
      || proficienciesRaw.length > MAX_CHARACTER_PROFICIENCIES
      || choicesRaw.length > MAX_CHARACTER_CHOICES
      || resourcesRaw.length > MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES) {
      return malformedCampaignCharacterWorkspace();
    }

    const positions = (entries: unknown[], maximum: number, project: (entry: Record<string, unknown>, index: number) => unknown) => {
      const seen = new Set<number>();
      return entries.map((unknownEntry, index) => {
        if (unknownEntry === null || typeof unknownEntry !== "object" || Array.isArray(unknownEntry)) {
          return malformedCampaignCharacterWorkspace();
        }
        const entry = unknownEntry as Record<string, unknown>;
        if (!Number.isSafeInteger(entry.position) || (entry.position as number) < 0
          || (entry.position as number) >= maximum || seen.has(entry.position as number)
          || entry.campaignId !== id || entry.sheetId !== sheetId) {
          return malformedCampaignCharacterWorkspace();
        }
        seen.add(entry.position as number);
        return project(entry, index);
      });
    };

    const classReferences = new Set<string>();
    const classes = positions(classesRaw, MAX_CHARACTER_CLASSES, (entry) => {
      if (entry.pinCount !== 1 || entry.definitionCount !== 1) return malformedCampaignCharacterWorkspace();
      const value = campaignCharacterClassSchema.parse({
        class: { packId: entry.packId, packVersion: entry.packVersion,
          kind: entry.kind, definitionId: entry.definitionId }, level: entry.level,
      });
      const key = `${value.class.packId}\u0000${value.class.packVersion}\u0000${value.class.definitionId}`;
      if (classReferences.has(key)) return malformedCampaignCharacterWorkspace();
      classReferences.add(key);
      return { name: campaignCharacterWorkspaceNameSchema.parse(entry.name),
        description: campaignCharacterWorkspaceDescriptionSchema.parse(entry.description), level: entry.level };
    });
    const attributeIds = new Set<string>();
    const attributes = positions(attributesRaw, MAX_CHARACTER_ATTRIBUTES, (entry, index) => {
      const value = campaignCharacterAttributeSchema.parse({ attributeId: entry.attributeId, value: entry.value });
      if (attributeIds.has(value.attributeId)) return malformedCampaignCharacterWorkspace();
      attributeIds.add(value.attributeId);
      return { label: `Attribute ${index + 1}`, value: value.value };
    });
    const proficiencyIds = new Set<string>();
    const proficiencies = positions(proficienciesRaw, MAX_CHARACTER_PROFICIENCIES, (entry, index) => {
      const value = campaignCharacterProficiencySchema.parse({ category: entry.category,
        proficiencyId: entry.proficiencyId });
      const key = `${value.category}\u0000${value.proficiencyId}`;
      if (proficiencyIds.has(key)) return malformedCampaignCharacterWorkspace();
      proficiencyIds.add(key);
      return { category: value.category,
        label: `${WORKSPACE_PROFICIENCY_PREFIX[value.category]} ${index + 1}` };
    });
    const choiceIds = new Set<string>();
    const choices = positions(choicesRaw, MAX_CHARACTER_CHOICES, (entry, index) => {
      if (entry.pinCount !== 1 || entry.definitionCount !== 1) return malformedCampaignCharacterWorkspace();
      const value = resolvedCharacterChoiceSchema.parse({ choiceId: entry.choiceId,
        selection: { packId: entry.packId, packVersion: entry.packVersion,
          kind: entry.kind, definitionId: entry.definitionId } });
      if (choiceIds.has(value.choiceId)) return malformedCampaignCharacterWorkspace();
      choiceIds.add(value.choiceId);
      return { label: `Choice ${index + 1}`, selection: { kind: value.selection.kind,
        name: campaignCharacterWorkspaceNameSchema.parse(entry.name),
        description: campaignCharacterWorkspaceDescriptionSchema.parse(entry.description) } };
    });
    const seenResources = new Set<string>();
    const resources = resourcesRaw.map((unknownEntry, index) => {
      if (unknownEntry === null || typeof unknownEntry !== "object" || Array.isArray(unknownEntry)) {
        return malformedCampaignCharacterWorkspace();
      }
      const entry = unknownEntry as Record<string, unknown>;
      const resource = actorResourceSchema.parse({ campaignId: entry.campaignId,
        actorId: entry.actorId, name: entry.name, current: entry.current, max: entry.max });
      if (resource.campaignId !== id || resource.actorId !== actorRecord.id
        || seenResources.has(resource.name)) return malformedCampaignCharacterWorkspace();
      seenResources.add(resource.name);
      return { label: `Resource ${index + 1}`, current: resource.current, max: resource.max };
    });

    const response = campaignCharacterWorkspaceResponseSchema.parse({ character: {
      name: campaignCharacterWorkspaceNameSchema.parse(row.character_name),
      race: { name: row.race_name, description: row.race_description },
      background: { name: row.background_name, description: row.background_description },
      classes, attributes, proficiencies, choices, resources,
    } });
    if (campaignCharacter.campaignId !== id || campaignCharacter.id !== targetId) {
      return malformedCampaignCharacterWorkspace();
    }
    return { campaignId: id, campaignCharacterId: targetId, character: response.character };
  } catch (error) {
    if (error instanceof Error && error.message === "campaign character workspace is malformed") throw error;
    return malformedCampaignCharacterWorkspace();
  }
}

export function createCampaignCharacterWorkspaceRepository(db: DatabaseDriver.Database) {
  return {
    getCampaignCharacterWorkspace: (
      actorPrincipalId: string,
      campaignId: string,
      campaignCharacterId: string,
    ) => getCampaignCharacterWorkspaceSyncInternal(
      db, actorPrincipalId, campaignId, campaignCharacterId,
    ),
  };
}
