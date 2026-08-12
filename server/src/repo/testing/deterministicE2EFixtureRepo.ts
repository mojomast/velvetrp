import {
  deriveUseConsumableEffectPlan,
  itemCatalogDefinitionSchema,
  itemCatalogReferenceSchema,
  resourceIdSchema,
  worldVisibleLocationHttpSchema,
  type CatalogDefinitionReference,
} from "@velvet/contracts";
import { MECHANICS_STARTER_CATALOG } from "../../content/mechanicsStarterCatalog.js";
import {
  createRepositoryTestingComposition,
  type CreateRepositoryOptions,
  type Repository,
} from "../campaignRepositoryOrchestration.js";

type ItemReference = Extract<CatalogDefinitionReference, { kind: "item" }>;

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
const campaignLocationFixtureSchema = worldVisibleLocationHttpSchema.extend({
  campaignId: resourceIdSchema,
}).refine((location) => location.parentLocationId !== location.locationId, {
  message: "a location cannot be its own parent",
  path: ["parentLocationId"],
});

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
  materializePinnedItemExecution(input: { principalId: string; campaignId: string; item: ItemReference }): void;
  materializeConsumableEntry(input: FixtureTarget & { entryId: string; item: ItemReference }): void;
  materializeShortRestFocus(input: FixtureTarget): void;
  materializeEconomyGraph(input: FixtureTarget): void;
  materializeCampaignLocation(input: {
    campaignId: string;
    locationId: string;
    parentLocationId: string | null;
    name: string;
    description: string;
  }): void;
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
    if (!Number.isSafeInteger(target.expectedRevision) || target.expectedRevision < 0) {
      throw new DeterministicE2EFixtureStaleError("deterministic fixtures require a valid expected M1.5 revision");
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
    if (revision !== target.expectedRevision) {
      throw new DeterministicE2EFixtureStaleError("deterministic fixture M1.5 revision is stale");
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
    materializePinnedItemExecution(input) {
      immediate(() => {
        const principalId = resourceIdSchema.parse(input.principalId);
        const campaignId = resourceIdSchema.parse(input.campaignId);
        const item = itemCatalogReferenceSchema.parse(input.item);
        const owned = db.prepare(`SELECT 1 FROM campaigns campaign JOIN campaign_memberships membership
          ON membership.campaign_id=campaign.id AND membership.principal_id=campaign.owner_principal_id AND membership.role='owner'
          JOIN campaign_catalog_current_pins pin ON pin.campaign_id=campaign.id
          JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
          WHERE campaign.id=? AND campaign.owner_principal_id=? AND pin.pack_id=? AND pin.pack_version=?
            AND definition.kind='item' AND definition.definition_id=?`)
          .get(campaignId, principalId, item.packId, item.packVersion, item.definitionId);
        if (!owned) throw new DeterministicE2EFixtureAuthorizationError("deterministic pinned item is unavailable");
        const existing = db.prepare(`SELECT 1 FROM rpg_campaign_catalog_definitions_v25 WHERE campaign_id=?
          AND pack_id=? AND pack_version=? AND kind='item' AND definition_id=?`)
          .get(campaignId, item.packId, item.packVersion, item.definitionId);
        if (!existing) db.prepare(`INSERT INTO rpg_campaign_catalog_definitions_v25
          (campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,'item',?)`)
          .run(campaignId, item.packId, item.packVersion, item.definitionId);
      });
    },
    materializeConsumableEntry(input) {
      immediate(() => {
        const target = authorizeAndCheckRevision(input);
        const entryId = resourceIdSchema.parse(input.entryId);
        const item = itemCatalogReferenceSchema.parse(input.item);
        const definition = db.prepare(`SELECT definition.definition_json definitionJson FROM campaign_catalog_current_pins pin
          JOIN rpg_campaign_catalog_definitions_v25 execution ON execution.campaign_id=pin.campaign_id
            AND execution.pack_id=pin.pack_id AND execution.pack_version=pin.pack_version
          JOIN rpg_catalog_definitions definition ON definition.pack_id=execution.pack_id
            AND definition.pack_version=execution.pack_version AND definition.kind=execution.kind
            AND definition.definition_id=execution.definition_id
          WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?
            AND execution.kind='item' AND execution.definition_id=?`)
          .get(target.campaignId, item.packId, item.packVersion, item.definitionId) as { definitionJson: string } | undefined;
        if (!definition) throw new DeterministicE2EFixtureAuthorizationError("deterministic consumable execution definition is unavailable");
        let parsed: ReturnType<typeof itemCatalogDefinitionSchema.parse>;
        try { parsed = itemCatalogDefinitionSchema.parse(JSON.parse(definition.definitionJson)); }
        catch { throw new DeterministicE2EFixtureConflictError("deterministic consumable definition is invalid"); }
        const plan = deriveUseConsumableEffectPlan(parsed, item);
        if (parsed.mechanics.category !== "consumable" || !parsed.mechanics.stackable || parsed.mechanics.slot !== null
            || plan === null || !plan.effects.some(({ effect }) => effect.kind === "healing")
            || plan.effects.some(({ effect }) => effect.kind === "modifier")) {
          conflict("deterministic item is not a supported healing consumable");
        }
        const existing = db.prepare(`SELECT entry_id entryId,campaign_id campaignId,actor_id actorId,item_pack_id packId,
          item_pack_version packVersion,item_kind kind,item_definition_id definitionId,entry_mode entryMode,
          quantity,instance_key instanceKey,slot_key slotKey,equipped,created_at createdAt
          FROM rpg_inventory_entries_v25 WHERE entry_id=?`).get(entryId) as Record<string, unknown> | undefined;
        const exact = { entryId, campaignId: target.campaignId, actorId: target.actorId, packId: item.packId,
          packVersion: item.packVersion, kind: item.kind, definitionId: item.definitionId,
          entryMode: "stackable", quantity: 1, instanceKey: null, slotKey: null, equipped: 0, createdAt: FIXTURE_TIME };
        if (existing) {
          if (!same(existing, exact)) conflict("consumable fixture identity already has different state");
          return;
        }
        db.prepare(`INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,
          item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at)
          VALUES(?,?,?,?,?,? ,?,'stackable',1,NULL,NULL,0,?)`)
          .run(entryId, target.campaignId, target.actorId, item.packId, item.packVersion,
            item.kind, item.definitionId, FIXTURE_TIME);
        const health = db.prepare("SELECT current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
          .get(target.campaignId, target.actorId) as { current: number; max: number } | undefined;
        if (!health) throw new DeterministicE2EFixtureAuthorizationError("deterministic consumable actor health is unavailable");
        db.prepare("UPDATE rpg_actor_resources SET current=? WHERE campaign_id=? AND actor_id=? AND name='health'")
          .run(Math.max(1, health.max - 1), target.campaignId, target.actorId);
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
    materializeCampaignLocation(input) {
      const location = campaignLocationFixtureSchema.parse(input);
      immediate(() => {
        const ownedCampaign = db.prepare(`SELECT 1 FROM campaigns campaign
          JOIN campaign_memberships membership ON membership.campaign_id=campaign.id
            AND membership.principal_id='local-owner' AND membership.role='owner'
          WHERE campaign.id=? AND campaign.owner_principal_id='local-owner'`)
          .get(location.campaignId);
        if (!ownedCampaign) {
          throw new DeterministicE2EFixtureAuthorizationError("deterministic E2E fixture target is unavailable");
        }

        const existing = db.prepare(`SELECT location_id locationId,campaign_id campaignId,
          parent_location_id parentLocationId,public_name name,public_description description,
          visibility,created_at createdAt FROM campaign_locations_v28 WHERE location_id=?`)
          .get(location.locationId) as Record<string, unknown> | undefined;
        const exact = { ...location, visibility: "public", createdAt: FIXTURE_TIME };
        if (existing) {
          if (!same(existing, exact)) conflict("campaign location fixture identity already has different state");
          return;
        }
        if (location.parentLocationId !== null && !db.prepare(`SELECT 1 FROM campaign_locations_v28
          WHERE campaign_id=? AND location_id=?`).get(location.campaignId, location.parentLocationId)) {
          throw new DeterministicE2EFixtureAuthorizationError("deterministic E2E fixture parent is unavailable");
        }
        db.prepare(`INSERT INTO campaign_locations_v28(location_id,campaign_id,parent_location_id,
          public_name,public_description,visibility,created_at) VALUES(?,?,?,?,?,'public',?)`)
          .run(location.locationId, location.campaignId, location.parentLocationId,
            location.name, location.description, FIXTURE_TIME);
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
