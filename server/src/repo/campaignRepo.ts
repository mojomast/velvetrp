import DatabaseDriver from "better-sqlite3";
import {
  addCampaignMembershipInputSchema,
  actorResourceNameSchema,
  actorResourceSchema,
  attachCampaignSessionInputSchema,
  campaignAccessSchema,
  campaignCharacterAttributeSchema,
  campaignCharacterClassSchema,
  campaignCharacterCreationOptionsResponseSchema,
  campaignCharacterPersonaSummarySchema,
  campaignCharacterProficiencySchema,
  campaignCharacterWorkspaceDescriptionSchema,
  campaignCharacterWorkspaceNameSchema,
  campaignCharacterWorkspaceResponseSchema,
  publicCampaignCharacterSummarySchema,
  publicCampaignActorSchema,
  campaignCharacterSchema,
  campaignCharacterReadSchema,
  campaignContentConfigurationSchema,
  campaignDetailSchema,
  campaignMembershipReadSchema,
  campaignMembershipSchema,
  campaignRenameRequestSchema,
  campaignSchema,
  campaignSessionAttachmentSchema,
  campaignRoomLinkingResponseSchema,
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
  MAX_CAMPAIGN_ROOM_SUMMARIES,
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
  rpgDefinitionSchema,
  rulesProfileIdentifierSchema,
  rulesProfileSchema,
  utcIsoTimestampSchema,
  type PublicCampaignCharacterSummary,
  type CampaignCharacterWorkspaceResponse,
  type CampaignRoomLinkingResponse,
  type ProgressionState,
} from "@velvet/contracts";
import path from "node:path";
import { createHash } from "node:crypto";
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
import { createCampaignCoreRepository } from "./campaign/campaignCoreRepo.js";
import { createCampaignActorRepository } from "./campaign/campaignActorRepo.js";
import { createCampaignCommandRepository } from "./campaign/campaignCommandRepo.js";
import { createCampaignEventProjectionRepo } from "./campaign/campaignEventProjectionRepo.js";
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
  CampaignRenameRequest,
  CampaignCharacterRead,
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

export interface RepositoryDependencies {
  clock: Clock;
  ids: IdGenerator;
  rng: RandomNumberGenerator;
}

/** Deliberately narrow failures that HTTP adapters may safely classify. */
export class CampaignCreationAuthorizationError extends Error {
  readonly code = "CAMPAIGN_CREATION_FORBIDDEN";

  constructor() {
    super("campaign creation requires the application owner");
    this.name = "CampaignCreationAuthorizationError";
  }
}

export class CampaignCreationIdCollisionError extends Error {
  readonly code = "CAMPAIGN_CREATION_ID_COLLISION";

  constructor() {
    super("a generated campaign resource ID already exists");
    this.name = "CampaignCreationIdCollisionError";
  }
}

export class CampaignRenameUnavailableError extends Error {
  readonly code = "CAMPAIGN_RENAME_UNAVAILABLE";

  constructor() {
    super("campaign is unavailable for rename");
    this.name = "CampaignRenameUnavailableError";
  }
}

export class CampaignRenameStaleError extends Error {
  readonly code = "CAMPAIGN_RENAME_STALE";

  constructor() {
    super("campaign rename precondition is stale");
    this.name = "CampaignRenameStaleError";
  }
}

/** Safe HTTP classifications for the campaign-room linking write only. */
export class CampaignSessionAttachmentUnavailableError extends Error {
  readonly code = "CAMPAIGN_SESSION_ATTACHMENT_UNAVAILABLE";
  constructor(message = "campaign session attachment requires the campaign owner") {
    super(message);
    this.name = "CampaignSessionAttachmentUnavailableError";
  }
}

export class CampaignSessionAttachmentSessionMissingError extends Error {
  readonly code = "CAMPAIGN_SESSION_ATTACHMENT_SESSION_MISSING";
  constructor() {
    super("session not found");
    this.name = "CampaignSessionAttachmentSessionMissingError";
  }
}

export class CampaignSessionAttachmentConflictError extends Error {
  readonly code = "CAMPAIGN_SESSION_ATTACHMENT_CONFLICT";
  constructor(message: "session is already attached to a different campaign" | "stopped sessions cannot be attached to campaigns") {
    super(message);
    this.name = "CampaignSessionAttachmentConflictError";
  }
}

export class ContentPackInstallationAuthorizationError extends Error {
  readonly code = "CONTENT_PACK_INSTALLATION_FORBIDDEN";
  constructor() {
    super("content pack installation requires the application owner");
    this.name = "ContentPackInstallationAuthorizationError";
  }
}

export class ContentPackInstallationConflictError extends Error {
  readonly code = "CONTENT_PACK_INSTALLATION_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ContentPackInstallationConflictError";
  }
}

export class CampaignContentConfigurationAuthorizationError extends Error {
  readonly code = "CAMPAIGN_CONTENT_CONFIGURATION_UNAVAILABLE";
  constructor(message = "campaign content configuration is unavailable") {
    super(message);
    this.name = "CampaignContentConfigurationAuthorizationError";
  }
}

export class CampaignContentConfigurationConflictError extends Error {
  readonly code = "CAMPAIGN_CONTENT_CONFIGURATION_CONFLICT";
  constructor(message = "campaign content configuration conflicts with existing configuration") {
    super(message);
    this.name = "CampaignContentConfigurationConflictError";
  }
}

/** Narrow classifications for the atomic generic campaign-character write. */
export class CampaignCharacterCreationUnavailableError extends Error {
  readonly code = "CAMPAIGN_CHARACTER_CREATION_UNAVAILABLE";
  constructor() {
    super("campaign character creation unavailable");
    this.name = "CampaignCharacterCreationUnavailableError";
  }
}

export class CampaignCharacterPersonaUnavailableError extends Error {
  readonly code = "CAMPAIGN_CHARACTER_PERSONA_UNAVAILABLE";
  constructor() {
    super("campaign character persona is missing or ineligible");
    this.name = "CampaignCharacterPersonaUnavailableError";
  }
}

export class CampaignCharacterCreationConflictError extends Error {
  readonly code = "CAMPAIGN_CHARACTER_CREATION_CONFLICT";
  constructor() {
    super("campaign character already exists for this persona");
    this.name = "CampaignCharacterCreationConflictError";
  }
}

export type OriginalStarterSetupInspection =
  | { status: "unavailable" }
  | { status: "conflict" }
  | { status: "unconfigured"; campaign: CampaignDetail }
  | { status: "exact"; campaign: CampaignDetail };

export interface RepositoryUnitOfWork {
  /** Read-only administration projection available inside one shared snapshot. */
  getCampaignAdministration: CampaignAdministrationRepository["getCampaignAdministration"];
  validateContentCatalog(input: unknown): import("@velvet/contracts").CatalogValidationReport;
  listContentCatalogPublications(actorPrincipalId: string): import("@velvet/contracts").PublicationSummary[];
  listContentCatalogPublicationPage(
    actorPrincipalId: string,
    input: import("./contentCatalogRepo.js").ContentCatalogPublicationPageInput,
  ): import("./contentCatalogRepo.js").ContentCatalogPublicationPage;
  getContentCatalogForOwner(actorPrincipalId: string, packId: string, packVersion: string): import("@velvet/contracts").OwnerCatalogProjection | null;
  getCampaignContentCatalog(actorPrincipalId: string, campaignId: string, packId: string, packVersion: string):
    import("@velvet/contracts").GmCatalogProjection | import("@velvet/contracts").PlayerCatalogProjection | import("@velvet/contracts").ObserverCatalogProjection | null;
  resolveCampaignCatalog(actorPrincipalId: string, campaignId: string): import("@velvet/contracts").CampaignCatalogResolutionReport | null;
  getCampaignCatalogReceipt(actorPrincipalId: string, campaignId: string, commandId: string): import("@velvet/contracts").CampaignCatalogReceipt | null;
  listCampaigns(actorPrincipalId: string): CampaignAccess[];
  getCampaign(actorPrincipalId: string, campaignId: string): CampaignAccess | null;
  getCampaignDetail(actorPrincipalId: string, campaignId: string): CampaignDetail | null;
  listCampaignTimelines(actorPrincipalId: string, campaignId: string): CampaignTimeline[];
  getCampaignTimeline(
    actorPrincipalId: string,
    campaignId: string,
    timelineId: string,
  ): CampaignTimeline | null;
  listCampaignMemberships(actorPrincipalId: string, campaignId: string): CampaignMembershipRead[];
  getCampaignMembership(
    actorPrincipalId: string,
    campaignId: string,
    principalId: string,
  ): CampaignMembershipRead | null;
  listCampaignSessionAttachments(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignSessionAttachment[];
  getCampaignSessionAttachment(
    actorPrincipalId: string,
    campaignId: string,
    sessionId: string,
  ): CampaignSessionAttachment | null;
  getCampaignRoomLinkingSnapshot(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignRoomLinkingSnapshot | null;
  getCampaignContentConfiguration(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignContentConfiguration | null;
  getCampaignCharacterCreationOptions(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignCharacterCreationOptionsResponse | null;
  getCampaignCharacterRoster(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignCharacterRosterSnapshot | null;
  getCampaignCharacterWorkspace(
    actorPrincipalId: string,
    campaignId: string,
    campaignCharacterId: string,
  ): CampaignCharacterWorkspaceSnapshot | null;
  getCampaignCharacterSheetSnapshot(
    actorPrincipalId: string,
    campaignId: string,
    campaignCharacterId: string,
  ): CampaignCharacterSheetSnapshot | null;
  listActorResources(actorPrincipalId: string, campaignId: string, actorId: string): ActorResource[];
  getActorResource(
    actorPrincipalId: string,
    campaignId: string,
    actorId: string,
    name: string,
  ): ActorResource | null;
  listCampaignEvents(actorPrincipalId: string, campaignId: string, timelineId: string): RpgEvent[];
  listPublicCampaignEvents(
    actorPrincipalId: string,
    campaignId: string,
    timelineId: string,
    afterRevision: number,
    limit: number,
  ): CampaignEventPage;
  listRecentCampaignDiceEvents(
    actorPrincipalId: string,
    campaignId: string,
    timelineId: string,
  ): CampaignDiceEvent[];
  getCommandReceipt(actorPrincipalId: string, campaignId: string, commandId: string): CommandReceipt | null;
  listCampaignCharacters(actorPrincipalId: string, campaignId: string): CampaignCharacterRead[];
  getCampaignCharacter(
    actorPrincipalId: string,
    campaignId: string,
    campaignCharacterId: string,
  ): CampaignCharacterRead | null;
  getCampaignCharacterByActorId(
    actorPrincipalId: string,
    campaignId: string,
    actorId: string,
  ): CampaignCharacterRead | null;
  listRulesProfiles(actorPrincipalId: string): RulesProfile[];
  getRulesProfile(actorPrincipalId: string, identifier: RulesProfileIdentifier): RulesProfile | null;
  listContentPacks(actorPrincipalId: string): ContentPack[];
  getContentPack(actorPrincipalId: string, identifier: ContentPackIdentifier): ContentPack | null;
  listContentPackDefinitions(actorPrincipalId: string, identifier: ContentPackIdentifier): RpgDefinition[];
  getContentPackDefinition(actorPrincipalId: string, reference: DefinitionReference): RpgDefinition | null;
  getCampaignRulesProfile(actorPrincipalId: string, campaignId: string): RulesProfile | null;
  listCampaignContentPacks(actorPrincipalId: string, campaignId: string): ContentPack[];
  listCampaignContentPackDefinitions(
    actorPrincipalId: string,
    campaignId: string,
    identifier: ContentPackIdentifier,
  ): RpgDefinition[];
  getCampaignContentPackDefinition(
    actorPrincipalId: string,
    campaignId: string,
    reference: DefinitionReference,
  ): RpgDefinition | null;
  getSession(id: string): Session | null;
  transitionSession(id: string, state: SceneState, reason: string): Session | null;
  addConsentEvent(sessionId: string, scope: string, granted: boolean, note: string): ConsentEvent | null;
}

/** Internal path-binding evidence is deliberately absent from the public envelope. */
export interface CampaignCharacterRosterSnapshot {
  campaignId: string;
  characters: PublicCampaignCharacterSummary[];
}

/** Internal request-path evidence is stripped by the HTTP adapter. */
export interface CampaignRoomLinkingSnapshot extends CampaignRoomLinkingResponse {
  campaignId: string;
}

/** Internal path evidence is intentionally kept outside the ID-free wire envelope. */
export interface CampaignCharacterWorkspaceSnapshot {
  campaignId: string;
  campaignCharacterId: string;
  character: CampaignCharacterWorkspaceResponse["character"];
}

/** A public sheet projection paired with the authoritative progression state. */
export interface CampaignCharacterSheetSnapshot {
  campaignId: string;
  campaignCharacterId: string;
  sheet: CampaignCharacterWorkspaceResponse["character"];
  progression: ProgressionState;
}

/** Bounded, cursor-based projection for the public campaign event log. */
export interface CampaignEventPage {
  events: RpgEvent[];
  nextAfterRevision: number | null;
}

/**
 * Internal evidence returned only by the locked original-starter operation.
 * Both fields are derived and validated inside its immediate transaction.
 */
export interface OriginalStarterCampaignCharacterCreationResult {
  projection: PrivilegedCampaignCharacterProjection;
  personaDisplayName: string;
}

type SynchronousCallback<T> = (repository: RepositoryUnitOfWork) =>
  T & (T extends PromiseLike<unknown> ? never : unknown);

export interface Repository extends RepositoryUnitOfWork, CampaignAdministrationRepository, ContentCatalogRepository, CharacterBuilderRepository, CharacterProgressionRepository, ActorResourceRepository, InventoryRepository, EconomyRepository, RestRepository, CheckRepository, PowerRepository, EffectRepository, EncounterRepository, WorldRepository, QuestRepository {
  /** Explicit built-in setup path; no caller-supplied catalog data or identity. */
  installMechanicsStarterCatalog(actorPrincipalId: string): import("@velvet/contracts").OwnerCatalogProjection;
  configureMechanicsStarterCatalog(actorPrincipalId: string, campaignId: string, input: {
    expectedRevision: number; idempotencyKey: string;
  }): import("@velvet/contracts").CampaignCatalogConfigurationResult;
  /** Specialized trusted-local snapshot; it accepts no caller-supplied content identities. */
  inspectOriginalStarterSetup(actorPrincipalId: string, campaignId: string): OriginalStarterSetupInspection;
  /** Specialized setup write; manifest identity and content are fixed by the repository. */
  installOriginalStarterContent(actorPrincipalId: string, campaignId: string): ContentPack;
  /** Specialized setup write; profile and pack selection are fixed by the repository. */
  configureOriginalStarterContent(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignContentConfiguration;
  addCampaignMembership(actorPrincipalId: string, campaignId: string, input: AddCampaignMembershipInput): CampaignMembership;
  attachCampaignSession(actorPrincipalId: string, input: AttachCampaignSessionInput): CampaignSessionAttachment;
  detachCampaignSession(actorPrincipalId: string, input: DetachCampaignSessionInput): CampaignSessionAttachment | null;
  installContentPack(actorPrincipalId: string, input: InstallContentPackInput): ContentPack;
  configureCampaignContent(
    actorPrincipalId: string,
    campaignId: string,
    input: ConfigureCampaignContentInput,
  ): CampaignContentConfiguration;
  createCampaignCharacter(
    actorPrincipalId: string,
    input: CreateCampaignCharacterInput,
  ): PrivilegedCampaignCharacterProjection;
  /** Factory-only fixed-content creation; never exposed on a unit of work or legacy wrapper. */
  createOriginalStarterCampaignCharacter(
    actorPrincipalId: string,
    input: CreateCampaignCharacterInput,
  ): OriginalStarterCampaignCharacterCreationResult;
  executeInitializeActorResource(actorPrincipalId: string, envelope: CommandEnvelope): CommandReceipt;
  executeRollActorDice(actorPrincipalId: string, envelope: CommandEnvelope): CommandReceipt;
  /** Factory-only locked revalidation for the ID-free campaign-dice boundary. */
  executeRollActorDiceForVisibleCharacter(
    actorPrincipalId: string,
    envelope: CommandEnvelope,
    binding: CampaignDiceVisibleCharacterBinding,
  ): CommandReceipt;
  executeSetActorAttribute(actorPrincipalId: string, envelope: CommandEnvelope): CommandReceipt;
  createCampaign(actorPrincipalId: string, input: CreateCampaignInput): Campaign;
  renameCampaign(actorPrincipalId: string, campaignId: string, input: RenameCampaignInput): Campaign;
  renameCampaignIfUnchanged(
    actorPrincipalId: string,
    campaignId: string,
    input: CampaignRenameRequest,
  ): Campaign;
  createCharacter(input: CreateCharacterInput): Character;
  createLoreEntry(input: NewLoreEntry): LoreEntry;
  updateHarnessSettings(patch: UpdateHarnessInput): HarnessSettings;
  updateSessionContextSource(sessionId: string, sourceOfTruth: string): { sourceOfTruth: string; updatedAt: string };
  transaction<T>(callback: SynchronousCallback<T>): T;
  stopSession(id: string, reason: string): Session | null;
  close(): void;
}

interface CampaignCommandRow {
  campaign_id: string;
  command_id: string;
  idempotency_key: string;
  timeline_id: string;
  actor_id: string;
  expected_revision: number;
  source_turn_id: string | null;
  type: string;
  attribute_id: string | null;
  value: number | null;
  resource_name: string | null;
  resource_current: number | null;
  resource_max: number | null;
  dice_expression: string | null;
  dice_count: number | null;
  dice_sides: number | null;
  dice_selection_type: string | null;
  dice_selection_count: number | null;
  dice_modifier: number | null;
}

interface CommandRetryRow extends CampaignCommandRow {
  retry_timeline_presence: string | null;
  retry_timeline_revision: unknown;
  retry_timeline_event_count: unknown;
  retry_actor_presence: string | null;
  revision_before: number | null;
  revision_after: number | null;
  receipt_event_id: string | null;
  event_id: string | null;
  event_campaign_id: string | null;
  event_command_id: string | null;
  event_timeline_id: string | null;
  event_actor_id: string | null;
  event_source_turn_id: string | null;
  event_type: string | null;
  event_revision: number | null;
  occurred_at: string | null;
  event_attribute_id: string | null;
  value_before: number | null;
  value_after: number | null;
  resource_name: string | null;
  resource_current: number | null;
  resource_max: number | null;
  event_resource_name: string | null;
  event_resource_current: number | null;
  event_resource_max: number | null;
  dice_roll_presence: string | null;
}

function commandRowMatchesEnvelope(row: CampaignCommandRow, envelope: CommandEnvelope): boolean {
  return envelope.command.type === "set_actor_attribute"
    && row.campaign_id === envelope.campaignId
    && row.command_id === envelope.commandId
    && row.idempotency_key === envelope.idempotencyKey
    && row.timeline_id === envelope.timelineId
    && row.actor_id === envelope.actorId
    && row.expected_revision === envelope.expectedRevision
    && row.source_turn_id === envelope.sourceTurnId
    && row.type === envelope.command.type
    && row.attribute_id === envelope.command.payload.attributeId
    && row.value === envelope.command.payload.value
    && row.resource_name === null
    && row.resource_current === null
    && row.resource_max === null
    && row.dice_expression === null && row.dice_count === null && row.dice_sides === null
    && row.dice_selection_type === null && row.dice_selection_count === null && row.dice_modifier === null;
}

function commandRowMatchesResourceEnvelope(row: CampaignCommandRow, envelope: CommandEnvelope): boolean {
  return envelope.command.type === "initialize_actor_resource"
    && row.campaign_id === envelope.campaignId
    && row.command_id === envelope.commandId
    && row.idempotency_key === envelope.idempotencyKey
    && row.timeline_id === envelope.timelineId
    && row.actor_id === envelope.actorId
    && row.expected_revision === envelope.expectedRevision
    && row.source_turn_id === envelope.sourceTurnId
    && row.type === envelope.command.type
    && row.attribute_id === null
    && row.value === null
    && row.resource_name === envelope.command.payload.name
    && row.resource_current === envelope.command.payload.current
    && row.resource_max === envelope.command.payload.max
    && row.dice_expression === null && row.dice_count === null && row.dice_sides === null
    && row.dice_selection_type === null && row.dice_selection_count === null && row.dice_modifier === null;
}

function commandRowMatchesDiceEnvelope(row: CampaignCommandRow, envelope: CommandEnvelope): boolean {
  if (envelope.command.type !== "roll_actor_dice") return false;
  const normalized = parseDiceExpression(envelope.command.payload.expression);
  const selectionCount = normalized.selection.type === "keep_highest"
    || normalized.selection.type === "keep_lowest" ? normalized.selection.count : null;
  return row.campaign_id === envelope.campaignId && row.command_id === envelope.commandId
    && row.idempotency_key === envelope.idempotencyKey && row.timeline_id === envelope.timelineId
    && row.actor_id === envelope.actorId && row.expected_revision === envelope.expectedRevision
    && row.source_turn_id === envelope.sourceTurnId && row.type === "roll_actor_dice"
    && row.attribute_id === null && row.value === null && row.resource_name === null
    && row.resource_current === null && row.resource_max === null
    && row.dice_expression === envelope.command.payload.expression
    && row.dice_count === normalized.count && row.dice_sides === normalized.sides
    && row.dice_selection_type === normalized.selection.type
    && row.dice_selection_count === selectionCount && row.dice_modifier === normalized.modifier;
}

/** Rebuild an immutable prior result rather than re-running any command logic. */
function receiptFromRetryRow(row: CommandRetryRow, envelope: CommandEnvelope): CommandReceipt {
  if (
    row.retry_timeline_presence === null || row.retry_timeline_revision === null
    || row.retry_actor_presence === null
    || row.revision_before === null || row.revision_after === null || row.receipt_event_id === null
    || row.event_id === null || row.event_campaign_id === null || row.event_command_id === null
    || row.event_timeline_id === null || row.event_actor_id === null || row.event_type === null
    || row.event_revision === null || row.occurred_at === null || row.event_attribute_id === null
    || row.value_before === null || row.value_after === null
    || row.event_resource_name !== null || row.event_resource_current !== null || row.event_resource_max !== null
    || row.dice_roll_presence !== null
  ) {
    throw new Error("set actor attribute command retry is incomplete");
  }
  if (row.receipt_event_id !== row.event_id) {
    throw new Error("set actor attribute command retry is invalid");
  }
  const event = rpgEventSchema.parse({
    eventId: row.event_id,
    commandId: row.event_command_id,
    campaignId: row.event_campaign_id,
    timelineId: row.event_timeline_id,
    actorId: row.event_actor_id,
    sourceTurnId: row.event_source_turn_id,
    type: row.event_type,
    revision: row.event_revision,
    occurredAt: row.occurred_at,
    data: {
      attributeId: row.event_attribute_id,
      valueBefore: row.value_before,
      valueAfter: row.value_after,
    },
  });
  const receipt = commandReceiptSchema.parse({
    commandId: row.command_id,
    campaignId: row.campaign_id,
    revisionBefore: row.revision_before,
    revisionAfter: row.revision_after,
    events: [event],
  });
  const retryTimelineRevision = revisionSchema.parse(row.retry_timeline_revision);
  const retryTimelineEventCount = revisionSchema.parse(row.retry_timeline_event_count);
  if (event.type !== "actor_attribute_set" || envelope.command.type !== "set_actor_attribute") {
    throw new Error("set actor attribute command retry is invalid");
  }
  // The receipt schema intentionally has only receipt/event invariants. A retry
  // additionally requires the stored event to be the exact result of this row.
  if (
    event.timelineId !== envelope.timelineId || event.actorId !== envelope.actorId
    || event.sourceTurnId !== envelope.sourceTurnId
    || event.data.attributeId !== envelope.command.payload.attributeId
    || event.data.valueAfter !== envelope.command.payload.value
    || receipt.revisionBefore !== envelope.expectedRevision
    || retryTimelineRevision < event.revision
    || retryTimelineEventCount !== retryTimelineRevision
  ) {
    throw new Error("set actor attribute command retry is invalid");
  }
  return receipt;
}

function executeSetActorAttributeSync(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
  actorPrincipalId: string,
  input: CommandEnvelope,
): CommandReceipt {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const envelope = commandEnvelopeSchema.parse(input);
  if (envelope.command.type !== "set_actor_attribute") {
    throw new Error("executeSetActorAttribute requires a set_actor_attribute command");
  }
  const command = envelope.command;
  const run = db.transaction(() => {
    // Authorization deliberately precedes all command identity lookups so an
    // unauthorized caller cannot discover whether a command has been used.
    const authorized = db.prepare(`SELECT 1
      FROM campaign_memberships membership
      JOIN principals principal ON principal.id = membership.principal_id
      JOIN campaigns campaign ON campaign.id = membership.campaign_id
      WHERE membership.campaign_id = ? AND membership.principal_id = ?
        AND (membership.role = 'gm' OR (
          membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
        ))`)
      .get(envelope.campaignId, principalId);
    if (!authorized) throw new Error("set actor attribute command unavailable");

    const collisions = db.prepare(`SELECT campaign_id, command_id, idempotency_key, timeline_id,
        actor_id, expected_revision, source_turn_id, type, attribute_id, value,
        resource_name, resource_current, resource_max, dice_expression, dice_count, dice_sides,
        dice_selection_type, dice_selection_count, dice_modifier
      FROM campaign_commands
      WHERE campaign_id = ? AND (command_id = ? OR idempotency_key = ?)
      ORDER BY rowid`).all(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as CampaignCommandRow[];
    if (collisions.length > 0) {
      if (collisions.length !== 1 || !commandRowMatchesEnvelope(collisions[0]!, envelope)) {
        throw new Error("set actor attribute command identity collision");
      }
      const retry = db.prepare(`SELECT command.*,
          retry_timeline.id AS retry_timeline_presence,
          retry_timeline.revision AS retry_timeline_revision,
          ((SELECT COUNT(*) FROM campaign_timeline_events timeline_event
            WHERE timeline_event.campaign_id = command.campaign_id
              AND timeline_event.timeline_id = command.timeline_id)
            + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
              WHERE imported.campaign_id=command.campaign_id AND imported.timeline_id=command.timeline_id)) AS retry_timeline_event_count,
          retry_actor.id AS retry_actor_presence,
          receipt.revision_before, receipt.revision_after, receipt.event_id AS receipt_event_id,
          event.event_id, event.campaign_id AS event_campaign_id, event.command_id AS event_command_id,
          event.timeline_id AS event_timeline_id, event.actor_id AS event_actor_id,
           event.source_turn_id AS event_source_turn_id, event.type AS event_type,
           event.revision AS event_revision, event.occurred_at, event.attribute_id AS event_attribute_id,
           event.value_before, event.value_after, event.resource_name AS event_resource_name,
            event.resource_current AS event_resource_current, event.resource_max AS event_resource_max,
            (SELECT roll.event_id FROM rpg_dice_rolls roll WHERE roll.event_id = event.event_id) AS dice_roll_presence
        FROM campaign_commands command
        LEFT JOIN command_receipts receipt
          ON receipt.campaign_id = command.campaign_id AND receipt.command_id = command.command_id
        LEFT JOIN campaign_events event
          ON event.campaign_id = receipt.campaign_id AND event.command_id = receipt.command_id
            AND event.event_id = receipt.event_id AND event.revision = receipt.revision_after
        LEFT JOIN campaign_timelines retry_timeline
          ON retry_timeline.campaign_id = event.campaign_id AND retry_timeline.id = event.timeline_id
        LEFT JOIN campaign_actors retry_actor
          ON retry_actor.campaign_id = event.campaign_id AND retry_actor.id = event.actor_id
        WHERE command.campaign_id = ? AND command.command_id = ? AND command.idempotency_key = ?`)
        .get(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as CommandRetryRow | undefined;
      if (!retry) throw new Error("set actor attribute command retry is incomplete");
      return receiptFromRetryRow(retry, envelope);
    }

    const timeline = db.prepare(`SELECT timeline.revision
      FROM campaigns campaign
      JOIN campaign_timelines timeline
        ON timeline.campaign_id = campaign.id AND timeline.id = campaign.active_timeline_id
      WHERE campaign.id = ? AND campaign.active_timeline_id = ?`)
      .get(envelope.campaignId, envelope.timelineId) as { revision: unknown } | undefined;
    if (!timeline) throw new Error("set actor attribute command timeline is inactive");
    const timelineRevision = revisionSchema.parse(timeline.revision);
    if (timelineRevision !== envelope.expectedRevision) {
      throw new Error("set actor attribute command revision does not match");
    }
    const target = db.prepare(`SELECT actor.sheet_id, sheet.updated_at,
        attribute.attribute_id, attribute.value
      FROM campaign_actors actor
      JOIN campaign_characters campaign_character
        ON campaign_character.campaign_id = actor.campaign_id
          AND campaign_character.id = actor.campaign_character_id
      JOIN rpg_campaign_sheets sheet
        ON sheet.campaign_id = actor.campaign_id AND sheet.id = actor.sheet_id
          AND sheet.campaign_character_id = campaign_character.id
      JOIN rpg_character_attributes attribute
        ON attribute.campaign_id = sheet.campaign_id AND attribute.sheet_id = sheet.id
          AND attribute.attribute_id = ?
      WHERE actor.campaign_id = ? AND actor.id = ?`)
      .get(command.payload.attributeId, envelope.campaignId, envelope.actorId) as
      | { sheet_id: string; updated_at: string; attribute_id: string; value: number }
      | undefined;
    if (!target) throw new Error("set actor attribute command target unavailable");
    // Treat persisted state as untrusted. These shared contract schemas keep a
    // damaged row from reaching dependency consumption or command writes.
    const targetSheetId = resourceIdSchema.parse(target.sheet_id);
    const targetUpdatedAt = utcIsoTimestampSchema.parse(target.updated_at);
    const targetAttribute = setActorAttributePayloadSchema.parse({
      attributeId: target.attribute_id,
      value: target.value,
    });
    if (targetAttribute.value === command.payload.value) {
      throw new Error("set actor attribute command cannot be a no-op");
    }

    const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
    const occurredAt = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
    if (occurredAt < targetUpdatedAt) {
      throw new Error("set actor attribute command timestamp cannot precede sheet updated_at");
    }
    const revisionAfter = envelope.expectedRevision + 1;
    const event = rpgEventSchema.parse({
      eventId,
      commandId: envelope.commandId,
      campaignId: envelope.campaignId,
      timelineId: envelope.timelineId,
      actorId: envelope.actorId,
      sourceTurnId: envelope.sourceTurnId,
      type: "actor_attribute_set",
      revision: revisionAfter,
      occurredAt,
      data: {
        attributeId: command.payload.attributeId,
        valueBefore: targetAttribute.value,
        valueAfter: command.payload.value,
      },
    });
    if (event.type !== "actor_attribute_set") {
      throw new Error("set actor attribute command produced an invalid event");
    }
    const receipt = commandReceiptSchema.parse({
      commandId: envelope.commandId,
      campaignId: envelope.campaignId,
      revisionBefore: envelope.expectedRevision,
      revisionAfter,
      events: [event],
    });

    // This order is part of the persistence contract and satisfies the v12
    // audit triggers without temporarily weakening any foreign key.
    db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(envelope.campaignId, envelope.commandId, envelope.idempotencyKey, envelope.timelineId,
        envelope.actorId, envelope.expectedRevision, envelope.sourceTurnId, command.type,
        command.payload.attributeId, command.payload.value);
    const attributeWrite = db.prepare(`UPDATE rpg_character_attributes SET value = ?
      WHERE campaign_id = ? AND sheet_id = ? AND attribute_id = ? AND value = ?`)
      .run(command.payload.value, envelope.campaignId, targetSheetId,
        command.payload.attributeId, targetAttribute.value);
    if (attributeWrite.changes !== 1) throw new Error("set actor attribute command target changed");
    const sheetWrite = db.prepare(`UPDATE rpg_campaign_sheets SET updated_at = ?
      WHERE campaign_id = ? AND id = ? AND updated_at = ?`)
      .run(occurredAt, envelope.campaignId, targetSheetId, targetUpdatedAt);
    if (sheetWrite.changes !== 1) throw new Error("set actor attribute command target changed");
    const timelineWrite = db.prepare(`UPDATE campaign_timelines SET revision = ?
      WHERE campaign_id = ? AND id = ? AND revision = ?`)
      .run(revisionAfter, envelope.campaignId, envelope.timelineId, envelope.expectedRevision);
    if (timelineWrite.changes !== 1) throw new Error("set actor attribute command revision changed");
    db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, event.campaignId, event.commandId, event.timelineId, event.actorId,
        event.sourceTurnId, event.type, event.revision, event.occurredAt, event.data.attributeId,
        event.data.valueBefore, event.data.valueAfter);
    db.prepare(`INSERT INTO command_receipts
      (campaign_id, command_id, revision_before, revision_after, event_id) VALUES (?, ?, ?, ?, ?)`)
      .run(receipt.campaignId, receipt.commandId, receipt.revisionBefore, receipt.revisionAfter, event.eventId);
    return receipt;
  });
  return run.immediate();
}

export function executeRollActorDiceSync(db: DatabaseDriver.Database, dependencies: RepositoryDependencies,
  actorPrincipalId: string, input: CommandEnvelope): CommandReceipt {
  return executeRollActorDiceAtomic(db, dependencies, actorPrincipalId, input);
}

interface LockedDiceCharacterAncestryRow {
  actor_id: unknown;
  campaign_character_id: unknown;
  actor_campaign_id: unknown;
  sheet_id: unknown;
  sheet_campaign_character_id: unknown;
  sheet_campaign_id: unknown;
}

export function executeRollActorDiceForVisibleCharacterSync(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
  actorPrincipalId: string,
  input: CommandEnvelope,
  inputBinding: CampaignDiceVisibleCharacterBinding,
): CommandReceipt {
  const position = inputBinding.position;
  if (!Number.isSafeInteger(position) || position < 1 || position > MAX_CAMPAIGN_CHARACTER_ROSTER) {
    throw new Error("campaign dice visible character position is invalid");
  }
  const name = publicCampaignCharacterSummarySchema.shape.name.parse(inputBinding.name);
  const campaignCharacterId = resourceIdSchema.parse(inputBinding.campaignCharacterId);

  return executeRollActorDiceAtomic(db, dependencies, actorPrincipalId, input, (envelope, principalId) => {
    // BEGIN IMMEDIATE is already held. Roster drift cannot occur between this
    // validation and the generic executor's RNG, identities, clock, or writes.
    const roster = getCampaignCharacterRosterSyncInternal(db, principalId, envelope.campaignId);
    if (roster === null) throw new Error("roll actor dice command unavailable");
    const current = roster.characters[position - 1];
    if (current === undefined || current.id !== campaignCharacterId || current.name !== name) {
      throw new CampaignDiceCharacterConflict();
    }

    const ancestry = db.prepare(`SELECT actor.id AS actor_id,
        actor.campaign_character_id, actor.campaign_id AS actor_campaign_id,
        sheet.id AS sheet_id, sheet.campaign_character_id AS sheet_campaign_character_id,
        sheet.campaign_id AS sheet_campaign_id
      FROM campaign_characters cc
      JOIN rpg_campaign_sheets sheet ON sheet.campaign_id=cc.campaign_id
        AND sheet.campaign_character_id=cc.id
      JOIN campaign_actors actor ON actor.campaign_id=cc.campaign_id
        AND actor.campaign_character_id=cc.id AND actor.sheet_id=sheet.id
      WHERE cc.campaign_id=? AND cc.id=?`).all(envelope.campaignId, campaignCharacterId) as
      LockedDiceCharacterAncestryRow[];
    if (ancestry.length !== 1) throw new Error("campaign dice character ancestry is malformed");
    const row = ancestry[0]!;
    const actorId = resourceIdSchema.parse(row.actor_id);
    resourceIdSchema.parse(row.sheet_id);
    if (resourceIdSchema.parse(row.campaign_character_id) !== campaignCharacterId
      || resourceIdSchema.parse(row.actor_campaign_id) !== envelope.campaignId
      || resourceIdSchema.parse(row.sheet_campaign_character_id) !== campaignCharacterId
      || resourceIdSchema.parse(row.sheet_campaign_id) !== envelope.campaignId) {
      throw new Error("campaign dice character ancestry is malformed");
    }
    if (actorId !== envelope.actorId) throw new CampaignDiceCharacterConflict();
  });
}

function resourceReceiptFromRetryRow(row: CommandRetryRow, envelope: CommandEnvelope): CommandReceipt {
  if (
    row.retry_timeline_presence === null || row.retry_timeline_revision === null
    || row.retry_actor_presence === null
    || row.revision_before === null || row.revision_after === null || row.receipt_event_id === null
    || row.event_id === null || row.event_campaign_id === null || row.event_command_id === null
    || row.event_timeline_id === null || row.event_actor_id === null || row.event_type === null
    || row.event_revision === null || row.occurred_at === null
    || row.event_attribute_id !== null || row.value_before !== null || row.value_after !== null
    || row.event_resource_name === null || row.event_resource_current === null || row.event_resource_max === null
    || row.dice_roll_presence !== null
  ) {
    throw new Error("initialize actor resource command retry is incomplete");
  }
  if (row.receipt_event_id !== row.event_id) {
    throw new Error("initialize actor resource command retry is invalid");
  }
  const event = rpgEventSchema.parse({
    eventId: row.event_id,
    commandId: row.event_command_id,
    campaignId: row.event_campaign_id,
    timelineId: row.event_timeline_id,
    actorId: row.event_actor_id,
    sourceTurnId: row.event_source_turn_id,
    type: row.event_type,
    revision: row.event_revision,
    occurredAt: row.occurred_at,
    data: {
      name: row.event_resource_name,
      current: row.event_resource_current,
      max: row.event_resource_max,
    },
  });
  const receipt = commandReceiptSchema.parse({
    commandId: row.command_id,
    campaignId: row.campaign_id,
    revisionBefore: row.revision_before,
    revisionAfter: row.revision_after,
    events: [event],
  });
  const retryTimelineRevision = revisionSchema.parse(row.retry_timeline_revision);
  const retryTimelineEventCount = revisionSchema.parse(row.retry_timeline_event_count);
  if (event.type !== "actor_resource_initialized" || envelope.command.type !== "initialize_actor_resource") {
    throw new Error("initialize actor resource command retry is invalid");
  }
  if (
    event.timelineId !== envelope.timelineId || event.actorId !== envelope.actorId
    || event.sourceTurnId !== envelope.sourceTurnId
    || event.data.name !== envelope.command.payload.name
    || event.data.current !== envelope.command.payload.current
    || event.data.max !== envelope.command.payload.max
    || receipt.revisionBefore !== envelope.expectedRevision
    || retryTimelineRevision < event.revision
    || retryTimelineEventCount !== retryTimelineRevision
  ) {
    throw new Error("initialize actor resource command retry is invalid");
  }
  return receipt;
}

function executeInitializeActorResourceSync(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
  actorPrincipalId: string,
  input: CommandEnvelope,
): CommandReceipt {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const envelope = commandEnvelopeSchema.parse(input);
  if (envelope.command.type !== "initialize_actor_resource") {
    throw new Error("executeInitializeActorResource requires an initialize_actor_resource command");
  }
  const command = envelope.command;
  const run = db.transaction(() => {
    const authorized = db.prepare(`SELECT 1
      FROM campaign_memberships membership
      JOIN principals principal ON principal.id = membership.principal_id
      JOIN campaigns campaign ON campaign.id = membership.campaign_id
      WHERE membership.campaign_id = ? AND membership.principal_id = ?
        AND (membership.role = 'gm' OR (
          membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
        ))`)
      .get(envelope.campaignId, principalId);
    if (!authorized) throw new Error("initialize actor resource command unavailable");

    const collisions = db.prepare(`SELECT campaign_id, command_id, idempotency_key, timeline_id,
        actor_id, expected_revision, source_turn_id, type, attribute_id, value,
        resource_name, resource_current, resource_max, dice_expression, dice_count, dice_sides,
        dice_selection_type, dice_selection_count, dice_modifier
      FROM campaign_commands
      WHERE campaign_id = ? AND (command_id = ? OR idempotency_key = ?)
      ORDER BY rowid`).all(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as CampaignCommandRow[];
    if (collisions.length > 0) {
      if (collisions.length !== 1 || !commandRowMatchesResourceEnvelope(collisions[0]!, envelope)) {
        throw new Error("initialize actor resource command identity collision");
      }
      const retry = db.prepare(`SELECT command.*,
          retry_timeline.id AS retry_timeline_presence,
          retry_timeline.revision AS retry_timeline_revision,
          ((SELECT COUNT(*) FROM campaign_timeline_events timeline_event
            WHERE timeline_event.campaign_id = command.campaign_id
              AND timeline_event.timeline_id = command.timeline_id)
            + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
              WHERE imported.campaign_id=command.campaign_id AND imported.timeline_id=command.timeline_id)) AS retry_timeline_event_count,
          retry_actor.id AS retry_actor_presence,
          receipt.revision_before, receipt.revision_after, receipt.event_id AS receipt_event_id,
          event.event_id, event.campaign_id AS event_campaign_id, event.command_id AS event_command_id,
          event.timeline_id AS event_timeline_id, event.actor_id AS event_actor_id,
          event.source_turn_id AS event_source_turn_id, event.type AS event_type,
          event.revision AS event_revision, event.occurred_at, event.attribute_id AS event_attribute_id,
          event.value_before, event.value_after, event.resource_name AS event_resource_name,
            event.resource_current AS event_resource_current, event.resource_max AS event_resource_max,
            (SELECT roll.event_id FROM rpg_dice_rolls roll WHERE roll.event_id = event.event_id) AS dice_roll_presence
        FROM campaign_commands command
        LEFT JOIN command_receipts receipt
          ON receipt.campaign_id = command.campaign_id AND receipt.command_id = command.command_id
        LEFT JOIN campaign_events event
          ON event.campaign_id = receipt.campaign_id AND event.command_id = receipt.command_id
            AND event.event_id = receipt.event_id AND event.revision = receipt.revision_after
        LEFT JOIN campaign_timelines retry_timeline
          ON retry_timeline.campaign_id = event.campaign_id AND retry_timeline.id = event.timeline_id
        LEFT JOIN campaign_actors retry_actor
          ON retry_actor.campaign_id = event.campaign_id AND retry_actor.id = event.actor_id
        WHERE command.campaign_id = ? AND command.command_id = ? AND command.idempotency_key = ?`)
        .get(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as CommandRetryRow | undefined;
      if (!retry) throw new Error("initialize actor resource command retry is incomplete");
      return resourceReceiptFromRetryRow(retry, envelope);
    }

    const timeline = db.prepare(`SELECT timeline.revision
      FROM campaigns campaign
      JOIN campaign_timelines timeline
        ON timeline.campaign_id = campaign.id AND timeline.id = campaign.active_timeline_id
      WHERE campaign.id = ? AND campaign.active_timeline_id = ?`)
      .get(envelope.campaignId, envelope.timelineId) as { revision: unknown } | undefined;
    if (!timeline) throw new Error("initialize actor resource command timeline is inactive");
    const timelineRevision = revisionSchema.parse(timeline.revision);
    if (timelineRevision !== envelope.expectedRevision) {
      throw new Error("initialize actor resource command revision does not match");
    }

    const target = db.prepare(`SELECT actor.id
      FROM campaign_actors actor
      JOIN campaign_characters campaign_character
        ON campaign_character.campaign_id = actor.campaign_id
          AND campaign_character.id = actor.campaign_character_id
      JOIN rpg_campaign_sheets sheet
        ON sheet.campaign_id = actor.campaign_id AND sheet.id = actor.sheet_id
          AND sheet.campaign_character_id = campaign_character.id
      WHERE actor.campaign_id = ? AND actor.id = ?`)
      .get(envelope.campaignId, envelope.actorId) as { id: string } | undefined;
    if (!target) throw new Error("initialize actor resource command target unavailable");
    resourceIdSchema.parse(target.id);
    const existingResource = db.prepare(`SELECT campaign_id FROM rpg_actor_resources
      WHERE actor_id = ? AND name = ?`).get(envelope.actorId, command.payload.name) as
      | { campaign_id: unknown }
      | undefined;
    if (existingResource) {
      if (resourceIdSchema.parse(existingResource.campaign_id) !== envelope.campaignId) {
        throw new Error("initialize actor resource command resource is invalid");
      }
      throw new Error("initialize actor resource command resource already exists");
    }

    const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
    const occurredAt = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
    const revisionAfter = envelope.expectedRevision + 1;
    const event = rpgEventSchema.parse({
      eventId,
      commandId: envelope.commandId,
      campaignId: envelope.campaignId,
      timelineId: envelope.timelineId,
      actorId: envelope.actorId,
      sourceTurnId: envelope.sourceTurnId,
      type: "actor_resource_initialized",
      revision: revisionAfter,
      occurredAt,
      data: command.payload,
    });
    if (event.type !== "actor_resource_initialized") {
      throw new Error("initialize actor resource command produced an invalid event");
    }
    const receipt = commandReceiptSchema.parse({
      commandId: envelope.commandId,
      campaignId: envelope.campaignId,
      revisionBefore: envelope.expectedRevision,
      revisionAfter,
      events: [event],
    });

    db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, resource_name, resource_current, resource_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(envelope.campaignId, envelope.commandId, envelope.idempotencyKey, envelope.timelineId,
        envelope.actorId, envelope.expectedRevision, envelope.sourceTurnId, command.type,
        command.payload.name, command.payload.current, command.payload.max);
    db.prepare(`INSERT INTO rpg_actor_resources (campaign_id, actor_id, name, current, max)
      VALUES (?, ?, ?, ?, ?)`)
      .run(envelope.campaignId, envelope.actorId, command.payload.name,
        command.payload.current, command.payload.max);
    const timelineWrite = db.prepare(`UPDATE campaign_timelines SET revision = ?
      WHERE campaign_id = ? AND id = ? AND revision = ?`)
      .run(revisionAfter, envelope.campaignId, envelope.timelineId, envelope.expectedRevision);
    if (timelineWrite.changes !== 1) throw new Error("initialize actor resource command revision changed");
    db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, resource_name, resource_current, resource_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, event.campaignId, event.commandId, event.timelineId, event.actorId,
        event.sourceTurnId, event.type, event.revision, event.occurredAt,
        event.data.name, event.data.current, event.data.max);
    db.prepare(`INSERT INTO command_receipts
      (campaign_id, command_id, revision_before, revision_after, event_id) VALUES (?, ?, ?, ?, ?)`)
      .run(receipt.campaignId, receipt.commandId, receipt.revisionBefore, receipt.revisionAfter, event.eventId);
    return receipt;
  });
  return run.immediate();
}

interface DiceRetryRow extends CommandRetryRow {
  retry_timeline_min_revision: unknown; retry_timeline_max_revision: unknown;
  retry_timeline_invalid_event_count: unknown;
  retry_campaign_character_presence: string | null; retry_character_presence: string | null;
  retry_sheet_presence: string | null;
  roll_event_id: string | null; roll_campaign_id: string | null; roll_command_id: string | null;
  roll_expression: string | null; roll_dice_count: number | null; roll_dice_sides: number | null;
  roll_selection_type: string | null; roll_selection_count: number | null;
  roll_modifier: number | null; roll_total: number | null;
}

function diceReceiptFromRetryRow(db: DatabaseDriver.Database, row: DiceRetryRow, envelope: CommandEnvelope): CommandReceipt {
  if (envelope.command.type !== "roll_actor_dice" || row.retry_timeline_presence === null
      || row.retry_timeline_revision === null || row.retry_actor_presence === null
      || row.retry_campaign_character_presence === null || row.retry_character_presence === null
      || row.retry_sheet_presence === null
      || row.revision_before === null || row.revision_after === null || row.receipt_event_id === null
      || row.event_id === null || row.event_campaign_id === null || row.event_command_id === null
      || row.event_timeline_id === null || row.event_actor_id === null || row.event_type === null
      || row.event_revision === null || row.occurred_at === null || row.event_attribute_id !== null
      || row.value_before !== null || row.value_after !== null || row.event_resource_name !== null
      || row.event_resource_current !== null || row.event_resource_max !== null || row.roll_event_id === null
      || row.roll_campaign_id === null || row.roll_command_id === null || row.roll_expression === null
      || row.roll_dice_count === null || row.roll_dice_sides === null || row.roll_selection_type === null
      || row.roll_modifier === null || row.roll_total === null) {
    throw new Error("roll actor dice command retry is incomplete");
  }
  if (row.receipt_event_id !== row.event_id || row.roll_event_id !== row.event_id) {
    throw new Error("roll actor dice command retry is invalid");
  }
  const terms = db.prepare("SELECT position, value, kept FROM rpg_dice_terms WHERE event_id = ? ORDER BY position")
    .all(row.event_id) as Array<{ position: unknown; value: unknown; kept: unknown }>;
  const normalized = parseDiceExpression(row.roll_expression);
  const physicalCount = normalized.selection.type === "advantage" || normalized.selection.type === "disadvantage"
    ? 2 : normalized.count;
  if (terms.length !== physicalCount || terms.some((term, index) => term.position !== index)) {
    throw new Error("roll actor dice command retry is incomplete");
  }
  // Do not coerce corrupt SQLite values into booleans.  A database opened with
  // checks disabled can contain text, fractions, or arbitrary integers here;
  // every such row must make historical reconstruction fail closed.
  if (terms.some((term) => typeof term.kept !== "number" || !Number.isInteger(term.kept)
      || (term.kept !== 0 && term.kept !== 1))) {
    throw new Error("roll actor dice command retry is invalid");
  }
  const termData = terms.map((term) => ({ value: term.value, kept: term.kept === 1 }));
  const selectionCount = normalized.selection.type === "keep_highest" || normalized.selection.type === "keep_lowest"
    ? normalized.selection.count : null;
  if (row.roll_campaign_id !== row.campaign_id || row.roll_command_id !== row.command_id
      || row.roll_dice_count !== normalized.count || row.roll_dice_sides !== normalized.sides
      || row.roll_selection_type !== normalized.selection.type || row.roll_selection_count !== selectionCount
      || row.roll_modifier !== normalized.modifier) throw new Error("roll actor dice command retry is invalid");
  const keepCount = selectionCount ?? (normalized.selection.type === "all" ? normalized.count : 1);
  const keepHigh = normalized.selection.type === "keep_highest" || normalized.selection.type === "advantage";
  const expectedKept = new Set(termData.map((_, index) => index).sort((left, right) => {
    if (normalized.selection.type === "all") return left - right;
    const difference = keepHigh ? Number(termData[right]!.value) - Number(termData[left]!.value)
      : Number(termData[left]!.value) - Number(termData[right]!.value);
    return difference === 0 ? left - right : difference;
  }).slice(0, keepCount));
  if (termData.some((term, index) => term.kept !== expectedKept.has(index))) {
    throw new Error("roll actor dice command retry is invalid");
  }
  const event = rpgEventSchema.parse({ eventId: row.event_id, commandId: row.event_command_id,
    campaignId: row.event_campaign_id, timelineId: row.event_timeline_id, actorId: row.event_actor_id,
    sourceTurnId: row.event_source_turn_id, type: row.event_type, revision: row.event_revision,
    occurredAt: row.occurred_at, data: { expression: row.roll_expression, normalized, terms: termData,
      modifier: row.roll_modifier, total: row.roll_total } });
  const receipt = commandReceiptSchema.parse({ commandId: row.command_id, campaignId: row.campaign_id,
    revisionBefore: row.revision_before, revisionAfter: row.revision_after, events: [event] });
  const timelineRevision = revisionSchema.parse(row.retry_timeline_revision);
  const eventCount = revisionSchema.parse(row.retry_timeline_event_count);
  const invalidEventCount = revisionSchema.parse(row.retry_timeline_invalid_event_count);
  if (event.type !== "actor_dice_rolled" || event.timelineId !== envelope.timelineId
      || event.actorId !== envelope.actorId || event.sourceTurnId !== envelope.sourceTurnId
      || event.data.expression !== envelope.command.payload.expression
      || receipt.revisionBefore !== envelope.expectedRevision || timelineRevision < event.revision
      || eventCount !== timelineRevision || invalidEventCount !== 0 || (timelineRevision > 0
        && (row.retry_timeline_min_revision !== 1 || row.retry_timeline_max_revision !== timelineRevision))) {
    throw new Error("roll actor dice command retry is invalid");
  }
  return receipt;
}

// A retry may return an old receipt only when every event through the current
// timeline head still has its exact immutable parents and a complete variant.
// Keep this as one bounded SQL aggregate rather than reconstructing unbounded
// later history in application memory.
const validResourceIdSql = (value: string): string => `(typeof(${value})='text'
  AND length(${value}) BETWEEN 1 AND 128 AND instr(${value},char(0))=0
  AND ${value} NOT GLOB '*[^A-Za-z0-9._:-]*')`;

const DICE_RETRY_INVALID_HISTORY_COUNT = `(SELECT COUNT(*) FROM campaign_events history
  WHERE history.campaign_id=command.campaign_id AND history.timeline_id=command.timeline_id
    AND NOT EXISTS (
      SELECT 1 FROM campaign_commands history_command
      JOIN command_receipts history_receipt
        ON history_receipt.campaign_id=history_command.campaign_id
        AND history_receipt.command_id=history_command.command_id
        AND history_receipt.revision_before=history_command.expected_revision
        AND history_receipt.revision_after=history.revision
        AND history_receipt.event_id=history.event_id
      JOIN campaign_timelines history_timeline
        ON history_timeline.campaign_id=history.campaign_id AND history_timeline.id=history.timeline_id
        AND history_timeline.revision>=history.revision
      JOIN campaign_actors history_actor
        ON history_actor.campaign_id=history.campaign_id AND history_actor.id=history.actor_id
      LEFT JOIN rpg_dice_rolls history_roll ON history_roll.event_id=history.event_id
      WHERE history_command.campaign_id=history.campaign_id
        AND history_command.command_id=history.command_id
        AND history_command.timeline_id=history.timeline_id
        AND history_command.actor_id=history.actor_id
        AND history_command.source_turn_id IS history.source_turn_id
        AND history_command.expected_revision+1=history.revision
        AND ${validResourceIdSql("history_command.campaign_id")}
        AND ${validResourceIdSql("history_command.command_id")}
        AND ${validResourceIdSql("history_command.idempotency_key")}
        AND ${validResourceIdSql("history_command.timeline_id")}
        AND ${validResourceIdSql("history_command.actor_id")}
        AND (history_command.source_turn_id IS NULL
          OR ${validResourceIdSql("history_command.source_turn_id")})
        AND ${validResourceIdSql("history.event_id")}
        AND ${validResourceIdSql("history.campaign_id")}
        AND ${validResourceIdSql("history.command_id")}
        AND ${validResourceIdSql("history.timeline_id")}
        AND ${validResourceIdSql("history.actor_id")}
        AND (history.source_turn_id IS NULL OR ${validResourceIdSql("history.source_turn_id")})
        AND ${validResourceIdSql("history_receipt.campaign_id")}
        AND ${validResourceIdSql("history_receipt.command_id")}
        AND ${validResourceIdSql("history_receipt.event_id")}
        AND ${validResourceIdSql("history_timeline.campaign_id")}
        AND ${validResourceIdSql("history_timeline.id")}
        AND ${validResourceIdSql("history_actor.campaign_id")}
        AND ${validResourceIdSql("history_actor.id")}
        AND history.occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',history.occurred_at)
        AND substr(history.occurred_at,12,2) BETWEEN '00' AND '23'
        AND (
          (history_command.type='set_actor_attribute' AND history.type='actor_attribute_set'
            AND history_command.attribute_id=history.attribute_id
            AND ${validResourceIdSql("history_command.attribute_id")}
            AND ${validResourceIdSql("history.attribute_id")}
            AND history_command.value=history.value_after AND history.value_before<>history.value_after
            AND typeof(history.value_before)='integer' AND history.value_before BETWEEN -1000 AND 1000
            AND typeof(history.value_after)='integer' AND history.value_after BETWEEN -1000 AND 1000
            AND history_command.resource_name IS NULL AND history_command.resource_current IS NULL
            AND history_command.resource_max IS NULL AND history_command.dice_expression IS NULL
            AND history_command.dice_count IS NULL AND history_command.dice_sides IS NULL
            AND history_command.dice_selection_type IS NULL
            AND history_command.dice_selection_count IS NULL AND history_command.dice_modifier IS NULL
            AND history.resource_name IS NULL AND history.resource_current IS NULL
            AND history.resource_max IS NULL AND history_roll.event_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history.event_id))
          OR (history_command.type='initialize_actor_resource' AND history.type='actor_resource_initialized'
            AND history_command.attribute_id IS NULL AND history_command.value IS NULL
            AND history_command.dice_expression IS NULL AND history_command.dice_count IS NULL
            AND history_command.dice_sides IS NULL AND history_command.dice_selection_type IS NULL
            AND history_command.dice_selection_count IS NULL AND history_command.dice_modifier IS NULL
            AND history.attribute_id IS NULL
            AND history.value_before IS NULL AND history.value_after IS NULL
            AND history_command.resource_name=history.resource_name
            AND ${validResourceIdSql("history_command.resource_name")}
            AND ${validResourceIdSql("history.resource_name")}
            AND history_command.resource_current=history.resource_current
            AND history_command.resource_max=history.resource_max
            AND typeof(history.resource_current)='integer' AND history.resource_current BETWEEN 0 AND 1000000
            AND typeof(history.resource_max)='integer' AND history.resource_max BETWEEN 0 AND 1000000
            AND history.resource_current<=history.resource_max AND history_roll.event_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history.event_id))
          OR (history_command.type='roll_actor_dice' AND history.type='actor_dice_rolled'
            AND history_command.attribute_id IS NULL AND history_command.value IS NULL
            AND history_command.resource_name IS NULL AND history_command.resource_current IS NULL
            AND history_command.resource_max IS NULL AND history.attribute_id IS NULL
            AND history.value_before IS NULL AND history.value_after IS NULL
            AND history.resource_name IS NULL AND history.resource_current IS NULL
            AND history.resource_max IS NULL AND history_roll.campaign_id=history.campaign_id
            AND history_roll.command_id=history.command_id
            AND ${validResourceIdSql("history_roll.event_id")}
            AND ${validResourceIdSql("history_roll.campaign_id")}
            AND ${validResourceIdSql("history_roll.command_id")}
            AND history_roll.expression=history_command.dice_expression
            AND history_roll.dice_count=history_command.dice_count
            AND history_roll.dice_sides=history_command.dice_sides
            AND history_roll.selection_type=history_command.dice_selection_type
            AND history_roll.selection_count IS history_command.dice_selection_count
            AND history_roll.modifier=history_command.dice_modifier
            AND typeof(history_roll.dice_count)='integer' AND history_roll.dice_count BETWEEN 1 AND 100
            AND typeof(history_roll.dice_sides)='integer' AND history_roll.dice_sides BETWEEN 2 AND 1000
            AND typeof(history_roll.modifier)='integer' AND history_roll.modifier BETWEEN -1000 AND 1000
            AND typeof(history_roll.total)='integer' AND history_roll.total BETWEEN -1000 AND 101000
            AND ((history_roll.selection_type='all' AND history_roll.selection_count IS NULL)
              OR (history_roll.selection_type IN ('keep_highest','keep_lowest')
                AND typeof(history_roll.selection_count)='integer'
                AND history_roll.selection_count BETWEEN 1 AND history_roll.dice_count)
              OR (history_roll.selection_type IN ('advantage','disadvantage')
                AND history_roll.selection_count IS NULL AND history_roll.dice_count=1))
            AND history_roll.expression=CAST(history_roll.dice_count AS TEXT)||'d'||CAST(history_roll.dice_sides AS TEXT)
              ||CASE history_roll.selection_type WHEN 'all' THEN ''
                WHEN 'keep_highest' THEN 'kh'||CAST(history_roll.selection_count AS TEXT)
                WHEN 'keep_lowest' THEN 'kl'||CAST(history_roll.selection_count AS TEXT)
                WHEN 'advantage' THEN 'adv' ELSE 'dis' END
              ||CASE WHEN history_roll.modifier=0 THEN '' WHEN history_roll.modifier>0
                THEN '+'||CAST(history_roll.modifier AS TEXT) ELSE CAST(history_roll.modifier AS TEXT) END
            AND (SELECT COUNT(*) FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history_roll.event_id)
              =CASE WHEN history_roll.selection_type IN ('advantage','disadvantage')
                THEN 2 ELSE history_roll.dice_count END
            AND (SELECT COALESCE(MIN(position),0) FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history_roll.event_id)=0
            AND (SELECT COALESCE(MAX(position),-1) FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history_roll.event_id)
              =CASE WHEN history_roll.selection_type IN ('advantage','disadvantage')
                THEN 1 ELSE history_roll.dice_count-1 END
            AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history_roll.event_id
                AND (typeof(history_term.position)<>'integer' OR typeof(history_term.value)<>'integer'
                  OR history_term.value<1 OR history_term.value>history_roll.dice_sides
                  OR typeof(history_term.kept)<>'integer' OR history_term.kept NOT IN (0,1)))
            AND (SELECT COUNT(*) FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history_roll.event_id AND history_term.kept=1)
              =CASE WHEN history_roll.selection_type IN ('keep_highest','keep_lowest')
                THEN history_roll.selection_count
                WHEN history_roll.selection_type IN ('advantage','disadvantage') THEN 1
                ELSE history_roll.dice_count END
            AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms kept
              JOIN rpg_dice_terms discarded ON discarded.event_id=kept.event_id
              WHERE kept.event_id=history_roll.event_id AND kept.kept=1 AND discarded.kept=0
                AND ((history_roll.selection_type IN ('keep_highest','advantage')
                    AND (kept.value<discarded.value OR (kept.value=discarded.value
                      AND kept.position>discarded.position)))
                  OR (history_roll.selection_type IN ('keep_lowest','disadvantage')
                    AND (kept.value>discarded.value OR (kept.value=discarded.value
                      AND kept.position>discarded.position)))))
            AND history_roll.total=history_roll.modifier+
              (SELECT COALESCE(SUM(value),0) FROM rpg_dice_terms history_term
                WHERE history_term.event_id=history_roll.event_id AND history_term.kept=1))
        )
    ))`;

function executeRollActorDiceAtomic(db: DatabaseDriver.Database, dependencies: RepositoryDependencies,
  actorPrincipalId: string, input: CommandEnvelope,
  validateLockedTarget?: (envelope: CommandEnvelope, principalId: string) => void): CommandReceipt {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const envelope = commandEnvelopeSchema.parse(input);
  if (envelope.command.type !== "roll_actor_dice") {
    throw new Error("executeRollActorDice requires a roll_actor_dice command");
  }
  const command = envelope.command;
  const run = db.transaction(() => {
    const authorized = db.prepare(`SELECT 1 FROM campaign_memberships membership
      JOIN principals principal ON principal.id = membership.principal_id
      JOIN campaigns campaign ON campaign.id = membership.campaign_id
      WHERE membership.campaign_id = ? AND membership.principal_id = ? AND
        (membership.role = 'gm' OR (membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id))`)
      .get(envelope.campaignId, principalId);
    if (!authorized) throw new Error("roll actor dice command unavailable");
    validateLockedTarget?.(envelope, principalId);
    const collisions = db.prepare(`SELECT campaign_id, command_id, idempotency_key, timeline_id, actor_id,
      expected_revision, source_turn_id, type, attribute_id, value, resource_name, resource_current,
      resource_max, dice_expression, dice_count, dice_sides, dice_selection_type, dice_selection_count,
      dice_modifier FROM campaign_commands WHERE campaign_id = ? AND (command_id = ? OR idempotency_key = ?)
      ORDER BY rowid`).all(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as CampaignCommandRow[];
    if (collisions.length > 0) {
      if (collisions.length !== 1 || !commandRowMatchesDiceEnvelope(collisions[0]!, envelope)) {
        throw new Error("roll actor dice command identity collision");
      }
      const retry = db.prepare(`SELECT command.*,
        timeline.id retry_timeline_presence, timeline.revision retry_timeline_revision,
        ((SELECT COUNT(*) FROM campaign_timeline_events h WHERE h.campaign_id=command.campaign_id AND h.timeline_id=command.timeline_id)
          + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
            WHERE imported.campaign_id=command.campaign_id AND imported.timeline_id=command.timeline_id)) retry_timeline_event_count,
        (SELECT MIN(revision) FROM (SELECT revision FROM campaign_timeline_events h
            WHERE h.campaign_id=command.campaign_id AND h.timeline_id=command.timeline_id
          UNION ALL SELECT revision FROM campaign_imported_timeline_events imported
            WHERE imported.campaign_id=command.campaign_id AND imported.timeline_id=command.timeline_id)) retry_timeline_min_revision,
        (SELECT MAX(revision) FROM (SELECT revision FROM campaign_timeline_events h
            WHERE h.campaign_id=command.campaign_id AND h.timeline_id=command.timeline_id
          UNION ALL SELECT revision FROM campaign_imported_timeline_events imported
            WHERE imported.campaign_id=command.campaign_id AND imported.timeline_id=command.timeline_id)) retry_timeline_max_revision,
        (${DICE_RETRY_INVALID_HISTORY_COUNT} + (SELECT COUNT(*) FROM campaign_timeline_events link
          LEFT JOIN campaign_events linked_event ON linked_event.event_id=link.event_id
          WHERE link.campaign_id=command.campaign_id AND link.timeline_id=command.timeline_id
            AND (linked_event.event_id IS NULL OR linked_event.campaign_id<>link.campaign_id
              OR linked_event.revision<>link.revision
              OR (link.inherited=0 AND linked_event.timeline_id<>link.timeline_id)))) retry_timeline_invalid_event_count,
        actor.id retry_actor_presence, receipt.revision_before, receipt.revision_after, receipt.event_id receipt_event_id,
        campaign_character.id retry_campaign_character_presence,
        character.id retry_character_presence, sheet.id retry_sheet_presence,
        event.event_id, event.campaign_id event_campaign_id, event.command_id event_command_id,
        event.timeline_id event_timeline_id, event.actor_id event_actor_id, event.source_turn_id event_source_turn_id,
        event.type event_type, event.revision event_revision, event.occurred_at, event.attribute_id event_attribute_id,
        event.value_before, event.value_after, event.resource_name event_resource_name,
        event.resource_current event_resource_current, event.resource_max event_resource_max,
        roll.event_id dice_roll_presence, roll.event_id roll_event_id, roll.campaign_id roll_campaign_id,
        roll.command_id roll_command_id, roll.expression roll_expression, roll.dice_count roll_dice_count,
        roll.dice_sides roll_dice_sides, roll.selection_type roll_selection_type,
        roll.selection_count roll_selection_count, roll.modifier roll_modifier, roll.total roll_total
        FROM campaign_commands command
        LEFT JOIN command_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        LEFT JOIN campaign_events event ON event.campaign_id=receipt.campaign_id AND event.command_id=receipt.command_id
          AND event.event_id=receipt.event_id AND event.revision=receipt.revision_after
        LEFT JOIN campaign_timelines timeline ON timeline.campaign_id=event.campaign_id AND timeline.id=event.timeline_id
        LEFT JOIN campaign_actors actor ON actor.campaign_id=event.campaign_id AND actor.id=event.actor_id
        LEFT JOIN campaign_characters campaign_character
          ON campaign_character.campaign_id=actor.campaign_id
          AND campaign_character.id=actor.campaign_character_id
        LEFT JOIN characters character ON character.id=campaign_character.character_id
        LEFT JOIN rpg_campaign_sheets sheet ON sheet.campaign_id=actor.campaign_id
          AND sheet.id=actor.sheet_id AND sheet.campaign_character_id=campaign_character.id
        LEFT JOIN rpg_dice_rolls roll ON roll.event_id=event.event_id
        WHERE command.campaign_id=? AND command.command_id=? AND command.idempotency_key=?`)
        .get(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as DiceRetryRow | undefined;
      if (!retry) throw new Error("roll actor dice command retry is incomplete");
      return diceReceiptFromRetryRow(db, retry, envelope);
    }
    const timeline = db.prepare(`SELECT timeline.revision FROM campaigns campaign JOIN campaign_timelines timeline
      ON timeline.campaign_id=campaign.id AND timeline.id=campaign.active_timeline_id
      WHERE campaign.id=? AND campaign.active_timeline_id=?`).get(envelope.campaignId, envelope.timelineId) as
      { revision: unknown } | undefined;
    if (!timeline) throw new Error("roll actor dice command timeline is inactive");
    if (revisionSchema.parse(timeline.revision) !== envelope.expectedRevision) {
      throw new Error("roll actor dice command revision does not match");
    }
    const target = db.prepare(`SELECT actor.id FROM campaign_actors actor
      JOIN campaign_characters cc ON cc.campaign_id=actor.campaign_id AND cc.id=actor.campaign_character_id
      JOIN characters character ON character.id=cc.character_id
      JOIN rpg_campaign_sheets sheet ON sheet.campaign_id=actor.campaign_id AND sheet.id=actor.sheet_id
        AND sheet.campaign_character_id=cc.id WHERE actor.campaign_id=? AND actor.id=?`)
      .get(envelope.campaignId, envelope.actorId) as { id: unknown } | undefined;
    if (!target) throw new Error("roll actor dice command target unavailable");
    resourceIdSchema.parse(target.id);
    const result = evaluateDiceExpression(command.payload.expression, dependencies.rng);
    const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
    const occurredAt = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
    const revisionAfter = envelope.expectedRevision + 1;
    const event = rpgEventSchema.parse({ eventId, commandId: envelope.commandId, campaignId: envelope.campaignId,
      timelineId: envelope.timelineId, actorId: envelope.actorId, sourceTurnId: envelope.sourceTurnId,
      type: "actor_dice_rolled", revision: revisionAfter, occurredAt, data: result });
    if (event.type !== "actor_dice_rolled") throw new Error("roll actor dice command produced an invalid event");
    const receipt = commandReceiptSchema.parse({ commandId: envelope.commandId, campaignId: envelope.campaignId,
      revisionBefore: envelope.expectedRevision, revisionAfter, events: [event] });
    const selectionCount = result.normalized.selection.type === "keep_highest"
      || result.normalized.selection.type === "keep_lowest" ? result.normalized.selection.count : null;
    db.prepare(`INSERT INTO campaign_commands (campaign_id,command_id,idempotency_key,timeline_id,actor_id,
      expected_revision,source_turn_id,type,dice_expression,dice_count,dice_sides,dice_selection_type,
      dice_selection_count,dice_modifier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(envelope.campaignId,
      envelope.commandId,envelope.idempotencyKey,envelope.timelineId,envelope.actorId,envelope.expectedRevision,
      envelope.sourceTurnId,command.type,result.expression,result.normalized.count,result.normalized.sides,
      result.normalized.selection.type,selectionCount,result.modifier);
    const timelineWrite = db.prepare("UPDATE campaign_timelines SET revision=? WHERE campaign_id=? AND id=? AND revision=?")
      .run(revisionAfter,envelope.campaignId,envelope.timelineId,envelope.expectedRevision);
    if (timelineWrite.changes !== 1) throw new Error("roll actor dice command revision changed");
    db.prepare(`INSERT INTO rpg_dice_rolls (event_id,campaign_id,command_id,expression,dice_count,dice_sides,
      selection_type,selection_count,modifier,total) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(event.eventId,event.campaignId,
      event.commandId,result.expression,result.normalized.count,result.normalized.sides,result.normalized.selection.type,
      selectionCount,result.modifier,result.total);
    const insertTerm = db.prepare("INSERT INTO rpg_dice_terms (event_id,position,value,kept) VALUES (?,?,?,?)");
    result.terms.forEach((term, position) => insertTerm.run(event.eventId,position,term.value,term.kept ? 1 : 0));
    db.prepare(`INSERT INTO campaign_events (event_id,campaign_id,command_id,timeline_id,actor_id,source_turn_id,
      type,revision,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(event.eventId,event.campaignId,event.commandId,
      event.timelineId,event.actorId,event.sourceTurnId,event.type,event.revision,event.occurredAt);
    const receiptWrite = db.prepare("INSERT INTO command_receipts (campaign_id,command_id,revision_before,revision_after,event_id) VALUES (?,?,?,?,?)")
      .run(receipt.campaignId,receipt.commandId,receipt.revisionBefore,receipt.revisionAfter,event.eventId);
    if (receiptWrite.changes !== 1) throw new Error("roll actor dice command receipt was not persisted");
    return receipt;
  });
  return run.immediate();
}

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
      const complete = getCampaignCharacterSyncInternal(db, actorPrincipal, normalized.campaignId, duplicateId);
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

function createCampaignSyncInternal(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
  actorPrincipalId: string,
  input: CreateCampaignInput,
): Campaign {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = createCampaignInputSchema.parse(input);
  const run = db.transaction(() => {
    const owner = db.prepare(`
      SELECT application_owner.principal_id, principals.id AS principal_parent_id
      FROM application_owner
      LEFT JOIN principals ON principals.id = application_owner.principal_id
      WHERE application_owner.singleton = 1
    `).get() as
      | { principal_id: unknown; principal_parent_id: unknown }
      | undefined;
    // A missing/corrupt singleton is an internal invariant failure, not an
    // authorization decision. Only a complete, valid owner may deny another
    // otherwise-valid principal with the narrow typed error used by HTTP.
    if (!owner) throw new Error("application owner invariant is missing");
    const parsedOwnerId = resourceIdSchema.safeParse(owner.principal_id);
    if (!parsedOwnerId.success || owner.principal_parent_id !== parsedOwnerId.data) {
      throw new Error("application owner invariant is malformed");
    }
    if (parsedOwnerId.data !== actorId) {
      throw new CampaignCreationAuthorizationError();
    }
    const campaignId = resourceIdSchema.parse(dependencies.ids.nextId());
    const timelineId = resourceIdSchema.parse(dependencies.ids.nextId());
    const createdAt = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
    const campaign = campaignSchema.parse({
      id: campaignId,
      name: normalized.name,
      activeTimelineId: timelineId,
      ownerPrincipalId: parsedOwnerId.data,
      createdAt,
      updatedAt: createdAt,
    });
    // Check only the two generated IDs in their own namespaces. Other SQL,
    // dependency, and projection failures must retain their original type.
    const campaignIdExists = db.prepare("SELECT 1 FROM campaigns WHERE id = ?").get(campaign.id);
    const timelineIdExists = db.prepare("SELECT 1 FROM campaign_timelines WHERE id = ?").get(campaign.activeTimelineId);
    if (campaignIdExists || timelineIdExists) throw new CampaignCreationIdCollisionError();
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(campaign.id, campaign.name, campaign.activeTimelineId, campaign.ownerPrincipalId, campaign.createdAt, campaign.updatedAt);
    db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES (?, ?, ?)")
      .run(campaign.activeTimelineId, campaign.id, campaign.createdAt);
    db.prepare(`INSERT INTO campaign_timeline_history
      (campaign_id, timeline_id, source_timeline_id, parent_timeline_id, created_by_command_id, forked_from_revision) VALUES (?, ?, NULL, NULL, NULL, NULL)`)
      .run(campaign.id, campaign.activeTimelineId);
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES (?, ?, 'owner', ?)`)
      .run(campaign.id, campaign.ownerPrincipalId, campaign.createdAt);
    return campaign;
  });
  return run.immediate();
}

interface CampaignRow {
  id: string;
  name: string;
  active_timeline_id: string;
  owner_principal_id: string;
  created_at: string;
  updated_at: string;
}

function toCampaign(row: CampaignRow): Campaign {
  return campaignSchema.parse({
    id: row.id,
    name: row.name,
    activeTimelineId: row.active_timeline_id,
    ownerPrincipalId: row.owner_principal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function recordCompatibilityAdministrationAuditInternal(db: DatabaseDriver.Database, campaignId: string,
  actorPrincipalId: string, type: "campaign_renamed" | "membership_added" | "room_attached" | "room_detached",
  payload: object, result: object, occurredAt: string): void {
  const row = db.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(campaignId) as { administration_revision: number };
  const before = revisionSchema.parse(row.administration_revision), after = before + 1;
  const identity = createHash("sha256").update(`${campaignId}:${type}:${before}:${JSON.stringify(payload)}`).digest("hex");
  const commandId = `compat-command-${identity.slice(0, 32)}`, eventId = `compat-event-${identity.slice(32)}`;
  const key = `compat-${identity.slice(0, 40)}`, data = JSON.stringify(payload);
  db.prepare(`INSERT INTO campaign_administration_commands
    (command_id,campaign_id,idempotency_key,actor_principal_id,expected_revision,type,payload,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(commandId, campaignId, key, actorPrincipalId, before, type, data, occurredAt);
  db.prepare("UPDATE campaigns SET administration_revision=? WHERE id=? AND administration_revision=?")
    .run(after, campaignId, before);
  db.prepare(`INSERT INTO campaign_administration_events
    (event_id,campaign_id,command_id,revision_before,revision,type,public_data,private_data,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(eventId, campaignId, commandId, before, after, type, data, data, occurredAt);
  db.prepare(`INSERT INTO campaign_administration_receipts
    (command_id,campaign_id,event_id,type,revision_before,revision_after,result_data) VALUES (?,?,?,?,?,?,?)`)
    .run(commandId, campaignId, eventId, type, before, after, JSON.stringify(result));
}

function renameCampaignSyncInternal(
  db: DatabaseDriver.Database,
  clock: Clock,
  actorPrincipalId: string,
  campaignId: string,
  input: RenameCampaignInput,
): Campaign {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const normalized = renameCampaignInputSchema.parse(input);
  const run = db.transaction(() => {
    const campaign = db.prepare(`SELECT id, name, active_timeline_id, owner_principal_id, created_at, updated_at
      FROM campaigns WHERE id = ?`).get(id) as CampaignRow | undefined;
    if (!campaign) throw new Error("campaign not found");
    if (campaign.owner_principal_id !== actorId) {
      throw new Error("campaign rename requires the campaign owner");
    }

    const updatedAt = utcIsoTimestampSchema.parse(clock.now().toISOString());
    if (updatedAt < campaign.updated_at) {
      throw new Error("campaign rename timestamp cannot precede campaign updated_at");
    }
    const updated = db.prepare(`UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ?
      RETURNING id, name, active_timeline_id, owner_principal_id, created_at, updated_at`)
      .get(normalized.name, updatedAt, id) as CampaignRow;
    return toCampaign(updated);
  });
  return run.immediate();
}

interface CampaignOwnerIntegrityRow {
  campaign_id: unknown;
  principal_id: unknown;
  role: unknown;
  created_at: unknown;
  principal_parent_id: unknown;
}

/**
 * Concurrency-aware rename used by HTTP. This intentionally does not replace
 * renameCampaignSync: the older factory method retains its exact signature and
 * behavior for compatibility.
 */
function renameCampaignIfUnchangedSyncInternal(
  db: DatabaseDriver.Database,
  clock: Clock,
  actorPrincipalId: string,
  campaignId: string,
  input: CampaignRenameRequest,
): Campaign {
  const run = db.transaction(() => {
    // Validation belongs to the same immediate transaction as authorization,
    // precondition evaluation, and the conditional write.
    const actorId = resourceIdSchema.parse(actorPrincipalId);
    const id = resourceIdSchema.parse(campaignId);
    const normalized = campaignRenameRequestSchema.parse(input);

    const row = db.prepare(`SELECT id, name, active_timeline_id, owner_principal_id, created_at, updated_at
      FROM campaigns WHERE id = ?`).get(id) as CampaignRow | undefined;
    if (!row) throw new CampaignRenameUnavailableError();

    // Apply non-disclosing denial from the raw owner pointer before parsing any
    // attributable campaign/owner state. A caller who is not the purported
    // owner must not be able to distinguish intact from corrupt denied rows.
    if (row.owner_principal_id !== actorId) throw new CampaignRenameUnavailableError();

    let campaign: Campaign;
    try {
      campaign = toCampaign(row);
      if (campaign.updatedAt < campaign.createdAt) throw new Error("campaign timestamp order is malformed");
    } catch {
      throw new Error("campaign rename campaign invariant is malformed");
    }

    const ownerRows = db.prepare(`SELECT membership.campaign_id, membership.principal_id,
        membership.role, membership.created_at, principal.id AS principal_parent_id
      FROM campaign_memberships membership
      LEFT JOIN principals principal ON principal.id = membership.principal_id
      WHERE membership.campaign_id = ? AND membership.role = 'owner'
      ORDER BY membership.principal_id COLLATE BINARY`).all(id) as CampaignOwnerIntegrityRow[];
    try {
      if (ownerRows.length !== 1) throw new Error("campaign must have one owner membership");
      const ownerRow = ownerRows[0]!;
      const owner = campaignMembershipReadSchema.parse({
        campaignId: ownerRow.campaign_id,
        principalId: ownerRow.principal_id,
        role: ownerRow.role,
        createdAt: ownerRow.created_at,
      });
      if (owner.role !== "owner"
        || owner.campaignId !== campaign.id
        || owner.principalId !== campaign.ownerPrincipalId
        || ownerRow.principal_parent_id !== owner.principalId) {
        throw new Error("campaign owner identities disagree");
      }
    } catch {
      // Owner corruption is an attributable internal invariant failure, never
      // the typed non-disclosing denial used for an intact campaign.
      throw new Error("campaign rename owner invariant is malformed");
    }

    if (campaign.updatedAt !== normalized.expectedUpdatedAt) throw new CampaignRenameStaleError();

    const clockAt = utcIsoTimestampSchema.parse(clock.now().toISOString());
    const previousMillis = Date.parse(campaign.updatedAt);
    const nextMillis = previousMillis + 1;
    if (!Number.isSafeInteger(nextMillis)) throw new Error("campaign rename timestamp cannot advance");
    // A successful write always invalidates the observed token, even for a
    // same-name write and even when the injected clock is equal or backward.
    const updatedAt = utcIsoTimestampSchema.parse(new Date(Math.max(Date.parse(clockAt), nextMillis)).toISOString());
    const result = db.prepare(`UPDATE campaigns SET name = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?`).run(normalized.name, updatedAt, id, campaign.updatedAt);
    if (result.changes !== 1) throw new CampaignRenameStaleError();

    const updated = db.prepare(`SELECT id, name, active_timeline_id, owner_principal_id, created_at, updated_at
      FROM campaigns WHERE id = ?`).get(id) as CampaignRow | undefined;
    if (!updated) throw new Error("campaign rename output is missing");
    const output = toCampaign(updated);
    if (output.id !== campaign.id
      || output.name !== normalized.name
      || output.activeTimelineId !== campaign.activeTimelineId
      || output.ownerPrincipalId !== campaign.ownerPrincipalId
      || output.createdAt !== campaign.createdAt
      || output.updatedAt !== updatedAt) {
      throw new Error("campaign rename output is malformed");
    }
    return output;
  });
  return run.immediate();
}

interface CampaignMembershipRow {
  campaign_id: string;
  principal_id: string;
  role: string;
  created_at: string;
}

function toCampaignMembership(row: CampaignMembershipRow): CampaignMembership {
  return campaignMembershipSchema.parse({
    campaignId: row.campaign_id,
    principalId: row.principal_id,
    role: row.role,
    createdAt: row.created_at,
  });
}

function addCampaignMembershipSyncInternal(
  db: DatabaseDriver.Database,
  clock: Clock,
  actorPrincipalId: string,
  campaignId: string,
  input: AddCampaignMembershipInput,
): CampaignMembership {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const normalized = addCampaignMembershipInputSchema.parse(input);
  const run = db.transaction(() => {
    const campaign = db.prepare("SELECT owner_principal_id, updated_at FROM campaigns WHERE id = ?").get(id) as
      | { owner_principal_id: string; updated_at: string }
      | undefined;
    if (!campaign) throw new Error("campaign not found");
    if (campaign.owner_principal_id !== actorId) {
      throw new Error("campaign membership addition requires the campaign owner");
    }

    const target = db.prepare("SELECT 1 FROM principals WHERE id = ?").get(normalized.principalId);
    if (!target) throw new Error("target principal not found");

    const existing = db.prepare(`SELECT campaign_id, principal_id, role, created_at
      FROM campaign_memberships WHERE campaign_id = ? AND principal_id = ?`)
      .get(id, normalized.principalId) as CampaignMembershipRow | undefined;
    if (existing) {
      if (existing.role === normalized.role) return toCampaignMembership(existing);
      if (existing.role === "owner") throw new Error("campaign owner cannot receive a member role");
      throw new Error("campaign principal already has a different membership role");
    }
    if (normalized.principalId === campaign.owner_principal_id) {
      throw new Error("campaign owner cannot receive a member role");
    }

    const createdAt = utcIsoTimestampSchema.parse(clock.now().toISOString());
    if (createdAt < campaign.updated_at) {
      throw new Error("campaign membership timestamp cannot precede campaign updated_at");
    }
    const membership = campaignMembershipSchema.parse({
      campaignId: id,
      principalId: normalized.principalId,
      role: normalized.role,
      createdAt,
    });
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES (?, ?, ?, ?)`).run(id, membership.principalId, membership.role, membership.createdAt);
    db.prepare("UPDATE campaigns SET updated_at = ? WHERE id = ?").run(membership.createdAt, id);
    return membership;
  });
  return run.immediate();
}

interface CampaignSessionAttachmentRow {
  campaign_id: string;
  session_id: string;
  attached_at: string;
}

interface CampaignRoomSessionIntegrityRow {
  session_id: string;
  character_id: string;
  primary_character_presence: string | null;
  title: string;
  state: string;
  created_at: string;
  stopped_at: string | null;
  stop_reason_kind: unknown;
  participant_names: string;
  participant_count: unknown;
  joined_character_count: unknown;
  primary_participant_count: unknown;
  distinct_character_count: unknown;
  distinct_position_count: unknown;
  malformed_position_count: unknown;
  minimum_position: unknown;
  maximum_position: unknown;
}

const RUNNING_CAMPAIGN_ROOM_STATES = ["setup", "active", "paused", "cooldown"] as const;

/**
 * Validate the legacy session fields that make a room safe to summarize and
 * eligible to link. This deliberately projects display values even though the
 * write does not return them, so attach cannot accept a graph that GET rejects.
 */
function validateCampaignRoomSessionIntegrityInternal(row: CampaignRoomSessionIntegrityRow): "running" | "stopped" {
  if (row.primary_character_presence !== row.character_id
    || !Number.isInteger(row.participant_count) || (row.participant_count as number) < 1
    || (row.participant_count as number) > 12
    || row.joined_character_count !== row.participant_count
    || row.primary_participant_count !== 1
    || row.distinct_character_count !== row.participant_count
    || row.distinct_position_count !== row.participant_count
    || row.malformed_position_count !== 0
    || row.minimum_position !== 0
    || row.maximum_position !== (row.participant_count as number) - 1) {
    throw new Error("campaign room session graph is malformed");
  }
  let names: unknown;
  try {
    names = JSON.parse(row.participant_names);
  } catch {
    throw new Error("campaign room session graph is malformed");
  }
  if (!Array.isArray(names) || names.length !== row.participant_count) {
    throw new Error("campaign room session graph is malformed");
  }
  try {
    projectLegacyRoomText(row.title, true);
    for (const name of names) projectLegacyRoomText(name, false);
    const createdAt = utcIsoTimestampSchema.parse(row.created_at);
    const running = (RUNNING_CAMPAIGN_ROOM_STATES as readonly string[]).includes(row.state)
      && row.stopped_at === null && row.stop_reason_kind === 0;
    if (running) return "running";
    if (row.state === "closed" && row.stopped_at !== null && row.stop_reason_kind === 1) {
      const stoppedAt = utcIsoTimestampSchema.parse(row.stopped_at);
      if (stoppedAt < createdAt) throw new Error("invalid stopped provenance");
      return "stopped";
    }
  } catch {
    throw new Error("campaign room session graph is malformed");
  }
  throw new Error("campaign room session graph is malformed");
}

function getCampaignRoomSessionIntegrityRowInternal(
  db: DatabaseDriver.Database,
  sessionId: string,
): CampaignRoomSessionIntegrityRow | undefined {
  return db.prepare(`SELECT target_session.id AS session_id, target_session.character_id,
      primary_character.id AS primary_character_presence, target_session.title,
      target_session.state, target_session.created_at, target_session.stopped_at,
      CASE WHEN target_session.stop_reason IS NULL THEN 0
        WHEN typeof(target_session.stop_reason) = 'text'
          AND length(trim(target_session.stop_reason)) > 0 THEN 1 ELSE 2 END AS stop_reason_kind,
      COALESCE((SELECT json_group_array(participant_name) FROM (
        SELECT character.name AS participant_name
        FROM session_characters participant
        JOIN characters character ON character.id = participant.character_id
        WHERE participant.session_id = target_session.id
        ORDER BY participant.position ASC
        LIMIT 13
      )), '[]') AS participant_names,
      (SELECT COUNT(*) FROM session_characters participant
        WHERE participant.session_id = target_session.id) AS participant_count,
      (SELECT COUNT(*) FROM session_characters participant
        JOIN characters character ON character.id = participant.character_id
        WHERE participant.session_id = target_session.id) AS joined_character_count,
      (SELECT COUNT(*) FROM session_characters participant
        WHERE participant.session_id = target_session.id
          AND participant.character_id = target_session.character_id) AS primary_participant_count,
      (SELECT COUNT(DISTINCT participant.character_id) FROM session_characters participant
        WHERE participant.session_id = target_session.id) AS distinct_character_count,
      (SELECT COUNT(DISTINCT participant.position) FROM session_characters participant
        WHERE participant.session_id = target_session.id) AS distinct_position_count,
      (SELECT COUNT(*) FROM session_characters participant
        WHERE participant.session_id = target_session.id
          AND typeof(participant.position) <> 'integer') AS malformed_position_count,
      (SELECT MIN(participant.position) FROM session_characters participant
        WHERE participant.session_id = target_session.id) AS minimum_position,
      (SELECT MAX(participant.position) FROM session_characters participant
        WHERE participant.session_id = target_session.id) AS maximum_position
    FROM sessions target_session
    LEFT JOIN characters primary_character ON primary_character.id = target_session.character_id
    WHERE target_session.id = ?`).get(sessionId) as CampaignRoomSessionIntegrityRow | undefined;
}

function toCampaignSessionAttachment(row: CampaignSessionAttachmentRow): CampaignSessionAttachment {
  return campaignSessionAttachmentSchema.parse({
    campaignId: row.campaign_id,
    sessionId: row.session_id,
    attachedAt: row.attached_at,
  });
}

function attachCampaignSessionSyncInternal(
  db: DatabaseDriver.Database,
  clock: Clock,
  actorPrincipalId: string,
  input: AttachCampaignSessionInput,
): CampaignSessionAttachment {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = attachCampaignSessionInputSchema.parse(input);
  const run = db.transaction(() => {
    const campaign = db.prepare(`SELECT campaign.owner_principal_id, campaign.owner_role,
        actor_membership.campaign_id AS actor_campaign_id,
        actor_membership.principal_id AS actor_principal_id,
        actor_membership.role AS actor_role,
        actor_membership.created_at AS actor_created_at,
        actor_principal.id AS actor_parent_id,
        owner_membership.campaign_id AS owner_campaign_id,
        owner_membership.principal_id AS owner_principal_parent_id,
        owner_membership.role AS owner_membership_role,
        owner_membership.created_at AS owner_created_at,
        owner_principal.id AS owner_parent_id,
        (SELECT COUNT(*) FROM campaign_memberships sole_owner
          WHERE sole_owner.campaign_id = campaign.id AND sole_owner.role = 'owner') AS owner_count
      FROM campaigns campaign
      LEFT JOIN campaign_memberships actor_membership
        ON actor_membership.campaign_id = campaign.id AND actor_membership.principal_id = ?
      LEFT JOIN principals actor_principal ON actor_principal.id = actor_membership.principal_id
      LEFT JOIN campaign_memberships owner_membership
        ON owner_membership.campaign_id = campaign.id
        AND owner_membership.principal_id = campaign.owner_principal_id
        AND owner_membership.role = 'owner'
      LEFT JOIN principals owner_principal ON owner_principal.id = owner_membership.principal_id
      WHERE campaign.id = ?`).get(actorId, normalized.campaignId) as
      | {
        owner_principal_id: string; owner_role: string; actor_campaign_id: string | null;
        actor_principal_id: string | null; actor_role: string | null; actor_created_at: string | null;
        actor_parent_id: string | null;
        owner_campaign_id: string | null; owner_principal_parent_id: string | null;
        owner_membership_role: string | null; owner_created_at: string | null;
        owner_parent_id: string | null; owner_count: unknown;
      }
      | undefined;
    if (!campaign) throw new CampaignSessionAttachmentUnavailableError("campaign not found");
    if (campaign.owner_principal_id !== actorId
      || campaign.actor_campaign_id !== normalized.campaignId
      || campaign.actor_principal_id !== actorId
      || campaign.actor_role !== "owner"
      || campaign.actor_parent_id !== actorId) {
      throw new CampaignSessionAttachmentUnavailableError();
    }
    try {
      campaignMembershipReadSchema.parse({
        campaignId: normalized.campaignId, principalId: actorId,
        role: campaign.actor_role, createdAt: campaign.actor_created_at,
      });
    } catch {
      throw new Error("campaign owner authority is malformed");
    }
    if (campaign.owner_role !== "owner" || campaign.owner_count !== 1
      || campaign.owner_campaign_id !== normalized.campaignId
      || campaign.owner_principal_parent_id !== campaign.owner_principal_id
      || campaign.owner_membership_role !== "owner"
      || campaign.owner_parent_id !== campaign.owner_principal_id) {
      throw new Error("campaign owner authority is malformed");
    }
    try {
      campaignMembershipReadSchema.parse({
        campaignId: normalized.campaignId, principalId: campaign.owner_principal_id,
        role: campaign.owner_membership_role, createdAt: campaign.owner_created_at,
      });
    } catch {
      throw new Error("campaign owner authority is malformed");
    }

    // Classify the attachment relation immediately after requested-campaign
    // authority. Foreign graph details are outside this authority domain and
    // therefore cannot influence or refine the generic typed conflict.
    const existing = db.prepare(`SELECT attachment.campaign_id, attachment.session_id,
        attachment.attached_at
      FROM campaign_sessions attachment
      WHERE attachment.session_id = ?`).get(normalized.sessionId) as
      | CampaignSessionAttachmentRow
      | undefined;
    if (existing && existing.campaign_id !== normalized.campaignId) {
      throw new CampaignSessionAttachmentConflictError("session is already attached to a different campaign");
    }
    let existingAttachment: CampaignSessionAttachment | null = null;
    if (existing) {
      try {
        existingAttachment = toCampaignSessionAttachment(existing);
      } catch {
        throw new Error("campaign session attachment is malformed");
      }
    }

    const session = getCampaignRoomSessionIntegrityRow(db, normalized.sessionId);
    if (!session) {
      if (existing) throw new Error("campaign session attachment has no session parent");
      throw new CampaignSessionAttachmentSessionMissingError();
    }
    const lifecycle = validateCampaignRoomSessionIntegrityInternal(session);

    if (existingAttachment) return existingAttachment;
    if (lifecycle === "stopped") {
      throw new CampaignSessionAttachmentConflictError("stopped sessions cannot be attached to campaigns");
    }

    const attachedAt = utcIsoTimestampSchema.parse(clock.now().toISOString());
    db.prepare("INSERT INTO campaign_sessions (campaign_id, session_id, attached_at) VALUES (?, ?, ?)")
      .run(normalized.campaignId, normalized.sessionId, attachedAt);
    return campaignSessionAttachmentSchema.parse({
      campaignId: normalized.campaignId,
      sessionId: normalized.sessionId,
      attachedAt,
    });
  });
  return run.immediate();
}

function detachCampaignSessionSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  input: DetachCampaignSessionInput,
): CampaignSessionAttachment | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = detachCampaignSessionInputSchema.parse(input);
  const run = db.transaction(() => {
    const campaign = db.prepare("SELECT owner_principal_id FROM campaigns WHERE id = ?").get(normalized.campaignId) as
      | { owner_principal_id: string }
      | undefined;
    if (!campaign) throw new Error("campaign not found");
    if (campaign.owner_principal_id !== actorId) {
      throw new Error("campaign session detachment requires the campaign owner");
    }

    const detached = db.prepare(`DELETE FROM campaign_sessions
      WHERE campaign_id = ? AND session_id = ?
      RETURNING campaign_id, session_id, attached_at`)
      .get(normalized.campaignId, normalized.sessionId) as CampaignSessionAttachmentRow | undefined;
    return detached ? toCampaignSessionAttachment(detached) : null;
  });
  return run.immediate();
}

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

function listCampaignsSyncInternal(db: DatabaseDriver.Database, actorPrincipalId: string): CampaignAccess[] {
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
}

function getCampaignSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignAccess | null {
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
}

interface CampaignTimelineReadRow {
  actor_campaign_id: string;
  actor_principal_id: string;
  actor_role: string;
  actor_created_at: string;
  campaign_id: string;
  active_timeline_id: string;
  active_timeline_presence: string | null;
  active_timeline_campaign_id: string | null;
  timeline_id: string | null;
  timeline_campaign_id: string | null;
  timeline_revision: unknown;
  timeline_created_at: string | null;
  event_count: unknown;
  command_count: unknown;
  receipt_count: unknown;
  minimum_revision: unknown;
  maximum_revision: unknown;
  distinct_revision_count: unknown;
  invalid_audit_count: unknown;
}

const SQL_VALID_RESOURCE_ID = (column: string): string =>
  `length(${column}) BETWEEN 1 AND 128 AND ${column} NOT GLOB '*[^A-Za-z0-9._:-]*'`;
const SQL_VALID_TIMESTAMP = (column: string): string =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL
    AND ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
    AND substr(${column}, 12, 2) BETWEEN '00' AND '23'`;

/*
 * This predicate deliberately repeats the persisted audit contract in SQL. The
 * timeline list cannot reconstruct history with follow-up queries: each row
 * carries a bounded aggregate proving that every attributable audit root is a
 * complete, exact command/event/receipt variant (and, for dice, roll/terms).
 */
const VALID_AUDIT_COMMAND = `
  ${SQL_VALID_RESOURCE_ID("command.command_id")}
  AND ${SQL_VALID_RESOURCE_ID("command.timeline_id")}
  AND ${SQL_VALID_RESOURCE_ID("command.actor_id")}
  AND (command.source_turn_id IS NULL OR (${SQL_VALID_RESOURCE_ID("command.source_turn_id")}))
  AND typeof(command.expected_revision) = 'integer'
  AND command.expected_revision BETWEEN 0 AND 9007199254740990
  AND EXISTS (SELECT 1 FROM campaign_timelines command_timeline
    WHERE command_timeline.campaign_id = command.campaign_id AND command_timeline.id = command.timeline_id)
  AND EXISTS (SELECT 1 FROM campaign_actors command_actor
    WHERE command_actor.campaign_id = command.campaign_id AND command_actor.id = command.actor_id)
  AND (SELECT COUNT(*) FROM campaign_events event
    WHERE event.campaign_id = command.campaign_id AND event.command_id = command.command_id) = 1
  AND (SELECT COUNT(*) FROM command_receipts receipt
    WHERE receipt.campaign_id = command.campaign_id AND receipt.command_id = command.command_id) = 1
  AND EXISTS (SELECT 1
    FROM campaign_events event
    JOIN command_receipts receipt ON receipt.campaign_id = event.campaign_id
      AND receipt.command_id = event.command_id AND receipt.event_id = event.event_id
    WHERE event.campaign_id = command.campaign_id AND event.command_id = command.command_id
      AND event.timeline_id = command.timeline_id AND event.actor_id = command.actor_id
      AND event.source_turn_id IS command.source_turn_id
      AND event.revision = command.expected_revision + 1
      AND receipt.revision_before = command.expected_revision
      AND receipt.revision_after = event.revision
      AND typeof(receipt.revision_before) = 'integer' AND typeof(receipt.revision_after) = 'integer'
      AND ((command.type = 'set_actor_attribute' AND event.type = 'actor_attribute_set'
          AND ${SQL_VALID_RESOURCE_ID("command.attribute_id")}
          AND typeof(command.value) = 'integer' AND command.value BETWEEN -1000 AND 1000
          AND event.attribute_id = command.attribute_id AND event.value_after = command.value
          AND command.resource_name IS NULL AND command.resource_current IS NULL
          AND command.resource_max IS NULL AND command.dice_expression IS NULL
          AND command.dice_count IS NULL AND command.dice_sides IS NULL
          AND command.dice_selection_type IS NULL AND command.dice_selection_count IS NULL
          AND command.dice_modifier IS NULL)
        OR (command.type = 'initialize_actor_resource' AND event.type = 'actor_resource_initialized'
          AND command.attribute_id IS NULL AND command.value IS NULL
          AND ${SQL_VALID_RESOURCE_ID("command.resource_name")}
          AND typeof(command.resource_current) = 'integer' AND command.resource_current BETWEEN 0 AND 1000000
          AND typeof(command.resource_max) = 'integer' AND command.resource_max BETWEEN 0 AND 1000000
          AND command.resource_current <= command.resource_max
          AND event.resource_name = command.resource_name
          AND event.resource_current = command.resource_current AND event.resource_max = command.resource_max
          AND command.dice_expression IS NULL AND command.dice_count IS NULL
          AND command.dice_sides IS NULL AND command.dice_selection_type IS NULL
          AND command.dice_selection_count IS NULL AND command.dice_modifier IS NULL)
        OR (command.type = 'roll_actor_dice' AND event.type = 'actor_dice_rolled'
          AND command.attribute_id IS NULL AND command.value IS NULL AND command.resource_name IS NULL
          AND command.resource_current IS NULL AND command.resource_max IS NULL
          AND EXISTS (SELECT 1 FROM rpg_dice_rolls roll
            WHERE roll.campaign_id = command.campaign_id AND roll.command_id = command.command_id
              AND roll.event_id = event.event_id AND roll.expression = command.dice_expression
              AND roll.dice_count = command.dice_count AND roll.dice_sides = command.dice_sides
              AND roll.selection_type = command.dice_selection_type
              AND roll.selection_count IS command.dice_selection_count
              AND roll.modifier = command.dice_modifier))))`;

const VALID_AUDIT_EVENT = `
  ${SQL_VALID_RESOURCE_ID("event.event_id")} AND ${SQL_VALID_RESOURCE_ID("event.command_id")}
  AND ${SQL_VALID_RESOURCE_ID("event.timeline_id")} AND ${SQL_VALID_RESOURCE_ID("event.actor_id")}
  AND (event.source_turn_id IS NULL OR (${SQL_VALID_RESOURCE_ID("event.source_turn_id")}))
  AND typeof(event.revision) = 'integer' AND event.revision BETWEEN 1 AND 9007199254740991
  AND ${SQL_VALID_TIMESTAMP("event.occurred_at")}
  AND EXISTS (SELECT 1 FROM campaign_timelines event_timeline
    WHERE event_timeline.campaign_id = event.campaign_id AND event_timeline.id = event.timeline_id)
  AND EXISTS (SELECT 1 FROM campaign_actors event_actor
    WHERE event_actor.campaign_id = event.campaign_id AND event_actor.id = event.actor_id)
  AND EXISTS (SELECT 1 FROM campaign_commands command
    WHERE command.campaign_id = event.campaign_id AND command.command_id = event.command_id
      AND command.timeline_id = event.timeline_id AND command.actor_id = event.actor_id
      AND command.source_turn_id IS event.source_turn_id AND command.expected_revision + 1 = event.revision)
  AND EXISTS (SELECT 1 FROM command_receipts receipt
    WHERE receipt.campaign_id = event.campaign_id AND receipt.command_id = event.command_id
      AND receipt.event_id = event.event_id AND receipt.revision_after = event.revision)
  AND ((event.type = 'actor_attribute_set' AND ${SQL_VALID_RESOURCE_ID("event.attribute_id")}
      AND typeof(event.value_before) = 'integer' AND event.value_before BETWEEN -1000 AND 1000
      AND typeof(event.value_after) = 'integer' AND event.value_after BETWEEN -1000 AND 1000
      AND event.value_before <> event.value_after AND event.resource_name IS NULL
      AND event.resource_current IS NULL AND event.resource_max IS NULL
      AND NOT EXISTS (SELECT 1 FROM rpg_dice_rolls roll
        WHERE roll.campaign_id = event.campaign_id AND roll.event_id = event.event_id))
    OR (event.type = 'actor_resource_initialized' AND event.attribute_id IS NULL
      AND event.value_before IS NULL AND event.value_after IS NULL
      AND ${SQL_VALID_RESOURCE_ID("event.resource_name")}
      AND typeof(event.resource_current) = 'integer' AND event.resource_current BETWEEN 0 AND 1000000
      AND typeof(event.resource_max) = 'integer' AND event.resource_max BETWEEN 0 AND 1000000
      AND event.resource_current <= event.resource_max
      AND NOT EXISTS (SELECT 1 FROM rpg_dice_rolls roll
        WHERE roll.campaign_id = event.campaign_id AND roll.event_id = event.event_id))
    OR (event.type = 'actor_dice_rolled' AND event.attribute_id IS NULL
      AND event.value_before IS NULL AND event.value_after IS NULL AND event.resource_name IS NULL
      AND event.resource_current IS NULL AND event.resource_max IS NULL
      AND (SELECT COUNT(*) FROM rpg_dice_rolls roll
        WHERE roll.campaign_id = event.campaign_id AND roll.event_id = event.event_id) = 1))`;

const VALID_DICE_ROLL = `
  ${SQL_VALID_RESOURCE_ID("roll.event_id")} AND ${SQL_VALID_RESOURCE_ID("roll.command_id")}
  AND typeof(roll.dice_count) = 'integer' AND roll.dice_count BETWEEN 1 AND 100
  AND typeof(roll.dice_sides) = 'integer' AND roll.dice_sides BETWEEN 2 AND 1000
  AND typeof(roll.modifier) = 'integer' AND roll.modifier BETWEEN -1000 AND 1000
  AND typeof(roll.total) = 'integer' AND roll.total BETWEEN -1000 AND 101000
  AND ((roll.selection_type = 'all' AND roll.selection_count IS NULL)
    OR (roll.selection_type IN ('keep_highest', 'keep_lowest')
      AND typeof(roll.selection_count) = 'integer'
      AND roll.selection_count BETWEEN 1 AND roll.dice_count)
    OR (roll.selection_type IN ('advantage', 'disadvantage')
      AND roll.selection_count IS NULL AND roll.dice_count = 1))
  AND roll.expression = CAST(roll.dice_count AS TEXT) || 'd' || CAST(roll.dice_sides AS TEXT)
    || CASE roll.selection_type WHEN 'all' THEN '' WHEN 'keep_highest' THEN 'kh' || CAST(roll.selection_count AS TEXT)
      WHEN 'keep_lowest' THEN 'kl' || CAST(roll.selection_count AS TEXT)
      WHEN 'advantage' THEN 'adv' ELSE 'dis' END
    || CASE WHEN roll.modifier = 0 THEN '' WHEN roll.modifier > 0
      THEN '+' || CAST(roll.modifier AS TEXT) ELSE CAST(roll.modifier AS TEXT) END
  AND EXISTS (SELECT 1 FROM campaign_commands command
    WHERE command.campaign_id = roll.campaign_id AND command.command_id = roll.command_id
      AND command.type = 'roll_actor_dice' AND command.dice_expression = roll.expression
      AND command.dice_count = roll.dice_count AND command.dice_sides = roll.dice_sides
      AND command.dice_selection_type = roll.selection_type
      AND command.dice_selection_count IS roll.selection_count AND command.dice_modifier = roll.modifier)
  AND EXISTS (SELECT 1 FROM campaign_events event
    WHERE event.campaign_id = roll.campaign_id AND event.command_id = roll.command_id
      AND event.event_id = roll.event_id AND event.type = 'actor_dice_rolled')
  AND EXISTS (SELECT 1 FROM command_receipts receipt
    WHERE receipt.campaign_id = roll.campaign_id AND receipt.command_id = roll.command_id
      AND receipt.event_id = roll.event_id)
  AND (SELECT COUNT(*) FROM rpg_dice_terms term WHERE term.event_id = roll.event_id)
    = CASE WHEN roll.selection_type IN ('advantage', 'disadvantage') THEN 2 ELSE roll.dice_count END
  AND (SELECT COUNT(DISTINCT term.position) FROM rpg_dice_terms term WHERE term.event_id = roll.event_id)
    = CASE WHEN roll.selection_type IN ('advantage', 'disadvantage') THEN 2 ELSE roll.dice_count END
  AND (SELECT COALESCE(MIN(term.position), -1) FROM rpg_dice_terms term WHERE term.event_id = roll.event_id) = 0
  AND (SELECT COALESCE(MAX(term.position), -1) FROM rpg_dice_terms term WHERE term.event_id = roll.event_id)
    = CASE WHEN roll.selection_type IN ('advantage', 'disadvantage') THEN 1 ELSE roll.dice_count - 1 END
  AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms term
    WHERE term.event_id = roll.event_id AND (
      typeof(term.position) <> 'integer' OR typeof(term.value) <> 'integer'
      OR term.value < 1 OR term.value > roll.dice_sides
      OR typeof(term.kept) <> 'integer' OR term.kept NOT IN (0, 1)
      OR term.kept <> CASE
        WHEN roll.selection_type = 'all' THEN 1
        WHEN roll.selection_type IN ('keep_highest', 'advantage') THEN
          CASE WHEN (SELECT COUNT(*) FROM rpg_dice_terms better
            WHERE better.event_id = roll.event_id AND (better.value > term.value
              OR (better.value = term.value AND better.position < term.position)))
            < COALESCE(roll.selection_count, 1) THEN 1 ELSE 0 END
        ELSE CASE WHEN (SELECT COUNT(*) FROM rpg_dice_terms better
            WHERE better.event_id = roll.event_id AND (better.value < term.value
              OR (better.value = term.value AND better.position < term.position)))
            < COALESCE(roll.selection_count, 1) THEN 1 ELSE 0 END END))
  AND roll.total = roll.modifier + (SELECT COALESCE(SUM(term.value), 0)
    FROM rpg_dice_terms term WHERE term.event_id = roll.event_id AND term.kept = 1)`;

const CAMPAIGN_TIMELINE_READ_SELECT = `SELECT
  membership.campaign_id AS actor_campaign_id, membership.principal_id AS actor_principal_id,
  membership.role AS actor_role, membership.created_at AS actor_created_at,
  campaign.id AS campaign_id, campaign.active_timeline_id,
  active_timeline.id AS active_timeline_presence,
  active_timeline.campaign_id AS active_timeline_campaign_id,
  timeline.id AS timeline_id, timeline.campaign_id AS timeline_campaign_id,
  timeline.revision AS timeline_revision, timeline.created_at AS timeline_created_at,
  ((SELECT COUNT(*) FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)
    + (SELECT COUNT(*) FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS event_count,
  ((SELECT COUNT(*) FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)
    + (SELECT COUNT(*) FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS command_count,
  ((SELECT COUNT(*) FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)
    + (SELECT COUNT(*) FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS receipt_count,
  (SELECT MIN(revision) FROM (SELECT revision FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id UNION ALL
      SELECT revision FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS minimum_revision,
  (SELECT MAX(revision) FROM (SELECT revision FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id UNION ALL
      SELECT revision FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS maximum_revision,
  (SELECT COUNT(DISTINCT revision) FROM (SELECT revision FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id UNION ALL
      SELECT revision FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS distinct_revision_count,
  ((SELECT COUNT(*) FROM campaign_commands command WHERE command.campaign_id = campaign.id
      AND COALESCE((${VALID_AUDIT_COMMAND}), 0) <> 1)
    + (SELECT COUNT(*) FROM campaign_events event WHERE event.campaign_id = campaign.id
      AND COALESCE((${VALID_AUDIT_EVENT}), 0) <> 1)
    + (SELECT COUNT(*) FROM command_receipts receipt WHERE receipt.campaign_id = campaign.id AND COALESCE((
      typeof(receipt.revision_before) = 'integer' AND receipt.revision_before BETWEEN 0 AND 9007199254740990
      AND typeof(receipt.revision_after) = 'integer' AND receipt.revision_after = receipt.revision_before + 1
      AND EXISTS (SELECT 1 FROM campaign_commands command WHERE command.campaign_id = receipt.campaign_id
        AND command.command_id = receipt.command_id AND command.expected_revision = receipt.revision_before)
      AND EXISTS (SELECT 1 FROM campaign_events event WHERE event.campaign_id = receipt.campaign_id
        AND event.command_id = receipt.command_id AND event.event_id = receipt.event_id
        AND event.revision = receipt.revision_after)), 0) <> 1)
    + (SELECT COUNT(*) FROM rpg_dice_rolls roll WHERE roll.campaign_id = campaign.id
      AND COALESCE((${VALID_DICE_ROLL}), 0) <> 1)
    + (SELECT COUNT(*) FROM rpg_dice_terms term
      WHERE NOT EXISTS (SELECT 1 FROM rpg_dice_rolls owning_roll
          WHERE owning_roll.event_id = term.event_id)
        AND (EXISTS (SELECT 1 FROM campaign_events event
          WHERE event.campaign_id = campaign.id AND event.event_id = term.event_id)
        OR EXISTS (SELECT 1 FROM command_receipts receipt
          WHERE receipt.campaign_id = campaign.id AND receipt.event_id = term.event_id)))) AS invalid_audit_count
FROM campaign_memberships membership
JOIN principals principal ON principal.id = membership.principal_id
JOIN campaigns campaign ON campaign.id = membership.campaign_id
LEFT JOIN campaign_timelines active_timeline
  ON active_timeline.campaign_id = campaign.id AND active_timeline.id = campaign.active_timeline_id
LEFT JOIN campaign_timelines timeline ON timeline.campaign_id = campaign.id
WHERE membership.principal_id = ? AND membership.campaign_id = ?
  AND (membership.role IN ('gm', 'player', 'observer') OR (
    membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id))
ORDER BY timeline.created_at ASC, timeline.id COLLATE BINARY ASC`;

// Keep get authorization and every audit aggregate byte-for-byte shared with
// the list boundary; only constrain the left-joined projection to its target.
const CAMPAIGN_TIMELINE_GET_SELECT = CAMPAIGN_TIMELINE_READ_SELECT
  .replace(
    "LEFT JOIN campaign_timelines timeline ON timeline.campaign_id = campaign.id",
    "LEFT JOIN campaign_timelines timeline ON timeline.campaign_id = campaign.id AND timeline.id = ?",
  )
  .replace("\nORDER BY timeline.created_at ASC, timeline.id COLLATE BINARY ASC", "");

function toCampaignTimelineRead(row: CampaignTimelineReadRow): CampaignTimeline {
  try {
    campaignMembershipReadSchema.parse({
      campaignId: row.actor_campaign_id,
      principalId: row.actor_principal_id,
      role: row.actor_role,
      createdAt: row.actor_created_at,
    });
    if (row.active_timeline_presence === null
        || row.active_timeline_presence !== row.active_timeline_id
        || row.active_timeline_campaign_id !== row.campaign_id
        || row.timeline_id === null || row.timeline_campaign_id !== row.campaign_id
        || row.timeline_created_at === null) {
      throw new Error();
    }
    const timeline = campaignTimelineSchema.parse({
      id: row.timeline_id,
      campaignId: row.timeline_campaign_id,
      revision: row.timeline_revision,
      createdAt: row.timeline_created_at,
    });
    const revision = timeline.revision;
    const eventCount = revisionSchema.parse(row.event_count);
    const commandCount = revisionSchema.parse(row.command_count);
    const receiptCount = revisionSchema.parse(row.receipt_count);
    const distinctCount = revisionSchema.parse(row.distinct_revision_count);
    const invalidCount = revisionSchema.parse(row.invalid_audit_count);
    if (eventCount !== revision || commandCount !== revision || receiptCount !== revision
        || distinctCount !== revision || invalidCount !== 0
        || (revision === 0
          ? row.minimum_revision !== null || row.maximum_revision !== null
          : row.minimum_revision !== 1 || row.maximum_revision !== revision)) {
      throw new Error();
    }
    return timeline;
  } catch {
    throw new Error("campaign timeline aggregate is malformed");
  }
}

function listCampaignTimelinesSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignTimeline[] {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const normalizedCampaignId = resourceIdSchema.parse(campaignId);
  const rows = db.prepare(CAMPAIGN_TIMELINE_READ_SELECT)
    .all(principalId, normalizedCampaignId) as CampaignTimelineReadRow[];
  return rows.map(toCampaignTimelineRead);
}

function getCampaignTimelineSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  timelineId: string,
): CampaignTimeline | null {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const normalizedCampaignId = resourceIdSchema.parse(campaignId);
  const normalizedTimelineId = resourceIdSchema.parse(timelineId);
  const row = db.prepare(CAMPAIGN_TIMELINE_GET_SELECT)
    .get(normalizedTimelineId, principalId, normalizedCampaignId) as CampaignTimelineReadRow | undefined;
  if (!row) return null;
  if (row.timeline_id !== null) return toCampaignTimelineRead(row);

  // A left-joined miss must still validate attributable campaign integrity for
  // an authorized member; only the genuine absent/cross-campaign target is null.
  try {
    campaignMembershipReadSchema.parse({
      campaignId: row.actor_campaign_id,
      principalId: row.actor_principal_id,
      role: row.actor_role,
      createdAt: row.actor_created_at,
    });
    if (row.active_timeline_presence === null
        || row.active_timeline_presence !== row.active_timeline_id
        || row.active_timeline_campaign_id !== row.campaign_id
        || revisionSchema.parse(row.invalid_audit_count) !== 0
        || row.timeline_campaign_id !== null || row.timeline_revision !== null
        || row.timeline_created_at !== null || row.minimum_revision !== null
        || row.maximum_revision !== null || row.event_count !== 0
        || row.command_count !== 0 || row.receipt_count !== 0
        || row.distinct_revision_count !== 0) {
      throw new Error();
    }
    return null;
  } catch {
    throw new Error("campaign timeline aggregate is malformed");
  }
}

interface CampaignMembershipReadRow {
  actor_campaign_id: string;
  actor_principal_id: string;
  actor_role: string;
  actor_created_at: string;
  campaign_id: string;
  principal_id: string;
  role: string;
  created_at: string;
  principal_presence: string | null;
}

function toCampaignMembershipRead(row: CampaignMembershipReadRow): CampaignMembershipRead {
  if (row.principal_presence === null || row.principal_presence !== row.principal_id) {
    throw new Error("campaign membership is malformed");
  }
  try {
    campaignMembershipReadSchema.parse({
      campaignId: row.actor_campaign_id,
      principalId: row.actor_principal_id,
      role: row.actor_role,
      createdAt: row.actor_created_at,
    });
    return campaignMembershipReadSchema.parse({
      campaignId: row.campaign_id,
      principalId: row.principal_id,
      role: row.role,
      createdAt: row.created_at,
    });
  } catch {
    throw new Error("campaign membership is malformed");
  }
}

const CAMPAIGN_MEMBERSHIP_READ_SELECT = `SELECT
  actor_membership.campaign_id AS actor_campaign_id,
  actor_membership.principal_id AS actor_principal_id,
  actor_membership.role AS actor_role,
  actor_membership.created_at AS actor_created_at,
  target_membership.campaign_id, target_membership.principal_id,
  target_membership.role, target_membership.created_at,
  target_principal.id AS principal_presence
FROM campaign_memberships actor_membership
JOIN principals actor_principal ON actor_principal.id = actor_membership.principal_id
JOIN campaigns campaign ON campaign.id = actor_membership.campaign_id
JOIN campaign_memberships target_membership ON target_membership.campaign_id = campaign.id
LEFT JOIN principals target_principal ON target_principal.id = target_membership.principal_id
WHERE actor_membership.principal_id = ? AND actor_membership.campaign_id = ?
  AND actor_membership.role = 'owner'
  AND campaign.owner_principal_id = actor_membership.principal_id
  AND (SELECT COUNT(*) FROM campaign_memberships owner_membership
    WHERE owner_membership.campaign_id = campaign.id AND owner_membership.role = 'owner') = 1`;

function listCampaignMembershipsSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignMembershipRead[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const rows = db.prepare(`${CAMPAIGN_MEMBERSHIP_READ_SELECT}
ORDER BY target_membership.created_at ASC,
  target_membership.principal_id COLLATE BINARY ASC`).all(actorId, id) as CampaignMembershipReadRow[];
  return rows.map(toCampaignMembershipRead);
}

function getCampaignMembershipSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  principalId: string,
): CampaignMembershipRead | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const targetPrincipalId = resourceIdSchema.parse(principalId);
  const row = db.prepare(`${CAMPAIGN_MEMBERSHIP_READ_SELECT}
  AND target_membership.principal_id = ?`).get(actorId, id, targetPrincipalId) as
    | CampaignMembershipReadRow
    | undefined;
  return row ? toCampaignMembershipRead(row) : null;
}

interface CampaignSessionAttachmentReadRow extends CampaignSessionAttachmentRow {
  actor_campaign_id: string;
  actor_principal_id: string;
  actor_role: string;
  actor_created_at: string;
  session_presence: string | null;
}

function toCampaignSessionAttachmentRead(
  row: CampaignSessionAttachmentReadRow,
): CampaignSessionAttachment {
  if (row.session_presence === null || row.session_presence !== row.session_id) {
    throw new Error("campaign session attachment is malformed");
  }
  try {
    campaignMembershipReadSchema.parse({
      campaignId: row.actor_campaign_id,
      principalId: row.actor_principal_id,
      role: row.actor_role,
      createdAt: row.actor_created_at,
    });
    return toCampaignSessionAttachment(row);
  } catch {
    throw new Error("campaign session attachment is malformed");
  }
}

const CAMPAIGN_SESSION_ATTACHMENT_READ_SELECT = `SELECT
  actor_membership.campaign_id AS actor_campaign_id,
  actor_membership.principal_id AS actor_principal_id,
  actor_membership.role AS actor_role,
  actor_membership.created_at AS actor_created_at,
  attachment.campaign_id, attachment.session_id, attachment.attached_at,
  target_session.id AS session_presence
FROM campaign_memberships actor_membership
JOIN principals actor_principal ON actor_principal.id = actor_membership.principal_id
JOIN campaigns campaign ON campaign.id = actor_membership.campaign_id
JOIN campaign_sessions attachment ON attachment.campaign_id = campaign.id
LEFT JOIN sessions target_session ON target_session.id = attachment.session_id
WHERE actor_membership.principal_id = ? AND actor_membership.campaign_id = ?
  AND actor_membership.role = 'owner'
  AND campaign.owner_principal_id = actor_membership.principal_id
  AND (SELECT COUNT(*) FROM campaign_memberships owner_membership
    WHERE owner_membership.campaign_id = campaign.id AND owner_membership.role = 'owner') = 1`;

function listCampaignSessionAttachmentsSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignSessionAttachment[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const rows = db.prepare(`${CAMPAIGN_SESSION_ATTACHMENT_READ_SELECT}
ORDER BY attachment.attached_at ASC,
  attachment.session_id COLLATE BINARY ASC`).all(actorId, id) as CampaignSessionAttachmentReadRow[];
  return rows.map(toCampaignSessionAttachmentRead);
}

function getCampaignSessionAttachmentSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  sessionId: string,
): CampaignSessionAttachment | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  // Legacy session identifiers are deliberately opaque and are not resource IDs.
  const targetSessionId = attachCampaignSessionInputSchema.shape.sessionId.parse(sessionId);
  const row = db.prepare(`${CAMPAIGN_SESSION_ATTACHMENT_READ_SELECT}
  AND attachment.session_id = ?`).get(actorId, id, targetSessionId) as
    | CampaignSessionAttachmentReadRow
    | undefined;
  return row ? toCampaignSessionAttachmentRead(row) : null;
}

interface CampaignRoomSnapshotRow {
  row_kind: "authority" | "attached" | "eligible";
  campaign_id: string;
  actor_principal_id: string | null;
  actor_role: string | null;
  actor_created_at: string | null;
  actor_parent_id: string | null;
  owner_principal_id: string;
  campaign_owner_role: string;
  owner_membership_principal_id: string | null;
  owner_membership_role: string | null;
  owner_created_at: string | null;
  owner_parent_id: string | null;
  owner_count: unknown;
  session_id: string | null;
  session_presence: string | null;
  title: string | null;
  session_state: string | null;
  created_at: string | null;
  stopped_at: string | null;
  stop_reason_kind: unknown;
  attached_at: string | null;
  participant_names: string | null;
  participant_count: unknown;
  joined_character_count: unknown;
  primary_participant_count: unknown;
  distinct_character_count: unknown;
  distinct_position_count: unknown;
  malformed_position_count: unknown;
  minimum_position: unknown;
  maximum_position: unknown;
}

const SQL_VALID_STORED_RESOURCE_ID = (column: string): string =>
  `typeof(${column}) = 'text'
    AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 128
    AND instr(${column}, char(0)) = 0
    AND ${column} NOT GLOB '*[^A-Za-z0-9._:-]*'`;

function projectLegacyRoomText(value: unknown, nullable: boolean): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    if (nullable) return null;
    throw new Error("campaign room summary is malformed");
  }
  let projected = "";
  for (let index = 0; index < value.length;) {
    const first = value.charCodeAt(index);
    let width = 1;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) throw new Error("campaign room summary is malformed");
      width = 2;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new Error("campaign room summary is malformed");
    }
    if (projected.length + width > 200) break;
    projected += value.slice(index, index + width);
    index += width;
  }
  if (projected.trim().length === 0) {
    const trimmed = value.trimStart();
    return projectLegacyRoomText(trimmed, nullable);
  }
  return projected;
}

/**
 * One statement owns campaign authority and both bounded room lists. Only the
 * reviewed presentation fields and the minimum state/ancestry evidence needed
 * to prove them are selected; legacy character IDs and private room data never
 * enter the result set.
 */
function getCampaignRoomLinkingSnapshotSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignRoomLinkingSnapshot | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const rows = db.prepare(`WITH authority AS MATERIALIZED (
      SELECT campaign.id AS campaign_id, campaign.owner_principal_id,
        campaign.owner_role AS campaign_owner_role,
        actor_membership.principal_id AS actor_principal_id,
        actor_membership.role AS actor_role,
        actor_membership.created_at AS actor_created_at,
        actor_parent.id AS actor_parent_id,
        owner_membership.principal_id AS owner_membership_principal_id,
        owner_membership.role AS owner_membership_role,
        owner_membership.created_at AS owner_created_at,
        owner_parent.id AS owner_parent_id,
        (SELECT COUNT(*) FROM campaign_memberships sole_owner
          WHERE sole_owner.campaign_id = campaign.id AND sole_owner.role = 'owner') AS owner_count
      FROM campaigns campaign
      LEFT JOIN campaign_memberships actor_membership
        ON actor_membership.campaign_id = campaign.id AND actor_membership.principal_id = $actorId
      LEFT JOIN principals actor_parent ON actor_parent.id = actor_membership.principal_id
      LEFT JOIN campaign_memberships owner_membership
        ON owner_membership.campaign_id = campaign.id
        AND owner_membership.principal_id = campaign.owner_principal_id
        AND owner_membership.role = 'owner'
      LEFT JOIN principals owner_parent ON owner_parent.id = owner_membership.principal_id
       WHERE campaign.id = $campaignId
     ), authorized AS MATERIALIZED (
       SELECT campaign_id, owner_principal_id, campaign_owner_role,
         actor_principal_id, actor_role, actor_created_at, actor_parent_id,
         owner_membership_principal_id, owner_membership_role, owner_created_at,
         owner_parent_id, owner_count
       FROM authority
       WHERE actor_principal_id = $actorId
         AND actor_parent_id = $actorId
         AND actor_role IN ('owner', 'gm', 'player', 'observer')
         AND (actor_role <> 'owner' OR owner_principal_id = $actorId)
          AND campaign_owner_role = 'owner'
          AND owner_count = 1
          AND ${SQL_VALID_STORED_RESOURCE_ID("owner_principal_id")}
          AND ${SQL_VALID_STORED_RESOURCE_ID("owner_membership_principal_id")}
          AND ${SQL_VALID_STORED_RESOURCE_ID("owner_parent_id")}
          AND owner_membership_principal_id COLLATE BINARY = owner_principal_id COLLATE BINARY
          AND owner_membership_role = 'owner'
          AND owner_parent_id COLLATE BINARY = owner_principal_id COLLATE BINARY
          AND typeof(actor_created_at) = 'text'
         AND strftime('%Y-%m-%dT%H:%M:%fZ', actor_created_at) = actor_created_at
         AND typeof(owner_created_at) = 'text'
         AND strftime('%Y-%m-%dT%H:%M:%fZ', owner_created_at) = owner_created_at
     ), attached_candidates AS MATERIALIZED (
      SELECT attachment.session_id, attachment.attached_at
       FROM authorized
       JOIN campaign_sessions attachment ON attachment.campaign_id = authorized.campaign_id
       ORDER BY attachment.attached_at ASC, attachment.session_id COLLATE BINARY ASC
       LIMIT ${MAX_CAMPAIGN_ROOM_SUMMARIES + 1}
     ), eligible_candidates AS MATERIALIZED (
      SELECT session.id AS session_id, session.created_at
       FROM authorized
       JOIN sessions session
         ON authorized.actor_role = 'owner' AND authorized.owner_principal_id = $actorId
       WHERE session.state <> 'closed' AND session.stopped_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM campaign_sessions linked WHERE linked.session_id = session.id)
       ORDER BY session.created_at ASC, session.id COLLATE BINARY ASC
       LIMIT ${MAX_CAMPAIGN_ROOM_SUMMARIES + 1}
     ), selected AS MATERIALIZED (
      SELECT 'attached' AS row_kind, candidate.session_id, candidate.attached_at,
        candidate.attached_at AS ordering_time
      FROM attached_candidates candidate
      UNION ALL
      SELECT 'eligible', candidate.session_id, NULL, candidate.created_at
      FROM eligible_candidates candidate
    )
    SELECT 'authority' AS row_kind, authority.campaign_id,
      authority.actor_principal_id, authority.actor_role, authority.actor_created_at,
      authority.actor_parent_id, authority.owner_principal_id, authority.campaign_owner_role,
      authority.owner_membership_principal_id, authority.owner_membership_role,
      authority.owner_created_at, authority.owner_parent_id, authority.owner_count,
      NULL AS session_id, NULL AS session_presence, NULL AS title, NULL AS session_state,
       NULL AS created_at, NULL AS stopped_at, NULL AS stop_reason_kind, NULL AS attached_at,
       NULL AS participant_names, NULL AS participant_count, NULL AS joined_character_count,
       NULL AS primary_participant_count, NULL AS distinct_character_count, NULL AS distinct_position_count,
       NULL AS malformed_position_count, NULL AS minimum_position, NULL AS maximum_position,
       0 AS kind_order, '' AS ordering_time
    FROM authority
    UNION ALL
    SELECT selected.row_kind, authority.campaign_id,
      authority.actor_principal_id, authority.actor_role, authority.actor_created_at,
      authority.actor_parent_id, authority.owner_principal_id, authority.campaign_owner_role,
      authority.owner_membership_principal_id, authority.owner_membership_role,
      authority.owner_created_at, authority.owner_parent_id, authority.owner_count,
      selected.session_id, session.id AS session_presence, session.title,
       session.state AS session_state, session.created_at, session.stopped_at,
       CASE WHEN session.stop_reason IS NULL THEN 0
         WHEN typeof(session.stop_reason) = 'text' AND length(trim(session.stop_reason)) > 0 THEN 1
         ELSE 2 END AS stop_reason_kind,
       selected.attached_at,
      COALESCE((SELECT json_group_array(participant_name) FROM (
        SELECT character.name AS participant_name
        FROM session_characters participant
        JOIN characters character ON character.id = participant.character_id
        WHERE participant.session_id = selected.session_id
        ORDER BY participant.position ASC
        LIMIT 13
      )), '[]') AS participant_names,
      (SELECT COUNT(*) FROM session_characters participant
        WHERE participant.session_id = selected.session_id) AS participant_count,
      (SELECT COUNT(*) FROM session_characters participant
        JOIN characters character ON character.id = participant.character_id
        WHERE participant.session_id = selected.session_id) AS joined_character_count,
       (SELECT COUNT(*) FROM session_characters participant
         WHERE participant.session_id = selected.session_id
           AND participant.character_id = session.character_id) AS primary_participant_count,
       (SELECT COUNT(DISTINCT participant.character_id) FROM session_characters participant
         WHERE participant.session_id = selected.session_id) AS distinct_character_count,
       (SELECT COUNT(DISTINCT participant.position) FROM session_characters participant
         WHERE participant.session_id = selected.session_id) AS distinct_position_count,
       (SELECT COUNT(*) FROM session_characters participant
         WHERE participant.session_id = selected.session_id
           AND typeof(participant.position) <> 'integer') AS malformed_position_count,
      (SELECT MIN(participant.position) FROM session_characters participant
        WHERE participant.session_id = selected.session_id) AS minimum_position,
      (SELECT MAX(participant.position) FROM session_characters participant
        WHERE participant.session_id = selected.session_id) AS maximum_position,
      CASE selected.row_kind WHEN 'attached' THEN 1 ELSE 2 END AS kind_order,
      selected.ordering_time
    FROM selected CROSS JOIN authorized AS authority
    LEFT JOIN sessions session ON session.id = selected.session_id
    ORDER BY kind_order ASC, ordering_time ASC, session_id COLLATE BINARY ASC`)
    .all({ actorId, campaignId: id }) as CampaignRoomSnapshotRow[];
  if (rows.length === 0) return null;
  const authority = rows[0]!;
  if (authority.actor_principal_id !== actorId || authority.actor_parent_id !== actorId
    || authority.actor_role === null) return null;
  // These states cannot establish attributable membership. Mask them before
  // parsing any actor-controlled fields, preserving non-disclosure.
  if (!["owner", "gm", "player", "observer"].includes(authority.actor_role)) return null;
  if (authority.actor_role === "owner" && authority.owner_principal_id !== actorId) return null;
  try {
    campaignMembershipReadSchema.parse({
      campaignId: id, principalId: actorId, role: authority.actor_role, createdAt: authority.actor_created_at,
    });
  } catch {
    throw new Error("campaign room linking authority is malformed");
  }
  if (authority.campaign_id !== id || authority.campaign_owner_role !== "owner"
    || authority.owner_count !== 1
    || authority.owner_membership_principal_id !== authority.owner_principal_id
    || authority.owner_membership_role !== "owner"
    || authority.owner_parent_id !== authority.owner_principal_id) {
    throw new Error("campaign room linking authority is malformed");
  }
  try {
    campaignMembershipReadSchema.parse({
      campaignId: id, principalId: authority.owner_principal_id,
      role: authority.owner_membership_role, createdAt: authority.owner_created_at,
    });
  } catch {
    throw new Error("campaign room linking authority is malformed");
  }

  const attached: CampaignRoomLinkingResponse["attached"] = [];
  const eligible: CampaignRoomLinkingResponse["eligible"] = [];
  for (const row of rows.slice(1)) {
    if (row.session_id === null || row.session_presence !== row.session_id
      || row.created_at === null || row.session_state === null
      || !Number.isInteger(row.participant_count) || (row.participant_count as number) < 1
      || (row.participant_count as number) > 12
      || row.joined_character_count !== row.participant_count
      || row.primary_participant_count !== 1
      || row.distinct_character_count !== row.participant_count
      || row.distinct_position_count !== row.participant_count
      || row.malformed_position_count !== 0
      || row.minimum_position !== 0
      || row.maximum_position !== (row.participant_count as number) - 1) {
      throw new Error("campaign room summary is malformed");
    }
    const rawNames = JSON.parse(row.participant_names ?? "null") as unknown;
    if (!Array.isArray(rawNames) || rawNames.length !== row.participant_count) {
      throw new Error("campaign room summary is malformed");
    }
    let createdAt: string;
    try {
      createdAt = utcIsoTimestampSchema.parse(row.created_at);
    } catch {
      throw new Error("campaign room summary is malformed");
    }
    const running = (RUNNING_CAMPAIGN_ROOM_STATES as readonly string[]).includes(row.session_state)
      && row.stopped_at === null && row.stop_reason_kind === 0;
    let stopped = false;
    if (!running && row.session_state === "closed" && row.stopped_at !== null && row.stop_reason_kind === 1) {
      try {
        const stoppedAt = utcIsoTimestampSchema.parse(row.stopped_at);
        if (stoppedAt < createdAt) throw new Error("invalid stopped provenance");
        stopped = true;
      } catch {
        throw new Error("campaign room summary is malformed");
      }
    } else if (!running) {
      throw new Error("campaign room summary is malformed");
    }
    const summary = {
      sessionId: row.session_id,
      title: projectLegacyRoomText(row.title, true),
      participantNames: rawNames.map((name) => projectLegacyRoomText(name, false) as string),
      createdAt,
    };
    if (row.row_kind === "attached") {
      if (row.attached_at === null) {
        throw new Error("campaign room summary is malformed");
      }
      attached.push({ ...summary, attachedAt: row.attached_at, stopped });
    } else if (row.row_kind === "eligible") {
      if (authority.actor_role !== "owner" || authority.owner_principal_id !== actorId
        || !running) {
        throw new Error("campaign room summary is malformed");
      }
      eligible.push(summary);
    } else {
      throw new Error("campaign room summary is malformed");
    }
  }
  if (attached.length > MAX_CAMPAIGN_ROOM_SUMMARIES || eligible.length > MAX_CAMPAIGN_ROOM_SUMMARIES) {
    throw new Error("campaign room summary limit exceeded");
  }
  const response = campaignRoomLinkingResponseSchema.parse({ attached, eligible });
  return { campaignId: id, ...response };
}

// Compatibility delegates retained for the composed repository facade.
function createCampaignSync(db: DatabaseDriver.Database, dependencies: RepositoryDependencies, actor: string, input: CreateCampaignInput): Campaign {
  return createCampaignSyncInternal(db, dependencies, actor, input);
}
function recordCompatibilityAdministrationAudit(db: DatabaseDriver.Database, campaignId: string, actor: string,
  type: "campaign_renamed" | "membership_added" | "room_attached" | "room_detached", payload: object, result: object, at: string): void {
  return recordCompatibilityAdministrationAuditInternal(db, campaignId, actor, type, payload, result, at);
}
function renameCampaignSync(db: DatabaseDriver.Database, clock: Clock, actor: string, campaignId: string, input: RenameCampaignInput): Campaign {
  return renameCampaignSyncInternal(db, clock, actor, campaignId, input);
}
function renameCampaignIfUnchangedSync(db: DatabaseDriver.Database, clock: Clock, actor: string, campaignId: string, input: CampaignRenameRequest): Campaign {
  return renameCampaignIfUnchangedSyncInternal(db, clock, actor, campaignId, input);
}
function addCampaignMembershipSync(db: DatabaseDriver.Database, clock: Clock, actor: string, campaignId: string, input: AddCampaignMembershipInput): CampaignMembership {
  return addCampaignMembershipSyncInternal(db, clock, actor, campaignId, input);
}
function getCampaignRoomSessionIntegrityRow(db: DatabaseDriver.Database, sessionId: string) {
  return getCampaignRoomSessionIntegrityRowInternal(db, sessionId);
}
function validateCampaignRoomSessionIntegrity(row: CampaignRoomSessionIntegrityRow): "running" | "stopped" {
  return validateCampaignRoomSessionIntegrityInternal(row);
}
function attachCampaignSessionSync(db: DatabaseDriver.Database, clock: Clock, actor: string, input: AttachCampaignSessionInput): CampaignSessionAttachment {
  return attachCampaignSessionSyncInternal(db, clock, actor, input);
}
function detachCampaignSessionSync(db: DatabaseDriver.Database, actor: string, input: DetachCampaignSessionInput): CampaignSessionAttachment | null {
  return detachCampaignSessionSyncInternal(db, actor, input);
}
function listCampaignsSync(db: DatabaseDriver.Database, actor: string): CampaignAccess[] { return listCampaignsSyncInternal(db, actor); }
function getCampaignSync(db: DatabaseDriver.Database, actor: string, campaignId: string): CampaignAccess | null { return getCampaignSyncInternal(db, actor, campaignId); }
function listCampaignTimelinesSync(db: DatabaseDriver.Database, actor: string, campaignId: string): CampaignTimeline[] { return listCampaignTimelinesSyncInternal(db, actor, campaignId); }
function getCampaignTimelineSync(db: DatabaseDriver.Database, actor: string, campaignId: string, timelineId: string): CampaignTimeline | null { return getCampaignTimelineSyncInternal(db, actor, campaignId, timelineId); }
function listCampaignMembershipsSync(db: DatabaseDriver.Database, actor: string, campaignId: string): CampaignMembershipRead[] { return listCampaignMembershipsSyncInternal(db, actor, campaignId); }
function getCampaignMembershipSync(db: DatabaseDriver.Database, actor: string, campaignId: string, principalId: string): CampaignMembershipRead | null { return getCampaignMembershipSyncInternal(db, actor, campaignId, principalId); }
function listCampaignSessionAttachmentsSync(db: DatabaseDriver.Database, actor: string, campaignId: string): CampaignSessionAttachment[] { return listCampaignSessionAttachmentsSyncInternal(db, actor, campaignId); }
function getCampaignSessionAttachmentSync(db: DatabaseDriver.Database, actor: string, campaignId: string, sessionId: string): CampaignSessionAttachment | null { return getCampaignSessionAttachmentSyncInternal(db, actor, campaignId, sessionId); }
function getCampaignRoomLinkingSnapshotSync(db: DatabaseDriver.Database, actor: string, campaignId: string): CampaignRoomLinkingSnapshot | null { return getCampaignRoomLinkingSnapshotSyncInternal(db, actor, campaignId); }

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
function getCampaignCharacterRosterSyncInternal(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignCharacterRosterSnapshot | null {
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
}

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

/**
 * The caller owns the surrounding SQLite snapshot. The workspace read proves
 * the complete campaign ancestry; progression then narrows visibility to an
 * owner, GM, or the actor's controller before its derived state is returned.
 */
function getCampaignCharacterSheetSnapshotSyncInternal(
  db: DatabaseDriver.Database,
  progressionRepository: CharacterProgressionRepository,
  actorPrincipalId: string,
  campaignId: string,
  campaignCharacterId: string,
): CampaignCharacterSheetSnapshot | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const targetId = resourceIdSchema.parse(campaignCharacterId);
  const workspace = getCampaignCharacterWorkspaceSyncInternal(db, actorId, id, targetId);
  if (workspace === null) return null;

  const progression = progressionRepository.getCharacterProgression(actorId, targetId);
  if (progression === null) return null;
  if (workspace.campaignId !== id || workspace.campaignCharacterId !== targetId
    || progression.campaignId !== id || progression.campaignCharacterId !== targetId) {
    throw new Error("campaign character sheet snapshot is malformed");
  }
  return { campaignId: id, campaignCharacterId: targetId, sheet: workspace.character, progression };
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

function actorResourceFromReadRow(
  row: ActorResourceReadRow,
  campaignId: string,
  actorId: string,
): ActorResource | null {
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

function listActorResourcesSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  actorId: string,
): ActorResource[] {
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
}

function getActorResourceSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  actorId: string,
  name: string,
): ActorResource | null {
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
    const timelineState = getCampaignTimelineSync(db, principalId, normalizedCampaignId, normalizedTimelineId);
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

interface RulesProfileRow {
  rules_profile_id: string;
  name: string;
  description: string;
  tags: string;
}

interface ContentPackRow extends RulesProfileRow {
  pack_id: string;
  pack_version: string;
}

interface RpgDefinitionRow {
  kind: string;
  definition_id: string;
  name: string;
  description: string;
  tags: string;
}

function parseTags(tags: string): unknown {
  return JSON.parse(tags) as unknown;
}

function toRulesProfile(row: RulesProfileRow): RulesProfile {
  return rulesProfileSchema.parse({
    rulesProfileId: row.rules_profile_id,
    name: row.name,
    description: row.description,
    tags: parseTags(row.tags),
  });
}

function toContentPack(row: ContentPackRow): ContentPack {
  return contentPackSchema.parse({
    packId: row.pack_id,
    packVersion: row.pack_version,
    rulesProfileId: row.rules_profile_id,
    name: row.name,
    description: row.description,
    tags: parseTags(row.tags),
  });
}

function toRpgDefinition(row: RpgDefinitionRow): RpgDefinition {
  return rpgDefinitionSchema.parse({
    kind: row.kind,
    definitionId: row.definition_id,
    name: row.name,
    description: row.description,
    tags: parseTags(row.tags),
  });
}

function sameMetadata(
  left: { name: string; description: string; tags: readonly string[] },
  right: { name: string; description: string; tags: readonly string[] },
): boolean {
  return left.name === right.name
    && left.description === right.description
    && left.tags.length === right.tags.length
    && left.tags.every((tag, index) => tag === right.tags[index]);
}

function requireOriginalStarterInspectionForWrite(
  db: DatabaseDriver.Database,
  actorId: string,
  campaignId: string,
  operation: "install" | "configure",
): OriginalStarterSetupInspection {
  const inspection = inspectOriginalStarterSetupSync(db, actorId, campaignId);
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
      requireOriginalStarterInspectionForWrite(db, actorId, starterCampaignId, "install");
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
      requireOriginalStarterInspectionForWrite(db, actorId, starterCampaignId, "install");
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
      requireOriginalStarterInspectionForWrite(db, actorId, id, "configure");
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
      requireOriginalStarterInspectionForWrite(db, actorId, id, "configure");
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

const RULES_PROFILE_PROJECTION = "rp.rules_profile_id, rp.name, rp.description, rp.tags";
const CONTENT_PACK_PROJECTION = `p.pack_id, p.pack_version, p.rules_profile_id,
  p.name, p.description, p.tags`;
const DEFINITION_PROJECTION = "d.kind, d.definition_id, d.name, d.description, d.tags";
const DEFINITION_ORDER = `CASE d.kind
      WHEN 'class' THEN 1 WHEN 'race' THEN 2 WHEN 'background' THEN 3 WHEN 'item' THEN 4
      WHEN 'spell' THEN 5 WHEN 'ability' THEN 6 WHEN 'enemy' THEN 7 END ASC, d.definition_id ASC`;

function listRulesProfilesSync(db: DatabaseDriver.Database, actorPrincipalId: string): RulesProfile[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const rows = db.prepare(`SELECT ${RULES_PROFILE_PROJECTION}
    FROM application_owner ao
    JOIN rpg_rules_profiles rp ON ao.principal_id = ?
    WHERE ao.singleton = 1
    ORDER BY rp.rules_profile_id ASC`).all(actorId) as RulesProfileRow[];
  return rows.map(toRulesProfile);
}

function getRulesProfileSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  identifier: RulesProfileIdentifier,
): RulesProfile | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = rulesProfileIdentifierSchema.parse(identifier);
  const row = db.prepare(`SELECT ${RULES_PROFILE_PROJECTION}
    FROM application_owner ao
    JOIN rpg_rules_profiles rp ON ao.principal_id = ? AND rp.rules_profile_id = ?
    WHERE ao.singleton = 1`).get(actorId, normalized.rulesProfileId) as RulesProfileRow | undefined;
  return row ? toRulesProfile(row) : null;
}

function listContentPacksSync(db: DatabaseDriver.Database, actorPrincipalId: string): ContentPack[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const rows = db.prepare(`SELECT ${CONTENT_PACK_PROJECTION}
    FROM application_owner ao
    JOIN rpg_content_packs p ON ao.principal_id = ?
    WHERE ao.singleton = 1 AND p.sealed = 1
    ORDER BY p.pack_id ASC, p.pack_version ASC`).all(actorId) as ContentPackRow[];
  return rows.map(toContentPack);
}

function getContentPackSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  identifier: ContentPackIdentifier,
): ContentPack | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = contentPackIdentifierSchema.parse(identifier);
  const row = db.prepare(`SELECT ${CONTENT_PACK_PROJECTION}
    FROM application_owner ao
    JOIN rpg_content_packs p ON ao.principal_id = ? AND p.pack_id = ? AND p.pack_version = ?
    WHERE ao.singleton = 1 AND p.sealed = 1`).get(actorId, normalized.packId, normalized.packVersion) as ContentPackRow | undefined;
  return row ? toContentPack(row) : null;
}

function listContentPackDefinitionsSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  identifier: ContentPackIdentifier,
): RpgDefinition[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = contentPackIdentifierSchema.parse(identifier);
  const rows = db.prepare(`SELECT ${DEFINITION_PROJECTION}
    FROM application_owner ao
    JOIN rpg_definitions d ON ao.principal_id = ? AND d.pack_id = ? AND d.pack_version = ?
    JOIN rpg_content_packs p ON p.pack_id = d.pack_id AND p.pack_version = d.pack_version AND p.sealed = 1
    WHERE ao.singleton = 1
    ORDER BY ${DEFINITION_ORDER}`).all(actorId, normalized.packId, normalized.packVersion) as RpgDefinitionRow[];
  return rows.map(toRpgDefinition);
}

function getContentPackDefinitionSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  reference: DefinitionReference,
): RpgDefinition | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = definitionReferenceSchema.parse(reference);
  const row = db.prepare(`SELECT ${DEFINITION_PROJECTION}
    FROM application_owner ao
    JOIN rpg_definitions d ON ao.principal_id = ? AND d.pack_id = ? AND d.pack_version = ?
      AND d.kind = ? AND d.definition_id = ?
    JOIN rpg_content_packs p ON p.pack_id = d.pack_id AND p.pack_version = d.pack_version AND p.sealed = 1
    WHERE ao.singleton = 1`).get(
      actorId,
      normalized.packId,
      normalized.packVersion,
      normalized.kind,
      normalized.definitionId,
    ) as RpgDefinitionRow | undefined;
  return row ? toRpgDefinition(row) : null;
}

function getCampaignRulesProfileSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): RulesProfile | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const row = db.prepare(`SELECT ${RULES_PROFILE_PROJECTION}
    FROM campaign_memberships cm
    JOIN campaign_rules_profiles crp ON crp.campaign_id = cm.campaign_id
    JOIN rpg_rules_profiles rp ON rp.rules_profile_id = crp.rules_profile_id
    WHERE cm.principal_id = ? AND cm.campaign_id = ?`).get(actorId, id) as RulesProfileRow | undefined;
  return row ? toRulesProfile(row) : null;
}

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
    toRulesProfile({
      rules_profile_id: first.profile_rules_profile_id!,
      name: first.profile_name!,
      description: first.profile_description!,
      tags: first.profile_tags!,
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
      const pack = toContentPack({
        pack_id: row.pack_id!,
        pack_version: row.pack_version!,
        rules_profile_id: row.pack_rules_profile_id!,
        name: row.pack_name!,
        description: row.pack_description!,
        tags: row.pack_tags!,
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
 * Legacy character storage deliberately has no modern name bound. Project the
 * longest well-formed UTF-16 prefix that fits the strict 200-code-unit wire
 * schema, never splitting a surrogate pair. If that prefix is blank, retry
 * after leading whitespace so valid legacy data still has a visible wire
 * projection. Storage and legacy APIs stay unchanged. Empty, whitespace-only,
 * and malformed UTF-16 names are corrupt.
 */
function projectLegacyPersonaDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("legacy persona display name is malformed");
  }
  for (const source of [value, value.trimStart()]) {
    let projected = "";
    for (let index = 0; index < source.length;) {
      const first = source.charCodeAt(index);
      let width = 1;
      if (first >= 0xd800 && first <= 0xdbff) {
        const second = source.charCodeAt(index + 1);
        if (!(second >= 0xdc00 && second <= 0xdfff)) {
          throw new Error("legacy persona display name is malformed");
        }
        width = 2;
      } else if (first >= 0xdc00 && first <= 0xdfff) {
        throw new Error("legacy persona display name is malformed");
      }
      if (projected.length + width > 200) break;
      projected += source.slice(index, index + width);
      index += width;
    }
    if (projected.trim().length > 0) return projected;
  }
  throw new Error("legacy persona display name is malformed");
}

/**
 * Reconstructs authority, configuration, persona availability, and current
 * campaign links from one statement. Keeping this as a single statement is
 * intentional: factory callers receive SQLite's implicit statement snapshot,
 * while active units of work receive their enclosing transaction snapshot.
 */
function getCampaignCharacterCreationOptionsSyncInternal(
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

function getCampaignDetailSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignDetail | null {
  const campaign = getCampaignSyncInternal(db, actorPrincipalId, campaignId);
  if (!campaign) return null;
  const configuration = getCampaignContentConfigurationSync(db, actorPrincipalId, campaignId);
  return campaignDetailSchema.parse({
    id: campaign.id,
    name: campaign.name,
    actorRole: campaign.actorRole,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    content: configuration
      ? {
        status: "configured",
        rulesProfileId: configuration.rulesProfileId,
        contentPacks: configuration.contentPacks,
      }
      : { status: "unconfigured" },
  });
}

function inspectOriginalStarterSetupSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): OriginalStarterSetupInspection {
  const actor = resourceIdSchema.safeParse(actorPrincipalId);
  const id = resourceIdSchema.safeParse(campaignId);
  if (!actor.success || !id.success) return { status: "unavailable" };

  // Check both authorities before reserved identities to avoid disclosing state.
  const authority = db.prepare(`SELECT ao.principal_id, p.id AS principal_parent_id, p.is_local,
      (SELECT COUNT(*) FROM application_owner) AS owner_count
    FROM application_owner ao JOIN principals p ON p.id = ao.principal_id
    WHERE ao.singleton = 1`).get() as
      | { principal_id: string; principal_parent_id: string; is_local: number; owner_count: number }
      | undefined;
  if (!authority || authority.owner_count !== 1 || authority.principal_id !== actor.data
    || authority.principal_parent_id !== actor.data || authority.is_local !== 1) {
    return { status: "unavailable" };
  }
  const ownership = db.prepare(`SELECT c.owner_principal_id, owner_principal.id AS owner_parent_id,
      cm.campaign_id AS membership_campaign_id, cm.principal_id AS membership_principal_id,
      cm.role, cm.created_at AS membership_created_at,
      (SELECT COUNT(*) FROM campaign_memberships owner_lock
        WHERE owner_lock.campaign_id = c.id AND owner_lock.role = 'owner') AS owner_count
    FROM campaigns c
    LEFT JOIN principals owner_principal ON owner_principal.id = c.owner_principal_id
    LEFT JOIN campaign_memberships cm
      ON cm.campaign_id = c.id AND cm.principal_id = ?
    WHERE c.id = ?`).get(actor.data, id.data) as
      | { owner_principal_id: string; owner_parent_id: string | null; membership_campaign_id: unknown;
          membership_principal_id: unknown; role: unknown; membership_created_at: unknown; owner_count: number }
      | undefined;
  const ownerMembership = ownership && campaignMembershipReadSchema.safeParse({
    campaignId: ownership.membership_campaign_id,
    principalId: ownership.membership_principal_id,
    role: ownership.role,
    createdAt: ownership.membership_created_at,
  });
  if (!ownership || !ownerMembership || !ownerMembership.success
    || ownership.owner_principal_id !== actor.data || ownership.owner_parent_id !== actor.data
    || ownerMembership.data.campaignId !== id.data || ownerMembership.data.principalId !== actor.data
    || ownerMembership.data.role !== "owner" || ownership.owner_count !== 1) {
    return { status: "unavailable" };
  }

  // Validate the attributable campaign row before classifying reserved state,
  // so an exact content pointer cannot hide unrelated campaign corruption.
  if (!getCampaignSyncInternal(db, actor.data, id.data)) return { status: "unavailable" };

  // Inspect only raw configuration identities before detail reconstruction.
  // An exact starter pointer whose required profile/pack has disappeared (or
  // is malformed) is a stable reserved-namespace conflict, not an incidental
  // failure of the general detail projection. Other malformed configurations
  // still flow through the ordinary detail validator below and remain loud.
  const selectedIdentity = db.prepare(`SELECT campaign_id, rules_profile_id
    FROM campaign_rules_profiles WHERE campaign_id = ?`).get(id.data) as
    | { campaign_id: string; rules_profile_id: string }
    | undefined;
  const pinIdentities = db.prepare(`SELECT campaign_id, pack_id, pack_version, rules_profile_id
    FROM campaign_content_packs WHERE campaign_id = ? ORDER BY rowid ASC`).all(id.data) as Array<{
      campaign_id: string;
      pack_id: string;
      pack_version: string;
      rules_profile_id: string;
    }>;
  const pointsExactlyToStarter = selectedIdentity?.campaign_id === id.data
    && selectedIdentity.rules_profile_id === ORIGINAL_STARTER_RULES_PROFILE_ID
    && pinIdentities.length === 1
    && pinIdentities[0]?.campaign_id === id.data
    && pinIdentities[0]?.rules_profile_id === ORIGINAL_STARTER_RULES_PROFILE_ID
    && pinIdentities[0]?.pack_id === ORIGINAL_STARTER_PACK_ID
    && pinIdentities[0]?.pack_version === ORIGINAL_STARTER_PACK_VERSION;
  if (pointsExactlyToStarter) {
    const requiredProfile = db.prepare(`SELECT rules_profile_id, name, description, tags
      FROM rpg_rules_profiles WHERE rules_profile_id = ?`)
      .get(ORIGINAL_STARTER_RULES_PROFILE_ID) as RulesProfileRow | undefined;
    const requiredPack = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags, sealed
      FROM rpg_content_packs WHERE pack_id = ? AND pack_version = ?`)
      .get(ORIGINAL_STARTER_PACK_ID, ORIGINAL_STARTER_PACK_VERSION) as
      | (ContentPackRow & { sealed: number })
      | undefined;
    try {
      if (!requiredProfile || !requiredPack || requiredPack.sealed !== 1
        || requiredPack.rules_profile_id !== ORIGINAL_STARTER_RULES_PROFILE_ID
        || !sameMetadata(toRulesProfile(requiredProfile), ORIGINAL_STARTER_MANIFEST.rulesProfile)
        || !sameMetadata(toContentPack(requiredPack), ORIGINAL_STARTER_MANIFEST)) {
        return { status: "conflict" };
      }
    } catch {
      return { status: "conflict" };
    }
  }

  const campaign = getCampaignDetailSync(db, actor.data, id.data);
  if (!campaign) return { status: "unavailable" };
  const exactConfiguration = campaign.content.status === "configured"
    && campaign.content.rulesProfileId === ORIGINAL_STARTER_RULES_PROFILE_ID
    && campaign.content.contentPacks.length === 1
    && campaign.content.contentPacks[0]?.packId === ORIGINAL_STARTER_PACK_ID
    && campaign.content.contentPacks[0]?.packVersion === ORIGINAL_STARTER_PACK_VERSION;
  if (campaign.content.status === "configured" && !exactConfiguration) return { status: "conflict" };

  const profile = db.prepare(`SELECT rules_profile_id, name, description, tags
    FROM rpg_rules_profiles WHERE rules_profile_id = ?`)
    .get(ORIGINAL_STARTER_RULES_PROFILE_ID) as RulesProfileRow | undefined;
  const packs = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags, sealed
    FROM rpg_content_packs WHERE pack_id = ? ORDER BY pack_version`)
    .all(ORIGINAL_STARTER_PACK_ID) as Array<ContentPackRow & { sealed: number }>;
  if (packs.some((pack) => pack.pack_version !== ORIGINAL_STARTER_PACK_VERSION) || packs.length > 1) {
    return { status: "conflict" };
  }

  const expectedDefinitions = [
    ...ORIGINAL_STARTER_MANIFEST.classes, ...ORIGINAL_STARTER_MANIFEST.races,
    ...ORIGINAL_STARTER_MANIFEST.backgrounds, ...ORIGINAL_STARTER_MANIFEST.items,
    ...ORIGINAL_STARTER_MANIFEST.spells, ...ORIGINAL_STARTER_MANIFEST.abilities,
    ...ORIGINAL_STARTER_MANIFEST.enemies,
  ];
  const placeholders = expectedDefinitions.map(() => "?").join(", ");
  // Compare every row owned by the reserved pack (including unexpected kinds
  // and IDs), while also finding expected reserved IDs captured elsewhere.
  const reservedDefinitions = db.prepare(`SELECT pack_id, pack_version, kind, definition_id, name, description, tags
    FROM rpg_definitions
    WHERE pack_id = ? OR definition_id IN (${placeholders})`)
    .all(
      ORIGINAL_STARTER_PACK_ID,
      ...expectedDefinitions.map((definition) => definition.definitionId),
    ) as
      Array<RpgDefinitionRow & { pack_id: string; pack_version: string }>;
  if (reservedDefinitions.some((definition) => definition.pack_id !== ORIGINAL_STARTER_PACK_ID
    || definition.pack_version !== ORIGINAL_STARTER_PACK_VERSION)) return { status: "conflict" };

  const pack = packs[0];
  try {
    if (profile && !sameMetadata(toRulesProfile(profile), ORIGINAL_STARTER_MANIFEST.rulesProfile)) {
      return { status: "conflict" };
    }
    if (pack) {
      if (!profile || pack.sealed !== 1 || pack.rules_profile_id !== ORIGINAL_STARTER_RULES_PROFILE_ID
        || !sameMetadata(toContentPack(pack), ORIGINAL_STARTER_MANIFEST)) return { status: "conflict" };
    let installed: Map<string, RpgDefinition>;
      installed = new Map(reservedDefinitions.map((row) => {
          const definition = toRpgDefinition(row);
          return [`${definition.kind}:${definition.definitionId}`, definition];
        }));
      if (installed.size !== expectedDefinitions.length || expectedDefinitions.some((definition) => {
        const persisted = installed.get(`${definition.kind}:${definition.definitionId}`);
        return !persisted || !sameMetadata(persisted, definition);
      })) return { status: "conflict" };
    } else if (reservedDefinitions.length > 0) {
      return { status: "conflict" };
    }
  } catch {
    return { status: "conflict" };
  }

  if (exactConfiguration && pack) return { status: "exact", campaign };
  return { status: "unconfigured", campaign };
}

function listCampaignContentPacksSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): ContentPack[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const rows = db.prepare(`SELECT ${CONTENT_PACK_PROJECTION}
    FROM campaign_memberships cm
    JOIN campaign_content_packs cp ON cp.campaign_id = cm.campaign_id
    JOIN rpg_content_packs p ON p.pack_id = cp.pack_id AND p.pack_version = cp.pack_version
      AND p.rules_profile_id = cp.rules_profile_id AND p.sealed = 1
    WHERE cm.principal_id = ? AND cm.campaign_id = ?
    ORDER BY p.pack_id ASC, p.pack_version ASC`).all(actorId, id) as ContentPackRow[];
  return rows.map(toContentPack);
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
  return {
    getCampaignCharacterCreationOptions: (actor: string, campaignId: string) =>
      getCampaignCharacterCreationOptionsSyncInternal(db, actor, campaignId),
    getCampaignCharacterRoster: (actor: string, campaignId: string) =>
      getCampaignCharacterRosterSyncInternal(db, actor, campaignId),
    getCampaignCharacterWorkspace: (actor: string, campaignId: string, campaignCharacterId: string) =>
      getCampaignCharacterWorkspaceSyncInternal(db, actor, campaignId, campaignCharacterId),
    getCampaignCharacterSheetSnapshot: (actor: string, campaignId: string, campaignCharacterId: string) =>
      getCampaignCharacterSheetSnapshotSyncInternal(db, progressionRepository, actor, campaignId, campaignCharacterId),
    listCampaignCharacters: (actor: string, campaignId: string) => listCampaignCharactersSyncInternal(db, actor, campaignId),
    getCampaignCharacter: (actor: string, campaignId: string, campaignCharacterId: string) =>
      getCampaignCharacterSyncInternal(db, actor, campaignId, campaignCharacterId),
    getCampaignCharacterByActorId: (actor: string, campaignId: string, actorId: string) =>
      getCampaignCharacterByActorIdSyncInternal(db, actor, campaignId, actorId),
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
  const campaignEventProjectionRepository = createCampaignEventProjectionRepo({
    listCampaignEvents: (actor, campaignId, timelineId) => listCampaignEventsSync(db, actor, campaignId, timelineId),
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
      return listCampaignsSync(db, actorPrincipalId);
    },
    getCampaign: (actorPrincipalId, campaignId) => {
      assertActive();
      return getCampaignSync(db, actorPrincipalId, campaignId);
    },
    getCampaignDetail: (actorPrincipalId, campaignId) => {
      assertActive();
      // runTransaction owns the snapshot for all composed aggregate reads.
      return getCampaignDetailSync(db, actorPrincipalId, campaignId);
    },
    listCampaignTimelines: (actorPrincipalId, campaignId) => {
      assertActive();
      return listCampaignTimelinesSync(db, actorPrincipalId, campaignId);
    },
    getCampaignTimeline: (actorPrincipalId, campaignId, timelineId) => {
      assertActive();
      return getCampaignTimelineSync(db, actorPrincipalId, campaignId, timelineId);
    },
    listCampaignMemberships: (actorPrincipalId, campaignId) => {
      assertActive();
      return listCampaignMembershipsSync(db, actorPrincipalId, campaignId);
    },
    getCampaignMembership: (actorPrincipalId, campaignId, principalId) => {
      assertActive();
      return getCampaignMembershipSync(db, actorPrincipalId, campaignId, principalId);
    },
    listCampaignSessionAttachments: (actorPrincipalId, campaignId) => {
      assertActive();
      return listCampaignSessionAttachmentsSync(db, actorPrincipalId, campaignId);
    },
    getCampaignSessionAttachment: (actorPrincipalId, campaignId, sessionId) => {
      assertActive();
      return getCampaignSessionAttachmentSync(db, actorPrincipalId, campaignId, sessionId);
    },
    getCampaignRoomLinkingSnapshot: (actorPrincipalId, campaignId) => {
      assertActive();
      return getCampaignRoomLinkingSnapshotSync(db, actorPrincipalId, campaignId);
    },
    getCampaignContentConfiguration: (actorPrincipalId, campaignId) => {
      assertActive();
      return getCampaignContentConfigurationSync(db, actorPrincipalId, campaignId);
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
      return listActorResourcesSync(db, actorPrincipalId, campaignId, actorId);
    },
    getActorResource: (actorPrincipalId, campaignId, actorId, name) => {
      assertActive();
      return getActorResourceSync(db, actorPrincipalId, campaignId, actorId, name);
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
      return listRulesProfilesSync(db, actorPrincipalId);
    },
    getRulesProfile: (actorPrincipalId, identifier) => {
      assertActive();
      return getRulesProfileSync(db, actorPrincipalId, identifier);
    },
    listContentPacks: (actorPrincipalId) => {
      assertActive();
      return listContentPacksSync(db, actorPrincipalId);
    },
    getContentPack: (actorPrincipalId, identifier) => {
      assertActive();
      return getContentPackSync(db, actorPrincipalId, identifier);
    },
    listContentPackDefinitions: (actorPrincipalId, identifier) => {
      assertActive();
      return listContentPackDefinitionsSync(db, actorPrincipalId, identifier);
    },
    getContentPackDefinition: (actorPrincipalId, reference) => {
      assertActive();
      return getContentPackDefinitionSync(db, actorPrincipalId, reference);
    },
    getCampaignRulesProfile: (actorPrincipalId, campaignId) => {
      assertActive();
      return getCampaignRulesProfileSync(db, actorPrincipalId, campaignId);
    },
    listCampaignContentPacks: (actorPrincipalId, campaignId) => {
      assertActive();
      return listCampaignContentPacksSync(db, actorPrincipalId, campaignId);
    },
    listCampaignContentPackDefinitions: (actorPrincipalId, campaignId, identifier) => {
      assertActive();
      return listCampaignContentPackDefinitionsSync(db, actorPrincipalId, campaignId, identifier);
    },
    getCampaignContentPackDefinition: (actorPrincipalId, campaignId, reference) => {
      assertActive();
      return getCampaignContentPackDefinitionSync(db, actorPrincipalId, campaignId, reference);
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
  const campaignCommandRepository = createCampaignCommandRepository({
    executeRollActorDice: (actor, input) => executeRollActorDiceSync(db, dependencies, actor, input),
    executeRollActorDiceForVisibleCharacter: (actor, input, binding) =>
      executeRollActorDiceForVisibleCharacterSync(db, dependencies, actor, input, binding),
    listRecentCampaignDiceEvents: (actor, campaignId, timelineId) =>
      listRecentCampaignDiceEventsSync(db, actor, campaignId, timelineId),
    getCommandReceipt: (actor, campaignId, commandId) =>
      getCommandReceiptSync(db, actor, campaignId, commandId),
  });
  const diceRepository = createDiceRepository(db, dependencies, campaignCommandRepository);
  const campaignCoreRepository = createCampaignCoreRepository({
    createCampaign: (actor, input) => createCampaignSyncInternal(db, dependencies, actor, input),
    renameCampaign: (actor, campaignId, input) => renameCampaignSyncInternal(db, dependencies.clock, actor, campaignId, input),
    renameCampaignIfUnchanged: (actor, campaignId, input) =>
      renameCampaignIfUnchangedSyncInternal(db, dependencies.clock, actor, campaignId, input),
    addCampaignMembership: (actor, campaignId, input) =>
      addCampaignMembershipSyncInternal(db, dependencies.clock, actor, campaignId, input),
    attachCampaignSession: (actor, input) => attachCampaignSessionSyncInternal(db, dependencies.clock, actor, input),
    detachCampaignSession: (actor, input) => detachCampaignSessionSyncInternal(db, actor, input),
    listCampaigns: (actor) => listCampaignsSyncInternal(db, actor),
    getCampaign: (actor, campaignId) => getCampaignSyncInternal(db, actor, campaignId),
    listCampaignTimelines: (actor, campaignId) => listCampaignTimelinesSyncInternal(db, actor, campaignId),
    getCampaignTimeline: (actor, campaignId, timelineId) => getCampaignTimelineSyncInternal(db, actor, campaignId, timelineId),
    listCampaignMemberships: (actor, campaignId) => listCampaignMembershipsSyncInternal(db, actor, campaignId),
    getCampaignMembership: (actor, campaignId, principalId) => getCampaignMembershipSyncInternal(db, actor, campaignId, principalId),
    listCampaignSessionAttachments: (actor, campaignId) => listCampaignSessionAttachmentsSyncInternal(db, actor, campaignId),
    getCampaignSessionAttachment: (actor, campaignId, sessionId) => getCampaignSessionAttachmentSyncInternal(db, actor, campaignId, sessionId),
    getCampaignRoomLinkingSnapshot: (actor, campaignId) => getCampaignRoomLinkingSnapshotSyncInternal(db, actor, campaignId),
    getCampaignRoomSessionLifecycle: (sessionId) => {
      const row = getCampaignRoomSessionIntegrityRowInternal(db, sessionId);
      return row ? validateCampaignRoomSessionIntegrityInternal(row) : null;
    },
  },
    (campaignId, actor, type, payload, result, occurredAt) =>
      recordCompatibilityAdministrationAuditInternal(db, campaignId, actor, type, payload, result, occurredAt));
  const campaignEventProjectionRepository = createCampaignEventProjectionRepo({
    listCampaignEvents: (actor, campaignId, timelineId) => listCampaignEventsSync(db, actor, campaignId, timelineId),
  });
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
      return db.transaction(() => inspectOriginalStarterSetupSync(db, actorPrincipalId, campaignId))();
    },
    installOriginalStarterContent: (actorPrincipalId, campaignId) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("original starter installation cannot run inside a repository transaction");
      return installContentPackSync(
        db,
        actorPrincipalId,
        installContentPackInputSchema.parse(ORIGINAL_STARTER_MANIFEST),
        campaignId,
      );
    },
    configureOriginalStarterContent: (actorPrincipalId, campaignId) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("original starter configuration cannot run inside a repository transaction");
      return configureCampaignContentSync(db, actorPrincipalId, campaignId, {
        rulesProfileId: ORIGINAL_STARTER_RULES_PROFILE_ID,
        contentPacks: [{ packId: ORIGINAL_STARTER_PACK_ID, packVersion: ORIGINAL_STARTER_PACK_VERSION }],
      }, true);
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
      return db.transaction(() => getCampaignDetailSync(db, actorPrincipalId, campaignId))();
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
      return getCampaignContentConfigurationSync(db, actorPrincipalId, campaignId);
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
      return listActorResourcesSync(db, actorPrincipalId, campaignId, actorId);
    },
    getActorResource: (actorPrincipalId, campaignId, actorId, name) => {
      assertOpen();
      return getActorResourceSync(db, actorPrincipalId, campaignId, actorId, name);
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
      return listRulesProfilesSync(db, actorPrincipalId);
    },
    getRulesProfile: (actorPrincipalId, identifier) => {
      assertOpen();
      return getRulesProfileSync(db, actorPrincipalId, identifier);
    },
    listContentPacks: (actorPrincipalId) => {
      assertOpen();
      return listContentPacksSync(db, actorPrincipalId);
    },
    getContentPack: (actorPrincipalId, identifier) => {
      assertOpen();
      return getContentPackSync(db, actorPrincipalId, identifier);
    },
    listContentPackDefinitions: (actorPrincipalId, identifier) => {
      assertOpen();
      return listContentPackDefinitionsSync(db, actorPrincipalId, identifier);
    },
    getContentPackDefinition: (actorPrincipalId, reference) => {
      assertOpen();
      return getContentPackDefinitionSync(db, actorPrincipalId, reference);
    },
    getCampaignRulesProfile: (actorPrincipalId, campaignId) => {
      assertOpen();
      return getCampaignRulesProfileSync(db, actorPrincipalId, campaignId);
    },
    listCampaignContentPacks: (actorPrincipalId, campaignId) => {
      assertOpen();
      return listCampaignContentPacksSync(db, actorPrincipalId, campaignId);
    },
    listCampaignContentPackDefinitions: (actorPrincipalId, campaignId, identifier) => {
      assertOpen();
      return listCampaignContentPackDefinitionsSync(db, actorPrincipalId, campaignId, identifier);
    },
    getCampaignContentPackDefinition: (actorPrincipalId, campaignId, reference) => {
      assertOpen();
      return getCampaignContentPackDefinitionSync(db, actorPrincipalId, campaignId, reference);
    },
    addCampaignMembership: (actorPrincipalId, campaignId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign membership addition cannot run inside a repository transaction");
      return db.transaction(() => {
        const normalized = addCampaignMembershipInputSchema.parse(input);
        const existed = db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
          .get(campaignId, normalized.principalId);
        const value = campaignCoreRepository.addCampaignMembership(actorPrincipalId, campaignId, normalized);
        if (!existed) campaignCoreRepository.writeCompatibilityAdministrationAudit(campaignId, actorPrincipalId, "membership_added",
          { principalId: value.principalId, role: value.role }, value, value.createdAt);
        return value;
      }).immediate();
    },
    createCampaign: (actorPrincipalId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign creation cannot run inside a repository transaction");
      return campaignCoreRepository.createCampaign(actorPrincipalId, input);
    },
    renameCampaign: (actorPrincipalId, campaignId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign rename cannot run inside a repository transaction");
      return db.transaction(() => {
        const value = campaignCoreRepository.renameCampaign(actorPrincipalId, campaignId, input);
        campaignCoreRepository.writeCompatibilityAdministrationAudit(campaignId, actorPrincipalId, "campaign_renamed",
          { name: value.name }, { name: value.name, updatedAt: value.updatedAt }, value.updatedAt);
        return value;
      }).immediate();
    },
    renameCampaignIfUnchanged: (actorPrincipalId, campaignId, input) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("stale-safe campaign rename cannot run inside a repository transaction");
      }
      return db.transaction(() => {
        const value = campaignCoreRepository.renameCampaignIfUnchanged(actorPrincipalId, campaignId, input);
        campaignCoreRepository.writeCompatibilityAdministrationAudit(campaignId, actorPrincipalId, "campaign_renamed",
          { name: value.name }, { name: value.name, updatedAt: value.updatedAt }, value.updatedAt);
        return value;
      }).immediate();
    },
    attachCampaignSession: (actorPrincipalId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign session attachment cannot run inside a repository transaction");
      return db.transaction(() => {
        const normalized = attachCampaignSessionInputSchema.parse(input);
        const existed = db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?")
          .get(normalized.campaignId, normalized.sessionId);
        const value = campaignCoreRepository.attachCampaignSession(actorPrincipalId, normalized);
        if (!existed) campaignCoreRepository.writeCompatibilityAdministrationAudit(normalized.campaignId, actorPrincipalId, "room_attached",
          { sessionId: value.sessionId }, value, value.attachedAt);
        return value;
      }).immediate();
    },
    detachCampaignSession: (actorPrincipalId, input) => {
      assertOpen();
      if (transactionDepth > 0) throw new Error("campaign session detachment cannot run inside a repository transaction");
      return db.transaction(() => {
        const normalized = detachCampaignSessionInputSchema.parse(input);
        const value = campaignCoreRepository.detachCampaignSession(actorPrincipalId, normalized);
        if (value) {
          const campaign = db.prepare("SELECT updated_at FROM campaigns WHERE id=?").get(normalized.campaignId) as { updated_at: string };
          campaignCoreRepository.writeCompatibilityAdministrationAudit(normalized.campaignId, actorPrincipalId, "room_detached",
            { sessionId: value.sessionId }, value, campaign.updated_at);
        }
        return value;
      }).immediate();
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
      return createCampaignCharacterSync(db, dependencies, actorPrincipalId, input).projection;
    },
    createOriginalStarterCampaignCharacter: (actorPrincipalId, input) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("original starter campaign character creation cannot run inside a repository transaction");
      }
      return createCampaignCharacterSync(db, dependencies, actorPrincipalId, input, true);
    },
    executeSetActorAttribute: (actorPrincipalId, envelope) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("set actor attribute command cannot run inside a repository transaction");
      }
      return executeSetActorAttributeSync(db, dependencies, actorPrincipalId, envelope);
    },
    executeInitializeActorResource: (actorPrincipalId, envelope) => {
      assertOpen();
      if (transactionDepth > 0) {
        throw new Error("initialize actor resource command cannot run inside a repository transaction");
      }
      return executeInitializeActorResourceSync(db, dependencies, actorPrincipalId, envelope);
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
