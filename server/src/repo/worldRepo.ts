import type DatabaseDriver from "better-sqlite3";
import { createActorJourneyRepository, type ActorJourneyRepository } from "./world/actorJourneyRepo.js";
import type { RandomNumberGenerator } from "../runtime.js";
import {
  createNpcPresenceRepository,
  createWorldReadRepository,
  createWorldWriteRepository,
  type NpcPresenceRepository,
  type WorldDependencies,
  type WorldReadRepository,
  type WorldWriteRepository,
} from "./world/index.js";

export {
  WorldAuthorizationError,
  WorldConflictError,
  WorldStaleError,
  WorldUnavailableError,
  type MutationReceipt,
  type WorldDependencies,
  type WorldReceipt,
  type WorldCampaignHttpSnapshot,
  type ActorTravelResult,
  type ActorCampResult,
  type CampaignNpcsSnapshot,
  type CreateNpcResult,
  type NpcRelationshipResult,
  type CampaignFactionsSnapshot,
  type CreateFactionResult,
  type FactionReputationResult,
  type FactionReactionResult,
  type SetFactionRelationResult,
  type ActorFactionMembershipResult,
  type NpcFactionMembershipResult,
} from "./world/index.js";

/** Public world facade combining commands with principal-filtered projections. */
export interface WorldRepository extends WorldReadRepository, WorldWriteRepository, NpcPresenceRepository, ActorJourneyRepository {}

export function createWorldRepository(db:DatabaseDriver.Database,deps:WorldDependencies & { rng?: RandomNumberGenerator },guard:()=>void):WorldRepository {
  const reads=createWorldReadRepository(db,{guard});
  const writes=createWorldWriteRepository(db,{...deps,guard});
  const npcPresence=createNpcPresenceRepository(db,deps,guard);
  const journeys=createActorJourneyRepository(db,deps,guard);
  return {...reads,...writes,...npcPresence,...journeys};
}
