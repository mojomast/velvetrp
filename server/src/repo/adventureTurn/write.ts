import type DatabaseDriver from "better-sqlite3";
import {
  generationDraftValidationSchema, resourceIdSchema, stagedGenerationContentSchema, utcIsoTimestampSchema,
  type AdventureTurnMode, type GenerationDraftKind, type NarrationStatus, type PrivateAdventureTurn,
  type PrivateGenerationDraft,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../../runtime.js";
import { AdventureTurnAuthorizationError, AdventureTurnConflictError, AdventureTurnExpiredError, AdventureTurnStaleError, AdventureTurnUnavailableError } from "./errors.js";
import { createAdventureTurnReadRepository, type AdventureTurnReadRepository } from "./read.js";

type Database = DatabaseDriver.Database;
/** Runtime and transaction guard dependencies for M1.10 writes. */
export interface AdventureTurnWriteContext { clock: Clock; ids: IdGenerator; guard(): void }
/** Shared optimistic envelope for durable turn mutations. */
export interface TurnMutationInput { turnId: string; expectedTurnRevision: number; expectedCampaignRevision: number; idempotencyKey: string }
/** Input for creating an original or narration-only adventure turn. */
export interface CreateAdventureTurnInput { campaignId: string; timelineId: string; sessionId: string; actorId: string; declaration: string;
  mode?: AdventureTurnMode; priorTurnId?: string | null; expectedCampaignRevision: number; idempotencyKey: string }
/** Input for appending one bounded tool proposal. */
export interface AppendToolProposalInput extends TurnMutationInput { toolName: string; arguments: Record<string, unknown>;
  requiresConfirmation: boolean; confirmationExpiresAt?: string | null }
/** Input for one exact human confirmation decision. */
export interface DecideToolProposalInput extends TurnMutationInput { proposalId: string; decision: "approved" | "rejected"; expiresAt: string }
/** Input for provider call start metadata recorded before external work. */
export interface ProviderCallStartInput extends TurnMutationInput { callId: string; provider: string; model: string; attempt: number }
/** Input for provider call outcome metadata recorded after external work. */
export interface ProviderCallOutcomeInput extends TurnMutationInput { callId: string; provider: string; model: string; attempt: number;
  outcome: "succeeded" | "failed" | "cancelled"; outcomeCode: string; promptTokens?: number | null; completionTokens?: number | null }
/** Input for linking one already-committed campaign command receipt. */
export interface LinkTurnReceiptInput extends TurnMutationInput { commandId: string }
/** Input for narration progress or terminal turn state. */
export interface UpdateTurnNarrationInput extends TurnMutationInput { narrationStatus: NarrationStatus; terminalState?: "completed" | "cancelled" | "failed" }
/** Input for creating staged generated campaign content. */
export interface CreateGenerationDraftInput { campaignId: string; timelineId: string; sessionId?: string | null; kind: GenerationDraftKind;
  stagedContent: Record<string, unknown>; validation: unknown; expectedCampaignRevision: number; idempotencyKey: string }
/** Shared optimistic envelope for generated-draft mutations. */
export interface DraftMutationInput { draftId: string; expectedDraftRevision: number; expectedCampaignRevision: number; idempotencyKey: string }
/** Input for owner/GM review of one exact generated draft. */
export interface ReviewGenerationDraftInput extends DraftMutationInput { decision: "approved" | "rejected"; notes?: string | null }
/** Input for linking the deterministic command that applied an approved draft. */
export interface ApplyGenerationDraftInput extends DraftMutationInput { commandId: string }

/** Authoritative M1.10 mutation surface. */
export interface AdventureTurnWriteRepository {
  /** Creates a durable declaration after rechecking role, control, room, campaign, and active timeline. */
  createAdventureTurn(principalId: string, input: CreateAdventureTurnInput): PrivateAdventureTurn;
  /** Appends a bounded proposal and advances the turn exactly once. */
  appendToolProposal(principalId: string, input: AppendToolProposalInput): PrivateAdventureTurn;
  /** Pauses at a durable confirmation boundary without retaining a transaction. */
  waitForToolConfirmation(principalId: string, input: TurnMutationInput): PrivateAdventureTurn;
  /** Approves or rejects one exact non-expired proposal. */
  decideToolProposal(principalId: string, input: DecideToolProposalInput): PrivateAdventureTurn;
  /** Records provider-call start metadata; external work must happen after this method returns. */
  recordProviderCallStart(principalId: string, input: ProviderCallStartInput): PrivateAdventureTurn;
  /** Records a provider outcome after external work and advances narration status when applicable. */
  recordProviderCallOutcome(principalId: string, input: ProviderCallOutcomeInput): PrivateAdventureTurn;
  /** Links one immutable mechanics receipt; narration-only descendants cannot call this method. */
  linkFinalMechanicsReceipt(principalId: string, input: LinkTurnReceiptInput): PrivateAdventureTurn;
  /** Advances narration or a terminal turn state without invoking a provider in-transaction. */
  updateAdventureTurnNarration(principalId: string, input: UpdateTurnNarrationInput): PrivateAdventureTurn;
  /** Creates a durable generated-content draft for owner/GM review. */
  createGenerationDraft(principalId: string, input: CreateGenerationDraftInput): PrivateGenerationDraft;
  /** Records one immutable owner/GM review decision. */
  reviewGenerationDraft(principalId: string, input: ReviewGenerationDraftInput): PrivateGenerationDraft;
  /** Links one deterministic apply receipt and seals the draft as applied. */
  applyGenerationDraft(principalId: string, input: ApplyGenerationDraftInput): PrivateGenerationDraft;
}

/** Creates revision-checked M1.10 writes with no asynchronous work inside SQLite transactions. */
export function createAdventureTurnWriteRepository(db: Database, context: AdventureTurnWriteContext,
  reads: AdventureTurnReadRepository = createAdventureTurnReadRepository(db)): AdventureTurnWriteRepository {
  const now = () => utcIsoTimestampSchema.parse(context.clock.now().toISOString());
  const id = () => resourceIdSchema.parse(context.ids.nextId());
  const privateTurn = (principalId: string, turnId: string) => {
    const value = reads.getAdventureTurn(principalId, turnId); if (!value || !("declaration" in value)) throw new AdventureTurnUnavailableError("private turn is unavailable"); return value;
  };
  const privateDraft = (principalId: string, draftId: string) => {
    const value = reads.getGenerationDraft(principalId, draftId); if (!value || !("stagedContent" in value)) throw new AdventureTurnUnavailableError("private draft is unavailable"); return value;
  };
  const campaign = (campaignId: string) => db.prepare("SELECT active_timeline_id,administration_revision FROM campaigns WHERE id=?").get(campaignId) as { active_timeline_id: string; administration_revision: number } | undefined;
  function authority(principalId: string, row: any, expectedCampaignRevision: number, gmOnly = false): void {
    const current = campaign(row.campaign_id); if (!current) throw new AdventureTurnUnavailableError("campaign is unavailable");
    const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(row.campaign_id, principalId) as { role: string } | undefined;
    if (!member || (gmOnly && member.role !== "owner" && member.role !== "gm")) throw new AdventureTurnAuthorizationError("current campaign authority is required");
    if (!gmOnly && member.role !== "owner" && member.role !== "gm" && (member.role !== "player" || !db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?")
      .get(row.campaign_id, row.actor_id, principalId))) throw new AdventureTurnAuthorizationError("current actor control is required");
    if (current.active_timeline_id !== row.timeline_id) throw new AdventureTurnStaleError("active timeline changed");
    if (current.administration_revision !== expectedCampaignRevision) throw new AdventureTurnStaleError("campaign revision is stale");
    if (row.session_id && !db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(row.campaign_id, row.session_id))
      throw new AdventureTurnStaleError("campaign session is no longer attached");
  }
  const turn = (turnId: string) => { const row = db.prepare("SELECT * FROM adventure_turns WHERE id=?").get(turnId) as any;
    if (!row) throw new AdventureTurnUnavailableError("turn is unavailable"); return row; };
  const draft = (draftId: string) => { const row = db.prepare("SELECT * FROM generation_drafts WHERE id=?").get(draftId) as any;
    if (!row) throw new AdventureTurnUnavailableError("draft is unavailable"); return row; };
  const staleTurn = (row: any, expected: number) => { if (row.revision !== expected) throw new AdventureTurnStaleError("turn revision is stale"); };
  const staleDraft = (row: any, expected: number) => { if (row.revision !== expected) throw new AdventureTurnStaleError("draft revision is stale"); };
  const immediate = <T>(work: () => T): T => { context.guard(); return db.transaction(work).immediate(); };
  const advance = (row: any, state: string, narration: string, at: string) => db.prepare(
    "UPDATE adventure_turns SET state=?,narration_status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
  ).run(state, narration, at, row.id, row.revision);

  return {
    createAdventureTurn(principalId, input) { return immediate(() => {
      const current = campaign(input.campaignId); if (!current) throw new AdventureTurnUnavailableError("campaign is unavailable");
      const synthetic = { campaign_id: input.campaignId, timeline_id: input.timelineId, session_id: input.sessionId, actor_id: input.actorId };
      authority(principalId, synthetic, input.expectedCampaignRevision);
      const replay = db.prepare("SELECT * FROM adventure_turns WHERE campaign_id=? AND idempotency_key=?").get(input.campaignId, input.idempotencyKey) as any;
      const mode = input.mode ?? "original", priorTurnId = input.priorTurnId ?? null;
      if (replay) { if (replay.principal_id !== principalId || replay.timeline_id !== input.timelineId || replay.session_id !== input.sessionId || replay.actor_id !== input.actorId || replay.declaration !== input.declaration || replay.mode !== mode || replay.prior_turn_id !== priorTurnId)
        throw new AdventureTurnConflictError("idempotency key was reused"); return privateTurn(principalId, replay.id); }
      if (mode !== "original") { const prior = turn(priorTurnId ?? ""); authority(principalId, prior, input.expectedCampaignRevision);
        if (prior.campaign_id !== input.campaignId || prior.timeline_id !== input.timelineId || prior.session_id !== input.sessionId || prior.actor_id !== input.actorId || prior.state !== "completed")
          throw new AdventureTurnConflictError("narration ancestry is invalid"); }
      const turnId = id(), at = now();
      db.prepare(`INSERT INTO adventure_turns(id,campaign_id,timeline_id,session_id,actor_id,principal_id,declaration,mode,prior_turn_id,state,narration_status,
        revision,campaign_revision,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'declared','none',0,?,?,?,?)`)
        .run(turnId, input.campaignId, input.timelineId, input.sessionId, input.actorId, principalId, input.declaration, mode, priorTurnId,
          input.expectedCampaignRevision, input.idempotencyKey, at, at);
      return privateTurn(principalId, turnId);
    }); },
    appendToolProposal(principalId, input) { return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision);
      const argumentsJson = JSON.stringify(input.arguments);
      const replay = db.prepare("SELECT * FROM tool_proposals WHERE campaign_id=? AND turn_id=? AND idempotency_key=?").get(row.campaign_id, row.id, input.idempotencyKey) as any;
      if (replay) { if (replay.tool_name !== input.toolName || replay.arguments_json !== argumentsJson || Boolean(replay.requires_confirmation) !== input.requiresConfirmation)
        throw new AdventureTurnConflictError("idempotency key was reused"); return privateTurn(principalId, row.id); }
      staleTurn(row, input.expectedTurnRevision); if (row.mode !== "original") throw new AdventureTurnConflictError("narration-only turns cannot propose mechanics");
      const position = (db.prepare("SELECT count(*) count FROM tool_proposals WHERE campaign_id=? AND turn_id=?").get(row.campaign_id, row.id) as { count: number }).count;
      const at = now(), expiresAt = input.requiresConfirmation ? utcIsoTimestampSchema.parse(input.confirmationExpiresAt) : null;
      db.prepare(`INSERT INTO tool_proposals(proposal_id,campaign_id,turn_id,position,tool_name,arguments_json,requires_confirmation,confirmation_expires_at,idempotency_key,proposed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id(), row.campaign_id, row.id, position, input.toolName, argumentsJson, input.requiresConfirmation ? 1 : 0, expiresAt, input.idempotencyKey, at);
      advance(row, "proposed", "none", at); return privateTurn(principalId, row.id);
    }); },
    waitForToolConfirmation(principalId, input) { return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision);
      if (row.state === "awaiting-confirmation" && row.revision === input.expectedTurnRevision + 1) return privateTurn(principalId, row.id);
      staleTurn(row, input.expectedTurnRevision);
      if (!db.prepare(`SELECT 1 FROM tool_proposals proposal WHERE proposal.campaign_id=? AND proposal.turn_id=? AND proposal.requires_confirmation=1
        AND NOT EXISTS(SELECT 1 FROM confirmation_decisions decision WHERE decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id) LIMIT 1`).get(row.campaign_id, row.id))
        throw new AdventureTurnConflictError("no proposal requires confirmation");
      advance(row, "awaiting-confirmation", "none", now()); return privateTurn(principalId, row.id);
    }); },
    decideToolProposal(principalId, input) { return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision);
      const replay = db.prepare("SELECT * FROM confirmation_decisions WHERE campaign_id=? AND turn_id=? AND idempotency_key=?").get(row.campaign_id, row.id, input.idempotencyKey) as any;
      if (replay) { if (replay.proposal_id !== input.proposalId || replay.decision !== input.decision || replay.expires_at !== input.expiresAt)
        throw new AdventureTurnConflictError("idempotency key was reused"); return privateTurn(principalId, row.id); }
      if (db.prepare("SELECT 1 FROM confirmation_decisions WHERE campaign_id=? AND turn_id=? AND proposal_id=?").get(row.campaign_id, row.id, input.proposalId))
        throw new AdventureTurnConflictError("proposal already has a decision");
      staleTurn(row, input.expectedTurnRevision); const at = now(); if (at >= input.expiresAt) throw new AdventureTurnExpiredError("confirmation expired");
      db.prepare(`INSERT INTO confirmation_decisions(decision_id,campaign_id,turn_id,proposal_id,principal_id,decision,expected_turn_revision,idempotency_key,expires_at,decided_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id(), row.campaign_id, row.id, input.proposalId, principalId, input.decision, row.revision, input.idempotencyKey, input.expiresAt, at);
      advance(row, input.decision === "approved" ? "mechanics-committed" : "cancelled", input.decision === "approved" ? "pending" : "none", at);
      return privateTurn(principalId, row.id);
    }); },
    recordProviderCallStart(principalId, input) { return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision);
      const replay = db.prepare("SELECT * FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? AND idempotency_key=?").get(row.campaign_id, row.id, input.idempotencyKey) as any;
      if (replay) { if (replay.call_id !== input.callId || replay.phase !== "started" || replay.provider !== input.provider || replay.model !== input.model || replay.attempt !== input.attempt)
        throw new AdventureTurnConflictError("idempotency key was reused"); return privateTurn(principalId, row.id); }
      staleTurn(row, input.expectedTurnRevision); const at = now();
      db.prepare(`INSERT INTO provider_call_metadata(record_id,campaign_id,turn_id,call_id,phase,provider,model,attempt,prompt_tokens,completion_tokens,outcome_code,idempotency_key,recorded_at)
        VALUES(?,?,?,?,'started',?,?,?,NULL,NULL,NULL,?,?)`).run(id(), row.campaign_id, row.id, input.callId, input.provider, input.model, input.attempt, input.idempotencyKey, at);
      const state = row.state === "mechanics-committed" || row.mode !== "original" ? "narrating" : row.state;
      advance(row, state, state === "narrating" ? "in-progress" : row.narration_status, at); return privateTurn(principalId, row.id);
    }); },
    recordProviderCallOutcome(principalId, input) { return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision);
      const replay = db.prepare("SELECT * FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? AND idempotency_key=?").get(row.campaign_id, row.id, input.idempotencyKey) as any;
      if (replay) { if (replay.call_id !== input.callId || replay.phase !== input.outcome || replay.outcome_code !== input.outcomeCode)
        throw new AdventureTurnConflictError("idempotency key was reused"); return privateTurn(principalId, row.id); }
      staleTurn(row, input.expectedTurnRevision); const at = now();
      db.prepare(`INSERT INTO provider_call_metadata(record_id,campaign_id,turn_id,call_id,phase,provider,model,attempt,prompt_tokens,completion_tokens,outcome_code,idempotency_key,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id(), row.campaign_id, row.id, input.callId, input.outcome, input.provider, input.model, input.attempt,
          input.promptTokens ?? null, input.completionTokens ?? null, input.outcomeCode, input.idempotencyKey, at);
      advance(row, input.outcome === "succeeded" ? "completed" : "failed", input.outcome === "succeeded" ? "completed" : "failed", at);
      return privateTurn(principalId, row.id);
    }); },
    linkFinalMechanicsReceipt(principalId, input) { return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision);
      const replay = db.prepare("SELECT * FROM final_receipt_links WHERE campaign_id=? AND turn_id=? AND idempotency_key=?").get(row.campaign_id, row.id, input.idempotencyKey) as any;
      if (replay) { if (replay.command_id !== input.commandId) throw new AdventureTurnConflictError("idempotency key was reused"); return privateTurn(principalId, row.id); }
      staleTurn(row, input.expectedTurnRevision); if (row.mode !== "original") throw new AdventureTurnConflictError("narration-only turns cannot commit mechanics");
      if (!db.prepare("SELECT 1 FROM command_receipts WHERE campaign_id=? AND command_id=?").get(row.campaign_id, input.commandId)) throw new AdventureTurnUnavailableError("receipt is unavailable");
      const at = now(); db.prepare("INSERT INTO final_receipt_links(link_id,campaign_id,turn_id,draft_id,command_id,idempotency_key,linked_at) VALUES(?,?,?,NULL,?,?,?)")
        .run(id(), row.campaign_id, row.id, input.commandId, input.idempotencyKey, at);
      advance(row, "mechanics-committed", "pending", at); return privateTurn(principalId, row.id);
    }); },
    updateAdventureTurnNarration(principalId, input) { return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision);
      if (input.terminalState && row.state === input.terminalState && row.revision === input.expectedTurnRevision + 1) return privateTurn(principalId, row.id);
      staleTurn(row, input.expectedTurnRevision);
      if (input.terminalState === "cancelled" && row.state !== "mechanics-committed" && db.prepare("SELECT 1 FROM final_receipt_links WHERE campaign_id=? AND turn_id=?").get(row.campaign_id, row.id))
        throw new AdventureTurnConflictError("pre-mechanics cancellation cannot have receipts");
      const state = input.terminalState ?? (input.narrationStatus === "none" ? row.state : "narrating");
      advance(row, state, input.narrationStatus, now()); return privateTurn(principalId, row.id);
    }); },
    createGenerationDraft(principalId, input) { return immediate(() => {
      const current = campaign(input.campaignId); if (!current) throw new AdventureTurnUnavailableError("campaign is unavailable");
      const synthetic = { campaign_id: input.campaignId, timeline_id: input.timelineId, session_id: input.sessionId ?? null };
      authority(principalId, synthetic, input.expectedCampaignRevision, true);
      const content = stagedGenerationContentSchema.parse(input.stagedContent), validation = generationDraftValidationSchema.parse(input.validation);
      const replay = db.prepare("SELECT * FROM generation_drafts WHERE campaign_id=? AND idempotency_key=?").get(input.campaignId, input.idempotencyKey) as any;
      if (replay) { if (replay.principal_id !== principalId || replay.kind !== input.kind || replay.staged_content_json !== JSON.stringify(content) || replay.validation_json !== JSON.stringify(validation))
        throw new AdventureTurnConflictError("idempotency key was reused"); return privateDraft(principalId, replay.id); }
      const draftId = id(), at = now(); db.prepare(`INSERT INTO generation_drafts(id,campaign_id,timeline_id,session_id,principal_id,kind,staged_content_json,
        validation_json,state,revision,campaign_revision,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'staged',0,?,?,?,?)`)
        .run(draftId, input.campaignId, input.timelineId, input.sessionId ?? null, principalId, input.kind, JSON.stringify(content), JSON.stringify(validation),
          input.expectedCampaignRevision, input.idempotencyKey, at, at); return privateDraft(principalId, draftId);
    }); },
    reviewGenerationDraft(principalId, input) { return immediate(() => {
      const row = draft(input.draftId); authority(principalId, row, input.expectedCampaignRevision, true);
      const replay = db.prepare("SELECT * FROM review_decisions WHERE campaign_id=? AND draft_id=?").get(row.campaign_id, row.id) as any;
      if (replay) { if (replay.idempotency_key !== input.idempotencyKey || replay.decision !== input.decision || replay.notes !== (input.notes ?? null))
        throw new AdventureTurnConflictError("draft already has a different review"); return privateDraft(principalId, row.id); }
      staleDraft(row, input.expectedDraftRevision); const at = now();
      if (row.state === "staged") db.prepare("UPDATE generation_drafts SET state='in-review',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(at, row.id, row.revision);
      const reviewRevision = row.state === "staged" ? row.revision + 1 : row.revision;
      db.prepare("INSERT INTO review_decisions VALUES(?,?,?,?,?,?,?,?,?)").run(id(), row.campaign_id, row.id, principalId, input.decision, input.notes ?? null,
        reviewRevision, input.idempotencyKey, at);
      db.prepare("UPDATE generation_drafts SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
        .run(input.decision, at, row.id, reviewRevision); return privateDraft(principalId, row.id);
    }); },
    applyGenerationDraft(principalId, input) { return immediate(() => {
      const row = draft(input.draftId); authority(principalId, row, input.expectedCampaignRevision, true);
      const replay = db.prepare("SELECT * FROM final_receipt_links WHERE campaign_id=? AND draft_id=? AND idempotency_key=?").get(row.campaign_id, row.id, input.idempotencyKey) as any;
      if (replay) { if (replay.command_id !== input.commandId) throw new AdventureTurnConflictError("idempotency key was reused"); return privateDraft(principalId, row.id); }
      staleDraft(row, input.expectedDraftRevision); if (row.state !== "approved") throw new AdventureTurnConflictError("only approved drafts can be applied");
      if (!db.prepare("SELECT 1 FROM command_receipts WHERE campaign_id=? AND command_id=?").get(row.campaign_id, input.commandId)) throw new AdventureTurnUnavailableError("receipt is unavailable");
      const at = now(); db.prepare("INSERT INTO final_receipt_links(link_id,campaign_id,turn_id,draft_id,command_id,idempotency_key,linked_at) VALUES(?,?,NULL,?,?,?,?)")
        .run(id(), row.campaign_id, row.id, input.commandId, input.idempotencyKey, at);
      db.prepare("UPDATE generation_drafts SET state='applied',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(at, row.id, row.revision);
      return privateDraft(principalId, row.id);
    }); },
  };
}
