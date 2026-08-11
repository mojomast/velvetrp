import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY } from "@velvet/contracts";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { cleanupTmpDataDirs, makeTmpDir, removeFutureChecksPowersEffectsV26 } from "./helpers.js";

const makeDir = () => makeTmpDir("velvet-v25-");
const file = (dir: string) => path.join(dir, "velvet.sqlite");

afterEach(cleanupTmpDataDirs);
const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"]
  .map((attribute, index) => [attribute, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as {might:number;agility:number;resolve:number;insight:number;presence:number;craft:number};

function layout(dir: string): unknown[] {
  const db = new DatabaseDriver(file(dir), { readonly: true });
  const result = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return result;
}

function assertV25ForeignKeysReferenceParentKeys(db: DatabaseDriver.Database): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB '*_v25' OR name GLOB '*_v25_*')").all() as Array<{name:string}>;
  for (const { name } of tables) {
    const keys = db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{id:number;seq:number;table:string;to:string}>;
    for (const id of new Set(keys.map((key) => key.id))) {
      const foreignKey = keys.filter((key) => key.id === id).sort((left, right) => left.seq - right.seq);
      const parent = foreignKey[0]!.table;
      const parentColumns = foreignKey.map((key) => key.to);
      const tableInfo = db.prepare(`PRAGMA table_info(${parent})`).all() as Array<{name:string;pk:number}>;
      const primaryKey = tableInfo.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk).map((column) => column.name);
      const indexes = db.prepare(`PRAGMA index_list(${parent})`).all() as Array<{name:string;unique:number;partial:number}>;
      const uniqueKeys = indexes.filter((index) => index.unique === 1 && index.partial === 0)
        .map((index) => (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{name:string;seqno:number}>).sort((left, right) => left.seqno - right.seqno).map((column) => column.name));
      expect([primaryKey, ...uniqueKeys]).toContainEqual(parentColumns);
    }
  }
}

/** Deliberately rewind only the additive v25 fixture artifacts. */
function rewindToV24(dir: string): void {
  const db = new DatabaseDriver(file(dir));
  removeFutureChecksPowersEffectsV26(db);
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v25' OR name GLOB '*_v25_*')").all() as Array<{name:string}>;
  for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB '*_v25' OR name GLOB '*_v25_*')").all() as Array<{name:string}>;
  for (const { name } of tables) db.exec(`DROP TABLE ${name}`);
  db.prepare("UPDATE meta SET value='24' WHERE key='schemaVersion'").run();
  db.close();
}

/** A real command graph with a rest domain receipt and counterpart revision. */
function populatedM15(dir: string): void {
  const repo = createRepository({ dataDir: dir, clock: { now: () => new Date("2035-01-01T00:00:00.000Z") } });
  const campaign = repo.createCampaign("local-owner", { name: "M1.5 integrity" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const actor = (name:string, key:string) => {
    const persona = repo.createCharacter({ name, age: 28, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${key}-draft` });
    const definitions = MECHANICS_STARTER_CATALOG.definitions;
    const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: `${key}-select`, selections: {
      race: definitions.find((definition) => definition.reference.kind === "race")!.reference,
      background: definitions.find((definition) => definition.reference.kind === "background")!.reference,
      class: definitions.find((definition) => definition.reference.kind === "class")!.reference, starterGrant: "kit",
    } } as never);
    return repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `${key}-final` }).receipt.actorId;
  };
  const owner = actor("M15 owner", "owner"), recipient = actor("M15 recipient", "recipient");
  const item = MECHANICS_STARTER_CATALOG.definitions.find((definition) => definition.reference.kind === "item")!.reference as {kind:"item";packId:string;packVersion:string;definitionId:string};
  const db = new DatabaseDriver(file(dir));
  db.prepare("INSERT INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,?,?,?)").run(campaign.id, owner, "focus", 1, 4);
  db.prepare("INSERT INTO rpg_campaign_catalog_definitions_v25 VALUES(?,?,?,?,?)").run(campaign.id, item.packId, item.packVersion, item.kind, item.definitionId);
  db.prepare("INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at) VALUES(?,?,?,?,?,'item',?,'instanced',1,?,NULL,0,?)").run("instance", campaign.id, owner, item.packId, item.packVersion, item.definitionId, "instance", "2035-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at) VALUES(?,?,?,?,?,'item',?,'instanced',1,?,NULL,0,?)").run("discard", campaign.id, owner, item.packId, item.packVersion, item.definitionId, "discard", "2035-01-01T00:00:00.000Z");
  db.close();
  repo.mutateActorResource("local-owner", { type: "set_actor_resource_binding", campaignId: campaign.id, actorId: owner, resourceId: "focus", binding: { kind: "ability", recovery: "short-rest" }, expectedRevision: 0, idempotencyKey: "binding" });
  repo.takeRest("local-owner", { type: "take_short_rest", campaignId: campaign.id, actorId: owner, expectedRevision: 1, idempotencyKey: "rest" });
  repo.mutateInventoryForActor("local-owner", campaign.id, owner, { kind: "gift", recipientActorId: recipient, entryId: "instance", item, quantity: 1, expectedRevision: 2, idempotencyKey: "transfer" });
  repo.mutateInventoryForActor("local-owner", campaign.id, owner, { kind: "drop", entryId: "discard", item, quantity: 1, expectedRevision: 3, idempotencyKey: "discard" });
  repo.close();
}

describe("additive schema v25r1 resources, inventory, economy, and rest migration", () => {
  it("creates the same canonical v25 layout fresh and from v24", () => {
    const migrated = makeDir();
    createRepository({ dataDir: migrated }).close();
    rewindToV24(migrated);
    createRepository({ dataDir: migrated }).close();

    const db = new DatabaseDriver(file(migrated), { readonly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(db.prepare("SELECT prior_layout_digest,current_layout_digest FROM rpg_resources_inventory_economy_layout_attestation_v25").get()).toEqual({
      prior_layout_digest: "e056d9df1ec9f9c00cc1aba740f2acc91b40cc7b03a5716cb75e79ec8df6bec8",
      current_layout_digest: "a5e3a58f8014978315d20440a0ac087871edac95323d059327faa2fe0a983ef7",
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rpg_actor_resource_charges_v25'").get()).toBeTruthy();
    expect((db.prepare("PRAGMA foreign_key_list(rpg_actor_resource_charges_v25)").all() as Array<{table:string}>).map((key) => key.table))
      .toContain("campaign_actors");
    expect((db.prepare("PRAGMA foreign_key_list(rpg_actor_resource_charges_v25)").all() as Array<{table:string}>).map((key) => key.table))
      .toContain("rpg_actor_resources");
    const stockSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rpg_shop_stock_v25'").get() as {sql:string}).sql;
    const tradeSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rpg_trade_proposals_v25'").get() as {sql:string}).sql;
    expect(stockSql).toContain("UNIQUE(campaign_id,stock_id)");
    expect(tradeSql).toContain("UNIQUE(campaign_id,trade_id)");
    assertV25ForeignKeysReferenceParentKeys(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rpg_inventory_entries_v25'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rpg_currency_ledger_v25'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rpg_rest_receipts_v25'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rpg_m15_mutation_revisions_v25'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rpg_m15_commands_v25'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rpg_m15_receipts_v25'").get()).toBeTruthy();
    const currencySql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rpg_currency_references_v25'").get() as {sql:string}).sql;
    const inventorySql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rpg_inventory_entries_v25'").get() as {sql:string}).sql;
    const purchaseSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rpg_purchase_receipts_v25'").get() as {sql:string}).sql;
    const restSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rpg_rest_receipts_v25'").get() as {sql:string}).sql;
    expect(currencySql).toContain("kind TEXT NOT NULL CHECK(kind='currency')");
    expect(currencySql).toContain("REFERENCES rpg_catalog_definitions(pack_id,pack_version,kind,definition_id)");
    expect(inventorySql).toContain("REFERENCES rpg_campaign_catalog_definitions_v25");
    for (const sql of [purchaseSql, restSql]) {
      expect(sql).toContain("command_id TEXT NOT NULL");
      expect(sql).toContain("resulting_revision INTEGER NOT NULL");
      expect(sql).toContain("REFERENCES rpg_m15_receipts_v25(campaign_id,actor_id,command_id,resulting_revision)");
    }
    for (const { sql } of db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name GLOB '*_v25'").all() as Array<{sql:string}>) {
      if (!sql.includes("_at TEXT NOT NULL")) continue;
      expect(sql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ'");
      expect(sql).toContain("IS NOT NULL");
      expect(sql).toContain("BETWEEN '00' AND '23'");
    }
    db.close();

    const fresh = makeDir();
    createRepository({ dataDir: fresh }).close();
    expect(layout(migrated)).toEqual(layout(fresh));
  });

  it("rolls back the additive migration if its schema marker is rejected", () => {
    const dir = makeDir();
    createRepository({ dataDir: dir }).close();
    rewindToV24(dir);
    const blocker = new DatabaseDriver(file(dir));
    blocker.exec("CREATE TRIGGER reject_resources_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='25' BEGIN SELECT RAISE(ABORT,'reject v25 marker'); END;");
    blocker.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("reject v25 marker");
    const rolledBack = new DatabaseDriver(file(dir));
    expect(rolledBack.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "24" });
    expect(rolledBack.prepare("SELECT 1 FROM sqlite_master WHERE name='rpg_inventory_entries_v25'").get()).toBeUndefined();
    expect(rolledBack.prepare("SELECT 1 FROM sqlite_master WHERE name='rpg_m15_commands_v25'").get()).toBeUndefined();
    rolledBack.exec("DROP TRIGGER reject_resources_marker");
    rolledBack.close();
    createRepository({ dataDir: dir }).close();
  });

  it("rejects v25 canonical DDL drift at startup", () => {
    const dir = makeDir();
    createRepository({ dataDir: dir }).close();
    const db = new DatabaseDriver(file(dir));
    db.exec("DROP TRIGGER rpg_rest_receipts_v25_immutable_update; CREATE TRIGGER rpg_rest_receipts_v25_immutable_update BEFORE UPDATE ON rpg_rest_receipts_v25 BEGIN SELECT 1; END;");
    db.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("schema v25 resources/inventory/economy canonical SQL is incompatible");
  });

  it("rejects persisted M1.5 command graph corruption at startup", () => {
    const corruptions: Array<{trigger:string;sql:string}> = [
      { trigger: "rpg_m15_commands_v25_immutable_update", sql: `UPDATE rpg_m15_commands_v25 SET request_digest='${"0".repeat(64)}' WHERE rowid=(SELECT rowid FROM rpg_m15_commands_v25 ORDER BY resulting_revision LIMIT 1)` },
      { trigger: "rpg_m15_receipts_v25_immutable_delete", sql: "DELETE FROM rpg_m15_receipts_v25 WHERE rowid=(SELECT rowid FROM rpg_m15_receipts_v25 ORDER BY resulting_revision LIMIT 1)" },
      { trigger: "rpg_m15_mutation_revisions_v25_revision_guard", sql: "UPDATE rpg_m15_mutation_revisions_v25 SET revision=99 WHERE revision=4" },
      { trigger: "rpg_m15_counterpart_receipts_v25_immutable_delete", sql: "DELETE FROM rpg_m15_counterpart_receipts_v25 WHERE rowid=(SELECT rowid FROM rpg_m15_counterpart_receipts_v25 LIMIT 1)" },
      { trigger: "rpg_rest_receipts_v25_immutable_delete", sql: "DELETE FROM rpg_rest_receipts_v25 WHERE rowid=(SELECT rowid FROM rpg_rest_receipts_v25 LIMIT 1)" },
    ];
    for (const corruption of corruptions) {
      const dir = makeDir(); populatedM15(dir);
      const db = new DatabaseDriver(file(dir));
      const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(corruption.trigger) as {sql:string};
      db.pragma("foreign_keys = OFF"); db.exec(`DROP TRIGGER ${corruption.trigger}`); db.exec(corruption.sql); db.exec(trigger.sql); db.pragma("foreign_keys = ON"); db.close();
      try { createRepository({ dataDir: dir }).close(); }
      catch (error) {
        expect(String(error)).toMatch(/M1\.5 .*inconsistent|M1\.5 command receipt graph is incomplete/);
        continue;
      }
      throw new Error(`accepted M1.5 corruption ${corruption.trigger}`);
    }
  });
});
