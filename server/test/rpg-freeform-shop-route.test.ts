import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

const openDb = (): DatabaseDriver.Database => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const countOf = (db: DatabaseDriver.Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
});
const enableRpg = (): void => {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
};

/**
 * Seeds one public merchant NPC ("Mara") through the ordinary generation accept
 * path, so the free-form shop classifier has a public merchant and the campaign's
 * pinned item catalog to bind a stall to. Mirrors the fixture in
 * `server/test/freeform-shop.test.ts`.
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

const appFor = (f: Fixture) => buildApp({ campaignRepositoryFactory: () => f.repo });
const shopUrl = (campaignId: string, sessionId: string, actorId: string) =>
  `/api/rpg/v1/campaigns/${campaignId}/rooms/${sessionId}/actors/${actorId}/freeform-shop-commands`;
const post = (url: string, payload: Record<string, unknown>) => ({
  method: "POST" as const, url, headers: { "content-type": "application/json" }, payload,
});

describe("freeform shop HTTP command", () => {
  it("materializes a catalog-bound shop with a durable receipt", async () => {
    enableRpg();
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    const app = appFor(f);

    const response = await app.inject(post(
      shopUrl(f.campaign.id, f.session.id, f.actorId),
      { merchantNpcId: merchantId },
    ));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.classification).toMatchObject({ intent: "materialize-shop", merchantName: "Mara" });
    expect(body.classification.candidates).toHaveLength(1);
    expect(body.materialization.status).toBe("materialized");
    if (body.materialization.status !== "materialized") throw new Error("expected a materialized shop");
    expect(body.materialization.contentReceiptId).toBeTruthy();
    expect(body.materialization.candidate.npcId).toBe(merchantId);
    expect(body.materialization.candidate.items.length).toBeGreaterThanOrEqual(1);
    expect(body.materialization.candidate.items.length).toBeLessThanOrEqual(8);

    const db = openDb();
    expect(db.prepare("SELECT name FROM rpg_shop_definitions_v25 WHERE campaign_id=? AND shop_id=?")
      .get(f.campaign.id, body.materialization.shopId)).toEqual({ name: body.materialization.candidate.shopName });
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_stock_v25 WHERE campaign_id=? AND shop_id=?",
      f.campaign.id, body.materialization.shopId)).toBe(body.materialization.candidate.items.length);
    expect(db.prepare("SELECT shop_id FROM campaign_npc_shop_bindings_v57 WHERE campaign_id=? AND npc_id=?")
      .get(f.campaign.id, merchantId)).toEqual({ shop_id: body.materialization.shopId });
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(body.materialization.contentReceiptId, body.materialization.draftId)).toBeTruthy();
    db.close();
    await app.close();
  });

  it("exposes the existing NPC-to-shop association after materialization and masks its absence", async () => {
    enableRpg();
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    const app = appFor(f);
    const associationUrl = `/api/rpg/v1/campaigns/${f.campaign.id}/npcs/${merchantId}/shop`;

    // Before any materialization the association is a non-disclosing 404.
    const missing = await app.inject({ method: "GET", url: associationUrl });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json()).toMatchObject({ code: "RPG_SHOP_NOT_FOUND" });

    const materialized = await app.inject(post(shopUrl(f.campaign.id, f.session.id, f.actorId), { merchantNpcId: merchantId }));
    expect(materialized.statusCode, materialized.body).toBe(200);
    const shopId = materialized.json().materialization.shopId as string;

    const found = await app.inject({ method: "GET", url: associationUrl });
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json()).toMatchObject({ association: { npcId: merchantId, vendorLabel: "Mara", shopId } });
    await app.close();
  });

  it("returns only the classification when there is no candidate", async () => {
    enableRpg();
    const f = await dmFixture();
    seedMerchant(f);
    const app = appFor(f);

    const response = await app.inject(post(
      shopUrl(f.campaign.id, f.session.id, f.actorId),
      { merchantNpcId: "no-such-merchant" },
    ));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.classification).toMatchObject({ intent: "none", reason: "no-merchant" });
    expect(body.materialization).toBeUndefined();
    expect(response.body).not.toContain("materialization");
    await app.close();
  });

  it("returns 404 for a principal and actor outside the campaign", async () => {
    enableRpg();
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    const app = appFor(f);

    // A well-formed campaign the trusted-local principal has no membership in:
    // the repository's authorize() rejects it before any materialization.
    const response = await app.inject(post(
      shopUrl("foreign-campaign", f.session.id, f.actorId),
      { merchantNpcId: merchantId },
    ));
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_SHOP_NOT_FOUND" });

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_definitions_v25 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    db.close();
    await app.close();
  });

  it("returns 409 for a candidate id outside the server-authored set", async () => {
    enableRpg();
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    const app = appFor(f);

    const response = await app.inject(post(
      shopUrl(f.campaign.id, f.session.id, f.actorId),
      { merchantNpcId: merchantId, candidateId: "ffsc-not-a-real-candidate" },
    ));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_SHOP_CONFLICT" });

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_definitions_v25 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_stock_v25 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-shop-draft-%'", f.campaign.id)).toBe(0);
    db.close();
    await app.close();
  });

  it("converges on an identical replay without creating a second shop", async () => {
    enableRpg();
    const f = await dmFixture();
    const merchantId = seedMerchant(f);
    const app = appFor(f);
    const url = shopUrl(f.campaign.id, f.session.id, f.actorId);

    const first = await app.inject(post(url, { merchantNpcId: merchantId }));
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json();
    expect(firstBody.materialization.status).toBe("materialized");
    if (firstBody.materialization.status !== "materialized") throw new Error("expected a materialized shop");

    const second = await app.inject(post(url, { merchantNpcId: merchantId }));
    expect(second.statusCode, second.body).toBe(200);
    const secondBody = second.json();
    expect(secondBody.classification).toMatchObject({ intent: "none", reason: "shop-already-exists" });
    expect(secondBody.materialization).toBeUndefined();

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_definitions_v25 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM rpg_shop_stock_v25 WHERE campaign_id=?", f.campaign.id)).toBe(firstBody.materialization.candidate.items.length);
    expect(countOf(db, "SELECT count(*) n FROM campaign_npc_shop_bindings_v57 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-shop-draft-%'", f.campaign.id)).toBe(1);
    db.close();
    await app.close();
  });
});
