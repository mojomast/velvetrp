import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdventureTurnAuthorizationError, AdventureTurnConflictError, AdventureTurnExpiredError, AdventureTurnStaleError,
  AdventureTurnUnavailableError, createRepository,
} from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const AT = "2035-01-01T00:00:00.000Z";
const EXPIRES = "2035-01-01T00:10:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function seed(): { campaignId: string; timelineId: string } {
  const initial = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
  const campaign = initial.createCampaign("local-owner", { name: "Adventure turns" });
  initial.close();
  const db = new DatabaseDriver(dbPath()); db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO principals VALUES ('player','Player',0),('observer','Observer',0),('outsider','Outsider',0)").run();
  db.prepare("INSERT INTO campaign_memberships VALUES (?,'player','player',?),(?,'observer','observer',?)")
    .run(campaign.id, AT, campaign.id, AT);
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(AT);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('turn-profile','Turn profile','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('turn-pack','1','turn-profile','Turn pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('turn-pack','1','race','human','Human','Race','[]'),('turn-pack','1','background','hero','Hero','Background','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='turn-pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'turn-profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'turn-pack','1','turn-profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','turn-pack','1','race','human','turn-pack','1','background','hero',?,?)")
    .run(campaign.id, AT, AT);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor',?,'player','private')").run(campaign.id);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(AT);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, AT);
  db.close();
  return { campaignId: campaign.id, timelineId: campaign.activeTimelineId };
}

let factorySequence = 0;
function factory(at = AT) {
  const factoryId = ++factorySequence;
  let sequence = 0;
  return createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(at) },
    ids: { nextId: () => `turn-id-${factoryId}-${++sequence}` }, rng: { integer: (minimum) => minimum } });
}

const createInput = (identity: { campaignId: string; timelineId: string }, key = "turn-create") => ({
  campaignId: identity.campaignId, timelineId: identity.timelineId, sessionId: "session", actorId: "actor",
  declaration: "I inspect the sealed door", expectedCampaignRevision: 0, idempotencyKey: key,
});

describe("M1.10 adventure turn repository", () => {
  it("survives restart, seals duplicate confirmation, preserves receipts, and supports narration-only retries", () => {
    const identity = seed(); let repo = factory();
    const created = repo.createAdventureTurn("player", createInput(identity));
    expect(repo.createAdventureTurn("player", createInput(identity))).toEqual(created);
    const proposed = repo.appendToolProposal("player", { turnId: created.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "proposal", toolName: "roll-check", arguments: { attribute: "insight" }, requiresConfirmation: true,
      confirmationExpiresAt: EXPIRES });
    const proposalId = proposed.toolCalls[0]!.proposal.proposalId;
    const waiting = repo.waitForToolConfirmation("player", { turnId: created.turnId, expectedTurnRevision: 1,
      expectedCampaignRevision: 0, idempotencyKey: "wait" });
    expect(waiting.state).toBe("awaiting-confirmation");
    expect(repo.waitForToolConfirmation("player", { turnId: created.turnId, expectedTurnRevision: 1,
      expectedCampaignRevision: 0, idempotencyKey: "wait" })).toEqual(waiting);
    const approved = repo.decideToolProposal("player", { turnId: created.turnId, proposalId, decision: "approved", expiresAt: EXPIRES,
      expectedTurnRevision: 2, expectedCampaignRevision: 0, idempotencyKey: "approve" });
    expect(approved.state).toBe("confirmed");
    expect(approved.receiptLinks).toEqual([]);
    expect(repo.decideToolProposal("player", { turnId: created.turnId, proposalId, decision: "approved", expiresAt: EXPIRES,
      expectedTurnRevision: 2, expectedCampaignRevision: 0, idempotencyKey: "approve" })).toEqual(approved);
    expect(() => repo.decideToolProposal("player", { turnId: created.turnId, proposalId, decision: "rejected", expiresAt: EXPIRES,
      expectedTurnRevision: 3, expectedCampaignRevision: 0, idempotencyKey: "different-decision" })).toThrow(AdventureTurnConflictError);

    const receipt = repo.executeRollActorDice("local-owner", { commandId: "mechanics-command", idempotencyKey: "mechanics-command",
      campaignId: identity.campaignId, timelineId: identity.timelineId, actorId: "actor", expectedRevision: 0,
      sourceTurnId: created.turnId, command: { type: "roll_actor_dice", payload: { expression: "1d20" } } });
    const linked = repo.linkFinalMechanicsReceipt("player", { turnId: created.turnId, proposalId, commandId: receipt.commandId,
      expectedTurnRevision: 3, expectedCampaignRevision: 0, idempotencyKey: "link" });
    expect(linked.state).toBe("mechanics-committed");
    expect(linked.receiptLinks.map((link) => link.commandId)).toEqual(["mechanics-command"]);
    const started = repo.recordProviderCallStart("player", { turnId: created.turnId, callId: "narration", provider: "test",
      model: "model", attempt: 1, expectedTurnRevision: 4, expectedCampaignRevision: 0, idempotencyKey: "provider-start" });
    const completed = repo.recordProviderCallOutcome("player", { turnId: created.turnId, callId: "narration", provider: "test",
      model: "model", attempt: 1, outcome: "succeeded", outcomeCode: "ok", promptTokens: 3, completionTokens: 5,
      expectedTurnRevision: started.revision, expectedCampaignRevision: 0, idempotencyKey: "provider-outcome" });
    expect(completed).toMatchObject({ state: "narrating", narrationStatus: "in-progress" });
    const narrated = repo.updateAdventureTurnNarration("player", { turnId: created.turnId, narrationStatus: "completed", terminalState: "completed",
      expectedTurnRevision: completed.revision, expectedCampaignRevision: 0, idempotencyKey: "narration-complete" });
    expect(narrated).toMatchObject({ state: "completed", narrationStatus: "completed" });
    const sealed = new DatabaseDriver(dbPath()); sealed.pragma("recursive_triggers=OFF");
    for (const table of ["adventure_turns", "tool_proposals", "confirmation_decisions", "provider_call_metadata", "final_receipt_links",
      "adventure_coordination_commands_v36", "adventure_coordination_events_v36", "adventure_coordination_receipts_v36", "turn_mechanics_links_v36"]) {
      expect(() => sealed.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`), table).toThrow();
    }
    expect(() => sealed.prepare("UPDATE confirmation_decisions SET decision='rejected'").run()).toThrow("immutable");
    sealed.close();
    repo.close();

    repo = factory();
    expect(repo.getAdventureTurn("player", created.turnId)).toMatchObject({ revision: 7, receiptLinks: [{ commandId: "mechanics-command", proposalId }] });
    const retry = repo.createAdventureTurn("player", { ...createInput(identity, "retry"), declaration: "Narrate the same result again",
      mode: "narration-retry", priorTurnId: created.turnId });
    expect(retry.receiptLinks.map((link) => link.commandId)).toEqual(["mechanics-command"]);
    expect(() => repo.linkFinalMechanicsReceipt("player", { turnId: retry.turnId, proposalId, commandId: receipt.commandId,
      expectedTurnRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "retry-link" })).toThrow(AdventureTurnConflictError);
    const cancelledRetry = repo.updateAdventureTurnNarration("player", { turnId: retry.turnId, expectedTurnRevision: 0,
      expectedCampaignRevision: 0, idempotencyKey: "retry-cancel", narrationStatus: "pending", terminalState: "cancelled" });
    const swipe = repo.createAdventureTurn("player", { ...createInput(identity, "swipe"), declaration: "Try a third narration",
      mode: "narration-swipe", priorTurnId: cancelledRetry.turnId });
    expect(swipe.receiptLinks.map((link) => link.commandId)).toEqual(["mechanics-command"]);
    repo.updateAdventureTurnNarration("player", { turnId: swipe.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "swipe-cancel", narrationStatus: "pending", terminalState: "cancelled" });
    const fallback = repo.createAdventureTurn("player", { ...createInput(identity, "fallback"), declaration: "Use fallback narration",
      mode: "narration-fallback", priorTurnId: swipe.turnId });
    expect(fallback).toMatchObject({ mode: "narration-fallback", receiptLinks: [{ commandId: "mechanics-command" }] });
    repo.close();
  });

  it("enforces expiry and cancellation boundaries", () => {
    const identity = seed(); const repo = factory();
    const before = repo.createAdventureTurn("player", createInput(identity));
    const cancelled = repo.updateAdventureTurnNarration("player", { turnId: before.turnId, expectedTurnRevision: 0,
      expectedCampaignRevision: 0, idempotencyKey: "cancel-before", narrationStatus: "none", terminalState: "cancelled" });
    expect(cancelled.receiptLinks).toEqual([]);
    const after = repo.createAdventureTurn("player", createInput(identity, "cancel-after"));
    const afterProposal = repo.appendToolProposal("player", { turnId: after.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "no-confirm", toolName: "roll", arguments: {}, requiresConfirmation: false });
    const committed = repo.executeRollActorDice("local-owner", { commandId: "cancel-command", idempotencyKey: "cancel-command",
      campaignId: identity.campaignId, timelineId: identity.timelineId, actorId: "actor", expectedRevision: 0, sourceTurnId: after.turnId,
      command: { type: "roll_actor_dice", payload: { expression: "1d6" } } });
    repo.linkFinalMechanicsReceipt("player", { turnId: after.turnId, proposalId: afterProposal.toolCalls[0]!.proposal.proposalId,
      commandId: committed.commandId, expectedTurnRevision: 1,
      expectedCampaignRevision: 0, idempotencyKey: "cancel-link" });
    const cancelledAfter = repo.updateAdventureTurnNarration("player", { turnId: after.turnId, expectedTurnRevision: 2,
      expectedCampaignRevision: 0, idempotencyKey: "cancel-after-commit", narrationStatus: "pending", terminalState: "cancelled" });
    expect(cancelledAfter.receiptLinks.map((link) => link.commandId)).toEqual(["cancel-command"]);
    const expiring = repo.createAdventureTurn("player", createInput(identity, "expiring"));
    const proposal = repo.appendToolProposal("player", { turnId: expiring.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "expiring-proposal", toolName: "roll", arguments: {}, requiresConfirmation: true, confirmationExpiresAt: EXPIRES });
    repo.waitForToolConfirmation("player", { turnId: expiring.turnId, expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "wait" });
    repo.close();
    const expiredRepo = factory(EXPIRES);
    expect(() => expiredRepo.decideToolProposal("player", { turnId: expiring.turnId, proposalId: proposal.toolCalls[0]!.proposal.proposalId,
      decision: "approved", expiresAt: EXPIRES, expectedTurnRevision: 2, expectedCampaignRevision: 0, idempotencyKey: "late" }))
      .toThrow(AdventureTurnExpiredError);
    expiredRepo.close();
  });

  it("rechecks role, actor control, timeline identity, and revisions inside each immediate transaction", () => {
    const identity = seed(); const repo = factory();
    const turn = repo.createAdventureTurn("player", createInput(identity));
    expect(() => repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 99, expectedCampaignRevision: 0,
      idempotencyKey: "stale", toolName: "roll", arguments: {}, requiresConfirmation: false })).toThrow(AdventureTurnStaleError);
    repo.changeAuditedCampaignMembershipRole("local-owner", identity.campaignId, "player", { role: "observer", expectedRevision: 0, idempotencyKey: "demote" });
    expect(() => repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 1,
      idempotencyKey: "lost-role", toolName: "roll", arguments: {}, requiresConfirmation: false })).toThrow(AdventureTurnAuthorizationError);
    const checkpoint = repo.createCampaignCheckpoint("local-owner", identity.campaignId, { timelineId: identity.timelineId, timelineRevision: 0,
      label: "Before fork", expectedRevision: 1, idempotencyKey: "checkpoint" });
    repo.forkCampaignTimeline("local-owner", identity.campaignId, { checkpointId: checkpoint.value.id, expectedRevision: 2, idempotencyKey: "fork" });
    expect(() => repo.appendToolProposal("local-owner", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 3,
      idempotencyKey: "old-timeline", toolName: "roll", arguments: {}, requiresConfirmation: false })).toThrow(AdventureTurnStaleError);
    repo.close();
  });

  it("retains history after room detachment but refuses every resume", () => {
    const identity = seed(); const repo = factory();
    const turn = repo.createAdventureTurn("player", createInput(identity));
    const db = new DatabaseDriver(dbPath()); db.prepare("DELETE FROM campaign_sessions WHERE campaign_id=? AND session_id='session'").run(identity.campaignId); db.close();
    expect(repo.getAdventureTurn("player", turn.turnId)).toMatchObject({ turnId: turn.turnId });
    expect(() => repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "detached", toolName: "roll", arguments: {}, requiresConfirmation: false })).toThrow(AdventureTurnStaleError);
    repo.close();
  });

  it("creates, reviews, applies, reopens, and role-redacts generated drafts", () => {
    const identity = seed(); let repo = factory();
    const draft = repo.createGenerationDraft("local-owner", { campaignId: identity.campaignId, timelineId: identity.timelineId,
      kind: "encounter", stagedContent: { title: "Hidden ambush", gmSecret: "three shadows" },
      validation: { valid: true, issues: [], validatedAt: AT }, expectedCampaignRevision: 0, idempotencyKey: "draft" });
    const safe = repo.getGenerationDraft("observer", draft.draftId)!;
    expect("stagedContent" in safe).toBe(false); expect(JSON.stringify(safe)).not.toContain("three shadows");
    expect(() => repo.getGenerationDraft("outsider", draft.draftId)).toThrow(AdventureTurnUnavailableError);
    expect(() => repo.reviewGenerationDraft("observer", { draftId: draft.draftId, decision: "approved",
      expectedDraftRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "observer-review" })).toThrow(AdventureTurnAuthorizationError);
    const reviewed = repo.reviewGenerationDraft("local-owner", { draftId: draft.draftId, decision: "approved", notes: "Apply it",
      expectedDraftRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "review" });
    expect(reviewed).toMatchObject({ state: "approved", revision: 1 });
    const revisionDb = new DatabaseDriver(dbPath(), { readonly: true });
    expect(revisionDb.prepare("SELECT state,revision FROM generation_drafts WHERE id=?").get(draft.draftId)).toEqual({ state: "approved", revision: 1 });
    expect(revisionDb.prepare("SELECT expected_draft_revision FROM review_decisions WHERE draft_id=?").get(draft.draftId)).toEqual({ expected_draft_revision: 0 });
    expect(revisionDb.prepare(`SELECT command.expected_revision,command.resulting_revision,event.resulting_revision FROM adventure_coordination_commands_v36 command
      JOIN adventure_coordination_events_v36 event ON event.command_id=command.command_id WHERE command.aggregate_kind='draft' AND command.aggregate_id=?
        AND command.mutation_type='draft-review'`).get(draft.draftId)).toEqual({ expected_revision: 0, resulting_revision: 1 });
    revisionDb.close();
    expect(() => repo.applyGenerationDraft("local-owner", { draftId: draft.draftId, commandId: "unrelated", expectedDraftRevision: 1,
      expectedCampaignRevision: 0, idempotencyKey: "bad-apply" } as never)).toThrow();
    const applied = repo.applyGenerationDraft("local-owner", { draftId: draft.draftId, result: { encounterId: "ambush" },
      expectedDraftRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "apply" });
    expect(applied).toMatchObject({ state: "applied", applyState: "applied", applyReceipt: { result: { encounterId: "ambush" } } });
    const sealed = new DatabaseDriver(dbPath()); sealed.pragma("recursive_triggers=OFF");
    for (const table of ["generation_drafts", "review_decisions", "generation_draft_apply_receipts_v36"]) {
      expect(() => sealed.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`), table).toThrow();
    }
    expect(() => sealed.prepare("DELETE FROM review_decisions").run()).toThrow("immutable"); sealed.close();
    repo.close(); repo = factory();
    expect(repo.getGenerationDraft("local-owner", draft.draftId)).toMatchObject({ state: "applied", revision: 2 });
    repo.close();
  });

  it("forbids nested unit-of-work mutations and calls no asynchronous provider inside a transaction", () => {
    const identity = seed(); const repo = factory();
    expect(() => repo.transaction(() => repo.createAdventureTurn("player", createInput(identity))))
      .toThrow("M1.10 operation cannot run inside a repository transaction");
    expect(repo.getAdventureTurn("player", "missing")).toBeNull();
    repo.close();
  });

  it("reconciles a deterministic command committed immediately before a crash", () => {
    const identity = seed(); let repo = factory();
    const turn = repo.createAdventureTurn("player", createInput(identity, "crash-turn"));
    const proposed = repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "crash-proposal", toolName: "roll", arguments: {}, requiresConfirmation: false });
    repo.executeRollActorDice("local-owner", { commandId: "crash-command", idempotencyKey: "crash-command", campaignId: identity.campaignId,
      timelineId: identity.timelineId, actorId: "actor", expectedRevision: 0, sourceTurnId: turn.turnId,
      command: { type: "roll_actor_dice", payload: { expression: "1d20" } } });
    repo.close();
    repo = factory();
    const reconciled = repo.reconcileAdventureTurnMechanics("player", { turnId: turn.turnId, expectedTurnRevision: 1,
      expectedCampaignRevision: 0, idempotencyKey: "crash-reconcile" });
    expect(reconciled).toMatchObject({ state: "mechanics-committed",
      toolCalls: [{ status: "committed", proposal: { proposalId: proposed.toolCalls[0]!.proposal.proposalId } }] });
    expect(reconciled.receiptLinks.map((link) => link.commandId)).toEqual(["crash-command"]);
    repo.close();
  });

  it("rejects unrelated command receipts and exact-key changed provider or narration values", () => {
    const identity = seed(); const repo = factory();
    const turn = repo.createAdventureTurn("player", createInput(identity, "strict-turn"));
    const proposed = repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "strict-proposal", toolName: "roll", arguments: {}, requiresConfirmation: false });
    repo.executeRollActorDice("local-owner", { commandId: "unrelated-command", idempotencyKey: "unrelated-command", campaignId: identity.campaignId,
      timelineId: identity.timelineId, actorId: "actor", expectedRevision: 0, sourceTurnId: null,
      command: { type: "roll_actor_dice", payload: { expression: "1d6" } } });
    const direct = new DatabaseDriver(dbPath());
    expect(() => direct.prepare(`INSERT INTO turn_mechanics_links_v36
      (link_id,campaign_id,turn_id,root_turn_id,proposal_id,command_id,source_turn_id,linked_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run("direct-unrelated", identity.campaignId, turn.turnId, turn.turnId, proposed.toolCalls[0]!.proposal.proposalId,
        "unrelated-command", turn.turnId, AT)).toThrow("invalid mechanics receipt provenance");
    expect(() => direct.prepare(`INSERT INTO turn_mechanics_links_v36
      (link_id,campaign_id,turn_id,root_turn_id,proposal_id,command_id,source_turn_id,linked_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run("direct-wrong-source", identity.campaignId, turn.turnId, turn.turnId, proposed.toolCalls[0]!.proposal.proposalId,
        "unrelated-command", "other-turn", AT)).toThrow("invalid mechanics receipt provenance");
    expect(direct.prepare("SELECT count(*) count FROM turn_mechanics_links_v36 WHERE turn_id=?").get(turn.turnId)).toEqual({ count: 0 });
    direct.close();
    expect(() => repo.linkFinalMechanicsReceipt("player", { turnId: turn.turnId, proposalId: proposed.toolCalls[0]!.proposal.proposalId,
      commandId: "unrelated-command", expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "unrelated-link" })).toThrow();

    const providerTurn = repo.createAdventureTurn("player", createInput(identity, "provider-turn"));
    const started = repo.recordProviderCallStart("player", { turnId: providerTurn.turnId, callId: "planning", provider: "test", model: "m1", attempt: 1,
      expectedTurnRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "provider-same" });
    expect(() => repo.recordProviderCallStart("player", { turnId: providerTurn.turnId, callId: "planning", provider: "test", model: "m2", attempt: 1,
      expectedTurnRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "provider-same" })).toThrow(AdventureTurnConflictError);
    const outcome = { turnId: providerTurn.turnId, callId: "planning", provider: "test", model: "m1", attempt: 1, outcome: "succeeded" as const,
      outcomeCode: "ok", promptTokens: 2, completionTokens: 3, expectedTurnRevision: started.revision, expectedCampaignRevision: 0, idempotencyKey: "outcome-same" };
    repo.recordProviderCallOutcome("player", outcome);
    expect(() => repo.recordProviderCallOutcome("player", { ...outcome, completionTokens: 4 })).toThrow(AdventureTurnConflictError);
    const cancelled = repo.updateAdventureTurnNarration("player", { turnId: turn.turnId, narrationStatus: "none", terminalState: "cancelled",
      expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "narration-same" });
    expect(repo.updateAdventureTurnNarration("player", { turnId: turn.turnId, narrationStatus: "none", terminalState: "cancelled",
      expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "narration-same" })).toEqual(cancelled);
    expect(() => repo.updateAdventureTurnNarration("player", { turnId: turn.turnId, narrationStatus: "failed", terminalState: "failed",
      expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "narration-same" })).toThrow(AdventureTurnConflictError);
    repo.close();
  });

  it("advances physical and coordination revisions once for each of multiple proposal decisions", () => {
    const identity = seed(); const repo = factory();
    const turn = repo.createAdventureTurn("player", createInput(identity, "multiple-decisions"));
    const first = repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "proposal-one", toolName: "roll", arguments: {}, requiresConfirmation: true, confirmationExpiresAt: EXPIRES });
    const second = repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 1, expectedCampaignRevision: 0,
      idempotencyKey: "proposal-two", toolName: "roll", arguments: {}, requiresConfirmation: true, confirmationExpiresAt: EXPIRES });
    repo.waitForToolConfirmation("player", { turnId: turn.turnId, expectedTurnRevision: 2, expectedCampaignRevision: 0, idempotencyKey: "wait-two" });
    const one = repo.decideToolProposal("player", { turnId: turn.turnId, proposalId: first.toolCalls[0]!.proposal.proposalId,
      decision: "approved", expiresAt: EXPIRES, expectedTurnRevision: 3, expectedCampaignRevision: 0, idempotencyKey: "decision-one" });
    expect(one).toMatchObject({ state: "awaiting-confirmation", revision: 4 });
    const two = repo.decideToolProposal("player", { turnId: turn.turnId, proposalId: second.toolCalls[1]!.proposal.proposalId,
      decision: "approved", expiresAt: EXPIRES, expectedTurnRevision: 4, expectedCampaignRevision: 0, idempotencyKey: "decision-two" });
    expect(two).toMatchObject({ state: "confirmed", revision: 5 });
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT state,revision FROM adventure_turns WHERE id=?").get(turn.turnId)).toEqual({ state: "mechanics-committed", revision: 5 });
    expect(db.prepare("SELECT expected_turn_revision FROM confirmation_decisions WHERE turn_id=? ORDER BY decided_at,decision_id").all(turn.turnId))
      .toEqual([{ expected_turn_revision: 3 }, { expected_turn_revision: 4 }]);
    expect(db.prepare(`SELECT command.expected_revision,command.resulting_revision,event.resulting_revision FROM adventure_coordination_commands_v36 command
      JOIN adventure_coordination_events_v36 event ON event.command_id=command.command_id WHERE command.aggregate_kind='turn' AND command.aggregate_id=?
        AND command.mutation_type='confirmation-decision' ORDER BY command.resulting_revision`).all(turn.turnId)).toEqual([
      { expected_revision: 3, resulting_revision: 4 }, { expected_revision: 4, resulting_revision: 5 },
    ]);
    db.close(); repo.close();
  });

  it("resets failed narration to in-progress on provider retry and keeps success in-progress", () => {
    const identity = seed(); const repo = factory();
    const turn = repo.createAdventureTurn("player", createInput(identity, "provider-retry"));
    const proposed = repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "retry-proposal", toolName: "roll", arguments: {}, requiresConfirmation: false });
    repo.executeRollActorDice("local-owner", { commandId: "retry-command", idempotencyKey: "retry-command", campaignId: identity.campaignId,
      timelineId: identity.timelineId, actorId: "actor", expectedRevision: 0, sourceTurnId: turn.turnId,
      command: { type: "roll_actor_dice", payload: { expression: "1d20" } } });
    const linked = repo.linkFinalMechanicsReceipt("player", { turnId: turn.turnId, proposalId: proposed.toolCalls[0]!.proposal.proposalId,
      commandId: "retry-command", expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "retry-link" });
    const start = repo.recordProviderCallStart("player", { turnId: turn.turnId, callId: "narration-one", provider: "test", model: "model",
      attempt: 1, expectedTurnRevision: linked.revision, expectedCampaignRevision: 0, idempotencyKey: "narration-one-start" });
    const failed = repo.recordProviderCallOutcome("player", { turnId: turn.turnId, callId: "narration-one", provider: "test", model: "model",
      attempt: 1, outcome: "failed", outcomeCode: "timeout", expectedTurnRevision: start.revision, expectedCampaignRevision: 0,
      idempotencyKey: "narration-one-failed" });
    expect(failed.narrationStatus).toBe("failed");
    const retry = repo.recordProviderCallStart("player", { turnId: turn.turnId, callId: "narration-two", provider: "test", model: "model",
      attempt: 2, expectedTurnRevision: failed.revision, expectedCampaignRevision: 0, idempotencyKey: "narration-two-start" });
    expect(retry.narrationStatus).toBe("in-progress");
    const succeeded = repo.recordProviderCallOutcome("player", { turnId: turn.turnId, callId: "narration-two", provider: "test", model: "model",
      attempt: 2, outcome: "succeeded", outcomeCode: "ok", expectedTurnRevision: retry.revision, expectedCampaignRevision: 0,
      idempotencyKey: "narration-two-success" });
    expect(succeeded).toMatchObject({ state: "narrating", narrationStatus: "in-progress" });
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT revision,narration_status FROM adventure_turns WHERE id=?").get(turn.turnId))
      .toEqual({ revision: succeeded.revision, narration_status: "in-progress" });
    db.close(); repo.close();
  });

  it("requires active lifecycle, attachment, active participating session, action role, and actor control", () => {
    const identity = seed(); const repo = factory();
    const turn = repo.createAdventureTurn("player", createInput(identity, "authority-turn"));
    const db = new DatabaseDriver(dbPath());
    for (const lifecycle of ["paused", "archived"]) {
      db.prepare("UPDATE campaigns SET lifecycle_status=? WHERE id=?").run(lifecycle, identity.campaignId);
      expect(() => repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
        idempotencyKey: `lifecycle-${lifecycle}`, toolName: "roll", arguments: {}, requiresConfirmation: false })).toThrow(AdventureTurnStaleError);
    }
    db.prepare("UPDATE campaigns SET lifecycle_status='draft' WHERE id=?").run(identity.campaignId);
    db.prepare("UPDATE sessions SET state='closed',stopped_at=? WHERE id='session'").run(AT);
    expect(() => repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "stopped", toolName: "roll", arguments: {}, requiresConfirmation: false })).toThrow(AdventureTurnStaleError);
    db.prepare("UPDATE sessions SET state='active',stopped_at=NULL WHERE id='session'").run();
    db.prepare("DELETE FROM session_characters WHERE session_id='session' AND character_id='persona'").run();
    expect(() => repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "nonparticipant", toolName: "roll", arguments: {}, requiresConfirmation: false })).toThrow(AdventureTurnAuthorizationError);
    db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='local-owner' WHERE campaign_id=? AND actor_id='actor'").run(identity.campaignId);
    expect(() => repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "control-change", toolName: "roll", arguments: {}, requiresConfirmation: false })).toThrow(AdventureTurnAuthorizationError);
    expect(() => repo.appendToolProposal("observer", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "observer", toolName: "roll", arguments: {}, requiresConfirmation: false })).toThrow(AdventureTurnAuthorizationError);
    db.prepare("DELETE FROM campaign_sessions WHERE campaign_id=? AND session_id='session'").run(identity.campaignId); db.close();
    expect(() => repo.appendToolProposal("local-owner", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "unattached", toolName: "roll", arguments: {}, requiresConfirmation: false })).toThrow(AdventureTurnStaleError);
    repo.close();
  });

  it("bounds provider metadata at sixty-four exact records", () => {
    const identity = seed(); const repo = factory();
    const turn = repo.createAdventureTurn("player", createInput(identity, "provider-bound")); let revision = turn.revision;
    for (let index = 0; index < 32; index += 1) {
      const started = repo.recordProviderCallStart("player", { turnId: turn.turnId, callId: `call-${index}`,
        provider: "test", model: "model", attempt: 1, expectedTurnRevision: revision, expectedCampaignRevision: 0, idempotencyKey: `start-${index}` });
      revision = started.revision;
      revision = repo.recordProviderCallOutcome("player", { turnId: started.turnId, callId: `call-${index}`, provider: "test", model: "model", attempt: 1,
        outcome: "succeeded", outcomeCode: "ok", expectedTurnRevision: revision, expectedCampaignRevision: 0, idempotencyKey: `outcome-${index}` }).revision;
    }
    const current = repo.getAdventureTurn("player", turn.turnId)!;
    expect("providerCalls" in current && current.providerCalls).toHaveLength(64);
    expect(() => repo.recordProviderCallStart("player", { turnId: current.turnId, callId: "call-33", provider: "test", model: "model", attempt: 1,
      expectedTurnRevision: revision, expectedCampaignRevision: 0, idempotencyKey: "start-33" })).toThrow(AdventureTurnConflictError);
    repo.close();
  });
});
