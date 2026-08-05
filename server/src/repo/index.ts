// Public repository surface. Domain implementations are extracted gradually
// while the compatibility barrel preserves the established API.
export * from "./db.js";
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
export * from "./campaignRepo.js";
export { createDiceRepository, type DiceRepository } from "./diceRepo.js";
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
