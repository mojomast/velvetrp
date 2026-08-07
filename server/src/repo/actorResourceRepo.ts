import type DatabaseDriver from "better-sqlite3";
import {
  createActorResourceReadRepository,
  createActorResourceWriteRepository,
  type ActorResourceReadRepository,
  type ActorResourceWriteRepository,
  type M15Dependencies,
} from "./actorResource/index.js";

export {
  ActorResourceAuthorizationError,
  ActorResourceConflictError,
  ActorResourceNegativeError,
  ActorResourceStaleError,
  getM15ActorRevision,
  m15Authorized,
  runM15Mutation,
  type ActorResourceReadRepository,
  type ActorResourceSnapshot,
  type ActorResourceWriteRepository,
  type ActorScopedResourceChange,
  type M15ActorResource,
  type M15Dependencies,
  type M15Result,
} from "./actorResource/index.js";

/** Public actor-resource facade combining M1.5 projections and commands. */
export interface ActorResourceRepository extends ActorResourceReadRepository, ActorResourceWriteRepository {}

export function createActorResourceRepository(db:DatabaseDriver.Database,deps:M15Dependencies,assertMutation:()=>void):ActorResourceRepository {
  const reads=createActorResourceReadRepository(db);
  const writes=createActorResourceWriteRepository(db,deps,assertMutation,reads);
  return {...reads,...writes};
}
