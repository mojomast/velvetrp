// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalV17 } from "./v16_v18_catalog.js";
import { V24_PROGRESSION_LAYOUT_DIGEST, assertCharacterProgressionLayoutV24, validateCharacterProgressionV24 } from "./v23_v24_progression.js";

/** Additive v25r1 persistence foundation for resources, possessions, economy, trade, and rest. */
export function createResourcesInventoryEconomyRestV25(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_actor_resource_charges_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, resource_name TEXT NOT NULL,
      current_charges INTEGER NOT NULL CHECK(typeof(current_charges)='integer' AND current_charges BETWEEN 0 AND 9007199254740991),
      maximum_charges INTEGER NOT NULL CHECK(typeof(maximum_charges)='integer' AND maximum_charges BETWEEN 0 AND 9007199254740991),
      CHECK(current_charges<=maximum_charges), PRIMARY KEY(campaign_id,actor_id,resource_name),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(actor_id,resource_name) REFERENCES rpg_actor_resources(actor_id,name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_actor_resource_ammunition_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, resource_name TEXT NOT NULL,
      current_ammunition INTEGER NOT NULL CHECK(typeof(current_ammunition)='integer' AND current_ammunition BETWEEN 0 AND 9007199254740991),
      maximum_ammunition INTEGER NOT NULL CHECK(typeof(maximum_ammunition)='integer' AND maximum_ammunition BETWEEN 0 AND 9007199254740991),
      CHECK(current_ammunition<=maximum_ammunition), PRIMARY KEY(campaign_id,actor_id,resource_name),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(actor_id,resource_name) REFERENCES rpg_actor_resources(actor_id,name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_actor_resource_bindings_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, resource_name TEXT NOT NULL,
      binding_key TEXT NOT NULL CHECK(length(binding_key) BETWEEN 1 AND 128 AND binding_key=trim(binding_key)),
      binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND json_type(binding_json)='object'),
      PRIMARY KEY(campaign_id,actor_id,resource_name),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(actor_id,resource_name) REFERENCES rpg_actor_resources(actor_id,name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_actor_resource_capacities_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, resource_name TEXT NOT NULL,
      used_capacity INTEGER NOT NULL CHECK(typeof(used_capacity)='integer' AND used_capacity BETWEEN 0 AND 9007199254740991),
      maximum_capacity INTEGER NOT NULL CHECK(typeof(maximum_capacity)='integer' AND maximum_capacity BETWEEN 0 AND 9007199254740991),
      CHECK(used_capacity<=maximum_capacity), PRIMARY KEY(campaign_id,actor_id,resource_name),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(actor_id,resource_name) REFERENCES rpg_actor_resources(actor_id,name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_inventory_entries_v25 (
      entry_id TEXT PRIMARY KEY CHECK(length(entry_id) BETWEEN 1 AND 128 AND entry_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, item_pack_id TEXT NOT NULL, item_pack_version TEXT NOT NULL,
      item_kind TEXT NOT NULL CHECK(item_kind='item'), item_definition_id TEXT NOT NULL,
      entry_mode TEXT NOT NULL CHECK(entry_mode IN ('stackable','instanced')),
      quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 1 AND 9007199254740991),
      instance_key TEXT, slot_key TEXT CHECK(slot_key IS NULL OR (length(slot_key) BETWEEN 1 AND 128 AND slot_key=trim(slot_key))),
      equipped INTEGER NOT NULL DEFAULT 0 CHECK(typeof(equipped)='integer' AND equipped IN (0,1)),
       created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      CHECK((entry_mode='stackable' AND instance_key IS NULL) OR (entry_mode='instanced' AND instance_key IS NOT NULL AND quantity=1)),
      CHECK(equipped=0 OR slot_key IS NOT NULL), UNIQUE(campaign_id,actor_id,instance_key),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,item_pack_id,item_pack_version,item_kind,item_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE UNIQUE INDEX uq_rpg_inventory_entries_v25_equipped_slot ON rpg_inventory_entries_v25(campaign_id,actor_id,slot_key) WHERE equipped=1;
    CREATE INDEX idx_rpg_inventory_entries_v25_actor ON rpg_inventory_entries_v25(campaign_id,actor_id,created_at);
    -- This sidecar turns an otherwise global catalog definition into an exact,
    -- campaign-pinned identity.  The current-pins parent has no key containing
    -- pack_version, so its actual (campaign_id,pack_id) key is used here and a
    -- guard below verifies the version before the sidecar can be inserted.
    CREATE TABLE rpg_campaign_catalog_definitions_v25 (
      campaign_id TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      kind TEXT NOT NULL, definition_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,pack_id,pack_version,kind,definition_id),
      FOREIGN KEY(campaign_id,pack_id) REFERENCES campaign_catalog_current_pins(campaign_id,pack_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(pack_id,pack_version,kind,definition_id) REFERENCES rpg_catalog_definitions(pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER rpg_campaign_catalog_definitions_v25_require_exact_pin BEFORE INSERT ON rpg_campaign_catalog_definitions_v25
      WHEN NOT EXISTS(SELECT 1 FROM campaign_catalog_current_pins pin WHERE pin.campaign_id=NEW.campaign_id AND pin.pack_id=NEW.pack_id AND pin.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'campaign catalog definition requires an exact current pin'); END;
    CREATE TABLE rpg_wallets_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      currency_code TEXT NOT NULL CHECK(length(currency_code) BETWEEN 3 AND 16 AND currency_code NOT GLOB '*[^A-Z0-9._:-]*'),
      balance_minor INTEGER NOT NULL CHECK(typeof(balance_minor)='integer' AND balance_minor BETWEEN -9007199254740991 AND 9007199254740991),
       updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,currency_code),
       FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,currency_code) REFERENCES rpg_currency_references_v25(campaign_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_currency_ledger_v25 (
      entry_id TEXT PRIMARY KEY CHECK(length(entry_id) BETWEEN 1 AND 128 AND entry_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, currency_code TEXT NOT NULL, delta_minor INTEGER NOT NULL
        CHECK(typeof(delta_minor)='integer' AND delta_minor BETWEEN -9007199254740991 AND 9007199254740991 AND delta_minor<>0),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason=trim(reason)), reference_type TEXT NOT NULL CHECK(length(reference_type) BETWEEN 1 AND 64), reference_id TEXT,
       occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY(campaign_id,actor_id,currency_code) REFERENCES rpg_wallets_v25(campaign_id,actor_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,currency_code) REFERENCES rpg_currency_references_v25(campaign_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX idx_rpg_currency_ledger_v25_wallet ON rpg_currency_ledger_v25(campaign_id,actor_id,currency_code,occurred_at,entry_id);
    CREATE TABLE rpg_shop_definitions_v25 (
      shop_id TEXT PRIMARY KEY CHECK(length(shop_id) BETWEEN 1 AND 128 AND shop_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL,
       name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name=trim(name)), created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,shop_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_shop_stock_v25 (
      stock_id TEXT PRIMARY KEY CHECK(length(stock_id) BETWEEN 1 AND 128 AND stock_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, shop_id TEXT NOT NULL,
      item_pack_id TEXT NOT NULL, item_pack_version TEXT NOT NULL, item_kind TEXT NOT NULL CHECK(item_kind='item'), item_definition_id TEXT NOT NULL,
      available_quantity INTEGER NOT NULL CHECK(typeof(available_quantity)='integer' AND available_quantity BETWEEN 0 AND 9007199254740991),
      unit_price_minor INTEGER NOT NULL CHECK(typeof(unit_price_minor)='integer' AND unit_price_minor BETWEEN 0 AND 9007199254740991), currency_code TEXT NOT NULL,
       UNIQUE(campaign_id,stock_id),
       UNIQUE(campaign_id,stock_id,shop_id,currency_code),
       UNIQUE(campaign_id,shop_id,item_pack_id,item_pack_version,item_kind,item_definition_id),
       FOREIGN KEY(campaign_id,shop_id) REFERENCES rpg_shop_definitions_v25(campaign_id,shop_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,item_pack_id,item_pack_version,item_kind,item_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,currency_code) REFERENCES rpg_currency_references_v25(campaign_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_shop_quotes_v25 (
       quote_id TEXT PRIMARY KEY CHECK(length(quote_id) BETWEEN 1 AND 128 AND quote_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, stock_id TEXT NOT NULL, shop_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 1 AND 9007199254740991), unit_price_minor INTEGER NOT NULL CHECK(typeof(unit_price_minor)='integer' AND unit_price_minor BETWEEN 0 AND 9007199254740991), currency_code TEXT NOT NULL,
       quoted_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',quoted_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',quoted_at)=quoted_at AND substr(quoted_at,12,2) BETWEEN '00' AND '23'), expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at AND substr(expires_at,12,2) BETWEEN '00' AND '23'), CHECK(expires_at>quoted_at),
       UNIQUE(campaign_id,quote_id,actor_id,shop_id),
       FOREIGN KEY(campaign_id,stock_id,shop_id,currency_code) REFERENCES rpg_shop_stock_v25(campaign_id,stock_id,shop_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(campaign_id,currency_code) REFERENCES rpg_currency_references_v25(campaign_id,currency_code) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_trade_proposals_v25 (
      trade_id TEXT PRIMARY KEY CHECK(length(trade_id) BETWEEN 1 AND 128 AND trade_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, proposer_actor_id TEXT NOT NULL, recipient_actor_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','accepted','declined','cancelled','settled')), offer_json TEXT NOT NULL CHECK(json_valid(offer_json) AND json_type(offer_json)='object'), request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
       created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'), expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at AND substr(expires_at,12,2) BETWEEN '00' AND '23'), CHECK(proposer_actor_id<>recipient_actor_id AND expires_at>created_at),
      UNIQUE(campaign_id,trade_id),
      FOREIGN KEY(campaign_id,proposer_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,recipient_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_trade_settlement_receipts_v25 (
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) BETWEEN 1 AND 128 AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'), trade_id TEXT NOT NULL UNIQUE, campaign_id TEXT NOT NULL,
       settlement_json TEXT NOT NULL CHECK(json_valid(settlement_json) AND json_type(settlement_json)='object'), settled_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',settled_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',settled_at)=settled_at AND substr(settled_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY(campaign_id,trade_id) REFERENCES rpg_trade_proposals_v25(campaign_id,trade_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_rest_receipts_v25 (
       receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) BETWEEN 1 AND 128 AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      rest_kind TEXT NOT NULL CHECK(rest_kind IN ('short','long')), changed_resources_json TEXT NOT NULL CHECK(json_valid(changed_resources_json) AND json_type(changed_resources_json)='array'),
       occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
       FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m15_receipts_v25(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    -- currency_code is an opaque local key, never a semantic currency label:
    -- this sidecar gives it one exact campaign-pinned catalog currency.
    CREATE TABLE rpg_currency_references_v25 (
      campaign_id TEXT NOT NULL, currency_code TEXT NOT NULL CHECK(length(currency_code) BETWEEN 1 AND 128 AND currency_code NOT GLOB '*[^A-Za-z0-9._:-]*'),
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind='currency'), definition_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,currency_code), UNIQUE(campaign_id,pack_id,pack_version,kind,definition_id),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,pack_id,pack_version,kind,definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(pack_id,pack_version,kind,definition_id) REFERENCES rpg_catalog_definitions(pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_purchase_receipts_v25 (
      purchase_id TEXT PRIMARY KEY CHECK(length(purchase_id) BETWEEN 1 AND 128), quote_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL, shop_id TEXT NOT NULL, buyer_actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity>0), total_json TEXT NOT NULL CHECK(json_valid(total_json) AND json_type(total_json)='object'),
      purchased_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',purchased_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',purchased_at)=purchased_at AND substr(purchased_at,12,2) BETWEEN '00' AND '23'), idempotency_key TEXT NOT NULL,
      FOREIGN KEY(campaign_id,quote_id,buyer_actor_id,shop_id) REFERENCES rpg_shop_quotes_v25(campaign_id,quote_id,actor_id,shop_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,buyer_actor_id,command_id,resulting_revision) REFERENCES rpg_m15_receipts_v25(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER rpg_purchase_receipts_v25_immutable_update BEFORE UPDATE ON rpg_purchase_receipts_v25 BEGIN SELECT RAISE(ABORT,'purchase receipts are immutable'); END;
    CREATE TRIGGER rpg_purchase_receipts_v25_immutable_delete BEFORE DELETE ON rpg_purchase_receipts_v25 BEGIN SELECT RAISE(ABORT,'purchase receipts are immutable'); END;
    -- M1.5 mutations use a new sidecar revision stream rather than changing
    -- the pre-existing campaign actor or resource aggregates.  One stream per
    -- campaign actor gives every resource, possession, money, trade, purchase,
    -- and rest command a common optimistic-concurrency boundary.
    CREATE TABLE rpg_m15_mutation_revisions_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_m15_commands_v25 (
      command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      command_family TEXT NOT NULL CHECK(command_family IN ('resource','inventory','economy','purchase','trade','rest')),
      command_type TEXT NOT NULL CHECK(length(command_type) BETWEEN 1 AND 128 AND command_type=trim(command_type)),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest GLOB '[0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991 AND resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,command_id),
      UNIQUE(campaign_id,actor_id,idempotency_key), UNIQUE(campaign_id,actor_id,resulting_revision), UNIQUE(campaign_id,actor_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES rpg_m15_mutation_revisions_v25(campaign_id,actor_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX idx_rpg_m15_commands_v25_retry ON rpg_m15_commands_v25(campaign_id,actor_id,idempotency_key);
    CREATE TABLE rpg_m15_receipts_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      canonical_result_json TEXT NOT NULL CHECK(json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest GLOB '[0-9a-f]*'),
      changed_keys_json TEXT NOT NULL CHECK(json_valid(changed_keys_json) AND json_type(changed_keys_json)='array'),
      changed_keys_digest TEXT NOT NULL CHECK(length(changed_keys_digest)=64 AND changed_keys_digest GLOB '[0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,command_id), UNIQUE(campaign_id,actor_id,resulting_revision), UNIQUE(campaign_id,actor_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m15_commands_v25(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_m15_receipt_changed_keys_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
      changed_key TEXT NOT NULL CHECK(length(changed_key) BETWEEN 1 AND 256 AND changed_key=trim(changed_key)),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      PRIMARY KEY(campaign_id,actor_id,command_id,changed_key),
      UNIQUE(campaign_id,actor_id,changed_key,resulting_revision),
      FOREIGN KEY(campaign_id,actor_id,command_id) REFERENCES rpg_m15_receipts_v25(campaign_id,actor_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    -- A cross-actor command advances a counterpart stream without inventing a
    -- second client command.  This immutable relation is its audit receipt.
    CREATE TABLE rpg_m15_counterpart_receipts_v25 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
      counterpart_actor_id TEXT NOT NULL, revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL,
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,command_id,counterpart_actor_id),
      UNIQUE(campaign_id,counterpart_actor_id,revision_after),
      CHECK(actor_id<>counterpart_actor_id AND revision_after=revision_before+1),
      FOREIGN KEY(campaign_id,actor_id,command_id) REFERENCES rpg_m15_commands_v25(campaign_id,actor_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,counterpart_actor_id) REFERENCES rpg_m15_mutation_revisions_v25(campaign_id,actor_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX idx_rpg_m15_receipt_changed_keys_v25_conflicts ON rpg_m15_receipt_changed_keys_v25(campaign_id,actor_id,changed_key,resulting_revision);
    CREATE TABLE rpg_resources_inventory_economy_layout_attestation_v25 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), prior_layout_digest TEXT NOT NULL CHECK(length(prior_layout_digest)=64), current_layout_digest TEXT NOT NULL CHECK(length(current_layout_digest)=64)
    );
    CREATE TRIGGER rpg_currency_ledger_v25_immutable_update BEFORE UPDATE ON rpg_currency_ledger_v25 BEGIN SELECT RAISE(ABORT,'currency ledger is append-only'); END;
    CREATE TRIGGER rpg_currency_ledger_v25_immutable_delete BEFORE DELETE ON rpg_currency_ledger_v25 BEGIN SELECT RAISE(ABORT,'currency ledger is append-only'); END;
    CREATE TRIGGER rpg_shop_quotes_v25_immutable_update BEFORE UPDATE ON rpg_shop_quotes_v25 BEGIN SELECT RAISE(ABORT,'shop quotes are immutable'); END;
    CREATE TRIGGER rpg_shop_quotes_v25_immutable_delete BEFORE DELETE ON rpg_shop_quotes_v25 BEGIN SELECT RAISE(ABORT,'shop quotes are immutable'); END;
    CREATE TRIGGER rpg_trade_settlement_receipts_v25_immutable_update BEFORE UPDATE ON rpg_trade_settlement_receipts_v25 BEGIN SELECT RAISE(ABORT,'trade settlement receipts are immutable'); END;
    CREATE TRIGGER rpg_trade_settlement_receipts_v25_immutable_delete BEFORE DELETE ON rpg_trade_settlement_receipts_v25 BEGIN SELECT RAISE(ABORT,'trade settlement receipts are immutable'); END;
    CREATE TRIGGER rpg_rest_receipts_v25_immutable_update BEFORE UPDATE ON rpg_rest_receipts_v25 BEGIN SELECT RAISE(ABORT,'rest receipts are immutable'); END;
    CREATE TRIGGER rpg_rest_receipts_v25_immutable_delete BEFORE DELETE ON rpg_rest_receipts_v25 BEGIN SELECT RAISE(ABORT,'rest receipts are immutable'); END;
    CREATE TRIGGER rpg_m15_mutation_revisions_v25_revision_guard BEFORE UPDATE ON rpg_m15_mutation_revisions_v25
      WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.actor_id<>OLD.actor_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
      BEGIN SELECT RAISE(ABORT,'M1.5 mutation revision must advance exactly once'); END;
    CREATE TRIGGER rpg_m15_mutation_revisions_v25_retain_delete BEFORE DELETE ON rpg_m15_mutation_revisions_v25 BEGIN SELECT RAISE(ABORT,'M1.5 mutation revisions are retained'); END;
    CREATE TRIGGER rpg_m15_commands_v25_immutable_update BEFORE UPDATE ON rpg_m15_commands_v25 BEGIN SELECT RAISE(ABORT,'M1.5 commands are immutable'); END;
    CREATE TRIGGER rpg_m15_commands_v25_immutable_delete BEFORE DELETE ON rpg_m15_commands_v25 BEGIN SELECT RAISE(ABORT,'M1.5 commands are immutable'); END;
    CREATE TRIGGER rpg_m15_commands_v25_prevent_replace BEFORE INSERT ON rpg_m15_commands_v25 WHEN EXISTS(
      SELECT 1 FROM rpg_m15_commands_v25 old WHERE old.campaign_id=NEW.campaign_id AND old.actor_id=NEW.actor_id AND (old.command_id=NEW.command_id OR old.idempotency_key=NEW.idempotency_key OR old.resulting_revision=NEW.resulting_revision)
    ) BEGIN SELECT RAISE(ABORT,'M1.5 commands are immutable'); END;
    CREATE TRIGGER rpg_m15_receipts_v25_immutable_update BEFORE UPDATE ON rpg_m15_receipts_v25 BEGIN SELECT RAISE(ABORT,'M1.5 receipts are immutable'); END;
    CREATE TRIGGER rpg_m15_receipts_v25_immutable_delete BEFORE DELETE ON rpg_m15_receipts_v25 BEGIN SELECT RAISE(ABORT,'M1.5 receipts are immutable'); END;
    CREATE TRIGGER rpg_m15_receipts_v25_require_command BEFORE INSERT ON rpg_m15_receipts_v25 WHEN NOT EXISTS(
      SELECT 1 FROM rpg_m15_commands_v25 command WHERE command.campaign_id=NEW.campaign_id AND command.actor_id=NEW.actor_id AND command.command_id=NEW.command_id AND command.resulting_revision=NEW.resulting_revision AND command.created_at=NEW.occurred_at
    ) BEGIN SELECT RAISE(ABORT,'M1.5 receipt must match its exact command'); END;
    CREATE TRIGGER rpg_m15_receipt_changed_keys_v25_immutable_update BEFORE UPDATE ON rpg_m15_receipt_changed_keys_v25 BEGIN SELECT RAISE(ABORT,'M1.5 changed keys are append-only'); END;
    CREATE TRIGGER rpg_m15_receipt_changed_keys_v25_immutable_delete BEFORE DELETE ON rpg_m15_receipt_changed_keys_v25 BEGIN SELECT RAISE(ABORT,'M1.5 changed keys are append-only'); END;
    CREATE TRIGGER rpg_m15_receipt_changed_keys_v25_require_receipt BEFORE INSERT ON rpg_m15_receipt_changed_keys_v25 WHEN NOT EXISTS(
      SELECT 1 FROM rpg_m15_receipts_v25 receipt WHERE receipt.campaign_id=NEW.campaign_id AND receipt.actor_id=NEW.actor_id AND receipt.command_id=NEW.command_id AND receipt.resulting_revision=NEW.resulting_revision
    ) BEGIN SELECT RAISE(ABORT,'M1.5 changed key must match its exact receipt'); END;
    CREATE TRIGGER rpg_m15_counterpart_receipts_v25_immutable_update BEFORE UPDATE ON rpg_m15_counterpart_receipts_v25 BEGIN SELECT RAISE(ABORT,'M1.5 counterpart receipts are immutable'); END;
    CREATE TRIGGER rpg_m15_counterpart_receipts_v25_immutable_delete BEFORE DELETE ON rpg_m15_counterpart_receipts_v25 BEGIN SELECT RAISE(ABORT,'M1.5 counterpart receipts are immutable'); END;
    CREATE TRIGGER rpg_wallets_v25_no_negative_insert BEFORE INSERT ON rpg_wallets_v25 WHEN NEW.balance_minor<0 BEGIN SELECT RAISE(ABORT,'wallet balance cannot be negative'); END;
    CREATE TRIGGER rpg_wallets_v25_no_negative_update BEFORE UPDATE OF balance_minor ON rpg_wallets_v25 WHEN NEW.balance_minor<0 BEGIN SELECT RAISE(ABORT,'wallet balance cannot be negative'); END;
    CREATE TRIGGER rpg_shop_quotes_v25_total_range BEFORE INSERT ON rpg_shop_quotes_v25
      WHEN NEW.unit_price_minor>0 AND NEW.quantity>9007199254740991/NEW.unit_price_minor
      BEGIN SELECT RAISE(ABORT,'quote total exceeds supported currency range'); END;
    CREATE TRIGGER rpg_trade_proposals_v25_immutable_terms BEFORE UPDATE OF campaign_id,proposer_actor_id,recipient_actor_id,offer_json,request_json,created_at,expires_at ON rpg_trade_proposals_v25 BEGIN SELECT RAISE(ABORT,'trade terms are immutable'); END;
    CREATE TRIGGER rpg_resources_inventory_economy_layout_attestation_v25_immutable_update BEFORE UPDATE ON rpg_resources_inventory_economy_layout_attestation_v25 BEGIN SELECT RAISE(ABORT,'v25 layout attestation is immutable'); END;
    CREATE TRIGGER rpg_resources_inventory_economy_layout_attestation_v25_immutable_delete BEFORE DELETE ON rpg_resources_inventory_economy_layout_attestation_v25 BEGIN SELECT RAISE(ABORT,'v25 layout attestation is immutable'); END;
  `);
  const current = resourcesInventoryEconomyRestLayoutDigestV25(db);
  db.prepare("INSERT INTO rpg_resources_inventory_economy_layout_attestation_v25(singleton,prior_layout_digest,current_layout_digest) VALUES(1,?,?)").run(V24_PROGRESSION_LAYOUT_DIGEST, current);
}
const V25_RESOURCES_INVENTORY_ECONOMY_LAYOUT_DIGEST = "a5e3a58f8014978315d20440a0ac087871edac95323d059327faa2fe0a983ef7";
function resourcesInventoryEconomyRestLayoutRowsV25(db: DatabaseDriver.Database): unknown[] { return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name GLOB '*_v25' OR name GLOB '*_v25_*' OR tbl_name GLOB '*_v25' OR tbl_name GLOB '*_v25_*') ORDER BY type,name`).all(); }
function resourcesInventoryEconomyRestLayoutDigestV25(db: DatabaseDriver.Database): string { const rows = (resourcesInventoryEconomyRestLayoutRowsV25(db) as Array<any>).map((row) => ({...row, sql: row.sql?.replace(/\s+/g, " ").trim()})); return createHash("sha256").update(canonicalV17(rows)).digest("hex"); }
export function assertResourcesInventoryEconomyRestLayoutV25(db: DatabaseDriver.Database): void { const row = db.prepare("SELECT prior_layout_digest,current_layout_digest FROM rpg_resources_inventory_economy_layout_attestation_v25 WHERE singleton=1").get() as any; const actual = resourcesInventoryEconomyRestLayoutDigestV25(db); if (!row || row.prior_layout_digest !== V24_PROGRESSION_LAYOUT_DIGEST || row.current_layout_digest !== actual || actual !== V25_RESOURCES_INVENTORY_ECONOMY_LAYOUT_DIGEST) throw new Error(`schema v25 resources/inventory/economy canonical SQL is incompatible (${actual})`); }
/** Re-attests the immutable M1.5 command graph after the fixed DDL attestation. */
export function validateM15PersistenceV25(db: DatabaseDriver.Database): void {
  const digest = (value: unknown) => createHash("sha256").update(canonicalV17(value)).digest("hex");
  const commands = db.prepare(`SELECT command.*, receipt.resulting_revision receipt_revision, receipt.canonical_result_json,
      receipt.result_digest, receipt.changed_keys_json, receipt.changed_keys_digest, receipt.occurred_at
    FROM rpg_m15_commands_v25 command LEFT JOIN rpg_m15_receipts_v25 receipt
      ON receipt.campaign_id=command.campaign_id AND receipt.actor_id=command.actor_id AND receipt.command_id=command.command_id
    ORDER BY command.campaign_id,command.actor_id,command.resulting_revision`).all() as Array<any>;
  const commandCount = (db.prepare("SELECT count(*) count FROM rpg_m15_commands_v25").get() as {count:number}).count;
  const receiptCount = (db.prepare("SELECT count(*) count FROM rpg_m15_receipts_v25").get() as {count:number}).count;
  if (commands.length !== commandCount || receiptCount !== commandCount) throw new Error("M1.5 command receipt graph is incomplete");
  for (const command of commands) {
    let request: any, result: any, changedKeys: unknown;
    try { request = JSON.parse(command.canonical_request_json); result = JSON.parse(command.canonical_result_json); changedKeys = JSON.parse(command.changed_keys_json); }
    catch { throw new Error("M1.5 command receipt graph is malformed"); }
    if (!command.canonical_result_json || command.canonical_request_json !== canonicalV17(request)
      || command.request_digest !== digest(request) || command.canonical_result_json !== canonicalV17(result)
      || command.result_digest !== digest(result) || !Array.isArray(changedKeys)
      || changedKeys.some((key) => typeof key !== "string")
      || command.changed_keys_json !== canonicalV17([...new Set(changedKeys)].sort())
      || command.changed_keys_digest !== digest(changedKeys)
      || command.receipt_revision !== command.resulting_revision || command.occurred_at !== command.created_at
      || result?.receipt?.commandId !== command.command_id || result.receipt?.idempotencyKey !== command.idempotency_key
      || result.receipt?.revisionBefore !== command.expected_revision || result.receipt?.revisionAfter !== command.resulting_revision
      || result.receipt?.occurredAt !== command.created_at || canonicalV17(result.receipt?.changedKeys) !== command.changed_keys_json)
      throw new Error("M1.5 command receipt provenance is inconsistent");
    const keyRows = db.prepare(`SELECT changed_key,resulting_revision FROM rpg_m15_receipt_changed_keys_v25
      WHERE campaign_id=? AND actor_id=? AND command_id=? ORDER BY changed_key`).all(command.campaign_id,command.actor_id,command.command_id) as Array<any>;
    if (keyRows.some((row) => row.resulting_revision !== command.resulting_revision)
      || canonicalV17(keyRows.map((row) => row.changed_key)) !== command.changed_keys_json)
      throw new Error("M1.5 changed-key provenance is inconsistent");
  }
  const roots = db.prepare("SELECT * FROM rpg_m15_mutation_revisions_v25 ORDER BY campaign_id,actor_id").all() as Array<any>;
  for (const root of roots) {
    const history = db.prepare(`SELECT resulting_revision revision,expected_revision revision_before,created_at occurred_at FROM rpg_m15_commands_v25 WHERE campaign_id=? AND actor_id=?
      UNION ALL SELECT revision_after,revision_before,occurred_at FROM rpg_m15_counterpart_receipts_v25 WHERE campaign_id=? AND counterpart_actor_id=?
      ORDER BY revision`).all(root.campaign_id,root.actor_id,root.campaign_id,root.actor_id) as Array<any>;
    if (history.length !== root.revision || history.some((row,index) => row.revision !== index+1 || row.revision_before !== index)
      || (history.length > 0 && root.updated_at !== history.at(-1)!.occurred_at))
      throw new Error("M1.5 revision root history is inconsistent");
  }
  const counterparts = db.prepare(`SELECT counterpart.*,command.created_at FROM rpg_m15_counterpart_receipts_v25 counterpart
    LEFT JOIN rpg_m15_commands_v25 command ON command.campaign_id=counterpart.campaign_id AND command.actor_id=counterpart.actor_id AND command.command_id=counterpart.command_id
    ORDER BY counterpart.campaign_id,counterpart.actor_id,counterpart.command_id,counterpart.counterpart_actor_id`).all() as Array<any>;
  for (const counterpart of counterparts) if (!counterpart.created_at || counterpart.actor_id===counterpart.counterpart_actor_id
    || counterpart.revision_after!==counterpart.revision_before+1 || counterpart.occurred_at!==counterpart.created_at)
    throw new Error("M1.5 counterpart revision provenance is inconsistent");
  const requireOne = (table:string, predicate:string, message:string) => {
    const invalid = db.prepare(`SELECT command.command_id FROM rpg_m15_commands_v25 command LEFT JOIN ${table} receipt ON ${predicate}
      WHERE ${message} LIMIT 1`).get(); if (invalid) throw new Error("M1.5 domain receipt provenance is inconsistent");
  };
  requireOne("rpg_purchase_receipts_v25", "receipt.purchase_id=command.command_id AND receipt.campaign_id=command.campaign_id AND receipt.buyer_actor_id=command.actor_id AND receipt.command_id=command.command_id AND receipt.resulting_revision=command.resulting_revision", "command.command_type='purchase_from_shop' AND (receipt.purchase_id IS NULL OR receipt.purchased_at<>command.created_at OR receipt.idempotency_key<>command.idempotency_key)");
  requireOne("rpg_rest_receipts_v25", "receipt.receipt_id=command.command_id AND receipt.campaign_id=command.campaign_id AND receipt.actor_id=command.actor_id AND receipt.command_id=command.command_id AND receipt.resulting_revision=command.resulting_revision", "command.command_family='rest' AND (receipt.receipt_id IS NULL OR receipt.occurred_at<>command.created_at OR (command.command_type='take_short_rest' AND receipt.rest_kind<>'short') OR (command.command_type='take_long_rest' AND receipt.rest_kind<>'long'))");
  requireOne("rpg_trade_settlement_receipts_v25", "receipt.receipt_id=command.command_id AND receipt.campaign_id=command.campaign_id", "command.command_type='accept_bilateral_trade' AND (receipt.receipt_id IS NULL OR receipt.settled_at<>command.created_at)");
  const orphanDomain = db.prepare(`SELECT 1 FROM rpg_purchase_receipts_v25 receipt LEFT JOIN rpg_m15_commands_v25 command ON command.command_id=receipt.command_id AND command.campaign_id=receipt.campaign_id AND command.actor_id=receipt.buyer_actor_id AND command.resulting_revision=receipt.resulting_revision WHERE command.command_id IS NULL OR command.command_type<>'purchase_from_shop'
    UNION ALL SELECT 1 FROM rpg_rest_receipts_v25 receipt LEFT JOIN rpg_m15_commands_v25 command ON command.command_id=receipt.command_id AND command.campaign_id=receipt.campaign_id AND command.actor_id=receipt.actor_id AND command.resulting_revision=receipt.resulting_revision WHERE command.command_id IS NULL OR command.command_family<>'rest'
    UNION ALL SELECT 1 FROM rpg_trade_settlement_receipts_v25 receipt LEFT JOIN rpg_m15_commands_v25 command ON command.command_id=receipt.receipt_id AND command.campaign_id=receipt.campaign_id WHERE command.command_id IS NULL OR command.command_type<>'accept_bilateral_trade' LIMIT 1`).get();
  if (orphanDomain) throw new Error("M1.5 domain receipt provenance is inconsistent");
}
export function migrate24to25(db: DatabaseDriver.Database): void { db.transaction(() => { assertCharacterProgressionLayoutV24(db); validateCharacterProgressionV24(db); createResourcesInventoryEconomyRestV25(db); db.prepare("UPDATE meta SET value='25' WHERE key='schemaVersion'").run(); })(); }

/** Additive v26r1 persistence for deterministic checks, powers, and typed effects. */
export function createChecksPowersEffectsV26(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_m16_mutation_revisions_v26 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_m16_commands_v26 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      command_family TEXT NOT NULL CHECK(command_family IN ('check','power','effect')), command_type TEXT NOT NULL CHECK(command_type IN ('resolve_check','use_power','apply_effect','remove_effect','advance_effect_duration')),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(length(canonical_request_json) BETWEEN 2 AND 32768 AND json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest GLOB '[0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,command_id), UNIQUE(campaign_id,actor_id,idempotency_key), UNIQUE(campaign_id,actor_id,resulting_revision), UNIQUE(campaign_id,actor_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,actor_id) REFERENCES rpg_m16_mutation_revisions_v26(campaign_id,actor_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_m16_receipts_v26 (
      campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      canonical_result_json TEXT NOT NULL CHECK(length(canonical_result_json) BETWEEN 2 AND 32768 AND json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest GLOB '[0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,actor_id,command_id), UNIQUE(campaign_id,actor_id,resulting_revision), UNIQUE(campaign_id,actor_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_commands_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_m16_events_v26 (
      event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('check_resolved','power_used','effect_applied','effect_removed','effect_duration_advanced')),
      event_json TEXT NOT NULL CHECK(length(event_json) BETWEEN 2 AND 32768 AND json_valid(event_json) AND json_type(event_json)='object'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,actor_id,command_id),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_receipts_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_check_results_v26 (
      check_id TEXT PRIMARY KEY CHECK(length(check_id) BETWEEN 1 AND 128 AND check_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      check_kind TEXT NOT NULL CHECK(check_kind IN ('ability','skill','save','attack','opposed')), check_key TEXT NOT NULL CHECK(check_key IN ('might','agility','resolve','insight','presence','craft','melee','ranged','spell','defense')),
      target_actor_id TEXT, difficulty INTEGER CHECK(typeof(difficulty)='integer' AND difficulty BETWEEN 0 AND 1000),
      dice_json TEXT NOT NULL CHECK(length(dice_json) BETWEEN 2 AND 4096 AND json_valid(dice_json) AND json_type(dice_json)='array' AND json_array_length(dice_json) BETWEEN 1 AND 32),
      result_json TEXT NOT NULL CHECK(length(result_json) BETWEEN 2 AND 8192 AND json_valid(result_json) AND json_type(result_json)='object'), total INTEGER NOT NULL CHECK(typeof(total)='integer' AND total BETWEEN -9007199254740991 AND 9007199254740991),
      resolved_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at)=resolved_at AND substr(resolved_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,actor_id,command_id),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_receipts_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,target_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_power_uses_v26 (
      power_use_id TEXT PRIMARY KEY CHECK(length(power_use_id) BETWEEN 1 AND 128 AND power_use_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      power_pack_id TEXT NOT NULL, power_pack_version TEXT NOT NULL, power_kind TEXT NOT NULL CHECK(power_kind IN ('ability','spell')), power_definition_id TEXT NOT NULL,
      slot_kind TEXT NOT NULL CHECK(slot_kind IN ('none','slot','charge','resource')), slot_level INTEGER CHECK(typeof(slot_level)='integer' AND slot_level BETWEEN 0 AND 20),
      target_actor_id TEXT, use_json TEXT NOT NULL CHECK(length(use_json) BETWEEN 2 AND 8192 AND json_valid(use_json) AND json_type(use_json)='object'),
      used_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',used_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',used_at)=used_at AND substr(used_at,12,2) BETWEEN '00' AND '23'),
      CHECK((slot_kind='slot' AND slot_level IS NOT NULL) OR (slot_kind<>'slot' AND slot_level IS NULL)), UNIQUE(campaign_id,actor_id,command_id),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_receipts_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,target_actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,power_pack_id,power_pack_version,power_kind,power_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_power_use_costs_v26 (
      power_use_id TEXT NOT NULL, cost_ordinal INTEGER NOT NULL CHECK(typeof(cost_ordinal)='integer' AND cost_ordinal BETWEEN 0 AND 31),
      cost_kind TEXT NOT NULL CHECK(cost_kind IN ('slot','charge','resource')), resource_name TEXT NOT NULL CHECK(length(resource_name) BETWEEN 1 AND 128 AND resource_name=trim(resource_name)), amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 1 AND 1000000),
      PRIMARY KEY(power_use_id,cost_ordinal),
      FOREIGN KEY(power_use_id) REFERENCES rpg_power_uses_v26(power_use_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_effect_modifier_vocabulary_v26 (
      modifier_kind TEXT PRIMARY KEY CHECK(modifier_kind IN ('flat','proficiency','advantage','resistance','vulnerability','immunity'))
    );
    INSERT INTO rpg_effect_modifier_vocabulary_v26(modifier_kind) VALUES ('flat'),('proficiency'),('advantage'),('resistance'),('vulnerability'),('immunity');
    CREATE TABLE rpg_active_effects_v26 (
      effect_id TEXT PRIMARY KEY CHECK(length(effect_id) BETWEEN 1 AND 128 AND effect_id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      source_pack_id TEXT, source_pack_version TEXT, source_kind TEXT CHECK(source_kind IS NULL OR source_kind IN ('ability','spell')), source_definition_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','removed','expired')), concentration_key TEXT,
      duration_kind TEXT NOT NULL CHECK(duration_kind IN ('until_removed','rounds','until_timestamp')), remaining_rounds INTEGER, expires_at TEXT,
      recovery_kind TEXT NOT NULL CHECK(recovery_kind IN ('none','short_rest','long_rest')), state_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(state_revision)='integer' AND state_revision BETWEEN 0 AND 9007199254740991), last_lifecycle_event_id TEXT,
      applied_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',applied_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',applied_at)=applied_at AND substr(applied_at,12,2) BETWEEN '00' AND '23'), updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'), ended_at TEXT CHECK(ended_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ',ended_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',ended_at)=ended_at AND substr(ended_at,12,2) BETWEEN '00' AND '23')),
      CHECK((source_pack_id IS NULL AND source_pack_version IS NULL AND source_kind IS NULL AND source_definition_id IS NULL) OR (source_pack_id IS NOT NULL AND source_pack_version IS NOT NULL AND source_kind IS NOT NULL AND source_definition_id IS NOT NULL)),
      CHECK((duration_kind='rounds' AND remaining_rounds BETWEEN 0 AND 100000 AND expires_at IS NULL) OR (duration_kind='until_timestamp' AND remaining_rounds IS NULL AND expires_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at AND substr(expires_at,12,2) BETWEEN '00' AND '23') OR (duration_kind='until_removed' AND remaining_rounds IS NULL AND expires_at IS NULL)),
      CHECK((status='active' AND ended_at IS NULL) OR (status<>'active' AND ended_at IS NOT NULL)),
      UNIQUE(campaign_id,actor_id,command_id),
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_receipts_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,source_pack_id,source_pack_version,source_kind,source_definition_id) REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE UNIQUE INDEX uq_rpg_active_effects_v26_concentration ON rpg_active_effects_v26(campaign_id,actor_id,concentration_key) WHERE status='active' AND concentration_key IS NOT NULL;
    CREATE TABLE rpg_effect_lifecycle_events_v26 (
      lifecycle_event_id TEXT PRIMARY KEY CHECK(length(lifecycle_event_id) BETWEEN 1 AND 128 AND lifecycle_event_id NOT GLOB '*[^A-Za-z0-9._:-]*'), effect_id TEXT NOT NULL, campaign_id TEXT NOT NULL, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      lifecycle_kind TEXT NOT NULL CHECK(lifecycle_kind IN ('applied','removed','concentration_replaced','duration_advanced')), remaining_rounds INTEGER CHECK(remaining_rounds IS NULL OR (typeof(remaining_rounds)='integer' AND remaining_rounds BETWEEN 0 AND 100000)),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,actor_id,command_id,effect_id),
      FOREIGN KEY(effect_id) REFERENCES rpg_active_effects_v26(effect_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id,command_id,resulting_revision) REFERENCES rpg_m16_receipts_v26(campaign_id,actor_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE rpg_effect_modifiers_v26 (
      effect_id TEXT NOT NULL, modifier_ordinal INTEGER NOT NULL CHECK(typeof(modifier_ordinal)='integer' AND modifier_ordinal BETWEEN 0 AND 127),
      modifier_kind TEXT NOT NULL CHECK(modifier_kind IN ('flat','proficiency','advantage','resistance','vulnerability','immunity')), applies_to_id TEXT NOT NULL CHECK(length(applies_to_id) BETWEEN 1 AND 128 AND applies_to_id=trim(applies_to_id)),
      amount INTEGER CHECK(typeof(amount)='integer' AND amount BETWEEN -10000 AND 10000),
      PRIMARY KEY(effect_id,modifier_ordinal),
      FOREIGN KEY(effect_id) REFERENCES rpg_active_effects_v26(effect_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(modifier_kind) REFERENCES rpg_effect_modifier_vocabulary_v26(modifier_kind) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK((modifier_kind='flat' AND amount IS NOT NULL) OR (modifier_kind='proficiency' AND amount BETWEEN 0 AND 10000) OR (modifier_kind IN ('advantage','resistance','vulnerability','immunity') AND amount IS NULL))
    );
    CREATE TABLE rpg_checks_powers_effects_layout_attestation_v26 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), prior_layout_digest TEXT NOT NULL CHECK(length(prior_layout_digest)=64), current_layout_digest TEXT NOT NULL CHECK(length(current_layout_digest)=64)
    );
    CREATE TRIGGER rpg_m16_mutation_revisions_v26_revision_guard BEFORE UPDATE ON rpg_m16_mutation_revisions_v26 WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.actor_id<>OLD.actor_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at BEGIN SELECT RAISE(ABORT,'M1.6 mutation revision must advance exactly once'); END;
    CREATE TRIGGER rpg_m16_mutation_revisions_v26_retain_delete BEFORE DELETE ON rpg_m16_mutation_revisions_v26 BEGIN SELECT RAISE(ABORT,'M1.6 mutation revisions are retained'); END;
    CREATE TRIGGER rpg_m16_commands_v26_immutable_update BEFORE UPDATE ON rpg_m16_commands_v26 BEGIN SELECT RAISE(ABORT,'M1.6 commands are immutable'); END;
    CREATE TRIGGER rpg_m16_commands_v26_immutable_delete BEFORE DELETE ON rpg_m16_commands_v26 BEGIN SELECT RAISE(ABORT,'M1.6 commands are immutable'); END;
    CREATE TRIGGER rpg_m16_receipts_v26_immutable_update BEFORE UPDATE ON rpg_m16_receipts_v26 BEGIN SELECT RAISE(ABORT,'M1.6 receipts are immutable'); END;
    CREATE TRIGGER rpg_m16_receipts_v26_immutable_delete BEFORE DELETE ON rpg_m16_receipts_v26 BEGIN SELECT RAISE(ABORT,'M1.6 receipts are immutable'); END;
    CREATE TRIGGER rpg_m16_events_v26_immutable_update BEFORE UPDATE ON rpg_m16_events_v26 BEGIN SELECT RAISE(ABORT,'M1.6 events are immutable'); END;
    CREATE TRIGGER rpg_m16_events_v26_immutable_delete BEFORE DELETE ON rpg_m16_events_v26 BEGIN SELECT RAISE(ABORT,'M1.6 events are immutable'); END;
    CREATE TRIGGER rpg_check_results_v26_immutable_update BEFORE UPDATE ON rpg_check_results_v26 BEGIN SELECT RAISE(ABORT,'check results are immutable'); END;
    CREATE TRIGGER rpg_check_results_v26_immutable_delete BEFORE DELETE ON rpg_check_results_v26 BEGIN SELECT RAISE(ABORT,'check results are immutable'); END;
    CREATE TRIGGER rpg_power_uses_v26_immutable_update BEFORE UPDATE ON rpg_power_uses_v26 BEGIN SELECT RAISE(ABORT,'power uses are immutable'); END;
    CREATE TRIGGER rpg_power_uses_v26_immutable_delete BEFORE DELETE ON rpg_power_uses_v26 BEGIN SELECT RAISE(ABORT,'power uses are immutable'); END;
    CREATE TRIGGER rpg_power_use_costs_v26_immutable_update BEFORE UPDATE ON rpg_power_use_costs_v26 BEGIN SELECT RAISE(ABORT,'power use costs are immutable'); END;
    CREATE TRIGGER rpg_power_use_costs_v26_immutable_delete BEFORE DELETE ON rpg_power_use_costs_v26 BEGIN SELECT RAISE(ABORT,'power use costs are immutable'); END;
    CREATE TRIGGER rpg_effect_lifecycle_events_v26_immutable_update BEFORE UPDATE ON rpg_effect_lifecycle_events_v26 BEGIN SELECT RAISE(ABORT,'effect lifecycle events are immutable'); END;
    CREATE TRIGGER rpg_effect_lifecycle_events_v26_immutable_delete BEFORE DELETE ON rpg_effect_lifecycle_events_v26 BEGIN SELECT RAISE(ABORT,'effect lifecycle events are immutable'); END;
    CREATE TRIGGER rpg_effect_lifecycle_events_v26_require_command BEFORE INSERT ON rpg_effect_lifecycle_events_v26
      WHEN NOT EXISTS(SELECT 1 FROM rpg_m16_commands_v26 command WHERE command.campaign_id=NEW.campaign_id AND command.actor_id=NEW.actor_id AND command.command_id=NEW.command_id AND command.resulting_revision=NEW.resulting_revision AND ((NEW.lifecycle_kind='applied' AND command.command_type='apply_effect') OR (NEW.lifecycle_kind='concentration_replaced' AND command.command_type='apply_effect') OR (NEW.lifecycle_kind='removed' AND command.command_type='remove_effect') OR (NEW.lifecycle_kind='duration_advanced' AND command.command_type='advance_effect_duration')))
      BEGIN SELECT RAISE(ABORT,'effect lifecycle event must match its exact command'); END;
    CREATE TRIGGER rpg_active_effects_v26_lifecycle_guard BEFORE UPDATE ON rpg_active_effects_v26
      WHEN NEW.effect_id<>OLD.effect_id OR NEW.campaign_id<>OLD.campaign_id OR NEW.actor_id<>OLD.actor_id OR NEW.command_id<>OLD.command_id OR NEW.resulting_revision<>OLD.resulting_revision OR NEW.applied_at<>OLD.applied_at OR NEW.state_revision<>OLD.state_revision+1 OR NEW.updated_at<OLD.updated_at OR NEW.last_lifecycle_event_id IS NULL OR NOT EXISTS(SELECT 1 FROM rpg_effect_lifecycle_events_v26 event WHERE event.lifecycle_event_id=NEW.last_lifecycle_event_id AND event.effect_id=NEW.effect_id AND event.campaign_id=NEW.campaign_id AND event.actor_id=NEW.actor_id AND event.occurred_at=NEW.updated_at AND ((NOT (NEW.remaining_rounds IS OLD.remaining_rounds) AND event.lifecycle_kind='duration_advanced') OR (NEW.remaining_rounds IS OLD.remaining_rounds AND NEW.status<>OLD.status AND event.lifecycle_kind IN ('removed','concentration_replaced'))))
      BEGIN SELECT RAISE(ABORT,'active effects advance only from an immutable lifecycle event'); END;
    CREATE TRIGGER rpg_effect_modifiers_v26_immutable_update BEFORE UPDATE ON rpg_effect_modifiers_v26 BEGIN SELECT RAISE(ABORT,'effect modifiers are immutable'); END;
    CREATE TRIGGER rpg_effect_modifiers_v26_immutable_delete BEFORE DELETE ON rpg_effect_modifiers_v26 BEGIN SELECT RAISE(ABORT,'effect modifiers are immutable'); END;
    CREATE TRIGGER rpg_checks_powers_effects_layout_attestation_v26_immutable_update BEFORE UPDATE ON rpg_checks_powers_effects_layout_attestation_v26 BEGIN SELECT RAISE(ABORT,'v26 layout attestation is immutable'); END;
    CREATE TRIGGER rpg_checks_powers_effects_layout_attestation_v26_immutable_delete BEFORE DELETE ON rpg_checks_powers_effects_layout_attestation_v26 BEGIN SELECT RAISE(ABORT,'v26 layout attestation is immutable'); END;
  `);
  const current = checksPowersEffectsLayoutDigestV26(db);
  db.prepare("INSERT INTO rpg_checks_powers_effects_layout_attestation_v26(singleton,prior_layout_digest,current_layout_digest) VALUES(1,?,?)").run(V25_RESOURCES_INVENTORY_ECONOMY_LAYOUT_DIGEST, current);
}
export const V26_CHECKS_POWERS_EFFECTS_LAYOUT_DIGEST = "7e3fe64f425173022d119f156f60eb36b26af2c97f29d40975f5579caa660f6a";
function checksPowersEffectsLayoutRowsV26(db: DatabaseDriver.Database): unknown[] { return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name GLOB '*_v26' OR name GLOB '*_v26_*' OR tbl_name GLOB '*_v26' OR tbl_name GLOB '*_v26_*') ORDER BY type,name`).all(); }
function checksPowersEffectsLayoutDigestV26(db: DatabaseDriver.Database): string { const rows = (checksPowersEffectsLayoutRowsV26(db) as Array<any>).map((row) => ({...row, sql: row.sql?.replace(/\s+/g, " ").trim()})); return createHash("sha256").update(canonicalV17(rows)).digest("hex"); }
export function assertChecksPowersEffectsLayoutV26(db: DatabaseDriver.Database): void { const row = db.prepare("SELECT prior_layout_digest,current_layout_digest FROM rpg_checks_powers_effects_layout_attestation_v26 WHERE singleton=1").get() as any; const actual = checksPowersEffectsLayoutDigestV26(db); if (!row || row.prior_layout_digest !== V25_RESOURCES_INVENTORY_ECONOMY_LAYOUT_DIGEST || row.current_layout_digest !== actual || actual !== V26_CHECKS_POWERS_EFFECTS_LAYOUT_DIGEST) throw new Error(`schema v26 checks/powers/effects canonical SQL is incompatible (${actual})`); }
export function validateM16PersistenceV26(db: DatabaseDriver.Database): void {
  const commands = db.prepare(`SELECT command.*,receipt.resulting_revision receipt_revision,receipt.occurred_at FROM rpg_m16_commands_v26 command LEFT JOIN rpg_m16_receipts_v26 receipt ON receipt.campaign_id=command.campaign_id AND receipt.actor_id=command.actor_id AND receipt.command_id=command.command_id ORDER BY command.campaign_id,command.actor_id,command.resulting_revision`).all() as Array<any>;
  if (commands.length !== (db.prepare("SELECT count(*) count FROM rpg_m16_receipts_v26").get() as {count:number}).count) throw new Error("M1.6 command receipt graph is incomplete");
  for (const command of commands) { let request:any; try { request=JSON.parse(command.canonical_request_json); } catch { throw new Error("M1.6 command provenance is malformed"); } if (command.canonical_request_json!==canonicalV17(request) || command.request_digest!==createHash("sha256").update(canonicalV17(request)).digest("hex") || command.receipt_revision!==command.resulting_revision || command.occurred_at!==command.created_at) throw new Error("M1.6 command receipt provenance is inconsistent"); }
  const roots=db.prepare("SELECT * FROM rpg_m16_mutation_revisions_v26 ORDER BY campaign_id,actor_id").all() as Array<any>;
  for (const root of roots) { const history=db.prepare("SELECT expected_revision,resulting_revision,created_at FROM rpg_m16_commands_v26 WHERE campaign_id=? AND actor_id=? ORDER BY resulting_revision").all(root.campaign_id,root.actor_id) as Array<any>; if(history.length!==root.revision || history.some((row,index)=>row.expected_revision!==index || row.resulting_revision!==index+1) || (history.length>0 && root.updated_at!==history.at(-1)!.created_at)) throw new Error("M1.6 revision root history is inconsistent"); }
}
export function migrate25to26(db: DatabaseDriver.Database): void { db.transaction(() => { assertResourcesInventoryEconomyRestLayoutV25(db); validateM15PersistenceV25(db); createChecksPowersEffectsV26(db); db.prepare("UPDATE meta SET value='26' WHERE key='schemaVersion'").run(); })(); }
