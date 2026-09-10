import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CAMPAIGN_RECALL_MAX_BYTES } from "../../server/src/repo/campaign/campaignRecallReadRepo.js";
import { closeRepo } from "../../server/src/repo/index.js";
import { createMemoryEvalFixture } from "../../server/test/fixtures/memory-evals/fixture.js";
import { scoreCases } from "../evaluate-campaign-memory.js";

test("computes ranking under storage reorder, privacy, packing, and hydration limits", () => {
  const metrics = scoreCases([
    { expected: ["a", "b"], forbidden: ["secret"], ranked: ["b", "x", "a"], supported: true, bytes: 10, hydrated: true, latencyMs: 1 },
    { expected: ["c"], forbidden: ["secret"], ranked: ["c"], supported: true, bytes: 20, hydrated: true, latencyMs: 2 },
    { expected: ["c"], forbidden: ["secret"], ranked: ["secret"], supported: false, bytes: 7_000, hydrated: false, latencyMs: 3 },
  ], 2);
  assert.equal(metrics.recallAtK, 2 / 3); assert.equal(metrics.recallAt8, 1); assert.equal(metrics.mrr, 1); assert.ok(metrics.ndcg > 0.9 && metrics.ndcg < 1); assert.equal(metrics.negativePassRate, 2 / 3); assert.equal(metrics.packingPassRate, 2 / 3); assert.equal(metrics.hydrationPassRate, 2 / 3);
});

test("uses production recall ordering, hydrated source kinds, and packet limits", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "velvet-memory-eval-script-")), prior = process.env.VELVET_DATA_DIR;
  try {
    process.env.VELVET_DATA_DIR = directory; closeRepo(); const fixture = await createMemoryEvalFixture(directory);
    const recall = () => fixture.repo.getCampaignRecall("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id, audience: { kind: "player", actorId: fixture.actors.aster }, query: "beacon status", purpose: "public-narration" })!;
    const first = recall();
    const current = fixture.repo.getCampaignRecall("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id, audience: { kind: "player", actorId: fixture.actors.aster }, query: "What is the beacon status now?", purpose: "public-narration" })!;
    assert.equal(current.hits[0]?.sourceId, fixture.sourceIds["current:beacon"]);
    const historical = fixture.repo.getCampaignRecall("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id, audience: { kind: "player", actorId: fixture.actors.aster }, query: "What was the earlier dim beacon?", purpose: "public-narration" })!;
    assert.equal(historical.hits[0]?.sourceId, fixture.sourceIds["past:beacon"]);
    fixture.repo.createAdventureTurn("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id, timelineId: fixture.repo.getCampaign("local-owner", fixture.campaign.id)!.activeTimelineId, actorId: fixture.actors.aster, declaration: "beacon status distraction: the older beacon was dim.", expectedCampaignRevision: fixture.repo.getCampaignAdministration("local-owner", fixture.campaign.id)!.revision, idempotencyKey: "memory-eval-script:reorder" });
    const second = recall();
    assert.ok(second.hits.some(hit => hit.sourceId === fixture.sourceIds["current:beacon"]));
    assert.ok(first.hits.some(hit => hit.sourceId === fixture.sourceIds["current:beacon"]));
    assert.equal(first.hits.find(hit => hit.sourceId === fixture.sourceIds["current:beacon"])?.sourceKind, fixture.sourceStorage["current:beacon"]);
    assert.ok(first.hits.every(hit => Buffer.byteLength(hit.text) <= 2_048));
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= CAMPAIGN_RECALL_MAX_BYTES);
    for (const [query, key, kind] of [["task accepted", "p2:p3-harbor-task-accepted-v1", "mechanic-receipt"], ["keeper statement", "p2:p3-harbor-keeper-statement-v1", "director-receipt"]] as const) {
      const result = fixture.repo.getCampaignRecall("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id, audience: { kind: "player", actorId: fixture.actors.aster }, query, purpose: "public-narration" })!;
      const hit = result.hits.find(item => item.sourceId === fixture.sourceIds[key]);
      assert.equal(hit?.sourceKind, kind); assert.ok(Buffer.byteLength(hit?.text ?? "") > 0);
    }
    const quest = fixture.repo.getCampaignRecall("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id, audience: { kind: "player", actorId: fixture.actors.aster }, query: "public quest receipt", purpose: "public-narration" })!;
    const questHit = quest.hits.find(hit => hit.sourceId === fixture.sourceIds["quest:hydration"]);
    assert.equal(questHit?.sourceKind, "quest-receipt"); assert.ok(Buffer.byteLength(questHit?.text ?? "") > 0); assert.ok(Buffer.byteLength(JSON.stringify(quest)) <= CAMPAIGN_RECALL_MAX_BYTES);
    const travel = fixture.repo.getCampaignRecall("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id, audience: { kind: "player", actorId: fixture.actors.aster }, query: "memory destination", purpose: "public-narration" })!;
    const travelHit = travel.hits.find(hit => hit.sourceId === fixture.sourceIds["travel:hydration"]);
    assert.equal(travelHit?.sourceKind, "travel-receipt"); assert.ok(Buffer.byteLength(travelHit?.text ?? "") > 0); assert.ok(Buffer.byteLength(JSON.stringify(travel)) <= CAMPAIGN_RECALL_MAX_BYTES);
    fixture.repo.close();
  } finally { closeRepo(); if (prior === undefined) delete process.env.VELVET_DATA_DIR; else process.env.VELVET_DATA_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});
