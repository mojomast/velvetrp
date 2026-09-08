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
export { buildUseConsumableLegalActions, executeUseConsumable, type UseConsumableBoundary } from "./useConsumableRuntime.js";
export { buildCombatPowerLegalActions, executeCombatPower, getCombatPowerResultByKey, type CombatPowerBoundary, type CombatPowerRequest, type CombatPowerResult } from "./combatPowerRuntime.js";
export { readReactionAvailability, resolveOpportunityAttacks, type OpportunityAttackDeps, type ReactionAvailability } from "./opportunityAttackRuntime.js";
