// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import {
  campaignMembershipReadSchema,
  campaignSchema,
  campaignTimelineSchema,
  contentPackIdentifierSchema,
  createCampaignCharacterInputSchema,
  MAX_CAMPAIGN_CONTENT_PACKS,
  privilegedCampaignCharacterProjectionSchema,
  resourceIdSchema,
  utcIsoTimestampSchema,
} from "@velvet/contracts";
import {
  ORIGINAL_STARTER_MANIFEST,
  ORIGINAL_STARTER_PACK_ID,
  ORIGINAL_STARTER_PACK_VERSION,
  ORIGINAL_STARTER_RULES_PROFILE_ID,
} from "../../content/originalStarterManifest.js";
import { LOCAL_OWNER_PRINCIPAL_ID } from "../shared.js";
import type {
  Campaign,
  ContentPack,
  CreateCampaignCharacterInput,
  PrivilegedCampaignCharacterProjection,
  RpgDefinition,
  RulesProfile,
} from "../../types.js";
import type { OriginalStarterCampaignCharacterCreationResult, RepositoryDependencies } from "./campaignTypes.js";
import {
  CampaignCharacterCreationConflictError,
  CampaignCharacterCreationUnavailableError,
  CampaignCharacterPersonaUnavailableError,
} from "./campaignErrors.js";
import { createCampaignCharacterReadOperations } from "./campaignCharacterReadRepo.js";
import {
  sameMetadata,
  toContentPack,
  toRpgDefinition,
  toRulesProfile,
  type ContentPackRow,
  type RpgDefinitionRow,
  type RulesProfileRow,
} from "./campaignGlobalContentReadRepo.js";
import { projectLegacyPersonaDisplayName } from "./legacyPersonaDisplayName.js";

/** Write boundary for campaign-character creation. */
export interface CampaignCharacterWriteRepository {
  createCampaignCharacter(
    actorPrincipalId: string,
    input: CreateCampaignCharacterInput,
  ): PrivilegedCampaignCharacterProjection;
  createOriginalStarterCampaignCharacter(
    actorPrincipalId: string,
    input: CreateCampaignCharacterInput,
  ): OriginalStarterCampaignCharacterCreationResult;
}

function createCampaignCharacterSync(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
  actorPrincipalId: string,
  input: CreateCampaignCharacterInput,
  requireOriginalStarter = false,
): OriginalStarterCampaignCharacterCreationResult {
  const actorPrincipal = resourceIdSchema.parse(actorPrincipalId);
  const normalized = createCampaignCharacterInputSchema.parse(input);
  const run = db.transaction(() => {
    // Decide non-disclosing absence/denial from raw parent-backed authority
    // before parsing any campaign-attributable state.
    const campaign = db.prepare(`SELECT id, name, active_timeline_id, owner_principal_id,
        owner_role, created_at, updated_at FROM campaigns WHERE id = ?`)
      .get(normalized.campaignId) as Record<string, unknown> | undefined;
    if (!campaign) throw new CampaignCharacterCreationUnavailableError();
    const authorization = db.prepare(`SELECT membership.campaign_id, membership.principal_id,
        membership.role, membership.created_at
      FROM campaign_memberships membership
      JOIN principals principal ON principal.id = membership.principal_id
      WHERE membership.campaign_id = ? AND membership.principal_id = ?`)
      .get(normalized.campaignId, actorPrincipal) as Record<string, unknown> | undefined;
    if (!authorization || (authorization.role !== "gm" && authorization.role !== "owner")
      || (authorization.role === "owner" && campaign.owner_principal_id !== actorPrincipal)) {
      throw new CampaignCharacterCreationUnavailableError();
    }

    let parsedCampaign: Campaign;
    try {
      campaignMembershipReadSchema.parse({
        campaignId: authorization.campaign_id, principalId: authorization.principal_id,
        role: authorization.role, createdAt: authorization.created_at,
      });
      parsedCampaign = campaignSchema.parse({
        id: campaign.id, name: campaign.name, activeTimelineId: campaign.active_timeline_id,
        ownerPrincipalId: campaign.owner_principal_id, createdAt: campaign.created_at,
        updatedAt: campaign.updated_at,
      });
      if (parsedCampaign.id !== normalized.campaignId || campaign.owner_role !== "owner"
        || parsedCampaign.updatedAt < parsedCampaign.createdAt) throw new Error("bad campaign");
      const owners = db.prepare(`SELECT membership.campaign_id, membership.principal_id,
          membership.role, membership.created_at, principal.id AS parent_id
        FROM campaign_memberships membership
        LEFT JOIN principals principal ON principal.id = membership.principal_id
        WHERE membership.campaign_id = ? AND membership.role = 'owner'
        ORDER BY membership.principal_id COLLATE BINARY`).all(normalized.campaignId) as Record<string, unknown>[];
      if (owners.length !== 1) throw new Error("bad owner count");
      const owner = campaignMembershipReadSchema.parse({
        campaignId: owners[0]!.campaign_id, principalId: owners[0]!.principal_id,
        role: owners[0]!.role, createdAt: owners[0]!.created_at,
      });
      if (owner.campaignId !== parsedCampaign.id || owner.role !== "owner"
        || owner.principalId !== parsedCampaign.ownerPrincipalId
        || owners[0]!.parent_id !== owner.principalId) throw new Error("bad owner");
      const timelineRows = db.prepare(`SELECT id, campaign_id, revision, created_at
        FROM campaign_timelines WHERE id = ?`).all(parsedCampaign.activeTimelineId) as Record<string, unknown>[];
      if (timelineRows.length !== 1) throw new Error("bad timeline count");
      const timeline = campaignTimelineSchema.parse({
        id: timelineRows[0]!.id, campaignId: timelineRows[0]!.campaign_id,
        revision: timelineRows[0]!.revision, createdAt: timelineRows[0]!.created_at,
      });
      if (timeline.campaignId !== parsedCampaign.id) throw new Error("bad timeline parent");
    } catch {
      throw new Error("campaign character creation campaign authority is malformed");
    }

    const controller = db.prepare(`SELECT membership.campaign_id, membership.principal_id,
        membership.role, membership.created_at, principal.id AS parent_id
      FROM campaign_memberships membership
      LEFT JOIN principals principal ON principal.id = membership.principal_id
      WHERE membership.campaign_id = ? AND membership.principal_id = ?`)
      .get(normalized.campaignId, normalized.controllerPrincipalId) as Record<string, unknown> | undefined;
    if (!controller || !["owner", "gm", "player"].includes(String(controller.role))) {
      throw new CampaignCharacterCreationUnavailableError();
    }
    try {
      const membership = campaignMembershipReadSchema.parse({ campaignId: controller.campaign_id,
        principalId: controller.principal_id, role: controller.role, createdAt: controller.created_at });
      if (membership.campaignId !== normalized.campaignId
        || membership.principalId !== normalized.controllerPrincipalId
        || controller.parent_id !== membership.principalId
        || (membership.role === "owner" && membership.principalId !== parsedCampaign.ownerPrincipalId)) {
        throw new Error("bad controller");
      }
    } catch {
      throw new Error("campaign character creation controller is malformed");
    }

    const persona = db.prepare(`SELECT id, name, fictional_confirmed, is_real_person, created_at
      FROM characters WHERE id = ?`).get(normalized.characterId) as Record<string, unknown> | undefined;
    if (!persona) throw new CampaignCharacterPersonaUnavailableError();
    let personaDisplayName: string;
    try {
      if (persona.id !== normalized.characterId) throw new Error("bad persona id");
      personaDisplayName = projectLegacyPersonaDisplayName(persona.name);
      utcIsoTimestampSchema.parse(persona.created_at);
      if (![0, 1].includes(persona.fictional_confirmed as number)
        || ![0, 1].includes(persona.is_real_person as number)) throw new Error("bad persona flags");
    } catch {
      throw new Error("campaign character creation persona is malformed");
    }
    if (persona.fictional_confirmed !== 1 || persona.is_real_person !== 0) {
      throw new CampaignCharacterPersonaUnavailableError();
    }

    // Validate the complete generic configured graph, not a special starter.
    const selections = db.prepare(`SELECT selection.campaign_id, selection.rules_profile_id,
        profile.rules_profile_id AS profile_id, profile.name, profile.description, profile.tags
      FROM campaign_rules_profiles selection
      LEFT JOIN rpg_rules_profiles profile ON profile.rules_profile_id = selection.rules_profile_id
      WHERE selection.campaign_id = ?`).all(normalized.campaignId) as Record<string, unknown>[];
    if (selections.length !== 1) throw new Error("campaign character creation content graph is malformed");
    let selectedProfileId: string;
    try {
      const selected = selections[0]!;
      if (selected.campaign_id !== normalized.campaignId || selected.profile_id !== selected.rules_profile_id) {
        throw new Error("bad profile ancestry");
      }
      selectedProfileId = toRulesProfile({ rules_profile_id: selected.profile_id as string,
        name: selected.name as string, description: selected.description as string,
        tags: selected.tags as string }).rulesProfileId;
    } catch {
      throw new Error("campaign character creation content graph is malformed");
    }
    const pins = db.prepare(`SELECT pin.campaign_id, pin.pack_id AS pin_pack_id,
        pin.pack_version AS pin_pack_version, pin.rules_profile_id AS pin_profile_id,
        pack.pack_id, pack.pack_version, pack.rules_profile_id, pack.name,
        pack.description, pack.tags, pack.sealed
      FROM campaign_content_packs pin
      LEFT JOIN rpg_content_packs pack ON pack.pack_id = pin.pack_id AND pack.pack_version = pin.pack_version
      WHERE pin.campaign_id = ? ORDER BY pin.pack_id COLLATE BINARY, pin.pack_version COLLATE BINARY`)
      .all(normalized.campaignId) as Record<string, unknown>[];
    if ((!requireOriginalStarter && pins.length === 0) || pins.length > MAX_CAMPAIGN_CONTENT_PACKS) {
      throw new Error("campaign character creation content graph is malformed");
    }
    try {
      for (const pin of pins) {
        if (pin.campaign_id !== normalized.campaignId || pin.pin_profile_id !== selectedProfileId
          || pin.pack_id !== pin.pin_pack_id || pin.pack_version !== pin.pin_pack_version
          || pin.rules_profile_id !== selectedProfileId || pin.sealed !== 1) throw new Error("bad pin");
        toContentPack({ pack_id: pin.pack_id as string, pack_version: pin.pack_version as string,
          rules_profile_id: pin.rules_profile_id as string, name: pin.name as string,
          description: pin.description as string, tags: pin.tags as string });
      }
    } catch {
      throw new Error("campaign character creation content graph is malformed");
    }

    // The fixed specialization classifies a complete, valid configuration or
    // reserved-namespace drift before generic requested-definition absence.
    // Persisted corruption has already failed loudly above.
    if (requireOriginalStarter) {
      validateOriginalStarterCharacterContent(db, normalized, selectedProfileId, pins);
    }

    const definitionAvailable = db.prepare(`SELECT d.kind, d.definition_id, d.name, d.description, d.tags
      FROM campaign_content_packs cp
      JOIN campaign_rules_profiles selection ON selection.campaign_id = cp.campaign_id
        AND selection.rules_profile_id = cp.rules_profile_id
      JOIN rpg_content_packs p ON p.pack_id = cp.pack_id AND p.pack_version = cp.pack_version
        AND p.rules_profile_id = cp.rules_profile_id AND p.sealed = 1
      JOIN rpg_definitions d ON d.pack_id = cp.pack_id AND d.pack_version = cp.pack_version
      WHERE cp.campaign_id = ? AND cp.pack_id = ? AND cp.pack_version = ?
        AND d.kind = ? AND d.definition_id = ?`);
    const references = [
      normalized.race,
      normalized.background,
      ...normalized.classes.map((entry) => entry.class),
      ...normalized.choices.map((entry) => entry.selection),
    ];
    for (const reference of references) {
      const definition = definitionAvailable.get(
        normalized.campaignId,
        reference.packId,
        reference.packVersion,
        reference.kind,
        reference.definitionId,
      ) as { kind: string; definition_id: string; name: string; description: string; tags: string } | undefined;
      if (!definition) throw new CampaignCharacterCreationUnavailableError();
      // Metadata corruption is not an availability classification.
      toRpgDefinition(definition);
    }

    // A conflict is classified only after all requested content has been
    // validated. An invalid request or corrupt definition must not be hidden
    // by an otherwise complete existing aggregate.
    const duplicate = db.prepare(`SELECT id FROM campaign_characters
      WHERE campaign_id = ? AND character_id = ?`).get(normalized.campaignId, normalized.characterId) as
      { id: unknown } | undefined;
    if (duplicate) {
      const duplicateId = resourceIdSchema.parse(duplicate.id);
      const complete = createCampaignCharacterReadOperations(db)
        .getCampaignCharacter(actorPrincipal, normalized.campaignId, duplicateId);
      if (!complete || complete.projection.campaignCharacter.characterId !== normalized.characterId) {
        throw new Error("campaign character duplicate aggregate is malformed");
      }
      throw new CampaignCharacterCreationConflictError();
    }

    const campaignCharacterId = resourceIdSchema.parse(dependencies.ids.nextId());
    const sheetId = resourceIdSchema.parse(dependencies.ids.nextId());
    const actorId = resourceIdSchema.parse(dependencies.ids.nextId());
    const createdAt = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
    if (createdAt < parsedCampaign.updatedAt) {
      throw new Error("campaign character timestamp cannot precede campaign updated_at");
    }

    db.prepare(`INSERT INTO campaign_characters
      (id, campaign_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(campaignCharacterId, normalized.campaignId, normalized.characterId, createdAt, createdAt);
    db.prepare(`INSERT INTO rpg_campaign_sheets
      (id, campaign_id, campaign_character_id,
       race_pack_id, race_pack_version, race_kind, race_definition_id,
       background_pack_id, background_pack_version, background_kind, background_definition_id,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        sheetId, normalized.campaignId, campaignCharacterId,
        normalized.race.packId, normalized.race.packVersion, normalized.race.kind, normalized.race.definitionId,
        normalized.background.packId, normalized.background.packVersion,
        normalized.background.kind, normalized.background.definitionId,
        createdAt, createdAt,
      );
    const insertClass = db.prepare(`INSERT INTO rpg_character_classes
      (campaign_id, sheet_id, position, pack_id, pack_version, kind, definition_id, level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    normalized.classes.forEach((entry, position) => insertClass.run(
      normalized.campaignId, sheetId, position, entry.class.packId, entry.class.packVersion,
      entry.class.kind, entry.class.definitionId, entry.level,
    ));
    const insertAttribute = db.prepare(`INSERT INTO rpg_character_attributes
      (campaign_id, sheet_id, position, attribute_id, value) VALUES (?, ?, ?, ?, ?)`);
    normalized.attributes.forEach((entry, position) => insertAttribute.run(
      normalized.campaignId, sheetId, position, entry.attributeId, entry.value,
    ));
    const insertProficiency = db.prepare(`INSERT INTO rpg_character_proficiencies
      (campaign_id, sheet_id, position, category, proficiency_id) VALUES (?, ?, ?, ?, ?)`);
    normalized.proficiencies.forEach((entry, position) => insertProficiency.run(
      normalized.campaignId, sheetId, position, entry.category, entry.proficiencyId,
    ));
    const insertChoice = db.prepare(`INSERT INTO rpg_character_choices
      (campaign_id, sheet_id, position, choice_id, pack_id, pack_version, kind, definition_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    normalized.choices.forEach((entry, position) => insertChoice.run(
      normalized.campaignId, sheetId, position, entry.choiceId, entry.selection.packId,
      entry.selection.packVersion, entry.selection.kind, entry.selection.definitionId,
    ));
    db.prepare(`INSERT INTO campaign_actors
      (id, campaign_id, campaign_character_id, sheet_id, kind, control, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'player-character', 'principal', ?, ?)`)
      .run(actorId, normalized.campaignId, campaignCharacterId, sheetId, createdAt, createdAt);
    db.prepare(`INSERT INTO campaign_actor_private_state
      (actor_id, campaign_id, controller_principal_id, private_notes) VALUES (?, ?, ?, ?)`)
      .run(actorId, normalized.campaignId, normalized.controllerPrincipalId, normalized.privateNotes ?? null);

    const projection = privilegedCampaignCharacterProjectionSchema.parse({
      campaignCharacter: {
        id: campaignCharacterId, campaignId: normalized.campaignId, characterId: normalized.characterId,
        createdAt, updatedAt: createdAt,
      },
      sheet: {
        id: sheetId, campaignId: normalized.campaignId, campaignCharacterId,
        race: normalized.race, background: normalized.background, classes: normalized.classes,
        attributes: normalized.attributes, proficiencies: normalized.proficiencies, choices: normalized.choices,
        createdAt, updatedAt: createdAt,
      },
      actor: {
        id: actorId, campaignId: normalized.campaignId, campaignCharacterId, sheetId,
        kind: "player-character", control: "principal",
        controllerPrincipalId: normalized.controllerPrincipalId,
        privateNotes: normalized.privateNotes ?? null, createdAt, updatedAt: createdAt,
      },
    });
    // Do not reconstruct the current persona name after commit: the bounded
    // name and aggregate are evidence from this same locked transaction.
    return { projection, personaDisplayName };
  });
  return run.immediate();
}

/**
 * Proves the fixed starter namespace while the caller holds BEGIN IMMEDIATE.
 * Structurally valid drift is a stable conflict; malformed persisted content
 * remains an untyped invariant failure.
 */
function validateOriginalStarterCharacterContent(
  db: DatabaseDriver.Database,
  input: CreateCampaignCharacterInput,
  selectedProfileId: string,
  pins: Record<string, unknown>[],
): void {
  const expectedDefinitions = [
    ...ORIGINAL_STARTER_MANIFEST.classes,
    ...ORIGINAL_STARTER_MANIFEST.races,
    ...ORIGINAL_STARTER_MANIFEST.backgrounds,
    ...ORIGINAL_STARTER_MANIFEST.items,
    ...ORIGINAL_STARTER_MANIFEST.spells,
    ...ORIGINAL_STARTER_MANIFEST.abilities,
    ...ORIGINAL_STARTER_MANIFEST.enemies,
  ];
  const expectedInput = {
    race: ORIGINAL_STARTER_MANIFEST.races[0]!,
    background: ORIGINAL_STARTER_MANIFEST.backgrounds[0]!,
    class: ORIGINAL_STARTER_MANIFEST.classes[0]!,
  };
  const referencesMatch = input.race.packId === ORIGINAL_STARTER_PACK_ID
    && input.race.packVersion === ORIGINAL_STARTER_PACK_VERSION
    && input.race.kind === "race"
    && input.race.definitionId === expectedInput.race.definitionId
    && input.background.packId === ORIGINAL_STARTER_PACK_ID
    && input.background.packVersion === ORIGINAL_STARTER_PACK_VERSION
    && input.background.kind === "background"
    && input.background.definitionId === expectedInput.background.definitionId
    && input.classes.length === 1
    && input.classes[0]?.level === 1
    && input.classes[0]?.class.packId === ORIGINAL_STARTER_PACK_ID
    && input.classes[0]?.class.packVersion === ORIGINAL_STARTER_PACK_VERSION
    && input.classes[0]?.class.kind === "class"
    && input.classes[0]?.class.definitionId === expectedInput.class.definitionId
    && input.attributes.length === 0 && input.proficiencies.length === 0 && input.choices.length === 0
    && input.privateNotes === undefined;
  if (!referencesMatch || input.controllerPrincipalId !== LOCAL_OWNER_PRINCIPAL_ID) {
    throw new CampaignCharacterCreationConflictError();
  }

  const profileRow = db.prepare(`SELECT rules_profile_id, name, description, tags
    FROM rpg_rules_profiles WHERE rules_profile_id = ?`)
    .get(ORIGINAL_STARTER_RULES_PROFILE_ID) as RulesProfileRow | undefined;
  const allReservedPacks = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags, sealed
    FROM rpg_content_packs WHERE pack_id = ? ORDER BY pack_version COLLATE BINARY`)
    .all(ORIGINAL_STARTER_PACK_ID) as Array<ContentPackRow & { sealed: number }>;
  const placeholders = expectedDefinitions.map(() => "?").join(", ");
  const definitionRows = db.prepare(`SELECT pack_id, pack_version, kind, definition_id, name, description, tags
    FROM rpg_definitions WHERE pack_id = ? OR definition_id IN (${placeholders})`)
    .all(ORIGINAL_STARTER_PACK_ID, ...expectedDefinitions.map((definition) => definition.definitionId)) as
    Array<RpgDefinitionRow & { pack_id: string; pack_version: string }>;

  let profile: RulesProfile | undefined;
  let packs: ContentPack[];
  let definitions: Array<RpgDefinition & { packId: string; packVersion: string }>;
  try {
    profile = profileRow ? toRulesProfile(profileRow) : undefined;
    if (allReservedPacks.some((row) => row.sealed !== 1)) {
      throw new Error("reserved pack is not sealed");
    }
    packs = allReservedPacks.map((row) => ({ ...toContentPack(row), sealed: row.sealed }));
    definitions = definitionRows.map((row) => {
      const identity = contentPackIdentifierSchema.parse({ packId: row.pack_id, packVersion: row.pack_version });
      return { ...toRpgDefinition(row), ...identity };
    });
  } catch {
    throw new Error("original starter campaign character content is malformed");
  }

  const exactPin = pins.length === 1
    && pins[0]!.pin_pack_id === ORIGINAL_STARTER_PACK_ID
    && pins[0]!.pin_pack_version === ORIGINAL_STARTER_PACK_VERSION
    && pins[0]!.pin_profile_id === ORIGINAL_STARTER_RULES_PROFILE_ID;
  const exactPack = allReservedPacks.length === 1 && allReservedPacks[0]!.sealed === 1
    && packs[0]!.rulesProfileId === ORIGINAL_STARTER_RULES_PROFILE_ID
    && sameMetadata(packs[0]!, ORIGINAL_STARTER_MANIFEST);
  const installed = new Map(definitions.map((definition) => [
    `${definition.kind}:${definition.definitionId}`,
    definition,
  ]));
  const exactDefinitions = definitions.length === expectedDefinitions.length
    && installed.size === expectedDefinitions.length
    && definitions.every((definition) => definition.packId === ORIGINAL_STARTER_PACK_ID
      && definition.packVersion === ORIGINAL_STARTER_PACK_VERSION)
    && expectedDefinitions.every((expected) => {
      const actual = installed.get(`${expected.kind}:${expected.definitionId}`);
      return actual !== undefined && sameMetadata(actual, expected);
    });
  if (selectedProfileId !== ORIGINAL_STARTER_RULES_PROFILE_ID || !exactPin || !profile
    || !sameMetadata(profile, ORIGINAL_STARTER_MANIFEST.rulesProfile) || !exactPack || !exactDefinitions) {
    throw new CampaignCharacterCreationConflictError();
  }
}

/** Creates campaign-character write operations scoped to one database connection. */
export function createCampaignCharacterWriteRepository(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
): CampaignCharacterWriteRepository {
  return {
    createCampaignCharacter: (actorPrincipalId, input) =>
      createCampaignCharacterSync(db, dependencies, actorPrincipalId, input).projection,
    createOriginalStarterCampaignCharacter: (actorPrincipalId, input) =>
      createCampaignCharacterSync(db, dependencies, actorPrincipalId, input, true),
  };
}
