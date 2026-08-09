import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  privateAdventureTurnSchema, privateGenerationDraftSchema, roleSafeAdventureTurnSchema, roleSafeGenerationDraftSchema,
  type PrivateAdventureTurn, type PrivateGenerationDraft, type RoleSafeAdventureTurn, type RoleSafeGenerationDraft,
} from "@velvet/contracts";
import { AdventureTurnUnavailableError } from "./errors.js";

type Database = DatabaseDriver.Database;
/** Principal-sensitive adventure-turn projection. */
export type AdventureTurnProjection = PrivateAdventureTurn | RoleSafeAdventureTurn;
/** Principal-sensitive generated-draft projection. */
export type GenerationDraftProjection = PrivateGenerationDraft | RoleSafeGenerationDraft;

/** Read-only M1.10 repository surface. */
export interface AdventureTurnReadRepository {
  /** Reads one turn, structurally redacting private coordination metadata when necessary. */
  getAdventureTurn(principalId: string, turnId: string): AdventureTurnProjection | null;
  /** Finds one committed original turn by its exact safe submission locator and current action authority. */
  getAdventureTurnByInitialIdempotencyKey(principalId: string, campaignId: string, sessionId: string, actorId: string,
    idempotencyKey: string): AdventureTurnProjection | null;
  /** Reads one generation draft, exposing staged content only to current owner/GM principals. */
  getGenerationDraft(principalId: string, draftId: string): GenerationDraftProjection | null;
  /** Reads persisted fallback narration from the exact terminal coordination command. */
  getAdventureTurnNarration(principalId: string, turnId: string): string | null;
  /** Finds an idempotent draft create without exposing cross-campaign data. */
  getGenerationDraftByIdempotencyKey(principalId: string, campaignId: string, idempotencyKey: string): GenerationDraftProjection | null;
}

const rootTurnId = (db: Database, campaignId: string, turnId: string): string => {
  let current = turnId; const visited = new Set<string>();
  while (true) {
    if (visited.has(current)) throw new Error("adventure turn ancestry contains a cycle");
    visited.add(current);
    const row = db.prepare("SELECT mode,prior_turn_id FROM adventure_turns WHERE campaign_id=? AND id=?").get(campaignId, current) as { mode: string; prior_turn_id: string | null } | undefined;
    if (!row) throw new Error("adventure turn ancestry is incomplete");
    if (row.mode === "original") return current;
    if (!row.prior_turn_id) throw new Error("adventure turn ancestry is incomplete");
    current = row.prior_turn_id;
  }
};

const receipts = (db: Database, campaignId: string, turnId: string) => {
  const root = rootTurnId(db, campaignId, turnId);
  const linked = (db.prepare(`SELECT link_id,command_id,proposal_id,source_turn_id,linked_at FROM turn_mechanics_links_v36
    WHERE campaign_id=? AND root_turn_id=? ORDER BY linked_at,link_id`).all(campaignId, root) as any[]).map((row) => ({
      linkId: row.link_id, campaignId, commandId: row.command_id, proposalId: row.proposal_id,
      sourceTurnId: row.source_turn_id, linkedAt: row.linked_at,
    }));
  const rootRow = db.prepare("SELECT timeline_id,actor_id FROM adventure_turns WHERE campaign_id=? AND id=?")
    .get(campaignId, root) as { timeline_id: string; actor_id: string } | undefined;
  if (!rootRow) throw new Error("adventure turn receipt root is unavailable");
  const proposals = db.prepare(`SELECT proposal.proposal_id,proposal.position,binding.execution_idempotency_key FROM tool_proposals proposal
    JOIN tool_proposal_execution_bindings_v37 binding ON binding.campaign_id=proposal.campaign_id AND binding.turn_id=proposal.turn_id
      AND binding.proposal_id=proposal.proposal_id
    LEFT JOIN confirmation_decisions decision ON decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id
      AND decision.proposal_id=proposal.proposal_id WHERE proposal.campaign_id=? AND proposal.turn_id=?
      AND (proposal.requires_confirmation=0 OR decision.decision='approved') ORDER BY proposal.position`)
    .all(campaignId, root) as Array<{ proposal_id: string; position: number; execution_idempotency_key: string }>;
  const unbound = proposals.filter((proposal) => !linked.some((link) => link.proposalId === proposal.proposal_id));
  const invalidCommand = db.prepare(`SELECT command.command_id FROM campaign_commands command LEFT JOIN tool_proposal_execution_bindings_v37 binding
      ON binding.campaign_id=command.campaign_id AND binding.execution_idempotency_key=command.idempotency_key
      AND binding.source_turn_id=command.source_turn_id AND binding.timeline_id=command.timeline_id
      AND binding.actor_id=command.actor_id AND binding.command_type=command.type
    WHERE command.campaign_id=? AND command.timeline_id=? AND command.actor_id=? AND command.source_turn_id=? AND binding.proposal_id IS NULL LIMIT 1`)
    .get(campaignId, rootRow.timeline_id, rootRow.actor_id, root) as { command_id: string } | undefined;
  if (invalidCommand) throw new Error("source-turn command receipt has no exact proposal execution binding");
  const commands = db.prepare(`SELECT command.command_id,event.occurred_at,binding.proposal_id FROM campaign_commands command
    JOIN command_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
    JOIN campaign_events event ON event.campaign_id=receipt.campaign_id AND event.event_id=receipt.event_id
      AND event.command_id=receipt.command_id
    JOIN tool_proposal_execution_bindings_v37 binding ON binding.campaign_id=command.campaign_id
        AND binding.execution_idempotency_key=command.idempotency_key AND binding.source_turn_id=command.source_turn_id
        AND binding.timeline_id=command.timeline_id AND binding.actor_id=command.actor_id AND binding.command_type=command.type
      WHERE command.campaign_id=? AND command.timeline_id=? AND command.actor_id=?
      AND command.source_turn_id=? AND event.timeline_id=? AND event.actor_id=? AND event.source_turn_id=?
      AND NOT EXISTS(SELECT 1 FROM turn_mechanics_links_v36 link WHERE link.campaign_id=command.campaign_id AND link.command_id=command.command_id)
    ORDER BY receipt.revision_after,command.command_id`).all(campaignId, rootRow.timeline_id, rootRow.actor_id, root,
       rootRow.timeline_id, rootRow.actor_id, root) as Array<{ command_id: string; proposal_id: string; occurred_at: string }>;
  if (commands.length > unbound.length) throw new Error("source-turn command receipts exceed approved proposals");
  const recoverable = commands.map((entry) => {
    const proposal = unbound.find((candidate) => candidate.proposal_id === entry.proposal_id);
    if (!proposal) throw new Error("source-turn command receipt proposal execution binding is invalid");
    unbound.splice(unbound.indexOf(proposal), 1);
    return { linkId: `recoverable-${createHash("sha256").update(`${campaignId}\0${root}\0${proposal.proposal_id}\0${entry.command_id}`).digest("hex").slice(0, 40)}`,
      campaignId, commandId: entry.command_id, proposalId: proposal.proposal_id, sourceTurnId: root, linkedAt: entry.occurred_at };
  });
  return { links: [...linked, ...recoverable].sort((left, right) => left.linkedAt.localeCompare(right.linkedAt) || left.linkId.localeCompare(right.linkId)),
    recoverableCount: recoverable.length, approvedCount: proposals.length };
};

/** Creates principal-sensitive, non-mutating turn and draft projections. */
export function createAdventureTurnReadRepository(db: Database): AdventureTurnReadRepository {
  const membership = (principalId: string, campaignId: string) => db.prepare(
    "SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?",
  ).get(campaignId, principalId) as { role: string } | undefined;
  const canSeePrivateTurn = (principalId: string, row: any, role: string) => role === "owner" || role === "gm" || row.principal_id === principalId || Boolean(db.prepare(
    "SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?",
  ).get(row.campaign_id, row.actor_id, principalId));
  const proposalRows = (turnId: string) => db.prepare(`SELECT proposal.*,binding.execution_idempotency_key,binding.command_type,
    binding.source_turn_id binding_source_turn_id,binding.timeline_id binding_timeline_id,binding.actor_id binding_actor_id,
    decision.decision_id,decision.principal_id decision_principal_id,
    decision.decision,decision.expected_turn_revision,decision.idempotency_key decision_key,decision.expires_at,decision.decided_at
    FROM tool_proposals proposal JOIN tool_proposal_execution_bindings_v37 binding ON binding.campaign_id=proposal.campaign_id
      AND binding.turn_id=proposal.turn_id AND binding.proposal_id=proposal.proposal_id
      LEFT JOIN confirmation_decisions decision ON decision.campaign_id=proposal.campaign_id
      AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id WHERE proposal.turn_id=? ORDER BY proposal.position`).all(turnId) as any[];
  const confirmation = (row: any) => row.decision_id ? { state: "decided" as const, decision: { decisionId: row.decision_id,
    proposalId: row.proposal_id, principalId: row.decision_principal_id, decision: row.decision, expectedTurnRevision: row.expected_turn_revision,
    idempotencyKey: row.decision_key, expiresAt: row.expires_at, decidedAt: row.decided_at } }
    : row.requires_confirmation ? { state: "pending" as const, expiresAt: row.confirmation_expires_at ?? "9999-12-31T23:59:59.999Z" }
      : { state: "not-required" as const };
  const common = (row: any, effective?: { state: string; narrationStatus: string }) => ({ turnId: row.id, campaignId: row.campaign_id, timelineId: row.timeline_id, sessionId: row.session_id,
    actorId: row.actor_id, principalId: row.principal_id, mode: row.v36_mode, priorTurnId: row.prior_turn_id, state: effective?.state ?? row.v36_state,
    narrationStatus: effective?.narrationStatus ?? row.v36_narration_status, revision: row.v36_revision, campaignRevision: row.campaign_revision,
    createdAt: row.created_at, updatedAt: row.v36_updated_at });

  return {
    getAdventureTurn(principalId, turnId) {
      const row = db.prepare(`SELECT turn.*,COALESCE(json_extract(created.request_json,'$.mode'),turn.mode) v36_mode,
        event.resulting_state v36_state,event.narration_status v36_narration_status,
        event.resulting_revision v36_revision,event.occurred_at v36_updated_at FROM adventure_turns turn JOIN adventure_coordination_events_v36 event
        ON event.aggregate_kind='turn' AND event.campaign_id=turn.campaign_id AND event.aggregate_id=turn.id
        AND event.resulting_revision=(SELECT max(latest.resulting_revision) FROM adventure_coordination_events_v36 latest
          WHERE latest.aggregate_kind='turn' AND latest.campaign_id=turn.campaign_id AND latest.aggregate_id=turn.id)
        LEFT JOIN adventure_coordination_commands_v36 created ON created.aggregate_kind='turn' AND created.campaign_id=turn.campaign_id
          AND created.aggregate_id=turn.id AND created.mutation_type='turn-create'
        WHERE turn.id=?`).get(turnId) as any;
      if (!row) return null;
      const member = membership(principalId, row.campaign_id); if (!member) throw new AdventureTurnUnavailableError("turn is unavailable");
      const receiptProjection = receipts(db, row.campaign_id, row.id); const links = receiptProjection.links;
      const proposals = proposalRows(turnId);
      const pending = proposals.some((proposal) => proposal.requires_confirmation && !proposal.decision_id);
      if (receiptProjection.recoverableCount > 0 && pending) throw new Error("recoverable mechanics coexist with pending confirmation");
      const effective = receiptProjection.recoverableCount > 0 && ["proposed", "confirmed", "mechanics-committed"].includes(row.v36_state)
        ? { state: links.length === receiptProjection.approvedCount ? "mechanics-committed" : "confirmed",
          narrationStatus: links.length === receiptProjection.approvedCount ? "pending" : "none" } : undefined;
      if (!canSeePrivateTurn(principalId, row, member.role)) return roleSafeAdventureTurnSchema.parse({ ...common(row, effective),
        proposals: proposals.map((proposal) => ({ proposalId: proposal.proposal_id, position: proposal.position, toolName: proposal.tool_name,
          proposedAt: proposal.proposed_at, confirmation: confirmation(proposal) })), receiptLinks: links });
      const providerCalls = (db.prepare("SELECT * FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? ORDER BY recorded_at,record_id")
        .all(row.campaign_id, turnId) as any[]).map((call) => ({ recordId: call.record_id, callId: call.call_id, phase: call.phase,
          provider: call.provider, model: call.model, attempt: call.attempt, promptTokens: call.prompt_tokens,
          completionTokens: call.completion_tokens, outcomeCode: call.outcome_code, recordedAt: call.recorded_at }));
      return privateAdventureTurnSchema.parse({ ...common(row, effective), declaration: row.declaration,
        toolCalls: proposals.map((proposal) => { const proposalLinks = links.filter((link) => link.proposalId === proposal.proposal_id); return ({ proposal: { proposalId: proposal.proposal_id, position: proposal.position,
           toolName: proposal.tool_name, argumentsJson: proposal.arguments_json, proposedAt: proposal.proposed_at,
           executionBinding: { idempotencyKey: proposal.execution_idempotency_key, commandType: proposal.command_type,
             campaignId: proposal.campaign_id, timelineId: proposal.binding_timeline_id, actorId: proposal.binding_actor_id,
             sourceTurnId: proposal.binding_source_turn_id },
           confirmation: confirmation(proposal) }, status: proposalLinks.length > 0 ? "committed" : proposal.decision ?? (proposal.requires_confirmation ? "waiting-confirmation" : "approved"), receiptLinks: proposalLinks }); }),
        providerCalls, receiptLinks: links });
    },
    getAdventureTurnByInitialIdempotencyKey(principalId, campaignId, sessionId, actorId, idempotencyKey) {
      const row = db.prepare(`SELECT turn.id FROM adventure_turns turn JOIN campaigns campaign ON campaign.id=turn.campaign_id
        JOIN campaign_memberships membership ON membership.campaign_id=turn.campaign_id AND membership.principal_id=?
        JOIN campaign_sessions attached ON attached.campaign_id=turn.campaign_id AND attached.session_id=turn.session_id
        JOIN sessions session ON session.id=attached.session_id JOIN campaign_characters cc ON cc.campaign_id=turn.campaign_id
        JOIN campaign_actors actor ON actor.campaign_id=cc.campaign_id AND actor.campaign_character_id=cc.id AND actor.id=turn.actor_id
        JOIN session_characters participant ON participant.session_id=turn.session_id AND participant.character_id=cc.character_id
        LEFT JOIN campaign_actor_private_state control ON control.campaign_id=turn.campaign_id AND control.actor_id=turn.actor_id
        WHERE turn.principal_id=? AND turn.campaign_id=? AND turn.session_id=? AND turn.actor_id=? AND turn.idempotency_key=?
          AND turn.mode='original' AND campaign.active_timeline_id=turn.timeline_id
          AND campaign.lifecycle_status IN ('draft','published') AND session.state='active' AND session.stopped_at IS NULL
          AND membership.role<>'observer' AND (membership.role IN ('owner','gm') OR control.controller_principal_id=?)`)
        .get(principalId, principalId, campaignId, sessionId, actorId, idempotencyKey, principalId) as { id: string } | undefined;
      return row ? this.getAdventureTurn(principalId, row.id) : null;
    },
    getGenerationDraft(principalId, draftId) {
      const row = db.prepare(`SELECT draft.*,event.resulting_state v36_state,event.resulting_revision v36_revision
        ,event.occurred_at v36_updated_at FROM generation_drafts draft JOIN adventure_coordination_events_v36 event ON event.aggregate_kind='draft'
          AND event.campaign_id=draft.campaign_id AND event.aggregate_id=draft.id AND event.resulting_revision=(SELECT max(latest.resulting_revision)
            FROM adventure_coordination_events_v36 latest WHERE latest.aggregate_kind='draft' AND latest.campaign_id=draft.campaign_id AND latest.aggregate_id=draft.id)
        WHERE draft.id=?`).get(draftId) as any;
      if (!row) return null;
      const member = membership(principalId, row.campaign_id); if (!member) throw new AdventureTurnUnavailableError("draft is unavailable");
      const decision = db.prepare("SELECT * FROM review_decisions WHERE campaign_id=? AND draft_id=?").get(row.campaign_id, draftId) as any;
      const links = (db.prepare("SELECT * FROM final_receipt_links WHERE campaign_id=? AND draft_id=? ORDER BY linked_at,link_id").all(row.campaign_id, draftId) as any[])
        .map((link) => ({ linkId: link.link_id, campaignId: row.campaign_id, commandId: link.command_id,
          proposalId: null, sourceTurnId: null, linkedAt: link.linked_at }));
      const applyReceipt = db.prepare("SELECT * FROM generation_draft_apply_receipts_v36 WHERE campaign_id=? AND draft_id=?").get(row.campaign_id, draftId) as any;
      const reviewState = decision?.decision ?? "pending";
      const applyState = row.v36_state === "applied" ? "applied" : row.v36_state === "approved" ? "ready" : "not-ready";
      const base = { draftId: row.id, campaignId: row.campaign_id, timelineId: row.timeline_id, sessionId: row.session_id,
        kind: row.kind, state: row.v36_state, reviewState, applyState, revision: row.v36_revision, campaignRevision: row.campaign_revision,
        createdAt: row.created_at, updatedAt: row.v36_updated_at };
      const validation = JSON.parse(row.validation_json) as { valid?: boolean; issues?: Array<{ severity?: string }> ; validatedAt?: string | null };
      if (member.role !== "owner" && member.role !== "gm") return roleSafeGenerationDraftSchema.parse({ ...base,
        validationSummary: { valid: validation.valid === true, errorCount: validation.issues?.filter((issue) => issue.severity === "error").length ?? 0,
          warningCount: validation.issues?.filter((issue) => issue.severity === "warning").length ?? 0 }, receiptLinks: links,
        applyReceiptId: applyReceipt?.receipt_id ?? null });
      return privateGenerationDraftSchema.parse({ ...base, principalId: row.principal_id, stagedContent: JSON.parse(row.staged_content_json),
        validation, reviewDecision: decision ? { decisionId: decision.decision_id, principalId: decision.principal_id, decision: decision.decision,
          notes: decision.notes, expectedDraftRevision: decision.expected_draft_revision, idempotencyKey: decision.idempotency_key,
          decidedAt: decision.decided_at } : null, receiptLinks: links, applyReceipt: applyReceipt ? { receiptId: applyReceipt.receipt_id,
          draftId, reviewDecisionId: applyReceipt.review_decision_id, principalId: applyReceipt.principal_id,
          result: JSON.parse(applyReceipt.result_json), appliedAt: applyReceipt.applied_at } : null });
    },
    getAdventureTurnNarration(principalId, turnId) {
      const projection = this.getAdventureTurn(principalId, turnId);
      if (!projection) return null;
      const row = db.prepare(`SELECT command.request_json FROM adventure_coordination_commands_v36 command
        WHERE command.aggregate_kind='turn' AND command.aggregate_id=? AND command.mutation_type='narration-update'
          AND json_type(command.request_json,'$.fallbackNarration')='text'
        ORDER BY command.resulting_revision DESC LIMIT 1`).get(turnId) as { request_json: string } | undefined;
      if (!row) return null;
      const text = (JSON.parse(row.request_json) as { fallbackNarration?: unknown }).fallbackNarration;
      return typeof text === "string" ? text : null;
    },
    getGenerationDraftByIdempotencyKey(principalId, campaignId, idempotencyKey) {
      const row = db.prepare("SELECT id FROM generation_drafts WHERE campaign_id=? AND idempotency_key=?")
        .get(campaignId, idempotencyKey) as { id: string } | undefined;
      return row ? this.getGenerationDraft(principalId, row.id) : null;
    },
  };
}
