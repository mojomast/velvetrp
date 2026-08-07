/** World repository composition boundary. */
export {
  createWorldReadRepository,
  type WorldReadContext,
  type WorldReadRepository,
} from "./worldReadRepo.js";
export {
  createWorldWriteRepository,
  WorldAuthorizationError,
  WorldConflictError,
  WorldStaleError,
  WorldUnavailableError,
  type MutationReceipt,
  type WorldDependencies,
  type WorldReceipt,
  type WorldWriteContext,
  type WorldWriteRepository,
} from "./worldWriteRepo.js";
