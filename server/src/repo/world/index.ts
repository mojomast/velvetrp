/** World repository composition boundary. */
export {
  createWorldReadRepository,
  type WorldReadContext,
  type WorldReadRepository,
  type WorldCampaignHttpSnapshot,
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
  type ActorTravelResult,
} from "./worldWriteRepo.js";
