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
  type EncounterLifecycleSnapshot,
  type EncounterReadRepository,
} from "./encounterReadRepo.js";
export {
  createEncounterWriteRepository,
  type EncounterDependencies,
  type EncounterReceipt,
  type EncounterResult,
  type EncounterWriteDependencies,
  type EncounterWriteRepository,
} from "./encounterWriteRepo.js";
