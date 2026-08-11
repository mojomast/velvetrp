import { resourceIdSchema } from "@velvet/contracts";
import { MECHANICS_STARTER_CATALOG } from "../../content/mechanicsStarterCatalog.js";
import {
  createRepositoryTestingComposition,
  type CreateRepositoryOptions,
  type Repository,
} from "../campaignRepositoryOrchestration.js";

const FIXTURE_TIME = "2035-01-01T00:00:00.000Z";
const WAYLAMP = {
  kind: "item" as const,
  packId: MECHANICS_STARTER_CATALOG.manifest.packId,
  packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
  definitionId: "velvet:mechanics:item:waylamp",
};
const GLIMMER = {
  kind: "currency" as const,
  packId: MECHANICS_STARTER_CATALOG.manifest.packId,
  packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
  definitionId: "velvet:mechanics:currency:glimmer",
};
const ECONOMY = {
  currencyCode: "GLM",
  shopId: "e2e-waylamp-shop",
  stockId: "e2e-waylamp-stock",
  shopName: "E2E Waylamp Shop",
  balance: 20,
  quantity: 2,
  unitPrice: 8,
};

export class DeterministicE2EFixtureAuthorizationError extends Error {
  readonly code = "DETERMINISTIC_E2E_FIXTURE_FORBIDDEN";
}
export class DeterministicE2EFixtureStaleError extends Error {
  readonly code = "DETERMINISTIC_E2E_FIXTURE_STALE";
}
export class DeterministicE2EFixtureConflictError extends Error {
  readonly code = "DETERMINISTIC_E2E_FIXTURE_CONFLICT";
}

export interface DeterministicE2EFixtures {
  materializeWaylamp(input: FixtureTarget & { entryId: string }): void;
  materializeShortRestFocus(input: FixtureTarget): void;
  materializeEconomyGraph(input: FixtureTarget): void;
}

type FixtureSqlParameter = string | number | bigint | Buffer | null;

/** @internal Minimal owned-connection capability available to fixture composition. */
export interface DeterministicE2EFixtureDatabase {
  prepare(source: string): {
    get(...parameters: FixtureSqlParameter[]): unknown;
    run(...parameters: FixtureSqlParameter[]): void;
  };
  immediate(operation: () => void): void;
}

interface FixtureTarget {
  principalId: string;
  campaignId: string;
  actorId: string;
  expectedRevision: number;
}

interface DeterministicE2ERepository {
  repository: Repository;
  fixtures: DeterministicE2EFixtures;
}

/** @internal Passed only to the owned repository's testing composition hook. */
export function createDeterministicE2EFixturesForOwnedRepository(
  db: DeterministicE2EFixtureDatabase,
): DeterministicE2EFixtures {
  const parseTarget = (input: FixtureTarget) => {
    const target = {
      principalId: resourceIdSchema.parse(input.principalId),
      campaignId: resourceIdSchema.parse(input.campaignId),
      actorId: resourceIdSchema.parse(input.actorId),
      expectedRevision: input.expectedRevision,
    };
    if (target.expectedRevision !== 0) {
      throw new DeterministicE2EFixtureStaleError("deterministic fixtures require expected M1.5 revision zero");
    }
    return target;
  };
  const authorizeAndCheckRevision = (input: FixtureTarget) => {
    const target = parseTarget(input);
    const ownedActor = db.prepare(`SELECT 1 FROM campaigns campaign
      JOIN campaign_memberships membership ON membership.campaign_id=campaign.id
        AND membership.principal_id=campaign.owner_principal_id AND membership.role='owner'
      JOIN campaign_actors actor ON actor.campaign_id=campaign.id
      WHERE campaign.id=? AND campaign.owner_principal_id=? AND actor.id=?`)
      .get(target.campaignId, target.principalId, target.actorId);
    if (!ownedActor) {
      throw new DeterministicE2EFixtureAuthorizationError("deterministic E2E fixture target is unavailable");
    }
    const revision = (db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?")
      .get(target.campaignId, target.actorId) as { revision: number } | undefined)?.revision ?? 0;
    if (revision !== 0) {
      throw new DeterministicE2EFixtureStaleError("deterministic fixtures require current M1.5 revision zero");
    }
    return target;
  };
  const conflict = (message: string): never => {
    throw new DeterministicE2EFixtureConflictError(message);
  };
  const same = (row: Record<string, unknown> | undefined, expected: Record<string, unknown>) =>
    row !== undefined && Object.entries(expected).every(([key, value]) => row[key] === value);
  const ensureCatalogDefinition = (campaignId: string, definition: typeof WAYLAMP | typeof GLIMMER) => {
    const row = db.prepare(`SELECT campaign_id campaignId,pack_id packId,pack_version packVersion,kind,definition_id definitionId
      FROM rpg_campaign_catalog_definitions_v25
      WHERE campaign_id=? AND pack_id=? AND pack_version=? AND kind=? AND definition_id=?`)
      .get(campaignId, definition.packId, definition.packVersion, definition.kind, definition.definitionId) as Record<string, unknown> | undefined;
    if (row) return;
    db.prepare("INSERT INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,?)")
      .run(campaignId, definition.packId, definition.packVersion, definition.kind, definition.definitionId);
  };
  const immediate = (operation: () => void) => {
    db.immediate(operation);
  };

  return {
    materializeWaylamp(input) {
      immediate(() => {
        const target = authorizeAndCheckRevision(input);
        const entryId = resourceIdSchema.parse(input.entryId);
        const existing = db.prepare(`SELECT entry_id entryId,campaign_id campaignId,actor_id actorId,item_pack_id packId,
          item_pack_version packVersion,item_kind kind,item_definition_id definitionId,entry_mode entryMode,
          quantity,instance_key instanceKey,slot_key slotKey,equipped,created_at createdAt
          FROM rpg_inventory_entries_v25 WHERE entry_id=?`).get(entryId) as Record<string, unknown> | undefined;
        const exact = { entryId, campaignId: target.campaignId, actorId: target.actorId, packId: WAYLAMP.packId,
          packVersion: WAYLAMP.packVersion, kind: WAYLAMP.kind, definitionId: WAYLAMP.definitionId,
          entryMode: "instanced", quantity: 1, instanceKey: entryId, slotKey: null, equipped: 0, createdAt: FIXTURE_TIME };
        if (existing) {
          if (!same(existing, exact)) conflict("Waylamp fixture identity already has different state");
          return;
        }
        ensureCatalogDefinition(target.campaignId, WAYLAMP);
        db.prepare(`INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,
          item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at)
          VALUES(?,?,?,?,?,? ,?,'instanced',1,?,NULL,0,?)`)
          .run(entryId, target.campaignId, target.actorId, WAYLAMP.packId, WAYLAMP.packVersion,
            WAYLAMP.kind, WAYLAMP.definitionId, entryId, FIXTURE_TIME);
      });
    },
    materializeShortRestFocus(input) {
      immediate(() => {
        const target = authorizeAndCheckRevision(input);
        const resource = db.prepare("SELECT campaign_id campaignId,actor_id actorId,name,current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='focus'")
          .get(target.campaignId, target.actorId) as Record<string, unknown> | undefined;
        const binding = db.prepare("SELECT campaign_id campaignId,actor_id actorId,resource_name resourceName,binding_key bindingKey,binding_json bindingJson FROM rpg_actor_resource_bindings_v25 WHERE campaign_id=? AND actor_id=? AND resource_name='focus'")
          .get(target.campaignId, target.actorId) as Record<string, unknown> | undefined;
        if (resource || binding) {
          if (!same(resource, { campaignId: target.campaignId, actorId: target.actorId, name: "focus", current: 1, max: 4 })
            || !same(binding, { campaignId: target.campaignId, actorId: target.actorId, resourceName: "focus", bindingKey: "ability", bindingJson: JSON.stringify({ kind: "ability", recovery: "short-rest" }) })) {
            conflict("short-rest focus fixture has partial or different state");
          }
          return;
        }
        db.prepare("INSERT INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,'focus',1,4)")
          .run(target.campaignId, target.actorId);
        db.prepare("INSERT INTO rpg_actor_resource_bindings_v25(campaign_id,actor_id,resource_name,binding_key,binding_json) VALUES(?,?,'focus','ability',?)")
          .run(target.campaignId, target.actorId, JSON.stringify({ kind: "ability", recovery: "short-rest" }));
      });
    },
    materializeEconomyGraph(input) {
      immediate(() => {
        const target = authorizeAndCheckRevision(input);
        const currency = db.prepare("SELECT campaign_id campaignId,currency_code currencyCode,pack_id packId,pack_version packVersion,kind,definition_id definitionId FROM rpg_currency_references_v25 WHERE campaign_id=? AND currency_code=?")
          .get(target.campaignId, ECONOMY.currencyCode) as Record<string, unknown> | undefined;
        const wallet = db.prepare("SELECT campaign_id campaignId,actor_id actorId,currency_code currencyCode,balance_minor balance,updated_at updatedAt FROM rpg_wallets_v25 WHERE campaign_id=? AND actor_id=? AND currency_code=?")
          .get(target.campaignId, target.actorId, ECONOMY.currencyCode) as Record<string, unknown> | undefined;
        const shop = db.prepare("SELECT shop_id shopId,campaign_id campaignId,name,created_at createdAt FROM rpg_shop_definitions_v25 WHERE shop_id=?")
          .get(ECONOMY.shopId) as Record<string, unknown> | undefined;
        const stock = db.prepare(`SELECT stock_id stockId,campaign_id campaignId,shop_id shopId,item_pack_id packId,
          item_pack_version packVersion,item_kind kind,item_definition_id definitionId,available_quantity quantity,
          unit_price_minor unitPrice,currency_code currencyCode FROM rpg_shop_stock_v25 WHERE stock_id=?`)
          .get(ECONOMY.stockId) as Record<string, unknown> | undefined;
        const rows = [currency, wallet, shop, stock];
        if (rows.some(Boolean)) {
          const exact = same(currency, { campaignId: target.campaignId, currencyCode: ECONOMY.currencyCode, packId: GLIMMER.packId, packVersion: GLIMMER.packVersion, kind: GLIMMER.kind, definitionId: GLIMMER.definitionId })
            && same(wallet, { campaignId: target.campaignId, actorId: target.actorId, currencyCode: ECONOMY.currencyCode, balance: ECONOMY.balance, updatedAt: FIXTURE_TIME })
            && same(shop, { shopId: ECONOMY.shopId, campaignId: target.campaignId, name: ECONOMY.shopName, createdAt: FIXTURE_TIME })
            && same(stock, { stockId: ECONOMY.stockId, campaignId: target.campaignId, shopId: ECONOMY.shopId, packId: WAYLAMP.packId, packVersion: WAYLAMP.packVersion, kind: WAYLAMP.kind, definitionId: WAYLAMP.definitionId, quantity: ECONOMY.quantity, unitPrice: ECONOMY.unitPrice, currencyCode: ECONOMY.currencyCode });
          if (!exact) conflict("economy fixture has partial or different state");
          return;
        }
        ensureCatalogDefinition(target.campaignId, WAYLAMP);
        ensureCatalogDefinition(target.campaignId, GLIMMER);
        db.prepare("INSERT INTO rpg_currency_references_v25(campaign_id,currency_code,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,?,?)")
          .run(target.campaignId, ECONOMY.currencyCode, GLIMMER.packId, GLIMMER.packVersion, GLIMMER.kind, GLIMMER.definitionId);
        db.prepare("INSERT INTO rpg_wallets_v25(campaign_id,actor_id,currency_code,balance_minor,updated_at) VALUES(?,?,?,?,?)")
          .run(target.campaignId, target.actorId, ECONOMY.currencyCode, ECONOMY.balance, FIXTURE_TIME);
        db.prepare("INSERT INTO rpg_shop_definitions_v25(shop_id,campaign_id,name,created_at) VALUES(?,?,?,?)")
          .run(ECONOMY.shopId, target.campaignId, ECONOMY.shopName, FIXTURE_TIME);
        db.prepare(`INSERT INTO rpg_shop_stock_v25(stock_id,campaign_id,shop_id,item_pack_id,item_pack_version,item_kind,
          item_definition_id,available_quantity,unit_price_minor,currency_code) VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .run(ECONOMY.stockId, target.campaignId, ECONOMY.shopId, WAYLAMP.packId, WAYLAMP.packVersion,
            WAYLAMP.kind, WAYLAMP.definitionId, ECONOMY.quantity, ECONOMY.unitPrice, ECONOMY.currencyCode);
      });
    },
  };
}

export function createDeterministicE2ERepository(
  options: CreateRepositoryOptions = {},
): DeterministicE2ERepository {
  const composition = createRepositoryTestingComposition(options, createDeterministicE2EFixturesForOwnedRepository);
  return { repository: composition.repository, fixtures: composition.extension };
}
