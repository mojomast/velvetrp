import type DatabaseDriver from "better-sqlite3";
import type { M15Dependencies } from "./actorResourceRepo.js";
import {
  createEconomyReadRepository,
  createEconomyWriteRepository,
  type EconomyReadRepository,
  type EconomyWriteRepository,
} from "./economy/index.js";

export type { ActorEconomySnapshot } from "./economy/index.js";
export {
  EconomyAuthorizationError,
  EconomyConflictError,
  QuoteExpiredError,
  ShopStockExhaustedError,
  TradeStaleError,
} from "./economy/index.js";
export type { ActorScopedEconomyCommand } from "./economy/index.js";
/** Public economy facade combining authorized reads with transactional commands. */
export interface EconomyRepository extends EconomyReadRepository, EconomyWriteRepository {}

/** Currency codes are legacy storage keys.  The v25 reference sidecar is the
 * authoritative public projection and prevents a code from silently meaning a
 * different pinned definition. */
export function createEconomyRepository(db:DatabaseDriver.Database,deps:M15Dependencies,assertMutation:()=>void):EconomyRepository {
  const reads=createEconomyReadRepository(db);
  const writes=createEconomyWriteRepository(db,deps,assertMutation,reads);
  const {currencyReference:_currencyReference,...readRepository}=reads;
  return {...readRepository,...writes};
}
