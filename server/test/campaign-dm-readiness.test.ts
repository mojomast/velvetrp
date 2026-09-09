import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignDmReadinessResponseSchema } from "@velvet/contracts";
import { orchestrateAdventureTurn } from "../src/agent/adventureOrchestrator.js";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { createCampaignDmReadinessRepository, CampaignDmReadinessUnavailableError, projectCampaignDmReadinessBindingReference } from "../src/repo/campaignDmReadinessRepo.js";
import { dmCompletion, dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

describe("campaign DM readiness repository", () => {
  afterEach(() => vi.restoreAllMocks());

  it("authorizes before the activation reader and returns a strict read-only snapshot", async () => {
    const fixture = await dmFixture();
    const connection = database();
    try {
      const before = connection.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(fixture.campaign.id);
      const reader = vi.fn(() => fixture.repo.getCampaignRoomActivationReadiness("local-owner", fixture.campaign.id, fixture.session.id));
      const readiness = createCampaignDmReadinessRepository(connection, reader, () => undefined);

      const report = readiness.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
      expect(campaignDmReadinessResponseSchema.parse(report)).toEqual(report);
      expect(report.identity).toMatchObject({ campaignId: fixture.campaign.id, sessionId: fixture.session.id, timelineId: fixture.campaign.activeTimelineId });
      expect(reader).toHaveBeenCalledTimes(1);
      expect(connection.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(fixture.campaign.id)).toEqual(before);
      expect(JSON.stringify(report)).not.toMatch(/SECRET|digest|canonical_json|privateGoals/);

      expect(() => readiness.getCampaignDmPreparationReadiness("outsider", fixture.campaign.id, fixture.session.id))
        .toThrow(CampaignDmReadinessUnavailableError);
      expect(reader).toHaveBeenCalledTimes(1);
    } finally {
      connection.close();
      fixture.repo.close();
    }
  });

  it("includes authored public story resources without generation artifacts", async () => {
    const fixture = await dmFixture();
    fixture.repo.createCampaignStorylineGraph("local-owner", fixture.campaign.id, {
      storyline: { storylineId: "authored-story", title: "Authored", summary: "Public story", nodes: [
        { nodeId: "authored-node", title: "Public scene", description: "A public scene.", gmNotes: "private note", revealThreshold: 0 },
      ], edges: [], plotPoints: [], clues: [] },
      expectedRevision: fixture.repo.getCampaignStory("local-owner", fixture.campaign.id)!.revision,
      idempotencyKey: "authored-story",
    });
    fixture.repo.executeStorylineCommand("local-owner", "authored-story", {
      kind: "reveal-node", targetId: "authored-node", data: {},
      expectedRevision: fixture.repo.getCampaignStory("local-owner", fixture.campaign.id)!.revision,
      idempotencyKey: "reveal-authored-node",
    });
    const connection = database();
    try {
      const readiness = createCampaignDmReadinessRepository(connection,
        () => fixture.repo.getCampaignRoomActivationReadiness("local-owner", fixture.campaign.id, fixture.session.id), () => undefined);
      const report = readiness.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
      expect(report.coverage.families.find(family => family.family === "story")?.inspected)
        .toContainEqual({ kind: "story-node", id: "authored-node" });
      expect(report.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "missing-public-rendering", reference: { kind: "story-node", id: "authored-node" } }),
      ]));
    } finally {
      connection.close();
      fixture.repo.close();
    }
  });

  it("is available through the composed repository with activation parity", async () => {
    const fixture = await dmFixture();
    try {
      const report = fixture.repo.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
      expect(report.activationReadiness.campaignId).toBe(fixture.campaign.id);
      expect(report.activationReadiness.sessionId).toBe(fixture.session.id);
      expect(report.identity.timelineId).toBe(fixture.campaign.activeTimelineId);
      expect(() => fixture.repo.getCampaignDmPreparationReadiness("outsider", fixture.campaign.id, fixture.session.id))
        .toThrow(CampaignDmReadinessUnavailableError);
    } finally {
      fixture.repo.close();
    }
  });

  it("preserves valid binding references and hashes only invalid projections without changing authority or evidence", async () => {
    const fixture = await dmFixture(true);
    const privateNodeId = `node-${"PRIVATE-BINDING-TEXT-".repeat(5)}`;
    fixture.graph();
    fixture.repo.createCampaignStorylineGraph("local-owner", fixture.campaign.id, {
      storyline: { storylineId: "long-binding-story", title: "Long binding", summary: null, nodes: [
        { nodeId: privateNodeId, title: "Bound scene", description: "A public scene.", gmNotes: null, revealThreshold: 0 },
      ], edges: [], plotPoints: [], clues: [] },
      expectedRevision: fixture.repo.getCampaignStory("local-owner", fixture.campaign.id)!.revision,
      idempotencyKey: "long-binding-story",
    });
    fixture.repo.setDmControl("local-owner", fixture.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "readiness-ai" });
    const opening = fixture.repo.openDmBeat("local-owner", fixture.campaign.id, fixture.session.id,
      { intent: "open", expectedModeRevision: 1, idempotencyKey: "readiness-open" });
    await orchestrateCampaignDmBeat(fixture.repo, "local-owner", opening.runId, dmDependencies(async input => dmCompletion(input, "reveal-node")));
    const story = fixture.repo.getCampaignStory("local-owner", fixture.campaign.id)!.story;
    if ("nodes" in story && story.nodes.find(node => node.nodeId === privateNodeId)?.status === "hidden") {
      fixture.repo.executeStorylineCommand("local-owner", "long-binding-story", {
        kind: "reveal-node", targetId: privateNodeId, data: {},
        expectedRevision: fixture.repo.getCampaignStory("local-owner", fixture.campaign.id)!.revision,
        idempotencyKey: "reveal-long-binding-node",
      });
    }
    const objectiveId = "long-binding-objective";
    fixture.repo.createCampaignQuest("local-owner", fixture.campaign.id, {
      quest: { questId: "long-binding-quest", storylineId: "long-binding-story", title: "Long binding quest", description: null, visibility: "public", journalText: "Complete the objective.",
        objectives: [{ objectiveId, description: "Complete the long binding objective", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }], rewards: [] },
      expectedRevision: fixture.repo.listCampaignQuests("local-owner", fixture.campaign.id)!.revision,
      idempotencyKey: "create-long-binding-quest",
    });
    fixture.repo.executeQuestCommand("local-owner", "long-binding-quest", {
      kind: "accept", expectedRevision: fixture.repo.listCampaignQuests("local-owner", fixture.campaign.id)!.revision,
      idempotencyKey: "accept-long-binding-quest",
    });
    fixture.advance();
    const turn = fixture.repo.createAdventureTurn("local-owner", { campaignId: fixture.campaign.id, timelineId: fixture.campaign.activeTimelineId,
      sessionId: fixture.session.id, actorId: fixture.actorId, declaration: "I complete the long binding objective.", expectedCampaignRevision: fixture.repo.getCampaignAdministration("local-owner", fixture.campaign.id)!.revision, idempotencyKey: "readiness-evidence" });
    const candidate = fixture.repo.listAdventureQuestObjectiveCandidates("local-owner", turn.turnId).find(value => value.objectiveId === objectiveId)!;
    const completed = (await orchestrateAdventureTurn(fixture.repo, turn.turnId, {
      ...dmDependencies(async () => ({ message: { role: "assistant", content: null, toolCalls: [{ id: "objective", name: "exact_quest_objective.select", arguments: JSON.stringify({ candidateId: candidate.candidateId, digest: candidate.digest }) }] }, usage: null, model: { requestedModel: "fake", responseModel: "fake" } })),
      now: fixture.options.clock.now,
    })).turn;
    expect(completed.receiptLinks).toHaveLength(1);
    const narrating = fixture.repo.updateAdventureTurnNarration("local-owner", { turnId: turn.turnId, expectedTurnRevision: completed.revision,
      expectedCampaignRevision: completed.campaignRevision, idempotencyKey: "readiness-narrating", narrationStatus: "in-progress" });
    fixture.repo.updateAdventureTurnNarration("local-owner", { turnId: turn.turnId, expectedTurnRevision: narrating.revision,
      expectedCampaignRevision: completed.campaignRevision, idempotencyKey: "readiness-completed", narrationStatus: "completed", terminalState: "completed", fallbackNarration: "The objective is complete." });
    for (const nodeId of ["gate", privateNodeId]) fixture.repo.bindDmSceneEvidence("local-owner", fixture.campaign.id, {
      nodeId, evidence: { kind: "quest-objective", targetId: objectiveId }, expectedStoryRevision: fixture.repo.getCampaignStory("local-owner", fixture.campaign.id)!.revision,
      idempotencyKey: nodeId === "gate" ? "readiness-bind-gate" : "readiness-bind-long",
    });
    const connection = database();
    try {
      const before = connection.prepare("SELECT count(*) count FROM dm_story_evidence WHERE campaign_id=?").get(fixture.campaign.id);
      const beforeBindings = connection.prepare("SELECT count(*) count FROM dm_review_scene_bindings WHERE campaign_id=?").get(fixture.campaign.id);
      const beforeAdministration = connection.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(fixture.campaign.id);
      const prepared = fixture.repo.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
      const preparedReferences = prepared.issues.filter(issue => issue.code === "awaiting-play-evidence").map(issue => issue.reference!.id);
      const simpleReference = `gate:quest-objective:${objectiveId}`;
      const longReference = `binding:${createHash("sha256").update(JSON.stringify([privateNodeId, "quest-objective", objectiveId])).digest("hex").slice(0, 48)}`;
      expect(`${privateNodeId}:quest-objective:${objectiveId}`.length).toBeGreaterThan(128);
      expect(fixture.repo.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id)).toEqual(prepared);
      expect(projectCampaignDmReadinessBindingReference("gate", "quest-objective", objectiveId)).toBe(simpleReference);
      expect(preparedReferences).toContain(simpleReference);
      expect(preparedReferences).toContain(longReference);
      expect(longReference).toMatch(/^binding:/);
      expect(longReference.length).toBeLessThanOrEqual(128);
      expect(longReference).not.toContain(privateNodeId);
      expect(longReference).not.toContain(turn.turnId);
      expect(longReference).not.toContain("PRIVATE-BINDING-TEXT");
       expect(longReference).not.toMatch(/^[0-9a-f]{64}$/);
      const colonReference = projectCampaignDmReadinessBindingReference("a:quest-objective:b", "quest-objective", "c");
      const splitReference = projectCampaignDmReadinessBindingReference("a", "quest-objective", "b:quest-objective:c");
      expect(["a:quest-objective:b", "quest-objective", "c"].join(":")).toBe(["a", "quest-objective", "b:quest-objective:c"].join(":"));
      expect(colonReference).toMatch(/^binding:/);
      expect(splitReference).toMatch(/^binding:/);
      expect(colonReference).not.toBe(splitReference);
      expect(preparedReferences).toHaveLength(2);
      expect(preparedReferences.filter(id => id.startsWith("binding:"))).toEqual([longReference]);
      expect(connection.prepare("SELECT count(*) count FROM dm_story_evidence WHERE campaign_id=?").get(fixture.campaign.id)).toEqual(before);
      expect(connection.prepare("SELECT count(*) count FROM dm_review_scene_bindings WHERE campaign_id=?").get(fixture.campaign.id)).toEqual(beforeBindings);
      expect(connection.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(fixture.campaign.id)).toEqual(beforeAdministration);
      expect(fixture.repo.getAdventureQuestPublicReceipt("local-owner", fixture.campaign.id, completed.receiptLinks[0]!.commandId)).toMatchObject({
        objectiveCompleted: true, progressAfter: 1, targetProgress: 1,
      });

      const resolving = fixture.repo.openDmBeat("local-owner", fixture.campaign.id, fixture.session.id,
        { intent: "continue", expectedModeRevision: 1, idempotencyKey: "readiness-resolve", evidenceTurnId: turn.turnId });
      await orchestrateCampaignDmBeat(fixture.repo, "local-owner", resolving.runId, dmDependencies(async input => {
        if (input.promptVersion === "campaign-dm-narration-v1") return dmCompletion(input);
        const candidates = (JSON.parse(input.messages[1]!.content as string) as { candidates: Array<{ action: string; label: string; candidateId: string; digest: string }> }).candidates;
        const selected = candidates.find(candidate => candidate.action === "resolve-node" && candidate.label === "Resolve bound scene: Bound scene");
        if (!selected) throw new Error("long binding resolve candidate unavailable");
        return { message: { role: "assistant" as const, content: "SECRET_PROVIDER_PROSE", toolCalls: [{ id: "choice", name: "select_dm_beat", arguments: JSON.stringify({ selection: { candidateId: selected.candidateId, digest: selected.digest } }) }] }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: { requestedModel: "fake-dm", responseModel: "fake-dm" } };
      }));
      const committedEvidence = connection.prepare("SELECT count(*) count FROM dm_story_evidence WHERE campaign_id=?").get(fixture.campaign.id);
      expect(committedEvidence).not.toEqual(before);
      expect(connection.prepare("SELECT run_id FROM dm_story_evidence WHERE campaign_id=? AND turn_id=?").get(fixture.campaign.id, turn.turnId)).toEqual({ run_id: resolving.runId });
      const committed = fixture.repo.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
      const reread = fixture.repo.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
      expect(committed).toEqual(reread);
      expect(committed.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "awaiting-play-evidence", reference: { kind: "binding", id: longReference } }),
      ]));
      expect(connection.prepare("SELECT count(*) count FROM dm_story_evidence WHERE campaign_id=?").get(fixture.campaign.id)).toEqual(committedEvidence);
      expect(connection.prepare("SELECT count(*) count FROM dm_review_scene_bindings WHERE campaign_id=?").get(fixture.campaign.id)).toEqual(beforeBindings);
    } finally {
      connection.close();
      fixture.repo.close();
    }
  });
});
