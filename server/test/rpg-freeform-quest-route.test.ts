import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const QUEST_DECLARATION = "I ask around for work";

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
 * public source location to anchor an ad-hoc quest to.
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
    idempotencyKey: "freeform-quest-route-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-quest-route-seed-apply", selectedArtifactKeys: ["harbor"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero-quest",
  });
  return locationId;
}

const appFor = (f: Fixture) => buildApp({ campaignRepositoryFactory: () => f.repo });
const questUrl = (campaignId: string, sessionId: string, actorId: string) =>
  `/api/rpg/v1/campaigns/${campaignId}/rooms/${sessionId}/actors/${actorId}/freeform-quest-commands`;
const post = (url: string, payload: Record<string, unknown>) => ({
  method: "POST" as const, url, headers: { "content-type": "application/json" }, payload,
});

describe("freeform quest HTTP command", () => {
  it("materializes a public quest with public objectives, a separate GM-only twist and receipts", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);

    const response = await app.inject(post(
      questUrl(f.campaign.id, f.session.id, f.actorId),
      { text: QUEST_DECLARATION },
    ));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.classification).toMatchObject({ intent: "materialize-quest" });
    expect(body.classification.candidates).toHaveLength(1);
    expect(body.classification.candidates[0].objectives.every((objective: { visibility: string }) => objective.visibility === "public")).toBe(true);
    expect(body.classification.candidates[0].reward).toMatchObject({ kind: "custom", amount: null });
    expect(body.materialization.status).toBe("materialized");
    if (body.materialization.status !== "materialized") throw new Error("expected a materialized quest");
    expect(body.materialization.contentReceiptId).toBeTruthy();
    expect(body.materialization.gmTwistArtifactKey).toBeTruthy();
    expect(body.materialization.candidate.visibility).toBe("public");

    const db = openDb();
    expect(db.prepare("SELECT status FROM quests WHERE campaign_id=? AND id=?")
      .get(f.campaign.id, body.materialization.questId)).toMatchObject({ status: "open" });
    // Exactly one public quest artifact and one separate GM-only twist artifact.
    const artifacts = db.prepare(`SELECT artifact_kind,visibility FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? ORDER BY artifact_kind`).all(f.campaign.id, body.materialization.draftId) as Array<{ artifact_kind: string; visibility: string }>;
    expect(artifacts.map((row) => `${row.artifact_kind}:${row.visibility}`)).toEqual(["lore:gm", "quest:public"]);
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(body.materialization.contentReceiptId, body.materialization.draftId)).toBeTruthy();
    db.close();
    await app.close();
  });

  it("returns only the classification for work that selects a known quest title", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    // Commit one quest outside the route so the second declaration is known work.
    f.repo.materializeFreeformQuest(OWNER, f.campaign.id, f.session.id, f.actorId, QUEST_DECLARATION);
    const app = appFor(f);

    const response = await app.inject(post(
      questUrl(f.campaign.id, f.session.id, f.actorId),
      { text: "I look for work" },
    ));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.classification).toMatchObject({ intent: "none", reason: "known-quest" });
    expect(body.materialization).toBeUndefined();
    expect(response.body).not.toContain("materialization");
    await app.close();
  });

  it("returns 404 for a principal and actor outside the campaign", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);

    const response = await app.inject(post(
      questUrl("foreign-campaign", f.session.id, f.actorId),
      { text: QUEST_DECLARATION },
    ));
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_QUEST_NOT_FOUND" });

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM quests WHERE campaign_id=?", f.campaign.id)).toBe(0);
    db.close();
    await app.close();
  });

  it("returns 409 for a candidate id outside the server-authored set", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);

    const response = await app.inject(post(
      questUrl(f.campaign.id, f.session.id, f.actorId),
      { text: QUEST_DECLARATION, candidateId: "ffq-not-a-real-candidate" },
    ));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: "RPG_FREEFORM_QUEST_CONFLICT" });

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM quests WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-quest-draft-%'", f.campaign.id)).toBe(0);
    db.close();
    await app.close();
  });

  it("converges on an identical replay without creating a second quest", async () => {
    enableRpg();
    const f = await dmFixture();
    seedHarbor(f);
    const app = appFor(f);
    const url = questUrl(f.campaign.id, f.session.id, f.actorId);

    const first = await app.inject(post(url, { text: QUEST_DECLARATION }));
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json();
    expect(firstBody.materialization.status).toBe("materialized");
    if (firstBody.materialization.status !== "materialized") throw new Error("expected a materialized quest");

    const second = await app.inject(post(url, { text: QUEST_DECLARATION }));
    expect(second.statusCode, second.body).toBe(200);
    const secondBody = second.json();
    expect(secondBody.classification).toMatchObject({ intent: "none", reason: "known-quest" });
    expect(secondBody.materialization).toBeUndefined();

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM quests WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM quests WHERE campaign_id=? AND id=?", f.campaign.id, firstBody.materialization.questId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-quest-draft-%'", f.campaign.id)).toBe(1);
    db.close();
    await app.close();
  });
});
