/** World repository composition boundary. */
export {
  createWorldReadRepository,
  type WorldReadContext,
  type WorldReadRepository,
  type WorldCampaignHttpSnapshot,
  type CampaignNpcsSnapshot,
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
  type CreateNpcResult,
  type NpcRelationshipResult,
} from "./worldWriteRepo.js";
