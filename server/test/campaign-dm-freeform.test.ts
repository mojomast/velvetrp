import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema, type PrivateAdventureTurn } from "@velvet/contracts";
import { orchestrateAdventureTurn } from "../src/agent/adventureOrchestrator.js";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
type Fixture = Awaited<ReturnType<typeof dmFixture>>;
const OWNER = "local-owner";
const openDb = (): DatabaseDriver.Database => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const countOf = (db: DatabaseDriver.Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

/**
 * Seeds one generated public location ("harbor") through the ordinary accept path
 * and places the actor there, so the free-form classifier has a generated public
 * source location to attach a connection to.
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

/** Completes the adventure turn's narration, the same way the scene-binding fixtures do. */
function finishTurn(f: Fixture, turn: PrivateAdventureTurn): string {
  expect(turn.receiptLinks).toHaveLength(1);
  const narrating = f.repo.updateAdventureTurnNarration(OWNER, { turnId: turn.turnId, expectedTurnRevision: turn.revision,
    expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `${turn.turnId}:narrating`, narrationStatus: "in-progress" });
  f.repo.updateAdventureTurnNarration(OWNER, { turnId: turn.turnId, expectedTurnRevision: narrating.revision,
    expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `${turn.turnId}:completed`,
    narrationStatus: "completed", terminalState: "completed", fallbackNarration: "The verified action is complete." });
  return turn.turnId;
}

/**
 * Produces one completed, evidenced adventure turn whose declaration names the
 * unmapped glassblower's district. The declared travel is carried as the turn's
 * declaration (`evidence.intent`), while a committed public quest objective is
 * the evidence fact that makes the turn usable by the director.
 */
async function travelEvidence(f: Fixture): Promise<string> {
  f.repo.createCampaignQuest(OWNER, f.campaign.id, { quest: {
    questId: "glass-quest", storylineId: "story", title: "Glass errand", description: null, visibility: "public", journalText: "Offered",
    objectives: [{ objectiveId: "glass-objective", description: "Reach the glassblower's district", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }],
    rewards: [],
  }, expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "create-glass-quest" });
  f.repo.executeQuestCommand(OWNER, "glass-quest", { kind: "accept",
    expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "accept-glass-quest" });
  const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration: "I go to the glassblower's district",
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: "travel-turn" });
  const objective = f.repo.listAdventureQuestObjectiveCandidates(OWNER, created.turnId).find((value) => value.objectiveId === "glass-objective")!;
  expect(objective).toBeDefined();
  const completed = await orchestrateAdventureTurn(f.repo, created.turnId, { ...dmDependencies(async () => ({ message: { role: "assistant", content: null,
    toolCalls: [{ id: "objective", name: "exact_quest_objective.select", arguments: JSON.stringify({ candidateId: objective.candidateId, digest: objective.digest }) }] },
    usage: null, model: { requestedModel: "fake", responseModel: "fake" } })), now: f.options.clock.now });
  return finishTurn(f, completed.turn);
}

describe("freeform location director integration", () => {
  it("offers, executes and exactly once replays a server-authored materialize-location candidate", async () => {
    const f = await dmFixture(); f.graph();
    const harborId = seedHarbor(f);
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "freeform-ai" });
    const evidence = await travelEvidence(f);

    const request = { intent: "continue" as const, expectedModeRevision: 1, idempotencyKey: "freeform-beat", evidenceTurnId: evidence };
    const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, request);
    const work = f.repo.claimDmPlanning(OWNER, run.runId, "fake", "fake")!;
    const candidate = work.candidates.find((value) => value.action === "materialize-location")!;
    expect(candidate).toBeDefined();
    // The candidate is the bounded, exact server-authored projection of the declaration.
    expect(work.candidates.filter((value) => value.action === "materialize-location")).toHaveLength(1);
    f.repo.settleDmPlanning(OWNER, run.runId, work.claimId, { candidateId: candidate.candidateId, digest: candidate.digest }, null);
    await orchestrateCampaignDmBeat(f.repo, OWNER, run.runId, dmDependencies());

    const executed = f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, run.runId);
    expect(executed.state).toBe("completed");
    expect(executed.receipts.map(({ action }) => action)).toEqual(["materialize-location"]);

    const db = openDb();
    const newLocation = db.prepare(`SELECT location_id,public_name,visibility FROM campaign_locations_v28
      WHERE campaign_id=? AND location_id<>?`).get(f.campaign.id, harborId) as { location_id: string; public_name: string; visibility: string };
    expect(newLocation.visibility).toBe("public");
    expect(newLocation.public_name.toLowerCase()).toContain("glassblower");
    expect(db.prepare(`SELECT from_location_id,to_location_id,visibility FROM campaign_location_connections_v28
      WHERE campaign_id=? AND to_location_id=?`).get(f.campaign.id, newLocation.location_id))
      .toMatchObject({ from_location_id: harborId, to_location_id: newLocation.location_id, visibility: "public" });
    expect(db.prepare(`SELECT location_id FROM campaign_actor_locations_v28
      WHERE campaign_id=? AND actor_id=? AND session_id=?`).get(f.campaign.id, f.actorId, f.session.id))
      .toMatchObject({ location_id: newLocation.location_id });
    expect(countOf(db, "SELECT count(*) n FROM world_commands_v28 WHERE campaign_id=? AND session_id=? AND command_type='travel'",
      f.campaign.id, f.session.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_receipts_v42 WHERE campaign_id=?", f.campaign.id)).toBeGreaterThan(0);

    // Replaying the same beat (same idempotency key) converges instead of creating a second location.
    const replay = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, request);
    expect(replay.runId).toBe(run.runId);
    await orchestrateCampaignDmBeat(f.repo, OWNER, replay.runId, dmDependencies(async () => { throw new Error("replay must not dispatch a provider"); }));
    expect(countOf(db, "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=?", f.campaign.id)).toBe(2);
    expect(countOf(db, "SELECT count(*) n FROM world_commands_v28 WHERE campaign_id=? AND session_id=? AND command_type='travel'",
      f.campaign.id, f.session.id)).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close(); f.repo.close();
  });
});
