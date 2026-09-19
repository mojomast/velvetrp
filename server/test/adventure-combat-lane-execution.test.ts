import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSystemOneDecisionsByLane, recordSystemOneDecision, type RecordSystemOneDecisionInput } from "../src/repo/index.js";
import { recordAdventureShadowDecision, type SystemOneAdventureDependency } from "../src/agent/adventureOrchestrator.js";
import { ADVENTURE_BEST_KEY, ADVENTURE_NONE, ADVENTURE_RELEVANCE_PREFIX, ADVENTURE_SUPPORTED_KEY,
  type AdventureSelectionCandidate } from "../src/agent/systemOneAdventure.js";
import { defaultSystemOneLaneModes, defaultSystemOneSettings } from "../src/defaults.js";
import { createFakeSystemOneCaller } from "../src/provider/systemOneFake.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const at = "2036-01-01T00:00:00.000Z";
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

/**
 * A settled SRD fighter fixture whose prepared encounter is active and owned by the reviewed
 * fighter, so the combat-power family advertises the executable Second Wind candidate.
 */
async function seed() {
  const f = await dmFixture(true);
  const prepared = f.prepare();
  let combat = f.repo.startEncounter(OWNER, prepared.encounterId,
    { expectedRevision: prepared.revision, idempotencyKey: "lane-combat-start" }).combat;
  const heroCombatant = combat.combatants.find((entry) => entry.kind === "actor" && entry.actorId === f.actorId)!.combatantId;
  // The fixture pins the RNG, so the fighter normally wins initiative; skip any earlier turn by
  // the server-authored enemy path instead of assuming the order.
  for (let step = 0; step < 8 && combat.currentCombatant !== heroCombatant; step += 1) {
    const acting = combat.combatants.find((entry) => entry.combatantId === combat.currentCombatant)!;
    combat = acting.kind === "enemy"
      ? f.repo.executeCombatEnemyTurn(OWNER, combat.combatId, { expectedRevision: combat.revision, idempotencyKey: `lane-combat-enemy-${step}` }).combat
      : f.repo.resolveCombatAction(OWNER, combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [],
        expectedRevision: combat.revision, idempotencyKey: `lane-combat-end-${step}` }).combat;
  }
  expect(combat.currentCombatant, "the reviewed fighter must own the combat turn").toBe(heroCombatant);
  return f;
}
function turn(f: Awaited<ReturnType<typeof seed>>, key: string) {
  return f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration: "I use Second Wind.",
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: key });
}
function combatPower(f: Awaited<ReturnType<typeof seed>>, turnId: string) {
  const candidate = f.repo.generateAdventureCombatPowerCandidates(OWNER, turnId).find((value) => value.powerName === "Second Wind");
  expect(candidate, "the reviewed SRD fighter must advertise Second Wind").toBeDefined(); return candidate!;
}
function decision(f: Awaited<ReturnType<typeof seed>>, turnId: string, overrides: Partial<RecordSystemOneDecisionInput> = {}) {
  const input: RecordSystemOneDecisionInput = { decisionId: "lane-combat-decision:1", lane: "adventure-selection", campaignId: f.campaign.id,
    sessionId: f.session.id, turnId, provider: "typesafe", model: "fake", confidencePolicyVersion: "v1", state: { declaration: "Second Wind" },
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

describe("lane-origin exact combat proposals", () => {
  it("appends one lane-origin confirmation-required combat proposal and replays per decision", async () => {
    const f = await seed(), created = turn(f, "lane-combat-append-turn"), candidate = combatPower(f, created.turnId);
    decision(f, created.turnId);
    const first = f.repo.appendAdventureCombatProposalFromLane(OWNER, laneInput(f, created, candidate, "lane-combat-decision:1", "lane-combat-append"));
    expect(first.toolCalls).toHaveLength(1);
    const proposal = first.toolCalls[0]!.proposal;
    expect(proposal.toolName).toBe("combat_power_use");
    expect(proposal.confirmation.state).toBe("pending");
    expect(proposal.policy).toMatchObject({ category: "ambiguous-limited-resource-use", requiresConfirmation: true, requiredAuthorizer: "controller" });
    expect(JSON.parse(proposal.argumentsJson)).toMatchObject({ candidateId: candidate.candidateId, digest: candidate.digest,
      systemOneDecisionId: "lane-combat-decision:1", powerName: "Second Wind", powerTargets: ["Hero"] });

    const replay = f.repo.appendAdventureCombatProposalFromLane(OWNER, laneInput(f, created, candidate, "lane-combat-decision:1", "lane-combat-append"));
    expect(replay.toolCalls).toHaveLength(1);
    expect(replay.toolCalls[0]!.proposal.proposalId).toBe(proposal.proposalId);

    decision(f, created.turnId, { decisionId: "lane-combat-decision:2" });
    expect(() => f.repo.appendAdventureCombatProposalFromLane(OWNER, laneInput(f, created, candidate, "lane-combat-decision:2", "lane-combat-append-2")))
      .toThrow("adventure combat proposal replay changed");

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT * FROM adventure_exact_action_proposal_bindings_v56 WHERE campaign_id=? AND turn_id=?")
      .get(f.campaign.id, created.turnId)).toMatchObject({ origin: "lane", system_one_decision_id: "lane-combat-decision:1",
        provider_call_id: null, provider_tool_call_id: null, action_kind: "combat-power", candidate_id: candidate.candidateId,
        candidate_digest: candidate.digest });
    db.close(); f.repo.close();
  });

  it("commits the approved combat proposal only through the ordinary confirmation API and replays without rerolling", async () => {
    const f = await seed(), created = turn(f, "lane-combat-commit"), candidate = combatPower(f, created.turnId);
    decision(f, created.turnId);
    const proposed = f.repo.appendAdventureCombatProposalFromLane(OWNER, laneInput(f, created, candidate, "lane-combat-decision:1", "lane-combat-commit-append"));
    const proposalId = proposed.toolCalls[0]!.proposal.proposalId;
    // Without an approved confirmation decision nothing can execute.
    expect(() => f.repo.executeAdventurePowerRestProposal(OWNER, created.turnId, proposalId)).toThrow("not executable");

    const waiting = f.repo.waitForToolConfirmation(OWNER, { turnId: created.turnId, expectedTurnRevision: proposed.revision,
      expectedCampaignRevision: proposed.campaignRevision, idempotencyKey: "lane-combat-wait" });
    expect(waiting.state).toBe("awaiting-confirmation");
    f.repo.decideToolProposals(OWNER, { turnId: created.turnId, proposalIds: [proposalId], decision: "approved",
      expectedTurnRevision: waiting.revision, expectedCampaignRevision: waiting.campaignRevision, idempotencyKey: "lane-combat-approve" });

    const committed = f.repo.executeApprovedAgentProposalAtomically(OWNER, created.turnId, proposalId);
    expect(committed.status).toBe("committed");
    expect(committed.turn.receiptLinks).toHaveLength(1);
    const commandId = committed.turn.receiptLinks[0]!.commandId;
    const receipt = f.repo.getAdventureCombatPowerPublicReceipt(OWNER, f.campaign.id, commandId);
    expect(receipt).toMatchObject({ powerName: "Second Wind", target: "Hero", actionCost: "bonus-action" });

    const replay = f.repo.executeApprovedAgentProposalAtomically(OWNER, created.turnId, proposalId);
    expect(replay.status).toBe("committed");
    expect(replay.turn.receiptLinks[0]!.commandId).toBe(commandId);

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT * FROM adventure_exact_action_executions_v56 WHERE turn_id=?").get(created.turnId))
      .toMatchObject({ origin: "lane", system_one_decision_id: "lane-combat-decision:1", provider_call_id: null,
        provider_tool_call_id: null, action_kind: "combat-power", command_id: commandId });
    expect(db.prepare("SELECT count(*) count FROM adventure_exact_action_executions_v56 WHERE turn_id=?").get(created.turnId)).toEqual({ count: 1 });
    db.close(); f.repo.close();
  });

  it("rejects unavailable decisions, tampered selections, and unadvertised candidates without writing", async () => {
    const f = await seed(), created = turn(f, "lane-combat-reject"), other = turn(f, "lane-combat-other"), candidate = combatPower(f, created.turnId);
    decision(f, created.turnId);
    decision(f, other.turnId, { decisionId: "other-turn-combat-decision" });
    const append = (overrides: Record<string, unknown>) =>
      f.repo.appendAdventureCombatProposalFromLane(OWNER, { ...laneInput(f, created, candidate, "lane-combat-decision:1", "lane-combat-reject-append"), ...overrides });
    expect(() => append({ decisionId: "missing-decision" })).toThrow("not bound to an advertised lane candidate");
    expect(() => append({ decisionId: "other-turn-combat-decision" })).toThrow("not bound to an advertised lane candidate");
    expect(() => append({ digest: "0".repeat(64) })).toThrow("not bound to an advertised lane candidate");
    expect(() => append({ candidateId: `combat-power-candidate:${"0".repeat(48)}` })).toThrow("not bound to an advertised lane candidate");
    const otherCandidate = combatPower(f, other.turnId);
    expect(() => f.repo.appendAdventureCombatProposalFromLane(OWNER, { ...laneInput(f, created, otherCandidate, "other-turn-combat-decision", "lane-combat-reject-other") }))
      .toThrow("not bound to an advertised lane candidate");

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT count(*) count FROM tool_proposals WHERE campaign_id=? AND turn_id=?").get(f.campaign.id, created.turnId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM adventure_exact_action_proposal_bindings_v56 WHERE campaign_id=? AND turn_id=?").get(f.campaign.id, created.turnId)).toEqual({ count: 0 });
    db.close(); f.repo.close();
  });

  it("records advisory and waits for confirmation on a promoted active combat lane pick", async () => {
    const f = await seed(), created = turn(f, "lane-combat-active"), candidate = combatPower(f, created.turnId);
    const selection: AdventureSelectionCandidate = { candidateId: candidate.candidateId, digest: candidate.digest,
      kind: "exact_combat_power.select", label: "Use power: Second Wind" };
    const caller = createFakeSystemOneCaller({ scripted: {
      [ADVENTURE_SUPPORTED_KEY]: { type: "noul", noul: 0.9 },
      // The battery collapses to one group, so the composer reads its relevance directly; the
      // aggregate choice stays in the answers for observability only.
      [`${ADVENTURE_RELEVANCE_PREFIX}${candidate.candidateId}`]: { type: "score", score: 2.7, confidence: 0.9, legend: {}, probabilities: {} },
      [ADVENTURE_BEST_KEY]: { type: "choice", choice: candidate.candidateId, confidence: 0.9,
        probabilities: { [candidate.candidateId]: 0.95, [ADVENTURE_NONE]: 0.05 } },
    } });
    const lane: SystemOneAdventureDependency = { settings: { ...defaultSystemOneSettings(), enabled: true,
      laneModes: { ...defaultSystemOneLaneModes(), "adventure-selection": "active" }, apiKey: "test-key" }, caller };

    const commit = await recordAdventureShadowDecision(created, [selection], lane, f.repo);
    expect(commit?.outcome).toBe("awaiting-confirmation");
    const awaiting = commit!.turn;
    expect(awaiting.state).toBe("awaiting-confirmation");
    const proposal = awaiting.toolCalls[0]!.proposal;
    expect(proposal.toolName).toBe("combat_power_use");
    expect(proposal.confirmation.state).toBe("pending");
    expect(caller.calls).toHaveLength(1);

    const decisions = listSystemOneDecisionsByLane("adventure-selection", 10);
    expect(decisions).toHaveLength(1);
    const recorded = decisions[0]!;
    // Advisory-first ordering keeps shadow=true; the lane-origin binding/execution is the proof.
    expect(recorded).toMatchObject({ shadow: true, lane: "adventure-selection", turnId: created.turnId });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT * FROM adventure_exact_action_proposal_bindings_v56 WHERE turn_id=?").get(created.turnId))
      .toMatchObject({ origin: "lane", system_one_decision_id: recorded.decisionId, provider_call_id: null,
        provider_tool_call_id: null, action_kind: "combat-power" });
    db.close();

    // The unapproved lane proposal can never commit.
    expect(() => f.repo.executeAdventurePowerRestProposal(OWNER, created.turnId, proposal.proposalId)).toThrow("not executable");

    f.repo.decideToolProposals(OWNER, { turnId: created.turnId, proposalIds: [proposal.proposalId], decision: "approved",
      expectedTurnRevision: awaiting.revision, expectedCampaignRevision: awaiting.campaignRevision, idempotencyKey: "lane-combat-active-approve" });
    const execution = f.repo.executeApprovedAgentProposalAtomically(OWNER, created.turnId, proposal.proposalId);
    expect(execution.status).toBe("committed");
    expect(execution.turn.receiptLinks).toHaveLength(1);
    const inspect = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(inspect.prepare("SELECT * FROM adventure_exact_action_executions_v56 WHERE turn_id=?").get(created.turnId))
      .toMatchObject({ origin: "lane", system_one_decision_id: recorded.decisionId, provider_call_id: null,
        provider_tool_call_id: null, action_kind: "combat-power" });
    inspect.close(); f.repo.close();
  });
});
