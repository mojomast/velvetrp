// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type { Clock, IdGenerator, RandomNumberGenerator } from "../../runtime.js";

export interface RepositoryDependencies {
  clock: Clock;
  ids: IdGenerator;
  rng: RandomNumberGenerator;
}

export interface CreateRepositoryOptions extends Partial<RepositoryDependencies> {
  dataDir?: string;
}
