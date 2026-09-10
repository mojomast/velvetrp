import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { cleanupTmpDataDirs, makeTmpDataDir } from "./helpers.js";
import { createReviewedAdventure, REVIEWED_ADVENTURE_PRIVATE_SENTINEL } from "./fixtures/reviewedAdventure.js";

const owner = "local-owner";
const provider = () => ({ ...defaultProviderSettings(), model: "reviewed-recovery" });
const deps = (complete: AdventureAgentDependencies["complete"], now = () => new Date("2036-01-01T00:00:00.000Z")): AdventureAgentDependencies => ({
  complete, getProvider: async () => provider(), getHarness: async () => defaultHarnessSettings(), now,
});
const result = (name: string, argumentsValue: unknown) => ({ message: { role: "assistant" as const, content: null, toolCalls: [{ id: `recovery:${name}`, name, arguments: JSON.stringify(argumentsValue) }] }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: { requestedModel: "reviewed-recovery", responseModel: "reviewed-recovery" } });

function gate<T>() {
  let gateEntered!: () => void;
  let release!: (value: T) => void;
  const entered = new Promise<void>((resolve) => { gateEntered = resolve; });
  return { entered, wait: () => { gateEntered(); return new Promise<T>((resolve) => { release = resolve; }); }, release: (value: T) => release(value) };
}

function dmSelection(input: any, action = "reveal-node") {
  const candidate = JSON.parse(input.messages[1].content).candidates.find((value: any) => value.action === action);
  if (!candidate) throw new Error(`reviewed ${action} candidate is unavailable`);
  return result("select_dm_beat", { selection: { candidateId: candidate.candidateId, digest: candidate.digest } });
}
function dmSelectionLabel(input: any, action: string, label: string) {
  const candidate = JSON.parse(input.messages[1].content).candidates.find((value: any) => value.action === action && value.label === label);
  if (!candidate) throw new Error(`reviewed ${label} candidate is unavailable`);
  return result("select_dm_beat", { selection: { candidateId: candidate.candidateId, digest: candidate.digest } });
}
function dmHold() { return result("select_dm_beat", { selection: null }); }

function finishTurn(fixture: Awaited<ReturnType<typeof createReviewedAdventure>>, turn: any, key: string) {
  const narrating = fixture.repo.updateAdventureTurnNarration(owner, { turnId: turn.turnId, expectedTurnRevision: turn.revision,
    expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `${key}:narrating`, narrationStatus: "in-progress" });
  return fixture.repo.updateAdventureTurnNarration(owner, { turnId: turn.turnId, expectedTurnRevision: narrating.revision,
    expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `${key}:completed`, narrationStatus: "completed", terminalState: "completed", fallbackNarration: "Verified evidence is complete." });
}

async function acceptHarborQuest(fixture: Awaited<ReturnType<typeof createReviewedAdventure>>) {
  const revision = fixture.repo.getCampaignAdministration(owner, fixture.campaignId)!.revision;
  const created = fixture.repo.createAdventureTurn(owner, { campaignId: fixture.campaignId, timelineId: fixture.repo.getCampaign(owner, fixture.campaignId)!.activeTimelineId,
    sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "I accept Restore the Harbor Light.", expectedCampaignRevision: revision, idempotencyKey: "recovery-accept" });
  const candidate = fixture.repo.generateAdventureQuestLifecycleCandidates(owner, created.turnId).find(value => value.action === "accept")!;
  const pending = await orchestrateAdventureTurn(fixture.repo, created.turnId, deps(async () => result("exact_quest_lifecycle.select", { candidateId: candidate.candidateId, digest: candidate.digest })));
  fixture.repo.decideToolProposals(owner, { turnId: created.turnId, proposalIds: [pending.turn.toolCalls[0]!.proposal.proposalId], decision: "approved",
    expectedTurnRevision: pending.turn.revision, expectedCampaignRevision: pending.turn.campaignRevision, idempotencyKey: "recovery-accept-approve" });
  return finishTurn(fixture, (await orchestrateAdventureTurn(fixture.repo, created.turnId, deps(async () => { throw new Error("accepted quest must not redispatch"); }))).turn, "recovery-accept");
}

async function completeObjective(fixture: Awaited<ReturnType<typeof createReviewedAdventure>>, objectiveId: string, key: string) {
  const revision = fixture.repo.getCampaignAdministration(owner, fixture.campaignId)!.revision;
  const created = fixture.repo.createAdventureTurn(owner, { campaignId: fixture.campaignId, timelineId: fixture.repo.getCampaign(owner, fixture.campaignId)!.activeTimelineId,
    sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: `I complete ${objectiveId}.`, expectedCampaignRevision: revision, idempotencyKey: key });
  const candidate = fixture.repo.listAdventureQuestObjectiveCandidates(owner, created.turnId).find(value => value.objectiveId === objectiveId)!;
  const completed = await orchestrateAdventureTurn(fixture.repo, created.turnId, deps(async () => result("exact_quest_objective.select", { candidateId: candidate.candidateId, digest: candidate.digest })));
  return finishTurn(fixture, completed.turn, key);
}

afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; delete process.env.FEATURE_RPG_COMBAT; cleanupTmpDataDirs(); });

describe("reviewed adventure interruption and recovery boundaries", () => {
  it("fences deferred planning before takeover without publishing provider text or changing state", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true";
    const fixture = await createReviewedAdventure(makeTmpDataDir());
    const paused = gate<any>(); let planningInput: any;
    try {
      fixture.repo.setDmControl(owner, fixture.campaignId, { mode: "ai", expectedRevision: 0, idempotencyKey: "delegate" });
      const run = fixture.repo.openDmBeat(owner, fixture.campaignId, fixture.sessionId, { intent: "open", expectedModeRevision: 1, idempotencyKey: "fenced-plan" });
      const work = orchestrateCampaignDmBeat(fixture.repo, owner, run.runId, deps(async input => {
        if (input.promptVersion === "campaign-dm-v1") { planningInput = input; return paused.wait(); }
        throw new Error("narration must not begin");
      }));
      await paused.entered;
      fixture.repo.setDmControl(owner, fixture.campaignId, { mode: "human", expectedRevision: 1, idempotencyKey: "takeover" });
      paused.release(dmHold());
      await work;
      const recovered = fixture.repo.getDmRun(owner, fixture.campaignId, fixture.sessionId, run.runId);
      expect(recovered).toMatchObject({ state: "cancelled", receipts: [], narration: null });
      expect(JSON.stringify(recovered)).not.toContain(REVIEWED_ADVENTURE_PRIVATE_SENTINEL);
      const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
      expect(db.prepare("SELECT count(*) count FROM dm_public_history WHERE run_id=?").get(run.runId)).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) count FROM dm_receipts WHERE run_id=?").get(run.runId)).toEqual({ count: 0 }); db.close();
    } finally { fixture.repo.close(); }
  });

  it("keeps one committed receipt but fences deferred narration after takeover", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true";
    const fixture = await createReviewedAdventure(makeTmpDataDir()); const paused = gate<any>();
    try {
      fixture.repo.setDmControl(owner, fixture.campaignId, { mode: "ai", expectedRevision: 0, idempotencyKey: "delegate" });
      const run = fixture.repo.openDmBeat(owner, fixture.campaignId, fixture.sessionId, { intent: "open", expectedModeRevision: 1, idempotencyKey: "fenced-narration" });
      const work = orchestrateCampaignDmBeat(fixture.repo, owner, run.runId, deps(async input => input.promptVersion === "campaign-dm-v1"
        ? dmSelection(input, "encounter-start") : paused.wait()));
      await paused.entered;
      fixture.repo.setDmControl(owner, fixture.campaignId, { mode: "human", expectedRevision: 1, idempotencyKey: "takeover-after-commit" });
      paused.release(result("submit_dm_scene", { atmosphere: "FENCED PROVIDER TEXT", dialogue: [], question: "What now?" }));
      await work;
      const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
      expect(db.prepare("SELECT count(*) count FROM dm_receipts WHERE run_id=?").get(run.runId)).toEqual({ count: 1 });
      expect(db.prepare("SELECT count(*) count FROM dm_public_history WHERE run_id=?").get(run.runId)).toEqual({ count: 0 }); db.close();
      expect(JSON.stringify(fixture.repo.getDmRun(owner, fixture.campaignId, fixture.sessionId, run.runId))).not.toContain("FENCED PROVIDER TEXT");
    } finally { fixture.repo.close(); }
  });

  it("honors rejected and stale reviewed approvals without consuming evidence or receipts", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true";
    const fixture = await createReviewedAdventure(makeTmpDataDir());
    try {
      const run = fixture.repo.openDmBeat(owner, fixture.campaignId, fixture.sessionId, { intent: "open", expectedModeRevision: 0, idempotencyKey: "reject" });
      await orchestrateCampaignDmBeat(fixture.repo, owner, run.runId, deps(async input => dmSelection(input, "encounter-start")));
      const pending = fixture.repo.getDmProposal(owner, fixture.campaignId, fixture.sessionId, run.runId);
      fixture.repo.decideDmBeat(owner, fixture.campaignId, fixture.sessionId, run.runId, { decision: "rejected", expectedRevision: pending.run.revision, idempotencyKey: "reject" });
      expect(fixture.repo.getDmRun(owner, fixture.campaignId, fixture.sessionId, run.runId)).toMatchObject({ state: "cancelled", receipts: [] });
      let rejectedCalls = 0;
      await orchestrateCampaignDmBeat(fixture.repo, owner, run.runId, deps(async () => { rejectedCalls += 1; throw new Error("rejected runs must not redispatch"); }));
      expect(rejectedCalls).toBe(0);
      const stale = fixture.repo.openDmBeat(owner, fixture.campaignId, fixture.sessionId, { intent: "continue", expectedModeRevision: 0, idempotencyKey: "stale" });
      await orchestrateCampaignDmBeat(fixture.repo, owner, stale.runId, deps(async input => dmSelection(input, "encounter-start")));
      const proposal = fixture.repo.getDmProposal(owner, fixture.campaignId, fixture.sessionId, stale.runId);
      expect(() => fixture.repo.decideDmBeat(owner, fixture.campaignId, fixture.sessionId, stale.runId, { decision: "approved", expectedRevision: proposal.run.revision - 1, idempotencyKey: "stale-approve" })).toThrow("proposal revision stale");
      expect(fixture.repo.getDmRun(owner, fixture.campaignId, fixture.sessionId, stale.runId).receipts).toEqual([]);
      let staleCalls = 0;
      await orchestrateCampaignDmBeat(fixture.repo, owner, stale.runId, deps(async () => { staleCalls += 1; throw new Error("stale approvals must not redispatch"); }));
      expect(staleCalls).toBe(0);
    } finally { fixture.repo.close(); }
  });

  it("recovers a sealed committed response exactly once without another provider call", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true";
    const fixture = await createReviewedAdventure(makeTmpDataDir());
    try {
      const revision = fixture.repo.getCampaignAdministration(owner, fixture.campaignId)!.revision;
      const created = fixture.repo.createAdventureTurn(owner, { campaignId: fixture.campaignId, timelineId: fixture.repo.getCampaign(owner, fixture.campaignId)!.activeTimelineId, sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "Strength (Strength), Easy difficulty, normal.", expectedCampaignRevision: revision, idempotencyKey: "lost-response" });
      const candidate = fixture.repo.generateAdventureCheckCandidates(owner, created.turnId).find(value => value.label === "Strength (Strength), Easy difficulty, normal")!;
      const interrupted = vi.spyOn(fixture.repo, "executeAdventureCheckCandidate").mockImplementationOnce(() => { throw new Error("lost after commit"); });
      await orchestrateAdventureTurn(fixture.repo, created.turnId, deps(async () => result("exact_srd_check.select", { candidateId: candidate.candidateId, digest: candidate.digest })));
      interrupted.mockRestore(); let calls = 0;
      const recovered = await orchestrateAdventureTurn(fixture.repo, created.turnId, deps(async () => { calls += 1; throw new Error("must not redispatch"); }));
      expect(calls).toBe(0); expect(recovered.turn.receiptLinks).toHaveLength(1);
      const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
      expect(db.prepare("SELECT count(*) count FROM adventure_check_executions_v54 WHERE turn_id=?").get(created.turnId)).toEqual({ count: 1 }); db.close();
    } finally { fixture.repo.close(); }
  });

  it("rejects wrong, failed, and already-used reviewed scene evidence", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true";
    let now = Date.parse("2036-01-01T00:00:00.000Z");
    const fixture = await createReviewedAdventure(makeTmpDataDir(), { prepareOptionalEncounter: false, rng: { integer: minimum => minimum }, clock: { now: () => new Date(now) } });
    const inspect = async (key: string, evidenceTurnId: string) => {
      const run = fixture.repo.openDmBeat(owner, fixture.campaignId, fixture.sessionId, { intent: "continue", expectedModeRevision: 1, idempotencyKey: key, evidenceTurnId });
      let candidates: any[] = [];
      await orchestrateCampaignDmBeat(fixture.repo, owner, run.runId, deps(async input => {
        if (input.promptVersion === "campaign-dm-v1") candidates = JSON.parse(input.messages[1]!.content as string).candidates;
        return dmHold();
      }));
      return { run: fixture.repo.getDmRun(owner, fixture.campaignId, fixture.sessionId, run.runId), candidates };
    };
    try {
      fixture.repo.setDmControl(owner, fixture.campaignId, { mode: "ai", expectedRevision: 0, idempotencyKey: "evidence-delegate" });
      await acceptHarborQuest(fixture);
      const reveal = fixture.repo.openDmBeat(owner, fixture.campaignId, fixture.sessionId, { intent: "continue", expectedModeRevision: 1, idempotencyKey: "reveal-lens" });
      await orchestrateCampaignDmBeat(fixture.repo, owner, reveal.runId, deps(async input => input.promptVersion === "campaign-dm-v1"
        ? dmSelectionLabel(input, "reveal-node", "Reveal scene: Lens Recovered") : result("submit_dm_scene", { atmosphere: "The lens catches the light.", dialogue: [], question: "What next?" })));
      now += 1_000;
      const hear = await completeObjective(fixture, fixture.resourceIds["hear-keeper"]!, "evidence-hear");
      const failedCreated = fixture.repo.createAdventureTurn(owner, { campaignId: fixture.campaignId, timelineId: fixture.repo.getCampaign(owner, fixture.campaignId)!.activeTimelineId,
        sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "Strength (Strength), Easy difficulty, normal.", expectedCampaignRevision: fixture.repo.getCampaignAdministration(owner, fixture.campaignId)!.revision, idempotencyKey: "failed-check" });
      const failedCandidate = fixture.repo.generateAdventureCheckCandidates(owner, failedCreated.turnId).find(value => value.label === "Strength (Strength), Easy difficulty, normal")!;
      const failed = finishTurn(fixture, (await orchestrateAdventureTurn(fixture.repo, failedCreated.turnId, deps(async () => result("exact_srd_check.select", { candidateId: failedCandidate.candidateId, digest: failedCandidate.digest })))).turn, "failed-check");
      expect((await inspect("failed-evidence", failed.turnId)).run.blockers).toContain("evidence-needs-successful-check-objective-or-defeat");
      const wrong = await inspect("wrong-evidence", hear.turnId);
      expect(wrong.candidates.some(candidate => candidate.action === "resolve-node")).toBe(false);
      const secure = await completeObjective(fixture, fixture.resourceIds["secure-lens"]!, "evidence-secure");
      const resolve = fixture.repo.openDmBeat(owner, fixture.campaignId, fixture.sessionId, { intent: "continue", expectedModeRevision: 1, idempotencyKey: "resolve-lens", evidenceTurnId: secure.turnId });
      await orchestrateCampaignDmBeat(fixture.repo, owner, resolve.runId, deps(async input => input.promptVersion === "campaign-dm-v1"
        ? dmSelection(input, "resolve-node") : result("submit_dm_scene", { atmosphere: "The recovered lens is secure.", dialogue: [], question: "What next?" })));
      const resolved = fixture.repo.getDmRun(owner, fixture.campaignId, fixture.sessionId, resolve.runId);
      expect(resolved.receipts, JSON.stringify(resolved)).toHaveLength(1);
      const used = await inspect("used-evidence", secure.turnId);
      expect(used.run.blockers).toContain("evidence-unavailable-or-already-used");
      expect(used.candidates.some(candidate => candidate.action === "resolve-node")).toBe(false);
    } finally { fixture.repo.close(); }
  });

  it("leaves an expired dispatched DM beat unknown and permits withdrawal before activation without combat", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true";
    let now = Date.parse("2036-01-01T00:00:00.000Z");
    const withdrawn = await createReviewedAdventure(makeTmpDataDir(), { activateRoom: false, prepareOptionalEncounter: false, clock: { now: () => new Date(now) } });
    try {
      expect(withdrawn.repo.getCampaignRoomActivationReadiness(owner, withdrawn.campaignId, withdrawn.sessionId)).toMatchObject({ ready: true, active: false });
      const stopped = withdrawn.repo.transitionSession(withdrawn.sessionId, "closed", "player-withdrew-before-activation")!;
      expect(stopped).toMatchObject({ state: "closed", stopReason: "player-withdrew-before-activation" });
      expect(withdrawn.repo.listEncounters(owner, withdrawn.campaignId)).toEqual([]);
      expect(JSON.stringify({ stopped, encounters: withdrawn.repo.listEncounters(owner, withdrawn.campaignId) })).not.toMatch(/retreat/i);
    } finally { withdrawn.repo.close(); }
    const fixture = await createReviewedAdventure(makeTmpDataDir(), { clock: { now: () => new Date(now) } });
    try {
      fixture.repo.setDmControl(owner, fixture.campaignId, { mode: "ai", expectedRevision: 0, idempotencyKey: "delegate" });
      const run = fixture.repo.openDmBeat(owner, fixture.campaignId, fixture.sessionId, { intent: "open", expectedModeRevision: 1, idempotencyKey: "unknown" });
      const claimed = fixture.repo.claimDmPlanning(owner, run.runId, "fake", "fake")!;
      now += 31_000;
      let calls = 0; await orchestrateCampaignDmBeat(fixture.repo, owner, run.runId, deps(async () => { calls += 1; throw new Error("must not retry"); }, () => new Date(now)));
      expect(calls).toBe(0); expect(fixture.repo.getDmRun(owner, fixture.campaignId, fixture.sessionId, run.runId)).toMatchObject({ state: "unknown", receipts: [] });
      const late = claimed.candidates[0]!;
      expect(() => fixture.repo.settleDmPlanning(owner, run.runId, claimed.claimId, { candidateId: late.candidateId, digest: late.digest }, null)).not.toThrow();
      expect(fixture.repo.getDmRun(owner, fixture.campaignId, fixture.sessionId, run.runId)).toMatchObject({ state: "unknown", receipts: [] });
    } finally { fixture.repo.close(); }
  });
});
