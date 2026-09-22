/** Encounter repository composition boundary. */
export {
  EncounterAuthorizationError,
  EncounterConflictError,
  EncounterStaleError,
  EncounterTurnError,
  EncounterUnavailableError,
} from "./encounterErrors.js";
export {
  createEncounterReadRepository,
  type CombatInitiationCandidate,
  type EncounterReadDependencies,
  type EncounterCombatSnapshot,
  type CombatLogPage,
  type EncounterLifecycleSnapshot,
  type EncounterSetupCandidatesSnapshot,
  type EncounterReadRepository,
} from "./encounterReadRepo.js";
export {
  createEncounterWriteRepository,
  type EncounterDependencies,
  type EncounterReceipt,
  type EncounterResult,
  type EncounterRewardGrantSnapshot,
  type EncounterWriteDependencies,
  type EncounterWriteRepository,
} from "./encounterWriteRepo.js";
export {
  NPC_TIER_KEYWORDS,
  NPC_TIER_MATCH_ORDER,
  NpcCombatProfileError,
  TIER_TEMPLATES,
  deriveNpcTier,
  resolveNpcCombatProfile,
  type NpcCombatBaselineStats,
  type NpcCombatProfile,
  type NpcCombatProfileFailureCode,
  type NpcCombatTier,
  type NpcTierDerivation,
  type NpcTierTemplateEntry,
} from "./npcCombatProfile.js";
export {
  CombatInitiationError,
  combatInitiationTargetSchema,
  initiateCombatFromTarget,
  initiateCombatInputSchema,
  type CombatInitiationFailureCode,
  type CombatInitiationTarget,
  type InitiateCombatInput,
  type InitiateCombatResult,
} from "./initiateCombat.js";
export { buildUseConsumableLegalActions, executeUseConsumable, type UseConsumableBoundary } from "./useConsumableRuntime.js";
export { buildCombatPowerLegalActions, executeCombatPower, getCombatPowerResultByKey, type CombatPowerBoundary, type CombatPowerRequest, type CombatPowerResult } from "./combatPowerRuntime.js";
export { readReactionAvailability, resolveOpportunityAttacks, type OpportunityAttackDeps, type ReactionAvailability } from "./opportunityAttackRuntime.js";
