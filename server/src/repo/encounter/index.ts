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
