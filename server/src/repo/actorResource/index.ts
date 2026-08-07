/** Actor-resource repository composition boundary and shared M1.5 protocol. */
export {
  ActorResourceAuthorizationError,
  ActorResourceConflictError,
  ActorResourceNegativeError,
  ActorResourceStaleError,
  getM15ActorRevision,
  m15Authorized,
  runM15Mutation,
  type ActorResourceSnapshot,
  type ActorScopedResourceChange,
  type M15ActorResource,
  type M15Dependencies,
  type M15Result,
} from "./m15Protocol.js";
export { createActorResourceReadRepository, type ActorResourceReadRepository } from "./actorResourceReadRepo.js";
export { createActorResourceWriteRepository, type ActorResourceWriteRepository } from "./actorResourceWriteRepo.js";
