// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type {
  CampaignCharacterWorkspaceResponse,
  CampaignPlayBootstrap,
  CampaignRoomLinkingResponse,
  ProgressionState,
  PublicCampaignCharacterSummary,
} from "@velvet/contracts";
import type { Clock, IdGenerator, RandomNumberGenerator } from "../../runtime.js";
import type {
  ActorResource,
  AddCampaignMembershipInput,
  AttachCampaignSessionInput,
  CampaignAccess,
  Campaign,
  CampaignCharacterCreationOptionsResponse,
  CampaignCharacterRead,
  CampaignContentConfiguration,
  CampaignDetail,
  CampaignMembership,
  CampaignMembershipRead,
  CampaignRenameRequest,
  CampaignSessionAttachment,
  CampaignTimeline,
  Character,
  CommandEnvelope,
  CommandReceipt,
  ConfigureCampaignContentInput,
  ConsentEvent,
  ContentPack,
  ContentPackIdentifier,
  CreateCampaignCharacterInput,
  CreateCampaignInput,
  CreateCharacterInput,
  DefinitionReference,
  DetachCampaignSessionInput,
  HarnessSettings,
  InstallContentPackInput,
  LoreEntry,
  NewLoreEntry,
  PrivilegedCampaignCharacterProjection,
  RenameCampaignInput,
  RpgDefinition,
  RpgEvent,
  RulesProfile,
  RulesProfileIdentifier,
  SceneState,
  Session,
  UpdateHarnessInput,
} from "../../types.js";
import type { ActorResourceRepository } from "../actorResourceRepo.js";
import type { AdventureTurnRepository } from "../adventureTurnRepo.js";
import type { CampaignAdministrationRepository } from "../campaignAdministrationRepo.js";
import type { CharacterBuilderRepository } from "../characterBuilderRepo.js";
import type { CharacterProgressionRepository } from "../characterProgressionRepo.js";
import type { CheckRepository } from "../checkRepo.js";
import type { ContentCatalogRepository } from "../contentCatalogRepo.js";
import type { CampaignDiceEvent, CampaignDiceVisibleCharacterBinding } from "../diceRepo.js";
import type { EconomyRepository } from "../economyRepo.js";
import type { EffectRepository } from "../effectRepo.js";
import type { EncounterRepository } from "../encounterRepo.js";
import type { InventoryRepository } from "../inventoryRepo.js";
import type { PowerRepository } from "../powerRepo.js";
import type { QuestRepository } from "../questRepo.js";
import type { StoryRepository } from "../storyRepo.js";
import type { RestRepository } from "../restRepo.js";
import type { WorldRepository } from "../worldRepo.js";

export interface RepositoryDependencies {
  clock: Clock;
  ids: IdGenerator;
  rng: RandomNumberGenerator;
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
    input: import("../contentCatalogRepo.js").ContentCatalogPublicationPageInput,
  ): import("../contentCatalogRepo.js").ContentCatalogPublicationPage;
  getContentCatalogForOwner(actorPrincipalId: string, packId: string, packVersion: string): import("@velvet/contracts").OwnerCatalogProjection | null;
  getCampaignContentCatalog(actorPrincipalId: string, campaignId: string, packId: string, packVersion: string):
    import("@velvet/contracts").GmCatalogProjection | import("@velvet/contracts").PlayerCatalogProjection | import("@velvet/contracts").ObserverCatalogProjection | null;
  resolveCampaignCatalog(actorPrincipalId: string, campaignId: string): import("@velvet/contracts").CampaignCatalogResolutionReport | null;
  getCampaignCatalogReceipt(actorPrincipalId: string, campaignId: string, commandId: string): import("@velvet/contracts").CampaignCatalogReceipt | null;
  listCampaigns(actorPrincipalId: string): CampaignAccess[];
  getCampaign(actorPrincipalId: string, campaignId: string): CampaignAccess | null;
  getCampaignDetail(actorPrincipalId: string, campaignId: string): CampaignDetail | null;
  listCampaignTimelines(actorPrincipalId: string, campaignId: string): CampaignTimeline[];
  getCampaignTimeline(actorPrincipalId: string, campaignId: string, timelineId: string): CampaignTimeline | null;
  listCampaignMemberships(actorPrincipalId: string, campaignId: string): CampaignMembershipRead[];
  getCampaignMembership(actorPrincipalId: string, campaignId: string, principalId: string): CampaignMembershipRead | null;
  listCampaignSessionAttachments(actorPrincipalId: string, campaignId: string): CampaignSessionAttachment[];
  getCampaignSessionAttachment(actorPrincipalId: string, campaignId: string, sessionId: string): CampaignSessionAttachment | null;
  getCampaignPlayBootstrap(actorPrincipalId: string, campaignId: string, sessionId: string): CampaignPlayBootstrap | null;
  getCampaignRoomLinkingSnapshot(actorPrincipalId: string, campaignId: string): CampaignRoomLinkingSnapshot | null;
  getCampaignContentConfiguration(actorPrincipalId: string, campaignId: string): CampaignContentConfiguration | null;
  getCampaignCharacterCreationOptions(actorPrincipalId: string, campaignId: string): CampaignCharacterCreationOptionsResponse | null;
  getCampaignCharacterRoster(actorPrincipalId: string, campaignId: string): CampaignCharacterRosterSnapshot | null;
  getCampaignCharacterWorkspace(actorPrincipalId: string, campaignId: string, campaignCharacterId: string): CampaignCharacterWorkspaceSnapshot | null;
  getCampaignCharacterSheetSnapshot(actorPrincipalId: string, campaignId: string, campaignCharacterId: string): CampaignCharacterSheetSnapshot | null;
  listActorResources(actorPrincipalId: string, campaignId: string, actorId: string): ActorResource[];
  getActorResource(actorPrincipalId: string, campaignId: string, actorId: string, name: string): ActorResource | null;
  listCampaignEvents(actorPrincipalId: string, campaignId: string, timelineId: string): RpgEvent[];
  listPublicCampaignEvents(actorPrincipalId: string, campaignId: string, timelineId: string, afterRevision: number, limit: number): CampaignEventPage;
  listRecentCampaignDiceEvents(actorPrincipalId: string, campaignId: string, timelineId: string): CampaignDiceEvent[];
  getCommandReceipt(actorPrincipalId: string, campaignId: string, commandId: string): CommandReceipt | null;
  listCampaignCharacters(actorPrincipalId: string, campaignId: string): CampaignCharacterRead[];
  getCampaignCharacter(actorPrincipalId: string, campaignId: string, campaignCharacterId: string): CampaignCharacterRead | null;
  getCampaignCharacterByActorId(actorPrincipalId: string, campaignId: string, actorId: string): CampaignCharacterRead | null;
  listRulesProfiles(actorPrincipalId: string): RulesProfile[];
  getRulesProfile(actorPrincipalId: string, identifier: RulesProfileIdentifier): RulesProfile | null;
  listContentPacks(actorPrincipalId: string): ContentPack[];
  getContentPack(actorPrincipalId: string, identifier: ContentPackIdentifier): ContentPack | null;
  listContentPackDefinitions(actorPrincipalId: string, identifier: ContentPackIdentifier): RpgDefinition[];
  getContentPackDefinition(actorPrincipalId: string, reference: DefinitionReference): RpgDefinition | null;
  getCampaignRulesProfile(actorPrincipalId: string, campaignId: string): RulesProfile | null;
  listCampaignContentPacks(actorPrincipalId: string, campaignId: string): ContentPack[];
  listCampaignContentPackDefinitions(actorPrincipalId: string, campaignId: string, identifier: ContentPackIdentifier): RpgDefinition[];
  getCampaignContentPackDefinition(actorPrincipalId: string, campaignId: string, reference: DefinitionReference): RpgDefinition | null;
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

export interface Repository extends RepositoryUnitOfWork, CampaignAdministrationRepository, ContentCatalogRepository, CharacterBuilderRepository, CharacterProgressionRepository, ActorResourceRepository, InventoryRepository, EconomyRepository, RestRepository, CheckRepository, PowerRepository, EffectRepository, EncounterRepository, WorldRepository, QuestRepository, StoryRepository, AdventureTurnRepository {
  /** Explicit built-in setup path; no caller-supplied catalog data or identity. */
  installMechanicsStarterCatalog(actorPrincipalId: string): import("@velvet/contracts").OwnerCatalogProjection;
  configureMechanicsStarterCatalog(actorPrincipalId: string, campaignId: string, input: { expectedRevision: number; idempotencyKey: string }): import("@velvet/contracts").CampaignCatalogConfigurationResult;
  /** Specialized trusted-local snapshot; it accepts no caller-supplied content identities. */
  inspectOriginalStarterSetup(actorPrincipalId: string, campaignId: string): OriginalStarterSetupInspection;
  /** Specialized setup write; manifest identity and content are fixed by the repository. */
  installOriginalStarterContent(actorPrincipalId: string, campaignId: string): ContentPack;
  /** Specialized setup write; profile and pack selection are fixed by the repository. */
  configureOriginalStarterContent(actorPrincipalId: string, campaignId: string): CampaignContentConfiguration;
  addCampaignMembership(actorPrincipalId: string, campaignId: string, input: AddCampaignMembershipInput): CampaignMembership;
  attachCampaignSession(actorPrincipalId: string, input: AttachCampaignSessionInput): CampaignSessionAttachment;
  detachCampaignSession(actorPrincipalId: string, input: DetachCampaignSessionInput): CampaignSessionAttachment | null;
  installContentPack(actorPrincipalId: string, input: InstallContentPackInput): ContentPack;
  configureCampaignContent(actorPrincipalId: string, campaignId: string, input: ConfigureCampaignContentInput): CampaignContentConfiguration;
  createCampaignCharacter(actorPrincipalId: string, input: CreateCampaignCharacterInput): PrivilegedCampaignCharacterProjection;
  /** Factory-only fixed-content creation; never exposed on a unit of work or legacy wrapper. */
  createOriginalStarterCampaignCharacter(actorPrincipalId: string, input: CreateCampaignCharacterInput): OriginalStarterCampaignCharacterCreationResult;
  executeInitializeActorResource(actorPrincipalId: string, envelope: CommandEnvelope): CommandReceipt;
  executeRollActorDice(actorPrincipalId: string, envelope: CommandEnvelope): CommandReceipt;
  /** Factory-only locked revalidation for the ID-free campaign-dice boundary. */
  executeRollActorDiceForVisibleCharacter(actorPrincipalId: string, envelope: CommandEnvelope, binding: CampaignDiceVisibleCharacterBinding): CommandReceipt;
  executeSetActorAttribute(actorPrincipalId: string, envelope: CommandEnvelope): CommandReceipt;
  createCampaign(actorPrincipalId: string, input: CreateCampaignInput): Campaign;
  renameCampaign(actorPrincipalId: string, campaignId: string, input: RenameCampaignInput): Campaign;
  renameCampaignIfUnchanged(actorPrincipalId: string, campaignId: string, input: CampaignRenameRequest): Campaign;
  createCharacter(input: CreateCharacterInput): Character;
  createLoreEntry(input: NewLoreEntry): LoreEntry;
  updateHarnessSettings(patch: UpdateHarnessInput): HarnessSettings;
  updateSessionContextSource(sessionId: string, sourceOfTruth: string): { sourceOfTruth: string; updatedAt: string };
  transaction<T>(callback: SynchronousCallback<T>): T;
  stopSession(id: string, reason: string): Session | null;
  close(): void;
}
