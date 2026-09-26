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
 * public source location to place an ad-hoc NPC in.
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
    idempotencyKey: "freeform-npc-route-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-npc-route-seed-apply", selectedArtifactKeys: ["harbor"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero-npc",
  });
  return locationId;
}

const appFor = (f: Fixture) => buildApp({ campaignRepositoryFactory: () => f.repo });
const npcUrl = (campaignId: string, sessionId: string, actorId: string) =>
  `/api/rpg/v1/campaigns/${campaignId}/rooms/${sessionId}/actors/${actorId}/freeform-npc-commands`;
const post = (url: string, payload: Record<string, unknown>) => ({
  method: "POST" as const, url, headers: { "content-type": "application/json" }, payload,
});

describe("freeform NPC HTTP command", () => {
  it("materializes a public persona with a separate GM-only goals artifact and receipts", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);

    const response = await app.inject(post(
      npcUrl(f.campaign.id, f.session.id, f.actorId),
      { text: "I ask the glassblower about the road" },
    ));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.classification).toMatchObject({ intent: "materialize-npc", npcName: "glassblower" });
    expect(body.materialization.status).toBe("materialized");
    if (body.materialization.status !== "materialized") throw new Error("expected a materialized NPC");
    expect(body.materialization.contentReceiptId).toBeTruthy();
    expect(body.materialization.gmGoalsArtifactKey).toBeTruthy();
    expect(body.materialization.candidate.visibility).toBe("public");
    expect(body.materialization.candidate.name.toLowerCase()).toContain("glassblower");

    const db = openDb();
    const npc = db.prepare("SELECT public_name,speech_control FROM campaign_npcs_v28 WHERE campaign_id=? AND npc_id=?")
      .get(f.campaign.id, body.materialization.npcId) as { public_name: string; speech_control: string };
    expect(npc.public_name.toLowerCase()).toContain("glassblower");
    expect(npc.speech_control).toBe("manual");
    // Exactly one public npc artifact and one separate GM-only goals artifact.
    const artifacts = db.prepare(`SELECT artifact_kind,visibility FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? ORDER BY artifact_kind`).all(f.campaign.id, body.materialization.draftId) as Array<{ artifact_kind: string; visibility: string }>;
    expect(artifacts.map((row) => `${row.artifact_kind}:${row.visibility}`)).toEqual(["lore:gm", "npc:public"]);
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(body.materialization.contentReceiptId, body.materialization.draftId)).toBeTruthy();
    db.close();
    await app.close();
  });

  it("returns only the classification for a known duplicate name", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    // Commit one persona outside the route so the second declaration is a duplicate.
    f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, "I greet Elara");
    const app = appFor(f);

    const response = await app.inject(post(
      npcUrl(f.campaign.id, f.session.id, f.actorId),
      { text: "I talk to Elara" },
    ));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.classification).toMatchObject({ intent: "none", reason: "known-npc" });
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
      npcUrl("foreign-campaign", f.session.id, f.actorId),
      { text: "I ask the glassblower about the road" },
    ));
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_NPC_NOT_FOUND" });

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_npcs_v28 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    db.close();
    await app.close();
  });

  it("returns 409 for a candidate id outside the server-authored set", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);

    const response = await app.inject(post(
      npcUrl(f.campaign.id, f.session.id, f.actorId),
      { text: "I ask the glassblower about the road", candidateId: "ffn-not-a-real-candidate" },
    ));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_NPC_CONFLICT" });

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_npcs_v28 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-npc-draft-%'", f.campaign.id)).toBe(0);
    db.close();
    await app.close();
  });

  it("converges on an identical replay without creating a second persona", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);
    const url = npcUrl(f.campaign.id, f.session.id, f.actorId);

    const first = await app.inject(post(url, { text: "I ask the glassblower about the road" }));
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json();
    expect(firstBody.materialization.status).toBe("materialized");
    if (firstBody.materialization.status !== "materialized") throw new Error("expected a materialized NPC");

    const second = await app.inject(post(url, { text: "I ask the glassblower about the road" }));
    expect(second.statusCode, second.body).toBe(200);
    const secondBody = second.json();
    expect(secondBody.classification).toMatchObject({ intent: "none", reason: "known-npc" });
    expect(secondBody.materialization).toBeUndefined();

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_npcs_v28 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_npcs_v28 WHERE campaign_id=? AND npc_id=?", f.campaign.id, firstBody.materialization.npcId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-npc-draft-%'", f.campaign.id)).toBe(1);
    db.close();
    await app.close();
  });
});
