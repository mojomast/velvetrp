import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { ActorResourceAuthorizationError, ActorResourceConflictError, ActorResourceNegativeError, ActorResourceStaleError, EconomyConflictError, InventoryBindingError, InventoryCapacityError, InventorySlotConflictError, QuoteExpiredError, RestIllegalStateError, ShopStockExhaustedError, TradeStaleError, createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const now = "2035-01-01T00:00:00.000Z";
const item = { kind: "item" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId, packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:item:waylamp" };
const currency = { kind: "currency" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId, packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:currency:glimmer" };
const scores: CharacterBuilderAttributeScores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as CharacterBuilderAttributeScores;

/** Build genuine campaign actors, then use a second SQLite connection only for v25 fixture state. */
function fixture() {
  let time = new Date(now);
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => time } });
  const campaign = repo.createCampaign("local-owner", { name: "M1.5 facade fixture" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const makeActor = (name: string, key: string) => {
    const persona = repo.createCharacter({ name, age: 28, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${key}-draft` });
    const definitions = MECHANICS_STARTER_CATALOG.definitions;
    const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: `${key}-select`, selections: {
      race: definitions.find((x) => x.reference.kind === "race")!.reference as any,
      background: definitions.find((x) => x.reference.kind === "background")!.reference as any,
      class: definitions.find((x) => x.reference.kind === "class")!.reference as any, starterGrant: "kit",
    } } as any);
    return repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `${key}-final` }).receipt.actorId;
  };
  const actor = makeActor("Aster", "a");
  const recipient = makeActor("Briar", "b");
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys = ON");
  const seedResource = (actorId: string, name: string, current: number, max: number) => db.prepare("INSERT OR REPLACE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,?,?,?)").run(campaign.id, actorId, name, current, max);
  seedResource(actor, "health", 5, 10); seedResource(actor, "focus", 1, 4); seedResource(actor, "grit", 1, 3); seedResource(recipient, "health", 7, 10);
  for (const principal of ["source-player", "recipient-player", "third-player"]) {
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(principal, principal);
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?, 'player',?)").run(campaign.id, principal, now);
  }
  db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id=? WHERE actor_id=?").run("source-player", actor);
  db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id=? WHERE actor_id=?").run("recipient-player", recipient);
    for (const reference of [item, currency]) db.prepare("INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25 VALUES(?,?,?,?,?)").run(campaign.id, reference.packId, reference.packVersion, reference.kind, reference.definitionId);
    db.prepare("INSERT OR REPLACE INTO rpg_currency_references_v25 VALUES(?,?,?,?,?,?)").run(campaign.id, "GLM", currency.packId, currency.packVersion, "currency", currency.definitionId);
   db.prepare("INSERT OR REPLACE INTO rpg_wallets_v25 VALUES(?,?,?,?,?)").run(campaign.id, actor, "GLM", 30, now);
   db.prepare("INSERT OR REPLACE INTO rpg_wallets_v25 VALUES(?,?,?,?,?)").run(campaign.id, recipient, "GLM", 5, now);
  db.prepare("INSERT INTO rpg_shop_definitions_v25 VALUES(?,?,?,?)").run("shop", campaign.id, "Lamplighter", now);
   db.prepare("INSERT INTO rpg_shop_stock_v25 VALUES(?,?,?,?,?,?,?,?,?,?)").run("stock", campaign.id, "shop", item.packId, item.packVersion, "item", item.definitionId, 3, 10, "GLM");
  db.close();
  return { repo, campaign: campaign.id, actor, recipient, sourcePlayer: "source-player", recipientPlayer: "recipient-player", thirdPlayer: "third-player", advance: () => { time = new Date(time.getTime() + 301_000); } };
}

function databaseState(f: ReturnType<typeof fixture>) {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
  const state = {
    inventory: db.prepare("SELECT actor_id,entry_id,quantity,entry_mode FROM rpg_inventory_entries_v25 ORDER BY actor_id,entry_id").all(),
    wallets: db.prepare("SELECT actor_id,currency_code,balance_minor FROM rpg_wallets_v25 ORDER BY actor_id,currency_code").all(),
    stock: db.prepare("SELECT stock_id,available_quantity FROM rpg_shop_stock_v25 ORDER BY stock_id").all(),
    trades: db.prepare("SELECT trade_id,status FROM rpg_trade_proposals_v25 ORDER BY trade_id").all(),
    revisions: db.prepare("SELECT actor_id,revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? ORDER BY actor_id").all(f.campaign),
    restReceipts: db.prepare("SELECT count(*) count FROM rpg_rest_receipts_v25").get(),
  };
  db.close();
  return state;
}

describe("M1.5 repository facades", () => {
  it("mutates bounded resources, exposes sidecars, and preserves exact retry/conflict semantics", () => {
    const f = fixture(); const command = { type: "change_actor_resource" as const, campaignId: f.campaign, actorId: f.actor, resourceId: "health", amount: 3, expectedRevision: 0, idempotencyKey: "heal" };
    const healed = f.repo.mutateActorResource("local-owner", command);
    expect(healed.resources.find((r) => r.resourceId === "health")).toMatchObject({ current: 8, capacity: 10 });
    expect(healed.receipt.changedKeys).toEqual(["resource:health"]);
    expect(f.repo.mutateActorResource("local-owner", command)).toEqual(healed);
    expect(() => f.repo.mutateActorResource("local-owner", { ...command, amount: 2 })).toThrow(ActorResourceConflictError);
    expect(() => f.repo.mutateActorResource("local-owner", { ...command, idempotencyKey: "stale", expectedRevision: 0 })).toThrow(ActorResourceStaleError);
    expect(() => f.repo.mutateActorResource("local-owner", { ...command, amount: -20, expectedRevision: 1, idempotencyKey: "negative" })).toThrow(ActorResourceNegativeError);
    expect(f.repo.getM15ActorResources("local-owner", f.campaign, f.actor).find((r) => r.resourceId === "health")!.current).toBe(8);
    f.repo.mutateActorResource("local-owner", { type: "set_actor_resource_charges", campaignId: f.campaign, actorId: f.actor, resourceId: "focus", current: 2, capacity: 3, expectedRevision: 1, idempotencyKey: "charges" });
    f.repo.mutateActorResource("local-owner", { type: "set_actor_resource_ammunition", campaignId: f.campaign, actorId: f.actor, resourceId: "focus", current: 1, capacity: 8, expectedRevision: 2, idempotencyKey: "ammo" });
    f.repo.mutateActorResource("local-owner", { type: "set_actor_resource_binding", campaignId: f.campaign, actorId: f.actor, resourceId: "focus", binding: { kind: "ability", recovery: "short-rest" }, expectedRevision: 3, idempotencyKey: "binding" });
    expect(f.repo.getActorResourceCharges("local-owner", f.campaign, f.actor, "focus")?.charges).toEqual({ current: 2, capacity: 3 });
    expect(f.repo.getActorResourceAmmunition("local-owner", f.campaign, f.actor, "focus")?.ammunition).toEqual({ current: 1, capacity: 8 });
    expect(f.repo.getActorResourceBinding("local-owner", f.campaign, f.actor, "focus")?.binding.recovery).toBe("short-rest");
    expect(() => f.repo.mutateActorResource("local-owner", { type: "set_actor_resource_capacity", campaignId: f.campaign, actorId: f.actor, resourceId: "health", capacity: 7, expectedRevision: 4, idempotencyKey: "too-small" })).toThrow(ActorResourceConflictError);
    f.repo.close();
  });

  it("keeps stack and instance identity, enforces equipment/capacity/binding, and advances recipient transfer revision", () => {
    const f = fixture();
    const add = (entryId: string, kind: "stackable" | "instanced", revision: number) => f.repo.mutateInventory("local-owner", { type: "add_inventory_item", campaignId: f.campaign, actorId: f.actor, expectedRevision: revision, idempotencyKey: entryId, item: kind === "stackable" ? { kind, entryId, item, quantity: 2 } : { kind, entryId, item } });
    add("stack", "stackable", 0); add("stack-again", "stackable", 1); add("instance", "instanced", 2);
    const inventory = f.repo.getActorInventory("local-owner", f.campaign, f.actor)!.inventory.items;
    expect(inventory.find((entry) => entry.entryId === "stack")).toMatchObject({ quantity: 4 });
    expect(inventory.find((entry) => entry.entryId === "instance")).toMatchObject({ kind: "instanced" });
    f.repo.mutateInventory("local-owner", { type: "equip_inventory_item", campaignId: f.campaign, actorId: f.actor, entryId: "instance", slot: "hand", expectedRevision: 3, idempotencyKey: "equip" });
    expect(() => f.repo.mutateInventory("local-owner", { type: "equip_inventory_item", campaignId: f.campaign, actorId: f.actor, entryId: "stack", slot: "hand", expectedRevision: 4, idempotencyKey: "slot" })).toThrow(InventorySlotConflictError);
    expect(() => f.repo.mutateInventory("local-owner", { type: "transfer_inventory_item", campaignId: f.campaign, actorId: f.actor, recipientActorId: f.recipient, entryId: "instance", item, quantity: 1, expectedRevision: 4, idempotencyKey: "bound" })).toThrow(InventoryBindingError);
    f.repo.mutateInventory("local-owner", { type: "unequip_inventory_item", campaignId: f.campaign, actorId: f.actor, slot: "hand", expectedRevision: 4, idempotencyKey: "unequip" });
    const transfer = f.repo.mutateInventory("local-owner", { type: "transfer_inventory_item", campaignId: f.campaign, actorId: f.actor, recipientActorId: f.recipient, entryId: "instance", item, quantity: 1, expectedRevision: 5, idempotencyKey: "transfer" });
    expect(transfer.receipt.changedKeys).toEqual([`inventory:${f.actor}`, `inventory:${f.recipient}`].sort());
    expect(f.repo.getActorInventory("local-owner", f.campaign, f.recipient)!.inventory.items).toMatchObject([{ entryId: "instance", kind: "instanced" }]);
    expect(() => f.repo.mutateInventory("local-owner", { type: "set_inventory_capacity", campaignId: f.campaign, actorId: f.actor, capacity: 0, expectedRevision: 6, idempotencyKey: "small" })).toThrow(InventoryCapacityError);
    f.repo.close();
  });

  it("projects wallet/shop and makes purchases and bilateral trades atomic with guard rollback", () => {
    const f = fixture();
    expect(f.repo.getWallet("local-owner", f.campaign, f.actor)?.balances[0]).toMatchObject({ minorUnits: 30, currency });
    expect(f.repo.getShop("local-owner", f.campaign, "shop")?.stock[0]).toMatchObject({ quantity: 3, item });
    const quote = f.repo.mutateEconomy("local-owner", { type: "request_purchase_quote", campaignId: f.campaign, buyerActorId: f.actor, shopId: "shop", item, quantity: 2, expectedRevision: 0, idempotencyKey: "quote" });
    const quoteId = (quote.quote as any).quoteId;
    const purchase = { type: "purchase_from_shop" as const, campaignId: f.campaign, buyerActorId: f.actor, quoteId, expectedRevision: 1, idempotencyKey: "buy" };
    expect(f.repo.mutateEconomy("local-owner", purchase)).toEqual(f.repo.mutateEconomy("local-owner", purchase));
    expect(f.repo.getWallet("local-owner", f.campaign, f.actor)?.balances[0]?.minorUnits).toBe(10);
    expect(f.repo.getActorInventory("local-owner", f.campaign, f.actor)!.inventory.items).toMatchObject([{ quantity: 2, item }]);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(db.prepare("SELECT count(*) count FROM rpg_currency_ledger_v25 WHERE actor_id=?").get(f.actor)).toEqual({ count: 1 }); expect(db.prepare("SELECT count(*) count FROM rpg_purchase_receipts_v25").get()).toEqual({ count: 1 }); db.close();
    const expired = f.repo.mutateEconomy("local-owner", { type: "request_purchase_quote", campaignId: f.campaign, buyerActorId: f.actor, shopId: "shop", item, quantity: 1, expectedRevision: 2, idempotencyKey: "expired-quote" }); f.advance();
    expect(() => f.repo.mutateEconomy("local-owner", { type: "purchase_from_shop", campaignId: f.campaign, buyerActorId: f.actor, quoteId: (expired.quote as any).quoteId, expectedRevision: 3, idempotencyKey: "expired-buy" })).toThrow(QuoteExpiredError);
    expect(f.repo.getShop("local-owner", f.campaign, "shop")!.stock[0]!.quantity).toBe(1);
    expect(() => f.repo.mutateEconomy("local-owner", { type: "request_purchase_quote", campaignId: f.campaign, buyerActorId: f.actor, shopId: "shop", item, quantity: 9, expectedRevision: 3, idempotencyKey: "stock" })).toThrow(ShopStockExhaustedError);
    const trade = { tradeId: "trade", campaignId: f.campaign, offeredByActorId: f.actor, acceptedByActorId: f.recipient, offeredItems: [], requestedItems: [], offeredCurrency: [{ currency, minorUnits: 4 }], requestedCurrency: [{ currency, minorUnits: 2 }] };
    f.repo.mutateEconomy("local-owner", { type: "propose_bilateral_trade", campaignId: f.campaign, trade, expectedRevision: 3, idempotencyKey: "offer" });
    expect(f.repo.mutateEconomy("local-owner", { type: "accept_bilateral_trade", campaignId: f.campaign, tradeId: "trade", acceptedByActorId: f.recipient, expectedRevision: 1, idempotencyKey: "accept" }).trade).toEqual({ tradeId: "trade", status: "settled" });
    expect(f.repo.getWallet("local-owner", f.campaign, f.actor)?.balances[0]?.minorUnits).toBe(8); expect(f.repo.getWallet("local-owner", f.campaign, f.recipient)?.balances[0]?.minorUnits).toBe(7);
    f.repo.close();
  });

  it("applies short and long rest recovery only to bound resources and records every changed resource", () => {
    const f = fixture();
    const bind = (resourceId: string, recovery: "short-rest" | "long-rest", revision: number) => f.repo.mutateActorResource("local-owner", { type: "set_actor_resource_binding", campaignId: f.campaign, actorId: f.actor, resourceId, binding: { kind: "ability", recovery }, expectedRevision: revision, idempotencyKey: `bind-${resourceId}` });
    bind("health", "long-rest", 0); bind("focus", "short-rest", 1);
    const short = f.repo.takeRest("local-owner", { type: "take_short_rest", campaignId: f.campaign, actorId: f.actor, expectedRevision: 2, idempotencyKey: "short" });
    expect(short.rest.recovery.resources).toEqual([{ resourceId: "focus", before: 1, after: 4 }]);
    const long = f.repo.takeRest("local-owner", { type: "take_long_rest", campaignId: f.campaign, actorId: f.actor, expectedRevision: 3, idempotencyKey: "long" });
    expect(long.rest.recovery.resources).toEqual([{ resourceId: "health", before: 5, after: 10 }]);
    expect(f.repo.listRestReceipts("local-owner", f.campaign, f.actor)).toHaveLength(2);
    expect(() => f.repo.takeRest("local-owner", { type: "take_long_rest", campaignId: f.campaign, actorId: f.actor, expectedRevision: 4, idempotencyKey: "illegal" })).toThrow(RestIllegalStateError);
    f.repo.close();
  });

  it("lets a source player gift without recipient control and makes the recipient's cross-actor revision observable", () => {
    const f = fixture();
    f.repo.mutateInventory(f.sourcePlayer, { type: "add_inventory_item", campaignId: f.campaign, actorId: f.actor, expectedRevision: 0, idempotencyKey: "gift-item", item: { kind: "instanced", entryId: "gift-instance", item } });
    const gift = f.repo.mutateInventory(f.sourcePlayer, { type: "transfer_inventory_item", campaignId: f.campaign, actorId: f.actor, recipientActorId: f.recipient, entryId: "gift-instance", item, quantity: 1, expectedRevision: 1, idempotencyKey: "gift" });
    expect(gift.receipt.changedKeys).toEqual([`inventory:${f.actor}`, `inventory:${f.recipient}`].sort());
    expect(f.repo.getActorInventory(f.recipientPlayer, f.campaign, f.recipient)?.inventory.items).toMatchObject([{ entryId: "gift-instance", kind: "instanced" }]);
    expect(() => f.repo.mutateActorResource(f.recipientPlayer, { type: "change_actor_resource", campaignId: f.campaign, actorId: f.recipient, resourceId: "health", amount: 1, expectedRevision: 0, idempotencyKey: "recipient-old" })).toThrow(ActorResourceStaleError);
    expect(f.repo.mutateActorResource(f.recipientPlayer, { type: "change_actor_resource", campaignId: f.campaign, actorId: f.recipient, resourceId: "health", amount: 1, expectedRevision: 1, idempotencyKey: "recipient-current" }).receipt.revisionAfter).toBe(2);
    f.repo.close();
  });

  it("requires recipient-controller acceptance and settles the exact selected instance", () => {
    const f = fixture();
    for (const entryId of ["unoffered-instance", "offered-instance"]) f.repo.mutateInventory(f.sourcePlayer, { type: "add_inventory_item", campaignId: f.campaign, actorId: f.actor, expectedRevision: entryId === "unoffered-instance" ? 0 : 1, idempotencyKey: entryId, item: { kind: "instanced", entryId, item } });
    const trade = { tradeId: "exact-instance-trade", campaignId: f.campaign, offeredByActorId: f.actor, acceptedByActorId: f.recipient, offeredItems: [{ kind: "instanced" as const, entryId: "offered-instance", item }], requestedItems: [], offeredCurrency: [{ currency, minorUnits: 1 }], requestedCurrency: [{ currency, minorUnits: 1 }] };
    f.repo.mutateEconomy(f.sourcePlayer, { type: "propose_bilateral_trade", campaignId: f.campaign, trade, expectedRevision: 2, idempotencyKey: "exact-offer" });
    const beforeUnauthorized = databaseState(f);
    expect(() => f.repo.mutateEconomy(f.thirdPlayer, { type: "accept_bilateral_trade", campaignId: f.campaign, tradeId: trade.tradeId, acceptedByActorId: f.recipient, expectedRevision: 1, idempotencyKey: "third-accept" })).toThrow(ActorResourceAuthorizationError);
    expect(databaseState(f)).toEqual(beforeUnauthorized);
    expect(f.repo.mutateEconomy(f.recipientPlayer, { type: "accept_bilateral_trade", campaignId: f.campaign, tradeId: trade.tradeId, acceptedByActorId: f.recipient, expectedRevision: 1, idempotencyKey: "accept-exact" }).trade).toEqual({ tradeId: trade.tradeId, status: "settled" });
    expect(f.repo.getActorInventory(f.recipientPlayer, f.campaign, f.recipient)?.inventory.items.map((entry) => entry.entryId)).toContain("offered-instance");
    expect(f.repo.getActorInventory(f.sourcePlayer, f.campaign, f.actor)?.inventory.items.map((entry) => entry.entryId)).toContain("unoffered-instance");
    f.repo.close();
  });

  it("rolls back capacity and missing-asset trade failures without changing either party or the open trade", () => {
    const f = fixture();
    f.repo.mutateInventory(f.sourcePlayer, { type: "add_inventory_item", campaignId: f.campaign, actorId: f.actor, expectedRevision: 0, idempotencyKey: "capacity-item", item: { kind: "instanced", entryId: "capacity-instance", item } });
    const trade = { tradeId: "capacity-trade", campaignId: f.campaign, offeredByActorId: f.actor, acceptedByActorId: f.recipient, offeredItems: [{ kind: "instanced" as const, entryId: "capacity-instance", item }], requestedItems: [], offeredCurrency: [{ currency, minorUnits: 1 }], requestedCurrency: [{ currency, minorUnits: 1 }] };
    f.repo.mutateEconomy(f.sourcePlayer, { type: "propose_bilateral_trade", campaignId: f.campaign, trade, expectedRevision: 1, idempotencyKey: "capacity-offer" });
    f.repo.mutateInventory(f.recipientPlayer, { type: "set_inventory_capacity", campaignId: f.campaign, actorId: f.recipient, capacity: 0, expectedRevision: 1, idempotencyKey: "recipient-full" });
    const before = databaseState(f);
    expect(() => f.repo.mutateEconomy(f.recipientPlayer, { type: "accept_bilateral_trade", campaignId: f.campaign, tradeId: trade.tradeId, acceptedByActorId: f.recipient, expectedRevision: 2, idempotencyKey: "capacity-accept" })).toThrow(EconomyConflictError);
    expect(databaseState(f)).toEqual(before);
    const missing = { ...trade, tradeId: "missing-asset-trade", offeredItems: [{ kind: "instanced" as const, entryId: "missing-instance", item }] };
    f.repo.mutateEconomy(f.sourcePlayer, { type: "propose_bilateral_trade", campaignId: f.campaign, trade: missing, expectedRevision: 2, idempotencyKey: "missing-offer" });
    const beforeMissing = databaseState(f);
    expect(() => f.repo.mutateEconomy(f.recipientPlayer, { type: "accept_bilateral_trade", campaignId: f.campaign, tradeId: missing.tradeId, acceptedByActorId: f.recipient, expectedRevision: 3, idempotencyKey: "missing-accept" })).toThrow(EconomyConflictError);
    expect(databaseState(f)).toEqual(beforeMissing);
    f.repo.close();
  });

  it("persists expired cancellation once, returns its exact retry receipt, and writes no additional cancellation", () => {
    const f = fixture();
    const trade = { tradeId: "expired-trade", campaignId: f.campaign, offeredByActorId: f.actor, acceptedByActorId: f.recipient, offeredItems: [], requestedItems: [], offeredCurrency: [{ currency, minorUnits: 1 }], requestedCurrency: [{ currency, minorUnits: 1 }] };
    f.repo.mutateEconomy(f.sourcePlayer, { type: "propose_bilateral_trade", campaignId: f.campaign, trade, expectedRevision: 0, idempotencyKey: "expired-offer" });
    f.advance();
    const cancel = { type: "accept_bilateral_trade" as const, campaignId: f.campaign, tradeId: trade.tradeId, acceptedByActorId: f.recipient, expectedRevision: 1, idempotencyKey: "expired-accept" };
    const cancelled = f.repo.mutateEconomy(f.recipientPlayer, cancel);
    expect(cancelled.trade).toMatchObject({ tradeId: trade.tradeId, status: "cancelled", expired: true });
    const afterFirst = databaseState(f);
    expect(f.repo.mutateEconomy(f.recipientPlayer, cancel)).toEqual(cancelled);
    expect(databaseState(f)).toEqual(afterFirst);
    expect(() => f.repo.mutateEconomy(f.recipientPlayer, { ...cancel, idempotencyKey: "new-expired-accept", expectedRevision: 2 })).toThrow(TradeStaleError);
    f.repo.close();
  });

  it("recovers bound base, charge, and ammunition pools while preserving unbound data and illegal-rest state", () => {
    const f = fixture();
    f.repo.mutateActorResource(f.sourcePlayer, { type: "set_actor_resource_charges", campaignId: f.campaign, actorId: f.actor, resourceId: "focus", current: 1, capacity: 3, expectedRevision: 0, idempotencyKey: "focus-charges" });
    f.repo.mutateActorResource(f.sourcePlayer, { type: "set_actor_resource_ammunition", campaignId: f.campaign, actorId: f.actor, resourceId: "focus", current: 2, capacity: 8, expectedRevision: 1, idempotencyKey: "focus-ammo" });
    f.repo.mutateActorResource(f.sourcePlayer, { type: "set_actor_resource_charges", campaignId: f.campaign, actorId: f.actor, resourceId: "grit", current: 1, capacity: 2, expectedRevision: 2, idempotencyKey: "grit-charges" });
    f.repo.mutateActorResource(f.sourcePlayer, { type: "set_actor_resource_binding", campaignId: f.campaign, actorId: f.actor, resourceId: "focus", binding: { kind: "ability", recovery: "short-rest" }, expectedRevision: 3, idempotencyKey: "focus-rest" });
    f.repo.mutateActorResource(f.sourcePlayer, { type: "set_actor_resource_binding", campaignId: f.campaign, actorId: f.actor, resourceId: "health", binding: { kind: "ability", recovery: "long-rest" }, expectedRevision: 4, idempotencyKey: "health-rest" });
    const short = f.repo.takeRest(f.sourcePlayer, { type: "take_short_rest", campaignId: f.campaign, actorId: f.actor, expectedRevision: 5, idempotencyKey: "sidecar-short" });
    expect(short.rest.recovery.resources).toEqual([{ resourceId: "focus", before: 1, after: 4 }, { resourceId: "focus:charges", before: 1, after: 3 }, { resourceId: "focus:ammunition", before: 2, after: 8 }]);
    expect(f.repo.getActorResourceCharges(f.sourcePlayer, f.campaign, f.actor, "grit")?.charges).toEqual({ current: 1, capacity: 2 });
    const long = f.repo.takeRest(f.sourcePlayer, { type: "take_long_rest", campaignId: f.campaign, actorId: f.actor, expectedRevision: 6, idempotencyKey: "sidecar-long" });
    expect(long.rest.recovery.resources).toEqual([{ resourceId: "health", before: 5, after: 10 }]);
    const beforeIllegal = databaseState(f);
    expect(() => f.repo.takeRest(f.sourcePlayer, { type: "take_long_rest", campaignId: f.campaign, actorId: f.actor, expectedRevision: 7, idempotencyKey: "sidecar-illegal" })).toThrow(RestIllegalStateError);
    expect(databaseState(f)).toEqual(beforeIllegal);
    f.repo.close();
  });
});
