import DatabaseDriver from "better-sqlite3";
import {
  addCampaignMembershipInputSchema,
  actorResourceNameSchema,
  actorResourceSchema,
  attachCampaignSessionInputSchema,
  campaignCharacterAttributeSchema,
  campaignCharacterClassSchema,
  campaignCharacterProficiencySchema,
  publicCampaignCharacterSummarySchema,
  publicCampaignActorSchema,
  campaignCharacterSchema,
  campaignContentConfigurationSchema,
  campaignMembershipReadSchema,
  campaignMembershipSchema,
  campaignRenameRequestSchema,
  campaignSchema,
  campaignSessionAttachmentSchema,
  campaignTimelineSchema,
  commandEnvelopeSchema,
  commandReceiptSchema,
  contentPackIdentifierSchema,
  contentPackSchema,
  configureCampaignContentInputSchema,
  createCampaignCharacterInputSchema,
  createCampaignInputSchema,
  definitionReferenceSchema,
  detachCampaignSessionInputSchema,
  installContentPackInputSchema,
  MAX_CAMPAIGN_CHARACTER_PERSONAS,
  MAX_CAMPAIGN_CHARACTER_ROSTER,
  MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES,
  MAX_CAMPAIGN_CONTENT_PACKS,
  MAX_CHARACTER_ATTRIBUTES,
  MAX_CHARACTER_CHOICES,
  MAX_CHARACTER_CLASSES,
  MAX_CHARACTER_PROFICIENCIES,
  privilegedCampaignCharacterProjectionSchema,
  revisionSchema,
  rpgEventSchema,
  setActorAttributePayloadSchema,
  renameCampaignInputSchema,
  resourceIdSchema,
  resolvedCharacterChoiceSchema,
  utcIsoTimestampSchema,
  type PublicCampaignCharacterSummary,
  type CampaignCharacterWorkspaceResponse,
  type CampaignRoomLinkingResponse,
  type ProgressionState,
} from "@velvet/contracts";
import path from "node:path";
import { evaluateDiceExpression, parseDiceExpression } from "../dice.js";
import {
  ORIGINAL_STARTER_MANIFEST,
  ORIGINAL_STARTER_PACK_ID,
  ORIGINAL_STARTER_PACK_VERSION,
  ORIGINAL_STARTER_RULES_PROFILE_ID,
} from "../content/originalStarterManifest.js";
import {
  MECHANICS_STARTER_CATALOG,
  MECHANICS_STARTER_RULES_PROFILE_ID,
} from "../content/mechanicsStarterCatalog.js";
import { systemRuntime } from "../runtime.js";
import { LOCAL_OWNER_PRINCIPAL_ID } from "./shared.js";
import { createCharacterSync } from "./characterRepo.js";
import { createLoreEntrySync } from "./loreRepo.js";
import { openRepositoryDatabase, resolveDataDir } from "./db.js";
import {
  createCampaignAdministrationRepository,
  type CampaignAdministrationRepository,
} from "./campaignAdministrationRepo.js";
import {
  createContentCatalogRepository,
  verifyCatalogVisibilityProjection,
  validateContentCatalog,
  type PersistedCatalogVisibilityRow,
  type ContentCatalogRepository,
} from "./contentCatalogRepo.js";
import {
  createCharacterBuilderRepository,
  type CharacterBuilderRepository,
} from "./characterBuilderRepo.js";
import { createCharacterProgressionRepository, type CharacterProgressionRepository } from "./characterProgressionRepo.js";
import { createActorResourceRepository, type ActorResourceRepository } from "./actorResourceRepo.js";
import { createInventoryRepository, type InventoryRepository } from "./inventoryRepo.js";
import { createEconomyRepository, type EconomyRepository } from "./economyRepo.js";
import { createRestRepository, type RestRepository } from "./restRepo.js";
import { createCheckRepository, type CheckRepository } from "./checkRepo.js";
import { createPowerRepository, type PowerRepository } from "./powerRepo.js";
import { createEffectRepository, type EffectRepository } from "./effectRepo.js";
import { createEncounterRepository, type EncounterRepository } from "./encounterRepo.js";
import { createWorldRepository, type WorldRepository } from "./worldRepo.js";
import { createQuestRepository, type QuestRepository } from "./questRepo.js";
import {
  CampaignDiceCharacterConflict,
  createDiceRepository,
  type CampaignDiceEvent,
  type CampaignDiceVisibleCharacterBinding,
} from "./diceRepo.js";
export {
  CampaignDiceCharacterConflict,
  type CampaignDiceEvent,
  type CampaignDiceVisibleCharacterBinding,
} from "./diceRepo.js";
import { updateHarnessSettingsSync } from "./settingsRepo.js";
import {
  addConsentEventSync,
  getSessionSync,
  stopSessionSync,
  transitionSessionSync,
  updateSessionContextSourceSync,
} from "./sessionRepo.js";
import type { Clock, IdGenerator, RandomNumberGenerator } from "../runtime.js";
import type {
  CampaignCharacterRosterSnapshot,
  CampaignCharacterSheetSnapshot,
  CampaignCharacterWorkspaceSnapshot,
  CampaignEventPage,
  CampaignRoomLinkingSnapshot,
  OriginalStarterCampaignCharacterCreationResult,
  OriginalStarterSetupInspection,
  Repository,
  RepositoryDependencies,
  RepositoryUnitOfWork,
} from "./campaign/campaignTypes.js";
export type {
  CampaignCharacterRosterSnapshot,
  CampaignCharacterSheetSnapshot,
  CampaignCharacterWorkspaceSnapshot,
  CampaignEventPage,
  CampaignRoomLinkingSnapshot,
  OriginalStarterCampaignCharacterCreationResult,
  OriginalStarterSetupInspection,
  Repository,
  RepositoryDependencies,
  RepositoryUnitOfWork,
} from "./campaign/campaignTypes.js";

type SynchronousCallback<T> = (repository: RepositoryUnitOfWork) =>
  T & (T extends PromiseLike<unknown> ? never : unknown);
import { createCampaignCoreRepository } from "./campaign/campaignCoreRepo.js";
import { createCampaignAccessRepository } from "./campaign/campaignAccessRepo.js";
import { createCampaignActorRepository } from "./campaign/campaignActorRepo.js";
import { createCampaignCharacterReadOperations } from "./campaign/campaignCharacterReadRepo.js";
import { createCampaignCharacterRosterOperations } from "./campaign/campaignCharacterRosterRepo.js";
import { createCampaignCharacterWriteRepository } from "./campaign/campaignCharacterWriteRepo.js";
import { createCampaignCommandRepository } from "./campaign/campaignCommandRepo.js";
import { createCampaignCommandWriteOperations } from "./campaign/campaignCommandWriteRepo.js";
import { createCampaignActorResourceRepository } from "./campaign/campaignActorResourceRepo.js";
import { createCampaignEventProjectionRepo } from "./campaign/campaignEventProjectionRepo.js";
import { createCampaignMembershipReadRepository } from "./campaign/campaignMembershipReadRepo.js";
import { createCampaignSessionAttachmentReadRepository } from "./campaign/campaignSessionAttachmentReadRepo.js";
import { createCampaignRoomLinkingSnapshotRepository } from "./campaign/campaignRoomLinkingSnapshotRepo.js";
import { createCampaignRoomSessionLifecycleRepository } from "./campaign/campaignRoomSessionLifecycleRepo.js";
import { createCampaignCharacterCreationOptionsRepository } from "./campaign/campaignCharacterCreationOptionsRepo.js";
import {
  getCampaignTimelineSync as getCampaignTimelineReadSync,
  listCampaignTimelinesSync as listCampaignTimelinesReadSync,
  VALID_AUDIT_COMMAND,
  VALID_AUDIT_EVENT,
  VALID_DICE_ROLL,
} from "./campaign/campaignTimelineReadRepo.js";
import { createCampaignCharacterWorkspaceRepository } from "./campaign/campaignCharacterWorkspaceRepo.js";
import { createCampaignCharacterSheetSnapshotRepository } from "./campaign/campaignCharacterSheetSnapshotRepo.js";
import {
  createCampaignContentConfigurationReadRepository,
  getCampaignContentConfigurationReadSync,
} from "./campaign/campaignContentConfigurationReadRepo.js";
import { createCampaignDetailReadRepository } from "./campaign/campaignDetailReadRepo.js";
import { createCampaignContentSelectionReadRepository } from "./campaign/campaignContentSelectionReadRepo.js";
import { createCampaignContentDefinitionReadRepository } from "./campaign/campaignContentDefinitionReadRepo.js";
import { createCampaignLegacyCoreWriteRepository } from "./campaign/campaignLegacyCoreWriteRepo.js";
import {
  addCampaignMembershipSync as addCampaignMembershipCoreWriteSync,
  attachCampaignSessionSync as attachCampaignSessionCoreWriteSync,
  createCampaignSync as createCampaignCoreWriteSync,
  detachCampaignSessionSync as detachCampaignSessionCoreWriteSync,
  recordCompatibilityAdministrationAudit as recordCompatibilityAdministrationAuditCoreWrite,
  renameCampaignIfUnchangedSync as renameCampaignIfUnchangedCoreWriteSync,
  renameCampaignSync as renameCampaignCoreWriteSync,
} from "./campaign/campaignCoreWriteRepo.js";
import {
  CampaignCharacterCreationConflictError,
  CampaignCharacterCreationUnavailableError,
  CampaignCharacterPersonaUnavailableError,
  CampaignContentConfigurationAuthorizationError,
  CampaignContentConfigurationConflictError,
  CampaignCreationAuthorizationError,
  CampaignCreationIdCollisionError,
  CampaignRenameStaleError,
  CampaignRenameUnavailableError,
  CampaignSessionAttachmentConflictError,
  CampaignSessionAttachmentSessionMissingError,
  CampaignSessionAttachmentUnavailableError,
  ContentPackInstallationAuthorizationError,
  ContentPackInstallationConflictError,
} from "./campaign/campaignErrors.js";
export {
  CampaignCharacterCreationConflictError,
  CampaignCharacterCreationUnavailableError,
  CampaignCharacterPersonaUnavailableError,
  CampaignContentConfigurationAuthorizationError,
  CampaignContentConfigurationConflictError,
  CampaignCreationAuthorizationError,
  CampaignCreationIdCollisionError,
  CampaignRenameStaleError,
  CampaignRenameUnavailableError,
  CampaignSessionAttachmentConflictError,
  CampaignSessionAttachmentSessionMissingError,
  CampaignSessionAttachmentUnavailableError,
  ContentPackInstallationAuthorizationError,
  ContentPackInstallationConflictError,
} from "./campaign/campaignErrors.js";
import { projectLegacyPersonaDisplayName } from "./campaign/legacyPersonaDisplayName.js";
import {
  createOriginalStarterSetupInspectionRepository,
  type OriginalStarterSetupInspectionRepository,
} from "./campaign/originalStarterSetupInspectionRepo.js";
import {
  createCampaignGlobalContentReadRepository,
  CONTENT_PACK_PROJECTION,
  DEFINITION_ORDER,
  DEFINITION_PROJECTION,
  RULES_PROFILE_PROJECTION,
  sameMetadata,
  toContentPack,
  toRpgDefinition,
  toRulesProfile,
  type ContentPackRow,
  type RpgDefinitionRow,
  type RulesProfileRow,
} from "./campaign/campaignGlobalContentReadRepo.js";
import type {
  AddCampaignMembershipInput,
  ActorResource,
  AttachCampaignSessionInput,
  Character,
  Campaign,
  CampaignAccess,
  CampaignContentConfiguration,
  CampaignDetail,
  CampaignMembership,
  CampaignMembershipRead,
  CampaignCharacterRead,
  CampaignRenameRequest,
  CampaignCharacterCreationOptionsResponse,
  CampaignSessionAttachment,
  CampaignTimeline,
  CommandEnvelope,
  CommandReceipt,
  ContentPack,
  ContentPackIdentifier,
  ConfigureCampaignContentInput,
  ConsentEvent,
  CreateCampaignCharacterInput,
  CreateCharacterInput,
  CreateCampaignInput,
  DetachCampaignSessionInput,
  DefinitionReference,
  InstallContentPackInput,
  RenameCampaignInput,
  RpgEvent,
  RpgDefinition,
  RulesProfile,
  RulesProfileIdentifier,
  Database,
  HarnessSettings,
  LoreEntry,
  NewLoreEntry,
  PrivilegedCampaignCharacterProjection,
  ProviderPricing,
  SceneState,
  Session,
  TokenUsage,
  UpdateHarnessInput,
  UsageSummary,
} from "../types.js";


export interface CreateRepositoryOptions extends Partial<RepositoryDependencies> {
  dataDir?: string;
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

interface CampaignEventReadRow {
  audit_command_id: string | null;
  command_presence: string | null;
  event_presence: string | null;
  receipt_presence: string | null;
  requested_timeline_presence: string | null;
  event_timeline_presence: string | null;
  event_timeline_revision: unknown;
  event_timeline_event_count: unknown;
  event_actor_presence: string | null;
  attributable_term_count: unknown;
  event_id: string | null;
  command_id: string | null;
  campaign_id: string | null;
  timeline_id: string | null;
  actor_id: string | null;
  source_turn_id: string | null;
  type: string | null;
  revision: number | null;
  occurred_at: string | null;
  attribute_id: string | null;
  value_before: number | null;
  value_after: number | null;
  resource_name: string | null;
  resource_current: number | null;
  resource_max: number | null;
}

interface DiceCampaignEventReadRow extends CampaignEventReadRow {
  requested_timeline_revision: unknown;
  requested_timeline_event_count: unknown;
  requested_timeline_min_revision: unknown;
  requested_timeline_max_revision: unknown;
  attributable_roll_count: unknown;
  roll_event_id: string | null;
  roll_campaign_id: string | null;
  roll_command_id: string | null;
  roll_expression: string | null;
  roll_dice_count: unknown;
  roll_dice_sides: unknown;
  roll_selection_type: string | null;
  roll_selection_count: unknown;
  roll_modifier: unknown;
  roll_total: unknown;
  term_event_id: string | null;
  term_position: unknown;
  term_value: unknown;
  term_kept: unknown;
  invalid_audit_count?: unknown;
}

interface CommandReceiptReadRow extends DiceCampaignEventReadRow {
  revision_before: number | null;
  revision_after: number | null;
}

function eventFromReadRow(row: CampaignEventReadRow): RpgEvent {
  // Dice rows require grouped term reconstruction and must never fall through
  // either legacy single-row event path.
  if (row.type === "actor_dice_rolled" && row.event_id !== null) {
    throw new Error("dice event projection is not implemented");
  }
  if (
    row.command_presence === null || row.event_presence === null || row.receipt_presence === null
    || row.requested_timeline_presence === null || row.event_timeline_presence === null
    || row.event_actor_presence === null || row.event_id === null || row.command_id === null
    || row.campaign_id === null || row.timeline_id === null || row.actor_id === null
    || row.type === null || row.revision === null || row.occurred_at === null
  ) {
    throw new Error("campaign event audit record is incomplete");
  }
  const common = {
    eventId: row.event_id,
    commandId: row.command_id,
    campaignId: row.campaign_id,
    timelineId: row.timeline_id,
    actorId: row.actor_id,
    sourceTurnId: row.source_turn_id,
    type: row.type,
    revision: row.revision,
    occurredAt: row.occurred_at,
  };
  if (row.type !== "actor_attribute_set" && row.type !== "actor_resource_initialized") {
    throw new Error("campaign event audit record is incomplete");
  }
  if (row.attributable_term_count !== 0) {
    throw new Error("campaign event audit record is incomplete");
  }
  const event = row.type === "actor_attribute_set"
    ? rpgEventSchema.parse({
        ...common,
        data: { attributeId: row.attribute_id, valueBefore: row.value_before, valueAfter: row.value_after },
      })
    : rpgEventSchema.parse({
        ...common,
        data: { name: row.resource_name, current: row.resource_current, max: row.resource_max },
      });
  const timelineRevision = revisionSchema.parse(row.event_timeline_revision);
  const timelineEventCount = revisionSchema.parse(row.event_timeline_event_count);
  if (timelineRevision < event.revision || timelineEventCount !== timelineRevision) {
    throw new Error("campaign event audit record is incomplete");
  }
  return event;
}

function diceEventFromReadRows(rows: DiceCampaignEventReadRow[]): RpgEvent {
  const row = rows[0]!;
  if (
    row.command_presence === null || row.event_presence === null || row.receipt_presence === null
    || row.requested_timeline_presence === null || row.event_timeline_presence === null
    || row.event_actor_presence === null || row.event_id === null || row.command_id === null
    || row.campaign_id === null || row.timeline_id === null || row.actor_id === null
    || row.type !== "actor_dice_rolled" || row.revision === null || row.occurred_at === null
    || row.attribute_id !== null || row.value_before !== null || row.value_after !== null
    || row.resource_name !== null || row.resource_current !== null || row.resource_max !== null
    || row.roll_event_id === null || row.roll_campaign_id === null || row.roll_command_id === null
    || row.roll_expression === null || row.roll_selection_type === null
    || row.roll_dice_count === null || row.roll_dice_sides === null || row.roll_modifier === null
    || row.roll_total === null || row.attributable_roll_count !== 1
    || row.attributable_term_count !== rows.length
  ) {
    throw new Error("campaign event audit record is incomplete");
  }
  if (rows.some((candidate) => candidate.event_id !== row.event_id
      || candidate.roll_event_id !== row.roll_event_id
      || candidate.roll_campaign_id !== row.roll_campaign_id
      || candidate.roll_command_id !== row.roll_command_id
      || candidate.roll_expression !== row.roll_expression
      || candidate.roll_dice_count !== row.roll_dice_count
      || candidate.roll_dice_sides !== row.roll_dice_sides
      || candidate.roll_selection_type !== row.roll_selection_type
      || candidate.roll_selection_count !== row.roll_selection_count
      || candidate.roll_modifier !== row.roll_modifier || candidate.roll_total !== row.roll_total)) {
    throw new Error("campaign event audit record is incomplete");
  }
  if (row.roll_event_id !== row.event_id || row.roll_campaign_id !== row.campaign_id
      || row.roll_command_id !== row.command_id) {
    throw new Error("campaign event audit record is incomplete");
  }

  let selection: Record<string, unknown>;
  if (row.roll_selection_type === "keep_highest" || row.roll_selection_type === "keep_lowest") {
    selection = { type: row.roll_selection_type, count: row.roll_selection_count };
  } else {
    if (row.roll_selection_count !== null) throw new Error("campaign event audit record is incomplete");
    selection = { type: row.roll_selection_type };
  }
  const physicalCount = row.roll_selection_type === "advantage" || row.roll_selection_type === "disadvantage"
    ? 2 : row.roll_dice_count;
  if (typeof physicalCount !== "number" || !Number.isInteger(physicalCount)
      || rows.length !== physicalCount) {
    throw new Error("campaign event audit record is incomplete");
  }
  if (rows.some((term, position) => term.term_event_id !== row.roll_event_id
      || term.term_position !== position
      || typeof term.term_kept !== "number" || !Number.isInteger(term.term_kept)
      || (term.term_kept !== 0 && term.term_kept !== 1))) {
    throw new Error("campaign event audit record is incomplete");
  }
  const terms = rows.map((term) => ({ value: term.term_value, kept: term.term_kept === 1 }));
  const normalized = {
    count: row.roll_dice_count,
    sides: row.roll_dice_sides,
    selection,
    modifier: row.roll_modifier,
  };
  const event = rpgEventSchema.parse({
    eventId: row.event_id,
    commandId: row.command_id,
    campaignId: row.campaign_id,
    timelineId: row.timeline_id,
    actorId: row.actor_id,
    sourceTurnId: row.source_turn_id,
    type: row.type,
    revision: row.revision,
    occurredAt: row.occurred_at,
    data: {
      expression: row.roll_expression,
      normalized,
      terms,
      modifier: row.roll_modifier,
      total: row.roll_total,
    },
  });
  if (event.type !== "actor_dice_rolled") throw new Error("campaign event audit record is incomplete");

  // The shared schema permits either equal-valued tied term to be retained.
  // Persistence requires the evaluator's stable earlier-physical-index choice.
  const keepCount = event.data.normalized.selection.type === "keep_highest"
    || event.data.normalized.selection.type === "keep_lowest"
    ? event.data.normalized.selection.count
    : event.data.normalized.selection.type === "all" ? event.data.normalized.count : 1;
  const keepHigh = event.data.normalized.selection.type === "keep_highest"
    || event.data.normalized.selection.type === "advantage";
  const expectedKept = new Set(event.data.terms.map((_, index) => index).sort((left, right) => {
    if (event.data.normalized.selection.type === "all") return left - right;
    const difference = keepHigh
      ? event.data.terms[right]!.value - event.data.terms[left]!.value
      : event.data.terms[left]!.value - event.data.terms[right]!.value;
    return difference === 0 ? left - right : difference;
  }).slice(0, keepCount));
  if (event.data.terms.some((term, index) => term.kept !== expectedKept.has(index))) {
    throw new Error("campaign event audit record is incomplete");
  }
  return event;
}

function listCampaignEventsSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  timelineId: string,
  recentDiceOnly = false,
): RpgEvent[] {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const normalizedCampaignId = resourceIdSchema.parse(campaignId);
  const normalizedTimelineId = resourceIdSchema.parse(timelineId);
  const derived = db.prepare(`SELECT h.parent_timeline_id,
      (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
        WHERE imported.campaign_id=h.campaign_id AND imported.timeline_id=h.timeline_id) AS imported_count
    FROM campaign_timeline_history h WHERE h.campaign_id=? AND h.timeline_id=?`)
    .get(normalizedCampaignId, normalizedTimelineId) as { parent_timeline_id: string | null; imported_count: number } | undefined;
  if (derived && (derived.parent_timeline_id !== null || derived.imported_count > 0)) {
    const timelineState = getCampaignTimelineReadSync(db, principalId, normalizedCampaignId, normalizedTimelineId);
    if (!timelineState) return [];
    const linked = db.prepare(`SELECT link.revision,event.command_id FROM campaign_timeline_events link
      JOIN campaign_events event ON event.event_id=link.event_id
      WHERE link.campaign_id=? AND link.timeline_id=? ORDER BY link.revision`).all(normalizedCampaignId, normalizedTimelineId) as
      Array<{ revision: number; command_id: string }>;
    const events: RpgEvent[] = linked.map((link) => {
      const receipt = getCommandReceiptSync(db, principalId, normalizedCampaignId, link.command_id);
      if (!receipt || receipt.events.length !== 1) throw new Error("campaign inherited event is incomplete");
      return rpgEventSchema.parse({ ...receipt.events[0], timelineId: normalizedTimelineId, revision: link.revision });
    });
    const imported = db.prepare(`SELECT * FROM campaign_imported_timeline_events
      WHERE campaign_id=? AND timeline_id=? ORDER BY revision`).all(normalizedCampaignId, normalizedTimelineId) as any[];
    for (const row of imported) events.push(rpgEventSchema.parse({ eventId: row.source_event_id,
      commandId: row.source_command_id, campaignId: normalizedCampaignId, timelineId: normalizedTimelineId,
      actorId: row.actor_id, sourceTurnId: row.source_turn_id, type: row.type, revision: row.revision,
      occurredAt: row.occurred_at, data: JSON.parse(row.public_data) }));
    events.sort((left, right) => left.revision - right.revision);
    if (events.length !== timelineState.revision || events.some((event, index) => event.revision !== index + 1))
      throw new Error("campaign inherited event history is incomplete");
    return recentDiceOnly ? events.filter((event) => event.type === "actor_dice_rolled").slice(-20).reverse() : events;
  }
  const auditIdentitySql = recentDiceOnly ? `
      SELECT campaign_id, command_id, timeline_id FROM campaign_events
      WHERE campaign_id = ? AND timeline_id = ? AND type = 'actor_dice_rolled'
      ORDER BY revision DESC, event_id DESC LIMIT 20` : `
      SELECT campaign_id, command_id, timeline_id FROM campaign_commands
      UNION
      SELECT campaign_id, command_id, timeline_id FROM campaign_events
      UNION
      SELECT orphan_receipt.campaign_id, orphan_receipt.command_id, ? AS timeline_id
        FROM command_receipts orphan_receipt
        WHERE NOT EXISTS (SELECT 1 FROM campaign_commands known_command
            WHERE known_command.campaign_id=orphan_receipt.campaign_id
              AND known_command.command_id=orphan_receipt.command_id)
          AND NOT EXISTS (SELECT 1 FROM campaign_events known_event
            WHERE known_event.campaign_id=orphan_receipt.campaign_id
              AND known_event.command_id=orphan_receipt.command_id)
      UNION
      SELECT orphan_roll.campaign_id, orphan_roll.command_id, ? AS timeline_id
        FROM rpg_dice_rolls orphan_roll
        WHERE NOT EXISTS (SELECT 1 FROM campaign_commands known_command
            WHERE known_command.campaign_id=orphan_roll.campaign_id
              AND known_command.command_id=orphan_roll.command_id)
          AND NOT EXISTS (SELECT 1 FROM campaign_events known_event
            WHERE known_event.campaign_id=orphan_roll.campaign_id
              AND known_event.command_id=orphan_roll.command_id)`;
  const rows = db.prepare(`SELECT
      audit_identity.command_id AS audit_command_id,
      command.command_id AS command_presence,
      event.event_id AS event_presence,
      receipt.command_id AS receipt_presence,
      requested_timeline.id AS requested_timeline_presence,
      event_timeline.id AS event_timeline_presence,
      event_timeline.revision AS event_timeline_revision,
      ((SELECT COUNT(*) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = event.campaign_id
          AND timeline_event.timeline_id = event.timeline_id)
        + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
          WHERE imported.campaign_id=event.campaign_id AND imported.timeline_id=event.timeline_id)) AS event_timeline_event_count,
      requested_timeline.revision AS requested_timeline_revision,
      ((SELECT COUNT(*) FROM campaign_commands invalid_command
          WHERE invalid_command.campaign_id=membership.campaign_id AND NOT EXISTS (
            SELECT 1 FROM campaign_commands command WHERE command.campaign_id=invalid_command.campaign_id
              AND command.command_id=invalid_command.command_id AND (${VALID_AUDIT_COMMAND})))
        + (SELECT COUNT(*) FROM campaign_events invalid_event
          WHERE invalid_event.campaign_id=membership.campaign_id AND NOT EXISTS (
            SELECT 1 FROM campaign_events event WHERE event.campaign_id=invalid_event.campaign_id
              AND event.event_id=invalid_event.event_id AND (${VALID_AUDIT_EVENT})))
        + (SELECT COUNT(*) FROM command_receipts receipt WHERE receipt.campaign_id=membership.campaign_id
          AND COALESCE((typeof(receipt.revision_before)='integer'
            AND receipt.revision_before BETWEEN 0 AND 9007199254740990
            AND typeof(receipt.revision_after)='integer' AND receipt.revision_after=receipt.revision_before+1
            AND EXISTS (SELECT 1 FROM campaign_commands command WHERE command.campaign_id=receipt.campaign_id
              AND command.command_id=receipt.command_id AND command.expected_revision=receipt.revision_before)
            AND EXISTS (SELECT 1 FROM campaign_events event WHERE event.campaign_id=receipt.campaign_id
              AND event.command_id=receipt.command_id AND event.event_id=receipt.event_id
              AND event.revision=receipt.revision_after)),0)<>1)
        + (SELECT COUNT(*) FROM rpg_dice_rolls invalid_roll WHERE invalid_roll.campaign_id=membership.campaign_id
          AND NOT EXISTS (SELECT 1 FROM rpg_dice_rolls roll WHERE roll.event_id=invalid_roll.event_id
            AND (${VALID_DICE_ROLL})))
        + (SELECT COUNT(*) FROM rpg_dice_terms term
          WHERE NOT EXISTS (SELECT 1 FROM rpg_dice_rolls parent WHERE parent.event_id=term.event_id)
            AND (EXISTS (SELECT 1 FROM campaign_events event WHERE event.campaign_id=membership.campaign_id
                AND event.event_id=term.event_id)
              OR EXISTS (SELECT 1 FROM command_receipts receipt WHERE receipt.campaign_id=membership.campaign_id
                AND receipt.event_id=term.event_id)))) AS invalid_audit_count,
      (SELECT COUNT(*) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = membership.campaign_id
          AND timeline_event.timeline_id = ?) AS requested_timeline_event_count,
      (SELECT MIN(timeline_event.revision) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = membership.campaign_id
          AND timeline_event.timeline_id = ?) AS requested_timeline_min_revision,
      (SELECT MAX(timeline_event.revision) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = membership.campaign_id
          AND timeline_event.timeline_id = ?) AS requested_timeline_max_revision,
      event_actor.id AS event_actor_presence,
      (SELECT COUNT(*) FROM rpg_dice_terms attributable_term
        WHERE attributable_term.event_id = event.event_id) AS attributable_term_count,
      event.event_id, event.command_id, event.campaign_id, event.timeline_id, event.actor_id,
      event.source_turn_id, event.type, event.revision, event.occurred_at,
      event.attribute_id, event.value_before, event.value_after,
      event.resource_name, event.resource_current, event.resource_max,
      (SELECT COUNT(*) FROM rpg_dice_rolls attributable_roll
        WHERE attributable_roll.event_id = event.event_id OR (
          attributable_roll.campaign_id = audit_identity.campaign_id
          AND attributable_roll.command_id = audit_identity.command_id)) AS attributable_roll_count,
      roll.event_id AS roll_event_id, roll.campaign_id AS roll_campaign_id,
      roll.command_id AS roll_command_id, roll.expression AS roll_expression,
      roll.dice_count AS roll_dice_count, roll.dice_sides AS roll_dice_sides,
      roll.selection_type AS roll_selection_type, roll.selection_count AS roll_selection_count,
      roll.modifier AS roll_modifier, roll.total AS roll_total,
      term.event_id AS term_event_id, term.position AS term_position,
      term.value AS term_value, term.kept AS term_kept
    FROM campaign_memberships membership
    JOIN principals principal ON principal.id = membership.principal_id
    JOIN campaigns campaign ON campaign.id = membership.campaign_id
    LEFT JOIN (${auditIdentitySql}) audit_identity
      ON audit_identity.campaign_id = membership.campaign_id AND audit_identity.timeline_id = ?
    LEFT JOIN campaign_timelines requested_timeline
      ON requested_timeline.campaign_id = membership.campaign_id
        AND requested_timeline.id = ?
    LEFT JOIN campaign_events event
      ON event.campaign_id = audit_identity.campaign_id
        AND event.command_id = audit_identity.command_id AND event.timeline_id = audit_identity.timeline_id
    LEFT JOIN rpg_dice_rolls roll
      ON roll.event_id = event.event_id OR (
        roll.campaign_id = audit_identity.campaign_id AND roll.command_id = audit_identity.command_id)
    LEFT JOIN rpg_dice_terms term ON term.event_id = roll.event_id
    LEFT JOIN campaign_commands command
      ON command.campaign_id = audit_identity.campaign_id AND command.command_id = audit_identity.command_id
        AND command.timeline_id = audit_identity.timeline_id AND command.actor_id = event.actor_id
        AND command.source_turn_id IS event.source_turn_id
        AND command.expected_revision + 1 = event.revision
        AND ((command.type = 'set_actor_attribute' AND event.type = 'actor_attribute_set'
            AND command.attribute_id = event.attribute_id AND command.value = event.value_after
            AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
            AND command.dice_expression IS NULL
            AND event.resource_name IS NULL AND event.resource_current IS NULL AND event.resource_max IS NULL
            AND roll.event_id IS NULL)
          OR (command.type = 'initialize_actor_resource' AND event.type = 'actor_resource_initialized'
            AND command.attribute_id IS NULL AND command.value IS NULL AND command.dice_expression IS NULL
            AND event.attribute_id IS NULL AND event.value_before IS NULL AND event.value_after IS NULL
            AND command.resource_name = event.resource_name
            AND command.resource_current = event.resource_current AND command.resource_max = event.resource_max
            AND roll.event_id IS NULL)
          OR (command.type = 'roll_actor_dice' AND event.type = 'actor_dice_rolled'
            AND command.attribute_id IS NULL AND command.value IS NULL
            AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
            AND event.attribute_id IS NULL AND event.value_before IS NULL AND event.value_after IS NULL
            AND event.resource_name IS NULL AND event.resource_current IS NULL AND event.resource_max IS NULL
            AND roll.event_id = event.event_id AND roll.campaign_id = event.campaign_id
            AND roll.command_id = event.command_id AND command.dice_expression = roll.expression
            AND command.dice_count = roll.dice_count AND command.dice_sides = roll.dice_sides
            AND command.dice_selection_type = roll.selection_type
            AND command.dice_selection_count IS roll.selection_count
            AND command.dice_modifier = roll.modifier))
        AND length(command.idempotency_key) BETWEEN 1 AND 128
        AND command.idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    LEFT JOIN command_receipts receipt
      ON receipt.campaign_id = audit_identity.campaign_id AND receipt.command_id = audit_identity.command_id
        AND receipt.event_id = event.event_id AND receipt.revision_after = event.revision
        AND receipt.revision_before + 1 = receipt.revision_after
        AND receipt.revision_before = command.expected_revision
    LEFT JOIN campaign_timelines event_timeline
      ON event_timeline.campaign_id = event.campaign_id AND event_timeline.id = event.timeline_id
    LEFT JOIN campaign_actors event_actor
      ON event_actor.campaign_id = event.campaign_id AND event_actor.id = event.actor_id
    WHERE membership.principal_id = ? AND membership.campaign_id = ?
      AND (membership.role IN ('gm', 'player', 'observer') OR (
        membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
      ))
    ORDER BY event.revision ${recentDiceOnly ? "DESC" : "ASC"},
      event.event_id ${recentDiceOnly ? "DESC" : "ASC"}, term.position ASC`)
    .all(normalizedTimelineId, normalizedTimelineId, normalizedTimelineId,
      ...(recentDiceOnly
        ? [normalizedCampaignId, normalizedTimelineId]
        : [normalizedTimelineId, normalizedTimelineId]),
      normalizedTimelineId, normalizedTimelineId,
      principalId, normalizedCampaignId) as DiceCampaignEventReadRow[];
  if (rows.length === 0) return [];
  const first = rows[0]!;
  if (first.requested_timeline_presence === null) {
    if (rows.some((row) => row.audit_command_id !== null)) {
      throw new Error("campaign event audit record is incomplete");
    }
    return [];
  }
  const timelineRevision = revisionSchema.parse(first.requested_timeline_revision);
  const eventCount = revisionSchema.parse(first.requested_timeline_event_count);
  const completeHistory = eventCount === timelineRevision && (timelineRevision === 0
    ? first.requested_timeline_min_revision === null && first.requested_timeline_max_revision === null
    : first.requested_timeline_min_revision === 1
      && first.requested_timeline_max_revision === timelineRevision);
  if (!completeHistory || revisionSchema.parse(first.invalid_audit_count) !== 0
      || rows.some((row) => row.requested_timeline_presence !== first.requested_timeline_presence
      || row.requested_timeline_revision !== first.requested_timeline_revision
      || row.requested_timeline_event_count !== first.requested_timeline_event_count
      || row.requested_timeline_min_revision !== first.requested_timeline_min_revision
      || row.requested_timeline_max_revision !== first.requested_timeline_max_revision
      || row.invalid_audit_count !== first.invalid_audit_count)) {
    throw new Error("campaign event audit record is incomplete");
  }
  if (first.audit_command_id === null) return [];

  const events: RpgEvent[] = [];
  for (let start = 0; start < rows.length;) {
    const identity = rows[start]!.audit_command_id;
    let end = start + 1;
    while (end < rows.length && rows[end]!.audit_command_id === identity) end += 1;
    const eventRows = rows.slice(start, end);
    events.push(eventRows[0]!.type === "actor_dice_rolled"
      ? diceEventFromReadRows(eventRows)
      : eventFromReadRow(eventRows[0]!));
    start = end;
  }
  return events;
}

export function listRecentCampaignDiceEventsSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  timelineId: string,
): CampaignDiceEvent[] {
  const events = listCampaignEventsSync(db, actorPrincipalId, campaignId, timelineId, true);
  if (events.some((event) => event.type !== "actor_dice_rolled")) {
    throw new Error("campaign event audit record is incomplete");
  }
  return events as CampaignDiceEvent[];
}

export function getCommandReceiptSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  commandId: string,
): CommandReceipt | null {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const normalizedCampaignId = resourceIdSchema.parse(campaignId);
  const normalizedCommandId = resourceIdSchema.parse(commandId);
  const rows = db.prepare(`SELECT
      audit_identity.command_id AS audit_command_id,
      command.command_id AS command_presence,
      event.event_id AS event_presence,
      receipt.command_id AS receipt_presence,
      requested_timeline.id AS requested_timeline_presence,
      event_timeline.id AS event_timeline_presence,
      event_timeline.revision AS event_timeline_revision,
      ((SELECT COUNT(*) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = event.campaign_id
          AND timeline_event.timeline_id = event.timeline_id)
        + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
          WHERE imported.campaign_id=event.campaign_id AND imported.timeline_id=event.timeline_id)) AS event_timeline_event_count,
      requested_timeline.revision AS requested_timeline_revision,
      ((SELECT COUNT(*) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = event.campaign_id
          AND timeline_event.timeline_id = event.timeline_id)
        + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
          WHERE imported.campaign_id=event.campaign_id AND imported.timeline_id=event.timeline_id)) AS requested_timeline_event_count,
      (SELECT MIN(revision) FROM (SELECT revision FROM campaign_timeline_events timeline_event
          WHERE timeline_event.campaign_id=event.campaign_id AND timeline_event.timeline_id=event.timeline_id
        UNION ALL SELECT revision FROM campaign_imported_timeline_events imported
          WHERE imported.campaign_id=event.campaign_id AND imported.timeline_id=event.timeline_id)) AS requested_timeline_min_revision,
      (SELECT MAX(revision) FROM (SELECT revision FROM campaign_timeline_events timeline_event
          WHERE timeline_event.campaign_id=event.campaign_id AND timeline_event.timeline_id=event.timeline_id
        UNION ALL SELECT revision FROM campaign_imported_timeline_events imported
          WHERE imported.campaign_id=event.campaign_id AND imported.timeline_id=event.timeline_id)) AS requested_timeline_max_revision,
      event_actor.id AS event_actor_presence,
      (SELECT COUNT(*) FROM rpg_dice_terms attributable_term
        WHERE attributable_term.event_id = event.event_id) AS attributable_term_count,
      receipt.revision_before, receipt.revision_after,
      event.event_id, event.command_id, event.campaign_id, event.timeline_id, event.actor_id,
      event.source_turn_id, event.type, event.revision, event.occurred_at,
      event.attribute_id, event.value_before, event.value_after,
      event.resource_name, event.resource_current, event.resource_max,
      (SELECT COUNT(*) FROM rpg_dice_rolls attributable_roll
        WHERE attributable_roll.event_id = event.event_id OR (
          attributable_roll.campaign_id = audit_identity.campaign_id
          AND attributable_roll.command_id = audit_identity.command_id)) AS attributable_roll_count,
      roll.event_id AS roll_event_id, roll.campaign_id AS roll_campaign_id,
      roll.command_id AS roll_command_id, roll.expression AS roll_expression,
      roll.dice_count AS roll_dice_count, roll.dice_sides AS roll_dice_sides,
      roll.selection_type AS roll_selection_type, roll.selection_count AS roll_selection_count,
      roll.modifier AS roll_modifier, roll.total AS roll_total,
      term.event_id AS term_event_id, term.position AS term_position,
      term.value AS term_value, term.kept AS term_kept
    FROM campaign_memberships membership
    JOIN principals principal ON principal.id = membership.principal_id
    JOIN campaigns campaign ON campaign.id = membership.campaign_id
    JOIN (
      SELECT campaign_id, command_id FROM campaign_commands
      UNION
      SELECT campaign_id, command_id FROM campaign_events
      UNION
      SELECT campaign_id, command_id FROM command_receipts
      UNION
      SELECT campaign_id, command_id FROM rpg_dice_rolls
    ) audit_identity
      ON audit_identity.campaign_id = membership.campaign_id AND audit_identity.command_id = ?
    LEFT JOIN campaign_events event
      ON event.campaign_id = audit_identity.campaign_id AND event.command_id = audit_identity.command_id
    LEFT JOIN rpg_dice_rolls roll
      ON roll.event_id = event.event_id OR (
        roll.campaign_id = audit_identity.campaign_id AND roll.command_id = audit_identity.command_id)
    LEFT JOIN rpg_dice_terms term ON term.event_id = roll.event_id
    LEFT JOIN campaign_commands command
      ON command.campaign_id = audit_identity.campaign_id AND command.command_id = audit_identity.command_id
        AND command.timeline_id = event.timeline_id AND command.actor_id = event.actor_id
        AND command.source_turn_id IS event.source_turn_id
        AND command.expected_revision + 1 = event.revision
        AND ((command.type = 'set_actor_attribute' AND event.type = 'actor_attribute_set'
            AND command.attribute_id = event.attribute_id AND command.value = event.value_after
            AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
            AND command.dice_expression IS NULL
            AND event.resource_name IS NULL AND event.resource_current IS NULL AND event.resource_max IS NULL
            AND roll.event_id IS NULL)
          OR (command.type = 'initialize_actor_resource' AND event.type = 'actor_resource_initialized'
            AND command.attribute_id IS NULL AND command.value IS NULL AND command.dice_expression IS NULL
            AND event.attribute_id IS NULL AND event.value_before IS NULL AND event.value_after IS NULL
            AND command.resource_name = event.resource_name
            AND command.resource_current = event.resource_current AND command.resource_max = event.resource_max
            AND roll.event_id IS NULL)
          OR (command.type = 'roll_actor_dice' AND event.type = 'actor_dice_rolled'
            AND command.attribute_id IS NULL AND command.value IS NULL
            AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
            AND event.attribute_id IS NULL AND event.value_before IS NULL AND event.value_after IS NULL
            AND event.resource_name IS NULL AND event.resource_current IS NULL AND event.resource_max IS NULL
            AND roll.event_id = event.event_id AND roll.campaign_id = event.campaign_id
            AND roll.command_id = event.command_id AND command.dice_expression = roll.expression
            AND command.dice_count = roll.dice_count AND command.dice_sides = roll.dice_sides
            AND command.dice_selection_type = roll.selection_type
            AND command.dice_selection_count IS roll.selection_count
            AND command.dice_modifier = roll.modifier))
        AND length(command.idempotency_key) BETWEEN 1 AND 128
        AND command.idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    LEFT JOIN command_receipts receipt
      ON receipt.campaign_id = audit_identity.campaign_id AND receipt.command_id = audit_identity.command_id
        AND receipt.revision_before = command.expected_revision
        AND receipt.revision_after = command.expected_revision + 1
        AND receipt.event_id = event.event_id AND receipt.revision_after = event.revision
    LEFT JOIN campaign_timelines requested_timeline
      ON requested_timeline.campaign_id = event.campaign_id AND requested_timeline.id = event.timeline_id
    LEFT JOIN campaign_timelines event_timeline
      ON event_timeline.campaign_id = event.campaign_id AND event_timeline.id = event.timeline_id
    LEFT JOIN campaign_actors event_actor
      ON event_actor.campaign_id = event.campaign_id AND event_actor.id = event.actor_id
    WHERE membership.principal_id = ? AND membership.campaign_id = ?
      AND (membership.role IN ('gm', 'player', 'observer') OR (
        membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
      ))
    ORDER BY term.position ASC`)
    .all(normalizedCommandId, principalId, normalizedCampaignId) as CommandReceiptReadRow[];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (
    row.receipt_presence === null || row.revision_before === null || row.revision_after === null
    || row.event_id === null || row.audit_command_id !== normalizedCommandId
    || row.requested_timeline_presence === null || row.event_timeline_presence === null
  ) {
    throw new Error("command receipt audit record is incomplete");
  }
  const timelineRevision = revisionSchema.parse(row.requested_timeline_revision);
  const timelineEventCount = revisionSchema.parse(row.requested_timeline_event_count);
  const completeHistory = timelineEventCount === timelineRevision && (timelineRevision === 0
    ? row.requested_timeline_min_revision === null && row.requested_timeline_max_revision === null
    : row.requested_timeline_min_revision === 1 && row.requested_timeline_max_revision === timelineRevision);
  if (!completeHistory || rows.some((candidate) =>
      candidate.audit_command_id !== row.audit_command_id
      || candidate.revision_before !== row.revision_before || candidate.revision_after !== row.revision_after
      || candidate.requested_timeline_presence !== row.requested_timeline_presence
      || candidate.requested_timeline_revision !== row.requested_timeline_revision
      || candidate.requested_timeline_event_count !== row.requested_timeline_event_count
      || candidate.requested_timeline_min_revision !== row.requested_timeline_min_revision
      || candidate.requested_timeline_max_revision !== row.requested_timeline_max_revision)) {
    throw new Error("command receipt audit record is incomplete");
  }
  const event = row.type === "actor_dice_rolled" ? diceEventFromReadRows(rows) : eventFromReadRow(row);
  return commandReceiptSchema.parse({
    commandId: normalizedCommandId,
    campaignId: normalizedCampaignId,
    revisionBefore: row.revision_before,
    revisionAfter: row.revision_after,
    events: [event],
  });
}

function requireOriginalStarterInspectionForWrite(
  inspectionRepository: OriginalStarterSetupInspectionRepository,
  actorId: string,
  campaignId: string,
  operation: "install" | "configure",
): OriginalStarterSetupInspection {
  const inspection = inspectionRepository.inspectOriginalStarterSetup(actorId, campaignId);
  if (inspection.status === "unavailable") {
    if (operation === "install") throw new ContentPackInstallationAuthorizationError();
    throw new CampaignContentConfigurationAuthorizationError();
  }
  if (inspection.status === "conflict") {
    if (operation === "install") {
      throw new ContentPackInstallationConflictError("original starter reserved identities conflict");
    }
    throw new CampaignContentConfigurationConflictError("original starter reserved identities conflict");
  }
  return inspection;
}

function installContentPackSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  input: InstallContentPackInput,
  originalStarterCampaignId?: string,
  originalStarterSetupInspectionRepository?: OriginalStarterSetupInspectionRepository,
): ContentPack {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const starterCampaignId = originalStarterCampaignId === undefined
    ? undefined
    : resourceIdSchema.parse(originalStarterCampaignId);
  const normalized = installContentPackInputSchema.parse(input);
  const definitions: RpgDefinition[] = [
    ...normalized.classes,
    ...normalized.races,
    ...normalized.backgrounds,
    ...normalized.items,
    ...normalized.spells,
    ...normalized.abilities,
    ...normalized.enemies,
  ];
  const contentPack = contentPackSchema.parse({
    packId: normalized.packId,
    packVersion: normalized.packVersion,
    rulesProfileId: normalized.rulesProfileId,
    name: normalized.name,
    description: normalized.description,
    tags: normalized.tags,
  });

  return db.transaction(() => {
    if (starterCampaignId !== undefined) {
      // Full authority, campaign configuration, reserved profile, every pack
      // version, and every expected/captured definition are checked after the
      // IMMEDIATE lock is acquired, before any generic install decisions.
      requireOriginalStarterInspectionForWrite(
        originalStarterSetupInspectionRepository!, actorId, starterCampaignId, "install",
      );
    } else {
      // Preserve the generic installation API's established authorization.
      const owner = db.prepare("SELECT principal_id FROM application_owner WHERE singleton = 1").get() as
        | { principal_id: string }
        | undefined;
      if (!owner || owner.principal_id !== actorId) {
        throw new ContentPackInstallationAuthorizationError();
      }
    }

    const profileRow = db.prepare(`SELECT rules_profile_id, name, description, tags
      FROM rpg_rules_profiles WHERE rules_profile_id = ?`)
      .get(normalized.rulesProfileId) as RulesProfileRow | undefined;
    if (profileRow && !sameMetadata(toRulesProfile(profileRow), normalized.rulesProfile)) {
      throw new ContentPackInstallationConflictError("rules profile metadata conflicts with the installed profile");
    }

    const packRow = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags, sealed
      FROM rpg_content_packs WHERE pack_id = ? AND pack_version = ?`)
      .get(normalized.packId, normalized.packVersion) as ContentPackRow | undefined;
    if (packRow) {
      if ((packRow as ContentPackRow & { sealed: number }).sealed !== 1) {
        throw new ContentPackInstallationConflictError("content pack installation conflicts with an incomplete pack");
      }
      const installedPack = toContentPack(packRow);
      if (installedPack.rulesProfileId !== normalized.rulesProfileId || !sameMetadata(installedPack, contentPack)) {
        throw new ContentPackInstallationConflictError("content pack metadata conflicts with the installed pack");
      }
      const rows = db.prepare(`SELECT kind, definition_id, name, description, tags
        FROM rpg_definitions WHERE pack_id = ? AND pack_version = ?`)
        .all(normalized.packId, normalized.packVersion) as RpgDefinitionRow[];
      const installed = new Map(rows.map((row) => {
        const definition = toRpgDefinition(row);
        return [`${definition.kind}:${definition.definitionId}`, definition];
      }));
      const equivalent = installed.size === definitions.length && definitions.every((definition) => {
        const persisted = installed.get(`${definition.kind}:${definition.definitionId}`);
        return persisted !== undefined && sameMetadata(persisted, definition);
      });
      if (!equivalent) {
        throw new ContentPackInstallationConflictError("content pack definitions conflict with the installed pack");
      }
      return installedPack;
    }

    // This is deliberately the last statement before the first global write.
    // BEGIN IMMEDIATE prevents either authority from changing afterward.
    if (starterCampaignId !== undefined) {
      requireOriginalStarterInspectionForWrite(
        originalStarterSetupInspectionRepository!, actorId, starterCampaignId, "install",
      );
    }
    if (!profileRow) {
      db.prepare(`INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags)
        VALUES (?, ?, ?, ?)`)
        .run(
          normalized.rulesProfileId,
          normalized.rulesProfile.name,
          normalized.rulesProfile.description,
          JSON.stringify(normalized.rulesProfile.tags),
        );
    }
    db.prepare(`INSERT INTO rpg_content_packs
      (pack_id, pack_version, rules_profile_id, name, description, tags, sealed) VALUES (?, ?, ?, ?, ?, ?, 0)`)
      .run(
        contentPack.packId,
        contentPack.packVersion,
        contentPack.rulesProfileId,
        contentPack.name,
        contentPack.description,
        JSON.stringify(contentPack.tags),
      );
    const insertDefinition = db.prepare(`INSERT INTO rpg_definitions
      (pack_id, pack_version, kind, definition_id, name, description, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const definition of definitions) {
      insertDefinition.run(
        contentPack.packId,
        contentPack.packVersion,
        definition.kind,
        definition.definitionId,
        definition.name,
        definition.description,
        JSON.stringify(definition.tags),
      );
    }
    db.prepare(`UPDATE rpg_content_packs SET sealed = 1
      WHERE pack_id = ? AND pack_version = ? AND sealed = 0`)
      .run(contentPack.packId, contentPack.packVersion);
    db.prepare(`INSERT INTO rpg_content_pack_publications
      (pack_id,pack_version,validation_level,rules_engine,manifest_digest,manifest_json,provenance_json,
       validation_report_json,published_by_principal_id,published_at)
      VALUES (?,?,'legacy-v10',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`)
      .run(contentPack.packId, contentPack.packVersion);
    return contentPack;
  }).immediate();
}

interface CampaignContentPinRow {
  pack_id: string;
  pack_version: string;
  rules_profile_id: string;
}

function configureCampaignContentSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  input: ConfigureCampaignContentInput,
  requireOriginalStarterAuthority = false,
  originalStarterSetupInspectionRepository?: OriginalStarterSetupInspectionRepository,
): CampaignContentConfiguration {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const normalized = configureCampaignContentInputSchema.parse(input);
  const projection = () => campaignContentConfigurationSchema.parse({
    campaignId: id,
    rulesProfileId: normalized.rulesProfileId,
    contentPacks: [...normalized.contentPacks].sort((left, right) =>
      (left.packId < right.packId ? -1 : left.packId > right.packId ? 1 : 0)
      || (left.packVersion < right.packVersion ? -1 : left.packVersion > right.packVersion ? 1 : 0)),
  });

  return db.transaction(() => {
    if (requireOriginalStarterAuthority) {
      requireOriginalStarterInspectionForWrite(
        originalStarterSetupInspectionRepository!, actorId, id, "configure",
      );
    }
    const campaign = db.prepare("SELECT owner_principal_id FROM campaigns WHERE id = ?").get(id) as
      | { owner_principal_id: string }
      | undefined;
    if (!campaign) throw new CampaignContentConfigurationAuthorizationError("campaign not found");
    if (campaign.owner_principal_id !== actorId) {
      throw new CampaignContentConfigurationAuthorizationError("campaign content configuration requires the campaign owner");
    }
    if (!db.prepare(`SELECT 1 FROM campaign_memberships
      WHERE campaign_id = ? AND principal_id = ? AND role = 'owner'`).get(id, actorId)) {
      throw new CampaignContentConfigurationAuthorizationError("malformed campaign ownership");
    }

    const selectedProfile = db.prepare(`SELECT campaign_id, rules_profile_id
      FROM campaign_rules_profiles WHERE campaign_id = ?`).get(id) as
      | { campaign_id: string; rules_profile_id: string }
      | undefined;
    const pinRows = db.prepare(`SELECT pack_id, pack_version, rules_profile_id
      FROM campaign_content_packs WHERE campaign_id = ? ORDER BY rowid ASC`).all(id) as CampaignContentPinRow[];

    if (selectedProfile || pinRows.length > 0) {
      if (!selectedProfile) throw new Error("malformed campaign content configuration");
      let existing: CampaignContentConfiguration;
      try {
        existing = campaignContentConfigurationSchema.parse({
          campaignId: selectedProfile.campaign_id,
          rulesProfileId: selectedProfile.rules_profile_id,
          contentPacks: pinRows.map((pin) => ({ packId: pin.pack_id, packVersion: pin.pack_version })),
        });
      } catch {
        throw new Error("malformed campaign content configuration");
      }
      const profileRow = db.prepare(`SELECT rules_profile_id, name, description, tags FROM rpg_rules_profiles
        WHERE rules_profile_id = ?`).get(existing.rulesProfileId) as RulesProfileRow | undefined;
      if (!profileRow || pinRows.some((pin) => pin.rules_profile_id !== existing.rulesProfileId)) {
        throw new Error("malformed campaign content configuration");
      }
      try {
        toRulesProfile(profileRow);
      } catch {
        throw new Error("malformed campaign content configuration");
      }
      const exactSealedPack = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags
        FROM rpg_content_packs
        WHERE pack_id = ? AND pack_version = ? AND rules_profile_id = ? AND sealed = 1`);
      for (const pack of existing.contentPacks) {
        const row = exactSealedPack.get(pack.packId, pack.packVersion, existing.rulesProfileId) as
          | ContentPackRow
          | undefined;
        try {
          if (!row) throw new Error();
          toContentPack(row);
        } catch {
          throw new Error("malformed campaign content configuration");
        }
      }

      const requestedPins = new Set(normalized.contentPacks.map((pack) => `${pack.packId}\u0000${pack.packVersion}`));
      const equivalent = existing.rulesProfileId === normalized.rulesProfileId
        && existing.contentPacks.length === normalized.contentPacks.length
        && existing.contentPacks.every((pack) => requestedPins.has(`${pack.packId}\u0000${pack.packVersion}`));
      if (!equivalent) throw new CampaignContentConfigurationConflictError();
      return projection();
    }

    const profileRow = db.prepare(`SELECT rules_profile_id, name, description, tags FROM rpg_rules_profiles
      WHERE rules_profile_id = ?`).get(normalized.rulesProfileId) as RulesProfileRow | undefined;
    if (!profileRow) {
      throw new Error("campaign content configuration unavailable");
    }
    toRulesProfile(profileRow);
    const exactSealedPack = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags
      FROM rpg_content_packs
      WHERE pack_id = ? AND pack_version = ? AND rules_profile_id = ? AND sealed = 1`);
    for (const pack of normalized.contentPacks) {
      const row = exactSealedPack.get(pack.packId, pack.packVersion, normalized.rulesProfileId) as
        | ContentPackRow
        | undefined;
      if (!row) {
        throw new Error("campaign content configuration unavailable");
      }
      toContentPack(row);
    }

    // Recheck both authority graphs after all dependency reads and directly
    // before the first configuration write. The IMMEDIATE lock closes the
    // remaining window through both profile and pin inserts.
    if (requireOriginalStarterAuthority) {
      requireOriginalStarterInspectionForWrite(
        originalStarterSetupInspectionRepository!, actorId, id, "configure",
      );
    }
    db.prepare(`INSERT INTO campaign_rules_profiles (campaign_id, rules_profile_id)
      VALUES (?, ?)`).run(id, normalized.rulesProfileId);
    const insertPin = db.prepare(`INSERT INTO campaign_content_packs
      (campaign_id, pack_id, pack_version, rules_profile_id) VALUES (?, ?, ?, ?)`);
    for (const pack of normalized.contentPacks) {
      insertPin.run(id, pack.packId, pack.packVersion, normalized.rulesProfileId);
    }
    return projection();
  }).immediate();
}

function listCampaignContentPackDefinitionsSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  identifier: ContentPackIdentifier,
): RpgDefinition[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const normalized = contentPackIdentifierSchema.parse(identifier);
  const rows = db.prepare(`SELECT ${DEFINITION_PROJECTION},cm.role access_role,publication.validation_level,
      publication.manifest_digest legacy_manifest_digest,attestation.definition_count,attestation.publication_digest,
      attestation.public_projection_digest,
      (SELECT json_group_array(json_object('kind',ordered.kind,'definition_id',ordered.definition_id,
        'public_definition_json',ordered.public_definition_json,'public_dependencies_json',ordered.public_dependencies_json,
        'private_dependencies_json',ordered.private_dependencies_json,'row_digest',ordered.row_digest,
        'publicly_reachable',ordered.publicly_reachable)) FROM
        (SELECT kind,definition_id,public_definition_json,public_dependencies_json,private_dependencies_json,row_digest,publicly_reachable
          FROM rpg_catalog_definition_visibility visibility WHERE visibility.pack_id=? AND visibility.pack_version=?
          ORDER BY visibility.kind COLLATE BINARY,visibility.definition_id COLLATE BINARY) ordered) visibility_rows_json
    FROM campaign_memberships cm
    JOIN campaign_content_packs cp ON cp.campaign_id = cm.campaign_id
      AND cp.pack_id = ? AND cp.pack_version = ?
    JOIN rpg_definitions d ON d.pack_id = cp.pack_id AND d.pack_version = cp.pack_version
    JOIN rpg_content_packs p ON p.pack_id = d.pack_id AND p.pack_version = d.pack_version AND p.sealed = 1
    LEFT JOIN rpg_content_pack_publications publication ON publication.pack_id=d.pack_id AND publication.pack_version=d.pack_version
    LEFT JOIN rpg_catalog_publication_attestations attestation ON attestation.pack_id=publication.pack_id
      AND attestation.pack_version=publication.pack_version
    WHERE cm.principal_id = ? AND cm.campaign_id = ?
    ORDER BY ${DEFINITION_ORDER}`).all(
      normalized.packId,
      normalized.packVersion,
      normalized.packId,
      normalized.packVersion,
      actorId,
      id,
    ) as Array<RpgDefinitionRow&{access_role:"owner"|"gm"|"player"|"observer";validation_level:string|null;
      legacy_manifest_digest:string|null;definition_count:number|null;publication_digest:string|null;
      public_projection_digest:string|null;visibility_rows_json:string}>;
  if(!rows.length)return[];
  const authority=rows[0]!;
  if (authority.validation_level !== "validated-v1") return rows.map(toRpgDefinition);
  let visible: Set<string>;
  try { visible=new Set(verifyCatalogVisibilityProjection({packId:normalized.packId,packVersion:normalized.packVersion,
    expectedCount:authority.definition_count!,manifestDigest:authority.legacy_manifest_digest!,publicationDigest:authority.publication_digest!,
    aggregateDigest:authority.public_projection_digest!,rows:JSON.parse(authority.visibility_rows_json) as PersistedCatalogVisibilityRow[]})
    .map((value)=>{const reference=(value as {reference:{kind:string;definitionId:string}}).reference;
      return `${reference.kind==="enemy-template"?"enemy":reference.kind}\0${reference.definitionId}`;})); }
  catch (error) {
    if (authority.access_role === "owner" || authority.access_role === "gm") throw error;
    return [];
  }
  const projected=authority.access_role === "owner" || authority.access_role === "gm" ? rows
    : rows.filter((row)=>visible.has(`${row.kind}\0${row.definition_id}`));
  return projected.map(toRpgDefinition);
}

function getCampaignContentPackDefinitionSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  reference: DefinitionReference,
): RpgDefinition | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const normalized = definitionReferenceSchema.parse(reference);
  const row = db.prepare(`SELECT ${DEFINITION_PROJECTION},cm.role access_role,publication.validation_level,
      publication.manifest_digest legacy_manifest_digest,attestation.definition_count,attestation.publication_digest,
      attestation.public_projection_digest,
      (SELECT json_group_array(json_object('kind',ordered.kind,'definition_id',ordered.definition_id,
        'public_definition_json',ordered.public_definition_json,'public_dependencies_json',ordered.public_dependencies_json,
        'private_dependencies_json',ordered.private_dependencies_json,'row_digest',ordered.row_digest,
        'publicly_reachable',ordered.publicly_reachable)) FROM
        (SELECT kind,definition_id,public_definition_json,public_dependencies_json,private_dependencies_json,row_digest,publicly_reachable
          FROM rpg_catalog_definition_visibility visibility WHERE visibility.pack_id=? AND visibility.pack_version=?
          ORDER BY visibility.kind COLLATE BINARY,visibility.definition_id COLLATE BINARY) ordered) visibility_rows_json
    FROM campaign_memberships cm
    JOIN campaign_content_packs cp ON cp.campaign_id = cm.campaign_id
      AND cp.pack_id = ? AND cp.pack_version = ?
    JOIN rpg_definitions d ON d.pack_id = cp.pack_id AND d.pack_version = cp.pack_version
      AND d.kind = ? AND d.definition_id = ?
    JOIN rpg_content_packs p ON p.pack_id = d.pack_id AND p.pack_version = d.pack_version AND p.sealed = 1
    LEFT JOIN rpg_content_pack_publications publication ON publication.pack_id=d.pack_id AND publication.pack_version=d.pack_version
    LEFT JOIN rpg_catalog_publication_attestations attestation ON attestation.pack_id=publication.pack_id
      AND attestation.pack_version=publication.pack_version
    WHERE cm.principal_id = ? AND cm.campaign_id = ?`).get(
      normalized.packId,
      normalized.packVersion,
      normalized.packId,
      normalized.packVersion,
      normalized.kind,
      normalized.definitionId,
      actorId,
      id,
    ) as (RpgDefinitionRow&{access_role:"owner"|"gm"|"player"|"observer";validation_level:string|null;
      legacy_manifest_digest:string|null;definition_count:number|null;publication_digest:string|null;
      public_projection_digest:string|null;visibility_rows_json:string})|undefined;
  if(!row)return null;
  if(row.validation_level==="validated-v1"){
    let visible:Set<string>;
    try{visible=new Set(verifyCatalogVisibilityProjection({packId:normalized.packId,packVersion:normalized.packVersion,
      expectedCount:row.definition_count!,manifestDigest:row.legacy_manifest_digest!,publicationDigest:row.publication_digest!,
      aggregateDigest:row.public_projection_digest!,rows:JSON.parse(row.visibility_rows_json) as PersistedCatalogVisibilityRow[]})
      .map((value)=>{const reference=(value as {reference:{kind:string;definitionId:string}}).reference;
        return `${reference.kind==="enemy-template"?"enemy":reference.kind}\0${reference.definitionId}`;}));}
    catch(error){if(row.access_role==="owner"||row.access_role==="gm")throw error;return null;}
    if(row.access_role!=="owner"&&row.access_role!=="gm"&&!visible.has(`${normalized.kind}\0${normalized.definitionId}`))return null;
  }
  return toRpgDefinition(row);
}

function createCampaignActorOperations(
  db: DatabaseDriver.Database,
  progressionRepository: CharacterProgressionRepository,
) {
  const characterCreationOptionsRepository = createCampaignCharacterCreationOptionsRepository(db);
  const characterRosterRepository = createCampaignCharacterRosterOperations(
    db,
    projectLegacyPersonaDisplayName,
  );
  const characterWorkspaceRepository = createCampaignCharacterWorkspaceRepository(db);
  const characterSheetSnapshotRepository = createCampaignCharacterSheetSnapshotRepository(
    db,
    progressionRepository,
    characterWorkspaceRepository,
  );
  return {
    getCampaignCharacterCreationOptions: (actor: string, campaignId: string) =>
      characterCreationOptionsRepository.getCampaignCharacterCreationOptions(actor, campaignId),
    getCampaignCharacterRoster: (actor: string, campaignId: string) =>
      characterRosterRepository.getCampaignCharacterRoster(actor, campaignId),
    getCampaignCharacterWorkspace: (actor: string, campaignId: string, campaignCharacterId: string) =>
      characterWorkspaceRepository.getCampaignCharacterWorkspace(actor, campaignId, campaignCharacterId),
    getCampaignCharacterSheetSnapshot: (actor: string, campaignId: string, campaignCharacterId: string) =>
      characterSheetSnapshotRepository.getCampaignCharacterSheetSnapshot(actor, campaignId, campaignCharacterId),
    ...createCampaignCharacterReadOperations(db),
  };
}

function runTransaction<T>(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
  callback: (repository: RepositoryUnitOfWork) => T,
): T {
  let active = true;
  const assertActive = () => {
    if (!active) throw new Error("transaction unit of work is no longer active");
  };
  const contentCatalogRepository = createContentCatalogRepository(db, dependencies.clock, () => {
    throw new Error("content catalog mutation cannot run inside a repository transaction");
  });
  const administrationRepository = createCampaignAdministrationRepository(db, dependencies, () => {
    throw new Error("campaign administration mutation cannot run inside a repository transaction");
  });
  const characterProgressionRepository = createCharacterProgressionRepository(db, dependencies, () => {
    throw new Error("character progression mutation cannot run inside a repository transaction");
  });
  const campaignActorRepository = createCampaignActorRepository(
    createCampaignActorOperations(db, characterProgressionRepository),
  );
  const campaignAccessRepository = createCampaignAccessRepository(db);
  const campaignEventProjectionRepository = createCampaignEventProjectionRepo({
    listCampaignEvents: (actor, campaignId, timelineId) => listCampaignEventsSync(db, actor, campaignId, timelineId),
  });
  const campaignActorResourceRepository = createCampaignActorResourceRepository(db);
  const campaignMembershipReadRepository = createCampaignMembershipReadRepository(db);
  const campaignSessionAttachmentReadRepository = createCampaignSessionAttachmentReadRepository(db);
  const campaignRoomLinkingSnapshotRepository = createCampaignRoomLinkingSnapshotRepository(db);
  const campaignContentConfigurationReadRepository = createCampaignContentConfigurationReadRepository(db);
  const campaignDetailReadRepository = createCampaignDetailReadRepository({
    getCampaign: (actor, campaignId) => campaignAccessRepository.getCampaign(actor, campaignId),
    getCampaignContentConfiguration: (actor, campaignId) =>
      campaignContentConfigurationReadRepository.getCampaignContentConfiguration(actor, campaignId),
  });
  const campaignGlobalContentReadRepository = createCampaignGlobalContentReadRepository(db);
  const campaignContentSelectionReadRepository = createCampaignContentSelectionReadRepository(db, {
    rulesProfileProjection: RULES_PROFILE_PROJECTION,
    contentPackProjection: CONTENT_PACK_PROJECTION,
    toRulesProfile,
    toContentPack,
  });
  const campaignContentDefinitionReadRepository = createCampaignContentDefinitionReadRepository(db, {
    definitionProjection: DEFINITION_PROJECTION, definitionOrder: DEFINITION_ORDER, toRpgDefinition,
    verifyCatalogVisibilityProjection,
  });
  const unitOfWork: RepositoryUnitOfWork = {
    getCampaignAdministration: (actorPrincipalId, campaignId) => {
      assertActive();
      return administrationRepository.getCampaignAdministration(actorPrincipalId, campaignId);
    },
    validateContentCatalog: (input) => {
      assertActive();
      return validateContentCatalog(input);
    },
    listContentCatalogPublications: (actorPrincipalId) => {
      assertActive();
      return contentCatalogRepository.listContentCatalogPublications(actorPrincipalId);
    },
    listContentCatalogPublicationPage: (actorPrincipalId, input) => {
      assertActive();
      return contentCatalogRepository.listContentCatalogPublicationPage(actorPrincipalId, input);
    },
    getContentCatalogForOwner: (actorPrincipalId, packId, packVersion) => {
      assertActive();
      return contentCatalogRepository.getContentCatalogForOwner(actorPrincipalId, packId, packVersion);
    },
    getCampaignContentCatalog: (actorPrincipalId, campaignId, packId, packVersion) => {
      assertActive();
      return contentCatalogRepository.getCampaignContentCatalog(actorPrincipalId, campaignId, packId, packVersion);
    },
    resolveCampaignCatalog: (actorPrincipalId, campaignId) => {
      assertActive();
      return contentCatalogRepository.resolveCampaignCatalog(actorPrincipalId, campaignId);
    },
    getCampaignCatalogReceipt: (actorPrincipalId, campaignId, commandId) => {
      assertActive();
      return contentCatalogRepository.getCampaignCatalogReceipt(actorPrincipalId, campaignId, commandId);
    },
    listCampaigns: (actorPrincipalId) => {
      assertActive();
      return campaignAccessRepository.listCampaigns(actorPrincipalId);
    },
    getCampaign: (actorPrincipalId, campaignId) => {
      assertActive();
      return campaignAccessRepository.getCampaign(actorPrincipalId, campaignId);
    },
    getCampaignDetail: (actorPrincipalId, campaignId) => {
      assertActive();
      // runTransaction owns the snapshot for all composed aggregate reads.
      return campaignDetailReadRepository.getCampaignDetail(actorPrincipalId, campaignId);
    },
    listCampaignTimelines: (actorPrincipalId, campaignId) => {
      assertActive();
      return listCampaignTimelinesReadSync(db, actorPrincipalId, campaignId);
    },
    getCampaignTimeline: (actorPrincipalId, campaignId, timelineId) => {
      assertActive();
      return getCampaignTimelineReadSync(db, actorPrincipalId, campaignId, timelineId);
    },
    listCampaignMemberships: (actorPrincipalId, campaignId) => {
      assertActive();
      return campaignMembershipReadRepository.listCampaignMemberships(actorPrincipalId, campaignId);
    },
    getCampaignMembership: (actorPrincipalId, campaignId, principalId) => {
      assertActive();
      return campaignMembershipReadRepository.getCampaignMembership(actorPrincipalId, campaignId, principalId);
    },
    listCampaignSessionAttachments: (actorPrincipalId, campaignId) => {
      assertActive();
      return campaignSessionAttachmentReadRepository.listCampaignSessionAttachments(actorPrincipalId, campaignId);
    },
    getCampaignSessionAttachment: (actorPrincipalId, campaignId, sessionId) => {
      assertActive();
      return campaignSessionAttachmentReadRepository.getCampaignSessionAttachment(actorPrincipalId, campaignId, sessionId);
    },
    getCampaignRoomLinkingSnapshot: (actorPrincipalId, campaignId) => {
      assertActive();
      return campaignRoomLinkingSnapshotRepository.getCampaignRoomLinkingSnapshot(actorPrincipalId, campaignId);
    },
    getCampaignContentConfiguration: (actorPrincipalId, campaignId) => {
      assertActive();
      return campaignContentConfigurationReadRepository.getCampaignContentConfiguration(actorPrincipalId, campaignId);
    },
    getCampaignCharacterCreationOptions: (actorPrincipalId, campaignId) => {
      assertActive();
      return campaignActorRepository.getCampaignCharacterCreationOptions(actorPrincipalId, campaignId);
    },
    getCampaignCharacterRoster: (actorPrincipalId, campaignId) => {
      assertActive();
      return campaignActorRepository.getCampaignCharacterRoster(actorPrincipalId, campaignId);
    },
    getCampaignCharacterWorkspace: (actorPrincipalId, campaignId, campaignCharacterId) => {
      assertActive();
      return campaignActorRepository.getCampaignCharacterWorkspace(actorPrincipalId, campaignId, campaignCharacterId);
    },
    getCampaignCharacterSheetSnapshot: (actorPrincipalId, campaignId, campaignCharacterId) => {
      assertActive();
      return campaignActorRepository.getCampaignCharacterSheetSnapshot(actorPrincipalId, campaignId, campaignCharacterId);
    },
    listActorResources: (actorPrincipalId, campaignId, actorId) => {
      assertActive();
      return campaignActorResourceRepository.listActorResources(actorPrincipalId, campaignId, actorId);
    },
    getActorResource: (actorPrincipalId, campaignId, actorId, name) => {
      assertActive();
      return campaignActorResourceRepository.getActorResource(actorPrincipalId, campaignId, actorId, name);
    },
    listCampaignEvents: (actorPrincipalId, campaignId, timelineId) => {
      assertActive();
      return listCampaignEventsSync(db, actorPrincipalId, campaignId, timelineId);
    },
    listPublicCampaignEvents: (actorPrincipalId, campaignId, timelineId, afterRevision, limit) => {
      assertActive();
      return campaignEventProjectionRepository.listPublicCampaignEvents(actorPrincipalId, campaignId, timelineId, afterRevision, limit);
    },
    listRecentCampaignDiceEvents: (actorPrincipalId, campaignId, timelineId) => {
      assertActive();
      return listRecentCampaignDiceEventsSync(db, actorPrincipalId, campaignId, timelineId);
    },
    getCommandReceipt: (actorPrincipalId, campaignId, commandId) => {
      assertActive();
      return getCommandReceiptSync(db, actorPrincipalId, campaignId, commandId);
    },
    listCampaignCharacters: (actorPrincipalId, campaignId) => {
      assertActive();
      return campaignActorRepository.listCampaignCharacters(actorPrincipalId, campaignId);
    },
    getCampaignCharacter: (actorPrincipalId, campaignId, campaignCharacterId) => {
      assertActive();
      return campaignActorRepository.getCampaignCharacter(actorPrincipalId, campaignId, campaignCharacterId);
    },
    getCampaignCharacterByActorId: (actorPrincipalId, campaignId, actorId) => {
      assertActive();
      return campaignActorRepository.getCampaignCharacterByActorId(actorPrincipalId, campaignId, actorId);
    },
    listRulesProfiles: (actorPrincipalId) => {
      assertActive();
      return campaignGlobalContentReadRepository.listRulesProfiles(actorPrincipalId);
    },
    getRulesProfile: (actorPrincipalId, identifier) => {
      assertActive();
      return campaignGlobalContentReadRepository.getRulesProfile(actorPrincipalId, identifier);
    },
    listContentPacks: (actorPrincipalId) => {
      assertActive();
      return campaignGlobalContentReadRepository.listContentPacks(actorPrincipalId);
    },
    getContentPack: (actorPrincipalId, identifier) => {
      assertActive();
      return campaignGlobalContentReadRepository.getContentPack(actorPrincipalId, identifier);
    },
    listContentPackDefinitions: (actorPrincipalId, identifier) => {
      assertActive();
      return campaignGlobalContentReadRepository.listContentPackDefinitions(actorPrincipalId, identifier);
    },
    getContentPackDefinition: (actorPrincipalId, reference) => {
      assertActive();
      return campaignGlobalContentReadRepository.getContentPackDefinition(actorPrincipalId, reference);
    },
    getCampaignRulesProfile: (actorPrincipalId, campaignId) => {
      assertActive();
      return campaignContentSelectionReadRepository.getCampaignRulesProfile(actorPrincipalId, campaignId);
    },
    listCampaignContentPacks: (actorPrincipalId, campaignId) => {
      assertActive();
      return campaignContentSelectionReadRepository.listCampaignContentPacks(actorPrincipalId, campaignId);
    },
    listCampaignContentPackDefinitions: (actorPrincipalId, campaignId, identifier) => {
      assertActive();
      return campaignContentDefinitionReadRepository.listCampaignContentPackDefinitions(actorPrincipalId, campaignId, identifier);
    },
    getCampaignContentPackDefinition: (actorPrincipalId, campaignId, reference) => {
      assertActive();
      return campaignContentDefinitionReadRepository.getCampaignContentPackDefinition(actorPrincipalId, campaignId, reference);
    },
    getSession: (id) => {
      assertActive();
      return getSessionSync(db, id);
    },
    transitionSession: (id, state, reason) => {
      assertActive();
      return transitionSessionSync(db, dependencies.clock, id, state, reason);
    },
    addConsentEvent: (sessionId, scope, granted, note) => {
      assertActive();
      return addConsentEventSync(db, dependencies, sessionId, scope, granted, note);
    },
  };
  try {
    return db.transaction(() => {
      const result = callback(unitOfWork);
      if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("repository transaction callbacks must be synchronous");
      }
      return result;
    })();
  } finally {
    active = false;
  }
}

export function createRepository(options: CreateRepositoryOptions = {}): Repository {
  const dependencies: RepositoryDependencies = {
    clock: options.clock ?? systemRuntime.clock,
    ids: options.ids ?? systemRuntime.ids,
    rng: options.rng ?? systemRuntime.rng,
  };
  const db = openRepositoryDatabase(path.resolve(options.dataDir ?? resolveDataDir()), dependencies);
  const campaignCommandWriteOperations = createCampaignCommandWriteOperations(db, dependencies);
  const campaignCommandRepository = createCampaignCommandRepository({
    executeRollActorDice: (actor, input) => campaignCommandWriteOperations.executeRollActorDice(actor, input),
    executeRollActorDiceForVisibleCharacter: (actor, input, binding) =>
      campaignCommandWriteOperations.executeRollActorDiceForVisibleCharacter(actor, input, binding),
    listRecentCampaignDiceEvents: (actor, campaignId, timelineId) =>
      listRecentCampaignDiceEventsSync(db, actor, campaignId, timelineId),
    getCommandReceipt: (actor, campaignId, commandId) =>
      getCommandReceiptSync(db, actor, campaignId, commandId),
  });
  const campaignCharacterWriteRepository = createCampaignCharacterWriteRepository({
    createCampaignCharacter: (actor, input) =>
      createCampaignCharacterSync(db, dependencies, actor, input).projection,
    createOriginalStarterCampaignCharacter: (actor, input) =>
      createCampaignCharacterSync(db, dependencies, actor, input, true),
  });
  const diceRepository = createDiceRepository(db, dependencies, campaignCommandRepository);
  const campaignAccessRepository = createCampaignAccessRepository(db);
  const campaignMembershipReadRepository = createCampaignMembershipReadRepository(db);
  const campaignSessionAttachmentReadRepository = createCampaignSessionAttachmentReadRepository(db);
  const campaignRoomLinkingSnapshotRepository = createCampaignRoomLinkingSnapshotRepository(db);
  const campaignRoomSessionLifecycleRepository = createCampaignRoomSessionLifecycleRepository(db);
  const campaignContentConfigurationReadRepository = createCampaignContentConfigurationReadRepository(db);
  const campaignDetailReadRepository = createCampaignDetailReadRepository({
    getCampaign: (actor, campaignId) => campaignAccessRepository.getCampaign(actor, campaignId),
    getCampaignContentConfiguration: (actor, campaignId) =>
      campaignContentConfigurationReadRepository.getCampaignContentConfiguration(actor, campaignId),
  });
  const originalStarterSetupInspectionRepository = createOriginalStarterSetupInspectionRepository(db, {
    getCampaign: (actor, campaignId) => campaignAccessRepository.getCampaign(actor, campaignId),
    getCampaignDetail: (actor, campaignId) => campaignDetailReadRepository.getCampaignDetail(actor, campaignId),
    toRulesProfile,
    toContentPack,
    toRpgDefinition,
    sameMetadata,
  });
  const campaignGlobalContentReadRepository = createCampaignGlobalContentReadRepository(db);
  const campaignContentSelectionReadRepository = createCampaignContentSelectionReadRepository(db, {
    rulesProfileProjection: RULES_PROFILE_PROJECTION,
    contentPackProjection: CONTENT_PACK_PROJECTION,
    toRulesProfile,
    toContentPack,
  });
  const campaignContentDefinitionReadRepository = createCampaignContentDefinitionReadRepository(db, {
    definitionProjection: DEFINITION_PROJECTION, definitionOrder: DEFINITION_ORDER, toRpgDefinition,
    verifyCatalogVisibilityProjection,
  });
  const campaignCoreRepository = createCampaignCoreRepository({
    createCampaign: (actor, input) => createCampaignCoreWriteSync(db, dependencies, actor, input),
    renameCampaign: (actor, campaignId, input) => renameCampaignCoreWriteSync(db, dependencies.clock, actor, campaignId, input),
    renameCampaignIfUnchanged: (actor, campaignId, input) =>
      renameCampaignIfUnchangedCoreWriteSync(db, dependencies.clock, actor, campaignId, input),
    addCampaignMembership: (actor, campaignId, input) =>
      addCampaignMembershipCoreWriteSync(db, dependencies.clock, actor, campaignId, input),
    attachCampaignSession: (actor, input) => attachCampaignSessionCoreWriteSync(db, dependencies.clock, actor, input),
    detachCampaignSession: (actor, input) => detachCampaignSessionCoreWriteSync(db, actor, input),
    listCampaigns: (actor) => campaignAccessRepository.listCampaigns(actor),
    getCampaign: (actor, campaignId) => campaignAccessRepository.getCampaign(actor, campaignId),
    listCampaignTimelines: (actor, campaignId) => listCampaignTimelinesReadSync(db, actor, campaignId),
    getCampaignTimeline: (actor, campaignId, timelineId) => getCampaignTimelineReadSync(db, actor, campaignId, timelineId),
    listCampaignMemberships: (actor, campaignId) => campaignMembershipReadRepository.listCampaignMemberships(actor, campaignId),
    getCampaignMembership: (actor, campaignId, principalId) =>
      campaignMembershipReadRepository.getCampaignMembership(actor, campaignId, principalId),
    listCampaignSessionAttachments: (actor, campaignId) =>
      campaignSessionAttachmentReadRepository.listCampaignSessionAttachments(actor, campaignId),
    getCampaignSessionAttachment: (actor, campaignId, sessionId) =>
      campaignSessionAttachmentReadRepository.getCampaignSessionAttachment(actor, campaignId, sessionId),
    getCampaignRoomLinkingSnapshot: (actor, campaignId) =>
      campaignRoomLinkingSnapshotRepository.getCampaignRoomLinkingSnapshot(actor, campaignId),
    getCampaignRoomSessionLifecycle: (sessionId) =>
      campaignRoomSessionLifecycleRepository.getCampaignRoomSessionLifecycle(sessionId),
  },
    (campaignId, actor, type, payload, result, occurredAt) =>
      recordCompatibilityAdministrationAuditCoreWrite(db, campaignId, actor, type, payload, result, occurredAt));
  const campaignLegacyCoreWriteRepository = createCampaignLegacyCoreWriteRepository(db, campaignCoreRepository);
  const campaignEventProjectionRepository = createCampaignEventProjectionRepo({
    listCampaignEvents: (actor, campaignId, timelineId) => listCampaignEventsSync(db, actor, campaignId, timelineId),
  });
  const campaignActorResourceRepository = createCampaignActorResourceRepository(db);
  let closed = false;
  let transactionDepth = 0;
  const assertOpen = () => {
    if (closed) throw new Error("repository is closed");
  };
  const rawAdministrationRepository = createCampaignAdministrationRepository(db, dependencies, () => {
    assertOpen();
    if (transactionDepth > 0) throw new Error("campaign administration mutation cannot run inside a repository transaction");
  }, (sessionId) => {
    return campaignCoreRepository.getCampaignRoomSessionLifecycle(sessionId);
  });
  const administrationRepository = new Proxy(rawAdministrationRepository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { assertOpen(); return value(...args); };
    },
  }) as CampaignAdministrationRepository;
  const rawContentCatalogRepository = createContentCatalogRepository(db, dependencies.clock, () => {
    assertOpen();
    if (transactionDepth > 0) throw new Error("content catalog mutation cannot run inside a repository transaction");
  });
  const contentCatalogRepository = new Proxy(rawContentCatalogRepository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { assertOpen(); return value(...args); };
    },
  }) as ContentCatalogRepository;
  const rawCharacterBuilderRepository = createCharacterBuilderRepository(db, dependencies, () => {
    assertOpen();
    if (transactionDepth > 0) throw new Error("character builder mutation cannot run inside a repository transaction");
  });
  const characterBuilderRepository = new Proxy(rawCharacterBuilderRepository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { assertOpen(); return value(...args); };
    },
  }) as CharacterBuilderRepository;
  const rawCharacterProgressionRepository=createCharacterProgressionRepository(db,dependencies,()=>{
    assertOpen();if(transactionDepth>0)throw new Error("character progression mutation cannot run inside a repository transaction");
  });
  const characterProgressionRepository=new Proxy(rawCharacterProgressionRepository,{get(target,property,receiver){const value=Reflect.get(target,property,receiver);
    if(typeof value!=="function")return value;return(...args:unknown[])=>{assertOpen();return value(...args);};}}) as CharacterProgressionRepository;
  const campaignActorRepository = createCampaignActorRepository(
    createCampaignActorOperations(db, characterProgressionRepository),
  );
  const m15Guard=()=>{assertOpen();if(transactionDepth>0)throw new Error("M1.5 mutation cannot run inside a repository transaction");};
  const rawActorResourceRepository=createActorResourceRepository(db,dependencies,m15Guard);
  const actorResourceRepository=new Proxy(rawActorResourceRepository,{get(target,property,receiver){const value=Reflect.get(target,property,receiver);
    if(typeof value!=="function")return value;return(...args:unknown[])=>{assertOpen();return value(...args);};}}) as ActorResourceRepository;
  const rawInventoryRepository=createInventoryRepository(db,dependencies,m15Guard);
  const inventoryRepository=new Proxy(rawInventoryRepository,{get(target,property,receiver){const value=Reflect.get(target,property,receiver);
    if(typeof value!=="function")return value;return(...args:unknown[])=>{assertOpen();return value(...args);};}}) as InventoryRepository;
  const rawEconomyRepository=createEconomyRepository(db,dependencies,m15Guard);
  const economyRepository=new Proxy(rawEconomyRepository,{get(target,property,receiver){const value=Reflect.get(target,property,receiver);
    if(typeof value!=="function")return value;return(...args:unknown[])=>{assertOpen();return value(...args);};}}) as EconomyRepository;
  const restRepository=createRestRepository(db,dependencies,m15Guard);
  const m16Guard=()=>{assertOpen();if(transactionDepth>0)throw new Error("M1.6 mutation cannot run inside a repository transaction");};
  const checkRepository=createCheckRepository(db,dependencies,m16Guard);
  const powerRepository=createPowerRepository(db,dependencies,m16Guard);
  const effectRepository=createEffectRepository(db,dependencies,m16Guard);
  const encounterRepository=createEncounterRepository(db,dependencies,()=>{assertOpen();if(transactionDepth>0)throw new Error("M1.7 mutation cannot run inside a repository transaction");});
  const worldRepository=createWorldRepository(db,dependencies,()=>{assertOpen();if(transactionDepth>0)throw new Error("M1.8 mutation cannot run inside a repository transaction");});
  const rawQuestRepository = createQuestRepository(db, LOCAL_OWNER_PRINCIPAL_ID, () => {
    assertOpen(); if (transactionDepth > 0) throw new Error("M2.1 mutation cannot run inside a repository transaction");
  });
  const questRepository = new Proxy(rawQuestRepository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { assertOpen(); return value(...args); };
    },
  }) as QuestRepository;
  return {
    ...administrationRepository,
    ...contentCatalogRepository,
    ...characterBuilderRepository,
    ...characterProgressionRepository,
    ...actorResourceRepository,
    ...inventoryRepository,
    ...economyRepository,
    ...restRepository,
    ...checkRepository,
    ...powerRepository,
    ...effectRepository,
    ...encounterRepository,
    ...worldRepository,
    ...questRepository,
    installMechanicsStarterCatalog: (actorPrincipalId) =>
      contentCatalogRepository.publishContentCatalog(actorPrincipalId, MECHANICS_STARTER_CATALOG),
    configureMechanicsStarterCatalog: (actorPrincipalId, campaignId, input) =>
      contentCatalogRepository.configureCampaignCatalog(actorPrincipalId, campaignId, {
        rulesProfileId: MECHANICS_STARTER_RULES_PROFILE_ID,
        contentPacks: [{
          packId: MECHANICS_STARTER_CATALOG.manifest.packId,
          packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
        }],
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
      }),
    inspectOriginalStarterSetup: (actorPrincipalId, campaignId) => {
      assertOpen();
      // One SQLite read transaction owns authority, campaign and content state.
      return db.transaction(() =>
        originalStarterSetupInspectionRepository.inspectOriginalStarterSetup(actorPrincipalId, campaignId))();
    },
    installOriginalStarterContent: (actorPrincipalId, campaignId) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("original starter installation cannot run inside a repository transaction");
      return installContentPackSync(
        db,
        actorPrincipalId,
        installContentPackInputSchema.parse(ORIGINAL_STARTER_MANIFEST),
        campaignId,
        originalStarterSetupInspectionRepository,
      );
    },
    configureOriginalStarterContent: (actorPrincipalId, campaignId) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("original starter configuration cannot run inside a repository transaction");
      return configureCampaignContentSync(db, actorPrincipalId, campaignId, {
        rulesProfileId: ORIGINAL_STARTER_RULES_PROFILE_ID,
        contentPacks: [{ packId: ORIGINAL_STARTER_PACK_ID, packVersion: ORIGINAL_STARTER_PACK_VERSION }],
      }, true, originalStarterSetupInspectionRepository);
    },
    listCampaigns: (actorPrincipalId) => {
      assertOpen();
      return campaignCoreRepository.listCampaigns(actorPrincipalId);
    },
    getCampaign: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignCoreRepository.getCampaign(actorPrincipalId, campaignId);
    },
    getCampaignDetail: (actorPrincipalId, campaignId) => {
      assertOpen();
      // Both authorization and content graph reconstruction must observe the
      // same SQLite snapshot; do not split this aggregate across requests.
      return db.transaction(() => campaignDetailReadRepository.getCampaignDetail(actorPrincipalId, campaignId))();
    },
    listCampaignTimelines: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignCoreRepository.listCampaignTimelines(actorPrincipalId, campaignId);
    },
    getCampaignTimeline: (actorPrincipalId, campaignId, timelineId) => {
      assertOpen();
      return campaignCoreRepository.getCampaignTimeline(actorPrincipalId, campaignId, timelineId);
    },
    listCampaignMemberships: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignCoreRepository.listCampaignMemberships(actorPrincipalId, campaignId);
    },
    getCampaignMembership: (actorPrincipalId, campaignId, principalId) => {
      assertOpen();
      return campaignCoreRepository.getCampaignMembership(actorPrincipalId, campaignId, principalId);
    },
    listCampaignSessionAttachments: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignCoreRepository.listCampaignSessionAttachments(actorPrincipalId, campaignId);
    },
    getCampaignSessionAttachment: (actorPrincipalId, campaignId, sessionId) => {
      assertOpen();
      return campaignCoreRepository.getCampaignSessionAttachment(actorPrincipalId, campaignId, sessionId);
    },
    getCampaignRoomLinkingSnapshot: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignCoreRepository.getCampaignRoomLinkingSnapshot(actorPrincipalId, campaignId);
    },
    getCampaignContentConfiguration: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignContentConfigurationReadRepository.getCampaignContentConfiguration(actorPrincipalId, campaignId);
    },
    getCampaignCharacterCreationOptions: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignActorRepository.getCampaignCharacterCreationOptions(actorPrincipalId, campaignId);
    },
    getCampaignCharacterRoster: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignActorRepository.getCampaignCharacterRoster(actorPrincipalId, campaignId);
    },
    getCampaignCharacterWorkspace: (actorPrincipalId, campaignId, campaignCharacterId) => {
      assertOpen();
      return campaignActorRepository.getCampaignCharacterWorkspace(actorPrincipalId, campaignId, campaignCharacterId);
    },
    getCampaignCharacterSheetSnapshot: (actorPrincipalId, campaignId, campaignCharacterId) => {
      assertOpen();
      // Both reads must see the same authority, ancestry, and progression state.
      return db.transaction(() => campaignActorRepository.getCampaignCharacterSheetSnapshot(
        actorPrincipalId, campaignId, campaignCharacterId,
      ))();
    },
    listActorResources: (actorPrincipalId, campaignId, actorId) => {
      assertOpen();
      return campaignActorResourceRepository.listActorResources(actorPrincipalId, campaignId, actorId);
    },
    getActorResource: (actorPrincipalId, campaignId, actorId, name) => {
      assertOpen();
      return campaignActorResourceRepository.getActorResource(actorPrincipalId, campaignId, actorId, name);
    },
    listCampaignEvents: (actorPrincipalId, campaignId, timelineId) => {
      assertOpen();
      return listCampaignEventsSync(db, actorPrincipalId, campaignId, timelineId);
    },
    listPublicCampaignEvents: (actorPrincipalId, campaignId, timelineId, afterRevision, limit) => {
      assertOpen();
      return campaignEventProjectionRepository.listPublicCampaignEvents(actorPrincipalId, campaignId, timelineId, afterRevision, limit);
    },
    listRecentCampaignDiceEvents: (actorPrincipalId, campaignId, timelineId) => {
      assertOpen();
      return diceRepository.listRecentCampaignDiceEvents(actorPrincipalId, campaignId, timelineId);
    },
    getCommandReceipt: (actorPrincipalId, campaignId, commandId) => {
      assertOpen();
      return diceRepository.getCommandReceipt(actorPrincipalId, campaignId, commandId);
    },
    listCampaignCharacters: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignActorRepository.listCampaignCharacters(actorPrincipalId, campaignId);
    },
    getCampaignCharacter: (actorPrincipalId, campaignId, campaignCharacterId) => {
      assertOpen();
      return campaignActorRepository.getCampaignCharacter(actorPrincipalId, campaignId, campaignCharacterId);
    },
    getCampaignCharacterByActorId: (actorPrincipalId, campaignId, actorId) => {
      assertOpen();
      return campaignActorRepository.getCampaignCharacterByActorId(actorPrincipalId, campaignId, actorId);
    },
    listRulesProfiles: (actorPrincipalId) => {
      assertOpen();
      return campaignGlobalContentReadRepository.listRulesProfiles(actorPrincipalId);
    },
    getRulesProfile: (actorPrincipalId, identifier) => {
      assertOpen();
      return campaignGlobalContentReadRepository.getRulesProfile(actorPrincipalId, identifier);
    },
    listContentPacks: (actorPrincipalId) => {
      assertOpen();
      return campaignGlobalContentReadRepository.listContentPacks(actorPrincipalId);
    },
    getContentPack: (actorPrincipalId, identifier) => {
      assertOpen();
      return campaignGlobalContentReadRepository.getContentPack(actorPrincipalId, identifier);
    },
    listContentPackDefinitions: (actorPrincipalId, identifier) => {
      assertOpen();
      return campaignGlobalContentReadRepository.listContentPackDefinitions(actorPrincipalId, identifier);
    },
    getContentPackDefinition: (actorPrincipalId, reference) => {
      assertOpen();
      return campaignGlobalContentReadRepository.getContentPackDefinition(actorPrincipalId, reference);
    },
    getCampaignRulesProfile: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignContentSelectionReadRepository.getCampaignRulesProfile(actorPrincipalId, campaignId);
    },
    listCampaignContentPacks: (actorPrincipalId, campaignId) => {
      assertOpen();
      return campaignContentSelectionReadRepository.listCampaignContentPacks(actorPrincipalId, campaignId);
    },
    listCampaignContentPackDefinitions: (actorPrincipalId, campaignId, identifier) => {
      assertOpen();
      return campaignContentDefinitionReadRepository.listCampaignContentPackDefinitions(actorPrincipalId, campaignId, identifier);
    },
    getCampaignContentPackDefinition: (actorPrincipalId, campaignId, reference) => {
      assertOpen();
      return campaignContentDefinitionReadRepository.getCampaignContentPackDefinition(actorPrincipalId, campaignId, reference);
    },
    addCampaignMembership: (actorPrincipalId, campaignId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign membership addition cannot run inside a repository transaction");
      return campaignLegacyCoreWriteRepository.addCampaignMembership(actorPrincipalId, campaignId, input);
    },
    createCampaign: (actorPrincipalId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign creation cannot run inside a repository transaction");
      return campaignLegacyCoreWriteRepository.createCampaign(actorPrincipalId, input);
    },
    renameCampaign: (actorPrincipalId, campaignId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign rename cannot run inside a repository transaction");
      return campaignLegacyCoreWriteRepository.renameCampaign(actorPrincipalId, campaignId, input);
    },
    renameCampaignIfUnchanged: (actorPrincipalId, campaignId, input) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("stale-safe campaign rename cannot run inside a repository transaction");
      }
      return campaignLegacyCoreWriteRepository.renameCampaignIfUnchanged(actorPrincipalId, campaignId, input);
    },
    attachCampaignSession: (actorPrincipalId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign session attachment cannot run inside a repository transaction");
      return campaignLegacyCoreWriteRepository.attachCampaignSession(actorPrincipalId, input);
    },
    detachCampaignSession: (actorPrincipalId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign session detachment cannot run inside a repository transaction");
      return campaignLegacyCoreWriteRepository.detachCampaignSession(actorPrincipalId, input);
    },
    installContentPack: (actorPrincipalId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("content pack installation cannot run inside a repository transaction");
      return installContentPackSync(db, actorPrincipalId, input);
    },
    configureCampaignContent: (actorPrincipalId, campaignId, input) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("campaign content configuration cannot run inside a repository transaction");
      }
      return configureCampaignContentSync(db, actorPrincipalId, campaignId, input);
    },
    createCampaignCharacter: (actorPrincipalId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign character creation cannot run inside a repository transaction");
      // Preserve the generic repository's established public return shape.
      return campaignCharacterWriteRepository.createCampaignCharacter(actorPrincipalId, input);
    },
    createOriginalStarterCampaignCharacter: (actorPrincipalId, input) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("original starter campaign character creation cannot run inside a repository transaction");
      }
      return campaignCharacterWriteRepository.createOriginalStarterCampaignCharacter(actorPrincipalId, input);
    },
    executeSetActorAttribute: (actorPrincipalId, envelope) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("set actor attribute command cannot run inside a repository transaction");
      }
      return campaignCommandWriteOperations.executeSetActorAttribute(actorPrincipalId, envelope);
    },
    executeInitializeActorResource: (actorPrincipalId, envelope) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("initialize actor resource command cannot run inside a repository transaction");
      }
      return campaignCommandWriteOperations.executeInitializeActorResource(actorPrincipalId, envelope);
    },
    executeRollActorDice: (actorPrincipalId, envelope) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("roll actor dice command cannot run inside a repository transaction");
      }
      return diceRepository.executeRollActorDice(actorPrincipalId, envelope);
    },
    executeRollActorDiceForVisibleCharacter: (actorPrincipalId, envelope, binding) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("visible-character dice command cannot run inside a repository transaction");
      }
      return diceRepository.executeRollActorDiceForVisibleCharacter(actorPrincipalId, envelope, binding);
    },
    createCharacter: (input) => {
      assertOpen();
      return createCharacterSync(db, dependencies, input);
    },
    createLoreEntry: (input) => {
      assertOpen();
      return createLoreEntrySync(db, dependencies, input);
    },
    updateHarnessSettings: (patch) => {
      assertOpen();
      return updateHarnessSettingsSync(db, dependencies.clock, patch);
    },
    updateSessionContextSource: (sessionId, sourceOfTruth) => {
      assertOpen();
      return updateSessionContextSourceSync(db, dependencies.clock, sessionId, sourceOfTruth);
    },
    getSession: (id) => {
      assertOpen();
      return getSessionSync(db, id);
    },
    transitionSession: (id, state, reason) => {
      assertOpen();
      return transitionSessionSync(db, dependencies.clock, id, state, reason);
    },
    addConsentEvent: (sessionId, scope, granted, note) => {
      assertOpen();
      return addConsentEventSync(db, dependencies, sessionId, scope, granted, note);
    },
    transaction: <T>(callback: SynchronousCallback<T>) => {
      assertOpen();
      transactionDepth += 1;
      try {
        return runTransaction(db, dependencies, callback);
      } finally {
        transactionDepth -= 1;
      }
    },
    stopSession: (id, reason) => {
      assertOpen();
      return runTransaction(db, dependencies, (unitOfWork) => stopSessionSync(unitOfWork, id, reason));
    },
    close: () => {
      if (closed) return;
      db.close();
      closed = true;
    },
  };
}
