import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordSystemOneDecision, type RecordSystemOneDecisionInput } from "../src/repo/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const at = "2036-01-01T00:00:00.000Z";
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

/** A settled SRD turn whose source actor is wounded enough to advertise a short rest. */
async function seed() {
  const f = await dmFixture(true);
  f.repo.changeActorResourceForActor(OWNER, f.campaign.id, f.actorId,
    { kind: "change", resourceName: "health", amount: -5, expectedRevision: 0, idempotencyKey: "lane-rest-wound" });
  return f;
}
function turn(f: Awaited<ReturnType<typeof seed>>, key: string) {
  return f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration: "I take a short rest.",
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: key });
}
function rest(f: Awaited<ReturnType<typeof seed>>, turnId: string) {
  const candidate = f.repo.generateAdventureRestCandidates(OWNER, turnId).find((value) => value.restKind === "short");
  expect(candidate, "the wounded SRD fixture must advertise a short rest").toBeDefined(); return candidate!;
}
function decision(f: Awaited<ReturnType<typeof seed>>, turnId: string, overrides: Partial<RecordSystemOneDecisionInput> = {}) {
  const input: RecordSystemOneDecisionInput = { decisionId: "lane-decision:1", lane: "adventure-selection", campaignId: f.campaign.id,
    sessionId: f.session.id, turnId, provider: "typesafe", model: "fake", confidencePolicyVersion: "v1", state: { declaration: "rest" },
    questions: { support: 0.9 }, answers: { support: 0.9 }, selection: { method: "act", selection: null }, confidenceBand: "act",
    fallbackUsed: false, shadow: false, usage: null, latencyMs: 1, createdAt: at, ...overrides };
  recordSystemOneDecision(input);
  return input;
}
function laneInput(f: Awaited<ReturnType<typeof seed>>, created: ReturnType<typeof turn>,
  candidate: { candidateId: string; digest: string }, decisionId: string, idempotencyKey: string,
  overrides: Partial<{ candidateId: string; digest: string }> = {}) {
  return { turnId: created.turnId, decisionId, candidateId: candidate.candidateId, digest: candidate.digest,
    expectedTurnRevision: created.revision, expectedCampaignRevision: created.campaignRevision, idempotencyKey, ...overrides };
}

describe("lane-origin exact rest proposals", () => {
  it("appends one lane-origin confirmation-required rest proposal and replays per decision", async () => {
    const f = await seed(), created = turn(f, "lane-rest-append-turn"), candidate = rest(f, created.turnId);
    decision(f, created.turnId);
    const first = f.repo.appendAdventureRestProposalFromLane(OWNER, laneInput(f, created, candidate, "lane-decision:1", "lane-rest-append"));
    expect(first.toolCalls).toHaveLength(1);
    const proposal = first.toolCalls[0]!.proposal;
    expect(proposal.toolName).toBe("rest_short");
    expect(proposal.confirmation.state).toBe("pending");
    expect(proposal.policy).toMatchObject({ category: "rest-timing", requiresConfirmation: true, requiredAuthorizer: "controller" });

    const replay = f.repo.appendAdventureRestProposalFromLane(OWNER, laneInput(f, created, candidate, "lane-decision:1", "lane-rest-append"));
    expect(replay.toolCalls).toHaveLength(1);
    expect(replay.toolCalls[0]!.proposal.proposalId).toBe(proposal.proposalId);

    decision(f, created.turnId, { decisionId: "lane-decision:2" });
    expect(() => f.repo.appendAdventureRestProposalFromLane(OWNER, laneInput(f, created, candidate, "lane-decision:2", "lane-rest-append-2")))
      .toThrow("adventure rest proposal replay changed");

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT * FROM adventure_exact_action_proposal_bindings_v56 WHERE campaign_id=? AND turn_id=?")
      .get(f.campaign.id, created.turnId)).toMatchObject({ origin: "lane", system_one_decision_id: "lane-decision:1",
        provider_call_id: null, provider_tool_call_id: null, action_kind: "rest", candidate_id: candidate.candidateId,
        candidate_digest: candidate.digest });
    db.close(); f.repo.close();
  });

  it("commits only through the ordinary confirmation API and replays without rerolling", async () => {
    const f = await seed(), created = turn(f, "lane-rest-commit"), candidate = rest(f, created.turnId);
    decision(f, created.turnId);
    const proposed = f.repo.appendAdventureRestProposalFromLane(OWNER, laneInput(f, created, candidate, "lane-decision:1", "lane-rest-commit-append"));
    const proposalId = proposed.toolCalls[0]!.proposal.proposalId;
    // Without an approved confirmation decision nothing can execute.
    expect(() => f.repo.executeAdventurePowerRestProposal(OWNER, created.turnId, proposalId)).toThrow("not executable");

    const waiting = f.repo.waitForToolConfirmation(OWNER, { turnId: created.turnId, expectedTurnRevision: proposed.revision,
      expectedCampaignRevision: proposed.campaignRevision, idempotencyKey: "lane-rest-wait" });
    expect(waiting.state).toBe("awaiting-confirmation");
    f.repo.decideToolProposals(OWNER, { turnId: created.turnId, proposalIds: [proposalId], decision: "approved",
      expectedTurnRevision: waiting.revision, expectedCampaignRevision: waiting.campaignRevision, idempotencyKey: "lane-rest-approve" });

    const committed = f.repo.executeApprovedAgentProposalAtomically(OWNER, created.turnId, proposalId);
    expect(committed.status).toBe("committed");
    expect(committed.turn.receiptLinks).toHaveLength(1);
    const commandId = committed.turn.receiptLinks[0]!.commandId;
    const receipt = f.repo.getAdventureRestPublicReceipt(OWNER, f.campaign.id, commandId);
    expect(receipt).toMatchObject({ restKind: "short", restName: "Short rest", revisionBefore: 1, revisionAfter: 2 });
    expect(receipt!.recovery).toEqual([expect.objectContaining({ label: "Health", before: 7 }),
      { label: "Hit Dice D10", before: 1, after: 0 }]);

    const replay = f.repo.executeApprovedAgentProposalAtomically(OWNER, created.turnId, proposalId);
    expect(replay.status).toBe("committed");
    expect(replay.turn.receiptLinks[0]!.commandId).toBe(commandId);

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT * FROM adventure_exact_action_executions_v56 WHERE turn_id=?").get(created.turnId))
      .toMatchObject({ origin: "lane", system_one_decision_id: "lane-decision:1", provider_call_id: null,
        provider_tool_call_id: null, action_kind: "rest", command_id: commandId });
    expect(db.prepare("SELECT count(*) count FROM adventure_exact_action_executions_v56 WHERE turn_id=?").get(created.turnId)).toEqual({ count: 1 });
    db.close(); f.repo.close();
  });

  it("rejects unavailable decisions, tampered selections, and unadvertised candidates without writing", async () => {
    const f = await seed(), created = turn(f, "lane-rest-reject"), other = turn(f, "lane-rest-other"), candidate = rest(f, created.turnId);
    decision(f, created.turnId);
    decision(f, other.turnId, { decisionId: "other-turn-decision" });
    const append = (overrides: Record<string, unknown>) =>
      f.repo.appendAdventureRestProposalFromLane(OWNER, { ...laneInput(f, created, candidate, "lane-decision:1", "lane-rest-reject-append"), ...overrides });
    expect(() => append({ decisionId: "missing-decision" })).toThrow("not bound to an advertised lane candidate");
    expect(() => append({ decisionId: "other-turn-decision" })).toThrow("not bound to an advertised lane candidate");
    expect(() => append({ digest: "0".repeat(64) })).toThrow("not bound to an advertised lane candidate");
    expect(() => append({ candidateId: `rest-candidate:${"0".repeat(48)}` })).toThrow("not bound to an advertised lane candidate");
    const otherCandidate = rest(f, other.turnId);
    expect(() => f.repo.appendAdventureRestProposalFromLane(OWNER, { ...laneInput(f, created, otherCandidate, "other-turn-decision", "lane-rest-reject-other") }))
      .toThrow("not bound to an advertised lane candidate");

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT count(*) count FROM tool_proposals WHERE campaign_id=? AND turn_id=?").get(f.campaign.id, created.turnId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM adventure_exact_action_proposal_bindings_v56 WHERE campaign_id=? AND turn_id=?").get(f.campaign.id, created.turnId)).toEqual({ count: 0 });
    db.close(); f.repo.close();
  });

  it("fails a stale rest state closed before the shared execution rules commit", async () => {
    const f = await seed(), created = turn(f, "lane-rest-stale"), candidate = rest(f, created.turnId);
    decision(f, created.turnId);
    const proposed = f.repo.appendAdventureRestProposalFromLane(OWNER, laneInput(f, created, candidate, "lane-decision:1", "lane-rest-stale-append"));
    const proposalId = proposed.toolCalls[0]!.proposal.proposalId;
    const waiting = f.repo.waitForToolConfirmation(OWNER, { turnId: created.turnId, expectedTurnRevision: proposed.revision,
      expectedCampaignRevision: proposed.campaignRevision, idempotencyKey: "lane-rest-stale-wait" });
    f.repo.decideToolProposals(OWNER, { turnId: created.turnId, proposalIds: [proposalId], decision: "approved",
      expectedTurnRevision: waiting.revision, expectedCampaignRevision: waiting.campaignRevision, idempotencyKey: "lane-rest-stale-approve" });

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.prepare("UPDATE rpg_actor_resources SET current=0 WHERE campaign_id=? AND actor_id=? AND name='hit-dice-d10'").run(f.campaign.id, f.actorId);
    db.close();
    expect(() => f.repo.executeAdventurePowerRestProposal(OWNER, created.turnId, proposalId)).toThrow("stale or tampered");

    const inspect = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(inspect.prepare("SELECT count(*) count FROM adventure_exact_action_executions_v56 WHERE turn_id=?").get(created.turnId)).toEqual({ count: 0 });
    expect(inspect.prepare("SELECT count(*) count FROM rpg_rest_receipts_v25 WHERE campaign_id=? AND actor_id=?").get(f.campaign.id, f.actorId)).toEqual({ count: 0 });
    inspect.close(); f.repo.close();
  });
});
