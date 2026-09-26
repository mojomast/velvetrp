import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const RUMOR_DECLARATION = "I listen for gossip about the salt witch";

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
 * Seeds one generated public location ("harbor") with one referenced public
 * faction ("tidewatch") through the ordinary accept path and places the actor
 * there, so the free-form rumor classifier has public canon to ground and
 * attribute the hearsay from.
 */
function seedHarbor(f: Fixture): string {
  const content = generatedCampaignContentProviderSchema.parse({
    locations: [{
      key: "harbor", name: "Rain Harbor", description: "A public harbor under grey rain.", visibility: "public",
      factionKeys: ["tidewatch"],
    }],
    factions: [{
      key: "tidewatch", name: "Tidewatch", description: "The harbor's public watch.", visibility: "public",
      gmNotes: "SECRET_TIDEWATCH_GOALS",
    }],
  });
  const context = f.repo.getCampaignGenerationContext(OWNER, f.campaign.id, [])!;
  const draft = f.repo.createGenerationDraft(OWNER, {
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "c".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision,
    idempotencyKey: "freeform-rumor-route-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-rumor-route-seed-apply", selectedArtifactKeys: ["harbor", "tidewatch"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero-rumor-route",
  });
  return locationId;
}

/**
 * Makes the fixed route principal `local-owner` a non-owner player that does
 * not control the actor, by moving campaign ownership to a fresh principal in
 * one deferred-FK transaction. The caller asserts the resulting 404.
 */
function demoteLocalOwner(f: Fixture): void {
  const db = openDb();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('rumor-nonowner','Rumor non-owner',0)").run();
    db.prepare("UPDATE campaign_memberships SET role='player' WHERE campaign_id=? AND principal_id=?").run(f.campaign.id, OWNER);
    db.prepare("UPDATE campaigns SET owner_principal_id='rumor-nonowner' WHERE id=?").run(f.campaign.id);
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,'owner','2036-01-01T00:00:00.000Z')")
      .run(f.campaign.id, "rumor-nonowner");
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='rumor-nonowner' WHERE campaign_id=? AND actor_id=?")
      .run(f.campaign.id, f.actorId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

const appFor = (f: Fixture) => buildApp({ campaignRepositoryFactory: () => f.repo });
const rumorUrl = (campaignId: string, sessionId: string, actorId: string) =>
  `/api/rpg/v1/campaigns/${campaignId}/rooms/${sessionId}/actors/${actorId}/freeform-rumor-commands`;
const post = (url: string, payload: Record<string, unknown>) => ({
  method: "POST" as const, url, headers: { "content-type": "application/json" }, payload,
});

describe("freeform rumor HTTP command", () => {
  it("materializes public hearsay with a durable receipt", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);

    const response = await app.inject(post(
      rumorUrl(f.campaign.id, f.session.id, f.actorId),
      { text: RUMOR_DECLARATION },
    ));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.classification).toMatchObject({ intent: "materialize-rumor", subject: "salt witch" });
    expect(body.materialization.status).toBe("materialized");
    if (body.materialization.status !== "materialized") throw new Error("expected a materialized rumor");
    expect(body.materialization.contentReceiptId).toBeTruthy();
    expect(body.materialization.gmTruthArtifactKey).toBeTruthy();
    expect(body.materialization.candidate.visibility).toBe("public");
    expect(body.materialization.candidate.subject).toBe("salt witch");

    const db = openDb();
    const hearsay = db.prepare(`SELECT visibility,server_resource_id FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_kind='lore' AND visibility='public'`).get(f.campaign.id) as { visibility: string; server_resource_id: string };
    expect(hearsay.visibility).toBe("public");
    expect(hearsay.server_resource_id).toBe(body.materialization.rumorId);
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(body.materialization.contentReceiptId, body.materialization.draftId)).toBeTruthy();
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore' AND visibility='public'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore' AND visibility='gm'", f.campaign.id)).toBe(1);
    db.close();
    await app.close();
  });

  it("returns only the classification without intent or against known canon", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);
    const url = rumorUrl(f.campaign.id, f.session.id, f.actorId);

    const none = await app.inject(post(url, { text: "I look around the market" }));
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json().classification).toMatchObject({ intent: "none", reason: "no-rumor-intent" });
    expect(none.json().materialization).toBeUndefined();
    expect(none.body).not.toContain("materialization");

    // Commit one rumor outside the route so the second declaration is known canon.
    f.repo.materializeFreeformRumor(OWNER, f.campaign.id, f.session.id, f.actorId, RUMOR_DECLARATION);
    const known = await app.inject(post(url, { text: "I ask around for rumors about the salt witch" }));
    expect(known.statusCode, known.body).toBe(200);
    expect(known.json().classification).toMatchObject({ intent: "none", reason: "known-rumor", title: "salt witch" });
    expect(known.json().materialization).toBeUndefined();
    await app.close();
  });

  it("returns 404 for a non-owner principal that does not control the actor", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);

    // The route acts as the fixed literal `local-owner`. Demote that principal
    // to a non-owner player that does not control the actor, so the repository
    // authorization fails closed before any materialization.
    demoteLocalOwner(f);

    const response = await app.inject(post(
      rumorUrl(f.campaign.id, f.session.id, f.actorId),
      { text: RUMOR_DECLARATION },
    ));
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_RUMOR_NOT_FOUND" });

    const verify = openDb();
    expect(countOf(verify, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore'", f.campaign.id)).toBe(0);
    verify.close();
    await app.close();
  });

  it("returns 409 for a candidate id outside the server-authored set", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);

    const response = await app.inject(post(
      rumorUrl(f.campaign.id, f.session.id, f.actorId),
      { text: RUMOR_DECLARATION, candidateId: "ffr-not-a-real-candidate" },
    ));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_RUMOR_CONFLICT" });

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore'", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-rumor-draft-%'", f.campaign.id)).toBe(0);
    db.close();
    await app.close();
  });

  it("converges exactly once on an identical replay", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);
    const url = rumorUrl(f.campaign.id, f.session.id, f.actorId);

    const first = await app.inject(post(url, { text: RUMOR_DECLARATION }));
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json();
    expect(firstBody.materialization.status).toBe("materialized");
    if (firstBody.materialization.status !== "materialized") throw new Error("expected a materialized rumor");

    const second = await app.inject(post(url, { text: RUMOR_DECLARATION }));
    expect(second.statusCode, second.body).toBe(200);
    const secondBody = second.json();
    expect(secondBody.classification).toMatchObject({ intent: "none", reason: "known-rumor" });
    expect(secondBody.materialization).toBeUndefined();

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore' AND visibility='public'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore' AND visibility='gm'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-rumor-draft-%'", f.campaign.id)).toBe(1);
    db.close();
    await app.close();
  });
});
