import type DatabaseDriver from "better-sqlite3";
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
  type CampaignNpcsSnapshot,
  type CreateNpcResult,
  type NpcRelationshipResult,
  type CampaignFactionsSnapshot,
  type CreateFactionResult,
  type FactionReputationResult,
} from "./world/index.js";

/** Public world facade combining commands with principal-filtered projections. */
export interface WorldRepository extends WorldReadRepository, WorldWriteRepository, NpcPresenceRepository {}

export function createWorldRepository(db:DatabaseDriver.Database,deps:WorldDependencies,guard:()=>void):WorldRepository {
  const reads=createWorldReadRepository(db,{guard});
  const writes=createWorldWriteRepository(db,{...deps,guard});
  const npcPresence=createNpcPresenceRepository(db,deps,guard);
  return {...reads,...writes,...npcPresence};
}
