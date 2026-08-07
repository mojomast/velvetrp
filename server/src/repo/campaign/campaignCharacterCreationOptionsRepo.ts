// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { projectLegacyPersonaDisplayName } from "./legacyPersonaDisplayName.js";
import {
  campaignCharacterCreationOptionsResponseSchema,
  campaignCharacterPersonaSummarySchema,
  campaignCharacterSchema,
  campaignMembershipReadSchema,
  campaignSchema,
  campaignTimelineSchema,
  MAX_CAMPAIGN_CHARACTER_PERSONAS,
  MAX_CAMPAIGN_CONTENT_PACKS,
  resourceIdSchema,
  utcIsoTimestampSchema,
} from "@velvet/contracts";
import { ORIGINAL_STARTER_MANIFEST } from "../../content/originalStarterManifest.js";
import type { CampaignCharacterCreationOptionsResponse } from "../../types.js";
import {
  sameMetadata,
  toContentPack,
  toRpgDefinition,
  toRulesProfile,
} from "./campaignContentRowMappers.js";

interface CampaignCharacterCreationOptionsRow {
  actor_campaign_id: unknown;
  actor_principal_id: unknown;
  actor_role: unknown;
  actor_created_at: unknown;
  campaign_id: unknown;
  campaign_name: unknown;
  active_timeline_id: unknown;
  owner_principal_id: unknown;
  campaign_owner_role: unknown;
  campaign_created_at: unknown;
  campaign_updated_at: unknown;
  owner_role_count: number;
  exact_owner_count: number;
  owner_membership_campaign_id: unknown;
  owner_membership_principal_id: unknown;
  owner_membership_role: unknown;
  owner_membership_created_at: unknown;
  active_timeline_count: number;
  active_timeline_revision: unknown;
  active_timeline_created_at: unknown;
  selected_count: number;
  selected_rules_profile_id: string | null;
  profile_rules_profile_id: string | null;
  profile_name: string | null;
  profile_description: string | null;
  profile_tags: string | null;
  pin_count: number;
  pins_json: string;
  reserved_definition_count: number;
  reserved_definitions_json: string;
  persona_count: number;
  persona_id: string | null;
  persona_name: string | null;
  persona_created_at: string | null;
  persona_fictional_confirmed: number | null;
  persona_is_real_person: number | null;
  already_used: number | null;
  campaign_link_count: number;
  campaign_links_json: string;
}

interface CreationOptionsPinRow {
  campaignId: unknown;
  packId: unknown;
  packVersion: unknown;
  pinRulesProfileId: unknown;
  storedPackId: unknown;
  storedPackVersion: unknown;
  packRulesProfileId: unknown;
  name: unknown;
  description: unknown;
  tags: unknown;
  sealed: unknown;
}

interface CreationOptionsLinkRow {
  id: unknown;
  campaignId: unknown;
  characterId: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface CreationOptionsDefinitionRow {
  packId: unknown;
  packVersion: unknown;
  kind: unknown;
  definitionId: unknown;
  name: unknown;
  description: unknown;
  tags: unknown;
}

function malformedCampaignCharacterCreationOptions(): never {
  throw new Error("campaign character creation options are malformed");
}

/**
 * Reconstructs authority, configuration, persona availability, and current
 * campaign links from one statement. Keeping this as a single statement is
 * intentional: factory callers receive SQLite's implicit statement snapshot,
 * while active units of work receive their enclosing transaction snapshot.
 */
function getCampaignCharacterCreationOptionsSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignCharacterCreationOptionsResponse | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const starterRace = ORIGINAL_STARTER_MANIFEST.races[0]!;
  const starterBackground = ORIGINAL_STARTER_MANIFEST.backgrounds[0]!;
  const starterClass = ORIGINAL_STARTER_MANIFEST.classes[0]!;
  const expectedDefinitions = [
    ...ORIGINAL_STARTER_MANIFEST.classes, ...ORIGINAL_STARTER_MANIFEST.races,
    ...ORIGINAL_STARTER_MANIFEST.backgrounds, ...ORIGINAL_STARTER_MANIFEST.items,
    ...ORIGINAL_STARTER_MANIFEST.spells, ...ORIGINAL_STARTER_MANIFEST.abilities,
    ...ORIGINAL_STARTER_MANIFEST.enemies,
  ];
  const rows = db.prepare(`WITH authorized AS (
      SELECT membership.campaign_id AS actor_campaign_id,
        membership.principal_id AS actor_principal_id,
        membership.role AS actor_role,
        membership.created_at AS actor_created_at,
        campaign.id AS campaign_id,
        campaign.name AS campaign_name,
        campaign.active_timeline_id,
        campaign.owner_principal_id,
        campaign.owner_role AS campaign_owner_role,
        campaign.created_at AS campaign_created_at,
        campaign.updated_at AS campaign_updated_at
      FROM campaign_memberships membership
      JOIN principals actor_parent ON actor_parent.id = membership.principal_id
      JOIN campaigns campaign ON campaign.id = membership.campaign_id
      WHERE membership.principal_id = $actorId AND membership.campaign_id = $campaignId
        AND (membership.role = 'gm' OR (
          membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
        ))
    ), selected_state AS (
      SELECT COUNT(*) AS selected_count,
        MIN(selected.rules_profile_id) AS selected_rules_profile_id
      FROM campaign_rules_profiles selected WHERE selected.campaign_id = $campaignId
    ), pin_state AS (
      SELECT COUNT(*) AS pin_count FROM campaign_content_packs pin
      WHERE pin.campaign_id = $campaignId
    )
    SELECT
      authorized.actor_campaign_id,
      authorized.actor_principal_id,
      authorized.actor_role,
      authorized.actor_created_at,
      authorized.campaign_id,
      authorized.campaign_name,
      authorized.active_timeline_id,
      authorized.owner_principal_id,
      authorized.campaign_owner_role,
      authorized.campaign_created_at,
      authorized.campaign_updated_at,
      (SELECT COUNT(*) FROM campaign_memberships owner_membership
        WHERE owner_membership.campaign_id = authorized.campaign_id
          AND owner_membership.role = 'owner') AS owner_role_count,
      (SELECT COUNT(*) FROM campaign_memberships owner_membership
        JOIN principals owner_parent ON owner_parent.id = owner_membership.principal_id
        WHERE owner_membership.campaign_id = authorized.campaign_id
          AND owner_membership.role = 'owner'
          AND owner_membership.principal_id = authorized.owner_principal_id) AS exact_owner_count,
      (SELECT owner_membership.campaign_id FROM campaign_memberships owner_membership
        WHERE owner_membership.campaign_id = authorized.campaign_id
          AND owner_membership.role = 'owner' LIMIT 1) AS owner_membership_campaign_id,
      (SELECT owner_membership.principal_id FROM campaign_memberships owner_membership
        WHERE owner_membership.campaign_id = authorized.campaign_id
          AND owner_membership.role = 'owner' LIMIT 1) AS owner_membership_principal_id,
      (SELECT owner_membership.role FROM campaign_memberships owner_membership
        WHERE owner_membership.campaign_id = authorized.campaign_id
          AND owner_membership.role = 'owner' LIMIT 1) AS owner_membership_role,
      (SELECT owner_membership.created_at FROM campaign_memberships owner_membership
        WHERE owner_membership.campaign_id = authorized.campaign_id
          AND owner_membership.role = 'owner' LIMIT 1) AS owner_membership_created_at,
      (SELECT COUNT(*) FROM campaign_timelines active_timeline
        WHERE active_timeline.campaign_id = authorized.campaign_id
          AND active_timeline.id = authorized.active_timeline_id) AS active_timeline_count,
      (SELECT active_timeline.revision FROM campaign_timelines active_timeline
        WHERE active_timeline.campaign_id = authorized.campaign_id
          AND active_timeline.id = authorized.active_timeline_id) AS active_timeline_revision,
      (SELECT active_timeline.created_at FROM campaign_timelines active_timeline
        WHERE active_timeline.campaign_id = authorized.campaign_id
          AND active_timeline.id = authorized.active_timeline_id) AS active_timeline_created_at,
      selected_state.selected_count,
      selected_state.selected_rules_profile_id,
      profile.rules_profile_id AS profile_rules_profile_id,
      profile.name AS profile_name,
      profile.description AS profile_description,
      profile.tags AS profile_tags,
      pin_state.pin_count,
      (SELECT json_group_array(json_object(
          'campaignId', bounded_pin.campaign_id,
          'packId', bounded_pin.pin_pack_id,
          'packVersion', bounded_pin.pin_pack_version,
          'pinRulesProfileId', bounded_pin.pin_rules_profile_id,
          'storedPackId', bounded_pin.pack_id,
          'storedPackVersion', bounded_pin.pack_version,
          'packRulesProfileId', bounded_pin.pack_rules_profile_id,
          'name', bounded_pin.pack_name,
          'description', bounded_pin.pack_description,
          'tags', bounded_pin.pack_tags,
          'sealed', bounded_pin.pack_sealed
        )) FROM (
          SELECT pin.campaign_id, pin.pack_id AS pin_pack_id,
            pin.pack_version AS pin_pack_version,
            pin.rules_profile_id AS pin_rules_profile_id,
            pack.pack_id, pack.pack_version,
            pack.rules_profile_id AS pack_rules_profile_id,
            pack.name AS pack_name, pack.description AS pack_description,
            pack.tags AS pack_tags, pack.sealed AS pack_sealed
          FROM campaign_content_packs pin
          LEFT JOIN rpg_content_packs pack
            ON pack.pack_id = pin.pack_id AND pack.pack_version = pin.pack_version
          WHERE pin.campaign_id = authorized.campaign_id
          ORDER BY pin.pack_id COLLATE BINARY ASC, pin.pack_version COLLATE BINARY ASC
          LIMIT ${MAX_CAMPAIGN_CONTENT_PACKS + 1}
        ) bounded_pin) AS pins_json,
      (SELECT COUNT(*) FROM rpg_definitions definition
        WHERE definition.pack_id = $starterPackId
          OR definition.definition_id IN ($starterClassId, $starterRaceId, $starterBackgroundId)
      ) AS reserved_definition_count,
      (SELECT json_group_array(json_object(
          'packId', bounded_definition.pack_id,
          'packVersion', bounded_definition.pack_version,
          'kind', bounded_definition.kind,
          'definitionId', bounded_definition.definition_id,
          'name', bounded_definition.name,
          'description', bounded_definition.description,
          'tags', bounded_definition.tags
        )) FROM (
          SELECT definition.pack_id, definition.pack_version, definition.kind,
            definition.definition_id, definition.name, definition.description, definition.tags
          FROM rpg_definitions definition
          WHERE definition.pack_id = $starterPackId
            OR definition.definition_id IN ($starterClassId, $starterRaceId, $starterBackgroundId)
          ORDER BY definition.pack_id COLLATE BINARY ASC, definition.pack_version COLLATE BINARY ASC,
            definition.kind COLLATE BINARY ASC, definition.definition_id COLLATE BINARY ASC
          LIMIT ${expectedDefinitions.length + 1}
        ) bounded_definition) AS reserved_definitions_json,
      (SELECT COUNT(*) FROM characters) AS persona_count,
      persona.id AS persona_id,
      persona.name AS persona_name,
      persona.created_at AS persona_created_at,
      persona.fictional_confirmed AS persona_fictional_confirmed,
      persona.is_real_person AS persona_is_real_person,
      CASE WHEN persona.id IS NULL THEN NULL ELSE EXISTS (
        SELECT 1 FROM campaign_characters link
        WHERE link.campaign_id = authorized.campaign_id AND link.character_id = persona.id
      ) END AS already_used,
      (SELECT COUNT(*) FROM campaign_characters link
        WHERE link.campaign_id = authorized.campaign_id) AS campaign_link_count,
      (SELECT json_group_array(json_object(
          'id', bounded_link.id,
          'campaignId', bounded_link.campaign_id,
          'characterId', bounded_link.character_id,
          'createdAt', bounded_link.created_at,
          'updatedAt', bounded_link.updated_at
        )) FROM (
          SELECT link.id, link.campaign_id, link.character_id, link.created_at, link.updated_at
          FROM campaign_characters link
          WHERE link.campaign_id = authorized.campaign_id
          ORDER BY link.created_at ASC, link.id COLLATE BINARY ASC
          LIMIT ${MAX_CAMPAIGN_CHARACTER_PERSONAS + 1}
        ) bounded_link) AS campaign_links_json
    FROM authorized
    CROSS JOIN selected_state
    CROSS JOIN pin_state
    LEFT JOIN rpg_rules_profiles profile
      ON profile.rules_profile_id = selected_state.selected_rules_profile_id
    LEFT JOIN characters persona ON 1 = 1
    ORDER BY persona.created_at ASC, persona.id COLLATE BINARY ASC
    LIMIT ${MAX_CAMPAIGN_CHARACTER_PERSONAS + 1}`).all({
      actorId,
      campaignId: id,
      starterPackId: ORIGINAL_STARTER_MANIFEST.packId,
      starterPackVersion: ORIGINAL_STARTER_MANIFEST.packVersion,
      starterRaceId: starterRace.definitionId,
      starterBackgroundId: starterBackground.definitionId,
      starterClassId: starterClass.definitionId,
    }) as CampaignCharacterCreationOptionsRow[];
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
      || !["owner", "gm"].includes(authorization.role)) {
      malformedCampaignCharacterCreationOptions();
    }
    const campaign = campaignSchema.parse({
      id: first.campaign_id,
      name: first.campaign_name,
      activeTimelineId: first.active_timeline_id,
      ownerPrincipalId: first.owner_principal_id,
      createdAt: first.campaign_created_at,
      updatedAt: first.campaign_updated_at,
    });
    if (campaign.id !== id || first.owner_role_count !== 1 || first.exact_owner_count !== 1
      || first.active_timeline_count !== 1 || first.campaign_owner_role !== "owner") {
      malformedCampaignCharacterCreationOptions();
    }
    const ownerMembership = campaignMembershipReadSchema.parse({
      campaignId: first.owner_membership_campaign_id,
      principalId: first.owner_membership_principal_id,
      role: first.owner_membership_role,
      createdAt: first.owner_membership_created_at,
    });
    if (ownerMembership.campaignId !== id || ownerMembership.principalId !== campaign.ownerPrincipalId
      || ownerMembership.role !== "owner") malformedCampaignCharacterCreationOptions();
    const activeTimeline = campaignTimelineSchema.parse({
      id: campaign.activeTimelineId,
      campaignId: campaign.id,
      revision: first.active_timeline_revision,
      createdAt: first.active_timeline_created_at,
    });
    if (activeTimeline.id !== campaign.activeTimelineId || activeTimeline.campaignId !== id) {
      malformedCampaignCharacterCreationOptions();
    }
    if (rows.some((row) => row.actor_campaign_id !== first.actor_campaign_id
      || row.actor_principal_id !== first.actor_principal_id
      || row.actor_role !== first.actor_role
      || row.actor_created_at !== first.actor_created_at
      || row.campaign_id !== first.campaign_id
      || row.selected_count !== first.selected_count
      || row.selected_rules_profile_id !== first.selected_rules_profile_id
      || row.pin_count !== first.pin_count
      || row.persona_count !== first.persona_count
      || row.campaign_link_count !== first.campaign_link_count)) {
      malformedCampaignCharacterCreationOptions();
    }

    if (first.persona_count > MAX_CAMPAIGN_CHARACTER_PERSONAS
      || first.campaign_link_count > MAX_CAMPAIGN_CHARACTER_PERSONAS) {
      malformedCampaignCharacterCreationOptions();
    }
    const links = JSON.parse(first.campaign_links_json) as CreationOptionsLinkRow[];
    if (!Array.isArray(links) || links.length !== first.campaign_link_count) {
      malformedCampaignCharacterCreationOptions();
    }
    const linkedPersonas = new Set<string>();
    const linkIds = new Set<string>();
    for (const rawLink of links) {
      const link = campaignCharacterSchema.parse(rawLink);
      if (link.campaignId !== id || linkIds.has(link.id) || linkedPersonas.has(link.characterId)) {
        malformedCampaignCharacterCreationOptions();
      }
      linkIds.add(link.id);
      linkedPersonas.add(link.characterId);
    }
    const personaRows = first.persona_count === 0 ? [] : rows;
    if (personaRows.length !== first.persona_count) malformedCampaignCharacterCreationOptions();
    const knownPersonas = new Set<string>();
    const personas = personaRows.map((row) => {
      if (row.persona_id === null || row.persona_name === null || row.persona_created_at === null
        || row.persona_fictional_confirmed !== 1 || row.persona_is_real_person !== 0
        || (row.already_used !== 0 && row.already_used !== 1)) {
        return malformedCampaignCharacterCreationOptions();
      }
      utcIsoTimestampSchema.parse(row.persona_created_at);
      if (knownPersonas.has(row.persona_id)) malformedCampaignCharacterCreationOptions();
      knownPersonas.add(row.persona_id);
      const alreadyUsed = row.already_used === 1;
      if (alreadyUsed !== linkedPersonas.has(row.persona_id)) malformedCampaignCharacterCreationOptions();
      return campaignCharacterPersonaSummarySchema.parse({
        characterId: row.persona_id,
        name: projectLegacyPersonaDisplayName(row.persona_name),
        alreadyUsed,
      });
    });
    if ([...linkedPersonas].some((characterId) => !knownPersonas.has(characterId))) {
      malformedCampaignCharacterCreationOptions();
    }

    if (first.selected_count === 0) {
      if (first.pin_count !== 0) malformedCampaignCharacterCreationOptions();
      return null;
    }
    if (first.selected_count !== 1 || first.profile_rules_profile_id === null
      || first.profile_name === null || first.profile_description === null || first.profile_tags === null) {
      malformedCampaignCharacterCreationOptions();
    }
    const profile = toRulesProfile({
      rules_profile_id: first.profile_rules_profile_id,
      name: first.profile_name,
      description: first.profile_description,
      tags: first.profile_tags,
    });
    if (profile.rulesProfileId !== first.selected_rules_profile_id
      || first.pin_count > MAX_CAMPAIGN_CONTENT_PACKS) {
      malformedCampaignCharacterCreationOptions();
    }
    const pins = JSON.parse(first.pins_json) as CreationOptionsPinRow[];
    if (!Array.isArray(pins) || pins.length !== first.pin_count) malformedCampaignCharacterCreationOptions();
    const parsedPins = pins.map((pin) => {
      if (pin.campaignId !== id || pin.pinRulesProfileId !== profile.rulesProfileId
        || pin.packId !== pin.storedPackId || pin.packVersion !== pin.storedPackVersion
        || pin.packRulesProfileId !== profile.rulesProfileId || pin.sealed !== 1
        || typeof pin.storedPackId !== "string" || typeof pin.storedPackVersion !== "string"
        || typeof pin.name !== "string" || typeof pin.description !== "string" || typeof pin.tags !== "string") {
        return malformedCampaignCharacterCreationOptions();
      }
      return toContentPack({
        pack_id: pin.storedPackId,
        pack_version: pin.storedPackVersion,
        rules_profile_id: profile.rulesProfileId,
        name: pin.name,
        description: pin.description,
        tags: pin.tags,
      });
    });

    const starterPack = parsedPins.length === 1
      && parsedPins[0]!.packId === ORIGINAL_STARTER_MANIFEST.packId
      && parsedPins[0]!.packVersion === ORIGINAL_STARTER_MANIFEST.packVersion;
    if (profile.rulesProfileId !== ORIGINAL_STARTER_MANIFEST.rulesProfileId || !starterPack) return null;
    if (!sameMetadata(profile, ORIGINAL_STARTER_MANIFEST.rulesProfile)
      || !sameMetadata(parsedPins[0]!, ORIGINAL_STARTER_MANIFEST)) {
      malformedCampaignCharacterCreationOptions();
    }

    if (first.reserved_definition_count !== expectedDefinitions.length) {
      malformedCampaignCharacterCreationOptions();
    }
    const rawDefinitions = JSON.parse(first.reserved_definitions_json) as CreationOptionsDefinitionRow[];
    if (!Array.isArray(rawDefinitions) || rawDefinitions.length !== expectedDefinitions.length) {
      malformedCampaignCharacterCreationOptions();
    }
    const installedDefinitions = new Map(rawDefinitions.map((raw) => {
      if (raw.packId !== ORIGINAL_STARTER_MANIFEST.packId
        || raw.packVersion !== ORIGINAL_STARTER_MANIFEST.packVersion
        || typeof raw.kind !== "string" || typeof raw.definitionId !== "string"
        || typeof raw.name !== "string" || typeof raw.description !== "string" || typeof raw.tags !== "string") {
        return malformedCampaignCharacterCreationOptions();
      }
      const definition = toRpgDefinition({
        kind: raw.kind,
        definition_id: raw.definitionId,
        name: raw.name,
        description: raw.description,
        tags: raw.tags,
      });
      return [`${definition.kind}:${definition.definitionId}`, definition] as const;
    }));
    if (installedDefinitions.size !== expectedDefinitions.length || expectedDefinitions.some((expected) => {
      const definition = installedDefinitions.get(`${expected.kind}:${expected.definitionId}`);
      return definition === undefined || !sameMetadata(definition, expected);
    })) malformedCampaignCharacterCreationOptions();

    const response = campaignCharacterCreationOptionsResponseSchema.parse({
      campaignId: id,
      personas,
      starter: {
        rulesProfile: {
          rulesProfileId: ORIGINAL_STARTER_MANIFEST.rulesProfileId,
          name: ORIGINAL_STARTER_MANIFEST.rulesProfile.name,
          description: ORIGINAL_STARTER_MANIFEST.rulesProfile.description,
        },
        pack: {
          packId: ORIGINAL_STARTER_MANIFEST.packId,
          packVersion: ORIGINAL_STARTER_MANIFEST.packVersion,
          rulesProfileId: ORIGINAL_STARTER_MANIFEST.rulesProfileId,
          name: ORIGINAL_STARTER_MANIFEST.name,
          description: ORIGINAL_STARTER_MANIFEST.description,
        },
        race: {
          reference: { packId: ORIGINAL_STARTER_MANIFEST.packId,
            packVersion: ORIGINAL_STARTER_MANIFEST.packVersion,
            definitionId: starterRace.definitionId, kind: starterRace.kind },
          name: starterRace.name, description: starterRace.description,
        },
        background: {
          reference: { packId: ORIGINAL_STARTER_MANIFEST.packId,
            packVersion: ORIGINAL_STARTER_MANIFEST.packVersion,
            definitionId: starterBackground.definitionId, kind: starterBackground.kind },
          name: starterBackground.name, description: starterBackground.description,
        },
        class: {
          reference: { packId: ORIGINAL_STARTER_MANIFEST.packId,
            packVersion: ORIGINAL_STARTER_MANIFEST.packVersion,
            definitionId: starterClass.definitionId, kind: starterClass.kind },
          name: starterClass.name, description: starterClass.description, level: 1,
        },
      },
    });
    if (response.campaignId !== id) malformedCampaignCharacterCreationOptions();
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "campaign character creation options are malformed") throw error;
    return malformedCampaignCharacterCreationOptions();
  }
}

export interface CampaignCharacterCreationOptionsRepository {
  getCampaignCharacterCreationOptions(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignCharacterCreationOptionsResponse | null;
}

export function createCampaignCharacterCreationOptionsRepository(
  db: DatabaseDriver.Database,
): CampaignCharacterCreationOptionsRepository {
  return {
    getCampaignCharacterCreationOptions(actorPrincipalId, campaignId) {
      return getCampaignCharacterCreationOptionsSync(db, actorPrincipalId, campaignId);
    },
  };
}
