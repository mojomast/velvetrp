/** Economy repository composition boundary. */
export {
  createEconomyReadRepository,
  type ActorEconomySnapshot,
  type EconomyCurrencyReference,
  type EconomyReadHelpers,
  type EconomyReadRepository,
} from "./economyReadRepo.js";
export {
  createEconomyWriteRepository,
  EconomyAuthorizationError,
  EconomyConflictError,
  QuoteExpiredError,
  ShopStockExhaustedError,
  TradeStaleError,
  type ActorScopedEconomyCommand,
  type EconomyWriteRepository,
} from "./economyWriteRepo.js";
