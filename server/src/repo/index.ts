// Preserve the established repository API without exposing domain-internal
// helpers from the split implementation modules.
export { closeRepo } from "./db.js";
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
