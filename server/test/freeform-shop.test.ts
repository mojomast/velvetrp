import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  FreeformShopConflictError,
  classifyFreeformShop,
  freeformShopId,
} from "../src/repo/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

const openDb = (): DatabaseDriver.Database => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const countOf = (db: DatabaseDriver.Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

type ReachableItem = { packId: string; packVersion: string; definitionId: string; json: string };

/** The campaign's publicly reachable, pinned item catalog: the only allowable shop source. */
function reachableItems(db: DatabaseDriver.Database, campaignId: string): ReachableItem[] {
  return db.prepare(`SELECT visibility.pack_id packId,visibility.pack_version packVersion,
      visibility.definition_id definitionId,visibility.public_definition_json json
    FROM campaign_catalog_current_pins pin
    JOIN rpg_catalog_definition_visibility visibility
      ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
    WHERE pin.campaign_id=? AND visibility.kind='item' AND visibility.publicly_reachable=1
    ORDER BY visibility.pack_id,visibility.pack_version,visibility.definition_id`).all(campaignId) as ReachableItem[];
}

/**
 * Seeds one public merchant NPC ("Mara") through the ordinary generation accept
 * path, so the free-form shop classifier has a public party to attach a stall to.
 */
function seedMerchant(f: Fixture, name = "Mara"): string {
  const key = "merchant-mara";
  const content = generatedCampaignContentProviderSchema.parse({
    npcs: [{ key, name, archetype: "Merchant", description: "A public merchant of the district.", visibility: "public" }],
  });
  const context = f.repo.getCampaignGenerationContext(OWNER, f.campaign.id, [])!;
  const draft = f.repo.createGenerationDraft(OWNER, {
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision,
    idempotencyKey: "freeform-shop-seed-merchant",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-shop-seed-apply", selectedArtifactKeys: [key],
  });
  const db = openDb();
  const id = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key=?`).get(f.campaign.id, key) as { server_resource_id: string }).server_resource_id;
  db.close();
  return id;
}

describe("freeform shop classification", () => {
  it("bounds the candidate to exact pinned items and their catalog prices", async () => {
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    const classification = f.repo.classifyFreeformShopIntent(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId);
    expect(classification.intent).toBe("materialize-shop");
    if (classification.intent !== "materialize-shop") throw new Error("expected a materialize-shop classification");
    expect(classification.candidates).toHaveLength(1);
    const candidate = classification.candidates[0]!;
    expect(candidate.npcId).toBe(merchantId);
    expect(candidate.shopName.toLowerCase()).toContain("mara");
    expect(candidate.items.length).toBeGreaterThanOrEqual(1);
    expect(candidate.items.length).toBeLessThanOrEqual(8);

    const db = openDb();
    const reachable = reachableItems(db, f.campaign.id);
    expect(reachable.length).toBeGreaterThan(0);
    for (const line of candidate.items) {
      const match = reachable.find((item) => item.packId === line.item.packId
        && item.packVersion === line.item.packVersion && item.definitionId === line.item.definitionId);
      expect(match).toBeDefined();
      expect(line.item.kind).toBe("item");
      expect((JSON.parse(match!.json) as { mechanics: { price: { amount: number } } }).mechanics.price.amount).toBe(line.unitPriceMinor);
      expect(line.quantity).toBeGreaterThanOrEqual(1);
      expect(line.quantity).toBeLessThanOrEqual(20);
    }
    db.close();
    f.repo.close();
  });

  it("is deterministic and declines merchants outside the closed candidate space", async () => {
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    expect(f.repo.classifyFreeformShopIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "no-such-merchant"))
      .toMatchObject({ intent: "none", reason: "no-merchant" });

    const merchant = { npcId: "mara", name: "Mara", visibility: "public" as const };
    const item = {
      reference: { kind: "item" as const, packId: "srd-5.1", packVersion: "1.0.0", definitionId: "srd-5.1:item:longsword" },
      name: "Longsword", unitPriceMinor: 15, currencyCode: "GP",
      currency: { kind: "currency" as const, packId: "srd-5.1", packVersion: "1.0.0", definitionId: "srd-5.1:currency:gp" },
      stackable: false,
    };
    expect(classifyFreeformShop({ identity: "cid:mara", merchant: null, items: [item], existingShopId: null }))
      .toMatchObject({ intent: "none", reason: "no-merchant" });
    expect(classifyFreeformShop({ identity: "cid:mara", merchant: { ...merchant, visibility: "gm" }, items: [item], existingShopId: null }))
      .toMatchObject({ intent: "none", reason: "merchant-not-public" });
    expect(classifyFreeformShop({ identity: "cid:mara", merchant, items: [], existingShopId: null }))
      .toMatchObject({ intent: "none", reason: "no-compatible-item" });
    expect(classifyFreeformShop({ identity: "cid:mara", merchant, items: [item], existingShopId: freeformShopId("cid:mara") }))
      .toMatchObject({ intent: "none", reason: "shop-already-exists" });

    // Deterministic identity: the same merchant always maps to the same shop/candidate.
    const first = f.repo.classifyFreeformShopIntent(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId);
    const second = f.repo.classifyFreeformShopIntent(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId);
    expect(second).toEqual(first);
    expect(() => f.repo.materializeFreeformShop(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId,
      { candidateId: "ffsc-not-a-real-candidate" })).toThrow(FreeformShopConflictError);
    f.repo.close();
  });
});

describe("freeform shop materialization", () => {
  it("materializes a public shop bound to the pinned catalog with a durable receipt", async () => {
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    const result = f.repo.materializeFreeformShop(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId);
    expect(result.status).toBe("materialized");
    if (result.status !== "materialized") throw new Error("expected a materialized shop");

    const db = openDb();
    const shop = db.prepare("SELECT name FROM rpg_shop_definitions_v25 WHERE campaign_id=? AND shop_id=?")
      .get(f.campaign.id, result.shopId) as { name: string };
    expect(shop.name).toBe(result.candidate.shopName);

    const stock = db.prepare("SELECT * FROM rpg_shop_stock_v25 WHERE campaign_id=? AND shop_id=? ORDER BY stock_id")
      .all(f.campaign.id, result.shopId) as Array<{ item_pack_id: string; item_pack_version: string; item_definition_id: string; available_quantity: number; unit_price_minor: number; currency_code: string }>;
    expect(stock).toHaveLength(result.stock.length);
    const reachable = reachableItems(db, f.campaign.id);
    for (const row of stock) {
      const match = reachable.find((item) => item.packId === row.item_pack_id
        && item.packVersion === row.item_pack_version && item.definitionId === row.item_definition_id);
      // Only exact pinned catalog items, never an invented item.
      expect(match).toBeDefined();
      const definition = JSON.parse(match!.json) as { mechanics: { price: { amount: number; currency: { packId: string; packVersion: string; definitionId: string } } } };
      // The price is exactly the catalog price, never a model/provider price.
      expect(row.unit_price_minor).toBe(definition.mechanics.price.amount);
      // The currency resolves through the campaign's exact pinned reference.
      expect(db.prepare(`SELECT 1 FROM rpg_currency_references_v25 WHERE campaign_id=? AND currency_code=?
        AND pack_id=? AND pack_version=? AND kind='currency' AND definition_id=?`)
        .get(f.campaign.id, row.currency_code, definition.mechanics.price.currency.packId,
          definition.mechanics.price.currency.packVersion, definition.mechanics.price.currency.definitionId)).toBeTruthy();
    }

    expect(db.prepare("SELECT shop_id FROM campaign_npc_shop_bindings_v57 WHERE campaign_id=? AND npc_id=?")
      .get(f.campaign.id, merchantId)).toEqual({ shop_id: result.shopId });

    // Durable campaign-content command + receipt for the whole materialization.
    expect(result.contentReceiptId).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?")
      .get(f.campaign.id, result.draftId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(result.contentReceiptId, result.draftId)).toBeTruthy();

    // The player-facing shop notice is public canon.
    expect(db.prepare(`SELECT visibility FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore'`).get(f.campaign.id, result.draftId))
      .toEqual({ visibility: "public" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });

  it("converges exactly once on replay", async () => {
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    const first = f.repo.materializeFreeformShop(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId);
    const second = f.repo.materializeFreeformShop(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId);
    expect(first.status).toBe("materialized");
    expect(second.status).toBe("materialized");
    if (first.status !== "materialized" || second.status !== "materialized") throw new Error("expected materializations");
    expect(second.shopId).toBe(first.shopId);
    expect(second.draftId).toBe(first.draftId);
    expect(second.contentReceiptId).toBe(first.contentReceiptId);
    expect(second.stock).toEqual(first.stock);
    expect(second.bindingCreated).toBe(false);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_definitions_v25 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-shop-draft-%'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_npc_shop_bindings_v57 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_stock_v25 WHERE campaign_id=?", f.campaign.id)).toBe(first.stock.length);
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?", f.campaign.id, first.draftId)).toBe(1);
    db.close();
    expect(f.repo.classifyFreeformShopIntent(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId))
      .toMatchObject({ intent: "none", reason: "shop-already-exists" });
    f.repo.close();
  });

  it("fails closed when the pinned catalog has no compatible item", async () => {
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    const db = openDb();
    // The catalog projection is immutable by design; drop its update guard to corrupt this
    // isolated fixture into a "no reachable item" catalog for the fail-closed path.
    db.exec("DROP TRIGGER rpg_catalog_visibility_immutable_update");
    db.prepare("UPDATE rpg_catalog_definition_visibility SET publicly_reachable=0 WHERE kind='item'").run();
    const before = countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=?", f.campaign.id);
    expect(f.repo.classifyFreeformShopIntent(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId))
      .toMatchObject({ intent: "none", reason: "no-compatible-item" });
    expect(f.repo.materializeFreeformShop(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId))
      .toEqual({ status: "declined", reason: "no-compatible-item" });
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_definitions_v25 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_stock_v25 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=?", f.campaign.id)).toBe(before);
    db.close();
    f.repo.close();
  });

  it("rolls the whole materialization back when a shop write fails", async () => {
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    const db = openDb();
    const baselineContentCommands = countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=?", f.campaign.id);
    // Fail after the public notice is staged and applied, at the shop-stock write.
    db.exec(`CREATE TRIGGER freeform_shop_inject_failure BEFORE INSERT ON rpg_shop_stock_v25
      BEGIN SELECT RAISE(ABORT,'injected freeform shop failure'); END;`);
    expect(() => f.repo.materializeFreeformShop(OWNER, f.campaign.id, f.session.id, f.actorId, merchantId)).toThrow();
    db.exec("DROP TRIGGER freeform_shop_inject_failure");

    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_definitions_v25 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_stock_v25 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM campaign_npc_shop_bindings_v57 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-shop-draft-%'", f.campaign.id)).toBe(0);
    expect(countOf(db, `SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore'`, f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=?", f.campaign.id)).toBe(baselineContentCommands);
    db.close();
    f.repo.close();
  });
});
