import {
  MAX_CAMPAIGN_CONTEXT_INSPECTION_DISPATCH_REFERENCES,
  campaignContextInspectionDispatchReferenceSelectorSchema,
  campaignContextInspectionResponseSchema,
  type CampaignContextInspectionDispatchReferenceSelector,
  type CampaignContextInspectionDispatchReferenceSelectorIdentity,
  type CampaignContextInspectionIdentity,
  type CampaignContextInspectionResponse,
} from "@velvet/contracts";
import type DatabaseDriver from "better-sqlite3";
import { contextInspectionSectionLabels } from "./campaignContextInspectionProvenanceWrite.js";

export interface CampaignContextInspectionReadRepository {
  inspectCampaignContext(principalId: string, identity: CampaignContextInspectionIdentity): CampaignContextInspectionResponse;
  resolveCampaignContextInspectionDispatchReferences(
    principalId: string,
    identity: CampaignContextInspectionDispatchReferenceSelectorIdentity,
  ): CampaignContextInspectionDispatchReferenceSelector;
}

export class CampaignContextInspectionUnavailableError extends Error {
  constructor() {
    super("campaign context inspection source unavailable");
    this.name = "CampaignContextInspectionUnavailableError";
  }
}

const unavailable = (identity: CampaignContextInspectionIdentity, reason: "dispatch-not-found" | "provenance-not-recorded" | "provenance-version-unsupported" | "provenance-corrupt" | "access-revoked") => campaignContextInspectionResponseSchema.parse({ version: "1.0", identity, availability: "unavailable", reason });
type DispatchRow = { claim_id: string; claimed_at: string; context_id: string | null; status: string | null; dispatch_source: string | null; outcome_code: string | null };

/** Read-only exact dispatch inspection and bounded source-reference selection. */
export function createCampaignContextInspectionReadRepository(db: DatabaseDriver.Database): CampaignContextInspectionReadRepository {
  const authorizeRoom = (principalId: string, campaignId: string, sessionId: string): boolean => Boolean(db.prepare(`SELECT 1
    FROM campaign_memberships member JOIN campaign_sessions room ON room.campaign_id=member.campaign_id AND room.session_id=?
    WHERE member.campaign_id=? AND member.principal_id=? AND member.role IN('owner','gm')`).get(sessionId, campaignId, principalId));
  return { resolveCampaignContextInspectionDispatchReferences(principalId, identity) {
    if (!authorizeRoom(principalId, identity.campaignId, identity.sessionId)) throw new CampaignContextInspectionUnavailableError();
    const sourceExists = identity.source.kind === "adventure-turn"
      ? db.prepare("SELECT 1 FROM adventure_turns WHERE id=? AND campaign_id=? AND session_id=?")
        .get(identity.source.sourceId, identity.campaignId, identity.sessionId)
      : db.prepare("SELECT 1 FROM dm_runs WHERE run_id=? AND campaign_id=? AND session_id=?")
        .get(identity.source.sourceId, identity.campaignId, identity.sessionId);
    if (!sourceExists) throw new CampaignContextInspectionUnavailableError();
    const rows = identity.source.kind === "adventure-turn"
      ? db.prepare(`SELECT lane,dispatch_id FROM (
          SELECT 'adventure-planning' lane,claim.claim_id dispatch_id,0 lane_order,context.round_number source_order
          FROM agent_provider_dispatch_claims_v39 claim JOIN agent_provider_contexts_v39 context ON context.context_id=claim.context_id
          WHERE claim.campaign_id=? AND claim.turn_id=?
          UNION ALL
          SELECT 'adventure-narration',dispatch.claim_id,1,0 FROM adventure_narration_dispatches_v60 dispatch
          WHERE dispatch.campaign_id=? AND dispatch.turn_id=?
        ) ORDER BY lane_order,source_order,dispatch_id LIMIT ?`).all(
          identity.campaignId, identity.source.sourceId, identity.campaignId, identity.source.sourceId,
          MAX_CAMPAIGN_CONTEXT_INSPECTION_DISPATCH_REFERENCES,
        )
      : db.prepare(`SELECT lane,dispatch_id FROM (
          SELECT 'director-planning' lane,claim_id dispatch_id,0 lane_order FROM dm_dispatches WHERE run_id=?
          UNION ALL
          SELECT 'director-narration',claim_id,1 FROM dm_narration_dispatches WHERE run_id=?
        ) ORDER BY lane_order,dispatch_id LIMIT ?`).all(
          identity.source.sourceId, identity.source.sourceId, MAX_CAMPAIGN_CONTEXT_INSPECTION_DISPATCH_REFERENCES,
        );
    return campaignContextInspectionDispatchReferenceSelectorSchema.parse({
      version: "1.0",
      identity,
      references: (rows as Array<{ lane: string; dispatch_id: string }>).map(row => ({ lane: row.lane, dispatchId: row.dispatch_id })),
    });
  }, inspectCampaignContext(principalId, identity) {
    if (!["adventure-planning", "adventure-narration", "director-planning", "director-narration"].includes(identity.lane)) return unavailable(identity, "provenance-version-unsupported");
    if (!authorizeRoom(principalId, identity.campaignId, identity.sessionId)) return unavailable(identity, "access-revoked");
    const row = identity.lane === "adventure-planning" ? db.prepare(`SELECT claim.claim_id,claim.claimed_at,context.context_id,response.status,NULL dispatch_source,response.outcome_code
      FROM agent_provider_dispatch_claims_v39 claim LEFT JOIN agent_provider_contexts_v39 context ON context.context_id=claim.context_id
      JOIN adventure_turns turn ON turn.id=context.turn_id AND turn.campaign_id=context.campaign_id
      LEFT JOIN agent_provider_responses_v39 response ON response.context_id=context.context_id AND response.provider_call_id=context.provider_call_id
      WHERE claim.claim_id=? AND claim.campaign_id=? AND turn.session_id=?`).get(identity.dispatchId, identity.campaignId, identity.sessionId) as DispatchRow | undefined
      : identity.lane === "adventure-narration" ? db.prepare(`SELECT dispatch.claim_id,dispatch.claimed_at,context.claim_id context_id,dispatch.status,dispatch.source dispatch_source,dispatch.outcome_code
        FROM adventure_narration_dispatches_v60 dispatch LEFT JOIN adventure_narration_contexts context USING(claim_id)
        JOIN adventure_turns turn ON turn.id=dispatch.turn_id AND turn.campaign_id=dispatch.campaign_id
        WHERE dispatch.claim_id=? AND dispatch.campaign_id=? AND turn.session_id=?`).get(identity.dispatchId, identity.campaignId, identity.sessionId) as DispatchRow | undefined
      : identity.lane === "director-planning" ? db.prepare(`SELECT dispatch.claim_id,dispatch.deadline_at claimed_at,request.run_id context_id,dispatch.status,NULL dispatch_source,NULL outcome_code
        FROM dm_dispatches dispatch JOIN dm_runs run ON run.run_id=dispatch.run_id LEFT JOIN dm_provider_requests request ON request.run_id=dispatch.run_id
        WHERE dispatch.claim_id=? AND run.campaign_id=? AND run.session_id=?`).get(identity.dispatchId, identity.campaignId, identity.sessionId) as DispatchRow | undefined
      : db.prepare(`SELECT dispatch.claim_id,dispatch.deadline_at claimed_at,dispatch.run_id context_id,dispatch.status,dispatch.source dispatch_source,dispatch.outcome_code
        FROM dm_narration_dispatches dispatch JOIN dm_runs run ON run.run_id=dispatch.run_id
        WHERE dispatch.claim_id=? AND run.campaign_id=? AND run.session_id=?`).get(identity.dispatchId, identity.campaignId, identity.sessionId) as DispatchRow | undefined;
    if (!row) return unavailable(identity, "dispatch-not-found");
    if (!row.context_id) return unavailable(identity, "provenance-not-recorded");
    const provenance = db.prepare(`SELECT provenance_version,campaign_id,session_id,lane,recorded_phase,source_visibility
      FROM campaign_context_inspection_headers_v61 WHERE dispatch_id=?`).get(identity.dispatchId) as { provenance_version: number;
        campaign_id: string; session_id: string; lane: string; recorded_phase: string; source_visibility: "public" | "revoked" | "private" } | undefined;
    if (!provenance) return unavailable(identity, "provenance-not-recorded");
    if (provenance.provenance_version !== 1) return unavailable(identity, "provenance-version-unsupported");
    const sources = db.prepare(`SELECT source_order,source_kind,source_label,authority FROM campaign_context_inspection_sources_v61
      WHERE dispatch_id=? ORDER BY source_order`).all(identity.dispatchId) as Array<{ source_order: number; source_kind: string; source_label: string; authority: string }>;
    const expectedPhase = identity.lane.endsWith("planning") ? "planned" : "narrated";
    const expectedLabels = contextInspectionSectionLabels(identity.lane);
    if (provenance.campaign_id !== identity.campaignId || provenance.session_id !== identity.sessionId || provenance.lane !== identity.lane
      || provenance.recorded_phase !== expectedPhase || sources.length !== expectedLabels.length
      || sources.some((source, index) => source.source_order !== index || source.source_kind !== "none"
        || source.source_label !== expectedLabels[index] || source.authority !== "system-safety")) return unavailable(identity, "provenance-corrupt");
    const settled = row.status === "succeeded" || row.status === "settled";
    const settlement = row.status === null ? "claimed" : settled ? "settled" : row.status === "unknown" ? "unknown" : "failed";
    const certainty = row.status === "unknown" || ["unknown-paid-outcome", "dispatch-lease-expired", "unknown-or-invalid-provider-outcome", "narration-failed-estimated"].includes(row.outcome_code ?? "") ? "provider-outcome-unknown"
      : row.status === "succeeded" || (identity.lane === "director-planning" && row.status === "settled") || row.dispatch_source === "provider-assisted"
        ? "provider-receipt-confirmed" : "recorded";
    const safeText = (label: string) => `${label} was retained in the frozen dispatch sidecar; its payload remains withheld.`;
    const sections = provenance.source_visibility === "revoked"
      ? [{ status: "withheld" as const, kind: "other" as const, reason: "current-visibility-revoked" as const }]
      : [...sources.map(source => ({ status: "included" as const, kind: "other" as const, label: source.source_label,
          authority: "system-safety" as const, text: safeText(source.source_label), displayedUtf8Bytes: Buffer.byteLength(safeText(source.source_label)) })),
        { status: "withheld" as const, kind: "other" as const, reason: "private-source" as const }];
    return campaignContextInspectionResponseSchema.parse({ version: "1.0", identity, availability: "available", dispatch: { recordedPhase: expectedPhase, certainty, settlement },
      // Historical request/context JSON can contain now-private or unsafe content. Never decode it in this slice.
      sections, recallHits: [], usage: { storedRecallPacketUtf8Bytes: null, storedMessageContentUtf8Bytes: null, serializedStoredRequestUtf8Bytes: null,
        displayedSafeResponseUtf8Bytes: provenance.source_visibility === "revoked" ? 0 : sources.reduce((total, source) => total + Buffer.byteLength(safeText(source.source_label)), 0),
        reportedPromptTokens: null, reportedCompletionTokens: null, reservedPromptTokens: null, reservedCompletionTokens: null } });
  } };
}
