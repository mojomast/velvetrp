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
    const approved = repo.decideToolProposal("player", { turnId: created.turnId, proposalId, decision: "approved", expiresAt: EXPIRES,
      expectedTurnRevision: 2, expectedCampaignRevision: 0, idempotencyKey: "approve" });
    expect(repo.decideToolProposal("player", { turnId: created.turnId, proposalId, decision: "approved", expiresAt: EXPIRES,
      expectedTurnRevision: 2, expectedCampaignRevision: 0, idempotencyKey: "approve" })).toEqual(approved);
    expect(() => repo.decideToolProposal("player", { turnId: created.turnId, proposalId, decision: "rejected", expiresAt: EXPIRES,
      expectedTurnRevision: 3, expectedCampaignRevision: 0, idempotencyKey: "different-decision" })).toThrow(AdventureTurnConflictError);

    const receipt = repo.executeRollActorDice("local-owner", { commandId: "mechanics-command", idempotencyKey: "mechanics-command",
      campaignId: identity.campaignId, timelineId: identity.timelineId, actorId: "actor", expectedRevision: 0,
      sourceTurnId: created.turnId, command: { type: "roll_actor_dice", payload: { expression: "1d20" } } });
    const linked = repo.linkFinalMechanicsReceipt("player", { turnId: created.turnId, commandId: receipt.commandId,
      expectedTurnRevision: 3, expectedCampaignRevision: 0, idempotencyKey: "link" });
    expect(linked.receiptLinks.map((link) => link.commandId)).toEqual(["mechanics-command"]);
    const started = repo.recordProviderCallStart("player", { turnId: created.turnId, callId: "narration", provider: "test",
      model: "model", attempt: 1, expectedTurnRevision: 4, expectedCampaignRevision: 0, idempotencyKey: "provider-start" });
    const completed = repo.recordProviderCallOutcome("player", { turnId: created.turnId, callId: "narration", provider: "test",
      model: "model", attempt: 1, outcome: "succeeded", outcomeCode: "ok", promptTokens: 3, completionTokens: 5,
      expectedTurnRevision: started.revision, expectedCampaignRevision: 0, idempotencyKey: "provider-outcome" });
    expect(completed).toMatchObject({ state: "completed", narrationStatus: "completed" });
    const sealed = new DatabaseDriver(dbPath()); sealed.pragma("recursive_triggers=OFF");
    for (const table of ["adventure_turns", "tool_proposals", "confirmation_decisions", "provider_call_metadata", "final_receipt_links"]) {
      expect(() => sealed.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`), table).toThrow();
    }
    expect(() => sealed.prepare("UPDATE confirmation_decisions SET decision='rejected'").run()).toThrow("immutable");
    sealed.close();
    repo.close();

    repo = factory();
    expect(repo.getAdventureTurn("player", created.turnId)).toMatchObject({ revision: 6, receiptLinks: [{ commandId: "mechanics-command" }] });
    const retry = repo.createAdventureTurn("player", { ...createInput(identity, "retry"), declaration: "Narrate the same result again",
      mode: "narration-retry", priorTurnId: created.turnId });
    expect(retry.receiptLinks.map((link) => link.commandId)).toEqual(["mechanics-command"]);
    expect(() => repo.linkFinalMechanicsReceipt("player", { turnId: retry.turnId, commandId: receipt.commandId,
      expectedTurnRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "retry-link" })).toThrow(AdventureTurnConflictError);
    repo.close();
  });

  it("enforces expiry and cancellation boundaries", () => {
    const identity = seed(); const repo = factory();
    const before = repo.createAdventureTurn("player", createInput(identity));
    const cancelled = repo.updateAdventureTurnNarration("player", { turnId: before.turnId, expectedTurnRevision: 0,
      expectedCampaignRevision: 0, idempotencyKey: "cancel-before", narrationStatus: "none", terminalState: "cancelled" });
    expect(cancelled.receiptLinks).toEqual([]);
    const after = repo.createAdventureTurn("player", createInput(identity, "cancel-after"));
    repo.appendToolProposal("player", { turnId: after.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
      idempotencyKey: "no-confirm", toolName: "roll", arguments: {}, requiresConfirmation: false });
    const committed = repo.executeRollActorDice("local-owner", { commandId: "cancel-command", idempotencyKey: "cancel-command",
      campaignId: identity.campaignId, timelineId: identity.timelineId, actorId: "actor", expectedRevision: 0, sourceTurnId: after.turnId,
      command: { type: "roll_actor_dice", payload: { expression: "1d6" } } });
    repo.linkFinalMechanicsReceipt("player", { turnId: after.turnId, commandId: committed.commandId, expectedTurnRevision: 1,
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
    const reviewed = repo.reviewGenerationDraft("local-owner", { draftId: draft.draftId, decision: "approved", notes: "Apply it",
      expectedDraftRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "review" });
    expect(reviewed).toMatchObject({ state: "approved", revision: 2 });
    const receipt = repo.executeRollActorDice("local-owner", { commandId: "draft-command", idempotencyKey: "draft-command",
      campaignId: identity.campaignId, timelineId: identity.timelineId, actorId: "actor", expectedRevision: 0, sourceTurnId: null,
      command: { type: "roll_actor_dice", payload: { expression: "1d6" } } });
    const applied = repo.applyGenerationDraft("local-owner", { draftId: draft.draftId, commandId: receipt.commandId,
      expectedDraftRevision: 2, expectedCampaignRevision: 0, idempotencyKey: "apply" });
    expect(applied).toMatchObject({ state: "applied", applyState: "applied", receiptLinks: [{ commandId: "draft-command" }] });
    const sealed = new DatabaseDriver(dbPath()); sealed.pragma("recursive_triggers=OFF");
    for (const table of ["generation_drafts", "review_decisions", "final_receipt_links"]) {
      expect(() => sealed.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`), table).toThrow();
    }
    expect(() => sealed.prepare("DELETE FROM review_decisions").run()).toThrow("immutable"); sealed.close();
    repo.close(); repo = factory();
    expect(repo.getGenerationDraft("local-owner", draft.draftId)).toMatchObject({ state: "applied", revision: 3 });
    repo.close();
  });

  it("forbids nested unit-of-work mutations and calls no asynchronous provider inside a transaction", () => {
    const identity = seed(); const repo = factory();
    expect(() => repo.transaction(() => repo.createAdventureTurn("player", createInput(identity))))
      .toThrow("M1.10 operation cannot run inside a repository transaction");
    expect(repo.getAdventureTurn("player", "missing")).toBeNull();
    repo.close();
  });
});
