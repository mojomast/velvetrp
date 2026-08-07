import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema, shopSchema, walletSchema, type Shop, type Wallet } from "@velvet/contracts";
import { getM15ActorRevision, m15Authorized } from "../actorResourceRepo.js";

/** An actor's authorized wallet projection and current M1.5 mutation revision. */
export interface ActorEconomySnapshot { campaignId: string; actorId: string; wallet: Wallet; revision: number; }

/** The exact pinned definition reference used by a wallet balance or price. */
export type EconomyCurrencyReference = Wallet["balances"][number]["currency"];

/** Non-mutating, principal-authorized economy projections. */
export interface EconomyReadRepository {
  /** Returns the actor wallet when the principal controls that actor. */
  getWallet(principal: string, campaignId: string, actorId: string): Wallet | null;
  /** Returns a wallet together with the revision required by economy commands. */
  getActorEconomySnapshot(principal: string, campaignId: string, actorId: string): ActorEconomySnapshot | null;
  /** Returns a campaign shop and its pinned-reference stock for a campaign member. */
  getShop(principal: string, campaignId: string, shopId: string): Shop | null;
}

/** Read helper injected into economy commands so they share the public reference projection. */
export interface EconomyReadHelpers {
  /** Resolves a legacy currency storage code to its exact campaign-pinned reference. */
  currencyReference(campaignId: string, currencyCode: string): EconomyCurrencyReference | null;
}

/** Creates database-backed economy read projections and their command-safe lookup helper. */
export function createEconomyReadRepository(
  db: DatabaseDriver.Database,
): EconomyReadRepository & EconomyReadHelpers {
  /** Reads the exact reference instead of allowing legacy currency codes to leak publicly. */
  const currencyReference = (campaignId: string, currencyCode: string): EconomyCurrencyReference | null => {
    const row = db.prepare("SELECT 'currency' kind,pack_id packId,pack_version packVersion,definition_id definitionId FROM rpg_currency_references_v25 WHERE campaign_id=? AND currency_code=?").get(campaignId, currencyCode) as EconomyCurrencyReference | undefined;
    return row ?? null;
  };
  /** Reads an actor-controlled wallet and rejects incomplete pinned currency provenance. */
  const getWallet = (principal: string, campaignId: string, actorId: string): Wallet | null => {
    resourceIdSchema.parse(principal); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(actorId);
    if (!m15Authorized(db, principal, campaignId, actorId)) return null;
    const balances = (db.prepare("SELECT currency_code,balance_minor FROM rpg_wallets_v25 WHERE campaign_id=? AND actor_id=? ORDER BY currency_code").all(campaignId, actorId) as any[])
      .map((row) => ({ currency: currencyReference(campaignId, row.currency_code), minorUnits: row.balance_minor }));
    if (balances.some((row) => !row.currency)) return null;
    return walletSchema.parse({ balances });
  };
  /** Captures an authorized wallet and its revision in one database transaction. */
  const getActorEconomySnapshot = (principal: string, campaignId: string, actorId: string): ActorEconomySnapshot | null => db.transaction(() => {
    resourceIdSchema.parse(principal); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(actorId);
    if (!m15Authorized(db, principal, campaignId, actorId)) return null;
    const wallet = getWallet(principal, campaignId, actorId);
    return wallet ? { campaignId, actorId, wallet, revision: getM15ActorRevision(db, campaignId, actorId) } : null;
  })();
  /** Reads member-visible stock and refuses prices without exact currency provenance. */
  const getShop = (principal: string, campaignId: string, shopId: string): Shop | null => {
    resourceIdSchema.parse(principal); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(shopId);
    if (!db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principal)) return null;
    const definition = db.prepare("SELECT name FROM rpg_shop_definitions_v25 WHERE campaign_id=? AND shop_id=?").get(campaignId, shopId) as any;
    if (!definition) return null;
    const stock = (db.prepare("SELECT * FROM rpg_shop_stock_v25 WHERE campaign_id=? AND shop_id=? ORDER BY stock_id").all(campaignId, shopId) as any[])
      .map((row) => ({ item: { kind: "item", packId: row.item_pack_id, packVersion: row.item_pack_version, definitionId: row.item_definition_id }, quantity: row.available_quantity, unitPrice: { currency: currencyReference(campaignId, row.currency_code), minorUnits: row.unit_price_minor } }));
    if (stock.some((row) => !row.unitPrice.currency)) return null;
    return shopSchema.parse({ shopId, campaignId, name: definition.name, stock });
  };
  return { currencyReference, getWallet, getActorEconomySnapshot, getShop };
}
