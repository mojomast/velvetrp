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
  /** Reads one generation draft, exposing staged content only to current owner/GM principals. */
  getGenerationDraft(principalId: string, draftId: string): GenerationDraftProjection | null;
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
  return (db.prepare(`SELECT link_id,command_id,proposal_id,source_turn_id,linked_at FROM turn_mechanics_links_v36
    WHERE campaign_id=? AND root_turn_id=? ORDER BY linked_at,link_id`).all(campaignId, root) as any[]).map((row) => ({
      linkId: row.link_id, campaignId, commandId: row.command_id, proposalId: row.proposal_id,
      sourceTurnId: row.source_turn_id, linkedAt: row.linked_at,
    }));
};

/** Creates principal-sensitive, non-mutating turn and draft projections. */
export function createAdventureTurnReadRepository(db: Database): AdventureTurnReadRepository {
  const membership = (principalId: string, campaignId: string) => db.prepare(
    "SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?",
  ).get(campaignId, principalId) as { role: string } | undefined;
  const canSeePrivateTurn = (principalId: string, row: any, role: string) => role === "owner" || role === "gm" || row.principal_id === principalId || Boolean(db.prepare(
    "SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?",
  ).get(row.campaign_id, row.actor_id, principalId));
  const proposalRows = (turnId: string) => db.prepare(`SELECT proposal.*,decision.decision_id,decision.principal_id decision_principal_id,
    decision.decision,decision.expected_turn_revision,decision.idempotency_key decision_key,decision.expires_at,decision.decided_at
    FROM tool_proposals proposal LEFT JOIN confirmation_decisions decision ON decision.campaign_id=proposal.campaign_id
      AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id WHERE proposal.turn_id=? ORDER BY proposal.position`).all(turnId) as any[];
  const confirmation = (row: any) => row.decision_id ? { state: "decided" as const, decision: { decisionId: row.decision_id,
    proposalId: row.proposal_id, principalId: row.decision_principal_id, decision: row.decision, expectedTurnRevision: row.expected_turn_revision,
    idempotencyKey: row.decision_key, expiresAt: row.expires_at, decidedAt: row.decided_at } }
    : row.requires_confirmation ? { state: "pending" as const, expiresAt: row.confirmation_expires_at ?? "9999-12-31T23:59:59.999Z" }
      : { state: "not-required" as const };
  const common = (row: any) => ({ turnId: row.id, campaignId: row.campaign_id, timelineId: row.timeline_id, sessionId: row.session_id,
    actorId: row.actor_id, principalId: row.principal_id, mode: row.v36_mode, priorTurnId: row.prior_turn_id, state: row.v36_state,
    narrationStatus: row.v36_narration_status, revision: row.v36_revision, campaignRevision: row.campaign_revision,
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
      const links = receipts(db, row.campaign_id, row.id);
      const proposals = proposalRows(turnId);
      if (!canSeePrivateTurn(principalId, row, member.role)) return roleSafeAdventureTurnSchema.parse({ ...common(row),
        proposals: proposals.map((proposal) => ({ proposalId: proposal.proposal_id, position: proposal.position, toolName: proposal.tool_name,
          proposedAt: proposal.proposed_at, confirmation: confirmation(proposal) })), receiptLinks: links });
      const providerCalls = (db.prepare("SELECT * FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? ORDER BY recorded_at,record_id")
        .all(row.campaign_id, turnId) as any[]).map((call) => ({ recordId: call.record_id, callId: call.call_id, phase: call.phase,
          provider: call.provider, model: call.model, attempt: call.attempt, promptTokens: call.prompt_tokens,
          completionTokens: call.completion_tokens, outcomeCode: call.outcome_code, recordedAt: call.recorded_at }));
      return privateAdventureTurnSchema.parse({ ...common(row), declaration: row.declaration,
        toolCalls: proposals.map((proposal) => { const proposalLinks = links.filter((link) => link.proposalId === proposal.proposal_id); return ({ proposal: { proposalId: proposal.proposal_id, position: proposal.position,
           toolName: proposal.tool_name, argumentsJson: proposal.arguments_json, proposedAt: proposal.proposed_at,
           confirmation: confirmation(proposal) }, status: proposalLinks.length > 0 ? "committed" : proposal.decision ?? (proposal.requires_confirmation ? "waiting-confirmation" : "approved"), receiptLinks: proposalLinks }); }),
        providerCalls, receiptLinks: links });
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
  };
}
