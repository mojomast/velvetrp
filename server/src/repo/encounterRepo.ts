import type DatabaseDriver from "better-sqlite3";
import {
  createEncounterReadRepository,
  type EncounterReadRepository,
} from "./encounter/encounterReadRepo.js";
import {
  createEncounterWriteRepository,
  type EncounterDependencies,
  type EncounterWriteRepository,
} from "./encounter/encounterWriteRepo.js";

export {
  EncounterAuthorizationError,
  EncounterConflictError,
  EncounterStaleError,
  EncounterTurnError,
  EncounterUnavailableError,
} from "./encounter/encounterErrors.js";
export type {
  EncounterDependencies,
  EncounterReceipt,
  EncounterResult,
} from "./encounter/encounterWriteRepo.js";

/** Public encounter facade composed from command handling and read projections. */
export interface EncounterRepository extends EncounterReadRepository, EncounterWriteRepository {}

/** Creates the public encounter facade while commands share the authoritative read projection. */
export function createEncounterRepository(
  db: DatabaseDriver.Database,
  deps: EncounterDependencies,
  guard: () => void,
): EncounterRepository {
  const reads = createEncounterReadRepository(db, deps);
  const writes = createEncounterWriteRepository(db, { ...deps, reads, assertFactoryMutation: guard });
  return { ...writes, ...reads };
}
