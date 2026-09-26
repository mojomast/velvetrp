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
 * Seeds one generated public location ("harbor") through the ordinary accept
 * path and places the actor there, so the free-form classifier has a generated
 * public source location to attach a connection to.
 */
function seedHarbor(f: Fixture): string {
  const content = generatedCampaignContentProviderSchema.parse({
    locations: [{ key: "harbor", name: "Rain Harbor", description: "A public harbor under grey rain.", visibility: "public" }],
  });
  const context = f.repo.getCampaignGenerationContext(OWNER, f.campaign.id, [])!;
  const draft = f.repo.createGenerationDraft(OWNER, {
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "c".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision,
    idempotencyKey: "freeform-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-seed-apply", selectedArtifactKeys: ["harbor"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero",
  });
  return locationId;
}

const appFor = (f: Fixture) => buildApp({ campaignRepositoryFactory: () => f.repo });
const travelUrl = (campaignId: string, sessionId: string, actorId: string) =>
  `/api/rpg/v1/campaigns/${campaignId}/rooms/${sessionId}/actors/${actorId}/freeform-travel-commands`;
const post = (url: string, payload: Record<string, unknown>) => ({
  method: "POST" as const, url, headers: { "content-type": "application/json" }, payload,
});

describe("freeform travel HTTP command", () => {
  it("materializes a public location and connection and moves the actor with receipts", async () => {
    enableRpg();
    const f = await dmFixture();
    const harborId = seedHarbor(f);
    const app = appFor(f);

    const response = await app.inject(post(
      travelUrl(f.campaign.id, f.session.id, f.actorId),
      { text: "I go to the glassblower's district" },
    ));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.classification).toMatchObject({ intent: "materialize-location", destinationName: "glassblower's district" });
    expect(body.materialization.status).toBe("materialized");
    if (body.materialization.status !== "materialized") throw new Error("expected a materialized location");
    expect(body.materialization.contentReceiptId).toBeTruthy();
    expect(body.materialization.candidate.visibility).toBe("public");
    expect(body.materialization.candidate.name.toLowerCase()).toContain("glassblower");

    const db = openDb();
    const location = db.prepare("SELECT public_name,visibility FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?")
      .get(f.campaign.id, body.materialization.locationId) as { public_name: string; visibility: string };
    expect(location.visibility).toBe("public");
    expect(location.public_name.toLowerCase()).toContain("glassblower");
    expect(db.prepare(`SELECT from_location_id,to_location_id,visibility,route_state FROM campaign_location_connections_v28
      WHERE campaign_id=? AND connection_id=?`).get(f.campaign.id, body.materialization.connectionId))
      .toMatchObject({ from_location_id: harborId, to_location_id: body.materialization.locationId, visibility: "public", route_state: "open" });
    expect(db.prepare("SELECT location_id FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=? AND session_id=?")
      .get(f.campaign.id, f.actorId, f.session.id)).toMatchObject({ location_id: body.materialization.locationId });
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(body.materialization.contentReceiptId, body.materialization.draftId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM world_commands_v28 WHERE campaign_id=? AND session_id=? AND command_id=? AND command_type='travel'")
      .get(f.campaign.id, f.session.id, body.materialization.world.commandId)).toBeTruthy();
    db.close();
    await app.close();
  });

  it("returns only the classification for a known location", async () => {
    enableRpg();
    const f = await dmFixture();
    const harborId = seedHarbor(f);
    const app = appFor(f);

    const response = await app.inject(post(
      travelUrl(f.campaign.id, f.session.id, f.actorId),
      { text: "I go to the Rain Harbor" },
    ));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.classification).toMatchObject({ intent: "none", reason: "known-location", locationId: harborId });
    expect(body.materialization).toBeUndefined();
    expect(response.body).not.toContain("materialization");
    await app.close();
  });

  it("returns 404 for a principal and actor outside the campaign", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);

    // A well-formed campaign the trusted-local principal has no membership in:
    // the repository's authorize() rejects it before any materialization.
    const response = await app.inject(post(
      travelUrl("foreign-campaign", f.session.id, f.actorId),
      { text: "I go to the glassblower's district" },
    ));
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_TRAVEL_NOT_FOUND" });

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    db.close();
    await app.close();
  });

  it("returns 409 for a candidate id outside the server-authored set", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);

    const response = await app.inject(post(
      travelUrl(f.campaign.id, f.session.id, f.actorId),
      { text: "I go to the glassblower's district", candidateId: "ffc-not-a-real-candidate" },
    ));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_TRAVEL_CONFLICT" });

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-draft-%'", f.campaign.id)).toBe(0);
    db.close();
    await app.close();
  });

  it("converges on an identical replay without creating a second location", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);
    const url = travelUrl(f.campaign.id, f.session.id, f.actorId);

    const first = await app.inject(post(url, { text: "I go to the glassblower's district" }));
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json();
    expect(firstBody.materialization.status).toBe("materialized");
    if (firstBody.materialization.status !== "materialized") throw new Error("expected a materialized location");

    const second = await app.inject(post(url, { text: "I go to the glassblower's district" }));
    expect(second.statusCode, second.body).toBe(200);
    const secondBody = second.json();
    expect(secondBody.classification).toMatchObject({ intent: "none", reason: "known-location", locationId: firstBody.materialization.locationId });
    expect(secondBody.materialization).toBeUndefined();

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=?", f.campaign.id)).toBe(2);
    expect(countOf(db, "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?", f.campaign.id, firstBody.materialization.locationId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_location_connections_v28 WHERE campaign_id=? AND connection_id=?", f.campaign.id, firstBody.materialization.connectionId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-draft-%'", f.campaign.id)).toBe(1);
    db.close();
    await app.close();
  });
});
