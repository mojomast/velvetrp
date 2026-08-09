import type DatabaseDriver from "better-sqlite3";
import type { Clock, IdGenerator } from "../runtime.js";
import { createAdventureTurnReadRepository, createAdventureTurnWriteRepository,
  type AdventureTurnReadRepository, type AdventureTurnWriteRepository } from "./adventureTurn/index.js";

export * from "./adventureTurn/index.js";

/** Complete read/write adventure-turn and generation-draft repository. */
export interface AdventureTurnRepository extends AdventureTurnReadRepository, AdventureTurnWriteRepository {}

/** Creates the composed M1.10 repository facade. */
export function createAdventureTurnRepository(db: DatabaseDriver.Database, dependencies: { clock: Clock; ids: IdGenerator }, guard: () => void): AdventureTurnRepository {
  const reads = createAdventureTurnReadRepository(db);
  return { ...reads, ...createAdventureTurnWriteRepository(db, { ...dependencies, guard }, reads) };
}
