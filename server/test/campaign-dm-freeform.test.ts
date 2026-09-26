import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema, type CampaignDmCandidate, type PrivateAdventureTurn } from "@velvet/contracts";
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
 * source location to attach content to.
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
 * Produces one completed, evidenced adventure turn whose declaration is the free-form
 * attempt under test. The declaration is carried as the turn's declaration
 * (`evidence.intent`), while a committed public quest objective is the evidence fact
 * that makes the turn usable by the director.
 */
async function evidencedTurn(f: Fixture, declaration: string): Promise<string> {
  f.repo.createCampaignQuest(OWNER, f.campaign.id, { quest: {
    questId: "freeform-quest", storylineId: "story", title: "Free-form errand", description: null, visibility: "public", journalText: "Offered",
    objectives: [{ objectiveId: "freeform-objective", description: "Carry out the declaration", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }],
    rewards: [],
  }, expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "create-freeform-quest" });
  f.repo.executeQuestCommand(OWNER, "freeform-quest", { kind: "accept",
    expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: "accept-freeform-quest" });
  const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration: declaration,
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: "freeform-turn" });
  const objective = f.repo.listAdventureQuestObjectiveCandidates(OWNER, created.turnId).find((value) => value.objectiveId === "freeform-objective")!;
  expect(objective).toBeDefined();
  const completed = await orchestrateAdventureTurn(f.repo, created.turnId, { ...dmDependencies(async () => ({ message: { role: "assistant", content: null,
    toolCalls: [{ id: "objective", name: "exact_quest_objective.select", arguments: JSON.stringify({ candidateId: objective.candidateId, digest: objective.digest }) }] },
    usage: null, model: { requestedModel: "fake", responseModel: "fake" } })), now: f.options.clock.now });
  return finishTurn(f, completed.turn);
}

/**
 * Produces one completed adventure turn whose only receipt is a FAILED SRD check and whose
 * declaration is the free-form attempt under test. This is the declaration-only case: the
 * turn is usable free-form context but is not successful-check story evidence.
 */
async function failedCheckTurn(f: Fixture, declaration: string): Promise<string> {
  const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration,
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: `failed-check-turn:${declaration.replace(/[^A-Za-z0-9._:-]+/g, "-")}` });
  const candidate = f.repo.generateAdventureCheckCandidates(OWNER, created.turnId)
    .find((value) => value.label.includes("Nearly Impossible") && value.label.endsWith("normal"))!;
  expect(candidate).toBeDefined();
  const completed = await orchestrateAdventureTurn(f.repo, created.turnId, { ...dmDependencies(async () => ({
    message: { role: "assistant", content: null,
      toolCalls: [{ id: "check", name: "exact_srd_check.select", arguments: JSON.stringify({ candidateId: candidate.candidateId, digest: candidate.digest }) }] },
    usage: null, model: { requestedModel: "fake", responseModel: "fake" } })), now: f.options.clock.now });
  expect(completed.turn.receiptLinks).toHaveLength(1);
  const receipt = f.repo.getAdventureCheckPublicReceipt(OWNER, f.campaign.id, completed.turn.receiptLinks[0]!.commandId);
  expect(receipt?.outcome).toBe("failure");
  return finishTurn(f, completed.turn);
}

/**
 * Offers exactly one candidate for `action`, executes it, and replays the same beat.
 * Returns the run so callers can assert the action-specific durable effects.
 */
async function offerExecuteAndReplay(f: Fixture, evidence: string, action: CampaignDmCandidate["action"]) {
  const request = { intent: "continue" as const, expectedModeRevision: 1, idempotencyKey: "freeform-beat", evidenceTurnId: evidence };
  const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, request);
  const work = f.repo.claimDmPlanning(OWNER, run.runId, "fake", "fake")!;
  const candidates = work.candidates.filter((value) => value.action === action);
  expect(candidates).toHaveLength(1);
  const candidate = candidates[0]!;
  f.repo.settleDmPlanning(OWNER, run.runId, work.claimId, { candidateId: candidate.candidateId, digest: candidate.digest }, null);
  await orchestrateCampaignDmBeat(f.repo, OWNER, run.runId, dmDependencies());

  const executed = f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, run.runId);
  expect(executed.state).toBe("completed");
  expect(executed.receipts.map(({ action: value }) => value)).toEqual([action]);

  // Replaying the same beat (same idempotency key) converges on the same run and does not re-execute.
  const replay = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, request);
  expect(replay.runId).toBe(run.runId);
  await orchestrateCampaignDmBeat(f.repo, OWNER, replay.runId, dmDependencies(async () => { throw new Error("replay must not dispatch a provider"); }));
  return run;
}

describe("freeform location director integration", () => {
  it("offers, executes and exactly once replays a server-authored materialize-location candidate", async () => {
    const f = await dmFixture(); f.graph();
    const harborId = seedHarbor(f);
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "freeform-ai" });
    const evidence = await evidencedTurn(f, "I go to the glassblower's district");

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

describe("freeform npc director integration", () => {
  it("offers, executes and exactly once replays a server-authored materialize-npc candidate", async () => {
    const f = await dmFixture();
    f.graph();
    seedHarbor(f);
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "freeform-ai" });
    const evidence = await evidencedTurn(f, "I ask the glassblower about the road");
    const run = await offerExecuteAndReplay(f, evidence, "materialize-npc");

    const db = openDb();
    const npc = db.prepare("SELECT npc_id,public_name FROM campaign_npcs_v28 WHERE campaign_id=?").all(f.campaign.id) as
      Array<{ npc_id: string; public_name: string }>;
    expect(npc).toHaveLength(1);
    expect(npc[0]!.public_name.toLowerCase()).toContain("glassblower");
    // The receipt names a real accepted content draft through the shared campaign-content receipt.
    const receipt = db.prepare("SELECT domain_receipt_json FROM dm_receipts WHERE run_id=?").get(run.runId) as { domain_receipt_json: string };
    const draftId = (JSON.parse(receipt.domain_receipt_json) as { draftId: string }).draftId;
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?").get(f.campaign.id, draftId)).toBeTruthy();

    // Replay converged: still exactly one persona and one draft.
    expect(countOf(db, "SELECT count(*) n FROM campaign_npcs_v28 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-npc-draft-%'", f.campaign.id)).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close(); f.repo.close();
  });
});

describe("freeform lore director integration", () => {
  it("offers, executes and exactly once replays a server-authored materialize-lore candidate", async () => {
    const f = await dmFixture();
    f.graph();
    seedHarbor(f);
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "freeform-ai" });
    const evidence = await evidencedTurn(f, "I recall the legend of the pale tide");
    const run = await offerExecuteAndReplay(f, evidence, "materialize-lore");

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='clue'", f.campaign.id)).toBe(1);
    const receipt = db.prepare("SELECT domain_receipt_json FROM dm_receipts WHERE run_id=?").get(run.runId) as { domain_receipt_json: string };
    const value = JSON.parse(receipt.domain_receipt_json) as { draftId: string; clueId: string };
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?").get(f.campaign.id, value.draftId)).toBeTruthy();
    expect(countOf(db, "SELECT count(*) n FROM story_clues_v34 WHERE campaign_id=? AND clue_id=?", f.campaign.id, value.clueId)).toBe(1);

    // Replay converged: one clue, one source node, one GM-only truth.
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='story-node'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-lore-draft-%'", f.campaign.id)).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close(); f.repo.close();
  });
});

describe("freeform encounter director integration", () => {
  it("offers, executes and exactly once replays a server-authored materialize-encounter candidate", async () => {
    const f = await dmFixture();
    f.graph();
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "freeform-ai" });
    const evidence = await evidencedTurn(f, "I attack the nearest foe!");
    const run = await offerExecuteAndReplay(f, evidence, "materialize-encounter");

    const db = openDb();
    const encounter = db.prepare("SELECT encounter_id,status,session_id FROM encounter WHERE campaign_id=?")
      .get(f.campaign.id) as { encounter_id: string; status: string; session_id: string };
    expect(encounter).toMatchObject({ status: "active", session_id: f.session.id });

    // The receipt names the real started encounter and its start combat command; the gate mirrors
    // the existing encounter authority clause.
    const receipt = db.prepare("SELECT domain_receipt_json FROM dm_receipts WHERE run_id=?").get(run.runId) as { domain_receipt_json: string };
    const value = JSON.parse(receipt.domain_receipt_json) as {
      encounterId: string; startReceipt: { commandId: string };
    };
    expect(value.encounterId).toBe(encounter.encounter_id);
    expect(db.prepare("SELECT 1 FROM combat_commands_v27 WHERE encounter_id=? AND command_id=? AND command_type='start'")
      .get(encounter.encounter_id, value.startReceipt.commandId)).toBeTruthy();

    // Replay converged: one encounter and its single start path.
    expect(countOf(db, "SELECT count(*) n FROM encounter WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM encounter_lifecycle_v31 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close(); f.repo.close();
  });
});

describe("freeform declaration-only director integration", () => {
  it("offers and materializes a location from a failed-check declaration", async () => {
    const f = await dmFixture(true);
    f.graph();
    seedHarbor(f);
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "failed-check-ai" });
    const evidence = await failedCheckTurn(f, "I go to the glassblower's district");

    const request = { intent: "continue" as const, expectedModeRevision: 1, idempotencyKey: "failed-check-beat", evidenceTurnId: evidence };
    const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, request);
    // Story grounding is unchanged: with no successful fact the evidence blocker remains.
    expect(run.blockers).toContain("evidence-needs-successful-check-objective-or-defeat");
    const work = f.repo.claimDmPlanning(OWNER, run.runId, "fake", "fake")!;
    const context = work.context as { evidence: unknown; declaration: { actorId: string; intent: string } | null };
    expect(context.evidence).toBeNull();
    expect(context.declaration).toMatchObject({ actorId: f.actorId, intent: "I go to the glassblower's district" });
    // The declaration alone still offers the closed free-form candidate.
    const candidate = work.candidates.find((value) => value.action === "materialize-location")!;
    expect(candidate).toBeDefined();
    f.repo.settleDmPlanning(OWNER, run.runId, work.claimId, { candidateId: candidate.candidateId, digest: candidate.digest }, null);
    await orchestrateCampaignDmBeat(f.repo, OWNER, run.runId, dmDependencies());

    const executed = f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, run.runId);
    expect(executed.state).toBe("completed");
    expect(executed.receipts.map(({ action }) => action)).toEqual(["materialize-location"]);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=?", f.campaign.id)).toBe(2);
    expect(countOf(db, "SELECT count(*) n FROM world_commands_v28 WHERE campaign_id=? AND session_id=? AND command_type='travel'",
      f.campaign.id, f.session.id)).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close(); f.repo.close();
  });

  it("does not treat a declaration-only turn as story evidence for reveal or resolve", async () => {
    const f = await dmFixture(true);
    f.graph();
    // A revealed public scene exists that would resolve if committed evidence were supplied.
    f.repo.executeStorylineCommand(OWNER, "story", { kind: "reveal-node", targetId: "gate", data: {},
      expectedRevision: f.repo.getCampaignStory(OWNER, f.campaign.id)!.revision, idempotencyKey: "reveal-gate-before-declaration" });
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "declaration-only-ai" });
    const evidence = await failedCheckTurn(f, "I study the gate's old markings");

    const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id,
      { intent: "continue", expectedModeRevision: 1, idempotencyKey: "declaration-only-beat", evidenceTurnId: evidence });
    expect(run.blockers).toContain("evidence-needs-successful-check-objective-or-defeat");
    const work = f.repo.claimDmPlanning(OWNER, run.runId, "fake", "fake")!;
    const context = work.context as { evidence: unknown; declaration: unknown };
    expect(context.evidence).toBeNull();
    expect(context.declaration).not.toBeNull();
    expect(work.candidates.some((value) => value.action === "resolve-node")).toBe(false);
    expect(work.candidates.some((value) => value.action === "reveal-node")).toBe(false);
    f.repo.close();
  });
});
