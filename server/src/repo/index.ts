// Preserve the established repository API without exposing domain-internal
// helpers from the split implementation modules.
export { closeRepo } from "./db.js";
export {
  CampaignAdministrationConflictError,
  CampaignAdministrationForbiddenError,
  CampaignAdministrationStaleError,
  type CampaignAdministrationRepository,
} from "./campaignAdministrationRepo.js";
export {
  calculateCatalogDigest,
  canonicalCatalogJson,
  ContentCatalogAuthorizationError,
  ContentCatalogConflictError,
  ContentCatalogStaleError,
  ContentCatalogValidationError,
  validateContentCatalog,
  type ContentCatalogRepository,
} from "./contentCatalogRepo.js";
export {
  CharacterBuilderAuthorizationError,
  CharacterBuilderConflictError,
  CharacterBuilderExpiredError,
  CharacterBuilderIncompleteError,
  CharacterBuilderStaleError,
  CharacterBuilderUnavailableError,
  rollCharacterBuilderAttributes,
  type CharacterBuilderRepository,
} from "./characterBuilderRepo.js";
export {
  CharacterProgressionAuthorizationError, CharacterProgressionConflictError, CharacterProgressionStaleError,
  CharacterProgressionUnavailableError, type CharacterProgressionRepository,
} from "./characterProgressionRepo.js";
export { calculateCharacterDerivedStats } from "../characterBuilderCalculator.js";
export {
  MECHANICS_STARTER_CATALOG,
  MECHANICS_STARTER_ID,
  MECHANICS_STARTER_PACK_ID,
  MECHANICS_STARTER_PACK_VERSION,
  MECHANICS_STARTER_PRIOR_CATALOG,
  MECHANICS_STARTER_PRIOR_PACK_VERSION,
  MECHANICS_STARTER_RULES_PROFILE_ID,
} from "../content/mechanicsStarterCatalog.js";
export { calculateCharacterProgression } from "../characterProgressionCalculator.js";
export { ActorResourceAuthorizationError, ActorResourceConflictError, ActorResourceNegativeError, ActorResourceStaleError, type ActorResourceRepository } from "./actorResourceRepo.js";
export { InventoryAuthorizationError, InventoryBindingError, InventoryCapacityError, InventorySlotConflictError, InventoryStaleError, type InventoryRepository } from "./inventoryRepo.js";
export { EconomyAuthorizationError, EconomyConflictError, QuoteExpiredError, ShopStockExhaustedError, TradeStaleError, type EconomyRepository } from "./economyRepo.js";
export { RestAuthorizationError, RestIllegalStateError, RestStaleError, type RestRepository } from "./restRepo.js";
export { CheckUnavailableError, type CheckRepository } from "./checkRepo.js";
export { PowerUnavailableError, PowerInsufficientResourceError, type PowerRepository } from "./powerRepo.js";
export { M16AuthorizationError, M16StaleError, M16ConflictError, EffectUnavailableError, EffectImmuneError, type EffectRepository } from "./effectRepo.js";
export {
  createCharacter,
  deleteCharacter,
  getCharacter,
  listCharacters,
  updateCharacter,
} from "./characterRepo.js";
export {
  getHarnessSettings,
  getProviderSettings,
  getPublicProviderSettings,
  updateHarnessSettings,
  updateProviderSettings,
} from "./settingsRepo.js";
export {
  addConsentEvent,
  createSession,
  deleteSession,
  getSession,
  getSessionContextSource,
  listSessions,
  stopSession,
  transitionSession,
  updateSessionContextSource,
  updateSessionSynthesizedSource,
} from "./sessionRepo.js";
export {
  addMessage,
  getActiveLeaf,
  getMessage,
  getUsageSummary,
  listBranchChildren,
  listBranchMessages,
  listMessages,
  nextSwipeIndex,
  recordUsageEvent,
  setActiveBranch,
} from "./messageRepo.js";
export {
  CampaignCharacterCreationConflictError,
  CampaignCharacterCreationUnavailableError,
  CampaignCharacterPersonaUnavailableError,
  CampaignContentConfigurationAuthorizationError,
  CampaignContentConfigurationConflictError,
  CampaignCreationAuthorizationError,
  CampaignCreationIdCollisionError,
  CampaignDiceCharacterConflict,
  CampaignRenameStaleError,
  CampaignRenameUnavailableError,
  CampaignSessionAttachmentConflictError,
  CampaignSessionAttachmentSessionMissingError,
  CampaignSessionAttachmentUnavailableError,
  ContentPackInstallationAuthorizationError,
  ContentPackInstallationConflictError,
  createRepository,
  type CampaignCharacterRosterSnapshot,
  type CampaignCharacterWorkspaceSnapshot,
  type CampaignDiceEvent,
  type CampaignDiceVisibleCharacterBinding,
  type CampaignRoomLinkingSnapshot,
  type CreateRepositoryOptions,
  type OriginalStarterCampaignCharacterCreationResult,
  type OriginalStarterSetupInspection,
  type Repository,
  type RepositoryDependencies,
  type RepositoryUnitOfWork,
} from "./campaignRepo.js";
export {
  addMemoryFacts,
  forgetMemory,
  getMemory,
  listAllMemories,
  listApprovedMemories,
  restoreMemory,
  setMemoryApproval,
  updateMemory,
} from "./memoryRepo.js";
export {
  createLoreEntry,
  deleteLoreEntry,
  getLoreEntry,
  listLoreEntries,
  updateLoreEntry,
} from "./loreRepo.js";
export {
  deleteSummary,
  getSummary,
  upsertSummary,
} from "./summaryRepo.js";
