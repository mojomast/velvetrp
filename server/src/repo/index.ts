export { CampaignDmConflictError, CampaignDmUnavailableError, type CampaignDmRepository } from "./campaignDmRepo.js";
export { CampaignDmReadinessUnavailableError, type CampaignDmReadinessRepository } from "./campaignDmReadinessRepo.js";
export {
  CampaignContextInspectionUnavailableError,
  createCampaignContextInspectionReadRepository,
  type CampaignContextInspectionReadRepository,
} from "./campaign/campaignContextInspectionReadRepo.js";
export {
  AgentObservationConflictError,
  AgentObservationUnavailableError,
  createAgentObservationRepository,
  type AgentObservation,
  type AgentObservationInput,
  type AgentObservationRepository,
} from "./observations/agentObservationRepo.js";
export {
  MAX_FACTION_WITNESS_FANOUT,
  MAX_GOSSIP_FANOUT,
  MAX_GOSSIP_PER_NPC,
  MAX_GOSSIP_SOURCE_ITEMS,
  MAX_HOP_COUNT,
  MAX_OBSERVATIONS_PER_AGENT,
  MAX_TELL_FANOUT,
  MAX_TELL_PER_ARRIVAL,
  MAX_WITNESS_FANOUT,
  TOWN_GOSSIP_AGENT_ID,
  gossipSampleIncluded,
  propagateFactionWitnessObservations,
  propagateGossipToPresentNpcs,
  propagateToldOnArrival,
  propagateTownGossipObservations,
  propagateWitnessObservations,
  type GossipSampleInput,
  type PropagationDependencies,
  type ToldOnArrivalInput,
  type WitnessObservationInput,
} from "./observations/agentObservationPropagation.js";
export {
  DEFAULT_AGENT_KNOWLEDGE_LIMIT,
  MAX_AGENT_KNOWLEDGE_LIMIT,
  MAX_KNOWLEDGE_QUERY_TERMS,
  NPC_DISCLOSURE_TRUST_THRESHOLD,
  createAgentObservationReadRepository,
  type AgentKnowledgeEntry,
  type AgentKnowledgeQuery,
  type AgentObservationReadRepository,
} from "./observations/agentObservationReadRepo.js";
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
  ContentCatalogAuthorizationError,
  ContentCatalogConflictError,
  ContentCatalogStaleError,
  ContentCatalogValidationError,
  calculateCatalogDigest,
  canonicalCatalogJson,
  type ContentCatalogRepository,
  validateContentCatalog,
} from "./contentCatalog/index.js";
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
export { SRD_5_1_STARTER_CATALOG } from "../content/srdStarterCatalog.js";
export { calculateCharacterProgression } from "../characterProgressionCalculator.js";
export {
  createActorGameplaySheetReadRepository,
  type ActorGameplaySheetReadRepository,
} from "./campaign/actorGameplaySheetReadRepo.js";
export { ActorResourceAuthorizationError, ActorResourceConflictError, ActorResourceNegativeError, ActorResourceStaleError, type ActorResourceRepository } from "./actorResourceRepo.js";
export { InventoryAuthorizationError, InventoryBindingError, InventoryCapacityError, InventorySlotConflictError, InventoryStaleError, type InventoryRepository } from "./inventoryRepo.js";
export { EconomyAuthorizationError, EconomyConflictError, QuoteExpiredError, ShopStockExhaustedError, TradeStaleError, type EconomyRepository } from "./economyRepo.js";
export { RestAuthorizationError, RestIllegalStateError, RestStaleError, type RestRepository } from "./restRepo.js";
export { createAttunementRepository, type AttunementRepository, type AttunementDependencies,
  type ActorAttunementSnapshot, type AttunementEntryView, type AttunementOutcome } from "./attunementRepo.js";
export { ActorCheckNotFoundError, CheckUnavailableError, type CheckRepository } from "./checkRepo.js";
export { createAdventureCheckRepository, type AdventureCheckRepository, type AdventureCheckPublicReceipt,
  type ProviderSafeAdventureCheckCandidate } from "./adventureCheckRepo.js";
export { createAdventureInventoryRepository, type AdventureInventoryRepository } from "./adventureInventoryRepo.js";
export { createAdventureCommerceRepository, type AdventureCommerceRepository, type VendorShopAssociation } from "./adventureCommerceRepo.js";
export { CampaignIntegrationConflictError, CampaignIntegrationForbiddenError, CampaignIntegrationStaleError,
  CampaignIntegrationUnavailableError, type CampaignAdministrationIntegrationRepository } from "./campaignAdministrationIntegrationRepo.js";
export { createAdventurePowerRestRepository, type AdventurePowerRestRepository } from "./adventurePowerRestRepo.js";
export { createAdventureQuestProgressionRepository, type AdventureQuestProgressionRepository } from "./adventureQuestProgressionRepo.js";
export { PowerUnavailableError, PowerInsufficientResourceError, ActorPowerNotFoundError, ActorPowerConflictError, ActorPowerInsufficientError, type ActorPowerSnapshot, type PowerRepository } from "./powerRepo.js";
export { createSpellcastingRepository, SpellcastingUnavailableError, SpellcastingComponentError, SpellcastingRangeError, type SpellcastingRepository, type SpellcastingRepositoryOptions } from "./spellcastingRepo.js";
export { M16AuthorizationError, M16StaleError, M16ConflictError, EffectUnavailableError, EffectImmuneError, type ActorEffectSnapshot, type EffectRepository } from "./effectRepo.js";
export { EncounterAuthorizationError, EncounterStaleError, EncounterConflictError, EncounterUnavailableError, EncounterTurnError, type EncounterRepository } from "./encounterRepo.js";
export { TacticalMapAuthorizationError, TacticalMapUnavailableError, TacticalMapStaleError, TacticalMapConflictError, type TacticalMapRepository } from "./tacticalMapRepo.js";
export { ensureCombatTacticalMap, inferCombatMapKind, combatMapSeed, type EnsureCombatTacticalMapDependencies,
  type EnsureCombatTacticalMapContext, type EnsureCombatTacticalMapInput, type EnsureCombatTacticalMapResult } from "./combatTacticalMap.js";
export { WorldAuthorizationError, WorldStaleError, WorldConflictError, WorldUnavailableError, type WorldRepository } from "./worldRepo.js";
export {
  MAX_FREEFORM_DESTINATION_LENGTH,
  FreeformTravelAuthorizationError,
  FreeformTravelConflictError,
  FreeformTravelUnavailableError,
  classifyFreeformTravel,
  createFreeformTravelRepository,
  parseFreeformTravelDestination,
  type FreeformTravelCandidate,
  type FreeformTravelClassification,
  type FreeformTravelLocationContext,
  type FreeformTravelMaterialization,
  type FreeformTravelRepository,
} from "./freeform/freeformTravelRepo.js";
export {
  MAX_FREEFORM_NPC_NAME_LENGTH,
  FREEFORM_NPC_ARCHETYPES,
  FreeformNpcAuthorizationError,
  FreeformNpcConflictError,
  FreeformNpcUnavailableError,
  classifyFreeformNpc,
  createFreeformNpcRepository,
  parseFreeformNpcAddress,
  selectFreeformNpcArchetype,
  type FreeformNpcArchetypeTemplate,
  type FreeformNpcCandidate,
  type FreeformNpcClassification,
  type FreeformNpcLocationContext,
  type FreeformNpcMaterialization,
  type FreeformNpcRepository,
} from "./freeform/freeformNpcRepo.js";
export {
  MAX_FREEFORM_LORE_SUBJECT_LENGTH,
  FREEFORM_LORE_TEMPLATES,
  FreeformLoreAuthorizationError,
  FreeformLoreConflictError,
  FreeformLoreUnavailableError,
  classifyFreeformLore,
  createFreeformLoreRepository,
  parseFreeformLoreSubject,
  selectFreeformLoreTemplate,
  type FreeformLoreCandidate,
  type FreeformLoreClassification,
  type FreeformLoreLocationContext,
  type FreeformLoreMaterialization,
  type FreeformLoreMaterializedCandidate,
  type FreeformLoreNoneReason,
  type FreeformLoreRepository,
  type FreeformLoreTemplate,
} from "./freeform/freeformLoreRepo.js";
export {
  MAX_FREEFORM_QUEST_LEAD_LENGTH,
  MAX_FREEFORM_QUEST_OBJECTIVES,
  FREEFORM_QUEST_TEMPLATES,
  FreeformQuestAuthorizationError,
  FreeformQuestConflictError,
  FreeformQuestUnavailableError,
  classifyFreeformQuest,
  createFreeformQuestRepository,
  parseFreeformQuestLead,
  selectFreeformQuestTemplate,
  type FreeformQuestCandidate,
  type FreeformQuestClassification,
  type FreeformQuestLocationContext,
  type FreeformQuestMaterialization,
  type FreeformQuestMaterializedCandidate,
  type FreeformQuestNoneReason,
  type FreeformQuestObjective,
  type FreeformQuestRepository,
  type FreeformQuestReward,
  type FreeformQuestTemplate,
} from "./freeform/freeformQuestRepo.js";
export {
  MAX_FREEFORM_RUMOR_SUBJECT_LENGTH,
  FREEFORM_RUMOR_TEMPLATES,
  FreeformRumorAuthorizationError,
  FreeformRumorConflictError,
  FreeformRumorUnavailableError,
  classifyFreeformRumor,
  createFreeformRumorRepository,
  deriveFreeformRumorSubject,
  parseFreeformRumorDeclaration,
  selectFreeformRumorTemplate,
  type FreeformRumorCandidate,
  type FreeformRumorClassification,
  type FreeformRumorDeclaration,
  type FreeformRumorLocationContext,
  type FreeformRumorMaterialization,
  type FreeformRumorMaterializedCandidate,
  type FreeformRumorNoneReason,
  type FreeformRumorRepository,
  type FreeformRumorTemplate,
} from "./freeform/freeformRumorRepo.js";
export {
  MAX_FREEFORM_SHOP_ITEMS,
  MIN_FREEFORM_SHOP_QUANTITY,
  MAX_FREEFORM_SHOP_QUANTITY,
  FreeformShopAuthorizationError,
  FreeformShopConflictError,
  FreeformShopUnavailableError,
  classifyFreeformShop,
  createFreeformShopRepository,
  freeformShopId,
  freeformShopName,
  freeformShopQuantity,
  freeformShopStockId,
  type FreeformShopCandidate,
  type FreeformShopClassification,
  type FreeformShopItemContext,
  type FreeformShopItemReference,
  type FreeformShopMaterialization,
  type FreeformShopMaterializedCandidate,
  type FreeformShopMerchantContext,
  type FreeformShopNoneReason,
  type FreeformShopRepository,
  type FreeformShopStockLine,
} from "./freeform/freeformShopRepo.js";
export {
  MAX_FREEFORM_ENCOUNTER_ENEMIES,
  MIN_FREEFORM_ENCOUNTER_ENEMIES,
  FreeformEncounterAuthorizationError,
  FreeformEncounterConflictError,
  FreeformEncounterUnavailableError,
  classifyFreeformEncounter,
  createFreeformEncounterRepository,
  deriveFreeformEncounterIntensity,
  isFreeformEncounterProvocation,
  type FreeformEncounterCandidate,
  type FreeformEncounterClassification,
  type FreeformEncounterEnemyReference,
  type FreeformEncounterEnemyTemplate,
  type FreeformEncounterIntensity,
  type FreeformEncounterMaterialization,
  type FreeformEncounterMaterializedCandidate,
  type FreeformEncounterNoneReason,
  type FreeformEncounterPorts,
  type FreeformEncounterRepository,
} from "./freeform/freeformEncounterRepo.js";
export {
  MAX_FREEFORM_FACTION_NAME_LENGTH,
  FREEFORM_FACTION_ARCHETYPES,
  FreeformFactionAuthorizationError,
  FreeformFactionConflictError,
  FreeformFactionUnavailableError,
  classifyFreeformFaction,
  createFreeformFactionRepository,
  hasFactionKeyword,
  parseFreeformFactionReference,
  selectFreeformFactionArchetype,
  type FreeformFactionCandidate,
  type FreeformFactionClassification,
  type FreeformFactionMaterialization,
  type FreeformFactionMaterializedCandidate,
  type FreeformFactionNoneReason,
  type FreeformFactionParseReason,
  type FreeformFactionRepository,
  type FreeformFactionTemplate,
} from "./freeform/freeformFactionRepo.js";
export { createEncounterPlanningService, type EncounterPlanningService, type EncounterPlanningDependencies,
  type EncounterCatalogDefinition, type EncounterCandidate, type EncounterPlanningDifficulty,
  type CampaignEncounterRequest, type CampaignEncounterPlan } from "./dm/encounterPlanning.js";
export {
  CampaignStartingLocationAuthorizationError,
  CampaignStartingLocationConflictError,
  CampaignStartingLocationStaleError,
  CampaignStartingLocationUnavailableError,
  type CampaignStartingLocationRepository,
} from "./campaignStartingLocationRepo.js";
export {
  CompanionAuthorizationError,
  CompanionConflictError,
  CompanionStaleError,
  CompanionUnavailableError,
  type CompanionReadRepository,
  type CompanionRepository,
} from "./companionRepo.js";
export {
  getQuest, getStoryline, listClues, listObjectiveCompletions, listQuests, listRewards, listStorylines,
  type CreateQuestInput, type CreateRewardInput, type CreateStorylineInput,
  type Quest, type QuestClue, type QuestObjectiveCompletion, type QuestReward, type Storyline,
  QuestAuthorizationError, QuestConflictError, QuestDomainUnavailableError, QuestStaleError,
  type AdventureQuestNarrationReceipt, type AdventureQuestObjectiveCandidate, type AdventureQuestPublicReceipt,
  type CampaignQuestSnapshot, type QuestMutationResult,
} from "./questRepo.js";
export {
  StoryAuthorizationError, StoryConflictError, StoryStaleError, StoryUnavailableError,
  type StoryMutationResult, type StoryRepository,
} from "./storyRepo.js";
export * from "./adventureTurnRepo.js";
export * from "./candidateRepo/index.js";
export * from "./systemOneDecisionRepo.js";
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
  getPublicSystemOneSettings,
  getSystemOneSettings,
  readSystemOne,
  updateHarnessSettings,
  updateProviderSettings,
  updateSystemOneSettings,
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
  createRepository,
  type CreateRepositoryOptions,
} from "./campaignRepositoryOrchestration.js";
export type {
  CampaignCharacterRosterSnapshot,
  CampaignCharacterSheetSnapshot,
  CampaignCharacterWorkspaceSnapshot,
  CampaignEventPage,
  CampaignRoomLinkingSnapshot,
  CampaignPlayReadRepository,
  CampaignAgentContextReadRepository,
  OriginalStarterCampaignCharacterCreationResult,
  OriginalStarterSetupInspection,
  Repository,
  RepositoryDependencies,
  RepositoryUnitOfWork,
} from "./campaign/index.js";
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
} from "./campaign/index.js";
export {
  CampaignDiceCharacterConflict,
  type CampaignDiceEvent,
  type CampaignDiceVisibleCharacterBinding,
} from "./diceRepo.js";
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
