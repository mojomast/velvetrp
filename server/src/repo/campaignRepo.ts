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
  campaignContentConfigurationSchema,
  campaignMembershipSchema,
  campaignRenameRequestSchema,
  campaignSessionAttachmentSchema,
  commandEnvelopeSchema,
  contentPackIdentifierSchema,
  contentPackSchema,
  configureCampaignContentInputSchema,
  createCampaignInputSchema,
  definitionReferenceSchema,
  detachCampaignSessionInputSchema,
  installContentPackInputSchema,
  MAX_CAMPAIGN_CHARACTER_PERSONAS,
  MAX_CAMPAIGN_CHARACTER_ROSTER,
  MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES,
  MAX_CHARACTER_ATTRIBUTES,
  MAX_CHARACTER_CHOICES,
  MAX_CHARACTER_CLASSES,
  MAX_CHARACTER_PROFICIENCIES,
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
import { createCampaignContentWriteRepository } from "./campaign/campaignContentWriteRepo.js";
import { createCampaignCommandRepository } from "./campaign/campaignCommandRepo.js";
import { createCampaignCommandWriteOperations } from "./campaign/campaignCommandWriteRepo.js";
import { createCampaignActorResourceRepository } from "./campaign/campaignActorResourceRepo.js";
import { createCampaignEventProjectionRepo } from "./campaign/campaignEventProjectionRepo.js";
import { createCampaignEventReadRepository } from "./campaign/campaignEventReadRepo.js";
import { createCampaignMembershipReadRepository } from "./campaign/campaignMembershipReadRepo.js";
import { createCampaignSessionAttachmentReadRepository } from "./campaign/campaignSessionAttachmentReadRepo.js";
import { createCampaignRoomLinkingSnapshotRepository } from "./campaign/campaignRoomLinkingSnapshotRepo.js";
import { createCampaignRoomSessionLifecycleRepository } from "./campaign/campaignRoomSessionLifecycleRepo.js";
import { createCampaignCharacterCreationOptionsRepository } from "./campaign/campaignCharacterCreationOptionsRepo.js";
import {
  getCampaignTimelineSync as getCampaignTimelineReadSync,
  listCampaignTimelinesSync as listCampaignTimelinesReadSync,
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
  ContentPack,
  ContentPackIdentifier,
  ConfigureCampaignContentInput,
  ConsentEvent,
  CreateCharacterInput,
  CreateCampaignInput,
  DetachCampaignSessionInput,
  DefinitionReference,
  InstallContentPackInput,
  RenameCampaignInput,
  RpgDefinition,
  RulesProfile,
  RulesProfileIdentifier,
  Database,
  HarnessSettings,
  LoreEntry,
  NewLoreEntry,
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

/** @deprecated Prefer the database-scoped campaign event read repository. */
function listCampaignEventsSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  timelineId: string,
) {
  return createCampaignEventReadRepository(db)
    .listCampaignEvents(actorPrincipalId, campaignId, timelineId);
}

/** @deprecated Prefer the database-scoped campaign event read repository. */
export function listRecentCampaignDiceEventsSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  timelineId: string,
) {
  return createCampaignEventReadRepository(db)
    .listRecentCampaignDiceEvents(actorPrincipalId, campaignId, timelineId);
}

/** @deprecated Prefer the database-scoped campaign event read repository. */
export function getCommandReceiptSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  commandId: string,
) {
  return createCampaignEventReadRepository(db)
    .getCommandReceipt(actorPrincipalId, campaignId, commandId);
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
  const campaignEventReadRepository = createCampaignEventReadRepository(db);
  const campaignEventProjectionRepository = createCampaignEventProjectionRepo(campaignEventReadRepository);
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
      return campaignEventReadRepository.listCampaignEvents(actorPrincipalId, campaignId, timelineId);
    },
    listPublicCampaignEvents: (actorPrincipalId, campaignId, timelineId, afterRevision, limit) => {
      assertActive();
      return campaignEventProjectionRepository.listPublicCampaignEvents(actorPrincipalId, campaignId, timelineId, afterRevision, limit);
    },
    listRecentCampaignDiceEvents: (actorPrincipalId, campaignId, timelineId) => {
      assertActive();
      return campaignEventReadRepository.listRecentCampaignDiceEvents(actorPrincipalId, campaignId, timelineId);
    },
    getCommandReceipt: (actorPrincipalId, campaignId, commandId) => {
      assertActive();
      return campaignEventReadRepository.getCommandReceipt(actorPrincipalId, campaignId, commandId);
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
  const campaignEventReadRepository = createCampaignEventReadRepository(db);
  const campaignCommandRepository = createCampaignCommandRepository({
    executeRollActorDice: (actor, input) => campaignCommandWriteOperations.executeRollActorDice(actor, input),
    executeRollActorDiceForVisibleCharacter: (actor, input, binding) =>
      campaignCommandWriteOperations.executeRollActorDiceForVisibleCharacter(actor, input, binding),
  }, campaignEventReadRepository);
  const campaignCharacterWriteRepository = createCampaignCharacterWriteRepository(db, dependencies);
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
  const campaignContentWriteRepository = createCampaignContentWriteRepository(
    db,
    originalStarterSetupInspectionRepository,
  );
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
  const campaignEventProjectionRepository = createCampaignEventProjectionRepo(campaignEventReadRepository);
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
      return campaignContentWriteRepository.installOriginalStarterContent(
        actorPrincipalId,
        campaignId,
        installContentPackInputSchema.parse(ORIGINAL_STARTER_MANIFEST),
      );
    },
    configureOriginalStarterContent: (actorPrincipalId, campaignId) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("original starter configuration cannot run inside a repository transaction");
      return campaignContentWriteRepository.configureOriginalStarterContent(actorPrincipalId, campaignId, {
        rulesProfileId: ORIGINAL_STARTER_RULES_PROFILE_ID,
        contentPacks: [{ packId: ORIGINAL_STARTER_PACK_ID, packVersion: ORIGINAL_STARTER_PACK_VERSION }],
      });
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
      return campaignEventReadRepository.listCampaignEvents(actorPrincipalId, campaignId, timelineId);
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
      return campaignContentWriteRepository.installContentPack(actorPrincipalId, input);
    },
    configureCampaignContent: (actorPrincipalId, campaignId, input) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("campaign content configuration cannot run inside a repository transaction");
      }
      return campaignContentWriteRepository.configureCampaignContent(actorPrincipalId, campaignId, input);
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
