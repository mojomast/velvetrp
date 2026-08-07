import type DatabaseDriver from "better-sqlite3";
import { createWorldReadRepository, type WorldReadRepository } from "./world/worldReadRepo.js";
import { createWorldWriteRepository, type WorldDependencies, type WorldWriteRepository } from "./world/worldWriteRepo.js";

export { WorldAuthorizationError, WorldConflictError, WorldStaleError, WorldUnavailableError, type MutationReceipt, type WorldDependencies, type WorldReceipt } from "./world/worldWriteRepo.js";

/** Public world facade combining commands with principal-filtered projections. */
export interface WorldRepository extends WorldReadRepository, WorldWriteRepository {}

export function createWorldRepository(db:DatabaseDriver.Database,deps:WorldDependencies,guard:()=>void):WorldRepository {
  const reads=createWorldReadRepository(db,{guard});
  const writes=createWorldWriteRepository(db,{...deps,guard});
  return {...reads,...writes};
}
