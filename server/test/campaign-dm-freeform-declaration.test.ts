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
 * source location to attach content to. Mirrors `campaign-dm-freeform.test.ts`.
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
    idempotencyKey: "declaration-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "declaration-seed-apply", selectedArtifactKeys: ["harbor"],
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

/** Settles an original turn's narration with zero receipts (a deterministic hold). */
function heldTurn(f: Fixture, declaration: string, key: string): string {
  const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration,
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: key });
  const narrating = f.repo.updateAdventureTurnNarration(OWNER, { turnId: created.turnId, expectedTurnRevision: created.revision,
    expectedCampaignRevision: created.campaignRevision, idempotencyKey: `${key}:narrating`, narrationStatus: "in-progress" });
  f.repo.updateAdventureTurnNarration(OWNER, { turnId: created.turnId, expectedTurnRevision: narrating.revision,
    expectedCampaignRevision: created.campaignRevision, idempotencyKey: `${key}:completed`, narrationStatus: "completed",
    terminalState: "completed", fallbackNarration: "The scene holds. No movement or other campaign change is established." });
  return created.turnId;
}

/** Completes the narration of a turn that already committed one receipt. */
function completeTurn(f: Fixture, turn: PrivateAdventureTurn): string {
  const narrating = f.repo.updateAdventureTurnNarration(OWNER, { turnId: turn.turnId, expectedTurnRevision: turn.revision,
    expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `${turn.turnId}:narrating`, narrationStatus: "in-progress" });
  f.repo.updateAdventureTurnNarration(OWNER, { turnId: turn.turnId, expectedTurnRevision: narrating.revision,
    expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `${turn.turnId}:completed`, narrationStatus: "completed",
    terminalState: "completed", fallbackNarration: "The verified action is complete." });
  return turn.turnId;
}

/**
 * Produces one completed turn whose only receipt is a committed public quest objective.
 * The turn has real successful evidence, so it is eligible to be recorded in
 * `dm_story_evidence` when a scene binds it.
 */
async function objectiveTurn(f: Fixture, declaration: string, key: string): Promise<string> {
  f.repo.createCampaignQuest(OWNER, f.campaign.id, { quest: {
    questId: "declaration-quest", storylineId: "story", title: "Declaration errand", description: null, visibility: "public", journalText: "Offered",
    objectives: [{ objectiveId: "declaration-objective", description: "Carry out the declaration", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }],
    rewards: [],
  }, expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: `create-${key}` });
  f.repo.executeQuestCommand(OWNER, "declaration-quest", { kind: "accept",
    expectedRevision: f.repo.listCampaignQuests(OWNER, f.campaign.id)!.revision, idempotencyKey: `accept-${key}` });
  const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration,
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: key });
  const objective = f.repo.listAdventureQuestObjectiveCandidates(OWNER, created.turnId).find((value) => value.objectiveId === "declaration-objective")!;
  expect(objective).toBeDefined();
  const completed = await orchestrateAdventureTurn(f.repo, created.turnId, { ...dmDependencies(async () => ({
    message: { role: "assistant", content: null,
      toolCalls: [{ id: "objective", name: "exact_quest_objective.select", arguments: JSON.stringify({ candidateId: objective.candidateId, digest: objective.digest }) }] },
    usage: null, model: { requestedModel: "fake", responseModel: "fake" } })), now: f.options.clock.now });
  expect(completed.turn.receiptLinks).toHaveLength(1);
  completeTurn(f, completed.turn);
  return created.turnId;
}

function openBeat(f: Fixture, key: string, evidenceTurnId: string) {
  return f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id,
    { intent: "continue", expectedModeRevision: 1, idempotencyKey: key, evidenceTurnId });
}

describe("freeform declaration gate", () => {
  it("offers a free-form candidate from a completed turn with no receipts", async () => {
    const f = await dmFixture(true);
    f.graph();
    seedHarbor(f);
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "declaration-ai" });
    const evidence = heldTurn(f, "I walk to the glassblower's district.", "declaration-held-turn");

    const run = openBeat(f, "declaration-held-beat", evidence);
    // A receipt-free turn is not successful-check evidence, but its own declaration is still usable.
    expect(run.blockers).toContain("evidence-unavailable-or-already-used");
    const work = f.repo.claimDmPlanning(OWNER, run.runId, "fake", "fake")!;
    const context = work.context as { evidence: unknown; declaration: { actorId: string; intent: string } | null };
    expect(context.evidence).toBeNull();
    expect(context.declaration).toMatchObject({ actorId: f.actorId, intent: "I walk to the glassblower's district." });

    const candidates = work.candidates.filter((value) => value.action === "materialize-location");
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
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

  it("does not re-offer story evidence once the turn is recorded", async () => {
    const f = await dmFixture(true);
    f.graph();
    seedHarbor(f);
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "declaration-record-ai" });
    f.repo.executeStorylineCommand(OWNER, "story", { kind: "reveal-node", targetId: "gate", data: {},
      expectedRevision: f.repo.getCampaignStory(OWNER, f.campaign.id)!.revision, idempotencyKey: "reveal-gate-before-record" });
    f.advance();
    const evidence = await objectiveTurn(f, "I walk to the glassblower's district.", "declaration-objective-turn");
    f.repo.bindDmSceneEvidence(OWNER, f.campaign.id, { nodeId: "gate", evidence: { kind: "quest-objective", targetId: "declaration-objective" },
      expectedStoryRevision: f.repo.getCampaignStory(OWNER, f.campaign.id)!.revision, idempotencyKey: "bind-gate-record" });

    // First beat resolves the bound scene, which durably records the turn in dm_story_evidence.
    const first = openBeat(f, "declaration-record-beat", evidence);
    const firstWork = f.repo.claimDmPlanning(OWNER, first.runId, "fake", "fake")!;
    const resolve = firstWork.candidates.find((value) => value.action === "resolve-node")!;
    expect(resolve).toBeDefined();
    f.repo.settleDmPlanning(OWNER, first.runId, firstWork.claimId, { candidateId: resolve.candidateId, digest: resolve.digest }, null);
    await orchestrateCampaignDmBeat(f.repo, OWNER, first.runId, dmDependencies());
    expect(f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, first.runId).receipts.map(({ action }) => action)).toEqual(["resolve-node"]);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM dm_story_evidence WHERE campaign_id=? AND turn_id=?", f.campaign.id, evidence)).toBe(1);

    // Re-opening a beat with the same turn never re-offers its story evidence.
    const second = openBeat(f, "declaration-record-beat-2", evidence);
    expect(second.blockers).toContain("evidence-unavailable-or-already-used");
    const secondWork = f.repo.claimDmPlanning(OWNER, second.runId, "fake", "fake")!;
    const secondContext = secondWork.context as { evidence: unknown; declaration: unknown };
    expect(secondContext.evidence).toBeNull();
    expect(secondContext.declaration).not.toBeNull();
    expect(secondWork.candidates.some((value) => value.action === "resolve-node")).toBe(false);
    // Free-form behavior is unchanged: the declaration alone still offers its bounded candidate.
    expect(secondWork.candidates.some((value) => value.action === "materialize-location")).toBe(true);
    expect(countOf(db, "SELECT count(*) n FROM dm_story_evidence WHERE campaign_id=? AND turn_id=?", f.campaign.id, evidence)).toBe(1);
    db.close(); f.repo.close();
  });

  it("yields no free-form candidate for a blank/whitespace declaration", async () => {
    const f = await dmFixture(true);
    f.graph();
    seedHarbor(f);
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "declaration-blank-ai" });

    // The deterministic classifiers own the closure: whitespace never names a place, person, clue, or foe.
    for (const text of ["", "   ", "\t\n"]) {
      expect(f.repo.classifyFreeformTravelIntent(OWNER, f.campaign.id, f.session.id, f.actorId, text).intent).toBe("none");
      expect(f.repo.classifyFreeformNpcIntent(OWNER, f.campaign.id, f.session.id, f.actorId, text).intent).toBe("none");
      expect(f.repo.classifyFreeformLoreIntent(OWNER, f.campaign.id, f.session.id, f.actorId, text).intent).toBe("none");
      expect(f.repo.classifyFreeformEncounterIntent(OWNER, f.campaign.id, f.session.id, f.actorId, text).intent).toBe("none");
    }

    // The DM gate only offers a free-form candidate when the turn carries a usable declaration.
    // A zero-width declaration survives the trim guard but still classifies to nothing.
    const blank = heldTurn(f, "\u200b", "declaration-blank-turn");
    const run = openBeat(f, "declaration-blank-beat", blank);
    const work = f.repo.claimDmPlanning(OWNER, run.runId, "fake", "fake")!;
    expect(work.candidates.some((value) => value.action.startsWith("materialize-"))).toBe(false);
    f.repo.close();
  });
});
