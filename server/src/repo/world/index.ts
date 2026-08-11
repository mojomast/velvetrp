/** World repository composition boundary. */
export {
  createWorldReadRepository,
  type WorldReadContext,
  type WorldReadRepository,
  type WorldCampaignHttpSnapshot,
  type CampaignNpcsSnapshot,
  type CampaignFactionsSnapshot,
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
  type CreateFactionResult,
  type FactionReputationResult,
} from "./worldWriteRepo.js";
export {
  createNpcPresenceRepository,
  type NpcPresenceRepository,
} from "./npcPresenceRepo.js";
